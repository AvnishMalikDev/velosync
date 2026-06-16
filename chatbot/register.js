/**
 * Single mount point for the chatbot module.
 *
 * server.js calls:
 *   const chatbot = require('./chatbot/register');
 *   chatbot.register(app, { requireAuth, requireAdmin, isAdmin, openRouterFetch });
 *
 * That's the only inbound edge into this module. We add:
 *   - GET   /chatbot/ui/*           (static widget assets, admin-only — non-admins
 *                                    receive a silent 200 empty stub instead of a
 *                                    403, so the <script> tag on dashboard pages
 *                                    doesn't pollute their console)
 *   - POST  /api/chatbot/ask        (NDJSON-streaming agent endpoint, hard admin-only)
 *   - POST  /api/chatbot/feedback   ({id, helpful}) thumbs up/down on a logged QA row
 *   - PATCH /api/chatbot/answer     ({id, answer}) edit a logged QA row's answer
 *
 * Background work fired on register:
 *   - Ensure data/ folder exists.
 *   - Warm up the embedding model + build the docs index in the background.
 *   - After the initial build, start the chokidar watcher for live deltas.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');

const config = require('./config');
const agent = require('./agent');
const {
  ensureDocsIndex,
  getIndexMeta,
  getEmbedderStatus,
  getIndexVersion,
} = require('./embeddings/indexer');
const db = require('./embeddings/db');
const fileWatcher = require('./embeddings/watcher');
const vecHealer = require('./embeddings/vecHealer');
const qaLog = require('./embeddings/qaLog');
const { prewarmReranker, getRerankerStatus } = require('./embeddings/search');
const { tokenBucket, startCleanup, getStats: getRateLimitStats } = require('./rateLimit');
const { getToolCacheStats } = require('./tools');

function ensureDataDir() {
  const dir = path.dirname(config.paths.docsIndex);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function backgroundWarmup() {
  ensureDataDir();
  ensureDocsIndex(({ stage, done, total }) => {
    if (stage === 'embedding' && total > 0 && (done % 25 === 0 || done === total)) {
      console.log(`[chatbot] embedding ${done}/${total}`);
    }
  })
    .then((idx) => {
      console.log(`[chatbot] index ready: ${idx.chunkCount} chunks from ${idx.mdFileCount || 0} MD files`);
      fileWatcher.start();
      vecHealer.start();
      prewarmReranker().then((r) => {
        if (r) console.log('[chatbot] reranker pre-warmed');
      });
    })
    .catch((err) => {
      console.error('[chatbot] warmup failed:', err.message || err);
      vecHealer.start();
      fileWatcher.start();
    });
}

function buildHealthzPayload() {
  const embedder = getEmbedderStatus();
  const reranker = getRerankerStatus();
  const watcherStatus = fileWatcher.getStatus ? fileWatcher.getStatus() : null;
  const healer = vecHealer.getStatus();
  const rateLimits = getRateLimitStats();
  const toolCache = getToolCacheStats();

  const dbBytes = (() => {
    try { return db.getDbBytes(); } catch (_) { return 0; }
  })();

  let docsIndex = null;
  try {
    const idx = getIndexMeta();
    docsIndex = {
      version: idx.indexVersion || 0,
      schemaVersion: idx.schemaVersion || 0,
      chunks: idx.chunks || 0,
      files: idx.mdFileCount || 0,
      builtAt: idx.builtAt || null,
      embeddingModel: idx.embeddingModel || null,
      embeddingDim: idx.embeddingDim || null,
      bytes: dbBytes,
    };
  } catch (_) { /* ignore */ }

  let qa = { rows: 0, withVec: 0, withoutVec: 0, helpfulUp: 0, helpfulDown: 0, edited: 0, bytes: dbBytes };
  try {
    qa = { ...db.getQaStats(), bytes: dbBytes };
  } catch (_) { /* ignore */ }

  return {
    ok: !!embedder.ready,
    indexVersionInMemory: getIndexVersion(),
    embedder,
    reranker,
    docsIndex,
    qa,
    watcher: watcherStatus,
    healer,
    rateLimits,
    toolCache,
    config: {
      embeddingModel: config.model.embedding,
      chatModel: config.model.chatDefault,
      topK: config.retrieval.topK,
      candidatePoolK: config.retrieval.candidatePoolK,
      enableHybrid: !!config.retrieval.enableHybrid,
      enableReranker: !!config.retrieval.enableReranker,
      maxIters: config.agent.maxIters,
    },
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    nowIso: new Date().toISOString(),
  };
}

function makeAskHandler({ openRouterFetch }) {
  return async (req, res) => {
    const { question, model, history } = req.body || {};
    if (!question || !String(question).trim()) {
      return res.status(400).json({ error: { message: 'question is required' } });
    }

    const account = req.session?.account || {};
    const userCtx = {
      email: account.username || '',
      displayName: account.name || '',
    };

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (evt) => {
      if (res.writableEnded) return;
      try {
        res.write(JSON.stringify(evt) + '\n');
        if (typeof res.flush === 'function') res.flush();
      } catch (_) { /* client gone */ }
    };

    try {
      const result = await agent.ask({
        question: String(question),
        model: model && typeof model === 'string' ? model : undefined,
        history: Array.isArray(history) ? history : [],
        user: userCtx,
        onEvent: send,
        openRouterFetch,
      });
      send({ type: 'done', model: result.model, toolCallCount: result.toolCalls.length });
    } catch (err) {
      console.error('[chatbot] ask error:', err.message || err);
      send({ type: 'error', message: err.message || 'Internal chatbot error' });
    } finally {
      if (!res.writableEnded) res.end();
    }
  };
}

function silentAdminGate(isAdmin) {
  return (req, res, next) => {
    if (!req.session?.account) return next();
    if (isAdmin(req.session.account)) return next();
    res.setHeader('Cache-Control', 'no-store');
    const p = (req.path || '').toLowerCase();
    if (p.endsWith('.js')) return res.type('text/javascript').status(200).send('// chatbot: admin-only — disabled for this user\n');
    if (p.endsWith('.css')) return res.type('text/css').status(200).send('/* chatbot: admin-only — disabled for this user */\n');
    return res.status(403).send('Forbidden');
  };
}

function register(app, deps) {
  if (!app) throw new Error('register: app is required');
  if (!deps?.requireAuth) throw new Error('register: deps.requireAuth is required');
  if (!deps?.openRouterFetch) throw new Error('register: deps.openRouterFetch is required');

  const { requireAuth, requireAdmin, isAdmin, openRouterFetch, skipWarmup } = deps;
  const passThrough = (_req, _res, next) => next();
  const apiAdminGate = requireAdmin || passThrough;
  const staticAdminGate = typeof isAdmin === 'function' ? silentAdminGate(isAdmin) : passThrough;

  const askLimiter = tokenBucket({ key: 'ask', capacity: 12, windowMs: 60_000 });
  const feedbackLimiter = tokenBucket({ key: 'fb', capacity: 60, windowMs: 60_000 });
  const answerLimiter = tokenBucket({ key: 'edit', capacity: 60, windowMs: 60_000 });
  const healthzLimiter = tokenBucket({ key: 'hz', capacity: 30, windowMs: 60_000 });
  startCleanup();

  app.use('/chatbot/ui', requireAuth, staticAdminGate, express.static(path.join(__dirname, 'ui')));

  app.get('/api/chatbot/healthz', requireAuth, apiAdminGate, healthzLimiter, (req, res) => {
    try {
      const payload = buildHealthzPayload();
      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    } catch (err) {
      console.error('[chatbot] healthz error:', err.message || err);
      res.status(500).json({ ok: false, error: err.message || 'healthz failed' });
    }
  });

  app.post('/api/chatbot/ask', requireAuth, apiAdminGate, askLimiter, makeAskHandler({ openRouterFetch }));

  app.post('/api/chatbot/feedback', requireAuth, apiAdminGate, feedbackLimiter, express.json({ limit: '8kb' }), async (req, res) => {
    const { id, helpful } = req.body || {};
    const by = req.session?.account?.username || '';
    if (!id || typeof id !== 'string') return res.status(400).json({ error: { message: 'id is required' } });
    if (helpful !== true && helpful !== false && helpful !== null) {
      return res.status(400).json({ error: { message: 'helpful must be true | false | null' } });
    }
    try {
      const out = await qaLog.setHelpful(id, helpful, by);
      if (!out.ok) {
        const status = out.error === 'not_found' ? 404 : out.error === 'forbidden' ? 403 : 400;
        return res.status(status).json({ error: { message: out.error } });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[chatbot] feedback error:', err.message || err);
      res.status(500).json({ error: { message: 'feedback failed' } });
    }
  });

  app.patch('/api/chatbot/answer', requireAuth, apiAdminGate, answerLimiter, express.json({ limit: '32kb' }), async (req, res) => {
    const { id, answer } = req.body || {};
    const by = req.session?.account?.username || '';
    if (!id || typeof id !== 'string') return res.status(400).json({ error: { message: 'id is required' } });
    if (!answer || typeof answer !== 'string') return res.status(400).json({ error: { message: 'answer is required' } });
    try {
      const out = await qaLog.editAnswer(id, answer, by);
      if (!out.ok) {
        const status = out.error === 'not_found' ? 404 : out.error === 'forbidden' ? 403 : 400;
        return res.status(status).json({ error: { message: out.error } });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[chatbot] edit error:', err.message || err);
      res.status(500).json({ error: { message: 'edit failed' } });
    }
  });

  if (!skipWarmup) {
    backgroundWarmup();
  }

  const adminMode = (requireAdmin && isAdmin) ? 'admin-only' : 'open';
  console.log(`[chatbot] registered (${adminMode}): /chatbot/ui (static) + /api/chatbot/ask + /feedback + /answer + /healthz`);
}

module.exports = { register };
