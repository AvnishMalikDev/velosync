/**
 * Tiny shared HTTP helper for connectors that need to fetch + JSON-parse with
 * tolerant error handling.
 *
 * Most JIRA / GitHub connectors use the global `fetch` directly because their
 * pagination / rate-limit semantics differ enough that a uniform wrapper would
 * obscure rather than help. This module exists for the simple "GET → JSON or
 * fail-soft" cases (e.g. Confluence search) and as a place for cross-cutting
 * helpers (timeout signals, transient retry checks).
 */

/** Pre-built `application/json` accept header. */
export const JSON_ACCEPT_HEADERS = { Accept: "application/json" };

/**
 * Fire one GET, return `{ ok, status, json, text }` without throwing.
 * `json` is null when the body is empty or not valid JSON.
 *
 * @param {string} url
 * @param {Record<string, string>} headers
 */
export async function fetchJsonSoft(url, headers) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text };
}

/**
 * Build an `AbortSignal` that fires after `timeoutMs`. Falls back to manual
 * `AbortController` for older Node where `AbortSignal.timeout` is missing.
 *
 * Returns `{ signal, cancel }` — call `cancel()` in a `finally` to release the
 * timer when the request completes early.
 */
export function timeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(timeoutMs), cancel() {} };
  }
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(id),
  };
}

/** Async sleep helper (Promise wrapper around setTimeout). */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Heuristic: is `err` a transient network error worth retrying?
 * Catches `AbortError`, `TimeoutError`, and the `TypeError: fetch failed`
 * thrown by Node when the underlying socket dies mid-request.
 */
export function isTransientFetchError(err) {
  if (!err) return false;
  const n = err.name;
  if (n === "AbortError" || n === "TimeoutError") return true;
  if (err instanceof TypeError) return true;
  return false;
}
