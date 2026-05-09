/**
 * cycle-time-analysis.js
 *
 * Standalone exploration script — reads projects from jira-md-export/projects.json,
 * fetches JIRA tickets resolved in the last 60 days per project, and computes
 * cycle time statistics (avg, stddev, percentiles) to recommend optimised colour-band
 * thresholds for the dashboard.
 *
 * Run from the test/ folder:
 *   npm install
 *   node cycle-time-analysis.js
 *
 * Env vars: ../.env (canonical Product/.env); merged with jira-md-export/.env when both exist (Product wins).
 *   JIRA_EMAIL, JIRA_TOKEN, JIRA_DOMAIN
 */

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const productEnv = path.join(__dirname, "..", ".env");
const jiraEnv = path.join(__dirname, "..", "jira-md-export", ".env");
const hasJira = fs.existsSync(jiraEnv);
const hasProduct = fs.existsSync(productEnv);
if (hasJira && hasProduct) {
  dotenv.config({ path: productEnv, override: false });
  dotenv.config({ path: jiraEnv, override: true });
} else if (hasJira) {
  dotenv.config({ path: jiraEnv });
} else {
  dotenv.config({ path: productEnv });
}

// --- Config -------------------------------------------------------------------

const JIRA_EMAIL  = process.env.JIRA_EMAIL;
const JIRA_TOKEN  = process.env.JIRA_TOKEN;
const JIRA_DOMAIN = process.env.JIRA_DOMAIN;

if (!JIRA_EMAIL || !JIRA_TOKEN || !JIRA_DOMAIN) {
  console.error("?  Missing JIRA_EMAIL, JIRA_TOKEN, or JIRA_DOMAIN in .env");
  process.exit(1);
}

const BASE_URL = `https://${JIRA_DOMAIN}`;
const AUTH     = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64");
const HEADERS  = {
  Authorization: `Basic ${AUTH}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

// Days to look back for resolved tickets
const LOOKBACK_DAYS = 30;

// Statuses the user confirmed are "done" / complete
const DONE_STATUSES = new Set([
  "ready for staging",
  "staging",
  "ready for release",
  "cancelled",
  "closed",
]);

// Concurrent changelog fetch limit
const CONCURRENCY = 20;

// --- JIRA helpers -------------------------------------------------------------

async function jiraGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: HEADERS });
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10) * 1000 + 300;
    console.warn(`  ?  Rate limited — waiting ${retryAfter}ms…`);
    await sleep(retryAfter);
    return jiraGet(path);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`JIRA ${path} ? HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Paginated JQL search — returns all matching issues (key + fields only).
 *  Uses POST /rest/api/3/search/jql (new Atlassian API).
 *  Paginates via nextPageToken (replaces deprecated startAt).
 */
async function searchJQL(jql, fields = "summary,status,resolutiondate") {
  const issues = [];
  const maxResults = 100;
  let nextPageToken = undefined;

  while (true) {
    const body = {
      jql,
      maxResults,
      fields: fields.split(",").map(f => f.trim()),
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await fetch(`${BASE_URL}/rest/api/3/search/jql`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10) * 1000 + 300;
      console.warn(`  ?  Rate limited — waiting ${retryAfter}ms…`);
      await sleep(retryAfter);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`JIRA POST /rest/api/3/search/jql ? HTTP ${res.status}: ${text.slice(0, 400)}`);
    }

    const data = await res.json();
    const page = data.issues || [];
    issues.push(...page);

    // New API returns nextPageToken when there are more results
    if (data.nextPageToken && page.length === maxResults) {
      nextPageToken = data.nextPageToken;
    } else {
      break;
    }
  }
  return issues;
}

/** Fetch a single issue with full changelog. */
async function fetchChangelog(key) {
  return jiraGet(`/rest/api/3/issue/${key}?expand=changelog&fields=summary,status,resolutiondate`);
}

/** Run up to `limit` async tasks concurrently, with periodic progress logging. */
async function pLimit(tasks, limit, progressLabel) {
  const results = [];
  let idx = 0;
  let done = 0;
  const total = tasks.length;
  const reportEvery = Math.max(1, Math.floor(total / 10)); // report ~10 times

  async function run() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
      done++;
      if (progressLabel && done % reportEvery === 0) {
        process.stdout.write(`\r   ${progressLabel}: ${done}/${total}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, run);
  await Promise.all(workers);
  if (progressLabel) process.stdout.write(`\r   ${progressLabel}: ${total}/${total}\n`);
  return results;
}

// --- Stage helpers ------------------------------------------------------------

/**
 * Parse startStage / endStage strings from project config into Sets.
 * Comma-separated, lowercased, trimmed.
 */
function parseStageSets(project) {
  const parse = (val) => {
    if (!val || String(val).trim() === "") return null;
    const tokens = String(val).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    return tokens.length ? new Set(tokens) : null;
  };

  const startStages = parse(project.startStage) ?? new Set(["ready for dev", "in progress", "in development"]);

  // endStages = project.endStage PLUS all "beyond" statuses (Staging, Ready for Release, Cancelled, Closed).
  // We always union with DONE_STATUSES so tickets that skip directly to a later stage are still captured.
  const parsedEnd = parse(project.endStage);
  const endStages = parsedEnd ? new Set([...parsedEnd, ...DONE_STATUSES]) : DONE_STATUSES;

  return { startStages, endStages };
}

/**
 * Compute cycle time (days) for a single JIRA issue with changelog.
 * startStages ? first transition into any of these    ? startTime
 * endStages   ? first transition into any of these    ? endTime  (must be AFTER startTime)
 *
 * Returns null if we can't find both transitions.
 */
function computeCycleTime(issue, startStages, endStages) {
  const histories = issue.changelog?.histories;
  if (!histories || histories.length === 0) return null;

  const sorted = [...histories].sort((a, b) => new Date(a.created) - new Date(b.created));

  let startTime = null;
  let endTime   = null;

  for (const history of sorted) {
    for (const item of history.items || []) {
      if (item.field !== "status") continue;

      const toStatus = (item.toString || "").toLowerCase().trim();

      if (!startTime && startStages.has(toStatus)) {
        startTime = new Date(history.created);
      }

      if (startTime && !endTime && endStages.has(toStatus)) {
        endTime = new Date(history.created);
      }
    }
  }

  if (startTime && endTime) {
    return (endTime - startTime) / (1000 * 60 * 60 * 24);
  }

  // Fallback: if we have a startTime and a resolutiondate, use that
  if (startTime && issue.fields?.resolutiondate) {
    const rd = new Date(issue.fields.resolutiondate);
    if (rd > startTime) {
      return (rd - startTime) / (1000 * 60 * 60 * 24);
    }
  }

  return null;
}

// --- Statistics ---------------------------------------------------------------

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr, avg) {
  const m = avg ?? mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stats(cycleTimes) {
  if (cycleTimes.length === 0) return null;
  const sorted = [...cycleTimes].sort((a, b) => a - b);
  const avg    = mean(sorted);
  return {
    n:      sorted.length,
    avg:    avg,
    stddev: stddev(sorted, avg),
    min:    sorted[0],
    p25:    percentile(sorted, 25),
    median: percentile(sorted, 50),
    p75:    percentile(sorted, 75),
    p90:    percentile(sorted, 90),
    max:    sorted[sorted.length - 1],
  };
}

// --- Output helpers -----------------------------------------------------------

function fmt(n, dp = 1) {
  return n == null ? "  —  " : n.toFixed(dp);
}

function band(days, elite, strong, poor) {
  if (days <= elite) return "?? Elite";
  if (days <= strong) return "?? Strong";
  if (days < poor)   return "?? At Risk";
  return "?? Poor";
}

function printProjectTable(project, s) {
  if (!s) {
    console.log(`  ${project.name.padEnd(18)} — no data (0 tickets with valid cycle times in 60 days)`);
    return;
  }
  console.log(`\n  Project : ${project.name} (${project.key})`);
  console.log(`  Manager : ${project.manager}`);
  console.log(`  Stages  : "${project.startStage}" ? "${project.endStage}"`);
  console.log(`  +---------------------------------------------------------+`);
  console.log(`  ¦  N tickets : ${String(s.n).padEnd(42)}¦`);
  console.log(`  ¦  Average   : ${fmt(s.avg, 2).padEnd(8)} days${" ".repeat(34)}¦`);
  console.log(`  ¦  Std Dev   : ${fmt(s.stddev, 2).padEnd(8)} days${" ".repeat(34)}¦`);
  console.log(`  ¦  Min       : ${fmt(s.min, 2).padEnd(8)} days${" ".repeat(34)}¦`);
  console.log(`  ¦  P25       : ${fmt(s.p25, 2).padEnd(8)} days${" ".repeat(34)}¦`);
  console.log(`  ¦  Median    : ${fmt(s.median, 2).padEnd(8)} days${" ".repeat(34)}¦`);
  console.log(`  ¦  P75       : ${fmt(s.p75, 2).padEnd(8)} days${" ".repeat(34)}¦`);
  console.log(`  ¦  P90       : ${fmt(s.p90, 2).padEnd(8)} days${" ".repeat(34)}¦`);
  console.log(`  ¦  Max       : ${fmt(s.max, 2).padEnd(8)} days${" ".repeat(34)}¦`);
  console.log(`  +---------------------------------------------------------+`);
  console.log(`  Current band (avg, vs METRICS.md): ${band(s.avg, 1.5, 2.5, 5)}`);
}

function printRecommendations(allCycleTimes, projectResults, projects) {
  const agg = stats(allCycleTimes);

  console.log("\n");
  console.log("----------------------------------------------------------------");
  console.log("  RECOMMENDATIONS — Data-driven Threshold Optimisation");
  console.log("----------------------------------------------------------------");

  console.log("\n  -- Aggregate across all projects (last 60 days) --");
  if (!agg) {
    console.log("  No data available.");
    return;
  }
  console.log(`  Total tickets analysed : ${agg.n}`);
  console.log(`  Overall average        : ${fmt(agg.avg, 2)} days`);
  console.log(`  Overall std dev        : ${fmt(agg.stddev, 2)} days`);
  console.log(`  P25 (Elite candidate)  : ${fmt(agg.p25, 2)} days`);
  console.log(`  P50 / Median           : ${fmt(agg.median, 2)} days`);
  console.log(`  P75 (At-Risk boundary) : ${fmt(agg.p75, 2)} days`);
  console.log(`  P90 (Poor boundary)    : ${fmt(agg.p90, 2)} days`);

  // Proposed thresholds (rounded to 1 dp)
  const proposed_elite  = Math.round(agg.p25  * 10) / 10;
  const proposed_strong = Math.round(agg.median * 10) / 10;
  const proposed_atrisk = Math.round(agg.p75  * 10) / 10;
  const proposed_poor   = Math.round(agg.p90  * 10) / 10;

  console.log("\n  -- Current METRICS.md Thresholds --");
  console.log("  ?? Elite  : = 1.5 days");
  console.log("  ?? Strong : = 2.5 days");
  console.log("  ?? At Risk: > 2.5 days (implied)");
  console.log("  ?? Poor   : = 5.0 days");

  console.log("\n  -- Proposed Data-driven Thresholds (based on actual distribution) --");
  console.log(`  ?? Elite  : = ${fmt(proposed_elite,  1)} days  (P25 — top quarter of tickets)`);
  console.log(`  ?? Strong : = ${fmt(proposed_strong, 1)} days  (P50 — median, achievable half the time)`);
  console.log(`  ?? At Risk: = ${fmt(proposed_atrisk, 1)} days  (P75 — starting to lag)`);
  console.log(`  ?? Poor   : > ${fmt(proposed_atrisk, 1)} days  (above P75 — needs attention)`);

  // Delta commentary
  const eliteDelta  = proposed_elite  - 1.5;
  const strongDelta = proposed_strong - 2.5;
  const poorDelta   = proposed_poor   - 5.0;

  console.log("\n  -- Delta vs Current --");
  console.log(`  Elite  threshold : ${eliteDelta >= 0 ? "+" : ""}${fmt(eliteDelta, 1)} days  ${eliteDelta < 0 ? "? tighter (teams are fast!)" : "? looser (teams take more time)"}`);
  console.log(`  Strong threshold : ${strongDelta >= 0 ? "+" : ""}${fmt(strongDelta, 1)} days  ${strongDelta < 0 ? "? tighter" : "? looser"}`);
  console.log(`  Poor threshold   : ${poorDelta >= 0 ? "+" : ""}${fmt(poorDelta, 1)} days  (P90 vs current =5 d boundary)`);

  // Per-project summary table
  console.log("\n  -- Per-Project Summary --");
  console.log("  " + "Project".padEnd(20) + "Avg".padEnd(8) + "StdDev".padEnd(10) + "Median".padEnd(10) + "P90".padEnd(8) + "N".padEnd(6) + "Band (current thresholds)");
  console.log("  " + "-".repeat(80));
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    const s = projectResults[i];
    if (!s) {
      console.log("  " + p.name.padEnd(20) + "—".padEnd(8) + "—".padEnd(10) + "—".padEnd(10) + "—".padEnd(8) + "0".padEnd(6) + "No data");
      continue;
    }
    const b = band(s.avg, 1.5, 2.5, 5);
    console.log(
      "  " +
      p.name.padEnd(20) +
      fmt(s.avg, 2).padEnd(8) +
      fmt(s.stddev, 2).padEnd(10) +
      fmt(s.median, 2).padEnd(10) +
      fmt(s.p90, 2).padEnd(8) +
      String(s.n).padEnd(6) +
      b
    );
  }

  console.log("\n  -- Interpretation --");
  console.log("  The proposed thresholds reflect what your teams ACTUALLY achieve.");
  console.log("  Setting Elite = P25 means ~25% of tickets already hit this bar.");
  console.log("  Setting Strong = Median means 50% of tickets are at or below this.");
  console.log("  If the current 1.5d Elite is rarely hit, it may demotivate teams.");
  console.log("  Use proposed thresholds to make the colour bands meaningful and motivating.");
  console.log("\n  -- Caveat --");
  console.log("  Cycle time here = first entry into startStage ? first entry into endStage.");
  console.log("  Tickets cancelled before reaching dev are excluded (no startTime found).");
  console.log("  Outliers (very large values) can skew averages — check P90 vs avg spread.");
  console.log("----------------------------------------------------------------\n");
}

// --- Main ---------------------------------------------------------------------

async function main() {
  // Load projects
  const projectsPath = path.join(__dirname, "..", "jira-md-export", "projects.json");
  const { projects: allProjects } = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
  const projects = allProjects.filter(p => p.active !== false);

  const lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - LOOKBACK_DAYS);
  const lookbackStr = lookbackDate.toISOString().split("T")[0]; // YYYY-MM-DD

  console.log("----------------------------------------------------------------");
  console.log("  JIRA Cycle Time Analysis — Last 60 Days");
  console.log(`  Domain  : ${JIRA_DOMAIN}`);
  console.log(`  From    : ${lookbackStr}  To: ${new Date().toISOString().split("T")[0]}`);
  console.log(`  Projects: ${projects.length} active`);
  console.log("----------------------------------------------------------------\n");

  const allCycleTimes    = [];
  const projectResults   = [];

  for (const project of projects) {
    const { startStages, endStages } = parseStageSets(project);

    console.log(`\n?  ${project.name} (${project.key}) — fetching resolved tickets…`);

    // JQL: tickets that have entered a "done" status within the lookback window
    const jql = [
      `project = "${project.key}"`,
      `status in ("Ready For Staging","Staging","Ready For Release","Cancelled","Closed")`,
      `updated >= "${lookbackStr}"`,
    ].join(" AND ") + " ORDER BY updated DESC";

    let issues;
    try {
      issues = await searchJQL(jql, "summary,status,resolutiondate");
    } catch (err) {
      console.error(`  ?  Failed to fetch issues for ${project.key}: ${err.message}`);
      projectResults.push(null);
      continue;
    }

    console.log(`   Found ${issues.length} candidate ticket(s) — fetching changelogs…`);

    if (issues.length === 0) {
      projectResults.push(null);
      continue;
    }

    // Fetch changelogs concurrently (up to CONCURRENCY at a time)
    const tasks = issues.map(issue => () => fetchChangelog(issue.key).catch(err => {
      console.warn(`  ?   Could not fetch changelog for ${issue.key}: ${err.message}`);
      return null;
    }));

    const detailed = await pLimit(tasks, CONCURRENCY, `changelogs`);

    // Compute cycle times
    const cycleTimes = [];
    for (const issue of detailed) {
      if (!issue) continue;
      const ct = computeCycleTime(issue, startStages, endStages);
      if (ct !== null && ct >= 0) {
        cycleTimes.push(ct);
      }
    }

    console.log(`   Valid cycle times: ${cycleTimes.length} / ${issues.length}`);

    const s = stats(cycleTimes);
    projectResults.push(s);
    allCycleTimes.push(...cycleTimes);

    printProjectTable(project, s);
  }

  // Recommendations
  printRecommendations(allCycleTimes, projectResults, projects);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
