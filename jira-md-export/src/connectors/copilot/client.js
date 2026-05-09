/**
 * GitHub Copilot connector.
 *
 * Pulls the latest 28-day enterprise + user-level Copilot metrics reports and
 * writes a combined `output/copilotdata.json` for the dashboard.
 *
 * Requires `GITHUB_TOKEN` (with `manage_billing:copilot` or `read:enterprise`)
 * and `ENT` (enterprise slug) in `.env`.
 *
 * Built directly on Node's `https` module (rather than `fetch`) so the export
 * works behind corporate MITM proxies — same rationale as the Cursor
 * connector, see `agent: httpsAgent` below.
 *
 * Standalone CLI:
 *   node src/connectors/copilot/client.js
 */

import "../../core/env.js";
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { join, resolve } from "path";
import https from "https";
import { OUTPUT_DIR } from "../../core/paths.js";

const OUTPUT_FILE = join(OUTPUT_DIR, "copilotdata.json");
const COPILOT_USER_LEADERBOARD_TOP_N = 25;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const defaultHeaders = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": "VeloSync-dashboard-copilot-exporter/1.0",
};

/**
 * Plain HTTPS GET via `httpsAgent`. Returns a Response-shaped object so the
 * call sites read like `fetch` results.
 */
function httpsGet(urlStr, hdrs) {
  const u = new URL(urlStr);
  const opts = {
    hostname: u.hostname,
    port: u.port || 443,
    path: u.pathname + u.search,
    method: "GET",
    headers: hdrs,
    agent: httpsAgent,
  };
  return new Promise((resolvereq, rejectReq) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolvereq({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: () => Promise.resolve(body),
          json: () => Promise.resolve(JSON.parse(body)),
        });
      });
    });
    req.on("error", rejectReq);
    req.end();
  });
}

/**
 * Reduce one `day_total` row from the enterprise report into the dashboard's
 * expected shape (totals_by_language_feature ? languages, totals_by_feature ?
 * chat counts).
 */
function normalizeEnterpriseDayTotal(dayTotal) {
  if (!dayTotal || typeof dayTotal !== "object" || !dayTotal.day) return null;

  let totalChats = 0;
  const languageMap = new Map();
  const languageTotals = Array.isArray(dayTotal.totals_by_language_feature) ? dayTotal.totals_by_language_feature : [];

  for (const item of languageTotals) {
    const name = String(item?.language || "").trim() || "Unknown";
    const accepted = Number(item?.loc_added_sum) || 0;
    const suggested = Number(item?.loc_suggested_to_add_sum) || 0;
    const current = languageMap.get(name) || { name, total_code_lines_accepted: 0, total_code_lines_suggested: 0 };
    current.total_code_lines_accepted += accepted;
    current.total_code_lines_suggested += suggested;
    languageMap.set(name, current);
  }

  const featureTotals = Array.isArray(dayTotal.totals_by_feature) ? dayTotal.totals_by_feature : [];
  for (const feature of featureTotals) {
    const featureName = String(feature?.feature || "").toLowerCase();
    if (featureName.includes("chat")) totalChats += Number(feature?.user_initiated_interaction_count) || 0;
  }

  return {
    day: dayTotal.day,
    copilot_chat: {
      total_active_users: dayTotal.monthly_active_users ?? dayTotal.daily_active_users ?? null,
      total_engaged_users: dayTotal.monthly_active_chat_users ?? dayTotal.daily_active_users ?? null,
      total_chats: totalChats,
    },
    copilot_ide_code_completions: {
      total_code_lines_accepted: Number(dayTotal.loc_added_sum) || 0,
      total_code_lines_suggested: Number(dayTotal.loc_suggested_to_add_sum) || 0,
      languages: [...languageMap.values()].map(({ name, total_code_lines_accepted }) => ({
        name,
        total_code_lines_accepted,
      })),
    },
  };
}

/** Parse newline-delimited JSON safely (skips blank lines from streaming downloads). */
function parseNdjsonLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Fetch the enterprise 28-day report metadata, follow each `download_links`
 * URL, then flatten the day_totals into a normalized array.
 */
async function fetchCopilotReportRows(ent) {
  const reportUrl = `https://api.github.com/enterprises/${ent}/copilot/metrics/reports/enterprise-28-day/latest`;
  console.log("[Copilot] Requesting latest 28-day enterprise report:", reportUrl);
  const reportRes = await httpsGet(reportUrl, defaultHeaders);

  if (!reportRes.ok) {
    const text = await reportRes.text();
    const err = new Error(`HTTP ${reportRes.status}: ${text}`);
    err.status = reportRes.status;
    throw err;
  }

  const reportMeta = await reportRes.json();
  const links = Array.isArray(reportMeta.download_links) ? reportMeta.download_links : [];
  if (links.length === 0) return [];

  const normalizedRows = [];
  const downloadHeaders = { "User-Agent": defaultHeaders["User-Agent"], Accept: "application/octet-stream" };
  for (const link of links) {
    const downloadRes = await httpsGet(link, downloadHeaders);
    if (!downloadRes.ok) {
      throw new Error(`Failed to download Copilot report (${downloadRes.status})`);
    }
    const text = await downloadRes.text();
    let records;
    try {
      records = JSON.parse(text);
    } catch {
      records = parseNdjsonLines(text);
    }

    const rows = Array.isArray(records) ? records : [records];
    for (const row of rows) {
      const dayTotals = Array.isArray(row?.day_totals) ? row.day_totals : [];
      for (const dayTotal of dayTotals) {
        const normalized = normalizeEnterpriseDayTotal(dayTotal);
        if (normalized) normalizedRows.push(normalized);
      }
    }
  }

  normalizedRows.sort((a, b) => String(a.day).localeCompare(String(b.day)));
  return normalizedRows;
}

/**
 * Fetch the user-level 28-day report (one row per user-day). Returns the raw
 * NDJSON rows untouched — aggregation happens in `aggregateCopilotUserRows`.
 */
async function fetchCopilotUserReportRows(ent) {
  const reportUrl = `https://api.github.com/enterprises/${ent}/copilot/metrics/reports/users-28-day/latest`;
  console.log("[Copilot] Requesting latest 28-day user-level report:", reportUrl);
  const reportRes = await httpsGet(reportUrl, defaultHeaders);

  if (!reportRes.ok) {
    const text = await reportRes.text();
    const err = new Error(`HTTP ${reportRes.status}: ${text}`);
    err.status = reportRes.status;
    throw err;
  }

  const reportMeta = await reportRes.json();
  const links = Array.isArray(reportMeta.download_links) ? reportMeta.download_links : [];
  if (links.length === 0) return [];

  const allRows = [];
  const downloadHeaders = { "User-Agent": defaultHeaders["User-Agent"], Accept: "application/octet-stream" };
  for (const link of links) {
    const downloadRes = await httpsGet(link, downloadHeaders);
    if (!downloadRes.ok) {
      throw new Error(`Failed to download Copilot user report (${downloadRes.status})`);
    }
    const text = await downloadRes.text();
    let records;
    try {
      records = JSON.parse(text);
    } catch {
      records = parseNdjsonLines(text);
    }
    const rows = Array.isArray(records) ? records : [records];
    allRows.push(...rows);
  }
  return allRows;
}

/**
 * Aggregate per-user-day rows into a top-N leaderboard with the same shape
 * as the Cursor leaderboard (so the dashboard can render both with one
 * component).
 */
function aggregateCopilotUserRows(userDayRows) {
  const byUser = new Map();

  for (const row of userDayRows) {
    const login = row.user_login || `user_${row.user_id}`;
    if (!byUser.has(login)) {
      byUser.set(login, {
        user_login: login,
        user_id: row.user_id,
        loc_added_sum: 0,
        loc_deleted_sum: 0,
        loc_suggested_to_add_sum: 0,
        loc_suggested_to_delete_sum: 0,
        code_acceptance_activity_count: 0,
        code_generation_activity_count: 0,
        active_days: 0,
        used_chat: false,
        used_agent: false,
        used_cli: false,
        chat_interactions: 0,
        features_used: new Set(),
      });
    }
    const u = byUser.get(login);
    u.loc_added_sum += Number(row.loc_added_sum) || 0;
    u.loc_deleted_sum += Number(row.loc_deleted_sum) || 0;
    u.loc_suggested_to_add_sum += Number(row.loc_suggested_to_add_sum) || 0;
    u.loc_suggested_to_delete_sum += Number(row.loc_suggested_to_delete_sum) || 0;
    u.code_acceptance_activity_count += Number(row.code_acceptance_activity_count) || 0;
    u.code_generation_activity_count += Number(row.code_generation_activity_count) || 0;
    u.active_days += 1;
    if (row.used_chat) u.used_chat = true;
    if (row.used_agent) u.used_agent = true;
    if (row.used_cli) u.used_cli = true;

    const features = Array.isArray(row.totals_by_feature) ? row.totals_by_feature : [];
    for (const f of features) {
      const name = String(f?.feature || "").toLowerCase();
      if (name) u.features_used.add(name);
      if (name.includes("chat")) u.chat_interactions += Number(f?.user_initiated_interaction_count) || 0;
    }
  }

  const users = Array.from(byUser.values()).map((u) => ({
    user_login: u.user_login,
    user_id: u.user_id,
    lines_accepted: u.loc_added_sum,
    lines_deleted: u.loc_deleted_sum,
    lines_suggested: u.loc_suggested_to_add_sum,
    acceptance_rate: u.code_generation_activity_count > 0
      ? Math.round((u.code_acceptance_activity_count / u.code_generation_activity_count) * 100) / 100
      : null,
    code_accepts: u.code_acceptance_activity_count,
    code_generations: u.code_generation_activity_count,
    active_days: u.active_days,
    used_chat: u.used_chat,
    used_agent: u.used_agent,
    used_cli: u.used_cli,
    chat_interactions: u.chat_interactions,
    features_used: [...u.features_used],
  }));

  users.sort((a, b) => (b.lines_accepted || 0) - (a.lines_accepted || 0));
  return users.slice(0, COPILOT_USER_LEADERBOARD_TOP_N);
}

/**
 * Top-level entry. Writes `output/copilotdata.json` and never throws — error
 * details land in the JSON file so the dashboard can show a clean banner.
 */
export async function getCopilotData() {
  const token = process.env.GITHUB_TOKEN;
  const ent = process.env.ENT;

  console.log("--- Starting Copilot metrics fetch ---");

  if (!token || !ent) {
    console.warn("[Copilot] Skipped: missing GITHUB_TOKEN or ENT in .env");
    return;
  }

  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    let enterpriseData;
    try {
      enterpriseData = await fetchCopilotReportRows(ent);
    } catch (err) {
      if (err.status === 401) {
        console.warn("[Copilot] Token expired or invalid (401).");
        writeFileSync(OUTPUT_FILE, JSON.stringify({ error: "GitHub token expired or invalid", status: 401 }, null, 2));
        return;
      }
      if (err.status === 403) {
        console.warn("[Copilot] Insufficient permissions (403) — token needs manage_billing:copilot or read:enterprise scope and enterprise access.");
        writeFileSync(OUTPUT_FILE, JSON.stringify({ error: "Insufficient permissions — token needs manage_billing:copilot or read:enterprise scope and enterprise access", status: 403 }, null, 2));
        return;
      }
      if (err.status === 404) {
        console.warn("[Copilot] Enterprise report not found (404) — check ENT value and Copilot usage metrics availability.");
        writeFileSync(OUTPUT_FILE, JSON.stringify({ error: "Enterprise report not found — check ENT value and Copilot usage metrics availability", status: 404 }, null, 2));
        return;
      }
      throw err;
    }

    console.log("[Copilot] Success: fetched", enterpriseData.length, "normalized daily rows at Enterprise Level (" + ent + ").");

    let userLeaderboard = [];
    try {
      const userDayRows = await fetchCopilotUserReportRows(ent);
      if (userDayRows.length > 0) {
        userLeaderboard = aggregateCopilotUserRows(userDayRows);
        console.log("[Copilot] User-level report: aggregated", userLeaderboard.length, "users from", userDayRows.length, "user-day rows.");
      } else {
        console.log("[Copilot] User-level report: no data returned (may require \"Copilot usage metrics\" policy enabled).");
      }
    } catch (err) {
      console.warn("[Copilot] User-level report fetch failed (non-fatal):", err.message);
    }

    const output = {
      lastSync: new Date().toISOString(),
      period: "28d",
      enterprise: enterpriseData,
      userLeaderboard,
    };

    writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");
    console.log("[Copilot] Written:", OUTPUT_FILE);
  } catch (err) {
    console.error("[Copilot] Error:", err.message);
    try {
      mkdirSync(OUTPUT_DIR, { recursive: true });
      writeFileSync(OUTPUT_FILE, JSON.stringify({ error: err.message }, null, 2));
    } catch (e) {
      console.warn("[Copilot] Could not write error file:", e.message);
    }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  getCopilotData();
}
