/**
 * Confluence connector.
 *
 * Fetches per-user page activity (created / edited / spaces) for a date range
 * via the Atlassian wiki API. Authenticates with the same Basic-auth token as
 * JIRA (`JIRA_EMAIL` + `JIRA_TOKEN`).
 *
 * Public surface:
 *   - `checkConfluenceAccess(domain, email, apiToken)` quick reachability probe
 *   - `buildConfluenceAuth(email, apiToken)` shareable Basic-auth string
 *   - `getConfluenceActivityForUser(domain, auth, accountId, startDate, endDate)`
 *
 * Standalone CLI (for sanity checks):
 *   node src/connectors/confluence/client.js [name-search-query]
 */

import { fileURLToPath } from "url";
import { resolve } from "path";
import { fetchJsonSoft, JSON_ACCEPT_HEADERS } from "../../core/http.js";
import { buildBasicAuth } from "../../core/jira-auth.js";

function headers(auth) {
  return { Authorization: `Basic ${auth}`, ...JSON_ACCEPT_HEADERS };
}

/** Format ISO date as `YYYY/MM/DD` for CQL operators. Returns null on bad input. */
function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Quick connectivity check — returns true if the Confluence wiki API is
 * reachable with the supplied creds (covers both "not licensed" and
 * "401 Unauthorized" scenarios so callers can branch cleanly).
 */
export async function checkConfluenceAccess(domain, email, apiToken) {
  const auth = buildBasicAuth(email, apiToken);
  const res = await fetchJsonSoft(
    `https://${domain}/wiki/rest/api/space?limit=1`,
    headers(auth),
  );
  return res.ok;
}

/**
 * Per-user page activity in a window.
 *
 * @param {string} domain    Atlassian host (e.g. `yourorg.atlassian.net`)
 * @param {string} auth      Pre-built base64 Basic-auth string
 * @param {string} accountId Atlassian accountId (same as JIRA)
 * @param {string} startDate ISO date `YYYY-MM-DD`
 * @param {string} endDate   ISO date `YYYY-MM-DD`
 * @returns {Promise<{contributed:number,created:number,edited:number,spaces:string[]}>}
 */
export async function getConfluenceActivityForUser(domain, auth, accountId, startDate, endDate) {
  if (!accountId || !startDate || !endDate) {
    return { contributed: 0, created: 0, edited: 0, spaces: [] };
  }

  const wikiBase = `https://${domain}/wiki`;
  const hdrs = headers(auth);
  const start = formatDate(startDate);
  const end = formatDate(endDate);
  if (!start || !end) return { contributed: 0, created: 0, edited: 0, spaces: [] };

  // Pages this user touched (created OR edited) in the window.
  const contribCql = `type=page AND contributor = "${accountId}" AND lastModified >= "${start}" AND lastModified <= "${end}"`;
  const contribRes = await fetchJsonSoft(
    `${wikiBase}/rest/api/content/search?cql=${encodeURIComponent(contribCql)}&expand=space,history&limit=100`,
    hdrs,
  );
  const contribPages = contribRes.ok ? (contribRes.json?.results || []) : [];
  const contribTotal = contribRes.ok ? (contribRes.json?.totalSize ?? contribPages.length) : 0;

  // Pages this user authored in the window.
  const createdCql = `type=page AND creator = "${accountId}" AND created >= "${start}" AND created <= "${end}"`;
  const createdRes = await fetchJsonSoft(
    `${wikiBase}/rest/api/content/search?cql=${encodeURIComponent(createdCql)}&limit=1`,
    hdrs,
  );
  const createdTotal = createdRes.ok
    ? (createdRes.json?.totalSize ?? createdRes.json?.results?.length ?? 0)
    : 0;

  // Derive space names from the pages we touched (skip personal `~user` spaces).
  const spaceSet = new Set();
  for (const p of contribPages) {
    const key = p.space?.key;
    const name = p.space?.name;
    if (key && name && !key.startsWith("~")) {
      spaceSet.add(name);
    }
  }

  return {
    contributed: contribTotal,
    created: createdTotal,
    edited: Math.max(0, contribTotal - createdTotal),
    spaces: [...spaceSet],
  };
}

/** Convenience: build the shared Basic-auth blob (re-exported for callers). */
export function buildConfluenceAuth(email, apiToken) {
  return buildBasicAuth(email, apiToken);
}

// -- Standalone entry for testing --------------------------------------------
const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  await import("../../core/env.js");
  (async () => {
    const email = process.env.JIRA_EMAIL;
    const token = process.env.JIRA_TOKEN;
    const domain = process.env.JIRA_DOMAIN;

    if (!email || !token || !domain) {
      console.error("Missing JIRA_EMAIL, JIRA_TOKEN, or JIRA_DOMAIN in .env");
      process.exitCode = 1;
      return;
    }

    const ok = await checkConfluenceAccess(domain, email, token);
    console.log(`Confluence API accessible: ${ok}`);
    if (!ok) { process.exitCode = 1; return; }

    const auth = buildConfluenceAuth(email, token);
    const searchName = process.argv[2] || "avnish";
    const hdrs = headers(auth);
    const usersRes = await fetchJsonSoft(
      `https://${domain}/rest/api/3/user/search?query=${encodeURIComponent(searchName)}&maxResults=3`,
      hdrs,
    );
    const users = usersRes.json || [];

    const now = new Date();
    const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
    const startDate = d30.toISOString().slice(0, 10);
    const endDate = now.toISOString().slice(0, 10);

    for (const u of users.filter((u) => u.active)) {
      console.log(`\n--- ${u.displayName} (${u.accountId}) ---`);
      const result = await getConfluenceActivityForUser(domain, auth, u.accountId, startDate, endDate);
      console.log(`  Contributed: ${result.contributed} | Created: ${result.created} | Edited: ${result.edited}`);
      console.log(`  Spaces: ${result.spaces.length > 0 ? result.spaces.join(", ") : "none"}`);
    }
  })().catch((e) => {
    console.error("Error:", e.message);
    process.exitCode = 1;
  });
}
