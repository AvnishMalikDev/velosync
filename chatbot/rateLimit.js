/**
 * Tiny in-process per-user token-bucket rate limiter.
 *
 * Identity: req.session.account.username (lowercased). Anonymous requests
 * (no session) get bucketed under '__anon__' which is fine because
 * upstream auth middleware will already 401 them — this is just defence
 * in depth.
 *
 * No persistence — counters reset on server restart. This is intentional
 * for a single-process Node app; it keeps the implementation dependency-free
 * and avoids the operational overhead of Redis.
 *
 * Tuning:
 *   /ask:                12 req / minute  (avoid runaway agent loops)
 *   /feedback, /answer:  60 req / minute  (rapid clicks are fine)
 */
const buckets = new Map();

function nowMs() { return Date.now(); }

/**
 * Build an Express middleware that enforces `capacity` tokens per
 * `windowMs`, refilling continuously. Each request consumes 1 token.
 *
 * @param {{ key: string, capacity: number, windowMs: number }} opts
 */
function tokenBucket({ key, capacity, windowMs }) {
  const refillPerMs = capacity / windowMs;

  return (req, res, next) => {
    const user = String(req.session?.account?.username || '__anon__').toLowerCase();
    const bucketKey = `${key}::${user}`;
    const now = nowMs();
    let b = buckets.get(bucketKey);
    if (!b) {
      b = { tokens: capacity, last: now };
      buckets.set(bucketKey, b);
    }
    // Refill since last hit.
    const elapsed = now - b.last;
    if (elapsed > 0) {
      b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerMs);
      b.last = now;
    }
    if (b.tokens < 1) {
      const retryAfterMs = Math.ceil((1 - b.tokens) / refillPerMs);
      res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
      res.setHeader('X-RateLimit-Limit', capacity);
      res.setHeader('X-RateLimit-Remaining', '0');
      return res.status(429).json({
        error: { message: `rate limit exceeded — try again in ${Math.ceil(retryAfterMs / 1000)}s` },
      });
    }
    b.tokens -= 1;
    res.setHeader('X-RateLimit-Limit', capacity);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, Math.floor(b.tokens)));
    return next();
  };
}

/**
 * Periodic cleanup of buckets that have been idle long enough that they're
 * effectively full. Prevents unbounded growth in the bucket Map.
 */
function startCleanup(maxIdleMs = 30 * 60 * 1000, intervalMs = 5 * 60 * 1000) {
  const t = setInterval(() => {
    const now = nowMs();
    for (const [k, b] of buckets) {
      if (now - b.last > maxIdleMs) buckets.delete(k);
    }
  }, intervalMs);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

function getStats() {
  return { activeBuckets: buckets.size };
}

module.exports = { tokenBucket, startCleanup, getStats };
