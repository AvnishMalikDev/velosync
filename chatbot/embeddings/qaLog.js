/**
 * Conversation memory: append-only Q+A log with embeddings, plus mutating
 * operations for the explicit feedback loop (thumbs + edit).
 *
 * Backed by the SQLite `qa_history` table (see embeddings/db.js). Row shape:
 *   { id, q, a, vec, by, model, at, helpful, helpfulAt, editedAt, editedBy }
 *
 * Why SQLite: the old JSONL store was rewritten in full on every feedback /
 * edit (read-all ? splice ? atomic write) and re-parsed on every retrieval.
 * Here, append is a single INSERT and feedback/edit are atomic UPDATE ... WHERE
 * id=? statements — no whole-file rewrite, no in-process serial queue needed.
 */
const config = require('../config');
const db = require('./db');
const { getEmbedder } = require('./indexer');

function makeId() {
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Public synchronous ID minter so callers (agent.js) can surface the QA id
 * to the client BEFORE the embedding+write actually completes — the widget
 * can then enable thumbs/edit immediately. logQA below uses the same id when
 * it eventually writes the row.
 */
function makeQaId() { return makeId(); }

/**
 * Embed Q+A and insert one row. Returns the row's id on success, or null if
 * anything fails (errors are logged but never thrown — fire-and-forget from
 * the caller's perspective).
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
  // row (vec=null) so feedback/edit endpoints can act on it. The vecHealer
  // backfills the embedding later. Keeps the chatbot usable when the model
  // can't be loaded (corp-proxy / TLS blocked / offline environment).
  let vec = null;
  try {
    const embed = await getEmbedder();
    const v = await embed(`${q}\n${a}`);
    if (Array.isArray(v) && v.length === config.model.embeddingDim) vec = v;
  } catch (err) {
    console.warn('[chatbot qaLog] embedder unavailable, writing row without vec:', err.message || err);
  }

  try {
    db.insertQa({
      id,
      q,
      a,
      vec,
      by: (entry.by || '').trim().toLowerCase(),
      model: entry.model || '',
      at: new Date().toISOString(),
      helpful: null,
    });
    // Bounded history: drop oldest rows beyond the cap (replaces JSONL rotation).
    try { db.pruneQaBeyond(config.qaLog.rotateAtLines); } catch (_) { /* best-effort */ }
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

  // The agent emits qaId to the widget synchronously, then fires the
  // embed+insert in the background — so a thumbs click can race the insert.
  // Retry briefly so we don't 404 in the typical case.
  const row = await findRowWithRetry(id);
  if (!row) return { ok: false, error: 'not_found' };
  if (String(row.by || '').trim().toLowerCase() !== owner) {
    return { ok: false, error: 'forbidden' };
  }
  db.updateQaHelpful(id, value, new Date().toISOString());
  return { ok: true };
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

  const row = await findRowWithRetry(id);
  if (!row) return { ok: false, error: 'not_found' };
  if (String(row.by || '').trim().toLowerCase() !== owner) {
    return { ok: false, error: 'forbidden' };
  }

  // Best-effort re-embed. If the model is offline we still accept the edit —
  // the row keeps its previous vec, and vecHealer can re-embed later.
  let finalVec = row.vec || null;
  try {
    const embed = await getEmbedder();
    const v = await embed(`${row.q}\n${text}`);
    if (Array.isArray(v) && v.length === config.model.embeddingDim) finalVec = v;
  } catch (err) {
    console.warn('[chatbot qaLog] re-embed on edit unavailable:', err.message || err);
  }

  db.updateQaAnswer(id, text, finalVec, new Date().toISOString(), owner);
  return { ok: true };
}

/** Look up a row, retrying briefly while logQA's background insert may still
 *  be in flight (same race the old JSONL retry loop handled). */
async function findRowWithRetry(id) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = db.getQaById(id);
    if (row) return row;
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

module.exports = { logQA, setHelpful, editAnswer, makeQaId };
