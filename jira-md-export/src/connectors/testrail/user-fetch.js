/**
 * One-shot utility: dump every TestRail user visible to the API account
 * (id, name, email, isActive) to `output/testrail-users.json`.
 *
 * That file then acts as a hard cache for `metrics.js`, eliminating all
 * `get_user/{id}` calls during the normal export run.
 *
 * Usage:
 *   npm run fetch:testrail-users          (or: node src/connectors/testrail/user-fetch.js)
 *
 * Inspect the output:
 *   output/testrail-users.json
 */

import "../../core/env.js";
import fs from "fs";
import { testRailGetJson } from "./request.js";
import { OUTPUT_DIR, PROJECTS_JSON, TESTRAIL_USERS_JSON } from "../../core/paths.js";

const TESTRAIL_DOMAIN = process.env.TESTRAIL_DOMAIN;
const TESTRAIL_EMAIL = process.env.TESTRAIL_EMAIL;
const TESTRAIL_API_KEY = process.env.TESTRAIL_API_KEY;

if (!TESTRAIL_DOMAIN || !TESTRAIL_EMAIL || !TESTRAIL_API_KEY) {
  console.error("Missing TESTRAIL_DOMAIN / TESTRAIL_EMAIL / TESTRAIL_API_KEY in .env");
  process.exit(1);
}

const baseUrl    = `https://${TESTRAIL_DOMAIN}/index.php?/api/v2`;
const authHeader = `Basic ${Buffer.from(`${TESTRAIL_EMAIL}:${TESTRAIL_API_KEY}`).toString("base64")}`;
const headers    = { Authorization: authHeader, "Content-Type": "application/json" };

async function trGet(endpoint) {
  return testRailGetJson(`${baseUrl}/${endpoint}`, headers, endpoint);
}

/** Extract a flat user array regardless of the envelope shape the API returned. */
function extractUsers(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.users)) return data.users;
  return [];
}

/** Merge incoming users into the accumulator map (`id` ? user object), first-write-wins. */
function mergeUsers(map, users) {
  for (const u of users) {
    if (!u.id) continue;
    if (!map.has(u.id)) {
      map.set(u.id, {
        id:       u.id,
        name:     u.name     || "",
        email:    u.email    || "",
        isActive: u.is_active ?? true,
      });
    }
  }
}

async function main() {
  console.log("Fetching TestRail users...\n");

  const userMap = new Map(); // id ? { id, name, email, isActive }

  // -- Step 1: global get_users (works for admin accounts) ------------------
  try {
    const data = await trGet("get_users");
    const users = extractUsers(data);
    mergeUsers(userMap, users);
    console.log(`  Global get_users ? ${users.length} users`);
  } catch (err) {
    console.warn(`  Global get_users failed (likely non-admin): ${err.message}`);
  }

  // -- Step 2: per-project get_users/{projectId} (non-admin accounts) -------
  let projectIds = [];
  try {
    const pj = JSON.parse(fs.readFileSync(PROJECTS_JSON, "utf8"));
    projectIds = (pj.projects || [])
      .flatMap((p) => p.testRailProjectIds || [])
      .filter(Boolean);
    projectIds = [...new Set(projectIds)];
  } catch (err) {
    console.warn(`  Could not read projects.json: ${err.message}`);
  }

  for (const pid of projectIds) {
    try {
      const data = await trGet(`get_users/${pid}`);
      const users = extractUsers(data);
      const before = userMap.size;
      mergeUsers(userMap, users);
      const added = userMap.size - before;
      console.log(`  Project ${pid}: ${users.length} users (${added} new)`);
    } catch (err) {
      console.warn(`  Project ${pid} get_users failed: ${err.message}`);
    }
  }

  // -- Step 3: write to output/testrail-users.json --------------------------
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const sorted = [...userMap.values()].sort((a, b) => a.id - b.id);
  const result = {
    fetchedAt: new Date().toISOString(),
    total: sorted.length,
    users: sorted,
  };

  fs.writeFileSync(TESTRAIL_USERS_JSON, JSON.stringify(result, null, 2), "utf8");

  console.log(`\nSaved ${sorted.length} users ? ${TESTRAIL_USERS_JSON}`);
  console.log("\nSample (first 5):");
  for (const u of sorted.slice(0, 5)) {
    console.log(`  [${u.id}] ${u.name.padEnd(30)} ${u.email}`);
  }

  const unresolved = sorted.filter((u) => !u.email);
  if (unresolved.length) {
    console.log(`\nWarning: ${unresolved.length} users have no email — they may be generic/system accounts:`);
    for (const u of unresolved.slice(0, 10)) {
      console.log(`  [${u.id}] ${u.name}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
