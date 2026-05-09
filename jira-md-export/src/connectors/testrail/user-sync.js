/**
 * Match TestRail users to JIRA `resource-directory.json` rows by email and
 * stamp `testRailUserId` onto each matching row.
 *
 * Idempotent: invoked from the orchestrator after `ensureresourceDirectory()`
 * runs (skipped if TestRail env vars are unset). Also exposed as a CLI:
 *   node src/connectors/testrail/user-sync.js
 */

import "../../core/env.js";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { testRailGetJson } from "./request.js";
import {
  PROJECTS_JSON,
  resource_DIRECTORY_JSON,
  TESTRAIL_USERS_JSON,
  OUTPUT_DIR,
} from "../../core/paths.js";

/** TR users JSON younger than this is treated as authoritative — skips per-project API sweep. */
const TESTRAIL_USERS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function getAuth() {
  const TESTRAIL_DOMAIN = process.env.TESTRAIL_DOMAIN;
  const TESTRAIL_EMAIL = process.env.TESTRAIL_EMAIL;
  const TESTRAIL_API_KEY = process.env.TESTRAIL_API_KEY;
  const baseUrl = TESTRAIL_DOMAIN ? `https://${TESTRAIL_DOMAIN}/index.php?/api/v2` : null;
  const authHeader =
    TESTRAIL_EMAIL && TESTRAIL_API_KEY
      ? `Basic ${Buffer.from(`${TESTRAIL_EMAIL}:${TESTRAIL_API_KEY}`).toString("base64")}`
      : null;
  return { baseUrl, authHeader };
}

async function trGet(baseUrl, authHeader, endpoint) {
  return testRailGetJson(
    `${baseUrl}/${endpoint}`,
    { Authorization: authHeader, "Content-Type": "application/json" },
    endpoint,
  );
}

/**
 * @param {object}  [options]
 * @param {string}  [options.rdPath]       Path to `resource-directory.json`.
 * @param {string}  [options.projectsPath] Path to `projects.json`.
 * @param {boolean} [options.skipIfNoEnv]  When true, no-op cleanly if TestRail env is unset (used by orchestrator).
 * @returns {Promise<{ok: boolean, skipped?: boolean, matched?: number, reason?: string, usedCache?: boolean}>}
 */
export async function syncTestRailUserIds(options = {}) {
  const {
    rdPath = resource_DIRECTORY_JSON,
    projectsPath = PROJECTS_JSON,
    skipIfNoEnv = false,
  } = options;

  const { baseUrl, authHeader } = getAuth();

  if (!baseUrl || !authHeader) {
    if (skipIfNoEnv) {
      console.log(
        "[TestRail user sync] Skipped — set TESTRAIL_DOMAIN, TESTRAIL_EMAIL, TESTRAIL_API_KEY to map Jira ? TestRail user IDs",
      );
      return { ok: false, skipped: true, reason: "no_env" };
    }
    throw new Error("Set TESTRAIL_DOMAIN, TESTRAIL_EMAIL, TESTRAIL_API_KEY in .env");
  }

  if (!fs.existsSync(rdPath)) {
    const msg = `Missing ${rdPath} — Jira directory must be created first.`;
    if (skipIfNoEnv) {
      console.warn(`[TestRail user sync] ${msg}`);
      return { ok: false, skipped: true, reason: "no_resource_directory" };
    }
    throw new Error(msg);
  }

  const rd = JSON.parse(fs.readFileSync(rdPath, "utf8"));
  let projectsJson;
  try {
    projectsJson = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
  } catch (e) {
    throw new Error(`Could not read projects.json: ${e.message}`);
  }

  const trProjectIds = new Set();
  for (const p of projectsJson.projects || []) {
    for (const id of p.testRailProjectIds || []) trProjectIds.add(id);
  }

  if (trProjectIds.size === 0) {
    console.log("[TestRail user sync] No testRailProjectIds in projects.json — nothing to map.");
    return { ok: true, matched: 0 };
  }

  const trUsersByEmail = new Map();
  /** Accumulate every TR user seen across project sweeps — persisted to testrail-users.json. */
  const trUsersById = new Map();

  // Try cache first: if testrail-users.json is fresh, skip the per-project API sweep entirely.
  let usedCache = false;
  if (fs.existsSync(TESTRAIL_USERS_JSON)) {
    try {
      const tu = JSON.parse(fs.readFileSync(TESTRAIL_USERS_JSON, "utf8"));
      const fetchedAt = tu.fetchedAt ? new Date(tu.fetchedAt).getTime() : 0;
      const ageMs = Date.now() - fetchedAt;
      if (Number.isFinite(fetchedAt) && fetchedAt > 0 && ageMs < TESTRAIL_USERS_MAX_AGE_MS) {
        for (const u of tu.users || []) {
          const em = (u.email || "").toLowerCase().trim();
          if (em && u.id != null) trUsersByEmail.set(em, { id: Number(u.id), name: u.name || "" });
        }
        usedCache = true;
        console.log(
          `[TestRail user sync] Using cached testrail-users.json (${trUsersByEmail.size} users, age ${Math.round(ageMs / (60 * 60 * 1000))}h) — skipping API`,
        );
      }
    } catch { /* fall through to API sweep */ }
  }

  if (!usedCache) {
    for (const projId of trProjectIds) {
      try {
        const data = await trGet(baseUrl, authHeader, `get_users/${projId}`);
        const users = Array.isArray(data) ? data : (data.users ?? []);
        for (const u of users) {
          const em = (u.email || "").toLowerCase().trim();
          if (em && u.id != null) trUsersByEmail.set(em, { id: Number(u.id), name: u.name || "" });
          if (u.id != null && !trUsersById.has(u.id)) {
            trUsersById.set(u.id, { name: u.name || "", email: u.email || "" });
          }
        }
        console.log(`[TestRail user sync] get_users/${projId}: indexed ${users.length} users`);
      } catch (e) {
        console.warn(`[TestRail user sync] get_users/${projId} skipped: ${e.message}`);
      }
    }

    // Persist the fresh sweep so metrics.js (later in the same run) can skip its own API preload.
    if (trUsersById.size > 0) {
      try {
        if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        const usersArr = [...trUsersById.entries()]
          .map(([id, u]) => ({ id: Number(id), name: u.name || "", email: u.email || "" }))
          .sort((a, b) => a.id - b.id);
        fs.writeFileSync(
          TESTRAIL_USERS_JSON,
          JSON.stringify({ fetchedAt: new Date().toISOString(), total: usersArr.length, users: usersArr }, null, 2),
          "utf8",
        );
        console.log(`[TestRail user sync] Cached ${usersArr.length} users ? ${TESTRAIL_USERS_JSON}`);
      } catch (e) {
        console.warn(`[TestRail user sync] Failed to write testrail-users.json: ${e.message}`);
      }
    }
  }

  let matched = 0;
  // Only set `testRailUserId` on each Jira user row — never assign
  // displayName/email/avatarUrl from TestRail. Pune-vs-Others segmentation in
  // the dashboard relies on Jira displayName (e.g. trailing "(IDC)"); that
  // text comes only from Jira / ensureresourceDirectory.
  for (const ju of rd.users || []) {
    const em = (ju.email || "").toLowerCase().trim();
    if (!em) continue;
    const tr = trUsersByEmail.get(em);
    if (tr) {
      ju.testRailUserId = tr.id;
      matched++;
    }
  }

  fs.writeFileSync(rdPath, JSON.stringify(rd, null, 2), "utf8");
  console.log(`[TestRail user sync] Set testRailUserId on ${matched} Jira users (email match) ? ${rdPath}`);
  return { ok: true, matched, usedCache };
}

async function main() {
  try {
    await syncTestRailUserIds({ skipIfNoEnv: false });
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
