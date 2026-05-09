# Chatbot Migration Guide

You are integrating the `chatbot/` folder (which has just been copied) into a host
Express + Azure-AD dashboard project. This document is the complete checklist —
follow it top to bottom.

The chatbot is a self-contained RAG agent that runs alongside the host
dashboard. It is **admin-only** at the HTTP layer, depends on the host's
existing auth + RBAC, and reuses the host's `jira-md-export/` helpers for
live tool calls.

---

## 1. Prerequisites in the host project

Verify each of these exists before you wire anything up. If something is
missing, that part of the chatbot will degrade gracefully (most often: the
related tool returns a clean error envelope and the LLM tells the user the
data source is unavailable). But for full functionality you want all of them.

| Requirement | Where | Required? |
|---|---|---|
| Express app with session middleware | `server.js` | **Yes** |
| `requireAuth(req, res, next)` middleware | `server.js` | **Yes** |
| `req.session.account = { username, name }` (Azure AD MSAL pattern) | `server.js` | **Yes** |
| `requireAdmin` middleware + `rVeloSynclveRoleForAccount(account) -> { role: 'admin' \| 'viewer', ... }` | `server.js` | Recommended (if missing, chatbot falls back to "open" mode and warns in the boot log) |
| `openRouterFetch(body, key, referer)` async helper that POSTs to `https://openrouter.ai/api/v1/chat/completions` and rVeloSynclves to `{ status, data }` | `server.js` | **Yes** (chatbot does NOT make HTTP itself; the host injects this) |
| `OPENROUTER_API_KEY` set in root `.env` | `.env` | **Yes** |
| `jira-md-export/.env` with JIRA + GitHub creds | sibling folder | **Yes** for JIRA + GitHub tools |
| `jira-md-export/get-github-metrics.js`, `get-confluence-data.js`, `get-testrail-data.js` | sibling folder | Required for `richMetrics`, Confluence, and TestRail tools |
| `output/copilotdata.json`, `output/cursordata.json` | sibling folder | Required for Copilot/Cursor tools |
| `output/rVeloSyncurce-directory.json` | sibling folder | Required for `lookup_person` and Confluence tool |
| `jira-md-export/projects.json` | sibling folder | Required for TestRail tool by `projectName` |
| `output/*.md` sprint reports | sibling folder | Required for the embedding index (no MDs → docs retrieval is empty, but agent still works) |

If `requireAdmin` / `rVeloSynclveRoleForAccount` don't exist in this host, **stop
and ask the user**: do they want chatbot to be open to all authenticated
users, or do they want to add a minimal RBAC layer first? The chatbot's
admin gate is opt-in; without it the bubble appears for everyone.

---

## 2. Install the chatbot dependency

```bash
cd chatbot
npm install
```

This installs `@xenova/transformers` (the only runtime dep) into
`chatbot/node_modules/`. It is a CPU-only ONNX runtime — no GPU, no external
service. First load downloads the `Xenova/all-MiniLM-L6-v2` model (~25MB)
to `chatbot/node_modules/@xenova/transformers/.cache/`.

If the host machine is offline / behind a corporate proxy, the first
embedding call may fail with `ENOTFOUND huggingface.co`. The chatbot fails
soft (log + agent continues with no docs context). To pre-cache the model,
run on a machine with internet access first, then ship the `.cache/` folder.

---

## 3. Wire `chatbot.register()` into the host's `server.js`

Find a spot **after** these are defined: `requireAuth`, `requireAdmin`,
`rVeloSynclveRoleForAccount`, `openRouterFetch`. Then add this block:

```javascript
// ── Chatbot module (self-contained in chatbot/; remove this block + the chatbot folder to uninstall)
const chatbot = require('./chatbot/register');
chatbot.register(app, {
  requireAuth,
  requireAdmin,                                                          // optional — omit for open mode
  isAdmin: (account) => rVeloSynclveRoleForAccount(account || {}).role === 'admin',  // optional — pairs with requireAdmin
  openRouterFetch,
});
```

After registering, the host now exposes:

- `GET  /chatbot/ui/*`     — widget assets, **silently** stubbed-out for non-admins
- `POST /api/chatbot/ask`  — NDJSON-streaming agent, **hard 403** for non-admins

On boot you should see:

```
[chatbot] registered (admin-only): /chatbot/ui (static) + /api/chatbot/ask (agent)
[chatbot] embedding 25/N  ...  [chatbot] index ready: N chunks from M MD files
```

If you see `(open)` instead of `(admin-only)`, you forgot to pass
`requireAdmin` and `isAdmin`. Anyone authenticated will get the bubble.

---

## 4. Files to create / modify outside `chatbot/`

The chatbot widget reuses a shared model-picker that the rest of the
dashboard also benefits from. Add these even if the dashboard doesn't have
its own model dropdowns yet — the widget needs the `/api/openrouter/models`
endpoint.

### 4a. `js/model-picker.js` (create)

```javascript
/**
 * Shared model dropdown helper for OpenRouter model selection.
 * Used by any <select> on the host pages plus the chatbot widget.
 * The 'aiModel' localStorage key is shared so the user's choice carries.
 */
(function (global) {
    const ENDPOINT = '/api/openrouter/models';
    const FALLBACK = [
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', default: true },
        { id: 'openai/gpt-5-mini',           name: 'GPT-5 Mini',        default: false },
        { id: 'google/gemini-2.5-flash',     name: 'Gemini 2.5 Flash',  default: false },
    ];

    let cachedItems = null;
    let inflight = null;

    async function loadItems(filter) {
        if (cachedItems) return filter ? cachedItems.filter(filter) : cachedItems;
        if (!inflight) {
            inflight = fetch(ENDPOINT, { credentials: 'same-origin' })
                .then(r => r.ok ? r.json() : Promise.reject(new Error('models endpoint ' + r.status)))
                .then(j => Array.isArray(j.items) && j.items.length ? j.items : FALLBACK)
                .catch(() => FALLBACK);
        }
        cachedItems = await inflight;
        return filter ? cachedItems.filter(filter) : cachedItems;
    }

    async function populateModelPicker(selectEl, opts) {
        if (!selectEl) return;
        const storageKey = (opts && opts.storageKey) || 'aiModel';
        const filter = opts && opts.filter;
        const items = await loadItems(filter);
        if (!items.length) return;

        selectEl.innerHTML = items
            .map(m => `<option value="${m.id}">${m.name}</option>`)
            .join('');

        let remembered = null;
        try { remembered = localStorage.getItem(storageKey); } catch (_) { /* private mode */ }
        const fallback = (items.find(m => m.default) || items[0]).id;
        selectEl.value = (remembered && items.some(m => m.id === remembered)) ? remembered : fallback;

        if (!selectEl.dataset.modelPickerWired) {
            selectEl.addEventListener('change', () => {
                try { localStorage.setItem(storageKey, selectEl.value); } catch (_) { /* private mode */ }
            });
            selectEl.dataset.modelPickerWired = '1';
        }
    }

    global.populateModelPicker = populateModelPicker;
    global.loadOpenRouterModels = loadItems;
})(window);
```

### 4b. `js/openrouter-allowlist.json` (create)

This is the curated list of OpenRouter slugs the dropdown will offer. Edit
freely; entries that 404 from OpenRouter on the day are silently dropped.

```json
[
  { "id": "anthropic/claude-sonnet-4.6", "name": "Claude Sonnet 4.6", "family": "Anthropic", "default": true  },
  { "id": "anthropic/claude-opus-4.7",   "name": "Claude Opus 4.7",   "family": "Anthropic", "default": false },
  { "id": "anthropic/claude-haiku-4.5",  "name": "Claude Haiku 4.5",  "family": "Anthropic", "default": false },
  { "id": "openai/gpt-5",                "name": "GPT-5",             "family": "OpenAI",    "default": false },
  { "id": "openai/gpt-5-mini",           "name": "GPT-5 Mini",        "family": "OpenAI",    "default": false },
  { "id": "openai/gpt-4.1",              "name": "GPT-4.1",           "family": "OpenAI",    "default": false },
  { "id": "google/gemini-2.5-pro",       "name": "Gemini 2.5 Pro",    "family": "Google",    "default": false },
  { "id": "google/gemini-2.5-flash",     "name": "Gemini 2.5 Flash",  "family": "Google",    "default": false },
  { "id": "x-ai/grok-4",                 "name": "Grok 4",            "family": "xAI",       "default": false }
]
```

### 4c. `GET /api/openrouter/models` endpoint (add to `server.js`)

This proxy hits OpenRouter once a day, intersects with the allow-list, and
serves the merged result to the dropdowns + chatbot widget. Drop this near
the other `/api/...` routes in `server.js`:

```javascript
const OPENROUTER_ALLOWLIST_PATH = path.join(__dirname, 'js', 'openrouter-allowlist.json');
let openRouterModelsCache = null;
const OPENROUTER_MODELS_TTL_MS = 24 * 60 * 60 * 1000;

function fetchOpenRouterModelsRaw(key) {
  return new Promise((rVeloSynclve, reject) => {
    const allowInsecure = process.env.ALLOW_INSECURE_TLS === '1' || process.env.ALLOW_INSECURE_TLS === 'true';
    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/models',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key.trim()}`,
        'HTTP-Referer': 'https://localhost',
        'X-Title': 'Dashboard',
      },
      ...(allowInsecure && { agent: new https.Agent({ rejectUnauthorized: false }) }),
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (ch) => { data += ch; });
      res.on('end', () => {
        try { rVeloSynclve({ status: res.statusCode, data: data ? JSON.parse(data) : {} }); }
        catch (e) { reject(new Error('Invalid JSON from OpenRouter /models')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function readOpenRouterAllowlist() {
  try {
    const raw = fs.readFileSync(OPENROUTER_ALLOWLIST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

app.get('/api/openrouter/models', requireAuth, async (req, res) => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key === 'your-openrouter-api-key-here') {
    return res.status(503).json({ error: { message: 'OpenRouter API key not configured. Set OPENROUTER_API_KEY in .env.' } });
  }

  const force = req.query.force === '1';
  if (!force && openRouterModelsCache && (Date.now() - openRouterModelsCache.fetchedAt) < OPENROUTER_MODELS_TTL_MS) {
    return res.json({ items: openRouterModelsCache.items, cachedAt: openRouterModelsCache.fetchedAt, fromCache: true });
  }

  const allowlist = readOpenRouterAllowlist();
  if (!allowlist.length) {
    return res.status(500).json({ error: { message: 'js/openrouter-allowlist.json missing or empty' } });
  }

  try {
    const { status, data } = await fetchOpenRouterModelsRaw(key);
    if (status < 200 || status >= 300) {
      const msg = data?.error?.message || `OpenRouter /models returned ${status}`;
      if (openRouterModelsCache) {
        return res.json({ items: openRouterModelsCache.items, cachedAt: openRouterModelsCache.fetchedAt, fromCache: true, stale: true, error: msg });
      }
      return res.status(status).json({ error: { message: msg } });
    }

    const liveById = new Map((data.data || []).map(m => [m.id, m]));
    const wantTools = req.query.capability === 'tools';
    const items = allowlist
      .map(entry => {
        const live = liveById.get(entry.id);
        if (!live) return null;
        const supportsTools = Array.isArray(live.supported_parameters) && live.supported_parameters.includes('tools');
        if (wantTools && !supportsTools) return null;
        return {
          id: entry.id,
          name: entry.name,
          family: entry.family,
          default: !!entry.default,
          contextLength: live.context_length || null,
          pricing: live.pricing || null,
          supportsTools,
        };
      })
      .filter(Boolean);

    openRouterModelsCache = { fetchedAt: Date.now(), items };
    res.json({ items, cachedAt: openRouterModelsCache.fetchedAt, fromCache: false });
  } catch (err) {
    if (openRouterModelsCache) {
      return res.json({ items: openRouterModelsCache.items, cachedAt: openRouterModelsCache.fetchedAt, fromCache: true, stale: true, error: err.message });
    }
    res.status(500).json({ error: { message: err.message || 'Failed to fetch OpenRouter models' } });
  }
});
```

If the host already serves the `js/` folder via `express.static` then no extra
mount is needed. Otherwise add `app.use('/js', express.static(path.join(__dirname, 'js')));`.

---

## 5. HTML wiring (per page that should show the bubble)

In every HTML file where you want the chatbot bubble to appear (typically
`index.html` and any page-detail file), add these two `<script>` tags right
before `</body>`:

```html
<script src="/js/model-picker.js" defer></script>
<!-- Chatbot module — remove this line + the chatbot/ folder to uninstall -->
<script src="/chatbot/ui/widget.js" defer></script>
```

If the page already has a model `<select>` with hardcoded `<option>` entries,
strip the options (the picker fills them dynamically) and add an init call in
the corresponding page script:

```javascript
if (typeof populateModelPicker === 'function') {
    populateModelPicker(document.getElementById('YOUR_SELECT_ID'), { storageKey: 'aiModel' });
}
```

`storageKey: 'aiModel'` is shared between the dropdown and the chatbot
widget — keep it consistent so the user's last-picked model carries across
all surfaces.

---

## 6. Theme support

The chatbot widget auto-adapts to **light** vs **dark** themes by reacting
to the class on `<html>`:

- Dark (default): nothing required
- Light: ensure the host toggles `<html class="theme-light">` for light mode
  (this is the same convention the source project uses; if your host uses a
  different class, edit the `html.theme-light .cb-*` selectors in
  `chatbot/ui/widget.css` accordingly)

---

## 7. Environment variables

Append to the host's `.env` (or `.env.example`):

```
# Chatbot (chatbot/ folder)
OPENROUTER_API_KEY=sk-or-v1-...                 # required (already set if you use the OpenRouter proxy)
CHATBOT_MODEL=anthropic/claude-sonnet-4.6       # optional default
CHATBOT_TOP_K=5                                 # optional retrieval cap
CHATBOT_MAX_ITERS=4                             # optional max tool-calling rounds
```

The chatbot also reads `jira-md-export/.env` directly (for JIRA, GitHub,
Confluence, TestRail creds) — you do **not** need to duplicate those keys in
the root `.env`.

---

## 8. Restart and smoke-test

```bash
pm2 restart <name>      # or: node server.js
```

Watch the boot log for these lines (they prove the chatbot is live):

```
[chatbot] registered (admin-only): /chatbot/ui (static) + /api/chatbot/ask (agent)
[chatbot] embedding 25/180   ←  warm-up progress, expect a few seconds
[chatbot] index ready: 180 chunks from 24 MD files
```

Then open the dashboard in a browser and verify:

| Check | Expected |
|---|---|
| Login as admin → bottom-right of any wired page | Purple bubble visible |
| Click bubble → panel opens | Suggestions list appears |
| Pick a model from the dropdown | Persists across page reloads |
| Ask "What is HDE's completion rate this sprint?" (or any project you have MDs for) | Streamed answer using retrieved context |
| Ask "Open JIRA bugs in HDE right now" | Tool timeline shows `query_jira` then a final answer |
| Login as non-admin (or unauth) | **No bubble** anywhere; console clean (no 403/404 errors from `/chatbot/ui/widget.js`) |
| `data/qa-history.jsonl` after a successful Q | Has one new line with `{ q, a, vec, by, model, at }` |
| Repeat the same question | Tool timeline shows "Retrieved N relevant chunks"; the prior answer is in context |

---

## 9. Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `404 /api/chatbot/ask` | Host server didn't pick up the new register call | `pm2 restart` (Node didn't reload) |
| `404 /api/openrouter/models` | Step 4c skipped | Add the endpoint to `server.js` |
| Bubble doesn't appear for admins, console shows `widget.js: 200 OK` but blank body | The silent-stub gate is matching admins as non-admins. The `isAdmin` predicate is wrong. | Open `register.js` and inspect what `isAdmin` is being called with. Probably `rVeloSynclveRoleForAccount` expects a different account shape. |
| Bubble appears for **non**-admins | `requireAdmin` / `isAdmin` not passed to `chatbot.register` | Pass them in step 3; redeploy |
| `[chatbot] warmup failed: fetch failed (huggingface.co)` | Behind corp proxy, first-time embedding model download blocked | Pre-cache `chatbot/node_modules/@xenova/transformers/.cache/` from a machine with internet, ship it |
| Tool calls all return `{ error: "... not configured" }` | `jira-md-export/.env` missing keys | Populate it; the chatbot reads creds from there directly |
| LLM responses say "no data found" for everything | Embedding index empty (no `output/*.md` files) | Run `node jira-md-export/index.js` to generate sprint MDs first |
| Two admins on the same browser see each other's chats | sessionStorage leak across logins (very old widget.js cached) | Hard-reload (Ctrl+F5). New widget.js namespaces history per logged-in user. |

---

## 10. Removal (zero residue)

1. Delete the `chatbot/` folder.
2. Remove the `chatbot.register(app, ...)` block from `server.js` (step 3).
3. Remove the `<script src="/chatbot/ui/widget.js">` lines from any HTML files (step 5).
4. (Optional) Remove the `js/openrouter-allowlist.json`, `js/model-picker.js`, and `GET /api/openrouter/models` endpoint **only if** they aren't used by the rest of the dashboard. They are independent of the chatbot.
5. (Optional) Remove the `CHATBOT_*` env vars from `.env`.

Done. No database migrations to undo, no global state to clean up.

---

## 11. Architecture (for the AI / reviewer)

```
chatbot/                                 ← single self-contained module
├── register.js          ← THE ONLY external entrypoint; mounts /chatbot/ui + /api/chatbot/ask
├── agent.js             ← LLM tool-calling loop; streams NDJSON events
├── config.js            ← reads root .env and jira-md-export/.env
├── tools/index.js       ← 7 tools with consistent error envelope { error, source, hint, retryable }
├── embeddings/
│   ├── indexer.js       ← Xenova MiniLM-L6-v2; chunks output/*.md by ### headings
│   ├── search.js        ← cosine top-K across docs index + per-user qa-history
│   └── qaLog.js         ← appends successful Q+A to data/qa-history.jsonl with rotation
├── ui/
│   ├── widget.js        ← floating bubble, vanilla JS, NDJSON streaming
│   └── widget.css       ← scoped .cb-* classes; light + dark theme
├── data/                ← created at runtime
│   ├── docs.index.json  ← embedding index (regenerated when output/*.md changes)
│   └── qa-history.jsonl ← compounding memory; rotated at 1000 lines
└── README.md            ← module overview
```

**Privacy guarantees**:
- `qa-history.jsonl` is shared on disk (admins-only filesystem), but at
  retrieval time `searchTopK` filters rows where `by !== currentUser`. Alice
  never sees Bob's prior Q&A surface as `prior_answer` context.
- UI history (`sessionStorage`) is namespaced as `cbChatHistory:<email>` so
  logout/login in the same browser tab can't leak chats between users.

**Failure handling**:
- Every tool returns `{ error, source, hint, retryable }` on failure; the
  system prompt instructs the LLM to acknowledge failures plainly and
  suggest fallbacks ("I couldn't reach JIRA — want me to check the latest
  sprint MD instead?").
- LLM-side failures (OpenRouter 4xx/5xx, network) produce a clean assistant
  message with status-specific guidance instead of crashing the loop.

That's the whole module. Good luck.
