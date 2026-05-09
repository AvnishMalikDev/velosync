/**
 * Conversation memory: append-only Q+A log with embeddings, plus mutating
 * operations for the explicit feedback loop (thumbs + edit).
 *
 * Layout: `data/qa-history.jsonl` — one JSON row per turn.
 * Row shape:
 *   {
 *     id,        // stable id surfaced to the widget
 *     q, a,      // question + (possibly edited) answer
 *     vec,       // embedding of `q\n${a}` — recomputed on edit
 *     by,        // owning user's email
 *     model, at, // model used + ISO timestamp
 *     helpful,   // null | true | false (set by /api/chatbot/feedback)
 *     helpfulAt, // ISO when feedback was last set
 *     editedAt,  // ISO of last edit (if any)
 *     editedBy,  // who edited (must equal `by`)
 *   }
 *
 * Append is fire-and-forget from the caller's perspective. Rewrites
 * (setHelpful / editAnswer) go through a tiny in-process serial queue
 * so two concurrent feedback clicks don't clobber each other's rewrite.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../config');
const { getEmbedder } = require('./indexer');

function ensureDir() {
  const dir = path.dirname(config.paths.qaHistory);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Rotate qa-history.jsonl when it exceeds `rotateAtLines`. Keeps the last
 * `rotateAtLines` rows in place; older rows go to a `.bak` archive that
 * search.js does not read.
 */
async function rotateIfNeeded() {
  const p = config.paths.qaHistory;
  if (!fs.existsSync(p)) return;
  let raw;
  try { raw = await fsp.readFile(p, 'utf8'); } catch (_) { return; }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const limit = config.qaLog.rotateAtLines;
  if (lines.length <= limit) return;

  const keep = lines.slice(lines.length - limit);
  const archive = lines.slice(0, lines.length - limit);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const bak = path.join(path.dirname(p), `qa-history-${stamp}.jsonl.bak`);
  try {
    await fsp.appendFile(bak, archive.join('\n') + '\n', 'utf8');
    await atomicWriteText(p, keep.join('\n') + '\n');
  } catch (err) {
    console.error('[chatbot qaLog] rotation failed:', err.message || err);
  }
}

function makeId() {
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Public synchronous ID minter so callers (agent.js) can surface the QA id
 * to the client BEFORE the embedding+file-write actually completes — the
 * widget can then enable thumbs/edit immediately. The async logQA below
 * will use the same id when it eventually writes the row.
 */
function makeQaId() { return makeId(); }

async function atomicWriteText(filePath, text) {
  const tmp = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, filePath);
}

/**
 * Tiny in-process serial mutator. Multiple calls await the previous one's
 * full JSONL read-modify-write before starting their own. Sufficient because
 * we only have one Node process serving this module.
 */
let mutateQueue = Promise.resolve();
function serialMutate(fn) {
  const next = mutateQueue.then(fn, fn);
  mutateQueue = next.catch(() => { /* keep chain alive */ });
  return next;
}

async function readAllRows() {
  const p = config.paths.qaHistory;
  if (!fs.existsSync(p)) return { lines: [], rows: [] };
  const raw = await fsp.readFile(p, 'utf8');
  const lines = raw.split(/\r?\n/);
  const rows = lines.map((line) => {
    if (!line) return null;
    try { return JSON.parse(line); } catch (_) { return null; }
  });
  return { lines, rows };
}

function rowsToJsonl(rows) {
  return rows.filter(Boolean).map(r => JSON.stringify(r)).join('\n') + '\n';
}

/**
 * Embed Q+A and append one JSONL row. Returns the row's id on success, or
 * null if anything fails (errors are logged but never thrown — fire-and-forget
 * from the caller's perspective).
 *
 * If `entry.id` is supplied, that exact id is used — letting the agent
 * pre-generate a synchronous id with `makeQaId()` and surface it to the
 * client immediately, while the embed/write happens in the background.
 *
 * @param {{ id?: string, question: string, answer: string, by?: string, model?: string }} entry
 * @returns {Promise<string|null>}
 */
async function logQA(entry) {
  if (!entry || !entry.question || !entry.answer) return null;
  const q = String(entry.question).slice(0, 4000);
  const a = String(entry.answer).slice(0, 8000);
  const id = entry.id || makeId();

  // Try to embed, but treat embedder failure as soft — we still write the
  // row so feedback/edit endpoints can act on it. The row just won't be
  // retrievable as `prior_answer` until vec is repopulated. This keeps
  // the chatbot fully usable even when the model can't be downloaded
  // (corp-proxy / TLS blocked / offline environment).
  let vec = null;
  try {
    const embed = await getEmbedder();
    const v = await embed(`${q}\n${a}`);
    if (Array.isArray(v) && v.length === config.model.embeddingDim) vec = v;
  } catch (err) {
    console.warn('[chatbot qaLog] embedder unavailable, writing row without vec:', err.message || err);
  }

  try {
    ensureDir();
    const row = {
      id,
      q,
      a,
      vec,
      by: entry.by || '',
      model: entry.model || '',
      at: new Date().toISOString(),
      helpful: null,
    };
    await fsp.appendFile(config.paths.qaHistory, JSON.stringify(row) + '\n', 'utf8');
    rotateIfNeeded().catch(() => { /* ignore */ });
    return id;
  } catch (err) {
    console.error('[chatbot qaLog] write failed:', err.message || err);
    return null;
  }
}

/**
 * Set the `helpful` flag on a previously logged turn.
 *
 * Ownership: `by` (the caller's logged-in email) must match the row's `by`.
 * This prevents one user from voting on another user's row.
 *
 * @param {string} id
 * @param {boolean|null} helpful
 * @param {string} by
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function setHelpful(id, helpful, by) {
  if (!id) return { ok: false, error: 'id is required' };
  const owner = String(by || '').trim().toLowerCase();
  if (!owner) return { ok: false, error: 'unauthenticated' };
  const value = (helpful === true || helpful === false) ? helpful : null;

  return serialMutate(async () => {
    // The agent emits qaId to the widget synchronously, then fires the
    // embed+append in the background. So a thumbs click can race the
    // append. Retry briefly so we don't 404 in the typical case.
    let row = null;
    let rows = null;
    let idx = -1;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      ({ rows } = await readAllRows());
      idx = rows.findIndex(r => r && r.id === id);
      if (idx !== -1) { row = rows[idx]; break; }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!row) return { ok: false, error: 'not_found' };
    if (String(row.by || '').trim().toLowerCase() !== owner) {
      return { ok: false, error: 'forbidden' };
    }
    rows[idx] = { ...row, helpful: value, helpfulAt: new Date().toISOString() };
    await atomicWriteText(config.paths.qaHistory, rowsToJsonl(rows));
    return { ok: true };
  });
}

/**
 * Replace a row's answer with a user-corrected version. Re-embeds Q+newAnswer
 * so subsequent retrievals see the updated content as `prior_answer`.
 *
 * @param {string} id
 * @param {string} newAnswer
 * @param {string} by
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function editAnswer(id, newAnswer, by) {
  if (!id) return { ok: false, error: 'id is required' };
  const text = String(newAnswer || '').slice(0, 8000).trim();
  if (!text) return { ok: false, error: 'answer is empty' };
  const owner = String(by || '').trim().toLowerCase();
  if (!owner) return { ok: false, error: 'unauthenticated' };

  return serialMutate(async () => {
    // Same race as setHelpful — retry briefly while logQA's background
    // append might still be in flight.
    let row = null;
    let rows = null;
    let idx = -1;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      ({ rows } = await readAllRows());
      idx = rows.findIndex(r => r && r.id === id);
      if (idx !== -1) { row = rows[idx]; break; }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!row) return { ok: false, error: 'not_found' };
    if (String(row.by || '').trim().toLowerCase() !== owner) {
      return { ok: false, error: 'forbidden' };
    }

    // Best-effort re-embed. If the model is offline (corp-proxy / TLS
    // blocked) we still accept the edit — the row keeps its previous vec
    // (or null), and the user-visible answer text is updated. Without
    // this, the edit endpoint would 400 every time on offline hosts.
    let finalVec = row.vec || null;
    try {
      const embed = await getEmbedder();
      const v = await embed(`${row.q}\n${text}`);
      if (Array.isArray(v) && v.length === config.model.embeddingDim) finalVec = v;
    } catch (err) {
      console.warn('[chatbot qaLog] re-embed on edit unavailable:', err.message || err);
    }

    rows[idx] = {
      ...row,
      a: text,
      vec: finalVec,
      editedAt: new Date().toISOString(),
      editedBy: owner,
    };
    await atomicWriteText(config.paths.qaHistory, rowsToJsonl(rows));
    return { ok: true };
  });
}

module.exports = { logQA, setHelpful, editAnswer, makeQaId };
