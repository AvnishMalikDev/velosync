/**
 * Shared TestRail HTTP GET helper.
 *
 * - Per-attempt timeout (configurable, default 120s).
 * - Up to N transient retries (network errors, 5xx, 408).
 * - Separate 429 rate-limit handling that honours `Retry-After`.
 *
 * Used by every TestRail entrypoint (`metrics.js`, `user-sync.js`,
 * `user-fetch.js`) so timeout / retry / 429 policy stays consistent.
 */

import { sleep, timeoutSignal, isTransientFetchError } from "../../core/http.js";

/** Per-HTTP-attempt timeout (ms). */
export const TR_FETCH_TIMEOUT_MS = 120_000;

/** Total attempts per logical GET (2 = one retry after a transient failure). */
export const TR_FETCH_ATTEMPTS = 2;

/** Re-export for callers that want the same sleep helper without a separate import. */
export { sleep as trSleep } from "../../core/http.js";

/**
 * GET JSON from TestRail with timeout, transient retry, and 429 backoff.
 *
 * @param {string} url            Full URL.
 * @param {HeadersInit} headers   Pre-built auth + content-type headers.
 * @param {string} endpointLabel  Short label used in log messages.
 * @param {{rateLimitRetries?: number, attempts?: number, timeoutMs?: number}} [opt]
 */
export async function testRailGetJson(url, headers, endpointLabel, opt = {}) {
  const attempts = opt.attempts ?? TR_FETCH_ATTEMPTS;
  const timeoutMs = opt.timeoutMs ?? TR_FETCH_TIMEOUT_MS;
  const rateLimitRetries = opt.rateLimitRetries ?? 4;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const { signal, cancel } = timeoutSignal(timeoutMs);
    let res;
    try {
      res = await fetch(url, { headers, signal });
    } catch (err) {
      if (attempt < attempts - 1 && isTransientFetchError(err)) {
        console.warn(
          `  TestRail: ${endpointLabel} — ${err.message} (attempt ${attempt + 1}/${attempts}), retrying...`,
        );
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    } finally {
      cancel();
    }

    if (res.status === 429) {
      const body = await res.text().catch(() => "");
      if (rateLimitRetries <= 0) {
        throw new Error(`TR ${endpointLabel} → 429 ${body.slice(0, 200)}`);
      }
      const retryAfter = parseInt(res.headers.get("retry-after") || "3", 10);
      const wait = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 3) * 1000 + 200;
      console.warn(`  TestRail: rate-limited on ${endpointLabel} — waiting ${wait}ms (${rateLimitRetries} left)`);
      await sleep(wait);
      return testRailGetJson(url, headers, endpointLabel, {
        ...opt,
        rateLimitRetries: rateLimitRetries - 1,
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const msg = `TR ${endpointLabel} → ${res.status} ${body.slice(0, 200)}`;
      const retriableHttp =
        (res.status >= 500 && res.status < 600) || res.status === 408;
      if (attempt < attempts - 1 && retriableHttp) {
        console.warn(
          `  TestRail: ${endpointLabel} — HTTP ${res.status} (attempt ${attempt + 1}/${attempts}), retrying...`,
        );
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new Error(msg);
    }

    return res.json();
  }

  throw new Error(`TR ${endpointLabel} — exceeded ${attempts} attempts`);
}
