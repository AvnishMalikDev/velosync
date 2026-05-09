/**
 * Shared Team Health scoring guide renderer.
 *
 * Exposes:
 *   window.refreshHealthMatrixHeaderLegend()
 *   window.refreshHealthScoringGuideTable()
 *   window.refreshHealthScoringUIFromServer()
 *
 * Reads live weights / benchmarks from window.DashboardConstants so it stays in
 * sync with admin-side overrides merged by dashboard-scoring-merge.js. Works on
 * both the main dashboard (index.html) and project-detail.html.
 */
(function (global) {
    function getBench() {
        const DC = global.DashboardConstants || {};
        return DC.RATING_BENCHMARKS || {};
    }
    function getWeights() {
        const DC = global.DashboardConstants || {};
        return DC.RATING_WEIGHTS || {};
    }

    function num(v, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    }

    function compositeBands() {
        const B = getBench();
        return {
            e: num(B.COMPOSITE_ELITE, 85),
            s: num(B.COMPOSITE_STRONG, 70),
            st: num(B.COMPOSITE_STABLE, 55),
            ar: num(B.COMPOSITE_AT_RISK, 40),
        };
    }

    function weightPct(key) {
        const map = {
            delivery: 'DELIVERY_WEIGHT',
            flow: 'FLOW_WEIGHT',
            stability: 'STABILITY_WEIGHT',
            quality: 'QUALITY_WEIGHT',
            risk: 'RISK_WEIGHT',
            aiAdoption: 'AI_ADOPTION_WEIGHT',
        };
        const v = Number(getWeights()[map[key]]);
        if (!Number.isFinite(v)) return '0%';
        return Math.round(v * 100) + '%';
    }

    function percentMetricTiers() {
        const { e, s, st, ar } = compositeBands();
        return [
            '\u2265' + e + '%',
            s + '\u2013' + (e - 1) + '%',
            st + '\u2013' + (s - 1) + '%',
            ar + '\u2013' + (st - 1) + '%',
            '<' + ar + '%',
        ];
    }

    function flowDayTiers() {
        const B = getBench();
        const ce = num(B.CYCLE_ELITE_DAYS, 12);
        const cp = num(B.CYCLE_POOR_DAYS, 52);
        const { e, s, st, ar } = compositeBands();
        const span = Math.max(1, cp - ce);
        function dForScore(T) {
            return ce + ((100 - T) / 100) * span;
        }
        const d5 = Math.round(dForScore(e));
        const d4 = Math.round(dForScore(s));
        const d3 = Math.round(dForScore(st));
        const d2 = Math.round(dForScore(ar));
        return [
            '\u2264' + d5 + 'd',
            (d5 + 1) + '\u2013' + d4 + 'd',
            (d4 + 1) + '\u2013' + d3 + 'd',
            (d3 + 1) + '\u2013' + d2 + 'd',
            '>' + d2 + 'd',
        ];
    }

    function carryTiers() {
        const B = getBench();
        const cg = num(B.CARRYOVER_GOOD_MAX, 10);
        const cpm = num(B.CARRYOVER_POOR_MIN, 30);
        const { e, s, st, ar } = compositeBands();
        const span = Math.max(1, cpm - cg);
        function cForScore(T) {
            return cg + ((100 - T) / 100) * span;
        }
        const c5 = Math.round(cForScore(e));
        const c4 = Math.round(cForScore(s));
        const c3 = Math.round(cForScore(st));
        const c2 = Math.round(cForScore(ar));
        return [
            '\u2264' + c5 + '%',
            (c5 + 1) + '\u2013' + c4 + '%',
            (c4 + 1) + '\u2013' + c3 + '%',
            (c3 + 1) + '\u2013' + c2 + '%',
            '>' + c2 + '%',
        ];
    }

    function overallTiers() {
        const { e, s, st, ar } = compositeBands();
        return [
            '\u2265' + e,
            s + '\u2013' + (e - 1),
            st + '\u2013' + (s - 1),
            ar + '\u2013' + (st - 1),
            '<' + ar,
        ];
    }

    function refreshHealthMatrixHeaderLegend() {
        const { e, s, st, ar } = compositeBands();
        const pairs = [
            ['healthMatrixLegendElite', '\u2265' + e],
            ['healthMatrixLegendStrong', s + '\u2013' + (e - 1)],
            ['healthMatrixLegendStable', st + '\u2013' + (s - 1)],
            ['healthMatrixLegendRisk', ar + '\u2013' + (st - 1)],
            ['healthMatrixLegendBreach', '<' + ar],
        ];
        pairs.forEach(([id, text]) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        });
    }

    function refreshHealthScoringGuideTable() {
        const tb = document.getElementById('healthScoringGuideTbody');
        if (!tb) return;
        const delQ = percentMetricTiers();
        const flow = flowDayTiers();
        const carry = carryTiers();
        const overall = overallTiers();
        const PILLAR_CLS = 'px-3 py-2 font-bold text-slate-900 dark:text-slate-300';
        const EMERALD = 'px-3 py-2 text-center font-semibold text-emerald-700 dark:text-emerald-400';
        const BLUE = 'px-3 py-2 text-center font-semibold text-blue-700 dark:text-blue-400';
        const AMBER = 'px-3 py-2 text-center font-semibold text-amber-700 dark:text-amber-400';
        const ORANGE = 'px-3 py-2 text-center font-semibold text-orange-700 dark:text-orange-400';
        const RED = 'px-3 py-2 text-center font-semibold text-red-700 dark:text-red-400';
        const DASH = 'px-3 py-2 text-center font-semibold text-slate-400 dark:text-slate-600';
        const rows = [];
        function row(pillar, metric, w, c0, c1, c2, c3, c4) {
            rows.push(
                '<tr><td class="' + PILLAR_CLS + '">' + pillar + '</td><td class="px-3 py-2">' + metric + '</td><td class="px-3 py-2">' + w + '</td>'
                + '<td class="' + EMERALD + '">' + c0 + '</td>'
                + '<td class="' + BLUE + '">' + c1 + '</td>'
                + '<td class="' + AMBER + '">' + c2 + '</td>'
                + '<td class="' + ORANGE + '">' + c3 + '</td>'
                + '<td class="' + RED + '">' + c4 + '</td></tr>',
            );
        }
        row('Delivery', 'Sprint Completion %', weightPct('delivery'), delQ[0], delQ[1], delQ[2], delQ[3], delQ[4]);
        row('Flow', 'Avg Review Cycle Time', weightPct('flow'), flow[0], flow[1], flow[2], flow[3], flow[4]);
        row('Stability', 'Carry-Over Rate %', weightPct('stability'), carry[0], carry[1], carry[2], carry[3], carry[4]);
        row('Quality', 'Bug Fix Rate %', weightPct('quality'), delQ[0], delQ[1], delQ[2], delQ[3], delQ[4]);
        rows.push(
            '<tr><td class="' + PILLAR_CLS + '">Risk</td><td class="px-3 py-2">Active Blockers</td><td class="px-3 py-2">' + weightPct('risk') + '</td>'
            + '<td class="' + EMERALD + '">0</td>'
            + '<td class="' + DASH + '">\u2014</td>'
            + '<td class="' + AMBER + '">1</td>'
            + '<td class="' + DASH + '">\u2014</td>'
            + '<td class="' + RED + '">2+</td></tr>',
        );
        rows.push(
            '<tr><td class="' + PILLAR_CLS + '">AI Adoption</td><td class="px-3 py-2">Cursor / Copilot Signal</td><td class="px-3 py-2">' + weightPct('aiAdoption') + '</td>'
            + '<td colspan="5" class="px-3 py-2 text-center italic text-slate-600 dark:text-slate-500">Composite of tool usage &amp; adoption signals (0\u2013100 score uses same star bands)</td></tr>',
        );
        rows.push(
            '<tr class="bg-slate-50 dark:bg-white/[0.02]"><td class="' + PILLAR_CLS + '">Overall</td><td class="px-3 py-2">Weighted Composite</td><td class="px-3 py-2">100%</td>'
            + '<td class="' + EMERALD + '">' + overall[0] + '</td>'
            + '<td class="' + BLUE + '">' + overall[1] + '</td>'
            + '<td class="' + AMBER + '">' + overall[2] + '</td>'
            + '<td class="' + ORANGE + '">' + overall[3] + '</td>'
            + '<td class="' + RED + '">' + overall[4] + '</td></tr>',
        );
        tb.innerHTML = rows.join('');
    }

    function refreshHealthScoringUIFromServer() {
        refreshHealthMatrixHeaderLegend();
        refreshHealthScoringGuideTable();
    }

    global.refreshHealthMatrixHeaderLegend = refreshHealthMatrixHeaderLegend;
    global.refreshHealthScoringGuideTable = refreshHealthScoringGuideTable;
    global.refreshHealthScoringUIFromServer = refreshHealthScoringUIFromServer;
})(typeof window !== 'undefined' ? window : this);
