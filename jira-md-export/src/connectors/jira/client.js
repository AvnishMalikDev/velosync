/**
 * JIRA HTTP client.
 *
 * Thin wrapper around `fetch` that injects the shared Basic-auth header and
 * domain. Keeps every other JIRA module free of credential plumbing.
 *
 * Returns the raw `Response` so callers can branch on `response.ok` /
 * `response.status` themselves — the various JIRA endpoints have meaningfully
 * different error semantics (search/jql 410, board 404, etc.) and a single
 * blanket throw would hide that.
 */

import { jiraDomain, jiraHeaders } from "../../core/jira-auth.js";

/**
 * Build a `https://<domain>/<path>` URL from a path that starts with `/`.
 * Use `URLSearchParams` directly when you need querystring control.
 */
export function jiraUrl(pathname) {
  return `https://${jiraDomain}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

/**
 * Authenticated GET request — returns the raw `Response`. Callers are
 * responsible for status checking and JSON parsing because each JIRA
 * endpoint has bespoke error semantics.
 */
export function jiraGet(url, extraHeaders = {}) {
  return fetch(url, {
    headers: { ...jiraHeaders, ...extraHeaders },
  });
}

/** Convenience wrapper: GET → JSON, throws on non-2xx with body excerpt. */
export async function jiraGetJson(url, label = "request") {
  const res = await jiraGet(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`JIRA ${label} → ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** Re-export jiraDomain so connector callers don't need a second import. */
export { jiraDomain } from "../../core/jira-auth.js";
