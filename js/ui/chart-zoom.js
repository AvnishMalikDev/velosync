/**
 * Generic click-to-zoom for any Chart.js chart on the dashboard.
 *
 *   window.ChartZoom.enable(chart, { title, eyebrow? })
 *
 * Attaches a small "fullscreen" button in the top-right corner of the chart's
 * parent container. Clicking the button opens a fullscreen modal with a
 * faithfully re-rendered copy of the chart (cloned config + data), so
 * interactive affordances (tooltips, legends, scales) keep working but are
 * sized to the full viewport.
 *
 * Using a dedicated button (instead of binding the whole canvas to click)
 * preserves any existing per-chart click handlers such as pie drill-downs or
 * dev/QA score breakdowns.
 */
(function (global) {
    let overlay = null;
    let activeZoomChart = null;

    function isLightTheme() {
        return typeof document !== 'undefined' && document.documentElement.classList.contains('theme-light');
    }

    function getThemeTokens() {
        if (isLightTheme()) {
            return {
                scrim: 'rgba(148,163,184,0.35)',
                cardBg: '#ffffff',
                cardBorder: 'rgba(15,23,42,0.10)',
                cardShadow: '0 30px 80px rgba(15,23,42,0.18)',
                eyebrow: '#64748b',
                title: '#0f172a',
                closeColor: '#64748b',
                closeHoverColor: '#0f172a',
                closeHoverBg: 'rgba(15,23,42,0.06)',
                canvasBorder: 'rgba(15,23,42,0.06)',
                canvasBg: 'rgba(15,23,42,0.015)',
            };
        }
        return {
            scrim: 'rgba(2,6,23,0.78)',
            cardBg: '#0b1220',
            cardBorder: 'rgba(148,163,184,0.22)',
            cardShadow: '0 30px 80px rgba(0,0,0,0.55)',
            eyebrow: '#64748b',
            title: '#f8fafc',
            closeColor: '#94a3b8',
            closeHoverColor: '#ffffff',
            closeHoverBg: 'rgba(255,255,255,0.08)',
            canvasBorder: 'rgba(255,255,255,0.06)',
            canvasBg: 'rgba(255,255,255,0.02)',
        };
    }

    function applyThemeTokens() {
        if (!overlay) return;
        const t = getThemeTokens();
        overlay.style.background = t.scrim;
        const card = overlay.querySelector('#chartZoomCard');
        if (card) {
            card.style.background = t.cardBg;
            card.style.border = `1px solid ${t.cardBorder}`;
            card.style.boxShadow = t.cardShadow;
        }
        const eyebrowEl = overlay.querySelector('#chartZoomEyebrow');
        if (eyebrowEl) eyebrowEl.style.color = t.eyebrow;
        const titleEl = overlay.querySelector('#chartZoomTitle');
        if (titleEl) titleEl.style.color = t.title;
        const closeBtn = overlay.querySelector('#chartZoomCloseBtn');
        if (closeBtn) {
            closeBtn.style.color = t.closeColor;
            closeBtn.style.background = 'transparent';
            closeBtn.__zoomTokens = t;
        }
        const wrap = overlay.querySelector('#chartZoomCanvasWrap');
        if (wrap) {
            wrap.style.border = `1px solid ${t.canvasBorder}`;
            wrap.style.background = t.canvasBg;
        }
    }

    function deepClone(obj) {
        if (obj == null || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(deepClone);
        // Skip DOM / canvas / Chart instances that sometimes appear on chart.config
        if (obj instanceof Element || typeof obj === 'function') return obj;
        const out = {};
        Object.keys(obj).forEach((k) => { out[k] = deepClone(obj[k]); });
        return out;
    }

    function ensureOverlay() {
        if (overlay) return overlay;
        overlay = document.createElement('div');
        overlay.id = 'chartZoomOverlay';
        overlay.style.cssText = [
            'position:fixed',
            'inset:0',
            'z-index:70',
            'display:none',
            'align-items:center',
            'justify-content:center',
            'backdrop-filter:blur(8px)',
            '-webkit-backdrop-filter:blur(8px)',
            'padding:1.5rem',
        ].join(';');
        overlay.innerHTML = `
            <div id="chartZoomCard" style="
                position:relative;
                display:flex;
                flex-direction:column;
                gap:1rem;
                width:min(88rem, calc(100vw - 3rem));
                max-width:calc(100vw - 3rem);
                height:min(56rem, calc(100vh - 3rem));
                max-height:calc(100vh - 3rem);
                border-radius:1rem;
                padding:1.25rem 1.5rem;
                overflow:hidden;">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-shrink:0;">
                    <div style="min-width:0;">
                        <div id="chartZoomEyebrow" style="font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:0.25em;margin-bottom:2px;">Zoomed View</div>
                        <div id="chartZoomTitle" style="font-weight:700;font-size:15px;line-height:1.25;"></div>
                    </div>
                    <button type="button" id="chartZoomCloseBtn" aria-label="Close zoom"
                        style="flex-shrink:0;background:transparent;border:none;font-size:20px;line-height:1;cursor:pointer;padding:4px 6px;border-radius:6px;transition:color 0.15s, background 0.15s;">✕</button>
                </div>
                <div id="chartZoomCanvasWrap" style="
                    position:relative;
                    flex:1 1 auto;
                    min-height:0;
                    border-radius:0.75rem;
                    padding:1rem;
                    overflow:hidden;">
                    <canvas id="chartZoomCanvas" style="width:100%;height:100%;display:block;"></canvas>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            const card = document.getElementById('chartZoomCard');
            if (!card || !card.contains(e.target)) close();
        });
        const closeBtn = overlay.querySelector('#chartZoomCloseBtn');
        if (closeBtn) {
            closeBtn.addEventListener('click', close);
            closeBtn.addEventListener('mouseenter', () => {
                const t = closeBtn.__zoomTokens || getThemeTokens();
                closeBtn.style.color = t.closeHoverColor;
                closeBtn.style.background = t.closeHoverBg;
            });
            closeBtn.addEventListener('mouseleave', () => {
                const t = closeBtn.__zoomTokens || getThemeTokens();
                closeBtn.style.color = t.closeColor;
                closeBtn.style.background = 'transparent';
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.style.display !== 'none') close();
        });
        applyThemeTokens();
        return overlay;
    }

    function open(sourceChart, meta) {
        if (!sourceChart || !global.Chart) return;
        ensureOverlay();
        applyThemeTokens();

        const m = meta || {};
        const titleEl = document.getElementById('chartZoomTitle');
        const eyebrowEl = document.getElementById('chartZoomEyebrow');
        if (titleEl) titleEl.textContent = m.title || 'Chart';
        if (eyebrowEl) eyebrowEl.textContent = m.eyebrow || 'Zoomed View';

        if (activeZoomChart) {
            try { activeZoomChart.destroy(); } catch (e) { /* ignore */ }
            activeZoomChart = null;
        }

        const type = sourceChart.config && sourceChart.config.type;
        const data = deepClone(sourceChart.config && sourceChart.config.data);
        const options = deepClone(sourceChart.config && sourceChart.config.options) || {};
        options.responsive = true;
        options.maintainAspectRatio = false;
        if (!options.animation || options.animation === false) options.animation = { duration: 400 };

        // Strip click handlers on the zoomed copy to avoid triggering drill-downs from zoom.
        delete options.onClick;
        delete options.onHover;

        const zoomCanvas = document.getElementById('chartZoomCanvas');
        if (!zoomCanvas || !type || !data) return;
        activeZoomChart = new global.Chart(zoomCanvas, { type, data, options });

        overlay.style.display = 'flex';
    }

    function close() {
        if (!overlay) return;
        if (activeZoomChart) {
            try { activeZoomChart.destroy(); } catch (e) { /* ignore */ }
            activeZoomChart = null;
        }
        overlay.style.display = 'none';
    }

    function mountZoomButton(parent, sourceChartHolder) {
        if (!parent) return;
        if (parent.dataset.chartZoomMounted === '1') return;
        parent.dataset.chartZoomMounted = '1';

        const computed = global.getComputedStyle(parent);
        if (!computed.position || computed.position === 'static') {
            parent.style.position = 'relative';
        }

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = 'Click to zoom';
        btn.setAttribute('aria-label', 'Zoom chart');
        btn.className = 'chart-zoom-btn';

        function btnTokens() {
            if (isLightTheme()) {
                return {
                    idleBg: 'rgba(255,255,255,0.95)',
                    idleColor: '#0f172a',
                    idleBorder: 'rgba(15,23,42,0.22)',
                    idleShadow: '0 2px 8px rgba(15,23,42,0.10), 0 0 0 2px rgba(255,255,255,0.6)',
                    hoverBg: '#0f172a',
                    hoverColor: '#ffffff',
                    hoverBorder: 'rgba(15,23,42,0.6)',
                    hoverShadow: '0 6px 18px rgba(15,23,42,0.28), 0 0 0 3px rgba(15,23,42,0.08)',
                    labelBg: 'rgba(15,23,42,0.92)',
                    labelColor: '#ffffff',
                };
            }
            return {
                idleBg: 'rgba(15,23,42,0.85)',
                idleColor: '#e2e8f0',
                idleBorder: 'rgba(148,163,184,0.55)',
                idleShadow: '0 2px 8px rgba(0,0,0,0.45), 0 0 0 2px rgba(15,23,42,0.4)',
                hoverBg: '#f8fafc',
                hoverColor: '#0f172a',
                hoverBorder: 'rgba(248,250,252,0.9)',
                hoverShadow: '0 6px 22px rgba(56,189,248,0.32), 0 0 0 3px rgba(56,189,248,0.18)',
                labelBg: 'rgba(248,250,252,0.96)',
                labelColor: '#0f172a',
            };
        }

        // "Zoom" pill that slides in next to the icon on hover, so the
        // affordance reads as a labeled control instead of an unmarked dot.
        const label = document.createElement('span');
        label.textContent = 'Zoom';
        label.style.cssText = [
            'position:absolute',
            'top:50%',
            'right:38px',
            'transform:translateY(-50%) translateX(4px)',
            'pointer-events:none',
            'opacity:0',
            'font-size:10px',
            'font-weight:800',
            'letter-spacing:0.12em',
            'text-transform:uppercase',
            'padding:3px 8px',
            'border-radius:9999px',
            'white-space:nowrap',
            'transition:opacity 0.15s ease, transform 0.15s ease',
            'box-shadow:0 4px 10px rgba(0,0,0,0.25)',
        ].join(';');

        function applyBtnIdle() {
            const t = btnTokens();
            btn.style.background = t.idleBg;
            btn.style.color = t.idleColor;
            btn.style.borderColor = t.idleBorder;
            btn.style.boxShadow = t.idleShadow;
            btn.style.opacity = '1';
            btn.style.transform = 'scale(1)';
            label.style.opacity = '0';
            label.style.transform = 'translateY(-50%) translateX(4px)';
            label.style.background = t.labelBg;
            label.style.color = t.labelColor;
        }
        function applyBtnHover() {
            const t = btnTokens();
            btn.style.background = t.hoverBg;
            btn.style.color = t.hoverColor;
            btn.style.borderColor = t.hoverBorder;
            btn.style.boxShadow = t.hoverShadow;
            btn.style.opacity = '1';
            btn.style.transform = 'scale(1.06)';
            label.style.opacity = '1';
            label.style.transform = 'translateY(-50%) translateX(0)';
            label.style.background = t.labelBg;
            label.style.color = t.labelColor;
        }

        btn.style.cssText = [
            'position:absolute',
            'top:10px',
            'right:10px',
            'z-index:5',
            'display:inline-flex',
            'align-items:center',
            'justify-content:center',
            'width:34px',
            'height:34px',
            'border-radius:10px',
            'border:1px solid transparent',
            'cursor:zoom-in',
            'backdrop-filter:blur(6px)',
            '-webkit-backdrop-filter:blur(6px)',
            'transition:all 0.18s ease',
            'padding:0',
        ].join(';');
        // Magnifier-with-plus icon — the universal "click to zoom in" cue.
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
        applyBtnIdle();
        btn.addEventListener('mouseenter', applyBtnHover);
        btn.addEventListener('mouseleave', applyBtnIdle);
        btn.addEventListener('focus', applyBtnHover);
        btn.addEventListener('blur', applyBtnIdle);
        btn.__refreshChartZoomTheme = applyBtnIdle;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            open(sourceChartHolder.chart, sourceChartHolder.meta || {});
        });
        parent.appendChild(label);
        parent.appendChild(btn);
    }

    function enable(sourceChart, meta) {
        if (!sourceChart || !sourceChart.canvas) return;
        const parent = sourceChart.canvas.parentElement;
        if (!parent) return;

        // Keep a live holder so re-created charts that reuse the same parent
        // still zoom the latest instance.
        let holder = parent.__chartZoomHolder;
        if (!holder) {
            holder = { chart: sourceChart, meta: meta || {} };
            parent.__chartZoomHolder = holder;
        } else {
            holder.chart = sourceChart;
            holder.meta = meta || {};
        }
        mountZoomButton(parent, holder);
    }

    function refreshTheme() {
        applyThemeTokens();
        document.querySelectorAll('.chart-zoom-btn').forEach((btn) => {
            if (typeof btn.__refreshChartZoomTheme === 'function') btn.__refreshChartZoomTheme();
        });
    }

    if (typeof document !== 'undefined' && document.documentElement) {
        try {
            const observer = new MutationObserver((muts) => {
                for (const m of muts) {
                    if (m.type === 'attributes' && m.attributeName === 'class') {
                        refreshTheme();
                        break;
                    }
                }
            });
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        } catch (e) { /* MutationObserver unsupported — theme stays set at mount time */ }
    }

    global.ChartZoom = { enable: enable, open: open, close: close, refreshTheme: refreshTheme };
})(typeof window !== 'undefined' ? window : this);
