/**
 * Background heal for qa-history.jsonl rows that were written without
 * embeddings (because the embedder was offline at the time — corp-proxy /
 * model files not yet in cache / fresh first-boot, etc.).
 *
 * Strategy:
 *   - Every `intervalMs`, scan the JSONL for rows with `vec === null`.
 *   - If the embedder is currently ready (or becomes ready), batch-embed
 *     the missing rows and atomically rewrite the file.
 *   - One row per failed re-embed attempt is silently skipped; healing
 *     resumes next tick. No retries that could hot-loop on a sticky failure.
 *
 * The heal is bounded — at most `maxPerTick` rows touched per cycle so we
 * don't stall the process on a giant backlog.
 */
const fs = require('fs');
const fsp = fs.promises;
const config = require('../config');
const { getEmbedder, getEmbedderStatus } = require('./indexer');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_PER_TICK = 32;

let timer = null;
let inflight = false;
let lastTickAt = null;
let lastHealedCount = 0;
let totalHealed = 0;

async function atomicWriteText(filePath, text) {
  const tmp = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, filePath);
}

function readAllRows() {
  const p = config.paths.qaHistory;
  if (!fs.existsSync(p)) return [];
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { return []; }
  const lines = raw.split(/\r?\n/);
  return lines.map((line) => {
    if (!line) return null;
    try { return JSON.parse(line); } catch (_) { return null; }
  });
}

async function tick(maxPerTick) {
  if (inflight) return;
  inflight = true;
  lastTickAt = Date.now();
  try {
    const rows = readAllRows();
    if (!rows.length) return;

    const orphans = [];
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      if (r && r.id && r.q && r.a && !Array.isArray(r.vec)) {
        orphans.push({ idx: i, row: r });
        if (orphans.length >= maxPerTick) break;
      }
    }
    if (!orphans.length) {
      lastHealedCount = 0;
      return;
    }

    let embed;
    try {
      embed = await getEmbedder();
    } catch (_) {
      // embedder not ready yet — try again next tick
      lastHealedCount = 0;
      return;
    }

    const texts = orphans.map(o => `${o.row.q}\n${o.row.a}`);
    let vecs;
    try {
      vecs = await embed.batch(texts);
    } catch (err) {
      console.warn('[chatbot vecHealer] batch embed failed:', err.message || err);
      lastHealedCount = 0;
      return;
    }

    let healed = 0;
    for (let j = 0; j < orphans.length; j += 1) {
      const v = vecs[j];
      if (Array.isArray(v) && v.length === config.model.embeddingDim) {
        rows[orphans[j].idx] = { ...orphans[j].row, vec: v };
        healed += 1;
      }
    }
    if (!healed) {
      lastHealedCount = 0;
      return;
    }

    const text = rows.filter(Boolean).map(r => JSON.stringify(r)).join('\n') + '\n';
    await atomicWriteText(config.paths.qaHistory, text);
    lastHealedCount = healed;
    totalHealed += healed;
    console.log(`[chatbot vecHealer] healed ${healed} row(s) (total ${totalHealed})`);
  } catch (err) {
    console.error('[chatbot vecHealer] tick failed:', err.message || err);
  } finally {
    inflight = false;
  }
}

/**
 * Start the background healer. Idempotent — calling twice is a no-op.
 *
 * @param {{ intervalMs?: number, maxPerTick?: number }} [opts]
 */
function start(opts = {}) {
  if (timer) return;
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  const maxPerTick = opts.maxPerTick || DEFAULT_MAX_PER_TICK;

  // Run one tick eagerly (non-blocking) so any rows that piled up while the
  // embedder was offline get embedded as soon as it comes online, without
  // waiting a full interval.
  setImmediate(() => { tick(maxPerTick).catch(() => {}); });

  timer = setInterval(() => { tick(maxPerTick).catch(() => {}); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function getStatus() {
  return {
    running: !!timer,
    inflight,
    lastTickAt,
    lastHealedCount,
    totalHealed,
    embedder: getEmbedderStatus(),
  };
}

module.exports = { start, stop, getStatus };
