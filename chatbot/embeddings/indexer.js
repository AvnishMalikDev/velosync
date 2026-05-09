/**
 * Embeddings indexer.
 *
 * Loads the Xenova all-MiniLM-L6-v2 model lazily (singleton, downloads ~25 MB
 * on first run to ../.cache/ and is reused afterwards). Walks output/*.md,
 * chunks each file by ### headings, embeds each chunk, and writes the result
 * to data/docs.index.json.
 *
 * Schema v2:
 *   {
 *     schemaVersion: 2,
 *     chunks:        [{ id, text, vec, meta }],
 *     mtimePerFile:  { [filename]: mtimeMs },
 *     mdFileCount:   number,
 *     embeddingModel, embeddingDim, builtAt, indexVersion
 *   }
 *
 * Old v1 indexes (no `schemaVersion`) are detected as stale and rebuilt once.
 *
 * The same embedder singleton is reused by qaLog.js and search.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const config = require('../config');

// v3 adds contextText (metadata-prefixed chunk text) used for embedding while
// the original text is preserved for display. Set CHATBOT_CONTEXTUAL_RETRIEVAL=llm
// for LLM-generated context instead of the deterministic metadata prefix.
const SCHEMA_VERSION = 3;

let pipelinePromise = null;
let embedderReady = false;
let embedderError = null;
let embedderLoadStartedAt = null;
let embedderLoadFinishedAt = null;

/**
 * Lazy-load the embedding pipeline. Singleton with auto-reset on failure
 * so a later caller (eg, the vec=null healer) can retry once the model
 * files become available.
 *
 * The returned function has a `.batch(texts[])` helper for indexing —
 * batching cuts cold-start reindex time ~3-5x because most of the model's
 * per-call overhead is fixed per ONNX session run.
 *
 * @returns {Promise<((text: string) => Promise<number[]>) & { batch: (texts: string[]) => Promise<number[][]> }>}
 */
async function getEmbedder() {
  if (pipelinePromise) return pipelinePromise;
  embedderLoadStartedAt = Date.now();
  embedderError = null;
  const p = (async () => {
    const { pipeline, env } = await import('@xenova/transformers');
    env.cacheDir = config.paths.cache;
    env.allowLocalModels = true;
    const extractor = await pipeline('feature-extraction', config.model.embedding, {
      quantized: true,
    });

    const embed = async (text) => {
      const out = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(out.data);
    };

    embed.batch = async (texts) => {
      if (!Array.isArray(texts) || !texts.length) return [];
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      const total = out.dims[0];
      const dim = out.dims[1];
      const flat = out.data;
      const result = new Array(total);
      for (let i = 0; i < total; i += 1) {
        result[i] = Array.from(flat.slice(i * dim, (i + 1) * dim));
      }
      return result;
    };

    embedderReady = true;
    embedderLoadFinishedAt = Date.now();
    return embed;
  })();
  pipelinePromise = p;
  // Auto-reset on failure so subsequent calls can retry (eg, after model
  // files are dropped into .cache/ post-startup).
  p.catch((err) => {
    embedderError = err && (err.message || String(err));
    embedderReady = false;
    if (pipelinePromise === p) pipelinePromise = null;
  });
  return p;
}

/**
 * Synchronous accessor for embedder health — used by the healthz endpoint
 * and the vec=null healer to decide whether to attempt re-embedding.
 */
function getEmbedderStatus() {
  return {
    ready: embedderReady,
    error: embedderError,
    loadStartedAt: embedderLoadStartedAt,
    loadFinishedAt: embedderLoadFinishedAt,
  };
}

/**
 * Parse the YAML-style header at the top of a sprint MD file.
 * Looks for `**Product:** HDE`, `**Sprint name:** ...`, `**Manager:** ...`.
 * Exported so deterministic tools (query_sprint) can reuse the same parser.
 */
function parseMdHeader(content) {
  const meta = {};
  const lines = content.split(/\r?\n/).slice(0, 12);
  for (const line of lines) {
    const m = line.match(/^\*\*([^:*]+):\*\*\s*(.+?)\s*$/);
    if (m) {
      const key = m[1].trim().toLowerCase().replace(/\s+/g, '_');
      meta[key] = m[2].trim();
    }
  }
  return meta;
}

// ------------------------------------------------------------------------------
// Contextual Retrieval helpers.
//
// Each chunk is embedded using a `contextText` that prepends document-level
// metadata so the vector captures *where* a fact lives, not just *what* it says.
//
// Default ('metadata' mode): deterministic, free — builds a prefix from the
// structured meta fields that already exist on every chunk.
//
// Optional ('llm' mode): calls the fast model via OpenRouter to generate a
// 1-2 sentence natural-language context sentence. More accurate but costs API
// calls and adds ~1-2 s per chunk during index builds.
// ------------------------------------------------------------------------------

/**
 * Build a deterministic context prefix from chunk metadata.
 * Result is prepended to the raw chunk text before embedding.
 */
function buildMetadataPrefix(meta) {
  const parts = [];
  if (meta.project) parts.push(`Project: ${meta.project}`);
  if (meta.sprint) parts.push(`Sprint: ${meta.sprint}`);
  if (meta.section) parts.push(`Section: ${meta.section}`);
  return parts.length ? `[${parts.join(' | ')}]\n` : '';
}

/**
 * One-shot non-streaming call to OpenRouter — used at index time for
 * LLM-powered contextual retrieval. Returns '' on any error so the caller
 * can fall back to the metadata prefix silently.
 */
async function callFastLLMOnce(prompt) {
  const apiKey = config.openRouter.apiKey;
  if (!apiKey || apiKey === 'your-openrouter-api-key-here') return '';
  const model = config.model.fastModel;
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 120,
    stream: false,
  });
  return new Promise((resolve) => {
    const allowInsecure = config.openRouter.allowInsecureTls;
    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'HTTP-Referer': 'https://localhost',
        'X-Title': 'VeloSync Dashboard Chatbot Indexer',
      },
      ...(allowInsecure && { agent: new https.Agent({ rejectUnauthorized: false }) }),
    };
    let raw = '';
    const req = https.request(options, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve((parsed?.choices?.[0]?.message?.content || '').trim());
        } catch (_) { resolve(''); }
      });
      res.on('error', () => resolve(''));
    });
    req.setTimeout(15000, () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
    req.write(body);
    req.end();
  });
}

/**
 * Generate LLM-powered context for a chunk (used when CHATBOT_CONTEXTUAL_RETRIEVAL=llm).
 * Batches calls to avoid rate-limit blowup: max `concurrency` in-flight at once.
 */
async function llmContextualizeChunks(chunks, docContentMap, concurrency = 4) {
  const results = new Array(chunks.length).fill('');
  let idx = 0;
  async function worker() {
    while (idx < chunks.length) {
      const i = idx++;
      const c = chunks[i];
      const docContent = docContentMap[c.meta.file] || '';
      // Trim doc to first 800 chars as "document context" to save tokens.
      const docSnippet = docContent.slice(0, 800).replace(/\n+/g, ' ');
      const prompt =
        `You are indexing sprint documentation for an engineering dashboard.\n` +
        `Document context (first part of the document):\n"${docSnippet}"\n\n` +
        `Chunk text:\n"${c.text.slice(0, 600)}"\n\n` +
        `Write 1-2 sentences of context that situate this chunk within the document, ` +
        `mentioning the project name, sprint/PI if present, and what aspect this chunk covers. ` +
        `Be concise. Do not repeat the chunk text verbatim.`;
      results[i] = await callFastLLMOnce(prompt);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/**
 * Chunk an MD file by `### ` headings. Each chunk includes its heading + body.
 * Long bodies are sliced into ~1600-char windows so we don't blow the embedding
 * model's context (MiniLM is 512 tokens / ~2000 chars).
 */
function chunkMarkdown(content, fileMeta, fileName) {
  const headerMeta = parseMdHeader(content);
  const project = headerMeta.product || headerMeta.project || fileName.replace(/\s*\[ACTIVE\]\.md$/i, '').replace(/\.md$/, '');
  const sprint = headerMeta.sprint_name || headerMeta.sprint || '';
  const max = config.retrieval.chunkMaxChars;

  const parts = content.split(/(^### .+$)/m);
  const chunks = [];
  let currentHeading = `${project} — overview`;
  let buffer = '';

  const flush = () => {
    if (!buffer.trim()) return;
    let text = buffer.trim();
    while (text.length > max) {
      chunks.push({
        heading: currentHeading,
        text: `${currentHeading}\n\n${text.slice(0, max)}`,
      });
      text = text.slice(max);
    }
    chunks.push({
      heading: currentHeading,
      text: text.length < max - currentHeading.length - 4 ? `${currentHeading}\n\n${text}` : text,
    });
    buffer = '';
  };

  for (const part of parts) {
    if (/^### /.test(part)) {
      flush();
      currentHeading = part.replace(/^###\s+/, '').trim();
    } else {
      buffer += part;
    }
  }
  flush();

  const mode = config.features.contextualRetrieval;
  return chunks.map((c, i) => {
    const meta = {
      file: fileName,
      project,
      sprint,
      section: c.heading,
      mtime: fileMeta.mtimeMs,
    };
    // contextText is set here for 'metadata' mode; for 'llm' mode it is
    // filled in later by llmContextualizeChunks after all chunks are collected.
    const contextText = mode !== 'off'
      ? `${buildMetadataPrefix(meta)}${c.text}`
      : c.text;
    return {
      id: `${fileName}#${i}`,
      text: c.text,
      contextText,
      meta,
    };
  });
}

/**
 * Read one MD file and produce chunks (no embeddings).
 * Returns null if the file is missing/unreadable.
 * Also returns raw `content` so LLM contextualizer can use the full document.
 */
function readFileChunks(file) {
  const full = path.join(config.paths.output, file);
  let stat;
  try { stat = fs.statSync(full); } catch (_) { return null; }
  let content;
  try { content = fs.readFileSync(full, 'utf8'); } catch (_) { return null; }
  return { stat, content, chunks: chunkMarkdown(content, stat, file) };
}

/**
 * Embed an array of chunk objects in batches; returns array of embedded chunks.
 *
 * Batching strategy: we feed `BATCH_SIZE` chunks to the ONNX session at once.
 * On the first cold reindex this is ~3-5x faster than one-by-one because the
 * fixed per-call overhead (tensor allocation, kernel dispatch) amortises
 * across the batch. If a batch errors as a whole, we fall back to per-chunk
 * embedding for that slice so a single bad input doesn't poison the rest.
 */
async function embedChunks(chunks, onProgress) {
  if (!chunks.length) return [];
  const embed = await getEmbedder();
  const out = [];
  const BATCH_SIZE = 8;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const slice = chunks.slice(i, i + BATCH_SIZE);
    // Embed contextText when available (contextual retrieval) — fall back to text.
    const textsToEmbed = slice.map(c => c.contextText || c.text);
    let vecs = null;
    try {
      vecs = await embed.batch(textsToEmbed);
    } catch (err) {
      console.warn('[chatbot indexer] batch embed failed, falling back to per-chunk:', err.message || err);
    }

    if (vecs && vecs.length === slice.length) {
      for (let j = 0; j < slice.length; j += 1) {
        const c = slice[j];
        if (Array.isArray(vecs[j]) && vecs[j].length === config.model.embeddingDim) {
          out.push({
            id: c.id,
            text: c.text,
            contextText: c.contextText || c.text,
            vec: vecs[j],
            meta: c.meta,
          });
        }
      }
    } else {
      for (const c of slice) {
        try {
          const vec = await embed(c.contextText || c.text);
          if (Array.isArray(vec) && vec.length === config.model.embeddingDim) {
            out.push({
              id: c.id,
              text: c.text,
              contextText: c.contextText || c.text,
              vec,
              meta: c.meta,
            });
          }
        } catch (err) {
          console.error('[chatbot indexer] failed to embed chunk', c.id, err.message || err);
        }
      }
    }

    if (onProgress) {
      onProgress({
        stage: 'embedding',
        done: Math.min(i + slice.length, chunks.length),
        total: chunks.length,
      });
    }
  }
  return out;
}

/**
 * Walk output/*.md and produce all chunks for every file (no embeddings yet).
 * Returns a flat list, a per-file mtime map, and docContentMap (for LLM mode).
 */
function collectAll() {
  const dir = config.paths.output;
  if (!fs.existsSync(dir)) return { chunks: [], mtimePerFile: {}, docContentMap: {}, fileCount: 0 };
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md'));
  const chunks = [];
  const mtimePerFile = {};
  const docContentMap = {};
  for (const file of files) {
    const r = readFileChunks(file);
    if (!r) continue;
    mtimePerFile[file] = r.stat.mtimeMs;
    docContentMap[file] = r.content || '';
    chunks.push(...r.chunks);
  }
  return { chunks, mtimePerFile, docContentMap, fileCount: files.length };
}

/**
 * Compute the delta between an existing index and the current state of disk.
 * Returns lists of file names: `added`, `modified`, `removed`.
 *
 * When `existing.hashPerFile` is available, a mtime change alone is not enough
 * to mark a file as modified — the content hash must also differ. This prevents
 * unnecessary full re-embeds when a cron job rewrites files with identical
 * content (touching their timestamps but not their data).
 */
function diffAgainstDisk(existing) {
  const dir = config.paths.output;
  const onDisk = {};
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(x => x.toLowerCase().endsWith('.md'))) {
      try { onDisk[f] = fs.statSync(path.join(dir, f)).mtimeMs; } catch (_) { /* skip */ }
    }
  }
  const indexed = (existing && existing.mtimePerFile) || {};
  const storedHashes = (existing && existing.hashPerFile) || {};

  const added = [];
  const modified = [];
  const removed = [];
  for (const [f, mtime] of Object.entries(onDisk)) {
    if (!(f in indexed)) {
      added.push(f);
    } else if (indexed[f] !== mtime) {
      // Mtime changed — verify content hash before declaring modified so that
      // files merely "touched" (same bytes, new timestamp) don't trigger
      // unnecessary re-embedding.
      const stored = storedHashes[f];
      if (stored) {
        const current = hashFile(path.join(dir, f));
        if (current && current === stored) continue; // content identical ? skip
      }
      modified.push(f);
    }
  }
  for (const f of Object.keys(indexed)) {
    if (!(f in onDisk)) removed.push(f);
  }
  return { added, modified, removed, onDisk };
}

/**
 * Compare existing index against current MD mtimes; return true if rebuild needed.
 * Treats v1 indexes (no schemaVersion) as stale to force a one-time migration.
 */
function isIndexStale(existing) {
  if (!existing || !Array.isArray(existing.chunks)) return true;
  if ((existing.schemaVersion || 1) < SCHEMA_VERSION) return true;
  const { added, modified, removed } = diffAgainstDisk(existing);
  return (added.length + modified.length + removed.length) > 0;
}

function readExistingIndex() {
  try {
    const raw = fs.readFileSync(config.paths.docsIndex, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function atomicWriteJson(filePath, payload) {
  const tmp = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * SHA-1 content hash of a file. Used to detect whether a file's content
 * actually changed vs only its mtime being bumped (e.g., by a cron that
 * rewrites the file with identical content). Returns null on any read error.
 */
function hashFile(fullPath) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(fullPath)).digest('hex');
  } catch (_) {
    return null;
  }
}

/**
 * Build the docs index from scratch and write it to data/docs.index.json.
 * @param {(progress: { stage: string, done: number, total: number }) => void} [onProgress]
 */
async function buildDocsIndex(onProgress) {
  const dir = path.dirname(config.paths.docsIndex);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (onProgress) onProgress({ stage: 'collecting', done: 0, total: 0 });
  const { chunks, mtimePerFile, docContentMap, fileCount } = collectAll();

  if (chunks.length === 0) {
    const empty = {
      schemaVersion: SCHEMA_VERSION,
      chunks: [],
      mtimePerFile: {},
      hashPerFile: {},
      mdFileCount: 0,
      contextualRetrieval: config.features.contextualRetrieval,
      builtAt: new Date().toISOString(),
      indexVersion: 1,
    };
    atomicWriteJson(config.paths.docsIndex, empty);
    cachedPayload = empty;
    return empty;
  }

  // LLM-powered contextual retrieval: overwrite contextText on each chunk
  // with an LLM-generated context sentence before embedding.
  if (config.features.contextualRetrieval === 'llm') {
    if (onProgress) onProgress({ stage: 'contextualizing', done: 0, total: chunks.length });
    console.log(`[chatbot indexer] LLM contextual retrieval: generating context for ${chunks.length} chunks…`);
    try {
      const ctxTexts = await llmContextualizeChunks(chunks, docContentMap);
      for (let i = 0; i < chunks.length; i++) {
        if (ctxTexts[i]) {
          chunks[i].contextText = `${ctxTexts[i]}\n\n${chunks[i].text}`;
        }
      }
    } catch (err) {
      console.warn('[chatbot indexer] LLM contextualization failed, using metadata prefix:', err.message || err);
    }
  }

  if (onProgress) onProgress({ stage: 'embedding', done: 0, total: chunks.length });

  // Compute content hashes for all files so future startups can skip
  // re-embedding files whose mtime changed but content didn't.
  const hashPerFile = {};
  for (const file of Object.keys(mtimePerFile)) {
    const h = hashFile(path.join(config.paths.output, file));
    if (h) hashPerFile[file] = h;
  }

  const out = await embedChunks(chunks, onProgress);

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    chunks: out,
    mtimePerFile,
    hashPerFile,
    mdFileCount: fileCount,
    embeddingModel: config.model.embedding,
    embeddingDim: config.model.embeddingDim,
    contextualRetrieval: config.features.contextualRetrieval,
    builtAt: new Date().toISOString(),
    indexVersion: 1,
  };
  atomicWriteJson(config.paths.docsIndex, payload);
  cachedPayload = payload;
  if (onProgress) onProgress({ stage: 'done', done: chunks.length, total: chunks.length });
  return payload;
}

/**
 * Apply a delta to the existing index — re-embed only changed/added files,
 * drop chunks for removed files, atomically rewrite the JSON. If no existing
 * index is found, falls back to a full rebuild.
 *
 * @param {{ added: string[], modified: string[], removed: string[] }} delta
 * @param {(progress: { stage: string, done: number, total: number }) => void} [onProgress]
 */
async function applyDelta(delta, onProgress) {
  const existing = readExistingIndex();
  if (!existing || (existing.schemaVersion || 1) < SCHEMA_VERSION) {
    return buildDocsIndex(onProgress);
  }
  const added = (delta.added || []).slice();
  const modified = (delta.modified || []).slice();
  const removed = (delta.removed || []).slice();

  const touchedFiles = new Set([...added, ...modified, ...removed]);
  if (!touchedFiles.size) return existing;

  const keptChunks = (existing.chunks || []).filter(c => !touchedFiles.has(c?.meta?.file));
  const newMtimePerFile = { ...(existing.mtimePerFile || {}) };
  const newHashPerFile = { ...(existing.hashPerFile || {}) };
  for (const f of removed) {
    delete newMtimePerFile[f];
    delete newHashPerFile[f];
  }

  const newRawChunks = [];
  const docContentMap = {};
  for (const f of [...added, ...modified]) {
    const r = readFileChunks(f);
    if (!r) {
      delete newMtimePerFile[f];
      delete newHashPerFile[f];
      continue;
    }
    newMtimePerFile[f] = r.stat.mtimeMs;
    docContentMap[f] = r.content || '';
    const h = hashFile(path.join(config.paths.output, f));
    if (h) newHashPerFile[f] = h; else delete newHashPerFile[f];
    newRawChunks.push(...r.chunks);
  }

  // LLM contextual retrieval for delta chunks (same as full build).
  if (config.features.contextualRetrieval === 'llm' && newRawChunks.length > 0) {
    try {
      const ctxTexts = await llmContextualizeChunks(newRawChunks, docContentMap);
      for (let i = 0; i < newRawChunks.length; i++) {
        if (ctxTexts[i]) {
          newRawChunks[i].contextText = `${ctxTexts[i]}\n\n${newRawChunks[i].text}`;
        }
      }
    } catch (err) {
      console.warn('[chatbot indexer] delta LLM contextualization failed, using metadata prefix:', err.message || err);
    }
  }

  if (onProgress && newRawChunks.length > 0) {
    onProgress({ stage: 'embedding', done: 0, total: newRawChunks.length });
  }
  const newEmbedded = await embedChunks(newRawChunks, onProgress);

  const dir = config.paths.output;
  const fileCount = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(x => x.toLowerCase().endsWith('.md')).length
    : 0;

  const payload = {
    ...existing,
    schemaVersion: SCHEMA_VERSION,
    chunks: [...keptChunks, ...newEmbedded],
    mtimePerFile: newMtimePerFile,
    hashPerFile: newHashPerFile,
    mdFileCount: fileCount,
    embeddingModel: config.model.embedding,
    embeddingDim: config.model.embeddingDim,
    contextualRetrieval: config.features.contextualRetrieval,
    builtAt: new Date().toISOString(),
    indexVersion: (existing.indexVersion || 0) + 1,
  };
  atomicWriteJson(config.paths.docsIndex, payload);
  cachedPayload = payload;
  return payload;
}

/**
 * Build the index if absent or stale. Returns the index payload.
 * Safe to call multiple times — uses an in-flight promise to avoid double work.
 *
 * Strategy:
 *  - Up-to-date index  ? return immediately (no embedding).
 *  - Stale but valid v2 index exists ? delta rebuild (only re-embed changed
 *    files; unchanged files keep their existing vectors). This is the common
 *    case after a cron regenerates a subset of MD files.
 *  - No valid index (first run / schema upgrade) ? full rebuild from scratch.
 */
let inflight = null;
let cachedPayload = null;

async function ensureDocsIndex(onProgress) {
  const existing = readExistingIndex();
  if (existing && !isIndexStale(existing)) {
    cachedPayload = existing;
    return existing;
  }
  if (inflight) return inflight;

  const canDelta = existing &&
    (existing.schemaVersion || 1) >= SCHEMA_VERSION &&
    Array.isArray(existing.chunks);

  if (canDelta) {
    const delta = diffAgainstDisk(existing);
    const n = delta.added.length + delta.modified.length + delta.removed.length;
    if (n > 0) {
      console.log(`[chatbot indexer] delta rebuild: +${delta.added.length} new, ~${delta.modified.length} changed, -${delta.removed.length} removed (${existing.chunks.length - (existing.chunks||[]).filter(c=>delta.removed.includes(c?.meta?.file)||delta.modified.includes(c?.meta?.file)).length} chunks kept)`);
    }
    inflight = applyDelta(delta, onProgress).finally(() => { inflight = null; });
  } else {
    inflight = buildDocsIndex(onProgress).finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * Cheap accessor for the current index version (for downstream BM25 cache
 * invalidation in search.js). Reads the cached payload first; falls back to
 * disk if not yet warmed.
 */
function getIndexVersion() {
  if (cachedPayload && cachedPayload.indexVersion != null) return cachedPayload.indexVersion;
  const ex = readExistingIndex();
  if (ex && ex.indexVersion != null) {
    cachedPayload = ex;
    return ex.indexVersion;
  }
  return 0;
}

module.exports = {
  getEmbedder,
  getEmbedderStatus,
  buildDocsIndex,
  ensureDocsIndex,
  readExistingIndex,
  isIndexStale,
  diffAgainstDisk,
  applyDelta,
  getIndexVersion,
  parseMdHeader,
};
