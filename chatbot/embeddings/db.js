/**
 * SQLite store for the chatbot (better-sqlite3, single file, WAL).
 *
 * This is the canonical home for three data sets that used to live in
 * memory-heavy flat files:
 *
 *   - docs vector index   (was data/docs.index.json — a 5 MB JSON blob that
 *                          search.js re-parsed on EVERY query, spiking RSS)
 *   - qa-history          (was data/qa-history.jsonl)
 *   - user-memory         (was data/user-memory.jsonl)
 *
 * Vectors are stored as compact Float32 BLOBs (4 bytes/dim) instead of JSON
 * arrays of doubles, and rows are read with indexed SQL instead of full-file
 * parses. Everything stays inside chatbot/ — the host server is untouched.
 *
 * The connection is a process-wide singleton. better-sqlite3 is synchronous,
 * so there is no connection pool to manage; a single handle is correct and
 * fastest for our single-process (fork-mode) deployment.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

// Bump this when the *chunk format* changes (e.g. contextText scheme) so a
// boot detects the old chunks as stale and rebuilds them. Mirrors the old
// indexer SCHEMA_VERSION (was 3 for contextual-retrieval text).
const CHUNK_SCHEMA_VERSION = 3;

const DIM = config.model.embeddingDim;

let _db = null;

// ──────────────────────────────────────────────────────────────────────────────
// Vector <-> BLOB helpers. Vectors are already L2-normalized upstream, so
// cosine similarity stays a plain dot product on the Float32 view.
// ──────────────────────────────────────────────────────────────────────────────

/** Encode a numeric array/Float32Array as a Float32 BLOB Buffer (or null). */
function vecToBlob(arr) {
  if (!arr || !arr.length) return null;
  const f32 = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** Decode a Float32 BLOB Buffer back to a Float32Array (safe copy, no aliasing). */
function blobToF32(buf) {
  if (!buf || !buf.length) return null;
  // Copy out of the (possibly pooled) Buffer into a tight ArrayBuffer so the
  // Float32Array view is correctly aligned and independent of the source.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

// ──────────────────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────────────────

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS mtimes (
      file    TEXT PRIMARY KEY,
      mtimeMs REAL,
      hash    TEXT
    );

    CREATE TABLE IF NOT EXISTS docs_chunks (
      id           TEXT PRIMARY KEY,
      file         TEXT,
      project      TEXT,
      sprint       TEXT,
      section      TEXT,
      mtime        REAL,
      text         TEXT,
      context_text TEXT,
      vec          BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_docs_chunks_file ON docs_chunks(file);

    CREATE TABLE IF NOT EXISTS qa_history (
      id         TEXT PRIMARY KEY,
      q          TEXT,
      a          TEXT,
      vec        BLOB,
      by_email   TEXT,
      model      TEXT,
      at         TEXT,
      helpful    INTEGER,
      helpful_at TEXT,
      edited_at  TEXT,
      edited_by  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_qa_by_email ON qa_history(by_email);
    CREATE INDEX IF NOT EXISTS idx_qa_at ON qa_history(at);

    CREATE TABLE IF NOT EXISTS user_memory (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      fact  TEXT,
      at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_email ON user_memory(email);
  `);
}

// ──────────────────────────────────────────────────────────────────────────────
// Connection (singleton)
// ──────────────────────────────────────────────────────────────────────────────

function getDb() {
  if (_db) return _db;
  const dir = path.dirname(config.paths.db);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(config.paths.db);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  createSchema(db);
  _db = db;

  // One-time migration of any pre-existing flat files into SQLite.
  try {
    if (getMeta('legacyImported') !== '1') {
      importLegacyData();
      setMeta('legacyImported', '1');
    }
  } catch (err) {
    console.warn('[chatbot db] legacy import skipped:', err.message || err);
  }
  return db;
}

// ──────────────────────────────────────────────────────────────────────────────
// meta
// ──────────────────────────────────────────────────────────────────────────────

function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  getDb()
    .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

function getIndexVersion() {
  const v = parseInt(getMeta('indexVersion'), 10);
  return Number.isFinite(v) ? v : 0;
}

function bumpIndexVersion() {
  const next = getIndexVersion() + 1;
  setMeta('indexVersion', String(next));
  return next;
}

/** Light summary for healthz — never materializes chunk vectors. */
function getIndexMeta() {
  const db = getDb();
  const chunks = db.prepare('SELECT COUNT(*) AS n FROM docs_chunks').get().n;
  return {
    indexVersion: getIndexVersion(),
    schemaVersion: parseInt(getMeta('chunkSchemaVersion'), 10) || 0,
    chunks,
    mdFileCount: parseInt(getMeta('mdFileCount'), 10) || 0,
    builtAt: getMeta('builtAt'),
    embeddingModel: getMeta('embeddingModel'),
    embeddingDim: parseInt(getMeta('embeddingDim'), 10) || DIM,
    contextualRetrieval: getMeta('contextualRetrieval'),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// mtimes (replaces mtimePerFile + hashPerFile)
// ──────────────────────────────────────────────────────────────────────────────

function getMtimes() {
  const out = {};
  for (const r of getDb().prepare('SELECT file, mtimeMs, hash FROM mtimes').all()) {
    out[r.file] = { mtimeMs: r.mtimeMs, hash: r.hash };
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// docs_chunks
// ──────────────────────────────────────────────────────────────────────────────

function chunkCount() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM docs_chunks').get().n;
}

/**
 * All chunks needed to build the in-memory search matrix. Returns rows with
 * the raw vec Buffer; the caller decodes once into a packed Float32 matrix.
 */
function getAllChunksForSearch() {
  return getDb()
    .prepare('SELECT id, file, project, sprint, section, text, vec FROM docs_chunks')
    .all();
}

function _insertChunkStmt() {
  return getDb().prepare(`
    INSERT INTO docs_chunks(id, file, project, sprint, section, mtime, text, context_text, vec)
    VALUES(@id, @file, @project, @sprint, @section, @mtime, @text, @context_text, @vec)
    ON CONFLICT(id) DO UPDATE SET
      file=excluded.file, project=excluded.project, sprint=excluded.sprint,
      section=excluded.section, mtime=excluded.mtime, text=excluded.text,
      context_text=excluded.context_text, vec=excluded.vec
  `);
}

function _chunkToRow(c) {
  const m = c.meta || {};
  return {
    id: c.id,
    file: m.file || '',
    project: m.project || '',
    sprint: m.sprint || '',
    section: m.section || '',
    mtime: m.mtime != null ? m.mtime : null,
    text: c.text || '',
    context_text: c.contextText || c.text || '',
    vec: vecToBlob(c.vec),
  };
}

/**
 * Full rebuild: wipe all chunks + mtimes and write the new set in one
 * transaction, then stamp meta and bump the index version.
 */
function replaceAllChunks(embeddedChunks, { mtimePerFile, hashPerFile, mdFileCount, embeddingModel, embeddingDim, contextualRetrieval }) {
  const db = getDb();
  const insertChunk = _insertChunkStmt();
  const insertMtime = db.prepare('INSERT INTO mtimes(file, mtimeMs, hash) VALUES(?, ?, ?) ON CONFLICT(file) DO UPDATE SET mtimeMs=excluded.mtimeMs, hash=excluded.hash');

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM docs_chunks').run();
    db.prepare('DELETE FROM mtimes').run();
    for (const c of embeddedChunks) insertChunk.run(_chunkToRow(c));
    for (const [file, mtimeMs] of Object.entries(mtimePerFile || {})) {
      insertMtime.run(file, mtimeMs, (hashPerFile && hashPerFile[file]) || null);
    }
  });
  tx();

  setMeta('chunkSchemaVersion', String(CHUNK_SCHEMA_VERSION));
  setMeta('mdFileCount', String(mdFileCount || 0));
  setMeta('embeddingModel', embeddingModel || '');
  setMeta('embeddingDim', String(embeddingDim || DIM));
  setMeta('contextualRetrieval', contextualRetrieval || '');
  setMeta('builtAt', new Date().toISOString());
  return bumpIndexVersion();
}

/**
 * Delta apply: drop chunks for touched/removed files, insert the freshly
 * embedded chunks, update mtimes, drop removed-file mtimes — one transaction.
 */
function applyChunkDelta({ touchedFiles, removedFiles, embeddedChunks, mtimePerFile, hashPerFile, mdFileCount, embeddingModel, embeddingDim, contextualRetrieval }) {
  const db = getDb();
  const insertChunk = _insertChunkStmt();
  const delByFile = db.prepare('DELETE FROM docs_chunks WHERE file = ?');
  const upsertMtime = db.prepare('INSERT INTO mtimes(file, mtimeMs, hash) VALUES(?, ?, ?) ON CONFLICT(file) DO UPDATE SET mtimeMs=excluded.mtimeMs, hash=excluded.hash');
  const delMtime = db.prepare('DELETE FROM mtimes WHERE file = ?');

  const tx = db.transaction(() => {
    for (const f of touchedFiles) delByFile.run(f);
    for (const f of removedFiles) { delByFile.run(f); delMtime.run(f); }
    for (const c of embeddedChunks) insertChunk.run(_chunkToRow(c));
    for (const [file, mtimeMs] of Object.entries(mtimePerFile || {})) {
      upsertMtime.run(file, mtimeMs, (hashPerFile && hashPerFile[file]) || null);
    }
  });
  tx();

  if (mdFileCount != null) setMeta('mdFileCount', String(mdFileCount));
  if (embeddingModel) setMeta('embeddingModel', embeddingModel);
  if (embeddingDim) setMeta('embeddingDim', String(embeddingDim));
  if (contextualRetrieval) setMeta('contextualRetrieval', contextualRetrieval);
  setMeta('chunkSchemaVersion', String(CHUNK_SCHEMA_VERSION));
  setMeta('builtAt', new Date().toISOString());
  return bumpIndexVersion();
}

// ──────────────────────────────────────────────────────────────────────────────
// qa_history
// ──────────────────────────────────────────────────────────────────────────────

function _intToBool(v) {
  if (v === 1) return true;
  if (v === 0) return false;
  return null;
}
function _boolToInt(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

function insertQa(row) {
  getDb().prepare(`
    INSERT INTO qa_history(id, q, a, vec, by_email, model, at, helpful, helpful_at, edited_at, edited_by)
    VALUES(@id, @q, @a, @vec, @by_email, @model, @at, @helpful, @helpful_at, @edited_at, @edited_by)
    ON CONFLICT(id) DO UPDATE SET
      q=excluded.q, a=excluded.a, vec=excluded.vec, by_email=excluded.by_email,
      model=excluded.model, at=excluded.at
  `).run({
    id: row.id,
    q: row.q || '',
    a: row.a || '',
    vec: vecToBlob(row.vec),
    by_email: String(row.by || '').trim().toLowerCase(),
    model: row.model || '',
    at: row.at || new Date().toISOString(),
    helpful: _boolToInt(row.helpful),
    helpful_at: row.helpfulAt || null,
    edited_at: row.editedAt || null,
    edited_by: row.editedBy || null,
  });
}

function getQaById(id) {
  const r = getDb().prepare('SELECT * FROM qa_history WHERE id = ?').get(id);
  if (!r) return null;
  return {
    id: r.id, q: r.q, a: r.a,
    vec: blobToF32(r.vec),
    by: r.by_email, model: r.model, at: r.at,
    helpful: _intToBool(r.helpful), helpfulAt: r.helpful_at,
    editedAt: r.edited_at, editedBy: r.edited_by,
  };
}

function updateQaHelpful(id, helpful, helpfulAt) {
  const info = getDb()
    .prepare('UPDATE qa_history SET helpful = ?, helpful_at = ? WHERE id = ?')
    .run(_boolToInt(helpful), helpfulAt || new Date().toISOString(), id);
  return info.changes > 0;
}

function updateQaAnswer(id, a, vec, editedAt, editedBy) {
  const info = getDb()
    .prepare('UPDATE qa_history SET a = ?, vec = ?, edited_at = ?, edited_by = ? WHERE id = ?')
    .run(a, vecToBlob(vec), editedAt || new Date().toISOString(), editedBy || '', id);
  return info.changes > 0;
}

function updateQaVec(id, vec) {
  return getDb().prepare('UPDATE qa_history SET vec = ? WHERE id = ?').run(vecToBlob(vec), id).changes > 0;
}

/**
 * Most-recent rows for one user that actually have a vector (retrieval only
 * cares about embeddable rows). Decodes vec to Float32Array for cosine.
 */
function getQaForUser(email, limit) {
  const rows = getDb()
    .prepare('SELECT * FROM qa_history WHERE by_email = ? AND vec IS NOT NULL ORDER BY at DESC LIMIT ?')
    .all(String(email || '').trim().toLowerCase(), Math.max(0, limit | 0));
  return rows.map((r) => ({
    id: r.id, q: r.q, a: r.a,
    vec: blobToF32(r.vec),
    by: r.by_email, at: r.at,
    helpful: _intToBool(r.helpful),
  }));
}

/** Rows missing a vector (vecHealer backfills these). */
function getQaOrphans(limit) {
  return getDb()
    .prepare('SELECT id, q, a FROM qa_history WHERE vec IS NULL AND q IS NOT NULL AND a IS NOT NULL LIMIT ?')
    .all(Math.max(0, limit | 0));
}

/** Drop oldest rows beyond `cap` (replaces JSONL line-count rotation). */
function pruneQaBeyond(cap) {
  if (!cap || cap < 1) return 0;
  return getDb().prepare(`
    DELETE FROM qa_history WHERE id IN (
      SELECT id FROM qa_history ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?
    )
  `).run(cap).changes;
}

function getQaStats() {
  const db = getDb();
  const s = db.prepare(`
    SELECT
      COUNT(*) AS rows,
      SUM(CASE WHEN vec IS NOT NULL THEN 1 ELSE 0 END) AS withVec,
      SUM(CASE WHEN vec IS NULL THEN 1 ELSE 0 END) AS withoutVec,
      SUM(CASE WHEN helpful = 1 THEN 1 ELSE 0 END) AS helpfulUp,
      SUM(CASE WHEN helpful = 0 THEN 1 ELSE 0 END) AS helpfulDown,
      SUM(CASE WHEN edited_at IS NOT NULL THEN 1 ELSE 0 END) AS edited
    FROM qa_history
  `).get();
  return {
    rows: s.rows || 0,
    withVec: s.withVec || 0,
    withoutVec: s.withoutVec || 0,
    helpfulUp: s.helpfulUp || 0,
    helpfulDown: s.helpfulDown || 0,
    edited: s.edited || 0,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// user_memory
// ──────────────────────────────────────────────────────────────────────────────

/** Oldest-first, matching the previous JSONL append order. */
function getMemoriesByEmail(email) {
  return getDb()
    .prepare('SELECT email, fact, at FROM user_memory WHERE email = ? ORDER BY id ASC')
    .all(String(email || '').trim().toLowerCase());
}

function insertMemory({ email, fact, at }) {
  getDb()
    .prepare('INSERT INTO user_memory(email, fact, at) VALUES(?, ?, ?)')
    .run(String(email || '').trim().toLowerCase(), fact, at || new Date().toISOString());
}

/** Keep only the newest `cap` rows for this user. */
function pruneMemoryBeyondCap(email, cap) {
  if (!cap || cap < 1) return 0;
  return getDb().prepare(`
    DELETE FROM user_memory WHERE email = ? AND id NOT IN (
      SELECT id FROM user_memory WHERE email = ? ORDER BY id DESC LIMIT ?
    )
  `).run(String(email || '').trim().toLowerCase(), String(email || '').trim().toLowerCase(), cap).changes;
}

// ──────────────────────────────────────────────────────────────────────────────
// Stats / misc
// ──────────────────────────────────────────────────────────────────────────────

function getDbBytes() {
  try { return fs.statSync(config.paths.db).size; } catch (_) { return 0; }
}

// ──────────────────────────────────────────────────────────────────────────────
// One-time legacy import (qa-history.jsonl + user-memory.jsonl -> SQLite).
// Docs index is NOT imported — it is rebuilt deterministically from output/*.md
// by the normal warmup, so there is nothing to migrate there.
// ──────────────────────────────────────────────────────────────────────────────

function _readJsonl(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

function importLegacyData() {
  const db = getDb();

  // qa-history.jsonl
  const qaRows = _readJsonl(config.paths.qaHistory);
  if (qaRows.length) {
    const insert = db.prepare(`
      INSERT INTO qa_history(id, q, a, vec, by_email, model, at, helpful, helpful_at, edited_at, edited_by)
      VALUES(@id, @q, @a, @vec, @by_email, @model, @at, @helpful, @helpful_at, @edited_at, @edited_by)
      ON CONFLICT(id) DO NOTHING
    `);
    const tx = db.transaction((rows) => {
      for (const r of rows) {
        if (!r || !r.id) continue;
        insert.run({
          id: r.id,
          q: r.q || '',
          a: r.a || '',
          vec: Array.isArray(r.vec) ? vecToBlob(r.vec) : null,
          by_email: (r.by || '').trim().toLowerCase(),
          model: r.model || '',
          at: r.at || new Date().toISOString(),
          helpful: _boolToInt(r.helpful === true ? true : r.helpful === false ? false : null),
          helpful_at: r.helpfulAt || null,
          edited_at: r.editedAt || null,
          edited_by: r.editedBy || null,
        });
      }
    });
    tx(qaRows);
    console.log(`[chatbot db] imported ${qaRows.length} qa-history row(s) from JSONL`);
  }

  // user-memory.jsonl
  const memRows = _readJsonl(config.paths.userMemory);
  if (memRows.length) {
    const insert = db.prepare('INSERT INTO user_memory(email, fact, at) VALUES(?, ?, ?)');
    const tx = db.transaction((rows) => {
      for (const r of rows) {
        if (!r || !r.email || typeof r.fact !== 'string') continue;
        insert.run(String(r.email).trim().toLowerCase(), r.fact, r.at || new Date().toISOString());
      }
    });
    tx(memRows);
    console.log(`[chatbot db] imported ${memRows.length} user-memory row(s) from JSONL`);
  }
}

module.exports = {
  getDb,
  vecToBlob,
  blobToF32,
  // meta / index version
  getMeta,
  setMeta,
  getIndexVersion,
  getIndexMeta,
  // mtimes
  getMtimes,
  // docs chunks
  chunkCount,
  getAllChunksForSearch,
  replaceAllChunks,
  applyChunkDelta,
  // qa history
  insertQa,
  getQaById,
  updateQaHelpful,
  updateQaAnswer,
  updateQaVec,
  getQaForUser,
  getQaOrphans,
  pruneQaBeyond,
  getQaStats,
  // user memory
  getMemoriesByEmail,
  insertMemory,
  pruneMemoryBeyondCap,
  // misc
  getDbBytes,
  CHUNK_SCHEMA_VERSION,
};
