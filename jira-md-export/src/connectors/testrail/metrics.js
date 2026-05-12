/**
 * TestRail QA metrics fetcher.
 *
 * Returns project-level authorship summary (cases / runs / plans created),
 * automation coverage snapshot, and per-QA-person breakdown for the supplied
 * sprint window. Drives section 2.6 / 2.7 of every sprint markdown file.
 *
 * User resolution priority (highest ? lowest):
 *   1. Explicit `testRailUserId` map  — `resource-directory.json` rows with
 *      a non-empty `testRailUserId` (run `npm run sync:testrail-users`).
 *   2. Email match                    — TR user email vs JIRA RD email.
 *   3. Email-prefix match             — `firstname.lastname@…` ? JIRA name
 *      tokens (handles role-style TR names like "QA").
 *   4. Fuzzy name token match         — last resort; skipped for single-token
 *      names like "QA"/"Admin" that would over-match.
 *   5. Raw TestRail name              — fallback so the row is still visible.
 */

import fs from "fs";
import { OUTPUT_DIR, resource_DIRECTORY_JSON, TESTRAIL_USERS_JSON } from "../../core/paths.js";
import { testRailGetJson } from "./request.js";
import path from "path";

const TESTRAIL_DOMAIN = process.env.TESTRAIL_DOMAIN;
const TESTRAIL_EMAIL = process.env.TESTRAIL_EMAIL;
const TESTRAIL_API_KEY = process.env.TESTRAIL_API_KEY;

const baseUrl = TESTRAIL_DOMAIN ? `https://${TESTRAIL_DOMAIN}/index.php?/api/v2` : null;
const authHeader = TESTRAIL_EMAIL && TESTRAIL_API_KEY
  ? `Basic ${Buffer.from(`${TESTRAIL_EMAIL}:${TESTRAIL_API_KEY}`).toString("base64")}`
  : null;

const headers = authHeader
  ? { Authorization: authHeader, "Content-Type": "application/json" }
  : {};

/** TR users cache is treated as authoritative if younger than this; otherwise a fresh API sweep runs. */
export const TESTRAIL_USERS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** True when `output/testrail-users.json` exists and is younger than `TESTRAIL_USERS_MAX_AGE_MS`. */
function isTestRailUsersCacheFresh() {
  try {
    if (!fs.existsSync(TESTRAIL_USERS_JSON)) return false;
    const tu = JSON.parse(fs.readFileSync(TESTRAIL_USERS_JSON, "utf8"));
    const fetchedAt = tu.fetchedAt ? new Date(tu.fetchedAt).getTime() : 0;
    return Number.isFinite(fetchedAt) && fetchedAt > 0 && (Date.now() - fetchedAt) < TESTRAIL_USERS_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/** One-shot cache for `loadresourceLookupMaps` — same files on disk, no need to re-read per sprint. */
let cachedLookupMaps = null;

/**
 * Load two lookup maps from `resource-directory.json` and pre-fill `userCache`
 * from `testrail-users.json`. Idempotent: first call reads both files,
 * subsequent calls return the same map refs without re-reading.
 *
 *   trIdToDisplayName : Map<number, string>  TR user ID ? JIRA displayName
 *   emailToDisplayName: Map<string, string>  lowercase email ? JIRA displayName
 */
function loadresourceLookupMaps() {
  if (cachedLookupMaps) return cachedLookupMaps;

  const trIdToDisplayName = new Map();
  const emailToDisplayName = new Map();
  try {
    if (fs.existsSync(resource_DIRECTORY_JSON)) {
      const j = JSON.parse(fs.readFileSync(resource_DIRECTORY_JSON, "utf8"));
      for (const u of j.users || []) {
        const displayName = String(u.displayName || "").trim();
        if (!displayName) continue;
        // ID map (only when testRailUserId is explicitly set)
        const id = u.testRailUserId;
        if (id != null && id !== "") trIdToDisplayName.set(Number(id), displayName);
        // Email map (always, for automatic matching)
        const email = String(u.email || "").toLowerCase().trim();
        if (email) emailToDisplayName.set(email, displayName);
      }
    }
  } catch { /* silent — maps stay empty */ }

  // Hard cache: pre-populate userCache from testrail-users.json so per-user
  // get_user/{id} calls are skipped during the run.
  try {
    if (fs.existsSync(TESTRAIL_USERS_JSON)) {
      const tu = JSON.parse(fs.readFileSync(TESTRAIL_USERS_JSON, "utf8"));
      let cached = 0;
      for (const u of tu.users || []) {
        if (!u.id) continue;
        if (!userCache.has(u.id)) {
          userCache.set(u.id, { name: u.name || "", email: u.email || "" });
          cached++;
        }
        // Also add their email to the lookup map if not already present
        const em = String(u.email || "").toLowerCase().trim();
        if (em && !emailToDisplayName.has(em) && u.name) {
          emailToDisplayName.set(em, u.name);
        }
      }
      if (cached > 0) {
        const ageMs = tu.fetchedAt ? (Date.now() - new Date(tu.fetchedAt).getTime()) : null;
        const ageStr = ageMs != null && Number.isFinite(ageMs) ? ` (age: ${Math.round(ageMs / (60 * 60 * 1000))}h)` : "";
        console.log(`  TestRail: loaded ${cached} users from testrail-users.json cache${ageStr}`);
      }
    }
  } catch { /* silent — cache file missing or malformed */ }

  cachedLookupMaps = { trIdToDisplayName, emailToDisplayName };
  return cachedLookupMaps;
}

/**
 * Tokenize a display name into lowercase words = 3 chars; strip suffixes like
 * `(IDC)`, `(c)`. Returns `[]` for generic single-token names ("QA", "Admin")
 * so they can't accidentally over-match.
 */
function nameTokens(name) {
  const cleaned = String(name || "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/[^a-zA-Z\s]/g, " ")
    .trim()
    .toLowerCase();
  return cleaned.split(/\s+/).filter((t) => t.length >= 3);
}

/**
 * Core token-overlap matcher. Given a Set of candidate tokens, find the best
 * JIRA displayName from `emailToDisplayName`. Returns the displayName when
 * =2 tokens overlap, else null.
 */
function fuzzyMatchTokenSet(tokenSet, emailToDisplayName) {
  if (!tokenSet || tokenSet.size < 2) return null;
  let bestName = null;
  let bestOverlap = 0;
  for (const jiraName of emailToDisplayName.values()) {
    const jiraTokens = nameTokens(jiraName);
    if (jiraTokens.length < 2) continue;
    let overlap = 0;
    for (const t of jiraTokens) {
      if (tokenSet.has(t)) overlap++;
    }
    if (overlap >= 2 && overlap > bestOverlap) {
      bestOverlap = overlap;
      bestName = jiraName;
    }
  }
  return bestName;
}

/** Try to fuzzy-match a TestRail display name against JIRA display names. */
function fuzzyMatchName(trName, emailToDisplayName) {
  const tokens = nameTokens(trName);
  return fuzzyMatchTokenSet(new Set(tokens), emailToDisplayName);
}

/**
 * Tier 2.5: derive name tokens from email prefix. Catches accounts where the
 * TestRail `name` is set to a generic role label ("QA", "EHR A") but the
 * email is a personal `firstname.lastname@VeloSync.com` address.
 */
function fuzzyMatchFromEmail(email, emailToDisplayName) {
  if (!email) return null;
  const prefix = email.split("@")[0]; // "harbinder.singh"
  const tokens = prefix
    .split(/[\.\-\_]/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3);
  return fuzzyMatchTokenSet(new Set(tokens), emailToDisplayName);
}

/** User ID ? `{name, email}` cache shared across all calls in one run. */
const userCache = new Map();
/** Set of project IDs whose users have already been pre-fetched. */
const userPreloadedProjects = new Set();
/** Whether the global `get_users` (no project scope) has been attempted. */
let globalUserPreloadDone = false;
/** True when this run fetched fresh user data; triggers `saveUserCache()` at the end. */
let userCacheDirty = false;

/**
 * Automation coverage cache: projectId ? coverage object.
 *
 * `fetchAllCases` is a snapshot (not sprint-scoped) — fetched ONCE per project
 * per run. Eliminates 36+ repeated paginated calls when `getTestRailMetrics`
 * is invoked for multiple sprints of the same project (current + prev × N
 * sprint files = many repeats).
 */
const automationCoverageCache = new Map();

/** Automation type dropdown values (from `get_case_fields` exploration). */
const AUTOMATION_TYPE_LABELS = {
  0: "None", 1: "C#/Backend", 2: "Ts/FrontEnd", 3: "API",
  4: "Java", 5: "Windows", 6: "Performance",
};

async function trGet(endpoint, rateLimitRetries = 4) {
  if (!baseUrl) throw new Error("TestRail not configured");
  return testRailGetJson(`${baseUrl}/${endpoint}`, headers, endpoint, { rateLimitRetries });
}

/**
 * Pre-fetch ALL users visible to this API account in one call (admin-only
 * endpoint). Called once per run before any per-user resolution. Populates
 * `userCache` so later `get_user/{id}` calls are only needed for users
 * outside this account's visibility.
 *
 * Skipped when `output/testrail-users.json` is fresh —
 * `loadresourceLookupMaps()` already populated `userCache` from that file.
 */
async function preloadAllUsers() {
  if (globalUserPreloadDone) return;
  globalUserPreloadDone = true;
  if (isTestRailUsersCacheFresh()) {
    return;
  }
  try {
    const data = await trGet(`get_users`);
    const users = Array.isArray(data) ? data : (data.users ?? []);
    let added = 0;
    for (const u of users) {
      if (u.id && !userCache.has(u.id)) {
        userCache.set(u.id, { name: u.name || u.email || `QA Tester #${u.id}`, email: u.email || "" });
        added++;
      }
    }
    if (added > 0) userCacheDirty = true;
    if (users.length > 0) console.log(`  TestRail: pre-loaded ${users.length} users into cache (fresh API fetch)`);
  } catch {
    // Non-admin accounts can't call get_users without a project scope — fall
    // through to per-project preload.
  }
}

/**
 * Persist the current `userCache` to `output/testrail-users.json` only when
 * fresh data was fetched during this run (`userCacheDirty`). Otherwise the
 * existing cache file's `fetchedAt` stays accurate and repeated sprint calls
 * don't spam disk I/O.
 */
function saveUserCache() {
  if (!userCacheDirty) return;
  try {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const users = [...userCache.entries()]
      .map(([id, u]) => ({ id, name: u.name || "", email: u.email || "" }))
      .sort((a, b) => a.id - b.id);
    const data = { fetchedAt: new Date().toISOString(), total: users.length, users };
    fs.writeFileSync(TESTRAIL_USERS_JSON, JSON.stringify(data, null, 2), "utf8");
    console.log(`  TestRail: cached ${users.length} users ? ${path.relative(process.cwd(), TESTRAIL_USERS_JSON)}`);
    userCacheDirty = false;
  } catch { /* silent */ }
}

/** Pre-fetch users scoped to a project (fills gaps for non-admin accounts). */
async function preloadProjectUsers(projectId) {
  if (userPreloadedProjects.has(projectId)) return;
  userPreloadedProjects.add(projectId);
  if (isTestRailUsersCacheFresh()) return;
  try {
    const data = await trGet(`get_users/${projectId}`);
    const users = Array.isArray(data) ? data : (data.users ?? []);
    let added = 0;
    for (const u of users) {
      if (u.id && !userCache.has(u.id)) {
        userCache.set(u.id, { name: u.name || u.email || `QA Tester #${u.id}`, email: u.email || "" });
        added++;
      }
    }
    if (added > 0) userCacheDirty = true;
  } catch { /* non-admin or no project-scoped users */ }
}

async function resolveUser(userId, trIdToDisplayName, emailToDisplayName) {
  if (!userId) return { name: "Unassigned", email: "" };
  let base;
  if (userCache.has(userId)) {
    base = userCache.get(userId);
  } else {
    try {
      const u = await trGet(`get_user/${userId}`);
      base = { name: u.name || u.email || `QA Tester #${userId}`, email: u.email || "" };
    } catch {
      base = { name: `QA Tester #${userId}`, email: "" };
    }
    userCache.set(userId, base);
    userCacheDirty = true; // new user fetched live — persist on next saveUserCache()
  }

  // Tier 1: explicit testRailUserId mapping
  const byId = trIdToDisplayName && trIdToDisplayName.get(userId);
  if (byId && String(byId).trim()) return { name: String(byId).trim(), email: base.email };

  // Tier 2: exact email match against Jira resource-directory
  const emailKey = (base.email || "").toLowerCase().trim();
  const byEmail = emailKey && emailToDisplayName && emailToDisplayName.get(emailKey);
  if (byEmail && String(byEmail).trim()) return { name: String(byEmail).trim(), email: base.email };

  // Tier 2.5: derive name from email prefix (e.g. harbinder.singh@VeloSync.com ? "Harbinder Singh (IDC)")
  // Catches accounts where TestRail name is a role label like "QA" but email is personal.
  const byEmailPrefix = emailKey && emailToDisplayName && fuzzyMatchFromEmail(emailKey, emailToDisplayName);
  if (byEmailPrefix) return { name: byEmailPrefix, email: base.email };

  // Tier 3: fuzzy name token match (skipped for single-token names like "QA")
  const byFuzzy = emailToDisplayName && fuzzyMatchName(base.name, emailToDisplayName);
  if (byFuzzy) return { name: byFuzzy, email: base.email };

  // Tier 4: raw TestRail name — log so we can diagnose unresolved accounts.
  console.log(`  TestRail: unresolved user #${userId} — name="${base.name}" email="${base.email || "(none)"}" (add to resource-directory or run sync:testrail-users)`);
  return { name: base.name, email: base.email };
}

/**
 * Paginate `get_cases`, handling both single-suite and multi-suite project
 * modes. Suite-mode projects (type=2) return 400 without `suite_id`, so we
 * try without first, then fall back to fetching suites and iterating.
 */
async function fetchAllCases(projectId) {
  const allCases = [];

  const fetchPage = async (endpoint) => {
    const cases = [];
    let offset = 0;
    const limit = 250;
    for (;;) {
      const sep = endpoint.includes("&") ? "&" : "&";
      const data = await trGet(`${endpoint}${sep}limit=${limit}&offset=${offset}`);
      const batch = data.cases ?? data;
      if (!Array.isArray(batch)) break;
      cases.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
      if (offset > 50000) break;
    }
    return cases;
  };

  try {
    const cases = await fetchPage(`get_cases/${projectId}`);
    return cases;
  } catch (e) {
    if (!String(e.message).includes("400")) throw e;
  }

  // Suite-mode fallback
  try {
    const suitesData = await trGet(`get_suites/${projectId}`);
    const suites = Array.isArray(suitesData) ? suitesData : (suitesData.suites ?? []);
    for (const s of suites) {
      try {
        const cases = await fetchPage(`get_cases/${projectId}&suite_id=${s.id}`);
        allCases.push(...cases);
      } catch { /* skip inaccessible suite */ }
    }
  } catch { /* no suites accessible */ }

  return allCases;
}

/**
 * Paginate `get_cases` filtered by `created_after` / `created_before` to
 * count cases authored during the sprint window. Same single-suite vs
 * suite-mode handling as `fetchAllCases`.
 */
async function fetchCasesCreatedInWindow(projectId, startTs, endTs) {
  const allCases = [];
  const dateFilters = [];
  if (startTs) dateFilters.push(`created_after=${startTs}`);
  if (endTs) dateFilters.push(`created_before=${endTs}`);
  const filterStr = dateFilters.length ? "&" + dateFilters.join("&") : "";

  const fetchPage = async (endpoint) => {
    const cases = [];
    let offset = 0;
    const limit = 250;
    for (;;) {
      const data = await trGet(`${endpoint}&limit=${limit}&offset=${offset}`);
      const batch = data.cases ?? data;
      if (!Array.isArray(batch)) break;
      cases.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
      if (offset > 50000) break;
    }
    return cases;
  };

  try {
    return await fetchPage(`get_cases/${projectId}${filterStr}`);
  } catch (e) {
    if (!String(e.message).includes("400")) throw e;
  }

  // Suite-mode fallback
  try {
    const suitesData = await trGet(`get_suites/${projectId}`);
    const suites = Array.isArray(suitesData) ? suitesData : (suitesData.suites ?? []);
    for (const s of suites) {
      try {
        const cases = await fetchPage(`get_cases/${projectId}&suite_id=${s.id}${filterStr}`);
        allCases.push(...cases);
      } catch { /* skip inaccessible suite */ }
    }
  } catch { /* no suites accessible */ }

  return allCases;
}

/**
 * Fetch TestRail metrics for one or more TestRail project IDs within a sprint
 * window.
 *
 * @param {number[]} projectIds  TestRail project IDs.
 * @param {string}   startDate   Sprint start `YYYY-MM-DD`.
 * @param {string}   endDate     Sprint end `YYYY-MM-DD`.
 * @returns {Promise<{summary, automation, casesCreated, runsCreated, plansCreated, byPerson}>}
 */
export async function getTestRailMetrics(projectIds, startDate, endDate) {
  const empty = {
    automation: { totalCases: 0, automated: 0, automationPct: "N/A", inProgress: 0, notStarted: 0, byType: {}, manualOnly: 0, manualPct: "N/A" },
    casesCreated: 0,
    runsCreated: 0,
    plansCreated: 0,
    byPerson: [],
  };

  if (!baseUrl || !authHeader) {
    console.log("  TestRail: not configured (missing env vars) — skipping");
    return empty;
  }
  if (!Array.isArray(projectIds) || projectIds.length === 0) {
    return empty;
  }

  const startTs = startDate ? Math.floor(new Date(startDate).getTime() / 1000) : null;
  const endTs = endDate ? Math.floor(new Date(endDate + "T23:59:59").getTime() / 1000) : null;

  const { trIdToDisplayName, emailToDisplayName } = loadresourceLookupMaps();

  // Global user preload (admin: one call returns all users with emails;
  // non-admin: silently skipped). Done once per process so repeated sprint
  // calls don't re-fetch.
  await preloadAllUsers();

  let totalRuns = 0;
  let totalCasesCreated = 0, totalPlansCreated = 0;
  const casesCreatedByPerson = new Map();
  const runsCreatedByPerson = new Map();
  const plansCreatedByPerson = new Map();

  // Automation coverage (snapshot, merged across projects).
  let totalCases = 0, automatedCases = 0, inProgressCases = 0, notStartedCases = 0;
  const autoByType = {};

  for (const projId of projectIds) {
    await preloadProjectUsers(projId);

    // -- 1. Runs in sprint window --
    try {
      let runsEndpoint = `get_runs/${projId}`;
      const filters = [];
      if (startTs) filters.push(`created_after=${startTs}`);
      if (endTs) filters.push(`created_before=${endTs}`);
      filters.push("limit=250");
      runsEndpoint += "&" + filters.join("&");

      const runsData = await trGet(runsEndpoint);
      const runs = runsData.runs ?? runsData;
      if (!Array.isArray(runs)) continue;

      totalRuns += runs.length;

      // Track who created each run (created_by = named QA engineer, not a
      // generic test executor account).
      for (const r of runs) {
        const uid = r.created_by || 0;
        if (uid) runsCreatedByPerson.set(uid, (runsCreatedByPerson.get(uid) || 0) + 1);
      }
    } catch (e) {
      console.warn(`  TestRail: get_runs/${projId} failed: ${e.message}`);
    }

    // -- 2. Cases created in sprint window (by author) --
    try {
      const createdCases = await fetchCasesCreatedInWindow(projId, startTs, endTs);
      totalCasesCreated += createdCases.length;
      for (const c of createdCases) {
        const uid = c.created_by || 0;
        casesCreatedByPerson.set(uid, (casesCreatedByPerson.get(uid) || 0) + 1);
      }
    } catch (e) {
      console.warn(`  TestRail: cases created for project ${projId} failed: ${e.message}`);
    }

    // -- 3. Plans created in sprint window (by author) --
    try {
      let plansEndpoint = `get_plans/${projId}`;
      const planFilters = [];
      if (startTs) planFilters.push(`created_after=${startTs}`);
      if (endTs) planFilters.push(`created_before=${endTs}`);
      planFilters.push("limit=250");
      plansEndpoint += "&" + planFilters.join("&");
      const plansData = await trGet(plansEndpoint);
      const plans = plansData.plans ?? plansData;
      if (Array.isArray(plans)) {
        totalPlansCreated += plans.length;
        for (const p of plans) {
          const uid = p.created_by || 0;
          if (uid) plansCreatedByPerson.set(uid, (plansCreatedByPerson.get(uid) || 0) + 1);
        }
      }
    } catch (e) {
      console.warn(`  TestRail: get_plans/${projId} failed: ${e.message}`);
    }

    // -- 4. Automation coverage snapshot (per-project cache — only fetched ONCE per run) --
    // fetchAllCases is sprint-independent; caching avoids 36+ repeated
    // paginated calls when getTestRailMetrics is called for current+prev
    // sprint across multiple sprint files.
    if (!automationCoverageCache.has(projId)) {
      try {
        const overallMs = 900_000; // 15 min — many paginated get_cases calls per large project
        const cases = await Promise.race([
          fetchAllCases(projId),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`cases fetch overall timeout (${overallMs / 1000}s)`)), overallMs),
          ),
        ]);

        let pTotal = 0, pAutomated = 0, pInProgress = 0, pNotStarted = 0;
        const pByType = {};
        for (const c of cases) {
          pTotal++;
          const isAutoType = c.type_id === 3;
          const autoStatus = c.custom_case_automationstatus;
          const isAutoStatus = autoStatus === 3;
          const isAutoByField = (c.custom_automation_type ?? 0) > 0;

          if (isAutoType || isAutoStatus || isAutoByField) {
            pAutomated++;
          } else if (autoStatus === 2) {
            pInProgress++;
          } else if (autoStatus === 1 || autoStatus === null || autoStatus === undefined) {
            pNotStarted++;
          }

          const atVal = c.custom_automation_type ?? 0;
          if (atVal > 0) {
            const label = AUTOMATION_TYPE_LABELS[atVal] || `Type ${atVal}`;
            pByType[label] = (pByType[label] || 0) + 1;
          }
        }
        automationCoverageCache.set(projId, { total: pTotal, automated: pAutomated, inProgress: pInProgress, notStarted: pNotStarted, byType: pByType });
        console.log(`  TestRail: automation coverage fetched for project ${projId} (${pTotal} cases) — cached for this run`);
      } catch (e) {
        console.warn(`  TestRail: cases for project ${projId} failed: ${e.message}`);
        automationCoverageCache.set(projId, { total: 0, automated: 0, inProgress: 0, notStarted: 0, byType: {} });
      }
    } else {
      console.log(`  TestRail: automation coverage for project ${projId} — served from cache (0 API calls)`);
    }

    const cov = automationCoverageCache.get(projId);
    totalCases += cov.total;
    automatedCases += cov.automated;
    inProgressCases += cov.inProgress;
    notStartedCases += cov.notStarted;
    for (const [label, cnt] of Object.entries(cov.byType)) {
      autoByType[label] = (autoByType[label] || 0) + cnt;
    }
  }

  const summary = { totalRuns };

  const manualOnly = totalCases - automatedCases - inProgressCases;
  const automation = {
    totalCases,
    automated: automatedCases,
    automationPct: totalCases > 0 ? Math.round((automatedCases / totalCases) * 100) + "%" : "N/A",
    inProgress: inProgressCases,
    notStarted: notStartedCases,
    byType: autoByType,
    manualOnly: Math.max(0, manualOnly),
    manualPct: totalCases > 0 ? Math.round((Math.max(0, manualOnly) / totalCases) * 100) + "%" : "N/A",
  };

  // Per-person array (sprint-scoped authorship: cases, runs, plans created).
  // Only uses created_by — excludes generic test executor accounts (QA1/QA2/...).
  const allUids = new Set([
    ...casesCreatedByPerson.keys(),
    ...runsCreatedByPerson.keys(),
    ...plansCreatedByPerson.keys(),
  ]);
  const byPerson = [];
  for (const uid of allUids) {
    if (!uid) continue;
    const user = await resolveUser(uid, trIdToDisplayName, emailToDisplayName);
    byPerson.push({
      name: user.name,
      email: user.email,
      casesCreated: casesCreatedByPerson.get(uid) || 0,
      runsCreated: runsCreatedByPerson.get(uid) || 0,
      plansCreated: plansCreatedByPerson.get(uid) || 0,
    });
  }
  byPerson.sort((a, b) =>
    (b.casesCreated + b.runsCreated + b.plansCreated) - (a.casesCreated + a.runsCreated + a.plansCreated),
  );

  // Persist merged user cache so the next run skips API calls for already-known users.
  saveUserCache();

  return {
    summary,
    automation,
    casesCreated: totalCasesCreated,
    runsCreated: totalRuns,
    plansCreated: totalPlansCreated,
    byPerson,
  };
}
