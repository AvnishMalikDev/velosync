/**
 * Shared model dropdown helper for OpenRouter model selection.
 * Used by any <select> on the host pages plus the chatbot widget.
 * The 'aiModel' localStorage key is shared so the user's choice carries.
 */
(function (global) {
    const ENDPOINT = '/api/openrouter/models';
    const FALLBACK = [
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', default: true  },
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

    // Auto-init any <select data-model-picker> present in the document.
    function autoInit() {
        document.querySelectorAll('select[data-model-picker]').forEach(sel => {
            populateModelPicker(sel);
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit);
    } else {
        autoInit();
    }
})(window);
