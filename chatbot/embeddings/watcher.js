/**
 * Live filesystem watcher over `output/*.md`.
 *
 * Started after the initial index build completes (see register.js). Coalesces
 * a flurry of writes (the daily cron rewrites many files in seconds) into a
 * single delta rebuild via a debounce window. Only changed/added files get
 * re-embedded; deleted files have their chunks dropped from the index.
 *
 * No-op when `config.watcher.enabled` is false, so production deployments can
 * disable hot-reload via env if they want a stricter "build at boot only"
 * profile.
 */
const path = require('path');
const config = require('../config');
const { diffAgainstDisk, applyDelta, readExistingIndex } = require('./indexer');

let watcher = null;
let debounceTimer = null;
let pendingChange = false;
let inflight = false;
let lastDeltaAt = null;
let lastDeltaCount = 0;
let lastDeltaMs = 0;

async function flushDelta() {
  if (inflight) {
    pendingChange = true;
    return;
  }
  pendingChange = false;
  inflight = true;
  try {
    const existing = readExistingIndex();
    const delta = diffAgainstDisk(existing);
    const total = delta.added.length + delta.modified.length + delta.removed.length;
    if (!total) return;
    console.log(`[chatbot watcher] applying delta: +${delta.added.length} ~${delta.modified.length} -${delta.removed.length}`);
    const t0 = Date.now();
    const idx = await applyDelta(delta);
    lastDeltaMs = Date.now() - t0;
    lastDeltaAt = Date.now();
    lastDeltaCount = total;
    console.log(`[chatbot watcher] index v${idx.indexVersion} ready (${idx.chunks.length} chunks) in ${lastDeltaMs}ms`);
  } catch (err) {
    console.error('[chatbot watcher] delta failed:', err.message || err);
  } finally {
    inflight = false;
    if (pendingChange) {
      pendingChange = false;
      schedule();
    }
  }
}

function schedule() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushDelta, config.watcher.debounceMs);
}

/**
 * Start watching `output/*.md`. Idempotent.
 */
async function start() {
  if (!config.watcher.enabled) {
    console.log('[chatbot watcher] disabled via env');
    return null;
  }
  if (watcher) return watcher;

  let chokidar;
  try {
    chokidar = require('chokidar');
  } catch (err) {
    console.warn('[chatbot watcher] chokidar not installed; live reload disabled');
    return null;
  }

  const dir = config.paths.output;
  watcher = chokidar.watch(path.join(dir, '*.md'), {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  const onChange = () => schedule();
  watcher.on('add', onChange);
  watcher.on('change', onChange);
  watcher.on('unlink', onChange);
  watcher.on('error', (err) => console.error('[chatbot watcher] error:', err.message || err));

  console.log(`[chatbot watcher] watching ${dir}/*.md (debounce ${config.watcher.debounceMs}ms)`);
  return watcher;
}

/**
 * Stop watching. Used by tests / graceful shutdown.
 */
async function stop() {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (watcher) {
    try { await watcher.close(); } catch (_) { /* ignore */ }
    watcher = null;
  }
}

function getStatus() {
  return {
    enabled: !!config.watcher.enabled,
    running: !!watcher,
    debounceMs: config.watcher.debounceMs,
    pendingChange,
    inflight,
    lastDeltaAt,
    lastDeltaCount,
    lastDeltaMs,
  };
}

module.exports = { start, stop, getStatus };
