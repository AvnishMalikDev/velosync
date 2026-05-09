/**
 * Hybrid retrieval over the docs index + per-user QA history.
 *
 * Pipeline per query:
 *   1. Cosine top-N over docs (and per-user QA, if provided)
 *   2. BM25 top-N over docs (keyword match for project names, JIRA keys, logins)
 *   3. Reciprocal Rank Fusion of the two doc lists; QA is cosine-only
 *   4. Apply `helpful` weighting on prior_answer rows (boost true, drop false)
 *   5. (Optional) Cross-encoder rerank of the fused pool down to top-K
 *
 * Costs:
 *   - BM25 index is built once per `indexVersion` (cheap; ~1-2 ms for 300 chunks)
 *   - Cross-encoder is lazy-loaded; first call ~2 s download, then ~30-80 ms / 20 candidates
 *
 * Privacy: QA retrieval is filtered to the calling user's email — Alice's
 * past Q&A never leaks into Bob's prompt as prior_answer context.
 */
const fs = require('fs');
const config = require('../config');
const { getEmbedder, readExistingIndex, getIndexVersion } = require('./indexer');

const RRF_K = 60;

let MiniSearchPromise = null;
function getMiniSearchCtor() {
  if (MiniSearchPromise) return MiniSearchPromise;
  MiniSearchPromise = (async () => {
    try {
      const mod = await import('minisearch');
      return mod.default || mod;
    } catch (err) {
      console.warn('[chatbot search] minisearch not installed; BM25 disabled');
      return null;
    }
  })();
  return MiniSearchPromise;
}

let rerankerPromise = null;
let rerankerReady = false;
let rerankerError = null;
function getReranker() {
  if (rerankerPromise) return rerankerPromise;
  rerankerPromise = (async () => {
    try {
      const { pipeline, env } = await import('@xenova/transformers');
      env.cacheDir = config.paths.cache;
      env.allowLocalModels = true;
      const r = await pipeline('text-classification', config.retrieval.rerankerModel, { quantized: true });
      rerankerReady = true;
      return r;
    } catch (err) {
      rerankerError = err && (err.message || String(err));
      console.warn('[chatbot search] reranker load failed; falling back to fused order:', err.message || err);
      return null;
    }
  })();
  return rerankerPromise;
}

/**
 * Fire-and-forget loader to warm the cross-encoder in the background so the
 * very first reranked query doesn't pay the ~3-5s ONNX session creation cost.
 * Safe to call multiple times — singleton-protected.
 */
function prewarmReranker() {
  if (!config.retrieval.enableReranker) return Promise.resolve(null);
  return getReranker().catch(() => null);
}

function getRerankerStatus() {
  return {
    enabled: config.retrieval.enableReranker,
    ready: rerankerReady,
    error: rerankerError,
  };
}

let bm25Cache = { version: -1, instance: null, ids: [] };

async function getBm25(docs) {
  const v = getIndexVersion();
  if (bm25Cache.version === v && bm25Cache.instance) return bm25Cache.instance;

  const Ctor = await getMiniSearchCtor();
  if (!Ctor) return null;

  const instance = new Ctor({
    fields: ['text'],
    storeFields: ['id'],
    idField: 'id',
    searchOptions: { boost: { text: 1 }, prefix: true, fuzzy: 0.15 },
  });
  const cleaned = docs
    .filter(d => d && typeof d.id === 'string' && typeof d.text === 'string')
    .map(d => ({ id: d.id, text: d.text }));
  instance.addAll(cleaned);

  bm25Cache = { version: v, instance, ids: cleaned.map(c => c.id) };
  return instance;
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}

/**
 * Read the tail of qa-history.jsonl. JSONL = one JSON per line; we read
 * the whole file (it's bounded by qaLog rotation) and keep the last `limit`
 * parseable rows.
 */
function readQaHistory(limit) {
  const p = config.paths.qaHistory;
  if (!fs.existsSync(p)) return [];
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { return []; }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const start = Math.max(0, lines.length - limit);
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    try {
      const row = JSON.parse(lines[i]);
      if (row && Array.isArray(row.vec) && row.vec.length === config.model.embeddingDim) {
        out.push(row);
      }
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

function ageDaysFrom(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!t) return null;
  const days = (Date.now() - t) / (24 * 60 * 60 * 1000);
  return Math.round(days * 10) / 10;
}

function normEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function rrfFuse(rankedLists) {
  const totals = new Map();
  for (const list of rankedLists) {
    list.forEach((id, rank) => {
      const inc = 1 / (RRF_K + rank + 1);
      totals.set(id, (totals.get(id) || 0) + inc);
    });
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Top-K hits across docs + qa-history for a given query string.
 *
 * @param {string} query
 * @param {{ k?: number, includeQa?: boolean, userEmail?: string }} [opts]
 * @returns {Promise<Array<{ score: number, source: 'docs'|'qa', text: string, meta: any }>>}
 */
async function searchTopK(query, opts) {
  const k = (opts && opts.k) || config.retrieval.topK;
  const poolK = config.retrieval.candidatePoolK;
  const includeQa = !opts || opts.includeQa !== false;
  const userEmail = normEmail(opts && opts.userEmail);

  const embed = await getEmbedder();
  const qVec = await embed(query);

  const docIdx = readExistingIndex();
  const docs = (docIdx && Array.isArray(docIdx.chunks)) ? docIdx.chunks : [];
  const qaRaw = (includeQa && userEmail)
    ? readQaHistory(config.retrieval.qaHistoryReadLimit).filter(r => normEmail(r.by) === userEmail)
    : [];
  const qa = config.retrieval.unhelpfulSkip ? qaRaw.filter(r => r.helpful !== false) : qaRaw;

  // -- Cosine on docs ------------------------------------------------------
  const docCosineScored = [];
  for (const c of docs) {
    if (!Array.isArray(c.vec)) continue;
    docCosineScored.push({ id: c.id, score: dot(qVec, c.vec), chunk: c });
  }
  docCosineScored.sort((a, b) => b.score - a.score);
  const docCosineTop = docCosineScored.slice(0, poolK);

  // -- BM25 on docs (if minisearch available + hybrid enabled) -------------
  let docBm25Top = [];
  if (config.retrieval.enableHybrid) {
    const ms = await getBm25(docs);
    if (ms) {
      try {
        const bm = ms.search(query, { combineWith: 'OR' }).slice(0, poolK);
        docBm25Top = bm.map(r => ({ id: r.id, score: r.score }));
      } catch (err) {
        console.warn('[chatbot search] bm25 query failed:', err.message || err);
      }
    }
  }

  // -- Fuse via RRF; QA stays cosine-only ----------------------------------
  const docByPair = new Map(docCosineTop.map(r => [r.id, r]));
  for (const r of docBm25Top) if (!docByPair.has(r.id)) docByPair.set(r.id, { id: r.id, score: 0, chunk: docs.find(c => c.id === r.id) });

  let docFused;
  if (docBm25Top.length) {
    const fused = rrfFuse([
      docCosineTop.map(r => r.id),
      docBm25Top.map(r => r.id),
    ]);
    docFused = fused.map(([id, score]) => ({ ...docByPair.get(id), fusedScore: score })).filter(x => x.chunk);
  } else {
    docFused = docCosineTop.map(r => ({ ...r, fusedScore: r.score }));
  }

  const qaCosineScored = qa.map(r => ({
    id: r.id || `qa#${r.at || Math.random()}`,
    score: dot(qVec, r.vec),
    qaRow: r,
  })).sort((a, b) => b.score - a.score).slice(0, poolK);

  // -- Build a unified candidate list with a normalized ranking score -----
  const candidates = [];
  docFused.forEach((d, rank) => {
    candidates.push({
      kind: 'docs',
      rank,
      preScore: d.fusedScore,
      chunk: d.chunk,
    });
  });
  qaCosineScored.forEach((q, rank) => {
    let helpfulMul = 1;
    if (q.qaRow.helpful === true) helpfulMul = config.retrieval.helpfulBoost;
    candidates.push({
      kind: 'qa',
      rank,
      preScore: q.score * helpfulMul,
      qaRow: q.qaRow,
    });
  });

  // -- Optional cross-encoder rerank ---------------------------------------
  // The Xenova v2.17 `text-classification` pipeline does NOT support
  // {text, text_pair} batched inputs (it just .split()s on the object).
  // We sidestep the pipeline and call tokenizer + model directly with
  // parallel arrays — a single forward pass scores all candidates with
  // proper [CLS] q [SEP] doc [SEP] tokenization, producing differentiated
  // logits we can sort on.
  let finalScored;
  if (config.retrieval.enableReranker && candidates.length > k) {
    const reranker = await getReranker();
    if (reranker) {
      try {
        const pairTexts = candidates.map(c =>
          c.kind === 'docs' ? c.chunk.text : `Q: ${c.qaRow.q}\nA: ${c.qaRow.a}`
        );
        const queries = new Array(candidates.length).fill(query);
        const enc = await reranker.tokenizer(queries, {
          text_pair: pairTexts,
          padding: true,
          truncation: true,
        });
        const out = await reranker.model(enc);
        const logits = Array.from(out.logits.data);
        finalScored = candidates.map((c, i) => ({
          ...c,
          rerankScore: typeof logits[i] === 'number' ? logits[i] : c.preScore,
        })).sort((a, b) => b.rerankScore - a.rerankScore);
      } catch (err) {
        console.warn('[chatbot search] reranker call failed:', err.message || err);
        finalScored = candidates.slice().sort((a, b) => b.preScore - a.preScore);
      }
    } else {
      finalScored = candidates.slice().sort((a, b) => b.preScore - a.preScore);
    }
  } else {
    finalScored = candidates.slice().sort((a, b) => b.preScore - a.preScore);
  }

  return finalScored.slice(0, k).map((c) => {
    const score = c.rerankScore != null ? c.rerankScore : c.preScore;
    if (c.kind === 'docs') {
      return {
        score,
        source: 'docs',
        text: c.chunk.text,
        meta: c.chunk.meta || {},
      };
    }
    const r = c.qaRow;
    return {
      score,
      source: 'qa',
      text: `Q: ${r.q}\nA: ${r.a}`,
      meta: {
        id: r.id || '',
        askedBy: r.by || '',
        askedAt: r.at || '',
        ageDays: ageDaysFrom(r.at),
        helpful: r.helpful == null ? null : !!r.helpful,
      },
    };
  });
}

/**
 * Format hits as a single XML-tagged context block ready to paste into a
 * system prompt. Each chunk has explicit source tagging so the LLM treats
 * docs as ground-truth and prior_answer as hints.
 */
function formatContextBlock(hits) {
  if (!hits || !hits.length) return '';
  const blocks = hits.map((h) => {
    if (h.source === 'docs') {
      const m = h.meta || {};
      const tag = `<context source="docs" file="${escapeXml(m.file || '')}" project="${escapeXml(m.project || '')}" section="${escapeXml(m.section || '')}">`;
      return `${tag}\n${h.text.trim()}\n</context>`;
    }
    const ageStr = h.meta?.ageDays != null ? ` age_days="${h.meta.ageDays}"` : '';
    const byStr = h.meta?.askedBy ? ` by="${escapeXml(h.meta.askedBy)}"` : '';
    return `<context source="prior_answer"${ageStr}${byStr}>\n${h.text.trim()}\n</context>`;
  });
  return blocks.join('\n\n');
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Multi-query retrieval: run multiple query strings (original + rewritten
 * variants + HyDE hypothetical doc), score all docs against each query
 * vector via cosine, take max-score per doc across queries, then fuse with
 * BM25 on the original query. Finally rerank the unified pool if enabled.
 *
 * Used by agent.js when CHATBOT_DISABLE_QUERY_REWRITE !== '1'.
 *
 * @param {string[]} queries  Array of query strings; queries[0] is the
 *                            original user question (used for BM25 + QA lookup).
 * @param {{ k?: number, includeQa?: boolean, userEmail?: string }} [opts]
 */
async function searchTopKMulti(queries, opts) {
  if (!queries || !queries.length) return searchTopK('', opts);
  if (queries.length === 1) return searchTopK(queries[0], opts);

  const k = (opts && opts.k) || config.retrieval.topK;
  const poolK = config.retrieval.candidatePoolK;
  const includeQa = !opts || opts.includeQa !== false;
  const userEmail = normEmail(opts && opts.userEmail);

  const embed = await getEmbedder();
  // Embed all query variants in parallel.
  const qVecs = await Promise.all(queries.map(q => embed(q)));
  const primaryVec = qVecs[0];

  const docIdx = readExistingIndex();
  const docs = (docIdx && Array.isArray(docIdx.chunks)) ? docIdx.chunks : [];
  const chunkById = new Map(docs.map(c => [c.id, c]));

  // Score each doc for each query vector; keep max cosine score across queries.
  const maxScoreById = new Map();
  for (const qVec of qVecs) {
    for (const c of docs) {
      if (!Array.isArray(c.vec)) continue;
      const score = dot(qVec, c.vec);
      if (!maxScoreById.has(c.id) || score > maxScoreById.get(c.id)) {
        maxScoreById.set(c.id, score);
      }
    }
  }

  // Sort by max cosine score, keep top poolK for BM25 fusion.
  const cosineTop = [...maxScoreById.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, poolK);

  // BM25 on primary query.
  let bm25Top = [];
  if (config.retrieval.enableHybrid) {
    const ms = await getBm25(docs);
    if (ms) {
      try {
        bm25Top = ms.search(queries[0], { combineWith: 'OR' }).slice(0, poolK).map(r => r.id);
      } catch (_) { /* ignore */ }
    }
  }

  // RRF fusion of cosine (multi-query max) and BM25.
  const cosineIds = cosineTop.map(([id]) => id);
  const byIdMap = new Map(cosineTop.map(([id, score]) => [id, score]));
  for (const id of bm25Top) if (!byIdMap.has(id)) byIdMap.set(id, 0);

  let docFused;
  if (bm25Top.length) {
    const fused = rrfFuse([cosineIds, bm25Top]);
    docFused = fused.map(([id, score]) => ({
      id, fusedScore: score, chunk: chunkById.get(id),
    })).filter(x => x.chunk);
  } else {
    docFused = cosineIds.map((id, rank) => ({
      id, fusedScore: byIdMap.get(id) || 0, rank, chunk: chunkById.get(id),
    })).filter(x => x.chunk);
  }

  // QA retrieval on primary query only (user-scoped).
  const qaRaw = (includeQa && userEmail)
    ? readQaHistory(config.retrieval.qaHistoryReadLimit).filter(r => normEmail(r.by) === userEmail)
    : [];
  const qa = config.retrieval.unhelpfulSkip ? qaRaw.filter(r => r.helpful !== false) : qaRaw;
  const qaCosineScored = qa.map(r => ({
    id: r.id || `qa#${r.at || Math.random()}`,
    score: dot(primaryVec, r.vec),
    qaRow: r,
  })).sort((a, b) => b.score - a.score).slice(0, poolK);

  // Build unified candidate list.
  const candidates = [];
  docFused.forEach((d, rank) => {
    candidates.push({ kind: 'docs', rank, preScore: d.fusedScore, chunk: d.chunk });
  });
  qaCosineScored.forEach((q) => {
    const helpfulMul = q.qaRow.helpful === true ? config.retrieval.helpfulBoost : 1;
    candidates.push({ kind: 'qa', rank: candidates.length, preScore: q.score * helpfulMul, qaRow: q.qaRow });
  });

  // Optional cross-encoder rerank (reuse same logic as searchTopK).
  let finalScored;
  if (config.retrieval.enableReranker && candidates.length > k) {
    const reranker = await getReranker();
    if (reranker) {
      try {
        const pairTexts = candidates.map(c =>
          c.kind === 'docs' ? c.chunk.text : `Q: ${c.qaRow.q}\nA: ${c.qaRow.a}`
        );
        const refQuery = queries[0];
        const enc = await reranker.tokenizer(new Array(candidates.length).fill(refQuery), {
          text_pair: pairTexts, padding: true, truncation: true,
        });
        const out = await reranker.model(enc);
        const logits = Array.from(out.logits.data);
        finalScored = candidates.map((c, i) => ({
          ...c, rerankScore: typeof logits[i] === 'number' ? logits[i] : c.preScore,
        })).sort((a, b) => b.rerankScore - a.rerankScore);
      } catch (_) {
        finalScored = candidates.slice().sort((a, b) => b.preScore - a.preScore);
      }
    } else {
      finalScored = candidates.slice().sort((a, b) => b.preScore - a.preScore);
    }
  } else {
    finalScored = candidates.slice().sort((a, b) => b.preScore - a.preScore);
  }

  return finalScored.slice(0, k).map((c) => {
    const score = c.rerankScore != null ? c.rerankScore : c.preScore;
    if (c.kind === 'docs') {
      return { score, source: 'docs', text: c.chunk.text, meta: c.chunk.meta || {} };
    }
    const r = c.qaRow;
    return {
      score, source: 'qa',
      text: `Q: ${r.q}\nA: ${r.a}`,
      meta: {
        id: r.id || '', askedBy: r.by || '', askedAt: r.at || '',
        ageDays: ageDaysFrom(r.at), helpful: r.helpful == null ? null : !!r.helpful,
      },
    };
  });
}

module.exports = {
  searchTopK,
  searchTopKMulti,
  formatContextBlock,
  readQaHistory,
  prewarmReranker,
  getRerankerStatus,
};
