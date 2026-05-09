/**
 * health-matrix-chart.js
 * ----------------------
 * Parallel-coordinates neon chart used by both the Team Health Matrix
 * (index.html) and the Sprint Health Matrix (project-detail.html).
 *
 * Public API:
 *   HealthMatrixChart.render(mountEl, rows, options)
 *
 * rows: [{
 *   name:       string,        // required, shown in the left rail
 *   subtitle?:  string,        // optional secondary line
 *   boardType?: string,        // 'Sprint' | 'Kanban' | 'Critical' | ... (for the pill)
 *   scores:     { delivery, flow, stability, quality, risk, aiAdoption } // 0-100 or null
 *   overall?:   1..5,          // star rating (used for left-rail colored bar)
 *   overallScore?: 0..100,     // weighted composite shown inside the left rail
 *   href?:      string         // optional link target for the team name
 * }]
 *
 * options: {
 *   pillars?: [{ key, label }]  // override which axes to draw + order
 *   emptyMessage?: string
 * }
 *
 * The renderer is dependency-free. Colors are hashed from the row name so
 * they stay stable across re-renders; the palette is a neon-vivid set tuned
 * for both the dark and light dashboards.
 */
(function (global) {
    'use strict';

    var DEFAULT_PILLARS = [
        { key: 'delivery',   label: 'Delivery' },
        { key: 'flow',       label: 'Flow' },
        { key: 'stability',  label: 'Stability' },
        { key: 'quality',    label: 'Quality' },
        { key: 'risk',       label: 'Risk' },
        { key: 'aiAdoption', label: 'AI Adoption' },
    ];

    /**
     * Tier palette — matches the bucket bar at the top of the dashboard
     * (Stellar/Surge/Cruise/Friction/Breach) so a row's line, dots, and rail
     * swatch all carry the same color cue as the bucket the team belongs to.
     * Click the green bucket → the lines underneath are green, etc.
     */
    var TIER_PALETTE = {
        5: '#34d399', // Stellar  — emerald
        4: '#60a5fa', // Surge    — blue
        3: '#fbbf24', // Cruise   — amber
        2: '#fb923c', // Friction — orange
        1: '#f87171', // Breach   — red
        0: '#94a3b8', // N/A      — slate
    };

    function colorForTier(tier) {
        return TIER_PALETTE[tier] || TIER_PALETTE[0];
    }

    function escapeHtml(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function boardPillClass(boardType) {
        var bt = String(boardType || '').toLowerCase();
        if (bt === 'kanban')   return 'hmx-pill hmx-pill--kanban';
        if (bt === 'critical') return 'hmx-pill hmx-pill--critical';
        if (!bt || bt === 'sprint') return 'hmx-pill hmx-pill--sprint';
        return 'hmx-pill hmx-pill--' + bt.replace(/[^a-z0-9]/g, '');
    }

    function overallTier(overallScore, overallRating) {
        var s = Number(overallScore);
        if (!Number.isFinite(s)) {
            var r = Number(overallRating);
            if (r >= 5) return 5;
            if (r >= 4) return 4;
            if (r >= 3) return 3;
            if (r >= 2) return 2;
            if (r >= 1) return 1;
            return 0;
        }
        if (s >= 85) return 5;
        if (s >= 70) return 4;
        if (s >= 55) return 3;
        if (s >= 40) return 2;
        return 1;
    }

    /**
     * Monotone-cubic path through [ {x,y}, ... ].
     * Produces a smooth curve that never overshoots the sample points — crucial
     * for a health chart where the line must not imply values outside [0, 100].
     */
    function smoothPath(points) {
        if (!points.length) return '';
        if (points.length === 1) return 'M ' + points[0].x + ' ' + points[0].y;

        // Compute slopes (Fritsch-Carlson monotone cubic interpolation).
        var n = points.length;
        var dx = new Array(n - 1);
        var dy = new Array(n - 1);
        var slope = new Array(n - 1);
        for (var i = 0; i < n - 1; i++) {
            dx[i] = points[i + 1].x - points[i].x;
            dy[i] = points[i + 1].y - points[i].y;
            slope[i] = dx[i] === 0 ? 0 : dy[i] / dx[i];
        }
        var m = new Array(n);
        m[0] = slope[0];
        m[n - 1] = slope[n - 2];
        for (var j = 1; j < n - 1; j++) {
            if (slope[j - 1] * slope[j] <= 0) {
                m[j] = 0;
            } else {
                m[j] = (slope[j - 1] + slope[j]) / 2;
            }
        }
        // Enforce monotonicity.
        for (var k = 0; k < n - 1; k++) {
            if (slope[k] === 0) {
                m[k] = 0;
                m[k + 1] = 0;
            } else {
                var a = m[k] / slope[k];
                var b = m[k + 1] / slope[k];
                var h = a * a + b * b;
                if (h > 9) {
                    var t = 3 / Math.sqrt(h);
                    m[k] = t * a * slope[k];
                    m[k + 1] = t * b * slope[k];
                }
            }
        }

        var d = 'M ' + points[0].x + ' ' + points[0].y;
        for (var s = 0; s < n - 1; s++) {
            var c1x = points[s].x + dx[s] / 3;
            var c1y = points[s].y + m[s] * dx[s] / 3;
            var c2x = points[s + 1].x - dx[s] / 3;
            var c2y = points[s + 1].y - m[s + 1] * dx[s] / 3;
            d += ' C ' + c1x + ' ' + c1y + ', ' + c2x + ' ' + c2y + ', ' + points[s + 1].x + ' ' + points[s + 1].y;
        }
        return d;
    }

    function buildRowSegments(row, pillars, xFor, yFor) {
        // Split at null gaps so lines don't connect across missing pillars.
        var segments = [];
        var current = [];
        for (var i = 0; i < pillars.length; i++) {
            var v = row.scores ? row.scores[pillars[i].key] : null;
            if (v === null || v === undefined || !Number.isFinite(Number(v))) {
                if (current.length) segments.push(current);
                current = [];
                continue;
            }
            current.push({
                x: xFor(i),
                y: yFor(Number(v)),
                value: Number(v),
                pillarIndex: i,
            });
        }
        if (current.length) segments.push(current);
        return segments;
    }

    function tooltipTemplate(teamName, pillarLabel, value) {
        return '<strong>' + escapeHtml(teamName) + '</strong>'
            + '<span class="hmx-tt-sep">·</span>'
            + escapeHtml(pillarLabel)
            + ' <span class="hmx-tt-val">' + (Math.round(value * 10) / 10) + '%</span>';
    }

    function render(mount, rows, options) {
        if (!mount) return;
        options = options || {};
        rows = Array.isArray(rows) ? rows.slice() : [];
        var pillars = Array.isArray(options.pillars) && options.pillars.length ? options.pillars : DEFAULT_PILLARS;

        if (!rows.length) {
            mount.innerHTML =
                '<div class="hmx-empty">' + escapeHtml(options.emptyMessage || 'No data to display.') + '</div>';
            return;
        }

        // Attach tier-based color so each line matches the bucket at the top
        // of the dashboard. Recompute on every render — if a team's score
        // changes tier, the line color must follow.
        rows.forEach(function (r) {
            r.__tier  = overallTier(r.overallScore, r.overall);
            r.__color = colorForTier(r.__tier);
        });

        // Geometry (SVG user-units).
        var PAD_LEFT   = 56;
        var PAD_RIGHT  = 32;
        // Extra top padding so the [Pillar] headers, 100% tick labels, and the
        // neon glow filter around the top of the curve don't visually collide.
        var PAD_TOP    = 56;
        var PAD_BOTTOM = 28;
        var INNER_W    = 640;
        var INNER_H    = 300;
        var W = PAD_LEFT + INNER_W + PAD_RIGHT;
        var H = PAD_TOP + INNER_H + PAD_BOTTOM;

        var n = pillars.length;
        function xFor(i) {
            if (n === 1) return PAD_LEFT + INNER_W / 2;
            return PAD_LEFT + (INNER_W * i) / (n - 1);
        }
        function yFor(v) {
            var clamped = Math.max(0, Math.min(100, v));
            return PAD_TOP + INNER_H * (1 - clamped / 100);
        }

        // ── Build SVG ───────────────────────────────────────────────────────
        var svg = [];
        svg.push(
            '<svg class="hmx-svg" viewBox="0 0 ' + W + ' ' + H + '" ' +
                'preserveAspectRatio="xMidYMid meet" ' +
                'role="img" aria-label="Team health parallel-coordinates chart">'
        );

        // Filters: outer neon glow for lines, softer glow for dots.
        svg.push(
            '<defs>' +
                '<filter id="hmxGlow" x="-20%" y="-20%" width="140%" height="140%">' +
                    '<feGaussianBlur stdDeviation="2.6" result="b1"/>' +
                    '<feGaussianBlur stdDeviation="5.5" result="b2"/>' +
                    '<feMerge>' +
                        '<feMergeNode in="b2"/>' +
                        '<feMergeNode in="b1"/>' +
                        '<feMergeNode in="SourceGraphic"/>' +
                    '</feMerge>' +
                '</filter>' +
                '<filter id="hmxDotGlow" x="-80%" y="-80%" width="260%" height="260%">' +
                    '<feGaussianBlur stdDeviation="3.2" result="b"/>' +
                    '<feMerge>' +
                        '<feMergeNode in="b"/>' +
                        '<feMergeNode in="SourceGraphic"/>' +
                    '</feMerge>' +
                '</filter>' +
            '</defs>'
        );

        // Tick gridlines + percentage labels per axis.
        var ticks = [0, 25, 50, 75, 100];
        for (var ai = 0; ai < n; ai++) {
            var ax = xFor(ai);
            svg.push('<line class="hmx-axis" x1="' + ax + '" y1="' + (PAD_TOP - 10) + '" x2="' + ax + '" y2="' + (PAD_TOP + INNER_H + 6) + '"/>');

            // Axis header label [Pillar]
            svg.push(
                '<text class="hmx-axis-label" x="' + ax + '" y="' + (PAD_TOP - 30) + '" text-anchor="middle">' +
                    '[' + escapeHtml(pillars[ai].label) + ']' +
                '</text>'
            );

            // Tick labels.
            for (var ti = 0; ti < ticks.length; ti++) {
                var tv = ticks[ti];
                var ty = yFor(tv);
                var anchor = (ai === 0) ? 'start' : (ai === n - 1 ? 'end' : 'middle');
                var tx = ax + (ai === 0 ? -6 : (ai === n - 1 ? 6 : 0));
                // Nudge the top (100%) tick label a bit higher so the curve+glow
                // at the ceiling doesn't overlap the "100%" text.
                var textY = (tv === 100) ? ty - 12 : ty - 4;
                svg.push(
                    '<text class="hmx-tick" x="' + tx + '" y="' + textY + '" text-anchor="' + anchor + '">' +
                        tv + '%' +
                    '</text>'
                );
            }
        }

        // Lines + dots per row. Each row sits in its own <g> so hover/dim-others is trivial.
        for (var ri = 0; ri < rows.length; ri++) {
            var row = rows[ri];
            var color = row.__color;
            var safeId = 'hmx-row-' + ri;

            svg.push(
                '<g class="hmx-row" data-row-index="' + ri + '" data-row-name="' + escapeHtml(row.name) + '" style="--hmx-color: ' + color + ';">'
            );

            var segments = buildRowSegments(row, pillars, xFor, yFor);
            for (var si = 0; si < segments.length; si++) {
                var seg = segments[si];
                if (seg.length < 2) continue;
                var d = smoothPath(seg);
                // Wide invisible hit-target for easier hover on a thin neon line.
                svg.push('<path class="hmx-line-hit" d="' + d + '"/>');
                svg.push('<path class="hmx-line" d="' + d + '"/>');
            }

            // Render dots on top (accessible tap targets).
            for (var pi = 0; pi < pillars.length; pi++) {
                var pk = pillars[pi].key;
                var val = row.scores ? row.scores[pk] : null;
                if (val === null || val === undefined || !Number.isFinite(Number(val))) continue;
                var cx = xFor(pi);
                var cy = yFor(Number(val));
                svg.push(
                    '<circle class="hmx-dot" cx="' + cx + '" cy="' + cy + '" r="4" ' +
                        'data-pillar="' + escapeHtml(pillars[pi].label) + '" ' +
                        'data-value="' + Number(val) + '" ' +
                        'data-row="' + escapeHtml(row.name) + '"/>'
                );
            }
            svg.push('</g>');
        }

        svg.push('</svg>');

        // ── Left rail (HTML, not SVG) ───────────────────────────────────────
        var railItems = [];
        for (var li = 0; li < rows.length; li++) {
            var rr = rows[li];
            var col = rr.__color;
            var tier = (rr.__tier !== undefined) ? rr.__tier : overallTier(rr.overallScore, rr.overall);
            var scoreLabel = Number.isFinite(Number(rr.overallScore))
                ? (Math.round(Number(rr.overallScore)) + '%')
                : (rr.overall ? (rr.overall + '/5') : '—');
            var pill = rr.boardType
                ? '<span class="' + boardPillClass(rr.boardType) + '">' + escapeHtml(rr.boardType) + '</span>'
                : '';
            var nameHtml = '<span class="hmx-team-name">' + escapeHtml(rr.name) + '</span>';

            var railOpen = rr.href
                ? '<a class="hmx-rail-item" href="' + escapeHtml(rr.href) + '" target="_blank" rel="noopener"'
                + ' aria-label="Open ' + escapeHtml(rr.name) + ' detail view"'
                : '<div class="hmx-rail-item"';
            var railClose = rr.href ? '</a>' : '</div>';

            railItems.push(
                railOpen + ' data-row-index="' + li + '" data-row-name="' + escapeHtml(rr.name) + '" data-tier="' + tier + '" style="--hmx-color: ' + col + ';">' +
                    '<span class="hmx-swatch" aria-hidden="true"></span>' +
                    '<div class="hmx-rail-meta">' +
                        '<div class="hmx-rail-top">' + nameHtml + pill + '</div>' +
                        (rr.subtitle ? '<div class="hmx-rail-sub">' + escapeHtml(rr.subtitle) + '</div>' : '') +
                    '</div>' +
                    '<span class="hmx-rail-score">' + escapeHtml(scoreLabel) + '</span>' +
                railClose
            );
        }

        mount.innerHTML =
            '<div class="hmx-wrap">' +
                '<div class="hmx-rail" role="list">' + railItems.join('') + '</div>' +
                '<div class="hmx-plot">' + svg.join('') + '</div>' +
                '<div class="hmx-tooltip" role="tooltip" aria-hidden="true"></div>' +
            '</div>';

        wireInteractions(mount, rows);
    }

    /* ───────────────────────── interactions ──────────────────────────────── */

    function wireInteractions(mount, rows) {
        var wrap    = mount.querySelector('.hmx-wrap');
        var tooltip = mount.querySelector('.hmx-tooltip');
        if (!wrap || !tooltip) return;

        var railItems = wrap.querySelectorAll('.hmx-rail-item');
        var rowGroups = wrap.querySelectorAll('.hmx-row');
        var dots      = wrap.querySelectorAll('.hmx-dot');
        var hitLines  = wrap.querySelectorAll('.hmx-line-hit');

        function highlight(idx) {
            wrap.classList.toggle('hmx-has-focus', idx !== null && idx !== undefined);
            rowGroups.forEach(function (g) {
                var on = String(g.getAttribute('data-row-index')) === String(idx);
                g.classList.toggle('is-active', on);
                g.classList.toggle('is-dim', idx !== null && idx !== undefined && !on);
            });
            railItems.forEach(function (el) {
                var on = String(el.getAttribute('data-row-index')) === String(idx);
                el.classList.toggle('is-active', on);
                el.classList.toggle('is-dim', idx !== null && idx !== undefined && !on);
            });
        }

        function showTooltip(target, text) {
            tooltip.innerHTML = text;
            tooltip.classList.add('is-visible');
            positionTooltip(target);
        }
        function hideTooltip() {
            tooltip.classList.remove('is-visible');
        }
        function positionTooltip(target) {
            if (!target) return;
            var wrect = wrap.getBoundingClientRect();
            var trect = target.getBoundingClientRect();
            var x = trect.left + trect.width / 2 - wrect.left;
            var y = trect.top - wrect.top - 12;
            tooltip.style.left = x + 'px';
            tooltip.style.top  = y + 'px';
        }

        railItems.forEach(function (el) {
            el.addEventListener('mouseenter', function () { highlight(el.getAttribute('data-row-index')); });
            el.addEventListener('mouseleave', function () { highlight(null); });
            el.addEventListener('focusin',   function () { highlight(el.getAttribute('data-row-index')); });
            el.addEventListener('focusout',  function () { highlight(null); });
        });

        rowGroups.forEach(function (g) {
            g.addEventListener('mouseenter', function () { highlight(g.getAttribute('data-row-index')); });
            g.addEventListener('mouseleave', function () { highlight(null); hideTooltip(); });
        });

        hitLines.forEach(function (ln) {
            ln.addEventListener('mouseenter', function () {
                var g = ln.closest('.hmx-row');
                if (g) highlight(g.getAttribute('data-row-index'));
            });
        });

        dots.forEach(function (d) {
            d.addEventListener('mouseenter', function () {
                var g = d.closest('.hmx-row');
                if (g) highlight(g.getAttribute('data-row-index'));
                showTooltip(
                    d,
                    tooltipTemplate(d.getAttribute('data-row'), d.getAttribute('data-pillar'), Number(d.getAttribute('data-value')))
                );
            });
            d.addEventListener('mouseleave', hideTooltip);
            d.addEventListener('focus', function () {
                var g = d.closest('.hmx-row');
                if (g) highlight(g.getAttribute('data-row-index'));
                showTooltip(
                    d,
                    tooltipTemplate(d.getAttribute('data-row'), d.getAttribute('data-pillar'), Number(d.getAttribute('data-value')))
                );
            });
            d.addEventListener('blur', hideTooltip);
        });

        // Tooltip also tracks pointer when hovering over the wide line hit-targets.
        hitLines.forEach(function (ln) {
            ln.addEventListener('mousemove', function (ev) {
                var g = ln.closest('.hmx-row');
                if (!g) return;
                var name = g.getAttribute('data-row-name');
                tooltip.innerHTML = '<strong>' + escapeHtml(name) + '</strong>';
                tooltip.classList.add('is-visible');
                var wrect = wrap.getBoundingClientRect();
                tooltip.style.left = (ev.clientX - wrect.left) + 'px';
                tooltip.style.top  = (ev.clientY - wrect.top - 18) + 'px';
            });
            ln.addEventListener('mouseleave', hideTooltip);
        });
    }

    global.HealthMatrixChart = { render: render };
})(typeof window !== 'undefined' ? window : this);
