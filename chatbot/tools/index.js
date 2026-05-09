/**
 * Live tools used by the agent loop. Every dashboard data source has a tool
 * so the user can ask anything:
 *
 *   - lookup_person   : resource directory + fuzzy match (no network)
 *   - query_jira      : live JIRA REST (basic auth from jira-md-export/.env)
 *   - query_github    : live GitHub search; richMetrics=true ? dynamic import
 *                       of jira-md-export/get-github-metrics.js for the
 *                       full PR + commit + lines-changed payload.
 *   - query_copilot   : reads output/copilotdata.json (top-25 user leaderboard
 *                       refreshed by the daily jira-md-export run).
 *   - query_cursor    : reads output/cursordata.json (top-10 leaderboard +
 *                       org model/language/work share + per-repo edits).
 *   - query_confluence: live per-user Confluence activity via dynamic import
 *                       of jira-md-export/get-confluence-data.js.
 *   - query_testrail  : live TestRail metrics (cases/runs/automation) via
 *                       dynamic import of jira-md-export/get-testrail-data.js.
 *
 * All schemas are OpenAI function-calling shape (works on OpenRouter for any
 * model that supports `tools`).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('../config');
const { parseMdHeader } = require('../embeddings/indexer');

// ------------------------------------------------------------------------------
// Small fuzzy-match utilities (copied from server.js so the chatbot module
// has zero reverse imports — see chatbot/README.md for the rationale).
// ------------------------------------------------------------------------------

function normalizeName(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const s = normalizeName(a);
  const t = normalizeName(b);
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const dp = Array.from({ length: s.length + 1 }, () => new Array(t.length + 1).fill(0));
  for (let i = 0; i <= s.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= t.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[s.length][t.length];
}

function tokenOverlap(a, b) {
  const aTok = new Set(normalizeName(a).split(' ').filter(Boolean));
  const bTok = new Set(normalizeName(b).split(' ').filter(Boolean));
  if (!aTok.size || !bTok.size) return 0;
  let overlap = 0;
  aTok.forEach(t => { if (bTok.has(t)) overlap += 1; });
  return overlap / Math.max(aTok.size, bTok.size);
}

function nameScore(query, candidate) {
  const nq = normalizeName(query);
  const nc = normalizeName(candidate);
  if (!nq || !nc) return 0;
  if (nq === nc) return 1;

  const qTok = nq.split(' ').filter(Boolean);
  const cTok = nc.split(' ').filter(Boolean);

  // Strong: full first+last token sequence match (substring), e.g.
  // query "Avnish Malik" against candidate "avnish malik (IDC)".
  if (qTok.length >= 2 && cTok.length >= 2 && qTok[0] === cTok[0] && qTok[1] === cTok[1]) {
    return 0.95;
  }

  // Strong: query is a single token equal to candidate's first OR last token.
  // Handles "Avnish" ? "Avnish Malik (IDC)", "Greenwald" ? "Matthew Greenwald".
  if (qTok.length === 1) {
    if (cTok[0] === qTok[0]) return 0.85;
    if (cTok[cTok.length - 1] === qTok[0]) return 0.78;
  }

  // Strong: "First L" / "F Last" abbreviation form.
  // Handles "Avnish M" ? "Avnish Malik" or "A Malik" ? "Avnish Malik".
  if (qTok.length >= 2 && cTok.length >= 2) {
    if (qTok[0] === cTok[0] && qTok[1].length === 1 && cTok[1].startsWith(qTok[1])) return 0.9;
    if (cTok[0] === qTok[0] && cTok[1].length === 1 && qTok[1].startsWith(cTok[1])) return 0.9;
  }

  const maxLen = Math.max(nq.length, nc.length);
  const lev = 1 - (levenshtein(nq, nc) / Math.max(1, maxLen));
  return 0.65 * lev + 0.35 * tokenOverlap(nq, nc);
}

// ------------------------------------------------------------------------------
// Tool 1: lookup_person
// ------------------------------------------------------------------------------

function readresourceDirectory() {
  try {
    const raw = fs.readFileSync(config.paths.resourceDirectory, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.users)) return parsed.users;
    return [];
  } catch (_) {
    return [];
  }
}

async function lookupPerson({ name }) {
  if (!name || !String(name).trim()) {
    return { error: 'name is required', source: 'lookup_person', retryable: true, hint: 'Ask the user to provide a name.' };
  }
  const query = String(name).trim();
  const users = readresourceDirectory();
  if (!users.length) {
    return failConfig(
      'lookup_person',
      ['resource-directory.json'],
      'Tell the user the resource directory is empty/missing and to refresh it from the dashboard header before asking person-related questions again.'
    );
  }

  const ranked = users
    .map(u => ({ user: u, score: nameScore(query, u.displayName || '') }))
    .filter(r => r.score >= 0.45)
    .sort((a, b) => b.score - a.score);

  const exact = ranked.find(r => r.score >= 0.99);
  const top = exact ? [exact] : ranked.slice(0, 3);

  if (!top.length) {
    return {
      match: null,
      candidates: [],
      note: `No close match for "${query}" in the resource directory. Ask the user to confirm the spelling, or try a single first/last name.`,
    };
  }

  const shape = (u) => ({
    displayName: u.displayName || '',
    email: u.email || '',
    accountId: u.accountId || '',
    githubLogin: u.githubLogin || null,
    testRailUserId: u.testRailUserId || null,
    avatarUrl: u.avatarUrl || '',
  });

  return {
    match: shape(top[0].user),
    matchScore: Math.round(top[0].score * 100) / 100,
    candidates: top.slice(1).map(r => ({ ...shape(r.user), score: Math.round(r.score * 100) / 100 })),
  };
}

// ------------------------------------------------------------------------------
// Tool 2: query_jira
// ------------------------------------------------------------------------------

function jiraRequest(pathPart, auth) {
  return new Promise((resolve, reject) => {
    const allowInsecure = config.openRouter.allowInsecureTls;
    const options = {
      hostname: config.jira.domain,
      path: pathPart,
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
      ...(allowInsecure && { agent: new https.Agent({ rejectUnauthorized: false }) }),
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (ch) => { data += ch; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          reject(new Error('Invalid JSON from JIRA'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function shapeJiraIssue(issue) {
  const f = issue.fields || {};
  return {
    key: issue.key,
    summary: f.summary || '',
    status: f.status?.name || '',
    statusCategory: f.status?.statusCategory?.name || '',
    type: f.issuetype?.name || '',
    priority: f.priority?.name || '',
    assignee: f.assignee?.displayName || null,
    reporter: f.reporter?.displayName || null,
    project: f.project?.key || (issue.key || '').split('-')[0],
    created: f.created || '',
    updated: f.updated || '',
    resolved: f.resolutiondate || null,
  };
}

async function queryJira({ jql, maxResults }) {
  if (!jql || !String(jql).trim()) {
    return { error: 'jql is required', source: 'jira', retryable: true, hint: 'Provide a JQL string.' };
  }
  const missing = [];
  if (!config.jira.email) missing.push('JIRA_EMAIL');
  if (!config.jira.token) missing.push('JIRA_TOKEN');
  if (!config.jira.domain) missing.push('JIRA_DOMAIN');
  if (missing.length) {
    return failConfig('jira', missing, 'JIRA tool unavailable. You can still answer historical questions from retrieved <context source="docs"> if it covers the project/sprint, or try GitHub for code-level activity.');
  }
  const cap = Math.max(1, Math.min(parseInt(maxResults, 10) || 15, 25));
  const auth = Buffer.from(`${config.jira.email}:${config.jira.token}`).toString('base64');

  const fields = 'summary,status,priority,assignee,reporter,issuetype,project,created,updated,resolutiondate';
  const params = new URLSearchParams();
  params.set('jql', jql);
  params.set('maxResults', String(cap));
  params.set('fields', fields);

  try {
    const result = await jiraRequest(`/rest/api/3/search/jql?${params.toString()}`, auth);
    if (result.status < 200 || result.status >= 300) {
      return failHttp(result.status, result.data, 'jira');
    }
    const issues = (result.data.issues || []).map(shapeJiraIssue);
    return {
      total: result.data.total || issues.length,
      returned: issues.length,
      issues,
      jql,
    };
  } catch (err) {
    return failNetwork(err, 'jira');
  }
}

// ------------------------------------------------------------------------------
// Tool 3: query_github
// ------------------------------------------------------------------------------

function githubSearch(pathPart, token) {
  return new Promise((resolve, reject) => {
    const allowInsecure = config.openRouter.allowInsecureTls;
    const options = {
      hostname: 'api.github.com',
      path: pathPart,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'VeloSync-dashboard-chatbot',
      },
      ...(allowInsecure && { agent: new https.Agent({ rejectUnauthorized: false }) }),
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (ch) => { data += ch; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          reject(new Error('Invalid JSON from GitHub'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function queryGithub({ login, days, richMetrics }) {
  if (!login || !String(login).trim()) {
    return { error: 'login is required', source: 'github', retryable: true, hint: 'resolve the user name to a GitHub login via lookup_person first.' };
  }
  const missing = [];
  if (!config.github.token) missing.push('GITHUB_TOKEN');
  if (!config.github.org) missing.push('ORG');
  if (missing.length) {
    return failConfig('github', missing, 'GitHub tool unavailable. Try query_copilot/query_cursor for AI-coding metrics or fall back to retrieved <context source="docs"> for historical PR data.');
  }
  const lookbackDays = Math.max(1, Math.min(parseInt(days, 10) || 30, 90));
  const since = isoDaysAgo(lookbackDays);
  const org = config.github.org;
  const cleanLogin = String(login).trim().replace(/^@/, '');

  // Rich path: dynamic import of the jira-md-export helper. This is the
  // explicit reuse of the existing exported library.
  if (richMetrics) {
    try {
      const mod = await importEsm(config.paths.githubMetricsModule);
      if (mod.isBotLogin && mod.isBotLogin(cleanLogin)) {
        return {
          error: `${cleanLogin} looks like a bot/service account`,
          source: 'github',
          retryable: false,
          hint: 'Tell the user this is a bot; ask them to clarify the human author.',
        };
      }
      const endDate = new Date().toISOString().slice(0, 10);
      const metrics = await mod.getGitHubMetricsForUser(cleanLogin, org, since, endDate, config.github.token);
      return {
        login: cleanLogin,
        org,
        windowDays: lookbackDays,
        since,
        until: endDate,
        metrics,
      };
    } catch (err) {
      return failNetwork(err, 'github');
    }
  }

  // Lightweight path: GitHub search API for PRs and (recent) commits.
  try {
    const prQ = encodeURIComponent(`is:pr author:${cleanLogin} org:${org} created:>=${since}`);
    const prRes = await githubSearch(`/search/issues?q=${prQ}&per_page=20&sort=created&order=desc`, config.github.token);
    if (prRes.status < 200 || prRes.status >= 300) {
      return failHttp(prRes.status, prRes.data, 'github');
    }
    const commitsQ = encodeURIComponent(`author:${cleanLogin} org:${org} committer-date:>=${since}`);
    const commitsRes = await githubSearch(`/search/commits?q=${commitsQ}&per_page=20&sort=committer-date&order=desc`, config.github.token);
    if (commitsRes.status < 200 || commitsRes.status >= 300) {
      return failHttp(commitsRes.status, commitsRes.data, 'github');
    }

    const prs = (prRes.data?.items || []).map(it => ({
      title: it.title,
      url: it.html_url,
      state: it.state,
      repo: (it.repository_url || '').split('/').slice(-1)[0],
      createdAt: it.created_at,
      mergedAt: it.pull_request?.merged_at || null,
    }));
    const commits = (commitsRes.data?.items || []).map(it => ({
      message: (it.commit?.message || '').split('\n')[0].slice(0, 160),
      url: it.html_url,
      repo: it.repository?.name || '',
      committedAt: it.commit?.committer?.date || '',
    }));

    return {
      login: cleanLogin,
      org,
      windowDays: lookbackDays,
      since,
      prCount: prRes.data?.total_count ?? prs.length,
      commitCount: commitsRes.data?.total_count ?? commits.length,
      prs,
      commits,
    };
  } catch (err) {
    return failNetwork(err, 'github');
  }
}

// ------------------------------------------------------------------------------
// Tool 3b: query_jira_issue — fetch one ticket by key with full detail.
// More efficient + richer than `query_jira` with `key=X` JQL because it pulls
// the entire single-issue payload (description, comments, subtasks, links)
// in one round-trip.
// ------------------------------------------------------------------------------

/**
 * Convert Atlassian Document Format (ADF) to plain text. JIRA Cloud returns
 * descriptions/comments as ADF JSON; we walk the tree and concatenate text
 * so the LLM gets a flat string instead of a 200-line JSON it has to parse.
 */
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'paragraph') return adfToText(node.content) + '\n\n';
  if (node.type === 'heading') return `\n${'#'.repeat(node.attrs?.level || 2)} ${adfToText(node.content)}\n\n`;
  if (node.type === 'bulletList' || node.type === 'orderedList') return adfToText(node.content);
  if (node.type === 'listItem') return `- ${adfToText(node.content).trim()}\n`;
  if (node.type === 'codeBlock') return `\`\`\`\n${adfToText(node.content)}\n\`\`\`\n`;
  if (node.type === 'inlineCard' || node.type === 'mention') return node.attrs?.url || node.attrs?.text || '';
  if (node.content) return adfToText(node.content);
  return '';
}

/**
 * Find the active sprint customfield value. Different JIRA cloud sites use
 * different IDs (commonly `customfield_10020` or `customfield_10010`); we
 * scan all customfields for a sprint-shaped object so we don't hard-code
 * the wrong one for a given site.
 */
function extractSprints(fields) {
  if (!fields) return [];
  for (const k of Object.keys(fields)) {
    if (!k.startsWith('customfield_')) continue;
    const v = fields[k];
    if (Array.isArray(v) && v.length && v[0] && (v[0].name || typeof v[0] === 'string')) {
      // Sprint values can come back as raw strings ("com.atlassian.greenhopper.service.sprint.Sprint@...")
      // or as objects { id, name, state, startDate, endDate }
      const shaped = v.map(s => {
        if (typeof s === 'string') {
          const m = s.match(/name=([^,]+).*?state=([^,]+)/);
          return m ? { name: m[1], state: m[2] } : { name: s.slice(0, 80) };
        }
        return { id: s.id, name: s.name, state: s.state, startDate: s.startDate, endDate: s.endDate };
      });
      const looksLikeSprint = shaped.some(s => s.state && /active|future|closed/i.test(s.state));
      if (looksLikeSprint) return shaped;
    }
  }
  return [];
}

async function queryJiraIssue({ key }) {
  const issueKey = String(key || '').trim().toUpperCase();
  if (!issueKey || !/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(issueKey)) {
    return {
      error: 'invalid issue key',
      source: 'jira',
      retryable: true,
      hint: 'Pass a key like "HDE-1234". If the user gave a JIRA URL, parse the trailing /browse/<KEY> segment and call again.',
    };
  }
  const missing = [];
  if (!config.jira.email) missing.push('JIRA_EMAIL');
  if (!config.jira.token) missing.push('JIRA_TOKEN');
  if (!config.jira.domain) missing.push('JIRA_DOMAIN');
  if (missing.length) {
    return failConfig('jira', missing, 'JIRA tool unavailable. You can still answer historical questions from retrieved <context source="docs"> if it covers the project/sprint.');
  }
  const auth = Buffer.from(`${config.jira.email}:${config.jira.token}`).toString('base64');

  // Fetch the issue with everything useful in one call.
  const fields = [
    'summary', 'status', 'priority', 'assignee', 'reporter', 'creator', 'issuetype',
    'project', 'created', 'updated', 'resolutiondate', 'duedate',
    'description', 'labels', 'components', 'fixVersions', 'versions',
    'parent', 'subtasks', 'issuelinks',
    'comment', 'attachment', '*all',
  ].join(',');
  try {
    const result = await jiraRequest(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields)}&expand=renderedFields,names`,
      auth,
    );
    if (result.status === 404) {
      return {
        error: `JIRA issue ${issueKey} not found`,
        source: 'jira',
        retryable: false,
        hint: 'The key is well-formed but does not exist (or the user lacks permission). Tell the user plainly and ask if they meant a different key.',
      };
    }
    if (result.status < 200 || result.status >= 300) {
      return failHttp(result.status, result.data, 'jira');
    }
    const issue = result.data;
    const f = issue.fields || {};
    const description = adfToText(f.description).trim();
    const sprints = extractSprints(f);
    const comments = ((f.comment && f.comment.comments) || []).slice(-5).map(c => ({
      author: c.author?.displayName || '',
      created: c.created || '',
      body: adfToText(c.body).trim().slice(0, 800),
    }));
    const subtasks = (f.subtasks || []).map(s => ({
      key: s.key,
      summary: s.fields?.summary || '',
      status: s.fields?.status?.name || '',
    }));
    const links = (f.issuelinks || []).map(l => {
      const rel = l.type?.outward || l.type?.inward || '';
      const other = l.outwardIssue || l.inwardIssue || {};
      return { relation: rel, key: other.key || '', summary: other.fields?.summary || '' };
    });
    const browseUrl = `https://${config.jira.domain}/browse/${issueKey}`;
    return {
      key: issueKey,
      url: browseUrl,
      summary: f.summary || '',
      type: f.issuetype?.name || '',
      status: f.status?.name || '',
      statusCategory: f.status?.statusCategory?.name || '',
      priority: f.priority?.name || '',
      assignee: f.assignee?.displayName || null,
      assigneeEmail: f.assignee?.emailAddress || null,
      reporter: f.reporter?.displayName || null,
      project: f.project?.key || issueKey.split('-')[0],
      created: f.created || '',
      updated: f.updated || '',
      resolved: f.resolutiondate || null,
      dueDate: f.duedate || null,
      labels: f.labels || [],
      components: (f.components || []).map(c => c.name),
      fixVersions: (f.fixVersions || []).map(v => v.name),
      sprints,
      parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || '' } : null,
      subtasks,
      links,
      description: description.slice(0, 4000),
      descriptionTruncated: description.length > 4000,
      commentCount: ((f.comment && f.comment.comments) || []).length,
      recentComments: comments,
      attachmentCount: (f.attachment || []).length,
    };
  } catch (err) {
    return failNetwork(err, 'jira');
  }
}

// ------------------------------------------------------------------------------
// Tool 3c: query_github_pr — fetch a single PR with files + reviews + comments.
// Accepts repo as "name", "org/name", or a full PR URL (number is then optional).
// ------------------------------------------------------------------------------

/**
 * Parse various GitHub PR specifiers:
 *   - "https://github.com/VeloSync-platform/repo/pull/123"
 *   - "VeloSync-platform/repo#123"
 *   - "repo#123"     (org defaults to config.github.org)
 *   - { repo: "repo", number: 123 }
 *   - { repo: "org/repo", number: 123 }
 * Returns { owner, repo, number } or null.
 */
function parseGithubPrRef(repoArg, numberArg) {
  const defaultOwner = config.github.org || '';
  let owner = defaultOwner;
  let repo = '';
  let number = parseInt(numberArg, 10);

  if (typeof repoArg === 'string') {
    const s = repoArg.trim();
    const urlMatch = s.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/i);
    if (urlMatch) {
      owner = urlMatch[1];
      repo = urlMatch[2];
      number = parseInt(urlMatch[3], 10);
    } else {
      const hashMatch = s.match(/^([\w.-]+\/)?([\w.-]+)#(\d+)$/);
      if (hashMatch) {
        if (hashMatch[1]) owner = hashMatch[1].slice(0, -1);
        repo = hashMatch[2];
        number = parseInt(hashMatch[3], 10);
      } else if (s.includes('/')) {
        const [o, r] = s.split('/', 2);
        owner = o;
        repo = r;
      } else {
        repo = s;
      }
    }
  }
  if (!repo || !Number.isFinite(number) || number <= 0 || !owner) return null;
  return { owner, repo, number };
}

async function queryGithubPr({ repo, number }) {
  const ref = parseGithubPrRef(repo, number);
  if (!ref) {
    return {
      error: 'could not resolve PR reference',
      source: 'github',
      retryable: true,
      hint: 'Pass either a full PR URL ("https://github.com/org/repo/pull/123"), an "org/repo#123" form, or repo + number as separate args (defaults org to config.github.org).',
    };
  }
  const missing = [];
  if (!config.github.token) missing.push('GITHUB_TOKEN');
  if (!ref.owner) missing.push('ORG');
  if (missing.length) {
    return failConfig('github', missing, 'GitHub tool unavailable. Provide owner explicitly via repo="org/name" if ORG env is missing.');
  }

  const base = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  try {
    const prRes = await githubSearch(base, config.github.token);
    if (prRes.status === 404) {
      return {
        error: `GitHub PR ${ref.owner}/${ref.repo}#${ref.number} not found`,
        source: 'github',
        retryable: false,
        hint: 'PR does not exist (or token lacks scope on the repo). Tell the user plainly and ask for clarification.',
      };
    }
    if (prRes.status < 200 || prRes.status >= 300) return failHttp(prRes.status, prRes.data, 'github');

    // Files (paginated; cap at 30 — GitHub returns up to 100 per page but
    // 30 is plenty for a summary and keeps the LLM payload tight).
    let files = [];
    try {
      const fr = await githubSearch(`${base}/files?per_page=30`, config.github.token);
      if (fr.status >= 200 && fr.status < 300 && Array.isArray(fr.data)) {
        files = fr.data.map(f => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        }));
      }
    } catch (_) { /* tolerate, continue */ }

    // Reviews + comments — both optional, tolerate failures.
    let reviews = [];
    try {
      const rr = await githubSearch(`${base}/reviews?per_page=20`, config.github.token);
      if (rr.status >= 200 && rr.status < 300 && Array.isArray(rr.data)) {
        reviews = rr.data.map(r => ({
          login: r.user?.login || '',
          state: r.state || '',
          submittedAt: r.submitted_at || '',
          body: (r.body || '').slice(0, 400),
        }));
      }
    } catch (_) { /* tolerate */ }

    let comments = [];
    try {
      const cr = await githubSearch(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=20`, config.github.token);
      if (cr.status >= 200 && cr.status < 300 && Array.isArray(cr.data)) {
        comments = cr.data.slice(-10).map(c => ({
          login: c.user?.login || '',
          createdAt: c.created_at || '',
          body: (c.body || '').slice(0, 400),
        }));
      }
    } catch (_) { /* tolerate */ }

    const pr = prRes.data || {};
    const totalAdds = files.reduce((s, f) => s + (f.additions || 0), 0);
    const totalDels = files.reduce((s, f) => s + (f.deletions || 0), 0);
    return {
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      url: pr.html_url || `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      title: pr.title || '',
      state: pr.state || '',
      draft: !!pr.draft,
      merged: !!pr.merged,
      mergedAt: pr.merged_at || null,
      mergeable: pr.mergeable,
      author: pr.user?.login || '',
      requestedReviewers: (pr.requested_reviewers || []).map(r => r.login),
      assignees: (pr.assignees || []).map(a => a.login),
      labels: (pr.labels || []).map(l => l.name),
      baseBranch: pr.base?.ref || '',
      headBranch: pr.head?.ref || '',
      createdAt: pr.created_at || '',
      updatedAt: pr.updated_at || '',
      additions: pr.additions ?? totalAdds,
      deletions: pr.deletions ?? totalDels,
      changedFiles: pr.changed_files ?? files.length,
      filesPreview: files.slice(0, 30),
      reviews,
      comments,
      body: (pr.body || '').slice(0, 2000),
    };
  } catch (err) {
    return failNetwork(err, 'github');
  }
}

// ------------------------------------------------------------------------------
// Error envelope helpers — every tool returns { error, source, hint, retryable }
// when something goes wrong, so the LLM can decide on a fallback plainly.
// ------------------------------------------------------------------------------

function failNetwork(err, source) {
  const code = err?.code || err?.cause?.code || '';
  const msg = err?.message || String(err);
  if (msg.toLowerCase().includes('certificate') || code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' || code === 'CERT_HAS_EXPIRED') {
    return {
      error: `TLS error reaching ${source}: ${msg}`,
      source,
      retryable: false,
      hint: `Likely a corporate proxy. Tell the user to set ALLOW_INSECURE_TLS=1 in .env and restart, then retry. You can still answer from retrieved <context source="docs"> if available.`,
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return {
      error: `Network error reaching ${source}: ${code || msg}`,
      source,
      retryable: true,
      hint: `Transient network issue. Tell the user we couldn't reach ${source} and offer fallbacks: a different tool that might cover the question, or historical numbers from retrieved <context source="docs">.`,
    };
  }
  return {
    error: msg || `Unknown error from ${source}`,
    source,
    retryable: false,
    hint: `${source} call failed unexpectedly. Tell the user, suggest a different tool or angle.`,
  };
}

function failHttp(status, body, source) {
  const detail = (() => {
    if (!body) return '';
    if (typeof body === 'string') return body.slice(0, 200);
    if (body.errorMessages) return body.errorMessages.join('; ');
    if (body.error?.message) return body.error.message;
    if (body.message) return body.message;
    try { return JSON.stringify(body).slice(0, 200); } catch (_) { return ''; }
  })();
  if (status === 401 || status === 403) {
    return {
      error: `${source} returned ${status} (auth)`,
      source,
      retryable: false,
      hint: `Credentials for ${source} are invalid, expired, or lack scope. Tell the user plainly that ${source} auth failed; suggest checking the relevant token in jira-md-export/.env (JIRA_TOKEN / GITHUB_TOKEN / TESTRAIL_API_KEY / etc.). Then offer to answer from retrieved <context source="docs"> or a different tool that might still work.`,
      detail,
    };
  }
  if (status === 429) {
    return {
      error: `${source} rate limit (429)`,
      source,
      retryable: true,
      hint: `${source} is rate-limiting us. Tell the user, suggest retry in a few minutes, and offer historical answers from retrieved context if applicable.`,
      detail,
    };
  }
  if (status === 400 || status === 422) {
    return {
      error: `${source} rejected the request (${status})`,
      source,
      retryable: true,
      hint: `The query/argument was malformed. Try a simpler call (e.g., for query_jira: drop unfamiliar fields, use just assignee + status). Don't loop forever — at most one retry.`,
      detail,
    };
  }
  if (status >= 500 && status < 600) {
    return {
      error: `${source} server error (${status})`,
      source,
      retryable: true,
      hint: `${source} backend is having issues. Tell the user, suggest retry later, and offer alternatives.`,
      detail,
    };
  }
  return {
    error: `${source} returned ${status}`,
    source,
    retryable: false,
    hint: `Unexpected status from ${source}. Tell the user the tool failed and try a different approach.`,
    detail,
  };
}

function failConfig(source, missing, alt) {
  return {
    error: `${source} not configured (missing: ${Array.isArray(missing) ? missing.join(', ') : missing})`,
    source,
    retryable: false,
    hint: `${source} is unavailable in this environment because the credentials aren't set in jira-md-export/.env. ${alt || `Tell the user the tool isn't configured and suggest: (1) answer from retrieved <context source="docs"> if it covers the question, or (2) try a different tool.`}`,
  };
}

// ------------------------------------------------------------------------------
// Helpers shared by query_copilot / query_cursor / query_confluence / query_testrail
// ------------------------------------------------------------------------------

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function importEsm(absPath) {
  // Windows-safe file:// URL conversion.
  return import(`file://${absPath.replace(/\\/g, '/')}`);
}

function resolveAccountIdFromName(name) {
  const users = readresourceDirectory();
  if (!users.length) return null;
  const ranked = users
    .map(u => ({ user: u, score: nameScore(name, u.displayName || '') }))
    .filter(r => r.score >= 0.45)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.user || null;
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

// ------------------------------------------------------------------------------
// Tool 4: query_copilot — reads output/copilotdata.json
// ------------------------------------------------------------------------------

async function queryCopilot({ login, top }) {
  const data = readJsonSafe(config.paths.copilotData);
  if (!data) {
    return failConfig('copilot', ['output/copilotdata.json'], 'Copilot data file is missing. Tell the user to run the jira-md-export pipeline. Fall back to retrieved <context source="docs"> if it covers Copilot adoption.');
  }
  if (data.error) {
    return {
      error: `Copilot data error: ${data.error}`,
      source: 'copilot',
      retryable: false,
      hint: 'The cached Copilot data was generated with an error (likely an expired token at fetch time). Tell the user the cached snapshot is bad and to re-run the export pipeline.',
    };
  }

  const lb = Array.isArray(data.userLeaderboard) ? data.userLeaderboard : [];
  if (login) {
    const cleanLogin = String(login).trim().replace(/^@/, '').toLowerCase();
    const row = lb.find(u => (u.user_login || '').toLowerCase() === cleanLogin);
    if (!row) {
      return {
        login: cleanLogin,
        found: false,
        note: `${cleanLogin} not in the Copilot top-${lb.length} leaderboard for the last ${data.period || '~28d'}. They may not be using Copilot, or fall below the leaderboard cutoff.`,
        period: data.period || null,
        lastSync: data.lastSync || null,
      };
    }
    return {
      login: row.user_login,
      found: true,
      period: data.period || null,
      lastSync: data.lastSync || null,
      stats: row,
    };
  }

  const cap = Math.max(1, Math.min(parseInt(top, 10) || 10, 25));
  return {
    period: data.period || null,
    lastSync: data.lastSync || null,
    enterpriseSummary: data.enterprise || null,
    topUsers: lb.slice(0, cap),
    leaderboardSize: lb.length,
  };
}

// ------------------------------------------------------------------------------
// Tool 5: query_cursor — reads output/cursordata.json
// ------------------------------------------------------------------------------

async function queryCursor({ email, top, sortBy }) {
  const data = readJsonSafe(config.paths.cursorData);
  if (!data) {
    return failConfig('cursor', ['output/cursordata.json'], 'Cursor data file is missing. Tell the user to run the jira-md-export pipeline. Fall back to retrieved <context source="docs"> if it covers Cursor adoption.');
  }
  if (data.error) {
    return {
      error: `Cursor data error: ${data.error}`,
      source: 'cursor',
      retryable: false,
      hint: 'The cached Cursor data was generated with an error. Tell the user the cached snapshot is bad and to re-run the export pipeline.',
    };
  }

  const lb = Array.isArray(data.top10Users) ? data.top10Users : [];
  if (email) {
    const wanted = String(email).trim().toLowerCase();
    const row = lb.find(u => (u.email || '').toLowerCase() === wanted);
    if (!row) {
      return {
        email: wanted,
        found: false,
        note: `${wanted} is not in the Cursor top-${lb.length} for the last ${data.period || '~30d'}. They may not be using Cursor or fall below the leaderboard cutoff.`,
        period: data.period || null,
        lastSync: data.lastSync || null,
      };
    }
    return { email: row.email, found: true, period: data.period || null, lastSync: data.lastSync || null, stats: row };
  }

  const cap = Math.max(1, Math.min(parseInt(top, 10) || 10, 25));
  const sort = sortBy && lb[0] && lb[0][sortBy] != null ? sortBy : 'lines_added';
  const sorted = [...lb].sort((a, b) => (Number(b[sort]) || 0) - (Number(a[sort]) || 0));
  return {
    period: data.period || null,
    lastSync: data.lastSync || null,
    sortedBy: sort,
    topUsers: sorted.slice(0, cap),
    summary: data.summary || null,
    modelShare: data.modelShare || null,
    languageShare: data.languageShare || null,
    workShare: data.workShare || null,
    aiEditsByRepository: Array.isArray(data.aiEditsByRepository) ? data.aiEditsByRepository.slice(0, 10) : [],
  };
}

// ------------------------------------------------------------------------------
// Tool 6: query_confluence — live per-user activity
// ------------------------------------------------------------------------------

async function queryConfluence({ name, days }) {
  if (!name || !String(name).trim()) {
    return { error: 'name is required', source: 'confluence', retryable: true, hint: 'Ask the user for the person\'s name.' };
  }
  const missing = [];
  if (!config.jira.email) missing.push('JIRA_EMAIL');
  if (!config.jira.token) missing.push('JIRA_TOKEN');
  if (!config.jira.domain) missing.push('JIRA_DOMAIN');
  if (missing.length) {
    return failConfig('confluence', missing, 'Confluence shares Atlassian credentials with JIRA — both unavailable. Tell the user, and offer to answer from retrieved <context source="docs"> if it covers documentation activity.');
  }
  const user = resolveAccountIdFromName(String(name).trim());
  if (!user || !user.accountId) {
    return {
      error: `Could not resolve "${name}" to an Atlassian accountId`,
      source: 'confluence',
      retryable: true,
      hint: 'Run lookup_person first with a fuller name, then retry. Or tell the user no match was found.',
    };
  }
  const lookbackDays = Math.max(1, Math.min(parseInt(days, 10) || 30, 90));
  const end = new Date();
  const start = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  try {
    const mod = await importEsm(config.paths.confluenceModule);
    const auth = mod.buildConfluenceAuth(config.jira.email, config.jira.token);
    const result = await mod.getConfluenceActivityForUser(config.jira.domain, auth, user.accountId, isoDate(start), isoDate(end));
    return {
      person: { displayName: user.displayName, email: user.email, accountId: user.accountId },
      windowDays: lookbackDays,
      since: isoDate(start),
      until: isoDate(end),
      activity: result,
    };
  } catch (err) {
    return failNetwork(err, 'confluence');
  }
}

// ------------------------------------------------------------------------------
// Tool 7: query_testrail — aggregate metrics for one or more TestRail projects
// ------------------------------------------------------------------------------

function loadProjectsConfig() {
  const cfg = readJsonSafe(config.paths.projectsConfig);
  return Array.isArray(cfg) ? cfg : (cfg && Array.isArray(cfg.projects) ? cfg.projects : []);
}

async function queryTestrail({ projectIds, projectName, days }) {
  const missing = [];
  if (!process.env.TESTRAIL_DOMAIN) missing.push('TESTRAIL_DOMAIN');
  if (!process.env.TESTRAIL_EMAIL) missing.push('TESTRAIL_EMAIL');
  if (!process.env.TESTRAIL_API_KEY) missing.push('TESTRAIL_API_KEY');
  if (missing.length) {
    return failConfig('testrail', missing, 'TestRail tool unavailable. Tell the user, and fall back to retrieved <context source="docs"> for QA/automation numbers from the most recent sprint snapshot.');
  }
  const lookbackDays = Math.max(1, Math.min(parseInt(days, 10) || 30, 120));
  const end = new Date();
  const start = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  let ids = Array.isArray(projectIds) ? projectIds.map(Number).filter(Number.isFinite) : [];

  if (!ids.length && projectName) {
    const projects = loadProjectsConfig();
    const wanted = String(projectName).toLowerCase();
    const match = projects.find(p => (p.name || p.projectName || '').toLowerCase().includes(wanted));
    const trIds = match?.testRailProjectIds;
    if (Array.isArray(trIds)) ids = trIds.map(Number).filter(Number.isFinite);
    else if (Number.isFinite(Number(trIds))) ids = [Number(trIds)];
  }

  if (!ids.length) {
    const projects = loadProjectsConfig();
    const knownTr = projects
      .filter(p => p.testRailProjectIds)
      .map(p => ({ project: p.name || p.projectName, testRailProjectIds: p.testRailProjectIds }));
    return {
      error: 'No project IDs supplied',
      source: 'testrail',
      retryable: true,
      hint: 'Either pass projectIds (array of numbers) or projectName matching a project from projects.json. Use the knownProjects list below to pick.',
      knownProjects: knownTr,
    };
  }

  try {
    const mod = await importEsm(config.paths.testrailModule);
    const result = await mod.getTestRailMetrics(ids, isoDate(start), isoDate(end));
    return {
      projectIds: ids,
      windowDays: lookbackDays,
      since: isoDate(start),
      until: isoDate(end),
      metrics: result,
    };
  } catch (err) {
    return failNetwork(err, 'testrail');
  }
}

// ------------------------------------------------------------------------------
// Tool 8: query_sprint — deterministic MD lookup, no embeddings
// ------------------------------------------------------------------------------

const SPRINT_BODY_CAP = 12000;

function listSprintsOnDisk() {
  const dir = config.paths.output;
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.toLowerCase().endsWith('.md')) continue;
    let content;
    try { content = fs.readFileSync(path.join(dir, file), 'utf8'); } catch (_) { continue; }
    const header = parseMdHeader(content);
    out.push({
      file,
      project: header.product || header.project || file.replace(/\s*\[ACTIVE\]\.md$/i, '').replace(/\.md$/, ''),
      sprint: header.sprint_name || header.sprint || '',
      manager: header.manager || '',
    });
  }
  return out;
}

async function querySprint({ project, sprint }) {
  const all = listSprintsOnDisk();
  if (!all.length) {
    return failConfig('query_sprint', ['output/*.md'], 'No sprint reports on disk. Tell the user to run the export pipeline first.');
  }
  const projectFilter = String(project || '').trim().toLowerCase();
  const sprintFilter = String(sprint || '').trim().toLowerCase();

  if (!projectFilter && !sprintFilter) {
    return {
      sprints: all.map(s => ({ project: s.project, sprint: s.sprint, file: s.file })),
      hint: 'Pass a project name (and optionally a sprint name) to fetch the full report.',
    };
  }

  const matches = all.filter((s) => {
    const projHit = projectFilter ? s.project.toLowerCase().includes(projectFilter) : true;
    const sprintHit = sprintFilter ? s.sprint.toLowerCase().includes(sprintFilter) : true;
    return projHit && sprintHit;
  });

  if (!matches.length) {
    return {
      error: `No sprint MD found for project="${project || ''}" sprint="${sprint || ''}"`,
      source: 'query_sprint',
      retryable: true,
      hint: 'Try with a partial project name. The list of available sprints is in the `available` field.',
      available: all.map(s => ({ project: s.project, sprint: s.sprint })),
    };
  }

  if (matches.length > 1 && !sprintFilter) {
    return {
      project,
      matched: matches.map(m => ({ project: m.project, sprint: m.sprint, file: m.file })),
      hint: 'Multiple sprints match — pass a `sprint` filter to fetch one.',
    };
  }

  const pick = matches[0];
  let content;
  try {
    content = fs.readFileSync(path.join(config.paths.output, pick.file), 'utf8');
  } catch (err) {
    return { error: `Could not read ${pick.file}`, source: 'query_sprint', retryable: false, hint: err.message || String(err) };
  }
  const truncated = content.length > SPRINT_BODY_CAP;
  return {
    project: pick.project,
    sprint: pick.sprint,
    manager: pick.manager,
    file: pick.file,
    truncated,
    content: truncated ? content.slice(0, SPRINT_BODY_CAP) + '\n\n[truncated…]' : content,
  };
}

// ------------------------------------------------------------------------------
// Tool 9: list_projects — deterministic project list from projects.json
// ------------------------------------------------------------------------------

async function listProjects() {
  const projects = loadProjectsConfig();
  if (!projects.length) {
    return failConfig('list_projects', ['jira-md-export/projects.json'], 'projects.json missing or empty.');
  }
  return {
    count: projects.length,
    projects: projects.map(p => ({
      name: p.name || p.projectName || '',
      key: p.jiraKey || p.key || '',
      managers: p.managers || p.manager || null,
      testRailProjectIds: p.testRailProjectIds ?? null,
    })),
  };
}

// ------------------------------------------------------------------------------
// Tool 10: list_people — deterministic resource directory dump
// ------------------------------------------------------------------------------

async function listPeople({ filter }) {
  const users = readresourceDirectory();
  if (!users.length) {
    return failConfig('list_people', ['output/resource-directory.json'], 'resource directory is empty/missing.');
  }
  const f = String(filter || '').trim().toLowerCase();
  const filtered = f
    ? users.filter(u => [u.displayName, u.email, u.role, u.team, u.manager]
        .some(v => String(v || '').toLowerCase().includes(f)))
    : users;
  const cap = Math.min(filtered.length, 100);
  return {
    count: filtered.length,
    returned: cap,
    people: filtered.slice(0, cap).map(u => ({
      displayName: u.displayName || '',
      email: u.email || '',
      role: u.role || '',
      team: u.team || '',
      manager: u.manager || '',
      githubLogin: u.githubLogin || null,
    })),
  };
}

// ------------------------------------------------------------------------------
// Tool registry — schemas + dispatch
// ------------------------------------------------------------------------------

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'lookup_person',
      description: 'Look up a person in the dashboard resource directory by name (fuzzy match supported). Returns their email, JIRA accountId, GitHub login, manager. Use this BEFORE query_jira (to get the email/accountId) and BEFORE query_github (to get the login). Names like "Avnish" or "Avnish Malik" both work.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The person\'s name (partial OK).' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_jira',
      description: 'Run a JQL query against JIRA. Returns up to 25 simplified issues. Use for live ticket status, assigned/open tickets, project membership ("which project is X on" ? assignee = "<email>" with no status filter shows recent activity). For a single specific ticket key, prefer query_jira_issue (richer payload). Common JQL fields: assignee, status, project, type, created, updated, resolved.',
      parameters: {
        type: 'object',
        properties: {
          jql: { type: 'string', description: 'JIRA JQL query string. Example: assignee = "user@VeloSync.com" AND statusCategory != Done ORDER BY updated DESC' },
          maxResults: { type: 'integer', description: 'Cap on issues returned (1-25). Defaults to 15.', minimum: 1, maximum: 25 },
        },
        required: ['jql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_jira_issue',
      description: 'Fetch ONE JIRA ticket by key with full detail: summary, description, status, type, priority, assignee, reporter, sprint, components, fix versions, parent, subtasks, links, recent comments. Use this whenever the user mentions a ticket like "HDE-1234" or pastes a JIRA URL — it is more efficient and richer than query_jira with `key=X`.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'JIRA issue key, e.g. "HDE-1234". Must match /^[A-Z][A-Z0-9]{1,9}-\\d+$/.' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_github',
      description: 'Fetch recent GitHub activity for a person by GitHub login (resolve name ? login via lookup_person first). Returns recent PRs and commits in the org. Set richMetrics=true for the full PR/commit/lines-changed breakdown (slower, ~2-3s). For a SPECIFIC PR by URL or number, prefer query_github_pr.',
      parameters: {
        type: 'object',
        properties: {
          login: { type: 'string', description: 'GitHub login (e.g. "matthew-greenwald-VeloSync"), without "@".' },
          days: { type: 'integer', description: 'Lookback window in days (default 30, max 90).', minimum: 1, maximum: 90 },
          richMetrics: { type: 'boolean', description: 'Set true for the rich metrics payload (uses the jira-md-export GitHub helper). Default false (faster).' },
        },
        required: ['login'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_github_pr',
      description: 'Fetch ONE GitHub pull request with full detail: title, state (open/closed/merged), author, reviewers, base/head branches, files changed (with +/-), reviews, recent comments, mergedAt. Use this whenever the user references a PR by URL ("https://github.com/x/y/pull/123") or shorthand ("repo#123"). Repo can be just the name (uses configured org) or "owner/repo".',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo identifier — full URL, "owner/repo", or just "repo" (org defaults to ORG env). If a URL is given, `number` is optional (parsed from URL).' },
          number: { type: 'integer', description: 'PR number. Required if `repo` is not a full URL.', minimum: 1 },
        },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_copilot',
      description: 'GitHub Copilot usage metrics from the cached output/copilotdata.json (refreshed daily). Use for "Copilot adoption", "lines accepted by X via Copilot", "top Copilot users". Pass a GitHub login to get one user; or pass top to get the leaderboard; or pass neither to get just the org-wide enterprise summary.',
      parameters: {
        type: 'object',
        properties: {
          login: { type: 'string', description: 'GitHub login of the user to look up (resolve via lookup_person). Omit for the leaderboard view.' },
          top: { type: 'integer', description: 'When login is omitted, return the top-N users (default 10, max 25).', minimum: 1, maximum: 25 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_cursor',
      description: 'Cursor IDE usage metrics from the cached output/cursordata.json (refreshed daily). Use for "Cursor adoption", "Cursor leaderboard", "model share", "lines added via Cursor", "AI edits per repository". Pass an email to get one user; otherwise returns the leaderboard plus org-wide model/language/work-share breakdowns.',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Email of the user to look up. Omit for the leaderboard.' },
          top: { type: 'integer', description: 'When email is omitted, return the top-N users (default 10, max 25).', minimum: 1, maximum: 25 },
          sortBy: { type: 'string', description: 'Field to sort the leaderboard by (e.g. "lines_added", "acceptance_rate", "agent_requests"). Defaults to "lines_added".' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_confluence',
      description: 'Live Confluence activity for one person over a date window. Returns pages contributed (created + edited) and the spaces they touched. Use for "what did X work on in Confluence", "did X create any docs recently".',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Person\'s name (the tool resolves it to an Atlassian accountId).' },
          days: { type: 'integer', description: 'Lookback window in days (default 30, max 90).', minimum: 1, maximum: 90 },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_testrail',
      description: 'Live TestRail metrics: total runs, cases created, plans, automation coverage, per-person QA breakdown. Pass either projectIds (array of TestRail project IDs) or projectName (matched against jira-md-export/projects.json). When called with no project, returns the list of known projects so the LLM can pick one.',
      parameters: {
        type: 'object',
        properties: {
          projectIds: { type: 'array', items: { type: 'integer' }, description: 'TestRail project IDs (numbers).' },
          projectName: { type: 'string', description: 'Substring of the project name from projects.json (e.g. "HDE", "ESA", "Siren"). The tool maps this to TestRail project IDs.' },
          days: { type: 'integer', description: 'Window in days (default 30, max 120).', minimum: 1, maximum: 120 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_sprint',
      description: 'Deterministic lookup of a sprint markdown report from output/*.md. Use this BEFORE retrieval/embeddings when the user explicitly asks for "the full HDE Sprint 47 report" or wants raw, verbatim content. Without `sprint`, returns the list of available sprints for that project.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project name (substring match on the MD header `Product`).' },
          sprint:  { type: 'string', description: 'Sprint name (substring match on `Sprint name`). Optional.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description: 'List all projects from jira-md-export/projects.json. Use to enumerate names/keys/managers without hitting JIRA.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_people',
      description: 'List people from the resource directory. Optional substring filter on name/email/role/team/manager. Use for "who is on team X", "list QA managers", etc. — without going through embeddings or live JIRA.',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Substring filter on displayName, email, role, team, or manager.' },
        },
      },
    },
  },
];

const DISPATCH = {
  lookup_person: lookupPerson,
  query_jira: queryJira,
  query_jira_issue: queryJiraIssue,
  query_github: queryGithub,
  query_github_pr: queryGithubPr,
  query_copilot: queryCopilot,
  query_cursor: queryCursor,
  query_confluence: queryConfluence,
  query_testrail: queryTestrail,
  query_sprint: querySprint,
  list_projects: listProjects,
  list_people: listPeople,
};

// ------------------------------------------------------------------------------
// TTL cache — wraps dispatchTool with per-tool TTLs from config.toolCache.
// Persists to chatbot/.cache/tool-cache.json so daily-refresh tools (Copilot,
// Cursor) don't re-run for the first hour after every server restart.
// Errors are NEVER cached so retries can still hit upstream.
// ------------------------------------------------------------------------------

let cacheLoaded = false;
let cacheStore = {};

function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = fs.readFileSync(config.toolCache.file, 'utf8');
    cacheStore = JSON.parse(raw) || {};
  } catch (_) {
    cacheStore = {};
  }
}

let savePending = false;
function persistCachVeloSyncon() {
  if (savePending) return;
  savePending = true;
  setTimeout(() => {
    savePending = false;
    try {
      const dir = path.dirname(config.toolCache.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${config.toolCache.file}.tmp-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(cacheStore), 'utf8');
      fs.renameSync(tmp, config.toolCache.file);
    } catch (err) {
      console.warn('[chatbot tool-cache] persist failed:', err.message || err);
    }
  }, 250);
}

function cacheKey(name, args) {
  let serialized;
  try { serialized = JSON.stringify(args || {}); } catch (_) { serialized = ''; }
  return `${name}::${serialized}`;
}

function readCache(name, args) {
  if (!config.toolCache.enabled) return null;
  loadCache();
  const ttl = config.toolCache.ttlMs[name];
  if (!ttl) return null;
  const entry = cacheStore[cacheKey(name, args)];
  if (!entry) return null;
  if ((Date.now() - entry.at) > ttl) return null;
  return entry.value;
}

function writeCache(name, args, value) {
  if (!config.toolCache.enabled) return;
  if (!config.toolCache.ttlMs[name]) return;
  if (value && value.error) return;
  loadCache();
  cacheStore[cacheKey(name, args)] = { at: Date.now(), value };
  persistCachVeloSyncon();
}

/**
 * Dispatch a tool call by name with parsed args. Always resolves to a JSON-
 * serializable object — errors come back as `{ error: "..." }` so the LLM
 * can recover rather than the loop crashing.
 */
async function dispatchTool(name, args) {
  const fn = DISPATCH[name];
  if (!fn) {
    return {
      error: `Unknown tool: ${name}`,
      source: 'dispatcher',
      retryable: false,
      hint: 'You called a tool that does not exist. Pick from the registered tools list and retry.',
    };
  }
  const cached = readCache(name, args);
  if (cached) {
    return { ...cached, _cached: true };
  }
  try {
    const result = await fn(args || {});
    writeCache(name, args, result);
    return result;
  } catch (err) {
    return {
      error: err.message || String(err),
      source: name,
      retryable: false,
      hint: `${name} threw an unexpected exception. Tell the user the tool crashed and try a different approach.`,
    };
  }
}

function getToolCacheStats() {
  loadCache();
  const now = Date.now();
  const entries = Object.entries(cacheStore);
  const perTool = {};
  let live = 0;
  let expired = 0;
  for (const [k, entry] of entries) {
    const tool = k.split('::', 1)[0];
    if (!perTool[tool]) perTool[tool] = 0;
    perTool[tool] += 1;
    const ttl = config.toolCache.ttlMs[tool] || 0;
    if (ttl && (now - entry.at) > ttl) expired += 1;
    else live += 1;
  }
  let fileSize = 0;
  try { fileSize = fs.statSync(config.toolCache.file).size; } catch (_) { /* not yet on disk */ }
  return {
    enabled: !!config.toolCache.enabled,
    totalEntries: entries.length,
    live,
    expired,
    perTool,
    fileBytes: fileSize,
  };
}

module.exports = {
  TOOL_SCHEMAS,
  dispatchTool,
  getToolCacheStats,
};
