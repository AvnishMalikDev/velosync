/**
 * JIRA ? resource-directory.json sync.
 *
 * Bulk-pulls the active JIRA user list (filtered to `@VeloSync.com` Atlassian
 * accounts) and writes `output/resource-directory.json`. Existing
 * `testRailUserId` and `githubLogin` rows are preserved (matched by email)
 * so manual edits / TestRail-sync results survive the refresh.
 *
 * Cache TTL: 7 days. The orchestrator calls `ensureresourceDirectory()`
 * on every run; if the cache is fresh, it's a no-op.
 */

import fs from "fs";
import { jiraGet, jiraUrl } from "./client.js";
import { OUTPUT_DIR, resource_DIRECTORY_JSON } from "../../core/paths.js";

const resource_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ensure `output/resource-directory.json` exists and is fresh (= 7 days old).
 *
 * On refresh, we pull every active Atlassian user, keep only `@VeloSync.com`
 * (or empty-email) accounts, and preserve any pre-existing `testRailUserId`
 * / `githubLogin` for each user (keyed by email). Anything that fails — JIRA
 * down, write fails, etc. — is logged and the orchestrator continues with
 * whatever cache it has.
 */
export async function ensureresourceDirectory() {
  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });

  try {
    const raw = await fs.promises.readFile(resource_DIRECTORY_JSON, "utf8");
    const cached = JSON.parse(raw);
    if (cached && cached.lastRefresh && (Date.now() - new Date(cached.lastRefresh).getTime()) < resource_DIR_MAX_AGE_MS) {
      console.log(`[resource Directory] Cache fresh (${(cached.users || []).length} users, refreshed ${cached.lastRefresh}) — skipping`);
      return;
    }
    console.log("[resource Directory] Cache stale — refreshing from JIRA...");
  } catch {
    console.log("[resource Directory] Not found — fetching from JIRA...");
  }

  try {
    const allUsers = [];
    let startAt = 0;
    const maxResults = 200;

    /** Preserve TestRail ID map when the Jira list is refreshed. */
    const existingTrByEmail = new Map();
    /** Preserve operator-maintained GitHub logins across refresh (keyed by email). */
    const existingGhByEmail = new Map();
    try {
      const prevRaw = await fs.promises.readFile(resource_DIRECTORY_JSON, "utf8");
      const prev = JSON.parse(prevRaw);
      for (const u of prev.users || []) {
        const e = (u.email || "").toLowerCase();
        if (e && u.testRailUserId != null && u.testRailUserId !== "") existingTrByEmail.set(e, u.testRailUserId);
        const gh = typeof u.githubLogin === "string" ? u.githubLogin.trim() : "";
        if (e && gh) existingGhByEmail.set(e, gh);
      }
    } catch { /* no prior file */ }

    for (;;) {
      const resp = await jiraGet(jiraUrl(`/rest/api/3/users/search?startAt=${startAt}&maxResults=${maxResults}`));
      if (!resp.ok) { console.warn(`[resource Directory] JIRA returned HTTP ${resp.status} — aborting`); break; }
      const batch = await resp.json();
      if (!Array.isArray(batch) || batch.length === 0) break;

      for (const u of batch) {
        if (u.accountType !== "atlassian" || u.active === false || !u.displayName) continue;
        const email = (u.emailAddress || "").toLowerCase();
        const name = u.displayName.toLowerCase();
        if (email && !email.endsWith("@VeloSync.com")) continue;
        if (!email && name.includes("@") && !name.includes("@VeloSync.com")) continue;
        const row = {
          displayName: u.displayName,
          accountId: u.accountId || "",
          email: u.emailAddress || "",
          avatarUrl: (u.avatarUrls && u.avatarUrls["24x24"]) || "",
        };
        if (email && existingTrByEmail.has(email)) row.testRailUserId = existingTrByEmail.get(email);
        if (email && existingGhByEmail.has(email)) row.githubLogin = existingGhByEmail.get(email);
        allUsers.push(row);
      }

      startAt += batch.length;
      if (batch.length < maxResults || startAt > 10000) break;
    }

    allUsers.sort((a, b) => a.displayName.localeCompare(b.displayName));
    const dirData = { lastRefresh: new Date().toISOString(), users: allUsers };
    await fs.promises.writeFile(resource_DIRECTORY_JSON, JSON.stringify(dirData, null, 2), "utf8");
    console.log(`[resource Directory] Written ${allUsers.length} users to ${resource_DIRECTORY_JSON}`);
  } catch (err) {
    console.warn("[resource Directory] Failed:", err.message);
  }
}
