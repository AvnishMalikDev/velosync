/**
 * health-trend-chart.js
 * ---------------------
 * Renders the "Health Score Trend — Sprint over Sprint" grouped bar chart
 * shown on the main dashboard, directly underneath the Team Health Matrix
 * scoring guide.
 *
 * For each team in view we plot up to three bars (Oldest Sprint → Previous
 * Sprint → Current Sprint) with the raw 0-100 weighted composite. The bar
 * hue mirrors the rating band it falls into (Elite/Strong/Stable/At Risk/
 * Breach) so a glance tells you both the absolute score AND the trend; the
 * sprint position is encoded as opacity (oldest = washed out, current =
 * full saturation).
 *
 * Public API:
 *   HealthTrendChart.render(canvasEl, rows, options)
 *
 * rows: [{
 *   name:    string,   // team / project name (x-axis label)
 *   sprints: [
 *     { label: string, score: number|null },  // oldest first
 *     ...                                     // up to 3 entries
 *   ]
 * }]
 *
 * options: {
 *   bands?:    { elite, strong, stable, atRisk },  // composite thresholds
 *   isLight?:  boolean,                            // theme hint
 *   onEmpty?:  () => void,                         // called when nothing to draw
 * }
 *
 * The renderer requires Chart.js v4 to be loaded globally as `Chart`.
 */
(function (global) {
    'use strict';

    var DEFAULT_BANDS = { elite: 85, strong: 70, stable: 55, atRisk: 40 };

    /* Per-band hue — kept in lock-step with the bucket bar at the top of the
       dashboard (Stellar / Surge / Cruise / Friction / Breach) and with the
       parallel-coordinates chart, so the same project reads as the same
       color cue everywhere. */
    var BAND_COLORS = {
        elite:  { r: 52,  g: 211, b: 153 }, // Stellar  — emerald
        strong: { r: 96,  g: 165, b: 250 }, // Surge    — blue
        stable: { r: 251, g: 191, b: 36  }, // Cruise   — amber
        atRisk: { r: 251, g: 146, b: 60  }, // Friction — orange
        breach: { r: 248, g: 113, b: 113 }, // Breach   — red
    };

    /* Sprint-position opacity ramp: oldest → previous → current.
       Lower = washed out, 1.0 = darkest/full saturation. The visual ramp
       mirrors the legend dots above the chart. */
    var POSITION_ALPHA = [0.40, 0.70, 1.0];

    var DEFAULT_CHART = null;

    function bandFor(score, bands) {
        var b = bands || DEFAULT_BANDS;
        if (!Number.isFinite(score)) return null;
        if (score >= b.elite)  return 'elite';
        if (score >= b.strong) return 'strong';
        if (score >= b.stable) return 'stable';
        if (score >= b.atRisk) return 'atRisk';
        return 'breach';
    }

    function rgba(c, alpha) {
        return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
    }

    /**
     * Pick the project-level band (the hue) from the most recent sprint
     * with a usable score. We walk the array right-to-left so the *current*
     * sprint wins; if it has no score we fall back to the previous sprint
     * and so on. Returns null only when the row has zero usable scores.
     */
    function rowBand(row, bands) {
        var arr = (row && row.sprints) || [];
        for (var i = arr.length - 1; i >= 0; i--) {
            var s = arr[i];
            if (s && Number.isFinite(Number(s.score))) {
                var b = bandFor(Number(s.score), bands);
                if (b) return b;
            }
        }
        return null;
    }

    function colorForCell(score, positionIndex, bands, fixedBand) {
        var band = fixedBand || bandFor(score, bands);
        if (!band) return 'rgba(148,163,184,0.18)'; // slate / no-data ghost
        var alpha = POSITION_ALPHA[positionIndex] != null
            ? POSITION_ALPHA[positionIndex]
            : POSITION_ALPHA[POSITION_ALPHA.length - 1];
        return rgba(BAND_COLORS[band], alpha);
    }

    function borderForCell(score, bands, fixedBand) {
        var band = fixedBand || bandFor(score, bands);
        if (!band) return 'rgba(148,163,184,0.35)';
        return rgba(BAND_COLORS[band], 0.95);
    }

    /* ─────────────── band line + label plugin ───────────────
     * Draws the four horizontal dashed reference lines (Elite / Strong /
     * Stable / At Risk) and labels them on the right edge — same vibe as
     * the reference design. Uses the chart's own y-scale so the lines
     * stay anchored even when the canvas is resized.
     */
    var bandLinesPlugin = {
        id: 'velosyncHealthBandLines',
        afterDatasetsDraw: function (chart, _args, opts) {
            /* Strict opt-in: only render when a chart explicitly enables this
             * plugin via options.plugins.velosyncHealthBandLines = { bands, isLight }.
             * Without this guard the globally-registered plugin draws the
             * Elite / Strong / Stable / At Risk threshold labels (the faint
             * "S / S / A" letters) on every Chart.js chart on the page —
             * e.g. the main dashboard's Story Points, Sprint Success, Review
             * Cycle, and Throughput bar cards — where they carry no meaning. */
            if (!opts || !opts.bands) return;
            var bands = opts.bands;
            var isLight = !!opts.isLight;
            var ctx = chart.ctx;
            var area = chart.chartArea;
            var yScale = chart.scales && chart.scales.y;
            if (!ctx || !area || !yScale) return;

            var entries = [
                { v: bands.elite,  label: 'Elite',   key: 'elite'  },
                { v: bands.strong, label: 'Strong',  key: 'strong' },
                { v: bands.stable, label: 'Stable',  key: 'stable' },
                { v: bands.atRisk, label: 'At Risk', key: 'atRisk' },
            ];

            ctx.save();
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.font = "700 9.5px 'JetBrains Mono', ui-monospace, monospace";
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';

            entries.forEach(function (e) {
                if (!Number.isFinite(e.v)) return;
                var y = yScale.getPixelForValue(e.v);
                if (y < area.top || y > area.bottom) return;

                var c = BAND_COLORS[e.key];
                ctx.strokeStyle = rgba(c, isLight ? 0.55 : 0.45);
                ctx.beginPath();
                ctx.moveTo(area.left, y);
                ctx.lineTo(area.right, y);
                ctx.stroke();

                /* Right-edge label, slightly recessed inside the chart area
                   so it doesn't get clipped by the canvas bounds. */
                ctx.fillStyle = rgba(c, isLight ? 0.95 : 0.9);
                ctx.fillText(e.label, area.right + 6, y);
            });

            ctx.restore();
        },
    };

    /* Register once. Chart.register tolerates duplicate calls in v4. */
    function ensurePluginRegistered() {
        if (typeof global.Chart === 'undefined') return;
        try { global.Chart.register(bandLinesPlugin); } catch (_) { /* noop */ }
    }

    function destroyExisting() {
        if (DEFAULT_CHART) {
            try { DEFAULT_CHART.destroy(); } catch (_) { /* noop */ }
            DEFAULT_CHART = null;
        }
    }

    function render(canvas, rows, options) {
        if (!canvas) return null;
        if (typeof global.Chart === 'undefined') {
            console.warn('[HealthTrendChart] Chart.js not loaded; skipping render');
            return null;
        }

        ensurePluginRegistered();
        destroyExisting();

        var opts = options || {};
        var bands = opts.bands || DEFAULT_BANDS;
        var isLight = !!opts.isLight;
        var data = Array.isArray(rows) ? rows : [];

        /* Filter out teams that have no usable scores at all, otherwise the
           chart shows phantom empty slots. */
        var usable = data.filter(function (row) {
            if (!row || !Array.isArray(row.sprints)) return false;
            return row.sprints.some(function (s) { return s && Number.isFinite(Number(s.score)); });
        });

        if (!usable.length) {
            if (typeof opts.onEmpty === 'function') opts.onEmpty();
            return null;
        }

        var labels = usable.map(function (r) { return r.name; });

        /* Lock one band (= one hue) per project, derived from its most
           recent usable sprint score. Same hue is then used for all 3 bars
           of that project, with POSITION_ALPHA encoding time as shade
           (oldest = lightest, current = darkest). */
        var rowBands = usable.map(function (row) { return rowBand(row, bands); });

        /* Build 3 datasets — Oldest, Previous, Current — left-padded with
           nulls when a team has fewer than three historical sprints. The
           rightmost (current) bar is always populated when ANY data exists. */
        var DATASET_TITLES = ['Oldest Sprint', 'Previous Sprint', 'Current Sprint'];
        var datasets = [0, 1, 2].map(function (slotIdx) {
            var values = usable.map(function (row) {
                var arr = row.sprints || [];
                /* Right-align: if a team has fewer than 3 sprints, the gap is
                   on the OLDEST side (index 0). i.e. for 2 sprints → slots
                   [null, prev, curr]; for 1 sprint → [null, null, curr]. */
                var offset = 3 - arr.length;
                var i = slotIdx - offset;
                if (i < 0 || i >= arr.length) return null;
                var s = arr[i];
                if (!s || !Number.isFinite(Number(s.score))) return null;
                return Math.max(0, Math.min(100, Number(s.score)));
            });
            var sprintLabels = usable.map(function (row) {
                var arr = row.sprints || [];
                var offset = 3 - arr.length;
                var i = slotIdx - offset;
                if (i < 0 || i >= arr.length) return '';
                return (arr[i] && arr[i].label) ? arr[i].label : '';
            });
            var bgs = values.map(function (v, ri) {
                return colorForCell(v, slotIdx, bands, rowBands[ri]);
            });
            var brds = values.map(function (v, ri) {
                return borderForCell(v, bands, rowBands[ri]);
            });
            return {
                label: DATASET_TITLES[slotIdx],
                data: values,
                _sprintLabels: sprintLabels,
                _slotIndex: slotIdx,
                backgroundColor: bgs,
                borderColor: brds,
                borderWidth: 1.2,
                borderRadius: 6,
                borderSkipped: false,
                hoverBackgroundColor: bgs.map(function (_c, idx) {
                    var b = rowBands[idx];
                    if (!b) return 'rgba(148,163,184,0.32)';
                    return rgba(BAND_COLORS[b], Math.min(1, (POSITION_ALPHA[slotIdx] || 1) + 0.12));
                }),
                categoryPercentage: 0.78,
                barPercentage: 0.92,
            };
        });

        var tickColor = isLight ? '#475569' : '#94a3b8';
        var gridColor = isLight ? 'rgba(15, 23, 42, 0.06)' : 'rgba(148, 163, 184, 0.12)';
        var axisColor = isLight ? 'rgba(15, 23, 42, 0.20)' : 'rgba(148, 163, 184, 0.28)';
        var tooltipBg = isLight ? 'rgba(255, 255, 255, 0.98)' : 'rgba(15, 23, 42, 0.94)';
        var tooltipFg = isLight ? '#0f172a' : '#f1f5f9';
        var tooltipFg2 = isLight ? '#334155' : '#cbd5e1';
        var tooltipBorder = isLight ? 'rgba(148, 163, 184, 0.40)' : 'rgba(148, 163, 184, 0.22)';

        var fontMono = "'JetBrains Mono', ui-monospace, monospace";

        DEFAULT_CHART = new global.Chart(canvas, {
            type: 'bar',
            data: { labels: labels, datasets: datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 380 },
                layout: {
                    padding: { top: 8, right: 56, bottom: 4, left: 0 },
                },
                plugins: {
                    legend: { display: false },
                    velosyncHealthBandLines: { bands: bands, isLight: isLight },
                    tooltip: {
                        backgroundColor: tooltipBg,
                        titleColor: tooltipFg,
                        bodyColor: tooltipFg2,
                        borderColor: tooltipBorder,
                        borderWidth: 1,
                        padding: 10,
                        cornerRadius: 10,
                        displayColors: true,
                        callbacks: {
                            title: function (items) {
                                if (!items || !items.length) return '';
                                return items[0].label || '';
                            },
                            label: function (ctx) {
                                var ds = ctx.dataset || {};
                                var sprintLabel = (ds._sprintLabels && ds._sprintLabels[ctx.dataIndex]) || '';
                                var v = ctx.parsed && ctx.parsed.y;
                                var prefix = ds.label || '';
                                var scoreText = Number.isFinite(v) ? Math.round(v) + ' / 100' : '— no data';
                                return prefix + (sprintLabel ? '  ·  ' + sprintLabel : '') + '  ·  ' + scoreText;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        ticks: {
                            color: tickColor,
                            font: { size: 10, weight: '600', family: fontMono },
                            maxRotation: 35,
                            minRotation: 0,
                            autoSkip: false,
                        },
                        grid: { display: false },
                        border: { display: true, color: axisColor },
                    },
                    y: {
                        beginAtZero: true,
                        suggestedMax: 100,
                        ticks: {
                            stepSize: 20,
                            color: tickColor,
                            font: { size: 10, family: fontMono },
                            callback: function (v) { return v; },
                        },
                        grid: { color: gridColor, lineWidth: 1 },
                        border: { display: true, color: axisColor },
                    },
                },
            },
        });

        return DEFAULT_CHART;
    }

    function destroy() {
        destroyExisting();
    }

    global.HealthTrendChart = { render: render, destroy: destroy };
})(typeof window !== 'undefined' ? window : this);
