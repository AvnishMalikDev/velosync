/**
 * GitHub repo-metrics connector.
 *
 * Per-user, per-sprint metrics (PRs, commits, repos touched, lines added /
 * deleted) used to populate section 2.3 of every sprint markdown file.
 *
 * Login resolution priority (highest ? lowest):
 *   1. `github-users.json` per-name override (manual, deterministic).
 *   2. `output/resource-directory.json` row's `githubLogin` (auto-backfilled).
 *   3. Fuzzy match against the live GitHub org member list.
 *   4. Derived `firstname-lastname-VeloSync` fallback — gated on the login actually
 *      existing in the org so we never query a wrong-real-user or a bot.
 *
 * Requires `GITHUB_TOKEN` (PAT with repo + search + read:org) and `ORG`.
 */

import fs from "fs";
import path from "path";

const GITHUB_API = "https://api.github.com";

/**
 * Logins that must never be queried as if they were a human developer.
 * Prevents the "mystery bot account" collision class of bugs, where a weak
 * derived-login fallback accidentally lands on a service / release account
 * and attributes hundreds of automated commits to unrelated people.
 *
 * Matched case-insensitively; a login is treated as a bot if it equals an
 * entry in this set OR matches one of the suffix / substring patterns below.
 */
const BOT_LOGIN_EXACT = new Set([
  "github-actions[bot]",
  "dependabot[bot]",
  "renovate[bot]",
  "github-actions",
  "dependabot",
  "renovate",
  "VeloSync-bot",
  "VeloSync-ci",
  "VeloSync-release-bot",
]);

const BOT_LOGIN_PATTERNS = [
  /\[bot\]$/i,
  /-bot$/i,
  /-bots$/i,
  /^bot-/i,
  /-ci$/i,
  /-sa$/i,
  /^service[-_]/i,
  /^svc[-_]/i,
  /^renovate[-_]?/i,
  /^dependabot[-_]?/i,
];

/** True when `login` is (or merely looks like) an automated account. */
export function isBotLogin(login) {
  if (!login) return false;
  const l = String(login).toLowerCase().trim();
  if (!l) return false;
  if (BOT_LOGIN_EXACT.has(l)) return true;
  for (const pat of BOT_LOGIN_PATTERNS) {
    if (pat.test(l)) return true;
  }
  return false;
}

// Upper bound for commit detail fetches per user per sprint. GitHub Search
// caps total results at 1000 commits; we respect that hard ceiling.
const MAX_COMMIT_SEARCH_PAGES = 10;      // 10 × 100 = 1000 (GitHub limit)
const COMMITS_PER_PAGE = 100;
const COMMIT_DETAIL_CONCURRENCY = 3;     // /repos/:o/:r/commits/:sha workers
const COMMIT_DETAIL_SLEEP_MS = 80;       // pacing between starts in each worker
const SEARCH_SLEEP_MS = 700;             // Search API: 30 req/min authenticated

/**
 * Per-user, per-sprint GitHub activity.
 *
 * @param {string} githubLogin   GitHub username
 * @param {string} org           GitHub org (e.g. `VeloSync-development`)
 * @param {string} startDate     `YYYY-MM-DD`
 * @param {string} endDate       `YYYY-MM-DD`
 * @param {string} token         GitHub PAT
 * @returns {Promise<{repos:string[], prCount:number, commitsCount:number, additions:number, deletions:number, note:string}>}
 */
export async function getGitHubMetricsForUser(githubLogin, org, startDate, endDate, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const result = {
    repos: [],
    prCount: 0,
    commitsCount: 0,
    additions: 0,
    deletions: 0,
    note: "",
  };

  if (!githubLogin || !org || !startDate || !endDate || !token) {
    result.note = "Missing config";
    return result;
  }

  // Hard stop: never attribute metrics to a bot/service account — its
  // activity is not representative of any individual developer and was
  // previously the source of cross-user "identical number" collisions in
  // section 2.3.
  if (isBotLogin(githubLogin)) {
    result.note = "Skipped: bot/service account";
    return result;
  }

  const dateRange = `${startDate}..${endDate}`;

  try {
    // 1) Search commits: org + author + committer-date range — paginated up
    //    to 1000 items (GitHub Search hard ceiling). `total_count` is
    //    authoritative even when items paginate.
    const repoSet = new Set();
    const commitsToFetch = []; // { owner, repo, sha }
    let totalCommits = 0;
    let truncated = false;

    for (let page = 1; page <= MAX_COMMIT_SEARCH_PAGES; page++) {
      const commitSearchUrl =
        `${GITHUB_API}/search/commits` +
        `?q=org:${encodeURIComponent(org)}` +
        `+author:${encodeURIComponent(githubLogin)}` +
        `+committer-date:${encodeURIComponent(dateRange)}` +
        `&per_page=${COMMITS_PER_PAGE}&page=${page}`;

      if (page > 1) await sleep(SEARCH_SLEEP_MS);
      const commitRes = await fetch(commitSearchUrl, { headers });
      if (!commitRes.ok) {
        if (commitRes.status === 422) {
          result.note = "Search not available";
          return result;
        }
        // On rate-limit / transient error after page 1 we keep what we have
        // rather than nuke the result.
        if (page === 1) {
          result.note = `API ${commitRes.status}`;
          return result;
        }
        truncated = true;
        break;
      }
      const commitData = await commitRes.json();
      if (page === 1) totalCommits = commitData.total_count ?? 0;
      const items = commitData.items ?? [];
      for (const it of items) {
        const repo = it.repository?.full_name;
        if (repo) repoSet.add(repo);
        if (it.sha && repo) {
          const [owner, repoName] = repo.split("/");
          if (owner && repoName) commitsToFetch.push({ owner, repo: repoName, sha: it.sha });
        }
      }
      if (items.length < COMMITS_PER_PAGE) break; // last page
      if (page === MAX_COMMIT_SEARCH_PAGES && totalCommits > commitsToFetch.length) truncated = true;
    }

    result.commitsCount = totalCommits;

    // 2) Additions/deletions from EVERY collected commit (bounded
    //    concurrency so we stay under GitHub's 5000 req/hr core rate limit
    //    even for the most active developers). Previously this path capped
    //    at 15 commits which systematically under-counted churn for anyone
    //    producing >15 commits per sprint.
    const additionsDeletions = await fetchCommitStatsBatch(commitsToFetch, headers);
    result.additions = additionsDeletions.additions;
    result.deletions = additionsDeletions.deletions;

    // 3) Search PRs: org + author + created-date range
    await sleep(SEARCH_SLEEP_MS);
    const prSearchUrl = `${GITHUB_API}/search/issues?q=org:${encodeURIComponent(org)}+author:${encodeURIComponent(githubLogin)}+created:${encodeURIComponent(dateRange)}+is:pr&per_page=100`;
    const prRes = await fetch(prSearchUrl, { headers });
    if (prRes.ok) {
      const prData = await prRes.json();
      result.prCount = prData.total_count ?? 0;
      // Merge PR repos into the set so people with PRs but no matching commits
      // still list repos.
      const apiReposBase = `${GITHUB_API}/repos/`;
      for (const pr of (prData.items ?? [])) {
        const repoUrl = pr.repository_url || "";
        if (repoUrl.startsWith(apiReposBase)) {
          repoSet.add(repoUrl.slice(apiReposBase.length));
        }
      }
    } else {
      result.note = `PR search failed (HTTP ${prRes.status})`;
    }

    result.repos = [...repoSet].sort();

    if (result.commitsCount === 0 && result.prCount === 0) result.note = "No activity in window";
    else if (truncated) result.note = "Search truncated at 1000 commits (GitHub limit)";
    else result.note = "";

    return result;
  } catch (err) {
    result.note = err.message || "Error";
    return result;
  }
}

/**
 * Pull stats for an arbitrary list of commits with bounded concurrency.
 * Returns summed additions/deletions; silently skips commits that fail.
 */
async function fetchCommitStatsBatch(commitsToFetch, headers) {
  const summary = { additions: 0, deletions: 0 };
  if (!commitsToFetch || commitsToFetch.length === 0) return summary;

  let cursor = 0;
  const workers = new Array(Math.min(COMMIT_DETAIL_CONCURRENCY, commitsToFetch.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= commitsToFetch.length) break;
        const { owner, repo, sha } = commitsToFetch[idx];
        await sleep(COMMIT_DETAIL_SLEEP_MS);
        try {
          const detailUrl = `${GITHUB_API}/repos/${owner}/${repo}/commits/${sha}`;
          const detailRes = await fetch(detailUrl, { headers });
          if (!detailRes.ok) continue;
          const detail = await detailRes.json();
          const stats = detail.stats;
          if (stats) {
            summary.additions += stats.additions ?? 0;
            summary.deletions += stats.deletions ?? 0;
          }
        } catch {
          // best-effort; don't let one bad SHA poison the whole batch
        }
      }
    });
  await Promise.all(workers);
  return summary;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Load JIRA display name ? GitHub login map from `github-users.json`.
 *
 * Format: `{ "Display Name": "github-login", "Another Person": "another" }`.
 * Keys starting with `_` are treated as comments and skipped (so the file can
 * carry inline docs e.g. `"_comment": "..."`). Empty-string values are also
 * skipped so a placeholder entry doesn't resolve to `""`.
 *
 * @param {string} dir - Directory containing `github-users.json`
 * @returns {Record<string, string>}
 */
export function loadGitHubUserMapping(dir) {
  try {
    const p = path.join(dir, "github-users.json");
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return {};
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof k !== "string" || k.startsWith("_")) continue;
      if (typeof v !== "string" || !v.trim()) continue;
      out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Load JIRA displayName ? GitHub login from `output/resource-directory.json`.
 * Only users with a non-empty `githubLogin` string are included; keys are the
 * exact JIRA `displayName` as stored in the directory.
 *
 * @param {string} repoRoot - Parent of `output/`
 * @returns {Record<string, string>}
 */
export function loadGithubLoginsFromresourceDirectory(repoRoot) {
  try {
    const p = path.join(repoRoot, "output", "resource-directory.json");
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw);
    const users = data && Array.isArray(data.users) ? data.users : [];
    const out = {};
    for (const u of users) {
      const dn = typeof u.displayName === "string" ? u.displayName.trim() : "";
      const gh = typeof u.githubLogin === "string" ? u.githubLogin.trim() : "";
      if (!dn || !gh) continue;
      out[dn] = gh;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * resolve a login from a resource-directory display-name map. Tries exact
 * match first, then a contractor-suffix-stripped + whitespace-collapsed
 * comparison so `Foo Bar (c)` and `foobar` collapse to the same key.
 */
export function resolveLoginFromresourceDirectory(displayName, byDisplayName) {
  if (!displayName || !byDisplayName || typeof byDisplayName !== "object") return null;
  const trimmed = String(displayName).trim();
  if (!trimmed) return null;
  if (byDisplayName[trimmed]) return byDisplayName[trimmed];
  for (const [k, v] of Object.entries(byDisplayName)) {
    const kNorm = String(k)
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replace(/\s+/g, "");
    const tNorm = trimmed
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replace(/\s+/g, "");
    if (kNorm === tNorm) return v;
  }
  return null;
}

/**
 * Pull every GitHub org member login (paginated). Returns an empty array on
 * error or when the token lacks `read:org` — callers degrade gracefully.
 */
export async function getOrgMemberLogins(org, token) {
  if (!org || !token) return [];
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const logins = [];
  let page = 1;
  try {
    while (true) {
      await sleep(150);
      const res = await fetch(`${GITHUB_API}/orgs/${org}/members?per_page=100&page=${page}`, { headers });
      if (!res.ok) break; // 403 = no read:org scope; gracefully return what we have
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) break;
      logins.push(...data.map((m) => m.login));
      if (data.length < 100) break;
      page++;
    }
  } catch {}
  return logins;
}

/**
 * Fuzzy-match a JIRA display name to the best-fitting GitHub org member.
 *
 * Algorithm:
 *   1. Normalise the display name: strip contractor markers like `(c)`, split
 *      on whitespace / dots, lowercase, alphanumeric only.
 *   2. For each org login: split on `-` and `_`, drop the common `VeloSync`
 *      suffix.
 *   3. The candidate's first login token MUST equal the person's first name
 *      token (hard gate — avoids cross-person first-name collisions).
 *   4. Every additional name token that appears in the login tokens adds to
 *      the score (longer tokens worth more).
 *   5. Return the highest-scoring login meeting the threshold, or null so
 *      the caller can fall back to the derived login.
 */
export function fuzzyMatchLogin(displayName, orgLogins) {
  if (!displayName || !orgLogins || orgLogins.length === 0) return null;

  const cleaned = String(displayName).replace(/\s*\([^)]*\)\s*$/, "").trim();
  const nameTokens = cleaned
    .toLowerCase()
    .split(/[\s.]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 1);

  if (nameTokens.length === 0) return null;
  const firstName = nameTokens[0];

  let bestLogin = null;
  let bestScore = -1;

  for (const login of orgLogins) {
    if (isBotLogin(login)) continue;
    const loginTokens = login
      .toLowerCase()
      .split(/[-_]/)
      .filter((t) => t && t !== "VeloSync" && t.length > 1);

    if (loginTokens.length === 0) continue;
    if (loginTokens[0] !== firstName) continue;

    let score = 3;
    for (let i = 1; i < nameTokens.length; i++) {
      if (loginTokens.includes(nameTokens[i])) {
        score += nameTokens[i].length > 3 ? 2 : 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestLogin = login;
    }
  }

  // For multi-part names require first name + at least one other token
  // (score >= 4). For a single-token name (rare) first-name match alone is
  // enough (score >= 3).
  const threshold = nameTokens.length >= 2 ? 4 : 3;
  return bestScore >= threshold ? bestLogin : null;
}

function firstNameTokenForGithub(full) {
  return String(full || "").trim().split(/\s+/)[0] || full;
}

/**
 * resolve a JIRA display name to a GitHub org login (same rules used to
 * populate sprint section 2.3).
 *
 * Order: `github-users.json` map ? optional resource-directory map ? fuzzy
 * org match ? derived `firstname-lastname-VeloSync` when that login exists in the
 * org (and isn't a bot).
 */
export function resolveJiraDisplayNameToGithubLogin(displayName, options = {}) {
  const {
    githubUserMap = {},
    rdGithubByDisplay = null,
    orgMemberLogins = [],
    orgMemberLoginsLower = null,
    unresolvedSet = null,
  } = options;

  const orgLower =
    orgMemberLoginsLower instanceof Set
      ? orgMemberLoginsLower
      : new Set((orgMemberLogins || []).map((l) => String(l).toLowerCase()));

  if (!displayName) return null;
  const trimmed = String(displayName).trim();
  if (!trimmed) return null;

  const sanitizeresolved = (login) => {
    if (!login) return null;
    if (isBotLogin(login)) return null;
    return login;
  };

  if (githubUserMap[trimmed]) return sanitizeresolved(githubUserMap[trimmed]);
  const first = firstNameTokenForGithub(trimmed);
  if (githubUserMap[first]) return sanitizeresolved(githubUserMap[first]);
  for (const [k, v] of Object.entries(githubUserMap)) {
    const kNorm = String(k)
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replace(/\s+/g, "");
    const tNorm = trimmed
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replace(/\s+/g, "");
    if (kNorm === tNorm) return sanitizeresolved(v);
  }

  if (rdGithubByDisplay && typeof rdGithubByDisplay === "object") {
    const rd = resolveLoginFromresourceDirectory(trimmed, rdGithubByDisplay);
    if (rd) return sanitizeresolved(rd);
  }

  const fuzzy = fuzzyMatchLogin(trimmed, orgMemberLogins);
  if (fuzzy) return sanitizeresolved(fuzzy);

  const cleaned = trimmed.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const parts = cleaned
    .split(/\s+/)
    .map((p) => p.replace(/[^a-zA-Z0-9.-]/g, ""))
    .filter(Boolean);
  const firstname = (parts[0] || "").toLowerCase();
  const lastname = (parts.slice(1).join("-") || "").toLowerCase();
  const candidates = [];
  if (lastname) {
    candidates.push(`${firstname}-${lastname}-VeloSync`);
    candidates.push(`${firstname}-${lastname}_VeloSync`);
    candidates.push(`${firstname}-${lastname}`);
  } else if (firstname) {
    candidates.push(`${firstname}-VeloSync`);
    candidates.push(`${firstname}_VeloSync`);
    candidates.push(firstname);
  }
  for (const cand of candidates) {
    if (orgLower.has(cand.toLowerCase()) && !isBotLogin(cand)) return cand;
  }
  if (unresolvedSet && typeof unresolvedSet.add === "function") unresolvedSet.add(trimmed);
  return null;
}

/**
 * For each user in `output/resource-directory.json` with no `githubLogin`,
 * infer one (github-users.json + fuzzy + derived) and write the file when at
 * least one row changes.
 *
 * Crucially, this path does NOT read existing `githubLogin` values — the
 * directory is the destination, not a fallback source — so a manual edit is
 * never silently overwritten.
 */
export function backfillGithubLoginsInresourceDirectory(repoRoot, options = {}) {
  const { githubUserMap = {}, orgMemberLogins = [], orgMemberLoginsLower = null } = options;
  if (!repoRoot || !orgMemberLogins.length) {
    return { updated: 0, totalUsers: 0, reason: "no org members" };
  }

  const rdPath = path.join(repoRoot, "output", "resource-directory.json");
  if (!fs.existsSync(rdPath)) {
    return { updated: 0, totalUsers: 0, reason: "no resource-directory.json" };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(rdPath, "utf8"));
  } catch {
    return { updated: 0, totalUsers: 0, reason: "parse error" };
  }
  const users = data && Array.isArray(data.users) ? data.users : [];
  const orgLower =
    orgMemberLoginsLower instanceof Set
      ? orgMemberLoginsLower
      : new Set(orgMemberLogins.map((l) => String(l).toLowerCase()));

  let updated = 0;
  for (const u of users) {
    const dn = typeof u.displayName === "string" ? u.displayName.trim() : "";
    if (!dn) continue;
    const existing = typeof u.githubLogin === "string" ? u.githubLogin.trim() : "";
    if (existing) continue;

    const login = resolveJiraDisplayNameToGithubLogin(dn, {
      githubUserMap,
      rdGithubByDisplay: null,
      orgMemberLogins,
      orgMemberLoginsLower: orgLower,
      unresolvedSet: null,
    });
    if (login) {
      u.githubLogin = login;
      updated++;
    }
  }

  if (updated > 0) {
    try {
      fs.writeFileSync(rdPath, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
      return { updated, totalUsers: users.length, reason: e.message || "write failed", writeFailed: true };
    }
  }

  return { updated, totalUsers: users.length };
}
