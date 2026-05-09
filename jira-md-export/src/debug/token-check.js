/**
 * Cross-system token + identity diagnostic.
 *
 * Validates JIRA, Confluence, Cursor, and GitHub credentials, then traces a
 * single user (passed via `--user`) through every resolution layer:
 *
 *   - `output/resource-directory.json` cache,
 *   - JIRA user search,
 *   - Cursor daily-usage rows,
 *   - GitHub login resolution (manual map ? resource-directory ? fuzzy ? derived)
 *     plus PR / commit attribution sanity check.
 *
 * Use when a person's metrics look wrong in the dashboard and you need to
 * see which integration is mis-mapping them.
 *
 * Usage:
 *   node src/debug/token-check.js --user "First Last" [--days 90] [--github-login override]
 */

import "../core/env.js";
import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import {
  fuzzyMatchLogin,
  getOrgMemberLogins,
  loadGitHubUserMapping,
  loadGithubLoginsFromresourceDirectory,
  resolveLoginFromresourceDirectory,
  isBotLogin,
} from "../connectors/github/metrics.js";
import { ROOT_DIR, OUTPUT_DIR, resource_DIRECTORY_JSON, GITHUB_USERS_JSON } from "../core/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const BASE_CURSOR_URL = "https://api.cursor.com";
const BASE_GITHUB_URL = "https://api.github.com";

function parseArgs(argv) {
  const out = { user: "", days: 180, githubLogin: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user" && argv[i + 1]) { out.user = argv[++i]; continue; }
    if (arg.startsWith("--user=")) { out.user = arg.slice("--user=".length); continue; }
    if (arg === "--days" && argv[i + 1]) { out.days = Number(argv[++i]) || out.days; continue; }
    if (arg.startsWith("--days=")) { out.days = Number(arg.slice("--days=".length)) || out.days; continue; }
    if (arg === "--github-login" && argv[i + 1]) { out.githubLogin = argv[++i]; continue; }
    if (arg.startsWith("--github-login=")) { out.githubLogin = arg.slice("--github-login=".length); continue; }
    if (!arg.startsWith("--") && !out.user) out.user = arg;
  }
  return out;
}

function maskSecret(value) {
  if (!value) return "(missing)";
  if (value.length <= 10) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function tokeniseName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .split(/[\s._@-]+/)
    .map((part) => part.replace(/[^a-z0-9]/g, ""))
    .filter((part) => part.length >= 2);
}

function matchesTargetUser(targetUser, candidate) {
  const targetTokens = tokeniseName(targetUser);
  if (targetTokens.length === 0) return false;
  const haystack = String(candidate || "").toLowerCase().replace(/[^a-z0-9@._ -]/g, "");
  return targetTokens.every((token) => haystack.includes(token));
}

function deriveGitHubLogin(displayName) {
  const cleaned = String(displayName || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const parts = cleaned.split(/\s+/).map((p) => p.replace(/[^a-zA-Z0-9.-]/g, "")).filter(Boolean);
  const first = (parts[0] || "").toLowerCase();
  const last = parts.slice(1).join("-").toLowerCase();
  if (!first) return "";
  return last ? `${first}-${last}_VeloSync` : `${first}_VeloSync`;
}

const JIRA_PUNE_IDC_DISPLAY_RE = /\s*\(IDC\)\s*$/i;

function inspectresourceDirectory(targetUser) {
  section("resource directory (cache)");
  console.log(`Path: ${resource_DIRECTORY_JSON}`);
  if (!fs.existsSync(resource_DIRECTORY_JSON)) {
    console.log("Status: file not found — populate it from the dashboard first.");
    return { ok: false, matches: [] };
  }
  let dir;
  try {
    dir = JSON.parse(fs.readFileSync(resource_DIRECTORY_JSON, "utf8"));
  } catch (error) {
    console.log(`Status: read failed — ${error.message}`);
    return { ok: false, matches: [] };
  }
  const users = Array.isArray(dir.users) ? dir.users : [];
  console.log(`Entries: ${users.length} | lastRefresh: ${dir.lastRefresh || "(none)"}`);
  if (!targetUser) {
    console.log("Status: no --user; skipping name match within cache.");
    return { ok: true, matches: [] };
  }
  const matches = [];
  for (const u of users) {
    const dn = String(u.displayName || "").trim();
    const em = String(u.email || u.emailAddress || "").trim();
    if (matchesTargetUser(targetUser, dn) || (em && matchesTargetUser(targetUser, em))) {
      matches.push({
        displayName: dn,
        email: em,
        accountId: u.accountId || "",
        pune: JIRA_PUNE_IDC_DISPLAY_RE.test(dn),
      });
    }
  }
  if (matches.length === 0) {
    console.log(`No entries matched "${targetUser}"`);
    return { ok: true, matches: [] };
  }
  matches.slice(0, 5).forEach((m, i) => {
    console.log(`Match ${i + 1}: ${m.displayName || "(no name)"} | Pune(IDC)=${m.pune} | email=${m.email || "(none)"} | accountId=${m.accountId || "(none)"}`);
  });
  return { ok: true, matches };
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function jiraHeaders(email, token) {
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  return { Authorization: `Basic ${auth}`, Accept: "application/json" };
}

function cursorBasicHeaders(token) {
  const encoded = Buffer.from(`${token}:`).toString("base64");
  return { Authorization: `Basic ${encoded}`, Accept: "application/json", "Content-Type": "application/json" };
}

function cursorBearerHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { response, text, json };
}

async function httpsJson(urlStr, method, headers, body) {
  const url = new URL(urlStr);
  const bodyText = body ? JSON.stringify(body) : null;
  const bodyBuffer = bodyText ? Buffer.from(bodyText, "utf8") : null;
  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method,
    headers: bodyBuffer ? { ...headers, "Content-Length": bodyBuffer.length } : headers,
    agent: httpsAgent,
  };

  const result = await new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });

  let json = null;
  try { json = result.text ? JSON.parse(result.text) : null; } catch { json = null; }
  return { ...result, json };
}

function getDateRange(days) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function getCursorDailyUsageWindow() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  start.setUTCHours(0, 0, 0, 0);
  return { startDate: start.getTime(), endDate: end.getTime() };
}

async function validateJira(targetUser) {
  section("Jira");
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN;
  const domain = process.env.JIRA_DOMAIN;

  console.log(`Domain: ${domain || "(missing)"}`);
  console.log(`Email: ${email || "(missing)"}`);
  console.log(`Token: ${maskSecret(token)}`);

  if (!email || !token || !domain) {
    console.log("Status: skipped, missing JIRA_EMAIL / JIRA_TOKEN / JIRA_DOMAIN");
    return { ok: false, matches: [] };
  }

  const headers = jiraHeaders(email, token);
  const myself = await fetchJson(`https://${domain}/rest/api/3/myself`, { headers });
  console.log(`Auth check: ${myself.response.status} ${myself.response.statusText}`);
  if (myself.response.ok) {
    console.log(`Authenticated as: ${myself.json?.displayName || "(unknown)"} <${myself.json?.emailAddress || email}>`);
  } else {
    console.log(`Body: ${myself.text.slice(0, 300)}`);
  }

  if (targetUser && myself.response.ok) {
    const queryUrl = `https://${domain}/rest/api/3/user/search?query=${encodeURIComponent(targetUser)}&maxResults=10`;
    const users = await fetchJson(queryUrl, { headers });
    console.log(`User lookup "${targetUser}": ${users.response.status} ${users.response.statusText}`);
    if (users.response.ok && Array.isArray(users.json)) {
      if (users.json.length === 0) {
        console.log("Matches: none");
      } else {
        users.json.slice(0, 5).forEach((u, i) => {
          const emailText = u.emailAddress || "(email hidden)";
          console.log(`Match ${i + 1}: ${u.displayName || "(no name)"} | active=${u.active} | email=${emailText} | accountId=${u.accountId}`);
        });
      }
      return { ok: myself.response.ok, matches: users.json };
    } else if (!users.response.ok) {
      console.log(`Body: ${users.text.slice(0, 300)}`);
    }
  }

  return { ok: myself.response.ok, matches: [] };
}

async function validateCursor(targetUser) {
  section("Cursor");
  const token = process.env.CURSOR_TOKEN;
  console.log(`Token: ${maskSecret(token)}`);

  if (!token) {
    console.log("Status: skipped, missing CURSOR_TOKEN");
    return { ok: false };
  }

  let leaderboardResult = null;
  let leaderboardAuth = "";
  for (const candidate of [
    { type: "Bearer", headers: cursorBearerHeaders(token) },
    { type: "Basic", headers: cursorBasicHeaders(token) },
  ]) {
    const result = await httpsJson(
      `${BASE_CURSOR_URL}/analytics/team/leaderboard?startDate=30d&endDate=now`,
      "GET",
      candidate.headers,
    );
    if (result.statusCode === 200) { leaderboardResult = result; leaderboardAuth = candidate.type; break; }
    if (result.statusCode !== 401) { leaderboardResult = result; leaderboardAuth = candidate.type; break; }
  }

  console.log(`Leaderboard check: ${leaderboardResult?.statusCode || 0} via ${leaderboardAuth || "(none)"}`);
  if (leaderboardResult?.statusCode !== 200) {
    console.log(`Body: ${(leaderboardResult?.text || "").slice(0, 300)}`);
  }

  const { startDate, endDate } = getCursorDailyUsageWindow();
  const dailyUsage = await httpsJson(
    `${BASE_CURSOR_URL}/teams/daily-usage-data`,
    "POST",
    cursorBasicHeaders(token),
    { startDate, endDate, page: 1, pageSize: 1000 },
  );
  console.log(`Daily usage check: ${dailyUsage.statusCode}`);
  if (dailyUsage.statusCode === 200) {
    const rows = Array.isArray(dailyUsage.json?.data) ? dailyUsage.json.data : [];
    console.log(`Rows returned: ${rows.length}`);
    if (targetUser) {
      const matches = rows.filter((row) => matchesTargetUser(targetUser, row.email || ""));
      if (matches.length === 0) {
        console.log(`Target user match in daily usage: none for "${targetUser}"`);
      } else {
        console.log(`Target user match in daily usage: ${matches.length} row(s)`);
        const summary = new Map();
        for (const row of matches) {
          const key = row.email || `user_${row.userId}`;
          if (!summary.has(key)) summary.set(key, { lines: 0, composer: 0, chat: 0, agent: 0 });
          const record = summary.get(key);
          record.lines += Number(row.totalLinesAdded || 0);
          record.composer += Number(row.composerRequests || 0);
          record.chat += Number(row.chatRequests || 0);
          record.agent += Number(row.agentRequests || 0);
        }
        for (const [email, record] of [...summary.entries()].slice(0, 5)) {
          console.log(`Cursor user: ${email} | linesAdded=${record.lines} | composer=${record.composer} | chat=${record.chat} | agent=${record.agent}`);
        }
      }
    }
  } else {
    console.log(`Body: ${dailyUsage.text.slice(0, 300)}`);
  }

  const aiCommits = await httpsJson(
    `${BASE_CURSOR_URL}/analytics/ai-code/commits?startDate=30d&endDate=now`,
    "GET",
    cursorBearerHeaders(token),
  );
  console.log(`AI commits endpoint: ${aiCommits.statusCode}`);
  if (aiCommits.statusCode !== 200) console.log(`Body: ${aiCommits.text.slice(0, 300)}`);

  return { ok: leaderboardResult?.statusCode === 200 || dailyUsage.statusCode === 200 };
}

async function resolveGitHubLogin(targetUser, overrideLogin) {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_METRICS_TOKEN;
  const org = process.env.ORG || "";
  const githubUserMap = loadGitHubUserMapping(ROOT_DIR);
  const rdGithubByDisplay = loadGithubLoginsFromresourceDirectory(path.join(ROOT_DIR, ".."));

  if (overrideLogin) return { login: overrideLogin, source: "cli override", orgMembers: [] };
  if (!targetUser) return { login: "", source: "no target user", orgMembers: [] };
  if (githubUserMap[targetUser]) return { login: githubUserMap[targetUser], source: "github-users.json exact", orgMembers: [] };

  const firstName = String(targetUser).trim().split(/\s+/)[0] || "";
  if (githubUserMap[firstName]) return { login: githubUserMap[firstName], source: "github-users.json first name", orgMembers: [] };

  const rdLogin = resolveLoginFromresourceDirectory(targetUser, rdGithubByDisplay);
  if (rdLogin && !isBotLogin(rdLogin)) return { login: rdLogin, source: "resource-directory githubLogin", orgMembers: [] };

  let orgMembers = [];
  if (token && org) {
    orgMembers = await getOrgMemberLogins(org, token);
    const fuzzy = fuzzyMatchLogin(targetUser, orgMembers);
    if (fuzzy) return { login: fuzzy, source: "fuzzy org member match", orgMembers };
  }

  return { login: deriveGitHubLogin(targetUser), source: "derived fallback", orgMembers };
}

function commitAttributionFacts(commit, targetUser, targetLogin) {
  const authorLogin = commit.author?.login || "";
  const committerLogin = commit.committer?.login || "";
  const authorName = commit.commit?.author?.name || "";
  const authorEmail = commit.commit?.author?.email || "";
  return {
    authorLogin, committerLogin, authorName, authorEmail,
    matchesAuthorLogin: !!targetLogin && authorLogin.toLowerCase() === targetLogin.toLowerCase(),
    matchesCommitterLogin: !!targetLogin && committerLogin.toLowerCase() === targetLogin.toLowerCase(),
    matchesName: matchesTargetUser(targetUser, authorName),
    matchesEmail: matchesTargetUser(targetUser, authorEmail),
  };
}

async function validateGitHub(targetUser, overrideLogin, days) {
  section("GitHub");
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_METRICS_TOKEN;
  const org = process.env.ORG || "";
  console.log(`Org: ${org || "(missing)"}`);
  console.log(`Token: ${maskSecret(token)}`);

  if (!token || !org) {
    console.log("Status: skipped, missing GITHUB_TOKEN/GITHUB_METRICS_TOKEN or ORG");
    return { ok: false };
  }

  const me = await fetchJson(`${BASE_GITHUB_URL}/user`, { headers: githubHeaders(token) });
  console.log(`Auth check: ${me.response.status} ${me.response.statusText}`);
  if (me.response.ok) {
    const scopes = me.response.headers.get("x-oauth-scopes") || "(header not present)";
    console.log(`Authenticated as: ${me.json?.login || "(unknown)"} | scopes: ${scopes}`);
  } else {
    console.log(`Body: ${me.text.slice(0, 300)}`);
    return { ok: false };
  }

  if (!targetUser && !overrideLogin) {
    console.log("Target user: not provided, token validation only");
    return { ok: true };
  }

  const { startDate, endDate } = getDateRange(days);
  const resolved = await resolveGitHubLogin(targetUser, overrideLogin);
  const targetLogin = resolved.login;
  console.log(`Target user: ${targetUser || "(none)"}`);
  console.log(`resolved GitHub login: ${targetLogin || "(none)"} via ${resolved.source}`);
  if (resolved.orgMembers?.length) console.log(`Org member logins fetched for matching: ${resolved.orgMembers.length}`);

  if (!targetLogin) {
    console.log("Unable to resolve GitHub login for target user");
    return { ok: true, resolvedLogin: "", profile: null, prItems: [] };
  }

  const profile = await fetchJson(`${BASE_GITHUB_URL}/users/${encodeURIComponent(targetLogin)}`, { headers: githubHeaders(token) });
  console.log(`Profile lookup: ${profile.response.status}`);
  if (profile.response.ok) {
    console.log(`GitHub profile: login=${profile.json?.login || "-"} | name=${profile.json?.name || "-"} | email=${profile.json?.email || "-"}`);
  }

  const membership = await fetchJson(`${BASE_GITHUB_URL}/orgs/${org}/members/${encodeURIComponent(targetLogin)}`, { headers: githubHeaders(token) });
  console.log(`Org membership check: ${membership.response.status}`);

  const prSearchUrl = `${BASE_GITHUB_URL}/search/issues?q=${encodeURIComponent(`org:${org} author:${targetLogin} created:${startDate}..${endDate} is:pr`)}&per_page=20`;
  const prSearch = await fetchJson(prSearchUrl, { headers: githubHeaders(token) });
  console.log(`PR search: ${prSearch.response.status}`);

  const commitSearchUrl = `${BASE_GITHUB_URL}/search/commits?q=${encodeURIComponent(`org:${org} author:${targetLogin} committer-date:${startDate}..${endDate}`)}&per_page=20`;
  const commitSearch = await fetchJson(commitSearchUrl, { headers: githubHeaders(token) });
  console.log(`Commit search: ${commitSearch.response.status}`);

  const prItems = Array.isArray(prSearch.json?.items) ? prSearch.json.items : [];
  console.log(`Authored PRs in last ${days} days: ${prSearch.json?.total_count ?? 0}`);
  console.log(`Commit search hits in last ${days} days: ${commitSearch.json?.total_count ?? 0}`);

  let totalPrCommits = 0, authorLoginMatches = 0, committerLoginMatches = 0, authorNameMatches = 0, authorEmailMatches = 0;
  const uniqueAuthorLogins = new Set();
  const uniqueAuthorNames = new Set();
  const uniqueAuthorEmails = new Set();
  const mismatchExamples = [];
  const prBreakdown = [];

  for (const pr of prItems.slice(0, 10)) {
    const repoFullName = String(pr.repository_url || "").replace(`${BASE_GITHUB_URL}/repos/`, "");
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo || !pr.number) continue;

    const commits = await fetchJson(`${BASE_GITHUB_URL}/repos/${owner}/${repo}/pulls/${pr.number}/commits?per_page=100`, { headers: githubHeaders(token) });
    const commitList = Array.isArray(commits.json) ? commits.json : [];
    totalPrCommits += commitList.length;
    const prSummary = { repo: repoFullName, number: pr.number, title: pr.title || "", commitCount: commitList.length, matchedByLogin: 0, matchedByNameOrEmail: 0, otherAuthors: new Set() };

    for (const commit of commitList) {
      const facts = commitAttributionFacts(commit, targetUser, targetLogin);
      if (facts.authorLogin) uniqueAuthorLogins.add(facts.authorLogin);
      if (facts.authorName) uniqueAuthorNames.add(facts.authorName);
      if (facts.authorEmail) uniqueAuthorEmails.add(facts.authorEmail);
      if (facts.matchesAuthorLogin) authorLoginMatches++;
      if (facts.matchesCommitterLogin) committerLoginMatches++;
      if (facts.matchesName) authorNameMatches++;
      if (facts.matchesEmail) authorEmailMatches++;
      if (facts.matchesAuthorLogin) prSummary.matchedByLogin++;
      if (!facts.matchesAuthorLogin && (facts.matchesName || facts.matchesEmail)) prSummary.matchedByNameOrEmail++;
      const hasAnyMatch = facts.matchesAuthorLogin || facts.matchesCommitterLogin || facts.matchesName || facts.matchesEmail;
      if (!hasAnyMatch) prSummary.otherAuthors.add(facts.authorLogin || facts.authorName || facts.authorEmail || "(unknown)");
      if (!hasAnyMatch && mismatchExamples.length < 5) {
        mismatchExamples.push(`${owner}/${repo}#${pr.number} | authorLogin=${facts.authorLogin || "-"} | committerLogin=${facts.committerLogin || "-"} | authorName=${facts.authorName || "-"} | authorEmail=${facts.authorEmail || "-"}`);
      }
    }
    prBreakdown.push(prSummary);
  }

  console.log(`PR commit rows inspected: ${totalPrCommits}`);
  console.log(`PR commits with author.login == ${targetLogin}: ${authorLoginMatches}`);
  console.log(`PR commits with committer.login == ${targetLogin}: ${committerLoginMatches}`);
  console.log(`PR commits with author name matching "${targetUser}": ${authorNameMatches}`);
  console.log(`PR commits with author email matching "${targetUser}": ${authorEmailMatches}`);

  if (mismatchExamples.length) {
    console.log("Mismatch examples:");
    mismatchExamples.forEach((line, i) => console.log(`  ${i + 1}. ${line}`));
  }

  if ((prSearch.json?.total_count ?? 0) > 0 && (commitSearch.json?.total_count ?? 0) === 0) {
    if (authorNameMatches > 0 || authorEmailMatches > 0) {
      console.log("Inference: PRs exist, but commit search by GitHub login is empty. The commits likely use a name/email that is not linked strongly enough to the resolved GitHub login.");
    } else if (totalPrCommits > 0 && authorLoginMatches === 0) {
      console.log("Inference: PRs were authored by this user, but the commits in those PRs appear to belong to other authors/logins.");
    } else {
      console.log("Inference: PR authorship exists, but there is no direct commit attribution for the resolved login in the selected date window.");
    }
  }

  if (membership.response.status === 404) {
    console.log("Inference: resolved login is not a visible org member. read:org scope or login resolution may need attention.");
  }
  if (commitSearch.response.status === 422) {
    console.log("Inference: commit search is unavailable for this token or query. Repo-level commit inspection from PRs is still shown above.");
  }

  return { ok: true, resolvedLogin: targetLogin, profile: profile.json || null, prItems };
}

async function validateConfluence() {
  section("Confluence");
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN;
  const domain = process.env.JIRA_DOMAIN;

  console.log(`Domain: ${domain || "(missing)"}`);
  console.log(`Email: ${email || "(missing)"}`);
  console.log(`Token: ${maskSecret(token)} (reusing JIRA_TOKEN)`);

  if (!email || !token || !domain) {
    console.log("Status: skipped, missing JIRA_EMAIL / JIRA_TOKEN / JIRA_DOMAIN");
    return { ok: false };
  }

  const headers = jiraHeaders(email, token);
  const wikiBase = `https://${domain}/wiki`;

  const spacesRes = await fetchJson(`${wikiBase}/rest/api/space?limit=25&type=global`, { headers });
  console.log(`Space list: ${spacesRes.response.status} ${spacesRes.response.statusText}`);
  if (!spacesRes.response.ok) {
    console.log(`Body: ${spacesRes.text.slice(0, 300)}`);
    return { ok: false };
  }
  const spaces = spacesRes.json?.results || [];
  console.log(`Global spaces found: ${spaces.length}`);
  spaces.slice(0, 10).forEach((sp, i) => console.log(`  ${i + 1}. ${sp.key} — ${sp.name}`));
  if (spaces.length > 10) console.log(`  ... and ${spaces.length - 10} more`);

  const cqlQuery = encodeURIComponent("type=page ORDER BY lastModified DESC");
  const searchRes = await fetchJson(`${wikiBase}/rest/api/content/search?cql=${cqlQuery}&limit=5&expand=version,history,space`, { headers });
  console.log(`CQL search (recent pages): ${searchRes.response.status} ${searchRes.response.statusText}`);
  if (searchRes.response.ok) {
    const pages = searchRes.json?.results || [];
    console.log(`Sample pages: ${pages.length}`);
    pages.forEach((p, i) => {
      const editor = p.version?.by?.displayName || p.history?.createdBy?.displayName || "(unknown)";
      const spaceKey = p.space?.key || "?";
      console.log(`  ${i + 1}. [${spaceKey}] ${p.title} — last edited by ${editor} (v${p.version?.number || "?"})`);
    });
  } else {
    console.log(`Body: ${searchRes.text.slice(0, 300)}`);
  }
  return { ok: spacesRes.response.ok };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  section("Run Config");
  console.log(`User: ${args.user || "(none)"}`);
  console.log(`Days: ${args.days}`);
  console.log(`GitHub login override: ${args.githubLogin || "(none)"}`);
  console.log(`Working directory: ${process.cwd()}`);
  console.log(`github-users.json present: ${fs.existsSync(GITHUB_USERS_JSON)}`);
  console.log(`resource-directory.json present: ${fs.existsSync(resource_DIRECTORY_JSON)}`);
  console.log(`Output dir: ${OUTPUT_DIR}`);

  const rdInfo = inspectresourceDirectory(args.user);
  const jiraInfo = await validateJira(args.user);
  await validateConfluence();
  await validateCursor(args.user);
  const githubInfo = await validateGitHub(args.user, args.githubLogin, args.days);

  section("Identity Summary");
  const topRd = rdInfo.matches?.[0];
  if (topRd) {
    console.log(`resource directory: ${topRd.displayName || "-"} | Pune(IDC)=${topRd.pune} | email=${topRd.email || "-"} | accountId=${topRd.accountId || "-"}`);
  } else {
    console.log("resource directory: no local cache match (or missing file / no --user)");
  }
  const topJiraMatch = jiraInfo.matches?.[0];
  if (topJiraMatch) {
    console.log(`Jira: ${topJiraMatch.displayName || "-"} | email=${topJiraMatch.emailAddress || "-"} | accountId=${topJiraMatch.accountId || "-"}`);
  } else {
    console.log("Jira: no target user match");
  }
  if (githubInfo.resolvedLogin) {
    console.log(`GitHub: login=${githubInfo.resolvedLogin} | profileName=${githubInfo.profile?.name || "-"} | profileEmail=${githubInfo.profile?.email || "-"}`);
  } else {
    console.log("GitHub: no resolved login");
  }

  console.log("\nDone.");
}

main().catch((error) => {
  console.error("\nFatal error:", error?.stack || error?.message || error);
  process.exitCode = 1;
});

// Touch __dirname/__filename to satisfy strict linters that flag unused
// declarations even though they are part of the standard CLI scaffold.
void __dirname;
void __filename;
