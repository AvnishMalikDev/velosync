/**
 * The LLM brain. Single touchpoint for OpenRouter in the entire chatbot module.
 *
 * Per turn:
 *   1. Pre-retrieve top-K chunks from the merged docs + qa-history index.
 *   2. Loop up to maxIters:
 *        - Stream chat/completions from OpenRouter; merge SSE deltas into a
 *          single `{content, tool_calls}` accumulator.
 *        - If tool_calls came back, dispatch them via tools/index.js
 *          (TTL-cached) and append results to the message history.
 *        - Else emit `final` and exit the loop.
 *   3. In parallel: ask the same model to suggest 3 follow-up questions and
 *      emit a `followups` event when ready (non-blocking for `final`).
 *   4. Fire-and-forget: embed Q+A and append to qa-history.jsonl, surfacing
 *      the new row's id in `final.qaId` so the widget can wire feedback/edit.
 *
 * Streaming uses a small in-module SSE helper (sslHttp) so we keep the same
 * TLS/insecure-TLS pattern used by tools/index.js, with no edits outside this
 * folder. The injected `openRouterFetch` (from server.js) is reused for the
 * small non-streaming follow-up call — preserving its corp-proxy handling.
 */
const fs = require('fs');
const https = require('https');
const config = require('./config');
const { searchTopK, searchTopKMulti, formatContextBlock } = require('./embeddings/search');
const { logQA, makeQaId } = require('./embeddings/qaLog');
const { getUserMemories, formatMemoryBlock, extractAndSaveMemories } = require('./embeddings/userMemory');
const { TOOL_SCHEMAS, dispatchTool } = require('./tools');

// ──────────────────────────────────────────────────────────────────────────────
// JIRA project-key allowlist.
//
// extractEntities() scans free text for /^[A-Z]{2,10}-\d+$/. Without an
// allowlist we get false positives on phrases like "PI-2026 plan",
// "Q4-2025 retro", "ESO-IDC team", and the orchestrator then fires
// query_jira_issue on garbage keys, polluting the prompt with
// <entity_resolved … error="not found"> blocks the model has to reason around.
//
// We read jira-md-export/projects.json once on module load (cheap, ~10 keys)
// and rebuild the allowlist set. If the file is missing or unreadable we fall
// back to "permissive" mode (treat any well-formed key as valid) so this can
// never break extraction in environments without projects.json.
// ──────────────────────────────────────────────────────────────────────────────
let JIRA_KEY_ALLOWLIST = null; // null = permissive; Set<string> = strict
try {
  const raw = fs.readFileSync(config.paths.projectsConfig, 'utf8');
  const parsed = JSON.parse(raw);
  const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.projects) ? parsed.projects : []);
  const set = new Set();
  for (const p of arr) {
    const k = (p && (p.key || p.jiraKey) || '').toString().trim().toUpperCase();
    if (/^[A-Z][A-Z0-9]{1,9}$/.test(k)) set.add(k);
  }
  if (set.size) JIRA_KEY_ALLOWLIST = set;
} catch (_) { /* keep permissive */ }

// Negative patterns that look like JIRA keys but are not. Used in permissive
// mode (when projects.json is missing) and as a belt-and-suspenders guard.
// Note: PR is intentionally NOT here because it is a real JIRA project key
// (Trauma / PR-Compliance) — the allowlist gates it correctly when active.
const FAKE_JIRA_KEY_RE = /^(PI|Q[1-4]|H[12]|FY|CY|YR|MVP|RC|GA|EOL|TBD|TODO|FIX|NA|UI|UX|API|SDK|CSS|JS|TS|HTTP|HTTPS|SQL|CSV|PDF|JSON|XML|YAML|HTML|URL|UUID|GUID|ETA|FAQ|KPI|OKR|ROI|SLA|SLO|SOP|MTTR|MTBF|RFC|RFI|RFP)-\d+$/i;

function isLikelyRealJiraKey(key) {
  const k = String(key || '').toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(k)) return false;
  const prefix = k.split('-')[0];
  if (JIRA_KEY_ALLOWLIST) return JIRA_KEY_ALLOWLIST.has(prefix);
  return !FAKE_JIRA_KEY_RE.test(k);
}

const SYSTEM_PROMPT_BASE = `You are the ESO Engineering Dashboard AI. You answer questions about projects, sprints, people, JIRA, GitHub, Copilot/Cursor adoption, Confluence, and TestRail.

# 1. CONTEXT CHANNELS
- <context source="docs">          → ground-truth sprint MDs. Trust.
- <context source="prior_answer">   → past chats. Trust stable facts; re-verify if >7d old and time-sensitive.
- <entity_resolved type="...">      → already-fetched JIRA/PR/person. TRUST AND DO NOT REFETCH unless user asks for fresher data.
- "Persistent context about this user" → role/projects/prefs. Personalise silently.

# 2. TOOLS (12) — pick the smallest one that answers
PEOPLE
  lookup_person(name)            → returns { email, accountId, githubLogin, matchScore }. Call FIRST when user names someone. If matchScore < 0.7 or lowConfidence:true, ASK the user to confirm before chaining.
  list_people(filter?)           → bulk roster. Use for "who is on team X" / "list QA managers".
WORK
  query_jira(jql, maxResults?)   → JQL search for MULTIPLE tickets / counts.
  query_jira_issue(key)          → ONE ticket with full detail. Use for any "HDE-1234" / JIRA URL.
  query_github(login, days?)     → recent PRs+commits for one person.
  query_github_pr(repo, number?) → ONE PR full detail.
AI ADOPTION
  query_copilot(login? | top?)   → cached Copilot leaderboard / per-user.
  query_cursor(email? | top?)    → cached Cursor leaderboard / per-user + org shares.
DOCS & QA
  query_confluence(name, days?)  → per-person Confluence activity.
  query_testrail(projectIds? | projectName?, days?)
SPRINTS & PROJECTS
  query_sprint(project, sprint?) → verbatim sprint MD fetch.
  list_projects()

# 3. KEY-PASSING — **HARD RULE, DO NOT SKIP**
For ANY person-scoped tool call (query_github, query_copilot, query_cursor,
query_confluence, query_jira-by-assignee), your FIRST tool call MUST be
lookup_person. Then chain with the EXACT field below — never the displayName,
never a guess.

  query_github   → login = lookup_person.match.githubLogin   (NOT email, NOT displayName)
  query_copilot  → login = lookup_person.match.githubLogin
  query_cursor   → email = lookup_person.match.email          (Cursor uses EMAIL)
  query_confluence → name = the displayName the user typed   (tool resolves accountId)
  query_jira(JQL) → email used as: assignee = "<email>"

If lookup_person returns no githubLogin (or any required field), say so plainly
and stop — don't fall through to the tool with a name/email guess. The tool will
reject it and you'll waste a round.

Example correct chain for "what is Avnish's PR activity":
  1. lookup_person({name:"Avnish"}) → { match:{ githubLogin:"avnishmalik", email:"..." }, matchScore:0.92 }
  2. query_github({login:"avnishmalik", days:30})

# 4. DECISION ORDER
1. If <entity_resolved> answers it → answer directly. NO more tool calls.
2. Else if retrieved <context> answers it → use it.
3. For live "right now" / "today" data → call tools.
4. Person → lookup_person first, then chain with the correct key.
5. "Full HDE Sprint X report" → query_sprint.
6. Hard cap: 6 tool rounds; the orchestrator terminates after.

# 5. ANSWER LENGTH POLICY (match shape to question)
- count / yes-no / single-fact         → 1 sentence. No bullets. No preamble.
- single-entity lookup (one person/ticket/PR) → 2-4 short lines, key facts only.
- list / leaderboard / "who is on…"    → 3-6 bullets, one fact per bullet.
- comparison / diagnosis / why         → 1 short paragraph + ≤4 bullets.
- explicit "full report" / "everything about" / "deep dive" / "details on" → no cap.
RULES (always):
- Never narrate tool calls ("Let me look this up…"). Just answer.
- Never restate the question. Never start with "Sure", "Absolutely", "I'd be happy to".
- Numbers: copy verbatim from tool output. Don't round, don't paraphrase.
- Cite sprint MDs inline as "<Project> — <Sprint>".
- "No data" → say "no <X> in the last <N>d" plainly. Don't speculate.
- Markdown OK (**bold**, bullets, links). Tables ONLY if user asks.

# 6. FAILURE HANDLING
- State the failure plainly. Don't pretend the tool worked.
- Read the \`hint\` field — follow it. ONE retry max, only if the call was malformed.
- Never invent data on failure. Better "I don't have that" than a hallucination.
- Config error (missing env) → name the env var + the file (jira-md-export/.env).

# 7. STYLE EXAMPLES (mirror these)

User: "How many open bugs in HDE right now?"
You: 14 open bugs in HDE (HS project, statusCategory != Done, type = Bug).

User: "Tell me about HDE-1234"
You: **HDE-1234** — Login fails on Safari 17 (Bug, In Progress)
- Assignee: Avnish Malik · Sprint: HDE PI 24.3 Sprint 4
- Reporter: Jessica O'Connel · Updated 2d ago
- Linked: blocks HDE-1240. 3 comments.

User: "Top 5 Cursor users by acceptance rate"
You:
- alice@eso.com — 71% acceptance, 4.2k lines
- bob@eso.com — 68% acceptance, 3.9k lines
- carol@eso.com — 64% acceptance, 5.1k lines
- dave@eso.com — 61% acceptance, 2.8k lines
- erin@eso.com — 59% acceptance, 3.3k lines`;

// ──────────────────────────────────────────────────────────────────────────────
// Answer-shape policy.
//
// Maps a question to a max-tokens budget so we never emit 800-word essays for
// "how many open bugs" type questions. The system prompt's ANSWER LENGTH POLICY
// teaches the model the *shape*; this is the hard ceiling that catches drift.
//
// `verbose` is reserved for explicit asks ("full report", "everything about",
// "deep dive", "details on"). The list is intentionally narrow — we want
// brevity to be the default, not the exception.
// ──────────────────────────────────────────────────────────────────────────────
const VERBOSE_RE = /\b(full\s+report|everything about|deep\s+dive|in\s+detail|details\s+on|complete\s+report|verbatim|raw\s+report|entire\s+sprint|full\s+sprint)\b/i;

function pickAnswerBudget(question) {
  const verbose = VERBOSE_RE.test(String(question || ''));
  return {
    verbose,
    maxTokens: verbose ? config.agent.maxTokensVerbose : config.agent.maxTokensDefault,
  };
}

// Small-talk / meta detector. When a user says "hi" / "what can you do" we
// skip tool calling entirely on iter 0 by setting tool_choice='none'. Keeps
// trivial turns single-round and stops the model from speculatively firing
// tools just because the schema is in scope.
const SMALLTALK_RE = /^\s*(hi|hello|hey|hii+|yo|sup|thanks|thank you|thx|ty|ok|okay|cool|nice|good morning|good afternoon|good evening|what can you do|what do you do|who are you|help|how are you|what are you)\b[\s\S]{0,40}\??\s*$/i;

function isSmallTalk(question) {
  return SMALLTALK_RE.test(String(question || ''));
}

function buildSystemPrompt(contextBlock, entityBlock, memoryBlock) {
  let out = SYSTEM_PROMPT_BASE;
  if (memoryBlock) {
    out += memoryBlock;
  }
  if (contextBlock) {
    out += `\n\n--- Retrieved context (${contextBlock.match(/<context /g)?.length || 0} hits) ---\n${contextBlock}\n--- End context ---`;
  }
  if (entityBlock) {
    out += entityBlock;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Streaming HTTP helper. Keeps the same TLS pattern as tools/index.js so corp
// proxies / self-signed certs are handled identically. Returns the merged
// `{ content, tool_calls, finishReason, status }` after the SSE stream ends.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Wrap streamChatCompletion with bounded retry + exponential backoff.
 * Retries on:
 *   - Pre-byte network failures (ECONNRESET / ETIMEDOUT / DNS / fetch failed)
 *   - HTTP 5xx responses where the stream never started
 *   - HTTP 429 rate-limit responses where the stream never started
 *
 * Does NOT retry once any content delta has been seen — that would duplicate
 * tokens the widget already rendered. Mid-stream drops bubble up.
 *
 * Emits `llm_retry` events via `onRetry` so the timeline can show "Retrying…"
 * with attempt + reason.
 *
 * @param {object} body
 * @param {string} apiKey
 * @param {(delta: string) => void} onContentDelta
 * @param {(info: { attempt: number, reason: string, delayMs: number }) => void} [onRetry]
 */
async function streamChatCompletionWithRetry(body, apiKey, onContentDelta, onRetry) {
  const MAX_ATTEMPTS = 3;
  const baseDelayMs = 500;
  let lastErr = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let chunkSeen = false;
    const wrappedDelta = (delta) => {
      chunkSeen = true;
      if (typeof onContentDelta === 'function') onContentDelta(delta);
    };

    try {
      const res = await streamChatCompletion(body, apiKey, wrappedDelta);
      const transient5xx = res.status >= 500 && res.status < 600;
      const rateLimited = res.status === 429;
      const isLast = attempt + 1 >= MAX_ATTEMPTS;
      if ((transient5xx || rateLimited) && !chunkSeen && !isLast) {
        const factor = rateLimited ? 2 : 1;
        const delayMs = baseDelayMs * Math.pow(2, attempt) * factor + Math.floor(Math.random() * 200);
        if (typeof onRetry === 'function') onRetry({ attempt: attempt + 1, reason: `http_${res.status}`, delayMs });
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (chunkSeen) throw err;
      if (attempt + 1 >= MAX_ATTEMPTS) throw err;
      const delayMs = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
      if (typeof onRetry === 'function') onRetry({ attempt: attempt + 1, reason: 'network_error', delayMs });
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr || new Error('OpenRouter retry budget exhausted');
}

function streamChatCompletion(body, apiKey, onContentDelta) {
  return new Promise((resolve, reject) => {
    const allowInsecure = config.openRouter.allowInsecureTls;
    const payload = JSON.stringify({ ...body, stream: true });
    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Accept: 'text/event-stream',
        'HTTP-Referer': 'https://localhost',
        'X-Title': 'ESO Dashboard Chatbot',
      },
      ...(allowInsecure && { agent: new https.Agent({ rejectUnauthorized: false }) }),
    };

    const acc = { content: '', tool_calls: [], finishReason: null };
    let buffer = '';
    let firstByteSeen = false;
    let nonStreamFallbackBody = '';

    const req = https.request(options, (res) => {
      const status = res.statusCode || 0;
      const isStream = (res.headers['content-type'] || '').includes('text/event-stream');

      if (status < 200 || status >= 300 || !isStream) {
        res.on('data', (chunk) => { nonStreamFallbackBody += chunk.toString('utf8'); });
        res.on('end', () => {
          let parsed = null;
          try { parsed = nonStreamFallbackBody ? JSON.parse(nonStreamFallbackBody) : null; } catch (_) { /* keep raw */ }
          resolve({ status, data: parsed, raw: nonStreamFallbackBody, streamed: false });
        });
        res.on('error', reject);
        return;
      }

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        firstByteSeen = true;
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const raw = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (!raw || raw.startsWith(':')) continue;
          if (!raw.startsWith('data:')) continue;
          const data = raw.slice(5).trim();
          if (data === '[DONE]') continue;
          let evt;
          try { evt = JSON.parse(data); } catch (_) { continue; }
          const choice = evt.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};
          if (typeof delta.content === 'string' && delta.content) {
            acc.content += delta.content;
            if (typeof onContentDelta === 'function') {
              try { onContentDelta(delta.content); } catch (_) { /* ignore */ }
            }
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!acc.tool_calls[idx]) {
                acc.tool_calls[idx] = {
                  id: tc.id || '',
                  type: tc.type || 'function',
                  function: { name: '', arguments: '' },
                };
              }
              const slot = acc.tool_calls[idx];
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.function.name += tc.function.name;
              if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
            }
          }
          if (choice.finish_reason) acc.finishReason = choice.finish_reason;
        }
      });
      res.on('end', () => {
        resolve({
          status,
          streamed: true,
          content: acc.content,
          tool_calls: acc.tool_calls.filter(Boolean),
          finishReason: acc.finishReason,
        });
      });
      res.on('error', reject);
    });

    req.setTimeout(120000, () => {
      req.destroy(new Error('OpenRouter stream timed out after 120s'));
    });
    req.on('error', (err) => {
      if (!firstByteSeen) reject(err);
      else reject(err);
    });
    req.write(payload);
    req.end();
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Entity pre-resolution.
// We scan the user's question for first-class identifiers (JIRA keys, GitHub
// PR URLs, GitHub logins, email addresses) and pre-fetch the corresponding
// data BEFORE the main LLM loop runs. The fetched payloads get injected into
// the system prompt as <entity_resolved> blocks. Net effect:
//   - 1 fewer LLM round in the typical "tell me about HDE-1234" case.
//   - The model gets ground-truth ticket/PR data on iter 0 instead of having
//     to plan-tool-respond.
//   - Less hallucination when a key is paraphrased poorly.
// ──────────────────────────────────────────────────────────────────────────────

// JIRA key inside word boundaries. Bounded length keeps random ALL_CAPS-N
// tokens from being misread as keys.
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;
// JIRA URL → /browse/<KEY>
const JIRA_URL_RE = /https?:\/\/[^\s)]+\/browse\/([A-Z][A-Z0-9]{1,9}-\d{1,7})/gi;
// GitHub PR URL or "owner/repo#N" or "repo#N". Protocol optional so users
// can paste "github.com/..." without "https://" and still get matched.
const GITHUB_PR_URL_RE = /(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/gi;
const GITHUB_PR_HASH_RE = /\b(?:([\w.-]+)\/)?([\w.-]+)#(\d{1,6})\b/g;
// Email
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
// "@login" — be conservative; GitHub logins are 1..39 chars, alphanumeric + hyphen.
const AT_LOGIN_RE = /(?:^|[\s,(])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?=[\s,.;:!?)]|$)/g;

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const s of arr) {
    if (!s) continue;
    const k = String(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * Extract first-class entities from the user's question. Returns lists,
 * de-duped, capped at a sane size to avoid runaway tool calls.
 */
function extractEntities(question) {
  const text = String(question || '');
  const jiraKeys = [];
  // JIRA URLs are explicit — user pasted them, always pre-resolve.
  for (const m of text.matchAll(JIRA_URL_RE)) jiraKeys.push(m[1].toUpperCase());
  // Bare tokens (e.g. "HDE-1234" in a sentence) are gated against the project
  // allowlist + negative regex so we don't pre-fetch garbage like "PI-2026".
  for (const m of text.matchAll(JIRA_KEY_RE)) {
    const candidate = `${m[1]}-${m[2]}`;
    if (isLikelyRealJiraKey(candidate)) jiraKeys.push(candidate);
  }

  const prRefs = [];
  for (const m of text.matchAll(GITHUB_PR_URL_RE)) {
    prRefs.push({ owner: m[1], repo: m[2], number: parseInt(m[3], 10) });
  }
  for (const m of text.matchAll(GITHUB_PR_HASH_RE)) {
    // Skip JIRA keys masquerading as repo#N (already captured above) — JIRA
    // keys are ALL_CAPS, GitHub repos typically aren't.
    const repoTok = m[2];
    if (/^[A-Z][A-Z0-9]{1,9}$/.test(repoTok)) continue;
    prRefs.push({ owner: m[1] || '', repo: repoTok, number: parseInt(m[3], 10) });
  }

  const emails = [];
  for (const m of text.matchAll(EMAIL_RE)) emails.push(m[0].toLowerCase());

  const logins = [];
  for (const m of text.matchAll(AT_LOGIN_RE)) logins.push(m[1]);

  return {
    jiraKeys: uniqStrings(jiraKeys).slice(0, 4),
    prRefs: prRefs.slice(0, 4),
    emails: uniqStrings(emails).slice(0, 4),
    logins: uniqStrings(logins).slice(0, 4),
  };
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Pre-resolve detected entities by firing the relevant tools in parallel.
 * Emits tool_start/tool_end events using synthetic IDs so the widget timeline
 * shows the same UI it does for LLM-driven tool calls.
 *
 * Returns an XML-tagged block string ready to splice into the system prompt
 * (or '' if nothing was resolved).
 */
async function preResolveEntities(question, emit) {
  const ents = extractEntities(question);
  const totalCount = ents.jiraKeys.length + ents.prRefs.length + ents.emails.length + ents.logins.length;
  if (!totalCount) return '';

  emit({ type: 'prepass_start', count: totalCount });

  const blocks = [];
  const tasks = [];

  let synthSeq = 0;
  const nextId = (label) => `prepass-${++synthSeq}-${label}`;

  // Helper that wraps a dispatchTool call with timeline events + a single-line
  // summary, mirroring the agent's tool dispatch loop.
  const fire = (toolName, args, label) => {
    const id = nextId(label);
    emit({ type: 'tool_start', name: toolName, args, id });
    return dispatchTool(toolName, args).then((result) => {
      emit({
        type: 'tool_end',
        name: toolName,
        id,
        ok: !result?.error,
        summary: summariseToolResult(toolName, result),
        cached: !!result?._cached,
      });
      return { toolName, args, result };
    });
  };

  for (const key of ents.jiraKeys) {
    tasks.push(fire('query_jira_issue', { key }, key).then(({ result }) => {
      if (result?.error) {
        blocks.push(`<entity_resolved type="jira_issue" key="${escapeXml(key)}" error="${escapeXml(result.error)}"/>`);
      } else {
        const r = result;
        const desc = r.description ? `\n${r.description.slice(0, 1500)}${r.descriptionTruncated ? '\n…(truncated)' : ''}` : '';
        const sprintStr = (r.sprints || []).map(s => `${s.name}${s.state ? ' ['+s.state+']' : ''}`).join(', ');
        const subsStr = (r.subtasks || []).map(s => `${s.key} (${s.status}): ${s.summary}`).slice(0, 8).join('\n  ');
        const linksStr = (r.links || []).map(l => `${l.relation} ${l.key}: ${l.summary}`).slice(0, 8).join('\n  ');
        const commentsStr = (r.recentComments || []).map(c => `[${c.author} @ ${c.created}] ${c.body}`).slice(0, 3).join('\n  ');
        const spLine = (r.storyPoints != null || r.actualStoryPoints != null)
          ? `storyPoints: ${r.storyPoints != null ? r.storyPoints : '-'}${r.actualStoryPoints != null ? `  actualStoryPoints: ${r.actualStoryPoints}` : ''}\n`
          : '';
        blocks.push(
          `<entity_resolved type="jira_issue" key="${escapeXml(r.key)}" url="${escapeXml(r.url)}">\n` +
          `summary: ${r.summary}\n` +
          `status: ${r.status} (${r.statusCategory})  type: ${r.type}  priority: ${r.priority || '-'}\n` +
          `assignee: ${r.assignee || '-'} (${r.assigneeEmail || ''})\n` +
          `reporter: ${r.reporter || '-'}\n` +
          (sprintStr ? `sprint: ${sprintStr}\n` : '') +
          spLine +
          (r.fixVersions?.length ? `fixVersions: ${r.fixVersions.join(', ')}\n` : '') +
          (r.components?.length ? `components: ${r.components.join(', ')}\n` : '') +
          (r.labels?.length ? `labels: ${r.labels.join(', ')}\n` : '') +
          (r.parent ? `parent: ${r.parent.key} — ${r.parent.summary}\n` : '') +
          (subsStr ? `subtasks:\n  ${subsStr}\n` : '') +
          (linksStr ? `links:\n  ${linksStr}\n` : '') +
          `created: ${r.created}  updated: ${r.updated}\n` +
          (desc ? `description:${desc}\n` : '') +
          (commentsStr ? `recent comments (${r.commentCount} total):\n  ${commentsStr}\n` : `comments: ${r.commentCount}\n`) +
          `</entity_resolved>`,
        );
      }
    }).catch((err) => {
      blocks.push(`<entity_resolved type="jira_issue" key="${escapeXml(key)}" error="${escapeXml(err.message || String(err))}"/>`);
    }));
  }

  for (const ref of ents.prRefs) {
    const label = `${ref.owner ? ref.owner + '/' : ''}${ref.repo}#${ref.number}`;
    const args = { repo: ref.owner ? `${ref.owner}/${ref.repo}` : ref.repo, number: ref.number };
    tasks.push(fire('query_github_pr', args, label).then(({ result }) => {
      if (result?.error) {
        blocks.push(`<entity_resolved type="github_pr" ref="${escapeXml(label)}" error="${escapeXml(result.error)}"/>`);
      } else {
        const r = result;
        const filesStr = (r.filesPreview || []).slice(0, 12).map(f => `${f.filename} (+${f.additions}/-${f.deletions})`).join('\n  ');
        const reviewsStr = (r.reviews || []).slice(0, 6).map(rv => `[${rv.login}] ${rv.state}: ${rv.body.slice(0, 200)}`).join('\n  ');
        const commentsStr = (r.comments || []).slice(0, 4).map(c => `[${c.login}] ${c.body.slice(0, 200)}`).join('\n  ');
        blocks.push(
          `<entity_resolved type="github_pr" ref="${escapeXml(r.owner)}/${escapeXml(r.repo)}#${r.number}" url="${escapeXml(r.url)}">\n` +
          `title: ${r.title}\n` +
          `state: ${r.state}${r.draft ? ' (draft)' : ''}${r.merged ? ' (merged)' : ''}\n` +
          `author: ${r.author}\n` +
          `branches: ${r.headBranch} → ${r.baseBranch}\n` +
          `changes: +${r.additions}/-${r.deletions} across ${r.changedFiles} files\n` +
          (r.requestedReviewers?.length ? `requested reviewers: ${r.requestedReviewers.join(', ')}\n` : '') +
          (r.labels?.length ? `labels: ${r.labels.join(', ')}\n` : '') +
          `created: ${r.createdAt}  updated: ${r.updatedAt}${r.mergedAt ? '  merged: '+r.mergedAt : ''}\n` +
          (filesStr ? `files:\n  ${filesStr}\n` : '') +
          (reviewsStr ? `reviews:\n  ${reviewsStr}\n` : '') +
          (commentsStr ? `comments:\n  ${commentsStr}\n` : '') +
          (r.body ? `body:\n${r.body.slice(0, 1500)}\n` : '') +
          `</entity_resolved>`,
        );
      }
    }).catch((err) => {
      blocks.push(`<entity_resolved type="github_pr" ref="${escapeXml(label)}" error="${escapeXml(err.message || String(err))}"/>`);
    }));
  }

  // For emails + logins, we just resolve identity (lookup_person handles both
  // names and emails because the resource directory rows include emails). We
  // do NOT auto-cascade to query_jira/query_github here — the model can decide
  // whether to chain based on the question.
  for (const email of ents.emails) {
    tasks.push(fire('lookup_person', { name: email }, email).then(({ result }) => {
      if (!result?.error) {
        blocks.push(
          `<entity_resolved type="person" lookup="${escapeXml(email)}">\n` +
          `${JSON.stringify(result, null, 2).slice(0, 1200)}\n` +
          `</entity_resolved>`,
        );
      }
    }).catch(() => { /* best-effort */ }));
  }

  for (const login of ents.logins) {
    tasks.push(fire('lookup_person', { name: login }, login).then(({ result }) => {
      if (!result?.error) {
        blocks.push(
          `<entity_resolved type="person" lookup="@${escapeXml(login)}">\n` +
          `${JSON.stringify(result, null, 2).slice(0, 1200)}\n` +
          `</entity_resolved>`,
        );
      }
    }).catch(() => { /* best-effort */ }));
  }

  await Promise.all(tasks);
  emit({ type: 'prepass_end', count: blocks.length });

  if (!blocks.length) return '';
  return `\n\n--- Pre-resolved entities (${blocks.length}) ---\n${blocks.join('\n\n')}\n--- End pre-resolved entities ---`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Upgrade 2 — Query Rewriting + HyDE.
//
// Before retrieval, ask the fast model to produce 2 alternative phrasings of
// the user's question AND a "hypothetical answer document" (HyDE). All 3+1
// (original + 2 variants + HyDE) are embedded and their cosine scores fused
// via max-score in searchTopKMulti. This dramatically improves recall for
// short/ambiguous/non-English queries.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Expand a user query into multiple variants + a HyDE document.
 * Returns an array starting with the original query followed by variants.
 * Falls back to [question] on any error so the caller always gets something.
 *
 * @param {{ question: string, openRouterFetch: Function, apiKey: string }} opts
 * @returns {Promise<string[]>}
 */
// Queries where HyDE / variant rewriting adds zero value and only burns
// ~1-2s of fast-LLM time before retrieval can start. We skip the rewrite
// when:
//   - smalltalk ("hi", "thanks") — no retrieval target at all
//   - very short prompts — too little signal for the rewriter to work with
//   - entity-bearing prompts (JIRA key / email / GitHub PR URL) — entity
//     pre-resolution already grounds them, the variant phrasings just add
//     noise to the cosine pool.
function shouldSkipExpand(question) {
  const q = String(question || '').trim();
  if (!q || q.length < 24) return true;
  if (isSmallTalk(q)) return true;
  // JIRA_KEY_RE / EMAIL_RE / GITHUB_PR_URL_RE all have the `g` flag, so
  // .test() advances lastIndex. Reset before AND after each test so the
  // shared regexes stay in a consistent state for any other caller.
  JIRA_KEY_RE.lastIndex = 0;
  if (JIRA_KEY_RE.test(q)) { JIRA_KEY_RE.lastIndex = 0; return true; }
  EMAIL_RE.lastIndex = 0;
  if (EMAIL_RE.test(q)) { EMAIL_RE.lastIndex = 0; return true; }
  GITHUB_PR_URL_RE.lastIndex = 0;
  if (GITHUB_PR_URL_RE.test(q)) { GITHUB_PR_URL_RE.lastIndex = 0; return true; }
  return false;
}

async function expandQuery({ question, openRouterFetch, apiKey }) {
  if (!config.features.queryRewrite) return [question];
  if (shouldSkipExpand(question)) return [question];
  const model = config.model.fastModel;
  const messages = [
    {
      role: 'system',
      content:
        'You improve search retrieval for an engineering sprint-tracking dashboard. ' +
        'Given a user question, return a JSON object with two keys:\n' +
        '"variants": array of exactly 2 short alternative phrasings (≤120 chars each) that would match different relevant sprint/JIRA/GitHub documents.\n' +
        '"hypothetical": a 2-3 sentence snippet that looks like a section from a sprint report that would perfectly answer this question.\n' +
        'Return ONLY the JSON object, no prose, no markdown fences.',
    },
    { role: 'user', content: question.slice(0, 400) },
  ];
  try {
    const res = await openRouterFetch(
      { model, messages, temperature: 0.3, max_tokens: 300, stream: false },
      apiKey,
      'https://localhost',
    );
    if (!res || res.status < 200 || res.status >= 300) return [question];
    const raw = (res.data?.choices?.[0]?.message?.content || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [question];
    const parsed = JSON.parse(m[0]);
    const queries = [question];
    if (Array.isArray(parsed.variants)) {
      queries.push(...parsed.variants.map(v => String(v || '').trim()).filter(Boolean).slice(0, 2));
    }
    if (typeof parsed.hypothetical === 'string' && parsed.hypothetical.trim()) {
      queries.push(parsed.hypothetical.trim().slice(0, 600));
    }
    return queries;
  } catch (_) {
    return [question];
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Upgrade 3a — Intent-based Tool Router.
//
// Light keyword routing narrows the tools list exposed to the LLM based on
// the question's likely domain. This reduces token overhead, cuts hallucinated
// tool calls, and is entirely rule-based (zero LLM call).
// ──────────────────────────────────────────────────────────────────────────────

const TOOL_INTENT_GROUPS = {
  people:    ['lookup_person', 'list_people'],
  work:      ['query_sprint', 'query_jira', 'query_jira_issue', 'list_projects'],
  github:    ['query_github', 'query_github_pr'],
  ai:        ['query_copilot', 'query_cursor'],
  quality:   ['query_testrail'],
  docs:      ['query_confluence'],
};

/**
 * Return a filtered TOOL_SCHEMAS subset relevant to the question, or the full
 * TOOL_SCHEMAS if no clear domain signal is found.
 *
 * @param {string} question
 * @param {object[]} allSchemas  The full TOOL_SCHEMAS array.
 * @returns {object[]}
 */
function routeTools(question, allSchemas) {
  const q = question.toLowerCase();

  // Explicit entity patterns always need full access.
  const hasJiraKey = /\b[A-Z]{2,10}-\d{1,7}\b/.test(question);
  const hasGithubRef = /github\.com|#\d{2,6}\b/.test(q);
  const hasEmail = /@[\w-]+\./.test(q);
  if (hasJiraKey || hasGithubRef || hasEmail) return allSchemas;

  const want = new Set();

  if (/\b(who is|who are|find person|contact|email of|team lead|manager|resource|people|roster|directory)\b/.test(q)) {
    TOOL_INTENT_GROUPS.people.forEach(t => want.add(t));
    TOOL_INTENT_GROUPS.work.forEach(t => want.add(t));
  }
  if (/\b(sprint|velocity|story point|backlog|pi |planned|delivered|jira|ticket|issue|bug|task|epic)\b/.test(q)) {
    TOOL_INTENT_GROUPS.work.forEach(t => want.add(t));
    TOOL_INTENT_GROUPS.people.forEach(t => want.add(t));
  }
  if (/\b(pr|pull request|commit|github|repo|branch|merge|code review|diff)\b/.test(q)) {
    TOOL_INTENT_GROUPS.github.forEach(t => want.add(t));
    TOOL_INTENT_GROUPS.people.forEach(t => want.add(t));
  }
  if (/\b(copilot|cursor|ai adoption|ai usage|acceptance rate|lines accepted|ai tool|ai assist)\b/.test(q)) {
    TOOL_INTENT_GROUPS.ai.forEach(t => want.add(t));
    TOOL_INTENT_GROUPS.people.forEach(t => want.add(t));
  }
  if (/\b(testrail|test case|test run|automation|test coverage|qa metric|defect|failed test)\b/.test(q)) {
    TOOL_INTENT_GROUPS.quality.forEach(t => want.add(t));
    TOOL_INTENT_GROUPS.work.forEach(t => want.add(t));
  }
  if (/\b(confluence|wiki|page|documentation|doc|knowledge base)\b/.test(q)) {
    TOOL_INTENT_GROUPS.docs.forEach(t => want.add(t));
    TOOL_INTENT_GROUPS.people.forEach(t => want.add(t));
  }

  if (!want.size) return allSchemas;

  const filtered = allSchemas.filter(s => want.has(s?.function?.name));
  // Safety: if filtering removed everything, fall back to all tools.
  return filtered.length >= 2 ? filtered : allSchemas;
}

// ──────────────────────────────────────────────────────────────────────────────
// Upgrade 5 — Conversation History Compression.
//
// When history exceeds `historyCompressTurns` turns, older turns are
// summarised into a single "Earlier conversation" message. The last 4 turns
// are always kept verbatim so the model has immediate context.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compress long conversation histories into a summary + recent verbatim tail.
 *
 * @param {{ history: object[], openRouterFetch: Function, apiKey: string }} opts
 * @returns {Promise<object[]>}  Compressed messages array ready for use.
 */
async function compressHistory({ history, openRouterFetch, apiKey }) {
  const threshold = config.agent.historyCompressTurns;
  if (!Array.isArray(history) || history.length <= threshold) return history || [];

  const VERBATIM_TAIL = 4;
  const toCompress = history.slice(0, history.length - VERBATIM_TAIL);
  const recent = history.slice(history.length - VERBATIM_TAIL);

  const histText = toCompress
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 400)}`)
    .join('\n');

  const messages = [
    {
      role: 'system',
      content:
        'Summarise this conversation between a user and an engineering dashboard AI in 2-3 sentences. ' +
        'Focus on: what the user asked, what data was found, and any key facts established. Be concise.',
    },
    { role: 'user', content: histText },
  ];

  try {
    const model = config.model.fastModel;
    const res = await openRouterFetch(
      { model, messages, temperature: 0.1, max_tokens: 250, stream: false },
      apiKey,
      'https://localhost',
    );
    if (!res || res.status < 200 || res.status >= 300) return history.slice(-6);
    const summary = (res.data?.choices?.[0]?.message?.content || '').trim();
    if (!summary) return history.slice(-6);
    return [
      { role: 'user', content: `[Earlier conversation summary: ${summary}]` },
      { role: 'assistant', content: 'Understood, I have the earlier context.' },
      ...recent,
    ];
  } catch (_) {
    return history.slice(-6);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Follow-up generator. Cheap separate completion. Uses the injected (non-
// streaming) openRouterFetch so corp-proxy handling stays identical.
// ──────────────────────────────────────────────────────────────────────────────

async function generateFollowups({ question, answer, model, openRouterFetch, apiKey }) {
  const followupModel = config.agent.followupModel || model;
  const messages = [
    { role: 'system', content: 'You suggest follow-up questions. Reply ONLY with a JSON array of exactly 3 short, distinct questions a user might ask next, no prose, no preamble. Each question must be under 80 characters.' },
    { role: 'user', content: `Original question:\n${question}\n\nAnswer given:\n${answer}\n\nReturn ONLY the JSON array.` },
  ];
  try {
    const res = await openRouterFetch({
      model: followupModel,
      messages,
      temperature: 0.5,
      max_tokens: 200,
      stream: false,
    }, apiKey, 'https://localhost');
    if (!res || res.status < 200 || res.status >= 300) return [];
    const raw = (res.data?.choices?.[0]?.message?.content || '').trim();
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr.map(s => String(s || '').trim()).filter(Boolean).slice(0, config.agent.followupCount);
  } catch (_) {
    return [];
  }
}

/**
 * Run a single user turn through the OpenRouter tool-calling loop.
 *
 * @param {Object} args
 * @param {string} args.question
 * @param {string} [args.model]
 * @param {Array}  [args.history]
 * @param {{email?: string, displayName?: string}} [args.user]
 * @param {(evt: { type: string, [k: string]: any }) => void} [args.onEvent]
 * @param {Function} args.openRouterFetch
 * @returns {Promise<{ answer: string, toolCalls: Array, model: string, qaId: string|null }>}
 */
async function ask({ question, model, history, user, onEvent, openRouterFetch }) {
  if (!question || !String(question).trim()) {
    throw new Error('question is required');
  }
  if (!openRouterFetch) {
    throw new Error('openRouterFetch is required (inject from server.js)');
  }
  const apiKey = config.openRouter.apiKey;
  if (!apiKey || apiKey === 'your-openrouter-api-key-here') {
    throw new Error('OPENROUTER_API_KEY not configured');
  }

  const chosenModel = model || config.model.chatDefault;
  const emit = typeof onEvent === 'function' ? onEvent : () => {};

  // ── 0. History compression (Upgrade 5) ──────────────────────────────────
  // Summarise old turns into a compact block so we don't blow the context
  // window on long chats, while keeping the last 4 turns verbatim.
  let effectiveHistory = history || [];
  if (effectiveHistory.length > config.agent.historyCompressTurns) {
    try {
      effectiveHistory = await compressHistory({ history: effectiveHistory, openRouterFetch, apiKey });
    } catch (err) {
      console.warn('[chatbot agent] history compression failed:', err.message || err);
      effectiveHistory = effectiveHistory.slice(-6);
    }
  }

  // ── 0b. User memory retrieval (Upgrade 4) ───────────────────────────────
  // Load persistent facts about this user so the model can personalise
  // answers without needing to be re-introduced every session.
  let memoryBlock = '';
  if (config.features.userMemory && user?.email) {
    try {
      const memories = getUserMemories(user.email);
      memoryBlock = formatMemoryBlock(memories);
    } catch (err) {
      console.warn('[chatbot agent] memory retrieval failed:', err.message || err);
    }
  }

  // ── 1. Pre-retrieval (Upgrade 2: Query Rewriting + HyDE) ─────────────────
  emit({ type: 'retrieval_start' });
  let hits = [];
  try {
    // Expand the query into variants + a HyDE hypothetical document.
    // Falls back to [question] silently on any error.
    const queries = await expandQuery({ question, openRouterFetch, apiKey });
    if (queries.length > 1) {
      hits = await searchTopKMulti(queries, {
        k: config.retrieval.topK,
        userEmail: user?.email || '',
      });
    } else {
      hits = await searchTopK(question, {
        k: config.retrieval.topK,
        userEmail: user?.email || '',
      });
    }
  } catch (err) {
    console.error('[chatbot agent] retrieval failed:', err.message || err);
  }
  emit({ type: 'retrieval_end', hitCount: hits.length });

  // Surface lightweight citation metadata so the widget can render source
  // chips under the answer. We deliberately do NOT include chunk text here
  // (already used in the system prompt) — this is just enough for the user
  // to know "this answer was grounded on these sprint reports".
  if (hits.length) {
    const sources = hits.map((h, i) => {
      const m = h.meta || {};
      if (h.source === 'docs') {
        return {
          rank: i + 1,
          source: 'docs',
          project: m.project || '',
          sprint: m.sprint || '',
          section: m.section || '',
          file: m.file || '',
          score: typeof h.score === 'number' ? Math.round(h.score * 1000) / 1000 : null,
        };
      }
      return {
        rank: i + 1,
        source: 'qa',
        askedBy: m.askedBy || '',
        ageDays: m.ageDays != null ? m.ageDays : null,
        helpful: m.helpful,
        score: typeof h.score === 'number' ? Math.round(h.score * 1000) / 1000 : null,
      };
    });
    emit({ type: 'sources', items: sources });
  }

  // ── 1b. Entity pre-resolution ────────────────────────────────────────────
  // Detect first-class identifiers (JIRA keys, GitHub PR URLs, emails,
  // @logins) in the user's question and pre-fetch them so the LLM has
  // ground-truth payloads on iteration 0 instead of having to plan tool
  // calls. Cheap, parallel, gracefully no-ops if no entities are found.
  let entityBlock = '';
  try {
    entityBlock = await preResolveEntities(question, emit);
  } catch (err) {
    console.warn('[chatbot agent] entity pre-resolve failed:', err.message || err);
  }

  const contextBlock = formatContextBlock(hits);
  const messages = [{ role: 'system', content: buildSystemPrompt(contextBlock, entityBlock, memoryBlock) }];
  // effectiveHistory is either compressed (Upgrade 5) or the raw slice from the
  // widget — either way it's already bounded, so no secondary .slice(-6) needed.
  if (Array.isArray(effectiveHistory) && effectiveHistory.length) {
    for (const m of effectiveHistory) {
      if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
        messages.push({ role: m.role, content: m.content });
      }
    }
  }
  messages.push({ role: 'user', content: question });

  // ── 2. Tool-calling loop with streaming ──────────────────────────────────
  // Upgrade 3a: route tools based on question intent. On iter 0 expose a
  // narrowed subset; subsequent iters always get the full set in case the
  // model needs to pivot (e.g. a person lookup leads to a JIRA query).
  const routedTools = routeTools(question, TOOL_SCHEMAS);
  const allToolCalls = [];
  let finalAnswer = '';
  let llmError = false;
  let qaId = null;

  // Per-question completion budget. `verbose=true` only when the user
  // explicitly asks for a full / detailed answer; otherwise the default
  // ceiling enforces brevity even when the model would otherwise ramble.
  const budget = pickAnswerBudget(question);
  // Trivial small-talk turns ("hi", "thanks", "what can you do") never need
  // tools. Forcing tool_choice='none' on iter 0 stops accidental tool firing
  // and lets us complete in a single round.
  const smallTalk = isSmallTalk(question);

  for (let iter = 0; iter < config.agent.maxIters; iter += 1) {
    const activeTools = iter === 0 ? routedTools : TOOL_SCHEMAS;
    const toolChoice = (iter === 0 && smallTalk) ? 'none' : 'auto';
    const body = {
      model: chosenModel,
      messages,
      tools: activeTools,
      tool_choice: toolChoice,
      temperature: config.agent.temperature,
      max_tokens: budget.maxTokens,
    };

    emit({ type: 'llm_call_start', iter, model: chosenModel });
    let result;
    try {
      result = await streamChatCompletionWithRetry(
        body,
        apiKey,
        (delta) => { emit({ type: 'assistant_chunk', delta }); },
        ({ attempt, reason, delayMs }) => {
          emit({ type: 'llm_retry', iter, attempt, reason, delayMs });
        },
      );
    } catch (err) {
      emit({ type: 'llm_call_end', iter, status: 0, error: err.message || String(err) });
      finalAnswer = `I couldn't reach the LLM provider (OpenRouter): ${err.message || err}. This is usually a network/proxy/TLS issue. Please retry, or pick a different model from the dropdown — sometimes one upstream is down while others are fine.`;
      llmError = true;
      emit({ type: 'final', content: finalAnswer, llmError: true });
      break;
    }
    emit({ type: 'llm_call_end', iter, status: result.status });

    if (result.status < 200 || result.status >= 300) {
      const errMsg = result.data?.error?.message || result.data?.error || result.raw || `OpenRouter returned ${result.status}`;
      const msgStr = typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg);
      finalAnswer = `The LLM provider returned an error (${result.status}): ${msgStr}. ${
        result.status === 401 || result.status === 403 ? 'Check OPENROUTER_API_KEY in jira-md-export/.env.' :
        result.status === 429 ? 'Rate-limited — retry in a minute or pick a different model.' :
        result.status >= 500 ? 'Upstream is having issues — try a different model from the dropdown.' :
        'Try again or pick a different model.'
      }`;
      llmError = true;
      emit({ type: 'final', content: finalAnswer, llmError: true });
      break;
    }

    const toolCalls = Array.isArray(result.tool_calls) ? result.tool_calls.filter(tc => tc?.function?.name) : [];

    if (toolCalls.length === 0) {
      // Surface OpenRouter's `finish_reason: length` to the user. Without this
      // the widget happily renders a half-sentence and the user has no idea
      // the model hit max_tokens. We also append a one-line breadcrumb so the
      // user knows how to ask for more.
      const wasTruncated = result.finishReason === 'length';
      finalAnswer = (result.content || '').trim();
      if (wasTruncated) {
        finalAnswer += '\n\n_(Answer was cut off at the token limit — re-ask with "full report" or "in detail" for the long version.)_';
      }
      messages.push({ role: 'assistant', content: finalAnswer });
      emit(wasTruncated
        ? { type: 'final', content: finalAnswer, truncated: true, reason: 'length' }
        : { type: 'final', content: finalAnswer });
      break;
    }

    // Intermediate iteration produced tool_calls (and possibly some "I'll look
    // this up" narration). Tell the widget to discard any chunks emitted from
    // this iteration; only the FINAL iteration's content should be displayed.
    emit({ type: 'assistant_reset' });

    messages.push({
      role: 'assistant',
      content: result.content || '',
      tool_calls: toolCalls,
    });

    // Upgrade 3b: dispatch all tool calls for this iteration in parallel.
    // Tool results are independent of each other within one LLM turn, so
    // Promise.all is safe and reduces wait time proportionally to call count.
    const toolResults = await Promise.all(toolCalls.map(async (tc) => {
      const fnName = tc.function?.name;
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(tc.function?.arguments || '{}'); } catch (_) { parsedArgs = {}; }
      emit({ type: 'tool_start', name: fnName, args: parsedArgs, id: tc.id });
      const toolResult = await dispatchTool(fnName, parsedArgs);
      emit({ type: 'tool_end', name: fnName, id: tc.id, ok: !toolResult?.error, summary: summariseToolResult(fnName, toolResult), cached: !!toolResult?._cached });
      return { name: fnName, args: parsedArgs, result: toolResult, id: tc.id };
    }));

    for (const { name, args, result: toolResult, id } of toolResults) {
      // Widget timeline + downstream consumers always see the FULL result.
      allToolCalls.push({ name, args, result: toolResult });
      // The LLM, however, only needs the model-relevant fields. Trimming
      // here cuts context bloat 30-60% on leaderboard / sprint / single-
      // ticket payloads, which both speeds up the next round and keeps the
      // model from paraphrasing fields it shouldn't have seen anyway.
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: JSON.stringify(summariseForLLM(name, toolResult)),
      });
    }
  }

  if (!finalAnswer) {
    finalAnswer = `I ran out of reasoning steps after ${config.agent.maxIters} tool rounds. Here's what I gathered: ${allToolCalls.length} tool call(s) ran. Try narrowing the question.`;
    emit({ type: 'final', content: finalAnswer, truncated: true });
  }

  // ── 3. Q+A log + follow-up generation, both fired in parallel ────────────
  // Skip the QA log entirely on LLM-error fallbacks — those aren't real
  // answers and we don't want them surfaced as `prior_answer` next time.
  //
  // qaId is generated SYNCHRONOUSLY here and emitted to the widget right
  // away so feedback/edit buttons become functional immediately, even
  // before the (slower) embed-and-write completes in the background. If
  // the eventual write fails, /api/chatbot/feedback returns 404 and the
  // widget rolls back its optimistic UI.
  if (!llmError) {
    qaId = makeQaId();
    emit({ type: 'qa_id', qaId });
    logQA({
      id: qaId,
      question,
      answer: finalAnswer,
      by: user?.email || '',
      model: chosenModel,
    }).catch(() => { /* errors logged inside logQA */ });

    // Upgrade 4: extract and persist memory facts from this turn (fire-and-forget).
    if (config.features.userMemory && user?.email) {
      extractAndSaveMemories({
        question,
        answer: finalAnswer,
        userEmail: user.email,
        openRouterFetch,
        apiKey,
      });
    }
  }

  // Follow-ups: wait up to 5s before letting the response close. Without this
  // the .then() callback would race the outer res.end() and the `followups`
  // event would silently get dropped by the writableEnded guard in send().
  if (!llmError) {
    const followupPromise = generateFollowups({
      question,
      answer: finalAnswer,
      model: chosenModel,
      openRouterFetch,
      apiKey,
    });
    try {
      const suggestions = await Promise.race([
        followupPromise,
        new Promise((resolve) => setTimeout(() => resolve([]), 5000)),
      ]);
      if (Array.isArray(suggestions) && suggestions.length) {
        emit({ type: 'followups', items: suggestions });
      }
    } catch (_) { /* ignore — never block the response on this */ }
  }

  return {
    answer: finalAnswer,
    toolCalls: allToolCalls,
    model: chosenModel,
    qaId: qaId || null,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool result summariser for the LLM context.
//
// Raw tool results carry rich metadata for the widget timeline (full file
// lists, every comment, the entire leaderboard, etc.) but the LLM rarely
// needs all of it to compose an answer. Re-feeding the whole blob bloats
// context, slows the next round, and tempts the model to paraphrase fields
// it shouldn't surface.
//
// This function produces a model-only view that keeps the answer-relevant
// fields and drops or caps the rest. The widget-side `allToolCalls` array
// still gets the original payload, so source chips / inspector views are
// unaffected.
//
// Errors / hints / cache markers are passed through untouched — those drive
// the model's failure-handling logic.
// ──────────────────────────────────────────────────────────────────────────────
function summariseForLLM(name, r) {
  if (!r || typeof r !== 'object') return r;
  // Always preserve the error-recovery contract.
  if (r.error) {
    return {
      error: r.error,
      source: r.source,
      retryable: r.retryable,
      hint: r.hint,
      ...(r.detail ? { detail: String(r.detail).slice(0, 300) } : {}),
      ...(r.knownProjects ? { knownProjects: r.knownProjects.slice(0, 12) } : {}),
    };
  }

  switch (name) {
    case 'lookup_person': {
      const out = {
        match: r.match,
        matchScore: r.matchScore,
      };
      if (r.lowConfidence) { out.lowConfidence = true; out.hint = r.hint; }
      if (Array.isArray(r.candidates) && r.candidates.length) out.candidates = r.candidates.slice(0, 3);
      return out;
    }

    case 'list_people': {
      const total = r.count;
      const slice = (r.people || []).slice(0, 25).map(p => ({
        displayName: p.displayName, email: p.email, role: p.role, team: p.team, githubLogin: p.githubLogin,
      }));
      const returnedToYou = slice.length;
      const out = {
        total,
        returnedToYou,
        people: slice,
      };
      if (total > returnedToYou) {
        out.narrowingHint =
          `Showing ${returnedToYou} of ${total} people. ` +
          `If the user wants someone specific not in this slice, ask them for a clue or call list_people again with {filter:"<role/team/email-substring>"} to narrow.`;
      }
      return out;
    }

    case 'query_jira': {
      return {
        total: r.total,
        returned: r.returned,
        jql: r.jql,
        issues: (r.issues || []).slice(0, 20).map(i => ({
          key: i.key,
          summary: i.summary,
          status: i.status,
          type: i.type,
          assignee: i.assignee,
          updated: i.updated,
          ...(i.resolved ? { resolved: i.resolved } : {}),
          // SP must round-trip — shapeJiraIssue already populated it.
          ...(i.storyPoints != null ? { storyPoints: i.storyPoints } : {}),
          ...(i.actualStoryPoints != null ? { actualStoryPoints: i.actualStoryPoints } : {}),
        })),
      };
    }

    case 'query_jira_issue': {
      return {
        key: r.key,
        url: r.url,
        summary: r.summary,
        type: r.type,
        status: r.status,
        priority: r.priority,
        assignee: r.assignee,
        assigneeEmail: r.assigneeEmail,
        reporter: r.reporter,
        sprints: r.sprints,
        // SP must round-trip to the LLM — without these, the model says
        // "no story points" even when the tool fetched a real value.
        storyPoints: r.storyPoints,
        ...(r.actualStoryPoints != null ? { actualStoryPoints: r.actualStoryPoints } : {}),
        labels: (r.labels || []).slice(0, 6),
        components: (r.components || []).slice(0, 4),
        fixVersions: (r.fixVersions || []).slice(0, 3),
        parent: r.parent,
        subtasks: (r.subtasks || []).slice(0, 6),
        links: (r.links || []).slice(0, 6),
        created: r.created,
        updated: r.updated,
        resolved: r.resolved,
        description: typeof r.description === 'string' ? r.description.slice(0, 800) : r.description,
        descriptionTruncated: r.descriptionTruncated || (typeof r.description === 'string' && r.description.length > 800),
        commentCount: r.commentCount,
        recentComments: (r.recentComments || []).slice(-2).map(c => ({
          author: c.author,
          created: c.created,
          body: typeof c.body === 'string' ? c.body.slice(0, 200) : c.body,
        })),
      };
    }

    case 'query_github': {
      if (r.metrics) return { login: r.login, org: r.org, windowDays: r.windowDays, since: r.since, metrics: r.metrics };
      return {
        login: r.login,
        org: r.org,
        windowDays: r.windowDays,
        prCount: r.prCount,
        commitCount: r.commitCount,
        prs: (r.prs || []).slice(0, 10),
        commits: (r.commits || []).slice(0, 8).map(c => ({ message: c.message, repo: c.repo, committedAt: c.committedAt })),
      };
    }

    case 'query_github_pr': {
      const out = {
        owner: r.owner, repo: r.repo, number: r.number, url: r.url,
        title: r.title, state: r.state, draft: r.draft, merged: r.merged, mergedAt: r.mergedAt,
        author: r.author, baseBranch: r.baseBranch, headBranch: r.headBranch,
        additions: r.additions, deletions: r.deletions, changedFiles: r.changedFiles,
        labels: r.labels, createdAt: r.createdAt, updatedAt: r.updatedAt,
        filesPreview: (r.filesPreview || []).slice(0, 8),
        reviews: (r.reviews || []).slice(0, 4).map(rv => ({ login: rv.login, state: rv.state, submittedAt: rv.submittedAt })),
        comments: (r.comments || []).slice(-3).map(c => ({ login: c.login, body: typeof c.body === 'string' ? c.body.slice(0, 200) : c.body })),
        body: typeof r.body === 'string' ? r.body.slice(0, 800) : r.body,
      };
      if (r.requestedReviewers && r.requestedReviewers.length) out.requestedReviewers = r.requestedReviewers;
      return out;
    }

    case 'query_copilot': {
      if (r.found === false) return { login: r.login, found: false, note: r.note, period: r.period };
      if (r.found === true) {
        const s = r.stats || {};
        return {
          login: r.login, found: true, period: r.period,
          stats: {
            user_login: s.user_login, lines_accepted: s.lines_accepted,
            lines_suggested: s.lines_suggested, acceptance_rate: s.acceptance_rate,
            chats: s.chats, active_days: s.active_days,
          },
        };
      }
      return {
        period: r.period,
        enterpriseSummary: r.enterpriseSummary,
        leaderboardSize: r.leaderboardSize,
        topUsers: (r.topUsers || []).slice(0, 10).map(u => ({
          user_login: u.user_login,
          lines_accepted: u.lines_accepted,
          acceptance_rate: u.acceptance_rate,
          active_days: u.active_days,
        })),
      };
    }

    case 'query_cursor': {
      if (r.found === false) return { email: r.email, found: false, note: r.note, period: r.period };
      if (r.found === true) {
        const s = r.stats || {};
        return {
          email: r.email, found: true, period: r.period,
          stats: {
            email: s.email, lines_added: s.lines_added,
            acceptance_rate: s.acceptance_rate, agent_requests: s.agent_requests,
            tab_completions: s.tab_completions, active_days: s.active_days,
          },
        };
      }
      return {
        period: r.period,
        sortedBy: r.sortedBy,
        topUsers: (r.topUsers || []).slice(0, 10).map(u => ({
          email: u.email, lines_added: u.lines_added,
          acceptance_rate: u.acceptance_rate, agent_requests: u.agent_requests,
        })),
        modelShare: r.modelShare,
        languageShare: r.languageShare,
        workShare: r.workShare,
      };
    }

    case 'query_confluence': {
      return {
        person: r.person,
        windowDays: r.windowDays,
        since: r.since,
        until: r.until,
        activity: r.activity,
      };
    }

    case 'query_testrail': {
      if (Array.isArray(r.knownProjects)) return { knownProjects: r.knownProjects.slice(0, 12) };
      return {
        projectIds: r.projectIds,
        windowDays: r.windowDays,
        since: r.since,
        until: r.until,
        metrics: r.metrics,
      };
    }

    case 'query_sprint': {
      // Discovery shape: just the sprint list.
      if (Array.isArray(r.sprints)) return { sprints: r.sprints.slice(0, 30), hint: r.hint };
      // Ambiguous: matched multiple, ask the model to disambiguate.
      if (Array.isArray(r.matched)) return { project: r.project, matched: r.matched.slice(0, 10), hint: r.hint };
      // Full hit. Cap content harder than the tool's 12 KB cap unless the
      // user explicitly asked for verbatim/full output (handled prompt-side).
      const SOFT_CAP = 6000;
      const content = typeof r.content === 'string' ? r.content : '';
      const trimmed = content.length > SOFT_CAP ? content.slice(0, SOFT_CAP) + '\n\n[trimmed for context — call again with explicit sprint name for full text]' : content;
      return {
        project: r.project, sprint: r.sprint, manager: r.manager, file: r.file,
        truncated: r.truncated || content.length > SOFT_CAP,
        content: trimmed,
      };
    }

    case 'list_projects': {
      return { count: r.count, projects: (r.projects || []).slice(0, 50) };
    }

    default:
      return r;
  }
}

function summariseToolResult(name, r) {
  if (!r) return 'no result';
  if (r.error) {
    const src = r.source ? `[${r.source}] ` : '';
    const retry = r.retryable ? ' (retryable)' : '';
    return `${src}${String(r.error).slice(0, 140)}${retry}`;
  }
  const cached = r._cached ? ' (cached)' : '';
  if (name === 'lookup_person') {
    return (r.match ? `matched ${r.match.displayName}` : 'no match') + cached;
  }
  if (name === 'query_jira') {
    return `${r.returned ?? 0}/${r.total ?? 0} issues` + cached;
  }
  if (name === 'query_jira_issue') {
    return `${r.key} ${r.status || ''} — ${(r.summary || '').slice(0, 80)}` + cached;
  }
  if (name === 'query_github') {
    if (r.metrics) return 'rich metrics' + cached;
    return `${r.prCount ?? 0} PRs / ${r.commitCount ?? 0} commits in ${r.windowDays ?? '?'}d` + cached;
  }
  if (name === 'query_github_pr') {
    const merged = r.merged ? ' merged' : (r.draft ? ' draft' : '');
    return `${r.owner}/${r.repo}#${r.number} ${r.state}${merged} +${r.additions}/-${r.deletions} ${r.changedFiles}f` + cached;
  }
  if (name === 'query_copilot') {
    if (r.found === false) return 'not on Copilot leaderboard' + cached;
    if (r.found === true) return `${r.stats?.lines_accepted ?? 0} lines accepted, ${r.stats?.acceptance_rate ?? 'n/a'} acceptance` + cached;
    return `top ${r.topUsers?.length ?? 0} of ${r.leaderboardSize ?? 0}` + cached;
  }
  if (name === 'query_cursor') {
    if (r.found === false) return 'not on Cursor leaderboard' + cached;
    if (r.found === true) return `${r.stats?.lines_added ?? 0} lines added, ${r.stats?.acceptance_rate ?? 'n/a'} acceptance` + cached;
    return `top ${r.topUsers?.length ?? 0} sorted by ${r.sortedBy}` + cached;
  }
  if (name === 'query_confluence') {
    return `${r.activity?.contributed ?? 0} pages (${r.activity?.created ?? 0} created) in ${r.windowDays ?? '?'}d` + cached;
  }
  if (name === 'query_testrail') {
    if (Array.isArray(r.knownProjects)) return `no project given — ${r.knownProjects.length} known` + cached;
    return `${r.metrics?.runsCreated ?? 0} runs, ${r.metrics?.casesCreated ?? 0} cases in ${r.windowDays ?? '?'}d` + cached;
  }
  if (name === 'query_sprint') {
    if (Array.isArray(r.sprints)) return `${r.sprints.length} sprints listed` + cached;
    if (Array.isArray(r.matched)) return `${r.matched.length} match(es) — ambiguous` + cached;
    return `${r.project} — ${r.sprint}${r.truncated ? ' (truncated)' : ''}` + cached;
  }
  if (name === 'list_projects') {
    return `${r.count ?? 0} projects` + cached;
  }
  if (name === 'list_people') {
    return `${r.returned ?? 0}/${r.count ?? 0} people` + cached;
  }
  return 'ok' + cached;
}

module.exports = { ask };
