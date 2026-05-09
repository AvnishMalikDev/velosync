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
const https = require('https');
const config = require('./config');
const { searchTopK, searchTopKMulti, formatContextBlock } = require('./embeddings/search');
const { logQA, makeQaId } = require('./embeddings/qaLog');
const { getUserMemories, formatMemoryBlock, extractAndSaveMemories } = require('./embeddings/userMemory');
const { TOOL_SCHEMAS, dispatchTool } = require('./tools');

const SYSTEM_PROMPT_BASE = `You are the VeloSync Engineering Dashboard's AI assistant. You answer questions about projects, sprints, people, JIRA, GitHub, AI tool adoption (Copilot + Cursor), Confluence, and TestRail QA.

# CONTEXT CHANNELS YOU MAY RECEIVE
- <context source="docs"> ............ ground truth from generated sprint MDs (Copilot/Cursor/GitHub/Confluence/TestRail sections per project per sprint).
- <context source="prior_answer"> ..... hints from past chats. Trust for stable facts; if the question is time-sensitive (>7d old), re-verify with a tool.
- <entity_resolved type="..."> ........ pre-resolved entities (JIRA issue, GitHub PR, person) the orchestrator already fetched before this turn — TRUST THIS DATA AND DO NOT REFETCH unless the user explicitly asks for fresher data.
- "Persistent context about this user" . known facts about the person you are talking to — their role, projects, preferences. Use this to personalise answers without asking again.

# TOOLS (12)
PEOPLE
  lookup_person(name)                            ? email + accountId + GitHub login. Call FIRST when the user names someone.
  list_people(filter?)                           ? bulk dump of the resource directory (optionally filtered). Use for "who is on team X" / "list QA managers".
WORK
  query_jira(jql, maxResults?)                   ? live JQL. Use for current tickets, open bugs, project membership, sprint scope.
  query_jira_issue(key)                          ? ONE ticket with full detail (description, comments, subtasks, links). Use whenever the user names a key like "HDE-1234" or pastes a JIRA URL.
  query_github(login, days?, richMetrics?)       ? recent PRs + commits in the org. richMetrics=true for full lines-changed payload (slower).
  query_github_pr(repo, number?)                 ? ONE PR with full detail (files changed, reviews, comments, merge state). Use whenever the user names a PR URL or "repo#123".
AI ADOPTION
  query_copilot(login? | top?)                   ? cached output/copilotdata.json (top-25, last ~28d).
  query_cursor(email? | top?, sortBy?)           ? cached output/cursordata.json + org model/language/work share.
DOCS & QA
  query_confluence(name, days?)                  ? live per-person Confluence activity.
  query_testrail(projectIds? | projectName?, days?) ? live TestRail runs/cases/automation. No project ? returns known projects.
SPRINTS & PROJECTS
  query_sprint(project, sprint?)                 ? deterministic full-text fetch of a sprint MD report. Use when the user wants the raw sprint report verbatim.
  list_projects()                                ? enumerate projects from projects.json (names, keys, managers, TestRail IDs).

# ENTITY RECOGNITION (use these patterns to pick the right tool)
- "HDE-1234", "ESA-87", any /^[A-Z]{2,}-\\d+$/                  ? query_jira_issue(key) — DO NOT use query_jira with key=X.
- "https://<host>/browse/HDE-1234"                              ? extract the trailing key, then query_jira_issue.
- "github.com/org/repo/pull/123" or "repo#123"                  ? query_github_pr.
- "@avnishm" or a bare GitHub login                             ? query_github(login=...). If you need their identity too, also call lookup_person.
- An email "name@domain"                                        ? lookup_person with the email's local part as name; the row matches on the email field too.
- A bare first name or "Firstname Lastname"                     ? lookup_person first (cheap, cached). Cascade to query_jira / query_github / query_confluence as needed.
- "what is X working on" + person                               ? lookup_person ? query_jira(assignee = "<email>" AND statusCategory != Done) AND query_github(login=...).

# DECISION ORDER
1. If <entity_resolved> already covers the question, answer from it directly without further tool calls.
2. Else if retrieved <context source="docs"/"prior_answer"> already answers, use it. Don't tool unnecessarily.
3. For live data (current tickets, today's PRs, "right now"), call tools.
4. To resolve a person ? always lookup_person first, then chain.
5. For "show me the full HDE Sprint X report" ? query_sprint, not retrieval.
  6. Hard cap: 6 tool rounds (orchestrator will terminate the loop).

# FAILURE HANDLING (NON-NEGOTIABLE)
Every tool can fail. When a tool result is { error, source, hint, retryable, … }:
  1. STATE THE FAILURE plainly to the user. Don't hide it. Don't pretend the tool worked.
       e.g. "I couldn't reach JIRA — the API returned 401 (auth)."
  2. READ THE \`hint\` FIELD — it tells you the right fallback. Follow it.
  3. ONE RETRY MAX. If retryable=true and the issue was a malformed call, retry once with simpler args. Otherwise don't retry the same tool.
  4. PROPOSE A FALLBACK in plain language:
       "Want me to check the latest sprint MD instead?"   ? when JIRA/GitHub down
       "Want me to try GitHub PRs as a proxy for what they've been working on?" ? when JIRA down
       "Want me to look at the Copilot/Cursor leaderboards instead?" ? when GitHub down
       "I have historical TestRail numbers from the last sprint snapshot — want those?" ? when TestRail down
  5. NEVER INVENT data when a tool failed. No fake JIRA keys, logins, counts, or dates. Better to say "I don't have that right now" than to hallucinate.
  6. If MULTIPLE tools fail in one turn, summarise what's broken and let the user pick a direction. Don't keep firing.
  7. If the failure is a config issue (missing env), tell the user the exact env var and where it lives (jira-md-export/.env).

# OUTPUT STYLE
- Concise. No "I'd be happy to help" filler. No restating the question.
- Markdown OK: **bold**, bullets, links, code spans. Tables only when the user asks.
- Cite sprint MDs as "<Project> — <Sprint>" inline.
- Numbers: copy verbatim from tool output. Don't round, don't paraphrase.
- "No data" answers: say "no <X> in the last <window>" plainly. Don't speculate.`;

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

// ------------------------------------------------------------------------------
// Streaming HTTP helper. Keeps the same TLS pattern as tools/index.js so corp
// proxies / self-signed certs are handled identically. Returns the merged
// `{ content, tool_calls, finishReason, status }` after the SSE stream ends.
// ------------------------------------------------------------------------------

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
        'X-Title': 'VeloSync Dashboard Chatbot',
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

// ------------------------------------------------------------------------------
// Entity pre-resolution.
// We scan the user's question for first-class identifiers (JIRA keys, GitHub
// PR URLs, GitHub logins, email addresses) and pre-fetch the corresponding
// data BEFORE the main LLM loop runs. The fetched payloads get injected into
// the system prompt as <entity_resolved> blocks. Net effect:
//   - 1 fewer LLM round in the typical "tell me about HDE-1234" case.
//   - The model gets ground-truth ticket/PR data on iter 0 instead of having
//     to plan-tool-respond.
//   - Less hallucination when a key is paraphrased poorly.
// ------------------------------------------------------------------------------

// JIRA key inside word boundaries. Bounded length keeps random ALL_CAPS-N
// tokens from being misread as keys.
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;
// JIRA URL ? /browse/<KEY>
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
  for (const m of text.matchAll(JIRA_URL_RE)) jiraKeys.push(m[1].toUpperCase());
  for (const m of text.matchAll(JIRA_KEY_RE)) jiraKeys.push(`${m[1]}-${m[2]}`);

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
async function preresolveEntities(question, emit) {
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
        blocks.push(
          `<entity_resolved type="jira_issue" key="${escapeXml(r.key)}" url="${escapeXml(r.url)}">\n` +
          `summary: ${r.summary}\n` +
          `status: ${r.status} (${r.statusCategory})  type: ${r.type}  priority: ${r.priority || '-'}\n` +
          `assignee: ${r.assignee || '-'} (${r.assigneeEmail || ''})\n` +
          `reporter: ${r.reporter || '-'}\n` +
          (sprintStr ? `sprint: ${sprintStr}\n` : '') +
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
          `branches: ${r.headBranch} ? ${r.baseBranch}\n` +
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

// ------------------------------------------------------------------------------
// Upgrade 2 — Query Rewriting + HyDE.
//
// Before retrieval, ask the fast model to produce 2 alternative phrasings of
// the user's question AND a "hypothetical answer document" (HyDE). All 3+1
// (original + 2 variants + HyDE) are embedded and their cosine scores fused
// via max-score in searchTopKMulti. This dramatically improves recall for
// short/ambiguous/non-English queries.
// ------------------------------------------------------------------------------

/**
 * Expand a user query into multiple variants + a HyDE document.
 * Returns an array starting with the original query followed by variants.
 * Falls back to [question] on any error so the caller always gets something.
 *
 * @param {{ question: string, openRouterFetch: Function, apiKey: string }} opts
 * @returns {Promise<string[]>}
 */
async function expandQuery({ question, openRouterFetch, apiKey }) {
  if (!config.features.queryRewrite) return [question];
  const model = config.model.fastModel;
  const messages = [
    {
      role: 'system',
      content:
        'You improve search retrieval for an engineering sprint-tracking dashboard. ' +
        'Given a user question, return a JSON object with two keys:\n' +
        '"variants": array of exactly 2 short alternative phrasings (=120 chars each) that would match different relevant sprint/JIRA/GitHub documents.\n' +
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

// ------------------------------------------------------------------------------
// Upgrade 3a — Intent-based Tool Router.
//
// Light keyword routing narrows the tools list exposed to the LLM based on
// the question's likely domain. This reduces token overhead, cuts hallucinated
// tool calls, and is entirely rule-based (zero LLM call).
// ------------------------------------------------------------------------------

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

// ------------------------------------------------------------------------------
// Upgrade 5 — Conversation History Compression.
//
// When history exceeds `historyCompressTurns` turns, older turns are
// summarised into a single "Earlier conversation" message. The last 4 turns
// are always kept verbatim so the model has immediate context.
// ------------------------------------------------------------------------------

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

// ------------------------------------------------------------------------------
// Follow-up generator. Cheap separate completion. Uses the injected (non-
// streaming) openRouterFetch so corp-proxy handling stays identical.
// ------------------------------------------------------------------------------

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

  // -- 0. History compression (Upgrade 5) ----------------------------------
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

  // -- 0b. User memory retrieval (Upgrade 4) -------------------------------
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

  // -- 1. Pre-retrieval (Upgrade 2: Query Rewriting + HyDE) -----------------
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

  // -- 1b. Entity pre-resolution --------------------------------------------
  // Detect first-class identifiers (JIRA keys, GitHub PR URLs, emails,
  // @logins) in the user's question and pre-fetch them so the LLM has
  // ground-truth payloads on iteration 0 instead of having to plan tool
  // calls. Cheap, parallel, gracefully no-ops if no entities are found.
  let entityBlock = '';
  try {
    entityBlock = await preresolveEntities(question, emit);
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

  // -- 2. Tool-calling loop with streaming ----------------------------------
  // Upgrade 3a: route tools based on question intent. On iter 0 expose a
  // narrowed subset; subsequent iters always get the full set in case the
  // model needs to pivot (e.g. a person lookup leads to a JIRA query).
  const routedTools = routeTools(question, TOOL_SCHEMAS);
  const allToolCalls = [];
  let finalAnswer = '';
  let llmError = false;
  let qaId = null;

  for (let iter = 0; iter < config.agent.maxIters; iter += 1) {
    const activeTools = iter === 0 ? routedTools : TOOL_SCHEMAS;
    const body = {
      model: chosenModel,
      messages,
      tools: activeTools,
      tool_choice: 'auto',
      temperature: config.agent.temperature,
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
      finalAnswer = (result.content || '').trim();
      messages.push({ role: 'assistant', content: finalAnswer });
      // qaId is filled in once logQA resolves below.
      emit({ type: 'final', content: finalAnswer });
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
      allToolCalls.push({ name, args, result: toolResult });
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  if (!finalAnswer) {
    finalAnswer = `I ran out of reasoning steps after ${config.agent.maxIters} tool rounds. Here's what I gathered: ${allToolCalls.length} tool call(s) ran. Try narrowing the question.`;
    emit({ type: 'final', content: finalAnswer, truncated: true });
  }

  // -- 3. Q+A log + follow-up generation, both fired in parallel ------------
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
