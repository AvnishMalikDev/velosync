/**
 * Cursor analytics connector.
 *
 * Fetches Cursor usage analytics (leaderboard, top users, model / language /
 * work share, AI edits per repository, intent distribution) and writes the
 * result to `output/cursordata.json` for the dashboard to consume.
 *
 * Requires `CURSOR_TOKEN` in `.env`.
 *
 * Uses a custom HTTPS agent with `rejectUnauthorized: false` so the export
 * runs behind corporate MITM proxies that present their own CA. Without it,
 * `api.cursor.com` requests fail with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
 *
 * Standalone CLI:
 *   node src/connectors/cursor/client.js
 */

import "../../core/env.js";
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { join, resolve } from "path";
import https from "https";
import { OUTPUT_DIR } from "../../core/paths.js";

const OUTPUT_FILE = join(OUTPUT_DIR, "cursordata.json");
const BASE_URL = "https://api.cursor.com";
/** Top-N users kept from both daily-usage aggregate and the leaderboard trim. */
const CURSOR_LEADERBOARD_TOP_N = 25;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function getAuthHeaders(token) {
  const encoded = Buffer.from(`${token}:`).toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function getBearerHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

/**
 * Flatten an `Error` (and its `cause` chain) into a single string suitable for
 * surfacing to the operator without losing the underlying network code.
 */
function normalizeFetchError(err, context) {
  const cause = err.cause?.message || err.cause?.code || "";
  const code = err.cause?.code || err.code || "";
  const msg = err.message + (cause ? ` (${cause})` : "") + (code ? ` [${code}]` : "");
  return { message: msg, code, context };
}

/**
 * Plain HTTPS request that goes through `httpsAgent`. Built directly on the
 * `https` module (rather than global `fetch`) so the custom agent is honoured
 * — `fetch` does not let us inject one in older Node versions.
 */
function httpsRequest(urlStr, method, headers, body = null) {
  const u = new URL(urlStr);
  const bodyBuf = body ? Buffer.from(body, "utf8") : null;
  const opts = {
    hostname: u.hostname,
    port: u.port || 443,
    path: u.pathname + u.search,
    method,
    headers: bodyBuf
      ? { ...headers, "Content-Length": bodyBuf.length }
      : headers,
    agent: httpsAgent,
  };
  return new Promise((resolvereq, rejectReq) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolvereq({ statusCode: res.statusCode, body: raw });
      });
    });
    req.on("error", rejectReq);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/**
 * GET analytics/team/leaderboard. Tries Bearer first then falls back to Basic
 * for older tokens that only grant the analytics scope under Basic auth.
 */
async function fetchLeaderboard(token) {
  const url = `${BASE_URL}/analytics/team/leaderboard?startDate=30d&endDate=now`;
  for (const headers of [getBearerHeaders(token), getAuthHeaders(token)]) {
    const { statusCode, body } = await httpsRequest(url, "GET", headers);
    if (statusCode === 200) return JSON.parse(body);
    if (statusCode === 401) continue;
    throw new Error(`Leaderboard ${statusCode}: ${body}`);
  }
  return null;
}

/**
 * GET analytics/ai-code/commits. Bearer-only; matches the working
 * PowerShell/curl reference. Returns null on 401/403/404 so callers can skip
 * the section gracefully when the token lacks the AI Code Tracking scope.
 */
async function fetchAiCodeCommits(token, startDate = "30d", endDate = "now", page, pageSize) {
  let url = `${BASE_URL}/analytics/ai-code/commits?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
  if (page != null && pageSize != null) {
    url += `&page=${page}&pageSize=${pageSize}`;
  }
  const headers = getBearerHeaders(token);
  const { statusCode, body } = await httpsRequest(url, "GET", headers);
  if (statusCode === 200) {
    return JSON.parse(body);
  }
  if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
    console.warn("[Cursor] AI commits endpoint returned", statusCode, body?.slice?.(0, 300) || body);
    return null;
  }
  throw new Error(`AI commits ${statusCode}: ${body}`);
}

/** Normalize a commit row across camelCase / snake_case API variants. */
function normalizeCommit(c) {
  return {
    repoName: c.repoName ?? c.repo_name ?? "",
    message: (c.message || "").trim(),
    tabLinesAdded: c.tabLinesAdded ?? c.tab_lines_added ?? 0,
    composerLinesAdded: c.composerLinesAdded ?? c.composer_lines_added ?? 0,
    totalLinesAdded: c.totalLinesAdded ?? c.total_lines_added ?? 0,
  };
}

/** Coarse category from the first line of a commit message (keyword + conventional-commits). */
function categoryFromCommitMessage(message) {
  const firstLine = (message || "").split(/\n/)[0].toLowerCase();
  if (!firstLine) return "Other";
  if (/\b(fix|bugfix|bug\s*fix)\b/.test(firstLine)) return "Bug Fix";
  if (/\b(config|configuration)\b/.test(firstLine)) return "Configuration";
  if (/\b(explain|explanation)\b/.test(firstLine)) return "Explanation";
  if (/\brefactor\b/.test(firstLine)) return "Refactor";
  if (/\b(feat|feature)\b/.test(firstLine)) return "Feature";
  if (/\b(data|database|db)\b/.test(firstLine)) return "Data/Database";
  if (/\b(test|testing)\b/.test(firstLine)) return "Testing";
  if (/\b(doc|documentation)\b/.test(firstLine)) return "Documentation";
  return "Other";
}

/** Extract the commits array regardless of which envelope shape the API returned. */
function getCommitsFromResponse(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  return res.items ?? res.data ?? res.commits ?? [];
}

/**
 * Walk all pages of `/analytics/ai-code/commits` and aggregate by repository
 * and message-derived category in a single sweep so we never re-fetch the
 * commit list.
 */
async function fetchAndAggregateAiCommitsByRepo(token) {
  const byRepo = new Map();
  const byCategory = new Map();
  let totalAiLinesForCategories = 0;
  const pageSize = 1000;
  let page = 1;
  let totalCount = null;

  while (true) {
    const res = page === 1
      ? await fetchAiCodeCommits(token, "30d", "now")
      : await fetchAiCodeCommits(token, "30d", "now", page, pageSize);
    if (!res) break;
    totalCount = res.totalCount ?? res.total_count ?? totalCount;
    const items = getCommitsFromResponse(res);
    if (!items.length) {
      if (page === 1) console.log("[Cursor] AI commits: 0 commits in range.");
      break;
    }
    for (const c of items) {
      const n = normalizeCommit(c);
      const key = n.repoName || "__unknown__";
      const aiAdded = (Number(n.tabLinesAdded) || 0) + (Number(n.composerLinesAdded) || 0);
      const totalAdded = Number(n.totalLinesAdded) || 0;
      if (!byRepo.has(key)) {
        byRepo.set(key, { repoName: key, aiLinesAdded: 0, totalLinesAdded: 0 });
      }
      const r = byRepo.get(key);
      r.aiLinesAdded += aiAdded;
      r.totalLinesAdded += totalAdded;
      if (aiAdded > 0) {
        const category = categoryFromCommitMessage(n.message);
        byCategory.set(category, (byCategory.get(category) || 0) + aiAdded);
        totalAiLinesForCategories += aiAdded;
      }
    }
    if (page === 1 && items.length > 0) {
      console.log("[Cursor] AI commits: first page got", items.length, "commits");
    }
    const hasMore = totalCount != null && page * pageSize < totalCount;
    if (!hasMore || items.length < pageSize) break;
    page++;
  }
  function projectNameFromRepo(repo) {
    if (!repo) return repo;
    const afterSlash = repo.replace(/^.*\//, "");
    try {
      return decodeURIComponent(afterSlash);
    } catch {
      return afterSlash.replace(/%20/g, " ");
    }
  }

  const list = Array.from(byRepo.values())
    .filter((r) => r.repoName !== "__unknown__")
    .map((r) => ({
      repository: r.repoName,
      projectName: projectNameFromRepo(r.repoName),
      aiLinesCommitted: r.aiLinesAdded,
      totalLinesCommitted: r.totalLinesAdded,
      codeCommittedByAiPct: r.totalLinesAdded > 0 ? Math.round((r.aiLinesAdded / r.totalLinesAdded) * 1000) / 10 : 0,
    }))
    .sort((a, b) => (b.aiLinesCommitted || 0) - (a.aiLinesCommitted || 0));

  const categories = {};
  if (totalAiLinesForCategories > 0) {
    const order = ["Bug Fix", "Configuration", "Explanation", "Refactor", "Feature", "Data/Database", "Testing", "Documentation", "Other"];
    for (const cat of order) {
      const lines = byCategory.get(cat) || 0;
      if (lines > 0) {
        categories[cat] = Math.round((lines / totalAiLinesForCategories) * 10000) / 100;
      }
    }
  }

  return { repoList: list, categories };
}

/** Last 30 calendar days inclusive of today, expressed in UTC ms timestamps. */
function getLast30DaysRange() {
  const now = new Date();
  const endOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const endDate = endOfToday.getTime();
  const startOfDay30Ago = new Date(endOfToday);
  startOfDay30Ago.setUTCDate(startOfDay30Ago.getUTCDate() - 30);
  startOfDay30Ago.setUTCHours(0, 0, 0, 0);
  const startDate = startOfDay30Ago.getTime();
  return { startDate, endDate };
}

/**
 * POST teams/daily-usage-data, paginating through all rows for the last 30
 * days. Uses Basic auth (the only auth scheme this endpoint accepts).
 */
async function fetchDailyUsage(token) {
  const { startDate, endDate } = getLast30DaysRange();
  const url = `${BASE_URL}/teams/daily-usage-data`;
  const pageSize = 1000;
  const allData = [];
  let page = 1;
  let totalPages = 1;

  do {
    const body = JSON.stringify({ startDate, endDate, page, pageSize });
    const { statusCode, body: raw } = await httpsRequest(url, "POST", getAuthHeaders(token), body);
    if (statusCode !== 200) {
      throw new Error(`Daily usage ${statusCode}: ${raw}`);
    }
    const res = JSON.parse(raw);
    const data = res?.data || [];
    allData.push(...data);
    const pagination = res?.pagination || {};
    totalPages = pagination.totalPages ?? (data.length < pageSize ? page : 999);
    if (page === 1 && allData.length > 0) {
      console.log("[Cursor] Daily usage: 30-day range, page 1 got", data.length, "rows; totalPages", totalPages);
    }
    if (page >= totalPages || data.length < pageSize) break;
    page++;
  } while (page <= totalPages);

  return {
    data: allData,
    period: { startDate, endDate },
    pagination: { totalRows: allData.length },
  };
}

/**
 * Reduce daily-usage rows into the dashboard-shaped aggregate (top-N
 * leaderboard, model / language / work share, intent distribution, summary).
 */
function aggregateUsage(dailyData) {
  const data = dailyData?.data || [];
  if (data.length === 0) {
    return {
      top10Users: [],
      modelShare: {},
      languageShare: {},
      workShare: {},
      intentDistribution: {},
      summary: { totalActiveUsers: 0, totalEngagedUsers: 0, totalRequests: 0, linesAccepted: 0, linesSuggested: 0 },
    };
  }

  const byUser = new Map();
  const modelCounts = {};
  const extensionCounts = {};
  let totalComposer = 0, totalChat = 0, totalAgent = 0, totalCmdk = 0, totalTab = 0;

  for (const row of data) {
    const email = row.email || `user_${row.userId}`;
    if (!byUser.has(email)) {
      byUser.set(email, {
        email,
        userId: row.userId,
        totalLinesAdded: 0,
        totalLinesDeleted: 0,
        acceptedLinesAdded: 0,
        acceptedLinesDeleted: 0,
        totalAccepts: 0,
        totalRejects: 0,
        totalTabsShown: 0,
        totalTabsAccepted: 0,
        composerRequests: 0,
        chatRequests: 0,
        agentRequests: 0,
        cmdkUsages: 0,
      });
    }
    const u = byUser.get(email);
    u.totalLinesAdded += row.totalLinesAdded ?? 0;
    u.totalLinesDeleted += row.totalLinesDeleted ?? 0;
    u.acceptedLinesAdded += row.acceptedLinesAdded ?? 0;
    u.acceptedLinesDeleted += row.acceptedLinesDeleted ?? 0;
    u.totalAccepts += row.totalAccepts ?? 0;
    u.totalRejects += row.totalRejects ?? 0;
    u.totalTabsShown += row.totalTabsShown ?? 0;
    u.totalTabsAccepted += row.totalTabsAccepted ?? 0;
    u.composerRequests += row.composerRequests ?? 0;
    u.chatRequests += row.chatRequests ?? 0;
    u.agentRequests += row.agentRequests ?? 0;
    u.cmdkUsages += row.cmdkUsages ?? 0;

    const model = row.mostUsedModel || "unknown";
    modelCounts[model] = (modelCounts[model] || 0) + 1;
    const extApply = row.applyMostUsedExtension || "other";
    const extTab = row.tabMostUsedExtension || "other";
    const normKey = (raw) => {
      const s = String(raw || "").trim().toLowerCase();
      return s === "others" ? "other" : s || "other";
    };
    const keyApply = normKey(extApply);
    const keyTab = normKey(extTab);
    extensionCounts[keyApply] = (extensionCounts[keyApply] || 0) + 1;
    extensionCounts[keyTab] = (extensionCounts[keyTab] || 0) + 1;

    totalComposer += row.composerRequests ?? 0;
    totalChat += row.chatRequests ?? 0;
    totalAgent += row.agentRequests ?? 0;
    totalCmdk += row.cmdkUsages ?? 0;
    totalTab += (row.totalTabsShown ?? 0) + (row.totalTabsAccepted ?? 0);
  }

  const users = Array.from(byUser.values());
  users.forEach((u) => {
    const total = u.totalAccepts + u.totalRejects;
    u.acceptance_rate = total > 0 ? Math.round((u.totalAccepts / total) * 100) / 100 : null;
  });
  users.sort((a, b) => (b.totalLinesAdded || 0) - (a.totalLinesAdded || 0));
  const top10Users = users.slice(0, CURSOR_LEADERBOARD_TOP_N).map((u) => ({
    email: u.email,
    lines_added: u.totalLinesAdded,
    lines_deleted: u.totalLinesDeleted,
    acceptance_rate: u.acceptance_rate,
    composer_requests: u.composerRequests,
    chat_requests: u.chatRequests,
    agent_requests: u.agentRequests,
    cmdk_usages: u.cmdkUsages,
  }));

  const totalModel = Object.values(modelCounts).reduce((a, b) => a + b, 0);
  const modelShare = {};
  for (const [k, v] of Object.entries(modelCounts)) {
    modelShare[k] = totalModel > 0 ? Math.round((v / totalModel) * 10000) / 100 : 0;
  }

  const totalExt = Object.values(extensionCounts).reduce((a, b) => a + b, 0);
  const languageShare = {};
  for (const [k, v] of Object.entries(extensionCounts)) {
    const label = k === "other" ? "other" : k.replace(/^\./, "");
    languageShare[label] = totalExt > 0 ? Math.round((v / totalExt) * 10000) / 100 : 0;
  }

  const totalWork = totalComposer + totalChat + totalAgent + totalCmdk + totalTab;
  const workShare = {
    composer: totalWork > 0 ? Math.round((totalComposer / totalWork) * 10000) / 100 : 0,
    chat: totalWork > 0 ? Math.round((totalChat / totalWork) * 10000) / 100 : 0,
    agent: totalWork > 0 ? Math.round((totalAgent / totalWork) * 10000) / 100 : 0,
    cmdk_inline_edit: totalWork > 0 ? Math.round((totalCmdk / totalWork) * 10000) / 100 : 0,
    tab_completions: totalWork > 0 ? Math.round((totalTab / totalWork) * 10000) / 100 : 0,
  };
  // Intent distribution mirrors the Cursor product UX: Write Code = Composer + Tab,
  // Ask = Chat, Plan = Agent, Task Automation = Cmd+K.
  const intentDistribution = totalWork > 0 ? {
    "Write Code": Math.round(((totalComposer + totalTab) / totalWork) * 10000) / 100,
    "Ask": Math.round((totalChat / totalWork) * 10000) / 100,
    "Plan": Math.round((totalAgent / totalWork) * 10000) / 100,
    "Task Automation": Math.round((totalCmdk / totalWork) * 10000) / 100,
  } : {};

  const totalActiveUsers = users.length;
  const totalEngagedUsers = users.filter(
    (u) => (u.totalAccepts + u.totalRejects) > 0 || (u.composerRequests + u.chatRequests + u.agentRequests) > 0,
  ).length;
  const totalRequests = totalComposer + totalChat + totalAgent;
  // Lines metrics: accepted = AI lines accepted; suggested = total lines changed
  // (force suggested >= accepted so the dashboard ratio is never > 100%).
  const linesAccepted = users.reduce(
    (s, u) => s + (u.acceptedLinesAdded || 0) + (u.acceptedLinesDeleted || 0),
    0,
  );
  let linesSuggested = users.reduce(
    (s, u) => s + (u.totalLinesAdded || 0) + (u.totalLinesDeleted || 0),
    0,
  );
  if (linesSuggested < linesAccepted) linesSuggested = linesAccepted;

  const summary = {
    totalActiveUsers,
    totalEngagedUsers,
    totalRequests,
    linesAccepted,
    linesSuggested,
  };

  return { top10Users, modelShare, languageShare, workShare, intentDistribution, summary };
}

/**
 * Top-level entry. Fetches Cursor metrics and persists `output/cursordata.json`.
 *
 * Never throws — all errors are flattened into the JSON payload so a
 * downstream dashboard can still render with a clear "data unavailable"
 * banner instead of crashing the whole sync run.
 */
export async function getCursorData() {
  const token = process.env.CURSOR_TOKEN;

  console.log("--- Starting Cursor metrics fetch ---");

  if (!token) {
    console.warn("[Cursor] Skipped: missing CURSOR_TOKEN in .env");
    return;
  }

  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const result = {
      lastSync: new Date().toISOString(),
      period: "30d",
      leaderboard: null,
      top10Users: [],
      modelShare: {},
      languageShare: {},
      workShare: {},
      intentDistribution: {},
      summary: null,
      aiEditsByRepository: [],
      categories: {},
      rawDailyUsage: null,
    };

    try {
      const leaderboard = await fetchLeaderboard(token);
      if (leaderboard) {
        if (Array.isArray(leaderboard)) {
          const sorted = [...leaderboard].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
          result.leaderboard = sorted.slice(0, CURSOR_LEADERBOARD_TOP_N);
        } else if (leaderboard && typeof leaderboard === "object" && Array.isArray(leaderboard.data) && !leaderboard.tab_leaderboard) {
          const sorted = [...leaderboard.data].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
          result.leaderboard = sorted.slice(0, CURSOR_LEADERBOARD_TOP_N);
        } else if (leaderboard && typeof leaderboard === "object") {
          const out = { ...leaderboard };
          if (Array.isArray(leaderboard.tab_leaderboard?.data)) {
            const sorted = [...leaderboard.tab_leaderboard.data].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
            out.tab_leaderboard = { ...leaderboard.tab_leaderboard, data: sorted.slice(0, CURSOR_LEADERBOARD_TOP_N) };
          }
          if (Array.isArray(leaderboard.agent_leaderboard?.data)) {
            const sorted = [...leaderboard.agent_leaderboard.data].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
            out.agent_leaderboard = { ...leaderboard.agent_leaderboard, data: sorted.slice(0, CURSOR_LEADERBOARD_TOP_N) };
          }
          result.leaderboard = out;
        } else {
          result.leaderboard = leaderboard;
        }
        console.log("[Cursor] Leaderboard fetched.");
      } else {
        console.log("[Cursor] Leaderboard endpoint not available or unauthorized (will use daily-usage aggregates).");
      }
    } catch (e) {
      const detail = normalizeFetchError(e, "leaderboard");
      result.errorLeaderboard = detail;
      console.warn("[Cursor] Leaderboard fetch failed:", detail.message);
    }

    try {
      const daily = await fetchDailyUsage(token);
      result.rawDailyUsage = daily?.data ? { period: daily.period, rowCount: daily.data.length } : null;
      const agg = aggregateUsage(daily);
      result.top10Users = agg.top10Users;
      result.modelShare = agg.modelShare;
      result.languageShare = agg.languageShare;
      result.workShare = agg.workShare;
      result.intentDistribution = agg.intentDistribution || {};
      result.summary = agg.summary || null;
      console.log("[Cursor] Daily usage aggregated: top users, model/language/work share.");
    } catch (e) {
      const detail = normalizeFetchError(e, "daily-usage");
      result.errorDailyUsage = detail;
      console.warn("[Cursor] Daily usage fetch failed:", detail.message);
    }

    try {
      const { repoList, categories } = await fetchAndAggregateAiCommitsByRepo(token);
      if (repoList && repoList.length > 0) {
        result.aiEditsByRepository = repoList;
        console.log("[Cursor] AI edits by repository:", repoList.length, "repos");
      } else {
        console.log("[Cursor] AI edits by repository: no data (endpoint may require Bearer token or returned empty)");
      }
      if (categories && Object.keys(categories).length > 0) {
        result.categories = categories;
        console.log("[Cursor] Categories (from commit messages):", Object.keys(categories).length, "categories");
      }
    } catch (e) {
      console.warn("[Cursor] AI code commits (by repo/categories) fetch failed:", e.message, e.stack?.slice(0, 200));
    }

    if (result.errorLeaderboard && result.errorDailyUsage) {
      const first = result.errorLeaderboard;
      result.error = first.message;
      result.errorCode = first.code;
      result.errorHint = "Both leaderboard and daily-usage failed. Check network/proxy/TLS to https://api.cursor.com. Try NODE_TLS_REJECT_UNAUTHORIZED=0 only if behind corporate MITM proxy.";
    }

    writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), "utf8");
    console.log("[Cursor] Written:", OUTPUT_FILE);
  } catch (err) {
    const detail = normalizeFetchError(err, "getCursorData");
    console.error("[Cursor] Error:", detail.message);
    try {
      mkdirSync(OUTPUT_DIR, { recursive: true });
      const causeInfo = err.cause
        ? { message: err.cause.message, code: err.cause.code }
        : undefined;
      writeFileSync(OUTPUT_FILE, JSON.stringify({
        error: detail.message,
        errorCode: detail.code,
        lastSync: new Date().toISOString(),
        cause: causeInfo,
        hint: "If fetch failed: check network/proxy/firewall to https://api.cursor.com. Corporate proxy? Try NODE_TLS_REJECT_UNAUTHORIZED=0 (only if behind MITM proxy).",
      }, null, 2));
    } catch (e) {
      console.warn("[Cursor] Could not write error file:", e.message);
    }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  getCursorData();
}
