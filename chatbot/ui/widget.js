/**
 * Floating-bubble chatbot widget.
 *
 * Self-injects into the page, mounts a 56px FAB bottom-right that expands to a
 * 400×620 chat panel, calls /api/chatbot/ask with NDJSON streaming, renders
 * the agent's tool-calling timeline, the final answer (token-by-token via
 * assistant_chunk events), per-message thumbs/copy/edit actions, and follow-up
 * suggestion chips returned post-answer.
 *
 * The model dropdown reuses the same `aiModel` localStorage key as the org
 * dashboard and project-detail page, so the user's last choice carries over.
 *
 * No build step. No framework. Vanilla JS.
 */
(function () {
    'use strict';
    if (window.__cbChatbotMounted) return;
    window.__cbChatbotMounted = true;

    const CSS_HREF = '/chatbot/ui/widget.css';
    const ENDPOINT = '/api/chatbot/ask';
    const FEEDBACK_ENDPOINT = '/api/chatbot/feedback';
    const ANSWER_ENDPOINT = '/api/chatbot/answer';
    const MODELS_ENDPOINT = '/api/openrouter/models';
    const STORAGE_KEY = 'aiModel';
    let historyKey = 'cbChatHistory';

    const SUGGESTIONS = [
        'Top 5 Copilot users this month',
        'Cursor leaderboard sorted by acceptance rate',
        'TestRail metrics for HDE last sprint',
        'Open JIRA bugs in HDE right now',
        'Org-wide Copilot adoption summary',
    ];

    function injectCss() {
        if (document.querySelector(`link[href="${CSS_HREF}"]`)) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = CSS_HREF;
        document.head.appendChild(link);
    }

    function el(tag, attrs, ...children) {
        const node = document.createElement(tag);
        if (attrs) {
            for (const k in attrs) {
                if (k === 'class') node.className = attrs[k];
                else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
                else if (k === 'html') node.innerHTML = attrs[k];
                else node.setAttribute(k, attrs[k]);
            }
        }
        children.flat().forEach(c => {
            if (c == null) return;
            node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
        return node;
    }

    function buildPanel() {
        const root = el('div', { class: 'cb-root' });

        const fab = el('button', {
            class: 'cb-fab',
            'aria-label': 'Open AI chat',
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
        });

        const panel = el('div', { class: 'cb-panel cb-hidden' });

        const header = el('div', { class: 'cb-header' },
            el('div', { class: 'cb-header-title' }, 'AI Assistant'),
            el('div', { class: 'cb-header-actions' },
                el('button', {
                    class: 'cb-icon-btn cb-clear-btn',
                    title: 'Clear conversation',
                    'aria-label': 'Clear conversation',
                    html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
                }),
                el('button', {
                    class: 'cb-icon-btn cb-popout-btn',
                    title: 'Pop out to new window',
                    'aria-label': 'Pop out to new window',
                    html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
                }),
                el('button', {
                    class: 'cb-icon-btn cb-fullscreen-btn',
                    title: 'Full screen',
                    'aria-label': 'Full screen',
                    html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
                }),
                el('button', {
                    class: 'cb-icon-btn cb-close-btn',
                    title: 'Close',
                    'aria-label': 'Close chat',
                    html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
                }),
            ),
        );

        const modelBar = el('div', { class: 'cb-model-bar' },
            el('label', null, 'Model'),
            el('select', { class: 'cb-model-select' }),
        );

        const messages = el('div', { class: 'cb-messages' });

        const empty = el('div', { class: 'cb-empty' },
            el('div', null, 'Hi! Ask me about projects, sprints, JIRA, GitHub, Copilot, Cursor, Confluence, or TestRail.'),
            el('div', { class: 'cb-empty-suggestions' },
                ...SUGGESTIONS.map(s => el('button', { class: 'cb-suggestion', 'data-prompt': s }, s)),
            ),
        );
        messages.appendChild(empty);

        const inputBar = el('div', { class: 'cb-input-bar' },
            el('textarea', { class: 'cb-input', rows: '1', placeholder: 'Ask anything…' }),
            el('button', { class: 'cb-send' }, 'Send'),
        );

        panel.appendChild(header);
        panel.appendChild(modelBar);
        panel.appendChild(messages);
        panel.appendChild(inputBar);

        root.appendChild(fab);
        root.appendChild(panel);
        document.body.appendChild(root);

        return {
            root, fab, panel, messages, empty,
            modelSelect: modelBar.querySelector('.cb-model-select'),
            input: inputBar.querySelector('.cb-input'),
            sendBtn: inputBar.querySelector('.cb-send'),
            clearBtn: header.querySelector('.cb-clear-btn'),
            closeBtn: header.querySelector('.cb-close-btn'),
            popoutBtn: header.querySelector('.cb-popout-btn'),
            fullscreenBtn: header.querySelector('.cb-fullscreen-btn'),
        };
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }
    function renderMarkdown(text) {
        let html = escapeHtml(text);
        html = html.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre><code>${code}</code></pre>`);
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/(^|\s)\*([^*]+)\*(\s|$)/g, '$1<em>$2</em>$3');
        html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        html = html.replace(/^-\s+(.+)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>(?:\n<li>.*<\/li>)*)/g, '<ul>$1</ul>');
        html = html.replace(/<\/ul>\n?<ul>/g, '');
        html = html.replace(/\n\n/g, '<br><br>');
        html = html.replace(/(?<!>)\n(?!<)/g, '<br>');
        return html;
    }

    async function loadModels(selectEl) {
        const fallback = [{ id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', default: true }];
        let items = fallback;
        try {
            const r = await fetch(MODELS_ENDPOINT, { credentials: 'same-origin' });
            if (r.ok) {
                const j = await r.json();
                if (Array.isArray(j.items) && j.items.length) items = j.items;
            }
        } catch (_) { /* fallback */ }
        selectEl.innerHTML = items.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
        let remembered = null;
        try { remembered = localStorage.getItem(STORAGE_KEY); } catch (_) { /* private mode */ }
        const fb = (items.find(m => m.default) || items[0]).id;
        selectEl.value = (remembered && items.some(m => m.id === remembered)) ? remembered : fb;
        selectEl.addEventListener('change', () => {
            try { localStorage.setItem(STORAGE_KEY, selectEl.value); } catch (_) { /* private mode */ }
        });
    }

    function loadHistory() {
        try {
            const raw = sessionStorage.getItem(historyKey);
            return raw ? JSON.parse(raw) : [];
        } catch (_) { return []; }
    }
    function saveHistory(h) {
        try { sessionStorage.setItem(historyKey, JSON.stringify(h)); } catch (_) { /* ignore */ }
    }

    async function streamAsk({ question, model, history, onEvent }) {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ question, model, history }),
        });
        if (!res.ok || !res.body) {
            const text = await res.text().catch(() => '');
            let msg = `Server returned ${res.status}`;
            try {
                const j = JSON.parse(text);
                msg = j?.error?.message || msg;
            } catch (_) { /* ignore */ }
            throw new Error(msg);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                try { onEvent(JSON.parse(line)); } catch (_) { /* malformed line */ }
            }
        }
        if (buf.trim()) {
            try { onEvent(JSON.parse(buf)); } catch (_) { /* ignore tail */ }
        }
    }

    async function ensureAdmin() {
        try {
            const res = await fetch('/api/me', { credentials: 'include', headers: { Accept: 'application/json' } });
            if (!res.ok) return null;
            const data = await res.json();
            if (!data || !data.authenticated || data.role !== 'admin') return null;
            return { username: data.username || '', name: data.name || '' };
        } catch (_) {
            return null;
        }
    }

    function userKeySuffix(u) {
        if (!u || !u.username) return 'anon';
        return String(u.username).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    }

    async function init() {
        const me = await ensureAdmin();
        if (!me) return;
        historyKey = `cbChatHistory:${userKeySuffix(me)}`;
        injectCss();
        const ui = buildPanel();
        loadModels(ui.modelSelect);

        const history = loadHistory();
        if (history.length) {
            ui.empty.classList.add('cb-hidden');
            history.forEach(m => {
                const msgEl = addMessage(m.role, m.content);
                // Re-activate thumbs/edit on restored assistant messages whose
                // qaId we'd already saved last session.
                if (m.role === 'assistant' && m.qaId) attachQaId(msgEl, m.qaId);
            });
        }

        ui.fab.addEventListener('click', () => {
            ui.fab.classList.add('cb-hidden');
            ui.panel.classList.remove('cb-hidden');
            setTimeout(() => ui.input.focus(), 50);
        });
        ui.closeBtn.addEventListener('click', () => {
            ui.panel.classList.add('cb-hidden');
            ui.fab.classList.remove('cb-hidden');
        });
        ui.clearBtn.addEventListener('click', () => {
            history.length = 0;
            saveHistory(history);
            ui.messages.innerHTML = '';
            ui.messages.appendChild(ui.empty);
            ui.empty.classList.remove('cb-hidden');
        });

        ui.empty.addEventListener('click', (e) => {
            const btn = e.target.closest('.cb-suggestion');
            if (!btn) return;
            ui.input.value = btn.getAttribute('data-prompt') || '';
            ui.input.focus();
        });

        ui.input.addEventListener('input', () => {
            ui.input.style.height = 'auto';
            ui.input.style.height = Math.min(120, ui.input.scrollHeight) + 'px';
        });
        ui.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });
        ui.sendBtn.addEventListener('click', send);

        // -- View-mode controls (fullscreen + popout) -------------------------

        const ICON_FULLSCREEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
        const ICON_EXIT_FULLSCREEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>';

        function setFullscreen(on) {
            ui.panel.classList.toggle('cb-fullscreen', on);
            ui.fullscreenBtn.innerHTML = on ? ICON_EXIT_FULLSCREEN : ICON_FULLSCREEN;
            ui.fullscreenBtn.title = on ? 'Exit full screen' : 'Full screen';
            ui.fullscreenBtn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
        }

        ui.fullscreenBtn.addEventListener('click', () => {
            setFullscreen(!ui.panel.classList.contains('cb-fullscreen'));
        });

        // Escape key: exit fullscreen first; if already normal-size, close panel.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (ui.panel.classList.contains('cb-fullscreen')) {
                setFullscreen(false);
            } else if (!ui.panel.classList.contains('cb-hidden')) {
                ui.panel.classList.add('cb-hidden');
                ui.fab.classList.remove('cb-hidden');
            }
        });

        ui.popoutBtn.addEventListener('click', () => {
            const popup = window.open(
                '/chatbot/ui/standalone.html',
                'cb-popout',
                'width=440,height=700,resizable=yes,scrollbars=no,toolbar=no,menubar=no,location=no,status=no'
            );
            if (popup) {
                // Collapse the inline panel once it's been popped out.
                ui.panel.classList.add('cb-hidden');
                ui.fab.classList.remove('cb-hidden');
            }
        });

        // When running inside the pop-out window: auto-open, go fullscreen,
        // hide the pop-out button (already in its own window) AND the
        // fullscreen toggle (the browser's native window controls serve that
        // role here — showing our button too causes a visual conflict with the
        // browser's maximize button), and wire close to window.close().
        const isPopout = window.name === 'cb-popout';
        if (isPopout) {
            ui.fab.classList.add('cb-hidden');
            ui.panel.classList.remove('cb-hidden');
            setFullscreen(true);
            ui.popoutBtn.classList.add('cb-hidden');
            ui.fullscreenBtn.classList.add('cb-hidden');
            ui.closeBtn.addEventListener('click', () => window.close(), { once: true });
            setTimeout(() => ui.input.focus(), 50);
        }

        // Close panel when clicking anywhere outside the widget root.
        document.addEventListener('click', (e) => {
            if (isPopout) return;                                      // own window — no outside
            if (ui.panel.classList.contains('cb-hidden')) return;      // already closed
            if (ui.panel.classList.contains('cb-fullscreen')) return;  // fullscreen owns the screen
            if (ui.root.contains(e.target)) return;                    // click was inside widget
            ui.panel.classList.add('cb-hidden');
            ui.fab.classList.remove('cb-hidden');
        }, { capture: false });

        // -- Render helpers ---------------------------------------------------

        /**
         * Build a message bubble. For assistant messages, attaches a content
         * holder + an action row (thumbs / copy / edit) that is hidden until
         * the message has a `qaId` attached (i.e., the server confirmed the
         * row was logged).
         */
        function addMessage(role, content) {
            const div = el('div', { class: `cb-msg cb-msg-${role}` });
            const roleLabel = el('div', { class: 'cb-msg-role' }, role === 'user' ? 'You' : role === 'assistant' ? 'AI' : 'Error');
            const body = el('div', { class: 'cb-msg-body' });
            body.innerHTML = role === 'user' ? escapeHtml(content) : renderMarkdown(content || '');
            div.appendChild(roleLabel);
            div.appendChild(body);
            if (role === 'assistant') {
                div.appendChild(buildActions(div));
            }
            ui.messages.appendChild(div);
            ui.messages.scrollTop = ui.messages.scrollHeight;
            return div;
        }

        /**
         * Build the per-assistant-message action row. Visible immediately but
         * in a "pending" (greyed, click-disabled) state until the server
         * confirms the QA row was logged via the `qa_id` event. This way the
         * user always sees the affordance even if logQA briefly fails or is
         * delayed.
         */
        function buildActions(msgEl) {
            const wrap = el('div', { class: 'cb-msg-actions cb-msg-actions-pending' });

            const thumbUp = el('button', {
                class: 'cb-act-btn cb-act-up',
                title: 'Helpful',
                'aria-label': 'Helpful',
                html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>',
            });
            const thumbDown = el('button', {
                class: 'cb-act-btn cb-act-down',
                title: 'Not helpful',
                'aria-label': 'Not helpful',
                html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zM17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/></svg>',
            });
            const copyBtn = el('button', {
                class: 'cb-act-btn cb-act-copy',
                title: 'Copy',
                'aria-label': 'Copy',
                html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
            });
            const editBtn = el('button', {
                class: 'cb-act-btn cb-act-edit',
                title: 'Edit answer',
                'aria-label': 'Edit answer',
                html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
            });

            thumbUp.addEventListener('click', () => sendFeedback(msgEl, true));
            thumbDown.addEventListener('click', () => sendFeedback(msgEl, false));
            copyBtn.addEventListener('click', () => copyAnswer(msgEl));
            editBtn.addEventListener('click', () => beginEdit(msgEl));

            wrap.appendChild(thumbUp);
            wrap.appendChild(thumbDown);
            wrap.appendChild(copyBtn);
            wrap.appendChild(editBtn);
            return wrap;
        }

        function attachQaId(msgEl, qaId) {
            if (!msgEl || !qaId) return;
            msgEl.dataset.qaId = qaId;
            const acts = msgEl.querySelector('.cb-msg-actions');
            if (acts) {
                acts.classList.remove('cb-hidden');
                acts.classList.remove('cb-msg-actions-pending');
            }
        }

        /**
         * Mark a bubble's action row as stale — its qaId predates the current
         * server's qa-history (eg, server restarted). Visible but click-blocked,
         * with a hover tooltip explaining why.
         */
        function markStale(msgEl, reason) {
            const acts = msgEl?.querySelector('.cb-msg-actions');
            if (!acts) return;
            acts.classList.add('cb-msg-actions-stale');
            acts.title = reason || 'This conversation predates the current server session — ask again to enable feedback.';
        }

        /**
         * Float a tiny inline toast above an action row. Auto-dismisses after
         * `ttlMs`. Used to surface rate-limit / forbidden / not-found reasons
         * when feedback or edit fails, instead of a silent rollback.
         */
        function showActionToast(msgEl, text, kind, ttlMs) {
            if (!msgEl) return;
            const old = msgEl.querySelector('.cb-act-toast');
            if (old) old.remove();
            const toast = el('div', { class: `cb-act-toast cb-act-toast-${kind || 'error'}` }, text);
            const acts = msgEl.querySelector('.cb-msg-actions');
            (acts || msgEl).appendChild(toast);
            setTimeout(() => { try { toast.remove(); } catch (_) { /* ignore */ } }, ttlMs || 4500);
        }

        async function readErrorMessage(res) {
            try {
                const t = await res.text();
                if (!t) return null;
                try { return JSON.parse(t)?.error?.message || t.slice(0, 200); } catch (_) { return t.slice(0, 200); }
            } catch (_) { return null; }
        }

        function feedbackErrorCopy(status, msg) {
            if (status === 404) return { kind: 'stale', text: 'This answer predates the current server session — ask again to enable feedback.' };
            if (status === 403) return { kind: 'error', text: 'You can only vote on your own answers.' };
            if (status === 429) return { kind: 'warn',  text: 'Too many clicks — wait a moment and try again.' };
            if (status === 401) return { kind: 'error', text: 'Session expired — refresh the page.' };
            return { kind: 'error', text: msg || `Couldn't save (HTTP ${status || '??'})` };
        }

        function renderSources(msgEl, items) {
            if (!msgEl || !Array.isArray(items) || !items.length) return;
            const old = msgEl.querySelector('.cb-sources');
            if (old) old.remove();

            const wrap = el('div', { class: 'cb-sources' });
            const label = el('div', { class: 'cb-sources-label' }, `Sources (${items.length})`);
            wrap.appendChild(label);

            const chipRow = el('div', { class: 'cb-sources-row' });
            for (const it of items) {
                const isDocs = it.source === 'docs';
                const title = isDocs
                    ? [it.project, it.sprint, it.section].filter(Boolean).join(' · ')
                    : `prior answer${it.ageDays != null ? ` · ${it.ageDays}d ago` : ''}${it.helpful === true ? ' · ??' : it.helpful === false ? ' · ??' : ''}`;
                const display = isDocs
                    ? (it.project || it.file || 'docs') + (it.section ? ` · ${it.section}` : '')
                    : `prior answer${it.ageDays != null ? ` · ${it.ageDays}d` : ''}`;
                const chip = el('span', {
                    class: `cb-source-chip cb-source-${isDocs ? 'docs' : 'qa'}`,
                    title,
                }, `${it.rank}. `, document.createTextNode(display));
                chipRow.appendChild(chip);
            }
            wrap.appendChild(chipRow);

            // Insert sources between body and actions for natural reading order.
            const acts = msgEl.querySelector('.cb-msg-actions');
            if (acts) msgEl.insertBefore(wrap, acts);
            else msgEl.appendChild(wrap);
            ui.messages.scrollTop = ui.messages.scrollHeight;
        }

        async function sendFeedback(msgEl, helpful) {
            const id = msgEl?.dataset?.qaId;
            if (!id) return;
            const acts = msgEl.querySelector('.cb-msg-actions');
            if (!acts) return;
            if (acts.classList.contains('cb-msg-actions-stale')) return;
            const prevState = acts.dataset.state || '';
            acts.classList.toggle('cb-state-up', helpful === true);
            acts.classList.toggle('cb-state-down', helpful === false);
            acts.dataset.state = helpful ? 'up' : 'down';
            let res = null;
            try {
                res = await fetch(FEEDBACK_ENDPOINT, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, helpful }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            } catch (err) {
                // Revert optimistic change.
                acts.classList.remove('cb-state-up', 'cb-state-down');
                acts.dataset.state = prevState;
                const status = res ? res.status : 0;
                const msg = res ? await readErrorMessage(res) : (err?.message || '');
                const copy = feedbackErrorCopy(status, msg);
                showActionToast(msgEl, copy.text, copy.kind);
                if (status === 404) markStale(msgEl, copy.text);
            }
        }

        function copyAnswer(msgEl) {
            const text = msgEl?.dataset?.rawText || msgEl?.querySelector('.cb-msg-body')?.innerText || '';
            if (!text) return;
            try {
                navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
                const btn = msgEl.querySelector('.cb-act-copy');
                if (btn) {
                    btn.classList.add('cb-act-flash');
                    setTimeout(() => btn.classList.remove('cb-act-flash'), 700);
                }
            } catch (_) { /* ignore */ }
        }

        function beginEdit(msgEl) {
            const id = msgEl?.dataset?.qaId;
            if (!id) return;
            const body = msgEl.querySelector('.cb-msg-body');
            if (!body || body.dataset.editing === '1') return;
            const original = msgEl.dataset.rawText || body.innerText || '';
            body.dataset.editing = '1';

            const ta = el('textarea', { class: 'cb-edit-textarea', rows: '6' });
            ta.value = original;
            const saveBtn = el('button', { class: 'cb-edit-save' }, 'Save');
            const cancelBtn = el('button', { class: 'cb-edit-cancel' }, 'Cancel');
            const editRow = el('div', { class: 'cb-edit-row' }, saveBtn, cancelBtn);

            const prevHtml = body.innerHTML;
            body.innerHTML = '';
            body.appendChild(ta);
            body.appendChild(editRow);
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);

            const restore = () => {
                body.dataset.editing = '0';
                body.innerHTML = prevHtml;
            };

            cancelBtn.addEventListener('click', restore);

            saveBtn.addEventListener('click', async () => {
                const newText = (ta.value || '').trim();
                if (!newText || newText === original) {
                    restore();
                    return;
                }
                saveBtn.disabled = true;
                cancelBtn.disabled = true;
                let res = null;
                try {
                    res = await fetch(ANSWER_ENDPOINT, {
                        method: 'PATCH',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id, answer: newText }),
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    body.dataset.editing = '0';
                    body.innerHTML = renderMarkdown(newText);
                    msgEl.dataset.rawText = newText;
                    // Update saved history so refresh shows the edit.
                    const idx = history.findIndex(h => h.role === 'assistant' && h.qaId === id);
                    if (idx !== -1) {
                        history[idx].content = newText;
                        saveHistory(history);
                    }
                } catch (err) {
                    saveBtn.disabled = false;
                    cancelBtn.disabled = false;
                    const status = res ? res.status : 0;
                    const msg = res ? await readErrorMessage(res) : (err?.message || '');
                    const copy = feedbackErrorCopy(status, msg);
                    showActionToast(msgEl, copy.text, copy.kind);
                    if (status === 404) {
                        markStale(msgEl, copy.text);
                        restore();
                    }
                }
            });
        }

        function makeTimeline() {
            const tl = el('div', { class: 'cb-timeline' });
            ui.messages.appendChild(tl);
            ui.messages.scrollTop = ui.messages.scrollHeight;
            return tl;
        }
        function timelineItem(tl, text, state) {
            const item = el('div', { class: `cb-timeline-item ${state || ''}` });
            const icon = state === 'running'
                ? el('span', { class: 'cb-timeline-spinner' })
                : el('span', { class: 'cb-timeline-check', html: state === 'ok'
                    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
                    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' });
            if (state !== 'ok') icon.classList.add('cb-timeline-x');
            item.appendChild(icon);
            const label = document.createElement('span');
            label.innerHTML = text;
            item.appendChild(label);
            tl.appendChild(item);
            ui.messages.scrollTop = ui.messages.scrollHeight;
            return item;
        }

        function renderFollowups(msgEl, items) {
            if (!msgEl || !Array.isArray(items) || !items.length) return;
            const existing = msgEl.querySelector('.cb-followups');
            if (existing) existing.remove();
            const wrap = el('div', { class: 'cb-followups' });
            for (const q of items) {
                const text = String(q || '').trim();
                if (!text) continue;
                const chip = el('button', { class: 'cb-suggestion cb-followup-chip', 'data-prompt': text }, text);
                chip.addEventListener('click', () => {
                    ui.input.value = text;
                    ui.input.focus();
                });
                wrap.appendChild(chip);
            }
            if (wrap.children.length) msgEl.appendChild(wrap);
            ui.messages.scrollTop = ui.messages.scrollHeight;
        }

        // -- Send handler -----------------------------------------------------
        let inflight = false;
        async function send(opts) {
            const explicitQ = opts && typeof opts.question === 'string' ? opts.question : null;
            const q = (explicitQ != null ? explicitQ : ui.input.value).trim();
            if (!q || inflight) return;
            inflight = true;
            ui.sendBtn.disabled = true;
            ui.empty.classList.add('cb-hidden');
            if (explicitQ == null) {
                ui.input.value = '';
                ui.input.style.height = 'auto';
            }

            // Skip echoing the user bubble + history append on a retry of an
            // already-sent question (the user's bubble is still on screen).
            if (!opts || !opts.isReconnect) {
                addMessage('user', q);
                history.push({ role: 'user', content: q });
            }

            const tl = makeTimeline();
            const toolItems = new Map();
            let pendingSources = null;
            let gotFinal = false;

            // Streaming-aware assistant bubble state.
            // assistantBubble: lazy-created on first assistant_chunk/final.
            // streamingText: accumulated content for the CURRENT iteration only.
            // Reset on assistant_reset (fired by the agent before tool calls).
            // llmItem: currently-running "Thinking…" spinner in the timeline,
            //   resolved when chunks arrive (model is answering) or tool_start
            //   fires (model picked a tool). Keeps the user engaged during
            //   the otherwise-silent gap between retrieval and tool/answer.
            let assistantBubble = null;
            let streamingText = '';
            let lastRenderAt = 0;
            let llmItem = null;

            const ensureBubble = () => {
                if (!assistantBubble) assistantBubble = addMessage('assistant', '');
                return assistantBubble;
            };

            const renderStreaming = (force) => {
                const b = ensureBubble();
                const body = b.querySelector('.cb-msg-body');
                if (!body) return;
                const now = Date.now();
                if (!force && now - lastRenderAt < 50) return;
                lastRenderAt = now;
                // Append a tiny blinking caret while streaming so the bubble
                // visibly "types" — removed once `final` fires.
                body.innerHTML = renderMarkdown(streamingText) + '<span class="cb-cursor"></span>';
                ui.messages.scrollTop = ui.messages.scrollHeight;
            };

            const resolveLlmItem = (label, ok) => {
                if (!llmItem) return;
                llmItem.remove();
                timelineItem(
                    tl,
                    `<span class="cb-timeline-name">${escapeHtml(label)}</span>`,
                    ok ? 'ok' : 'fail',
                );
                llmItem = null;
            };

            const model = ui.modelSelect.value;

            try {
                await streamAsk({
                    question: q,
                    model,
                    history: history.slice(0, -1).slice(-6),
                    onEvent: (evt) => {
                        switch (evt.type) {
                            case 'retrieval_start':
                                timelineItem(tl, '<span class="cb-timeline-name">Searching docs &amp; memory…</span>', 'running');
                                break;
                            case 'retrieval_end': {
                                const items = tl.querySelectorAll('.cb-timeline-item');
                                items[items.length - 1].remove();
                                timelineItem(tl, `<span class="cb-timeline-name">Retrieved</span> <span class="cb-timeline-summary">${evt.hitCount} relevant chunks</span>`, 'ok');
                                break;
                            }
                            case 'llm_call_start':
                                // Persistent "Thinking…" spinner so the user sees
                                // activity between retrieval and tool/answer.
                                if (!llmItem) {
                                    llmItem = timelineItem(
                                        tl,
                                        '<span class="cb-timeline-name">Thinking…</span>',
                                        'running',
                                    );
                                }
                                break;
                            case 'llm_retry':
                                // Backend hit a transient OpenRouter failure and
                                // is retrying with backoff. Annotate timeline so
                                // the user sees we're not stuck.
                                timelineItem(
                                    tl,
                                    `<span class="cb-timeline-name">Retrying…</span> <span class="cb-timeline-summary">attempt ${evt.attempt}/3 (${escapeHtml(evt.reason || '')}, +${evt.delayMs}ms)</span>`,
                                    'fail',
                                );
                                break;
                            case 'sources':
                                // Hold sources until the assistant bubble exists
                                // (chunks haven't started yet at this point).
                                pendingSources = Array.isArray(evt.items) ? evt.items : null;
                                break;
                            case 'llm_call_end':
                                // If neither tool_start nor a content chunk arrived
                                // (e.g. upstream error), resolve here so the spinner
                                // doesn't dangle. Successful resolutions happen in
                                // the tool_start / assistant_chunk handlers below.
                                if (llmItem) {
                                    const status = evt.status || 0;
                                    if (status === 0 || status < 200 || status >= 300) {
                                        resolveLlmItem(evt.error ? `LLM error: ${String(evt.error).slice(0, 60)}` : `LLM error (${status})`, false);
                                    }
                                }
                                break;
                            case 'tool_start': {
                                resolveLlmItem('Picked tool', true);
                                const item = timelineItem(tl, `<span class="cb-timeline-name">${escapeHtml(evt.name)}</span> <span class="cb-timeline-summary">${escapeHtml(JSON.stringify(evt.args).slice(0, 80))}</span>`, 'running');
                                toolItems.set(evt.id, item);
                                break;
                            }
                            case 'tool_end': {
                                const item = toolItems.get(evt.id);
                                if (item) {
                                    item.remove();
                                    const cachedTag = evt.cached ? ' <span class="cb-timeline-cached">cached</span>' : '';
                                    timelineItem(tl, `<span class="cb-timeline-name">${escapeHtml(evt.name)}</span> <span class="cb-timeline-summary">${escapeHtml(evt.summary || '')}</span>${cachedTag}`, evt.ok ? 'ok' : 'fail');
                                }
                                break;
                            }
                            case 'assistant_chunk':
                                if (typeof evt.delta === 'string') {
                                    // First chunk of an answer iteration — the
                                    // model is now generating text, so the
                                    // "Thinking…" spinner can graduate.
                                    if (llmItem) resolveLlmItem('Answering', true);
                                    streamingText += evt.delta;
                                    renderStreaming(false);
                                }
                                break;
                            case 'assistant_reset':
                                // Intermediate iteration produced tool_calls; discard
                                // narration so only the final iteration is shown.
                                streamingText = '';
                                if (assistantBubble) {
                                    const body = assistantBubble.querySelector('.cb-msg-body');
                                    if (body) body.innerHTML = '';
                                }
                                break;
                            case 'final': {
                                // Stream done — resolve any lingering thinking
                                // indicator and render the final markdown without
                                // the typing caret.
                                resolveLlmItem('Answered', true);
                                gotFinal = true;
                                const b = ensureBubble();
                                const body = b.querySelector('.cb-msg-body');
                                if (body) body.innerHTML = renderMarkdown(evt.content || '');
                                b.dataset.rawText = evt.content || '';
                                history.push({
                                    role: 'assistant',
                                    content: evt.content,
                                    qaId: null,
                                });
                                saveHistory(history);
                                break;
                            }
                            case 'qa_id': {
                                if (assistantBubble && evt.qaId) {
                                    attachQaId(assistantBubble, evt.qaId);
                                    const last = history[history.length - 1];
                                    if (last && last.role === 'assistant') {
                                        last.qaId = evt.qaId;
                                        saveHistory(history);
                                    }
                                }
                                break;
                            }
                            case 'followups':
                                renderFollowups(assistantBubble, evt.items);
                                break;
                            case 'error':
                                addMessage('error', evt.message || 'Something went wrong.');
                                break;
                            default:
                                break;
                        }
                    },
                });
            } catch (err) {
                // Stream failed (network drop / proxy / server died mid-stream).
                // If we never got `final`, the bubble may have partial text or be
                // empty — either way, give the user a clear "Reconnect" affordance
                // instead of a dead bubble.
                if (!gotFinal) {
                    if (assistantBubble && streamingText) {
                        const body = assistantBubble.querySelector('.cb-msg-body');
                        if (body) {
                            body.innerHTML = renderMarkdown(streamingText) +
                                `<div class="cb-stream-broken">Connection lost mid-answer. The text above may be partial.</div>`;
                            assistantBubble.dataset.rawText = streamingText;
                        }
                        attachReconnect(assistantBubble, q);
                    } else {
                        const errBubble = addMessage('error', `Couldn't reach the chatbot: ${err.message || err}`);
                        attachReconnect(errBubble, q);
                    }
                }
            } finally {
                if (assistantBubble) {
                    const body = assistantBubble.querySelector('.cb-msg-body');
                    if (body && streamingText && !assistantBubble.dataset.rawText && gotFinal) {
                        body.innerHTML = renderMarkdown(streamingText);
                        assistantBubble.dataset.rawText = streamingText;
                    }
                }
                inflight = false;
                ui.sendBtn.disabled = false;
                ui.input.focus();
            }
        }

        /**
         * Append a "Reconnect" button to a bubble after a stream broke. Clicking
         * removes the button and re-fires `send()` with the same question, marked
         * as a reconnect so we don't re-add the user's message to history.
         */
        function attachReconnect(msgEl, question) {
            if (!msgEl) return;
            const old = msgEl.querySelector('.cb-reconnect');
            if (old) old.remove();
            const wrap = el('div', { class: 'cb-reconnect' });
            const btn = el('button', { class: 'cb-reconnect-btn' }, '? Reconnect');
            btn.addEventListener('click', () => {
                wrap.remove();
                send({ question, isReconnect: true });
            });
            wrap.appendChild(btn);
            msgEl.appendChild(wrap);
            ui.messages.scrollTop = ui.messages.scrollHeight;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
