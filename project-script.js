const _DC = window.DashboardConstants || {};
const _WEIGHTS = _DC.RATING_WEIGHTS || { DELIVERY_WEIGHT: 0.45, FLOW_WEIGHT: 0.10, STABILITY_WEIGHT: 0.10, QUALITY_WEIGHT: 0.20, RISK_WEIGHT: 0.05, AI_ADOPTION_WEIGHT: 0.10 };
const _BENCH = _DC.RATING_BENCHMARKS || { CYCLE_ELITE_DAYS: 12, CYCLE_STRONG_DAYS: 21, CYCLE_POOR_DAYS: 52, CARRYOVER_GOOD_MAX: 10, CARRYOVER_POOR_MIN: 30, COMPOSITE_ELITE: 85, COMPOSITE_STRONG: 70, COMPOSITE_STABLE: 55, COMPOSITE_AT_RISK: 40 };
const _SCORE = _DC.SCORE_THRESHOLDS || { DEFAULT_CYCLE: 3 };
const PILLAR_RATING_LABELS = { 5: 'Stellar', 4: 'Surge', 3: 'Cruise', 2: 'Friction', 1: 'Breach' };

let fullProjectHistory = [];
let devChartInst, qaChartInst, trendChartInst, cycleChartInst, carryBugChartInst;
let detailWorkCatChartInst = null;
let detailEpicChartInst = null;
let trExecutionChartInst = null;
let trRateChartInst = null;
/** QA/SDET title exclusions (no external roster; reserved for future use). */
let detailExcludedDevNames = [];
/** resolved project key for AI (matches JIRA product name in history). */
let detailProjectName = '';
let copilotDataForAi = null;
let cursorDataForAi = null;

function detailDevresourceWeights() {
    var w = window.DashboardScoringRuntime && window.DashboardScoringRuntime.devData && window.DashboardScoringRuntime.devData.weights;
    if (w && typeof w === 'object') return w;
    return {
        DELIVERY: 0.18,
        GITHUB_IMPACT: 0.22,
        GITHUB_QUALITY: 0.12,
        CONSISTENCY: 0.11,
        IMPACT_BREADTH: 0.08,
        CONFLUENCE_DOCS: 0.05,
        CURSOR_LEADERBOARD: 0.08,
        COPILOT_INDIVIDUAL: 0.08,
        AI_TOOLS_ADOPTION: 0.08,
    };
}

function detailDevCombinedCap() {
    var c = window.DashboardScoringRuntime && window.DashboardScoringRuntime.devData && window.DashboardScoringRuntime.devData.combinedToolsMaxWeight;
    var n = Number(c);
    return Number.isFinite(n) ? Math.min(0.5, Math.max(0, n)) : 0.24;
}

function buildresourceIndsFromHistory(history, projectName) {
    var inds = {};
    var ADC = typeof AiDevToolsContext !== 'undefined' ? AiDevToolsContext : null;
    var copilotLB = copilotDataForAi && copilotDataForAi.userLeaderboard ? copilotDataForAi.userLeaderboard : null;
    var hasDevToolsData = (cursorDataForAi || copilotLB) && projectName;
    (history || []).forEach(function (d) {
        (d.individuals || []).forEach(function (i) {
            var name = i.name;
            if (!name) return;
            if (!inds[name]) inds[name] = { pts: 0, ai: [], team: projectName, sprintPresence: 0, projects: new Set(), confluencePages: 0 };
            inds[name].pts += Number.isFinite(Number(i.pts)) ? Number(i.pts) : 0;
            var aiVal = 0;
            if (hasDevToolsData && ADC && ADC.computePersonAiAdoptionRating) {
                var computed = ADC.computePersonAiAdoptionRating(i.name, i.pts, d.individuals, projectName, cursorDataForAi, copilotDataForAi);
                if (computed != null) aiVal = computed;
            } else if (i.ai != null) aiVal = Number(i.ai);
            inds[name].ai.push(Number.isFinite(aiVal) ? aiVal : 0);
            if ((Number(i.pts) || 0) > 0 || Number.isFinite(Number(aiVal))) inds[name].sprintPresence += 1;
            if (projectName) inds[name].projects.add(projectName);
        });
        (d.confluenceActivity || []).forEach(function (c) {
            var nm = (c.name || '').trim();
            if (!nm || nm === '—') return;
            if (!inds[nm]) inds[nm] = { pts: 0, ai: [], team: projectName, sprintPresence: 0, projects: new Set(), confluencePages: 0 };
            inds[nm].confluencePages += (Number(c.pagesCreated) || 0) + (Number(c.pagesEdited) || 0);
        });
    });
    return inds;
}

function computeDetailresourceScores(inds, ghRows) {
    if (!window.VelosyncresourceScore || typeof window.VelosyncresourceScore.compute !== 'function') return [];
    var ADC = typeof AiDevToolsContext !== 'undefined' ? AiDevToolsContext : null;
    if (!ADC || typeof ADC.similarEnough !== 'function' || typeof ADC.getCursorLeaderboardRowsForMatch !== 'function') return [];
    var copilotLB = copilotDataForAi && copilotDataForAi.userLeaderboard ? copilotDataForAi.userLeaderboard : null;
    return window.VelosyncresourceScore.compute(
        inds,
        ghRows,
        cursorDataForAi,
        copilotDataForAi,
        copilotLB,
        detailDevresourceWeights(),
        detailDevCombinedCap(),
        { similarEnough: ADC.similarEnough, getCursorLeaderboardRowsForMatch: ADC.getCursorLeaderboardRowsForMatch }
    );
}

function qaDetailWeights() {
    var w = window.DashboardScoringRuntime && window.DashboardScoringRuntime.qaData && window.DashboardScoringRuntime.qaData.weights;
    if (w && typeof w === 'object') return w;
    return { VOLUME: 0.4, COVERAGE: 0.3, AUTHORSHIP: 0.1, CONSISTENCY: 0.05, COMPLEXITY: 0.1, DOCS: 0.05 };
}

function qaDetailBandTiers() {
    var b = window.DashboardScoringRuntime && window.DashboardScoringRuntime.qaData && window.DashboardScoringRuntime.qaData.bands;
    if (b && typeof b === 'object') {
        return {
            stellar: Number(b.stellarMin) || 90,
            surge: Number(b.surgeMin) || 70,
            cruise: Number(b.cruiseMin) || 50,
        };
    }
    return { stellar: 90, surge: 70, cruise: 50 };
}

function detailThemeLight() {
    return typeof document !== 'undefined' && document.documentElement.classList.contains('theme-light');
}
/** Chart.js tick / legend / grid colors when project detail uses theme-light (mirrors main dashboard). */
function detailChartPalette() {
    if (detailThemeLight()) {
        return {
            tick: '#334155',
            tickMuted: '#475569',
            legend: '#334155',
            axisTitle: '#475569',
            grid: 'rgba(15, 23, 42, 0.1)',
            gridFaint: 'rgba(15, 23, 42, 0.06)',
            border: 'rgba(100, 116, 139, 0.3)',
        };
    }
    return {
        tick: '#94a3b8',
        tickMuted: '#64748b',
        legend: '#cbd5e1',
        axisTitle: '#64748b',
        grid: 'rgba(148, 163, 184, 0.12)',
        gridFaint: 'rgba(148, 163, 184, 0.08)',
        border: 'rgba(148, 163, 184, 0.2)',
    };
}
function detailTooltipChartTheme() {
    if (detailThemeLight()) {
        return {
            backgroundColor: 'rgba(255, 255, 255, 0.97)',
            titleColor: '#0f172a',
            bodyColor: '#334155',
            borderColor: 'rgba(148, 163, 184, 0.35)',
        };
    }
    return {
        backgroundColor: 'rgba(15, 23, 42, 0.94)',
        titleColor: '#f1f5f9',
        bodyColor: '#cbd5e1',
        borderColor: 'rgba(148, 163, 184, 0.22)',
    };
}

window.onload = async () => {
    const params = new URLSearchParams(window.location.search);
    const targetProject = params.get('project');
    if (!targetProject) return;
    detailProjectName = targetProject;

    if (typeof fetchDashboardScoring === 'function') {
        try {
            await fetchDashboardScoring();
        } catch (e) { /* non-fatal */ }
    }

    const rawHistory = localStorage.getItem('allProjectsHistory');
    if (rawHistory) {
        const allHistory = JSON.parse(rawHistory);
        const key = Object.keys(allHistory).find(k => k.toLowerCase() === targetProject.toLowerCase());
        fullProjectHistory = allHistory[key] || [];
    }

    fullProjectHistory.sort((a, b) => new Date(a.reviewDate) - new Date(b.reviewDate));

    if (typeof AiDevToolsContext !== 'undefined' && AiDevToolsContext.fetchDevToolsJson) {
        try {
            const o = await AiDevToolsContext.fetchDevToolsJson();
            copilotDataForAi = o.copilot;
            cursorDataForAi = o.cursor;
        } catch (e) { /* non-fatal */ }
    }

    if (fullProjectHistory.length > 0) {
        initSlider(targetProject);
        updateDashboard(targetProject, fullProjectHistory);
        const generateBtn = document.getElementById('generateDetailAiBtn');
        if (generateBtn) generateBtn.addEventListener('click', () => triggerAIAnalysis());
    }
};

function getSelectedHistorySlice() {
    const startInput = document.getElementById('rangeStart');
    const endInput = document.getElementById('rangeEnd');
    const maxIdx = fullProjectHistory.length - 1;
    if (maxIdx < 0) return [];
    let s = parseInt(startInput?.value ?? '0', 10);
    let e = parseInt(endInput?.value ?? String(maxIdx), 10);
    if (Number.isNaN(s)) s = 0;
    if (Number.isNaN(e)) e = maxIdx;
    if (s > e) [s, e] = [e, s];
    return fullProjectHistory.slice(s, e + 1);
}

/** Re-run charts/tables after theme toggle (Chart.js colors follow `theme-light`). */
function refreshProjectDetailChartsForTheme() {
    if (!detailProjectName || !fullProjectHistory.length) return;
    updateDashboard(detailProjectName, getSelectedHistorySlice());
}
window.refreshProjectDetailChartsForTheme = refreshProjectDetailChartsForTheme;

function isDetailDevExcluded(personName) {
    if (!personName || !detailExcludedDevNames.length) return false;
    return detailExcludedDevNames.some((excl) => similarEnoughDetail(personName, excl));
}

function normalizeForDetailMatch(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function editDistDetail(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i += 1) {
        const curr = [i];
        for (let j = 1; j <= n; j += 1) {
            curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
        }
        prev = curr;
    }
    return prev[n];
}
function similarEnoughDetail(a, b) {
    const na = normalizeForDetailMatch(a);
    const nb = normalizeForDetailMatch(b);
    if (na.length < 2 || nb.length < 2) return na === nb;
    if (na.includes(nb) || nb.includes(na)) return true;
    const aParts = na.split(' ');
    const bParts = nb.split(' ');
    const aIsShortForm = aParts.length === 2 && aParts[1].length === 1;
    const bIsShortForm = bParts.length === 2 && bParts[1].length === 1;
    if ((aIsShortForm || aParts.length === 1) && bParts.length >= 2) {
        const aFirst = aParts[0], bFirst = bParts[0];
        if (aFirst.length >= 5 && bFirst.length >= 5 &&
            (aFirst === bFirst || editDistDetail(aFirst, bFirst) <= 1)) return true;
    }
    if ((bIsShortForm || bParts.length === 1) && aParts.length >= 2) {
        const aFirst = aParts[0], bFirst = bParts[0];
        if (aFirst.length >= 5 && bFirst.length >= 5 &&
            (aFirst === bFirst || editDistDetail(aFirst, bFirst) <= 1)) return true;
    }
    return false;
}

function workCatSegmentColorDetail(index) {
    const h = (38 + index * 47.3) % 360;
    return {
        bg: `hsla(${h}, 58%, 52%, 0.88)`,
        border: `hsla(${h}, 58%, 68%, 0.35)`,
    };
}

/** Distinct hue sequence for epic chart (offset from work-cat palette). */
function epicSegmentColorDetail(index) {
    const h = (210 + index * 41.7) % 360;
    return {
        bg: `hsla(${h}, 55%, 50%, 0.9)`,
        border: `hsla(${h}, 55%, 65%, 0.38)`,
    };
}

/**
 * Per-sprint Work Classification % stacked bars (same logic as org dashboard Work Categorization).
 */
function renderDetailWorkCatChart(history) {
    const section = document.getElementById('detailWorkCategorizationSection');
    const canvas = document.getElementById('detailWorkCategorizationChart');
    if (!section || !canvas) return;
    const h = history || [];
    if (detailWorkCatChartInst) {
        try { detailWorkCatChartInst.destroy(); } catch (e) { /* ignore */ }
        detailWorkCatChartInst = null;
    }
    const perSprint = h.map((entry) => {
        const wc = Array.isArray(entry.workClassification) ? entry.workClassification : [];
        let sumClosed = 0;
        let sumOpened = 0;
        const byCat = new Map();
        wc.forEach((row) => {
            const c = String(row.category || '').trim();
            if (!c) return;
            const o = Number(row.opened) || 0;
            const cl = Number(row.closed) || 0;
            sumClosed += cl;
            sumOpened += o;
            byCat.set(c, { opened: o, closed: cl });
        });
        const useClosed = sumClosed > 0;
        const total = useClosed ? sumClosed : sumOpened;
        const shortDate = entry.reviewDate ? String(entry.reviewDate).split('-').slice(1).join('/') : '—';
        return { label: shortDate, entry, useClosed, total, byCat };
    });
    const hasAnyData = perSprint.some((p) => p.total > 0);
    if (!hasAnyData) {
        section.classList.add('hidden');
        return;
    }
    const catSet = new Set();
    perSprint.forEach((p) => {
        if (p.total <= 0) return;
        p.byCat.forEach((_, cat) => {
            const row = p.byCat.get(cat);
            const v = p.useClosed ? (row ? row.closed : 0) : (row ? row.opened : 0);
            if (v > 0) catSet.add(cat);
        });
    });
    if (catSet.size === 0) {
        section.classList.add('hidden');
        return;
    }
    const categories = [...catSet].sort((a, b) => {
        const ua = /^uncategorized$/i.test(a);
        const ub = /^uncategorized$/i.test(b);
        if (ua && !ub) return 1;
        if (!ua && ub) return -1;
        return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    const labels = perSprint.map((p) => p.label);
    const datasets = categories.map((cat, idx) => {
        const colors = workCatSegmentColorDetail(idx);
        return {
            label: cat,
            data: perSprint.map((p) => {
                if (p.total <= 0) return 0;
                const row = p.byCat.get(cat);
                const raw = p.useClosed ? (row ? row.closed : 0) : (row ? row.opened : 0);
                return (100 * raw) / p.total;
            }),
            backgroundColor: colors.bg,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 4,
            stack: 'wc',
        };
    });
    const fontMono = "'JetBrains Mono', ui-monospace, monospace";
    const dp = detailChartPalette();
    const tt = detailTooltipChartTheme();
    const tooltipMeta = { perSprint, categories };
    section.classList.remove('hidden');
    if (typeof Chart === 'undefined') {
        section.classList.add('hidden');
        return;
    }
    try {
        detailWorkCatChartInst = new Chart(canvas, {
            type: 'bar',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 500 },
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: {
                        stacked: true,
                        ticks: { color: dp.tick, font: { size: 10, family: fontMono, weight: '600' }, maxRotation: 40, minRotation: 0 },
                        grid: { display: false },
                        border: { display: true, color: dp.border },
                    },
                    y: {
                        stacked: true,
                        min: 0,
                        max: 100,
                        ticks: {
                            color: dp.tick,
                            font: { size: 10, family: fontMono, weight: '600' },
                            callback: (v) => (Number.isFinite(v) ? `${v}%` : ''),
                        },
                        title: {
                            display: true,
                            text: 'Share (%)',
                            color: dp.axisTitle,
                            font: { size: 11, family: fontMono, weight: '600' },
                        },
                        grid: { color: dp.gridFaint, lineWidth: 1 },
                        border: { display: false },
                    },
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'bottom',
                        align: 'start',
                        labels: {
                            color: dp.legend,
                            font: { size: 10, family: fontMono, weight: '600' },
                            usePointStyle: true,
                            pointStyle: 'rectRounded',
                            padding: 16,
                            boxWidth: 10,
                            boxHeight: 10,
                        },
                    },
                    tooltip: {
                        ...tt,
                        borderWidth: 1,
                        padding: 12,
                        cornerRadius: 12,
                        callbacks: {
                            title: (items) => {
                                const idx = items && items[0] ? items[0].dataIndex : 0;
                                const e = tooltipMeta.perSprint[idx];
                                return e && e.entry ? `${e.entry.reviewDate || ''}${e.entry.period ? ` · ${e.entry.period}` : ''}` : '';
                            },
                            label: (ctx) => {
                                const cat = ctx.dataset.label || '';
                                const idx = ctx.dataIndex;
                                const pct = ctx.parsed && typeof ctx.parsed.y === 'number' ? ctx.parsed.y : Number(ctx.raw) || 0;
                                const pp = tooltipMeta.perSprint[idx];
                                if (!pp) return ` ${cat}: ${pct.toFixed(1)}%`;
                                const row = pp.byCat.get(cat);
                                const raw = pp.useClosed ? (row ? row.closed : 0) : (row ? row.opened : 0);
                                const basis = pp.useClosed ? 'closed' : 'opened';
                                return ` ${cat}: ${pct.toFixed(1)}% (${raw} ${basis})`;
                            },
                        },
                    },
                },
            },
        });
        if (window.ChartZoom) window.ChartZoom.enable(detailWorkCatChartInst, { title: 'Work Categorization — per sprint', eyebrow: 'Stacked share (%)' });
    } catch (err) {
        console.error('[Project detail] Work Categorization chart failed:', err);
        detailWorkCatChartInst = null;
        section.classList.add('hidden');
    }
}

const OTHER_EPICS_LABEL = 'Other epics';

/**
 * Per-sprint epic mix: % stacked bars using **top 5** epics by total (opened+closed) across the range, plus Other.
 */
function renderDetailEpicChart(history) {
    const section = document.getElementById('detailEpicWorkSection');
    const canvas = document.getElementById('detailEpicWorkChart');
    if (!section || !canvas) return;
    const h = history || [];
    if (detailEpicChartInst) {
        try { detailEpicChartInst.destroy(); } catch (e) { /* ignore */ }
        detailEpicChartInst = null;
    }
    const perSprintRaw = h.map((entry) => {
        const ew = Array.isArray(entry.epicWork) ? entry.epicWork : [];
        let sumClosed = 0;
        let sumOpened = 0;
        const byCat = new Map();
        ew.forEach((row) => {
            const c = String(row.category || '').trim();
            if (!c) return;
            const o = Number(row.opened) || 0;
            const cl = Number(row.closed) || 0;
            sumClosed += cl;
            sumOpened += o;
            byCat.set(c, { opened: o, closed: cl });
        });
        const useClosed = sumClosed > 0;
        const total = useClosed ? sumClosed : sumOpened;
        const shortDate = entry.reviewDate ? String(entry.reviewDate).split('-').slice(1).join('/') : '—';
        return { label: shortDate, entry, useClosed, total, byCat };
    });
    const hasAnyData = perSprintRaw.some((p) => p.total > 0);
    if (!hasAnyData) {
        section.classList.add('hidden');
        return;
    }
    const globalWeight = new Map();
    perSprintRaw.forEach((p) => {
        if (p.total <= 0) return;
        p.byCat.forEach((v, raw) => {
            const w = (Number(v.opened) || 0) + (Number(v.closed) || 0);
            if (w <= 0) return;
            globalWeight.set(raw, (globalWeight.get(raw) || 0) + w);
        });
    });
    const sorted = [...globalWeight.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    if (sorted.length === 0) {
        section.classList.add('hidden');
        return;
    }
    const top5 = sorted.slice(0, 5);
    const topSet = new Set(top5);
    const needOther = sorted.length > 5;
    const categories = needOther ? [...top5, OTHER_EPICS_LABEL] : [...sorted];

    const perSprint = perSprintRaw.map((p) => {
        const byCat = new Map();
        if (p.total <= 0) {
            return { label: p.label, entry: p.entry, useClosed: p.useClosed, total: 0, byCat };
        }
        p.byCat.forEach((v, raw) => {
            const disp = needOther && !topSet.has(raw) ? OTHER_EPICS_LABEL : raw;
            const cur = byCat.get(disp) || { opened: 0, closed: 0 };
            cur.opened += Number(v.opened) || 0;
            cur.closed += Number(v.closed) || 0;
            byCat.set(disp, cur);
        });
        let sumClosed = 0;
        let sumOpened = 0;
        byCat.forEach((v) => {
            sumClosed += Number(v.closed) || 0;
            sumOpened += Number(v.opened) || 0;
        });
        const useClosed = sumClosed > 0;
        const total = useClosed ? sumClosed : sumOpened;
        return { label: p.label, entry: p.entry, useClosed, total, byCat };
    });

    const labels = perSprint.map((p) => p.label);
    const datasets = categories.map((cat, idx) => {
        const colors = epicSegmentColorDetail(idx);
        return {
            label: cat,
            data: perSprint.map((p) => {
                if (p.total <= 0) return 0;
                const row = p.byCat.get(cat);
                const raw = p.useClosed ? (row ? row.closed : 0) : (row ? row.opened : 0);
                return (100 * raw) / p.total;
            }),
            backgroundColor: colors.bg,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 4,
            stack: 'epic',
        };
    });
    const fontMono = "'JetBrains Mono', ui-monospace, monospace";
    const dp = detailChartPalette();
    const tt = detailTooltipChartTheme();
    const tooltipMeta = { perSprint, categories };
    section.classList.remove('hidden');
    if (typeof Chart === 'undefined') {
        section.classList.add('hidden');
        return;
    }
    try {
        detailEpicChartInst = new Chart(canvas, {
            type: 'bar',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 500 },
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: {
                        stacked: true,
                        ticks: { color: dp.tick, font: { size: 10, family: fontMono, weight: '600' }, maxRotation: 40, minRotation: 0 },
                        grid: { display: false },
                        border: { display: true, color: dp.border },
                    },
                    y: {
                        stacked: true,
                        min: 0,
                        max: 100,
                        ticks: {
                            color: dp.tick,
                            font: { size: 10, family: fontMono, weight: '600' },
                            callback: (v) => (Number.isFinite(v) ? `${v}%` : ''),
                        },
                        title: {
                            display: true,
                            text: 'Share (%)',
                            color: dp.axisTitle,
                            font: { size: 11, family: fontMono, weight: '600' },
                        },
                        grid: { color: dp.gridFaint, lineWidth: 1 },
                        border: { display: false },
                    },
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'bottom',
                        align: 'start',
                        labels: {
                            color: dp.legend,
                            font: { size: 9, family: fontMono, weight: '600' },
                            usePointStyle: true,
                            pointStyle: 'rectRounded',
                            padding: 12,
                            boxWidth: 10,
                            boxHeight: 10,
                        },
                    },
                    tooltip: {
                        ...tt,
                        borderWidth: 1,
                        padding: 12,
                        cornerRadius: 12,
                        callbacks: {
                            title: (items) => {
                                const idx = items && items[0] ? items[0].dataIndex : 0;
                                const e = tooltipMeta.perSprint[idx];
                                return e && e.entry ? `${e.entry.reviewDate || ''}${e.entry.period ? ` · ${e.entry.period}` : ''}` : '';
                            },
                            label: (ctx) => {
                                const cat = ctx.dataset.label || '';
                                const idx = ctx.dataIndex;
                                const pct = ctx.parsed && typeof ctx.parsed.y === 'number' ? ctx.parsed.y : Number(ctx.raw) || 0;
                                const pp = tooltipMeta.perSprint[idx];
                                if (!pp) return ` ${cat}: ${pct.toFixed(1)}%`;
                                const row = pp.byCat.get(cat);
                                const raw = pp.useClosed ? (row ? row.closed : 0) : (row ? row.opened : 0);
                                const basis = pp.useClosed ? 'closed' : 'opened';
                                return ` ${cat}: ${pct.toFixed(1)}% (${raw} ${basis})`;
                            },
                        },
                    },
                },
            },
        });
        if (window.ChartZoom) window.ChartZoom.enable(detailEpicChartInst, { title: 'Epic Focus — per sprint', eyebrow: 'Top 5 epics + Other' });
    } catch (err) {
        console.error('[Project detail] Epic focus chart failed:', err);
        detailEpicChartInst = null;
        section.classList.add('hidden');
    }
}

function refreshDetailDistributionCharts(history) {
    renderDetailWorkCatChart(history);
    renderDetailEpicChart(history);
}

function computeSprintSubScores(data) {
    var comp = parseFloat(data.completion) || 0;
    var cycleRaw = parseFloat(data.cycleTime);
    var cycleVal = Number.isFinite(cycleRaw) ? cycleRaw : (_SCORE.DEFAULT_CYCLE || 3);
    var carryOver = parseFloat(data.carryOver);
    var carryVal = Number.isFinite(carryOver) ? Math.min(100, Math.max(0, carryOver)) : 0;
    var bugsOpened = parseInt(data.bugsOpened, 10) || 0;
    var bugsClosed = parseInt(data.bugsClosed, 10) || 0;
    var bugFixRate = bugsOpened > 0 ? Math.round((bugsClosed / bugsOpened) * 100) : 100;
    var blockers = parseInt(data.blockers, 10) || 0;

    var deliveryScore = Math.min(100, Math.max(0, comp));
    var cyclePoor = _BENCH.CYCLE_POOR_DAYS || 52;
    var cycleElite = _BENCH.CYCLE_ELITE_DAYS || 12;
    var flowScore = cycleVal <= cycleElite ? 100 : cycleVal >= cyclePoor ? 0 : Math.round(100 - (100 * (cycleVal - cycleElite)) / (cyclePoor - cycleElite));
    var carryGood = _BENCH.CARRYOVER_GOOD_MAX || 10;
    var carryPoor = _BENCH.CARRYOVER_POOR_MIN || 30;
    var stabilityScore = carryVal <= carryGood ? 100 : carryVal >= carryPoor ? 0 : Math.round(100 - (100 * (carryVal - carryGood)) / (carryPoor - carryGood));
    var qualityScore = Math.min(100, Math.max(0, bugFixRate));
    var riskScore = blockers === 0 ? 100 : blockers === 1 ? 60 : 0;

    var aiAdoptionScore = 50;
    var hasAI = false;
    var ADC = typeof AiDevToolsContext !== 'undefined' ? AiDevToolsContext : null;
    if ((_WEIGHTS.AI_ADOPTION_WEIGHT || 0) > 0 && ADC && (cursorDataForAi || copilotDataForAi)) {
        hasAI = true;
        var score = 50;
        if (ADC.projectMatchesCursorRepo && cursorDataForAi) {
            var repoMatch = ADC.projectMatchesCursorRepo(detailProjectName, cursorDataForAi);
            if (repoMatch.match) {
                var pct = repoMatch.codeCommittedByAiPct || 0;
                if (pct >= 60) score = 62;
                else if (pct >= 40) score = 56;
                else if (pct >= 20) score = 52;
                else score = 48;
            }
        }
        var names = (data.individuals || []).map(function (i) { return i && i.name; }).filter(Boolean);
        var onEitherLb = {};
        names.forEach(function (name) {
            var onCursor = ADC.memberMatchesCursorLeaderboard && ADC.memberMatchesCursorLeaderboard(name, cursorDataForAi);
            var onCopilot = ADC.memberMatchesCopilotLeaderboard && ADC.memberMatchesCopilotLeaderboard(name, copilotDataForAi);
            if (onCursor || onCopilot) onEitherLb[name] = true;
        });
        var onEitherCount = Object.keys(onEitherLb).length;
        if (names.length > 0 && onEitherCount > 0) {
            var boost = Math.min(20, onEitherCount * 5);
            score = Math.min(100, score + boost);
        }
        aiAdoptionScore = Math.max(0, Math.min(100, score));
    }

    var hasDelivery = comp > 0;
    var hasFlow = Number.isFinite(cycleRaw) && cycleRaw > 0;
    var hasStability = hasDelivery;
    var hasQuality = bugsOpened > 0 || bugsClosed > 0;
    var hasRisk = hasDelivery;

    return {
        delivery:   { score: deliveryScore,   has: hasDelivery,  weight: _WEIGHTS.DELIVERY_WEIGHT },
        flow:       { score: flowScore,       has: hasFlow,      weight: _WEIGHTS.FLOW_WEIGHT },
        stability:  { score: stabilityScore,  has: hasStability,  weight: _WEIGHTS.STABILITY_WEIGHT },
        quality:    { score: qualityScore,    has: hasQuality,   weight: _WEIGHTS.QUALITY_WEIGHT },
        risk:       { score: riskScore,       has: hasRisk,      weight: _WEIGHTS.RISK_WEIGHT },
        aiAdoption: { score: aiAdoptionScore, has: hasAI,        weight: _WEIGHTS.AI_ADOPTION_WEIGHT || 0 },
    };
}

function sprintCompositeToRating(score) {
    if (score >= (_BENCH.COMPOSITE_ELITE || 85)) return 5;
    if (score >= (_BENCH.COMPOSITE_STRONG || 70)) return 4;
    if (score >= (_BENCH.COMPOSITE_STABLE || 55)) return 3;
    if (score >= (_BENCH.COMPOSITE_AT_RISK || 40)) return 2;
    return 1;
}

function calculateSprintScore(data) {
    var subs = computeSprintSubScores(data);
    var dims = [];
    var keys = ['delivery', 'flow', 'stability', 'quality', 'risk', 'aiAdoption'];
    for (var i = 0; i < keys.length; i++) {
        var d = subs[keys[i]];
        if (d.has) dims.push(d);
    }
    if (!dims.length) return 1;
    var totalWeight = 0;
    for (var j = 0; j < dims.length; j++) totalWeight += dims[j].weight;
    var composite = 0;
    for (var k = 0; k < dims.length; k++) composite += (dims[k].weight / totalWeight) * dims[k].score;
    return sprintCompositeToRating(Math.round(composite));
}

function getSprintPillarScores(data) {
    var subs = computeSprintSubScores(data);
    var overall = calculateSprintScore(data);
    var keys = ['delivery', 'flow', 'stability', 'quality', 'risk', 'aiAdoption'];
    var scores = {};
    var composite = 0, totalW = 0;
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var d = subs[k];
        scores[k] = d.has ? Math.max(0, Math.min(100, Math.round(d.score))) : null;
        if (d.has) { composite += (d.weight || 0) * d.score; totalW += (d.weight || 0); }
    }
    var overallScore = totalW > 0 ? Math.round(composite / totalW) : null;
    return {
        delivery:   subs.delivery.has   ? sprintCompositeToRating(subs.delivery.score)   : null,
        flow:       subs.flow.has       ? sprintCompositeToRating(subs.flow.score)       : null,
        stability:  subs.stability.has  ? sprintCompositeToRating(subs.stability.score)  : null,
        quality:    subs.quality.has    ? sprintCompositeToRating(subs.quality.score)    : null,
        risk:       subs.risk.has       ? sprintCompositeToRating(subs.risk.score)       : null,
        aiAdoption: subs.aiAdoption.has ? sprintCompositeToRating(subs.aiAdoption.score) : null,
        overall:    overall,
        scores:       scores,
        overallScore: overallScore,
    };
}

function healthDotHtml(rating, label) {
    if (rating === null || rating === undefined) {
        return '<span class="health-dot health-dot-null" title="' + label + ': No Data"></span>';
    }
    var tag = PILLAR_RATING_LABELS[rating] || '';
    return '<span class="health-dot health-dot-' + rating + '" title="' + label + ': ' + rating + '/5 – ' + tag + '"></span>';
}

function renderSprintHealthMatrix(history) {
    var section = document.getElementById('sprintHealthMatrixSection');
    var mount = document.getElementById('sprintHealthMatrixMount');
    if (!section || !mount) return;

    if (!history || !history.length) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');

    var rows = history.map(function (entry) {
        var pillars = getSprintPillarScores(entry);
        var label = entry.reviewDate || '—';
        var period = (entry.period || '').trim();
        return {
            name: label,
            subtitle: period,
            boardType: 'Sprint',
            scores: pillars.scores,
            overall: pillars.overall,
            overallScore: pillars.overallScore,
        };
    });

    if (typeof window !== 'undefined' && window.HealthMatrixChart && typeof window.HealthMatrixChart.render === 'function') {
        window.HealthMatrixChart.render(mount, rows, { emptyMessage: 'No sprint data available.' });
    } else {
        mount.innerHTML = '<div class="hmx-empty">Health chart module is unavailable.</div>';
    }
}

function buildAiPayloadForProject(historySlice) {
    const ADC = typeof AiDevToolsContext !== 'undefined' ? AiDevToolsContext : null;
    const copilot = ADC ? ADC.getCopilotOrgSnapshot(copilotDataForAi) : null;
    const cursorOrg = ADC ? ADC.buildCursorOrgSnapshot(cursorDataForAi) : null;
    const teamNames = [...new Set(historySlice.flatMap(e => (e.individuals || []).map(i => i.name)).filter(Boolean))];
    const cursorProject = ADC ? ADC.buildCursorProjectSignals(detailProjectName, cursorDataForAi, teamNames) : null;
    const ghAgg = aggregateGitHubMetricsFromHistory(historySlice);
    const github_team = ADC ? ADC.compactGithubMetrics(
        ghAgg.map(r => ({ name: r.name, repos: r.repos, prs: r.prs, commits: r.commits, additions: r.additions, deletions: r.deletions, notes: r.notes })),
        16
    ) : ghAgg.map(r => ({ name: r.name, repos: r.repos, prs: r.prs, commits: r.commits, additions: r.additions, deletions: r.deletions }));

    const sprints = historySlice.map(s => ({
        review_date: s.reviewDate,
        sprint_name: s.period || '',
        story_points: s.points,
        sprint_completion_pct: (s.completion != null ? s.completion : 0) + '%',
        bugs_closed: s.bugsClosed,
        bugs_opened: s.bugsOpened || 0,
        cycle_time_days: s.cycleTime || 0,
        carry_over_pct: s.carryOver != null ? s.carryOver + '%' : null,
        blockers: s.blockers || 0,
        regulatory_cycle_share_pct: (s.totalCycleDays > 0 && s.regulatoryDays != null)
            ? Math.round((s.regulatoryDays / s.totalCycleDays) * 1000) / 10
            : null,
        team_output: (s.individuals || []).map(i => ({ name: i.name, story_points: i.pts || 0, ai_adoption_1_to_5: i.ai != null ? i.ai : null })),
        github_per_sprint: ADC ? ADC.compactGithubMetrics(s.githubMetrics || [], 14) : (s.githubMetrics || []).slice(0, 14),
        anomalies: (s.anomalies || []).filter(a => a.what && String(a.what).trim().length > 2 && a.what !== '—').map(a => ({
            what: a.what,
            severity: a.severity,
            owner: a.owner
        }))
    }));

    return {
        project: detailProjectName,
        analysis_scope: {
            sprint_rows_included: sprints.length,
            timeline: sprints.length ? { first_review: sprints[0].review_date, last_review: sprints[sprints.length - 1].review_date } : null
        },
        org_dev_tools: {
            copilot_org: copilot,
            copilot_user_leaderboard: ADC && ADC.getCopilotUserLeaderboardSnapshot ? ADC.getCopilotUserLeaderboardSnapshot(copilotDataForAi) : null,
            cursor_org: cursorOrg
        },
        cursor_project_signals: cursorProject,
        github_team_aggregated_across_selected_sprints: github_team,
        github_team_totals: ADC ? ADC.aggregateGithubTeamTotals(github_team) : null,
        sprints
    };
}

async function triggerAIAnalysis(retries = 1) {
    const aiResponseDiv = document.getElementById('aiResponse');
    const aiStatusText = document.getElementById('aiStatusText');
    const aiSpinner = document.getElementById('aiSpinner');
    const statusContainer = document.getElementById('aiStatusContainer');
    const generateBtn = document.getElementById('generateDetailAiBtn');
    const selectedModel = document.getElementById('modelSelector')?.value || 'anthropic/claude-sonnet-4.6';
    if (!fullProjectHistory || fullProjectHistory.length === 0) return;

    const historySlice = getSelectedHistorySlice();
    if (historySlice.length === 0) return;

    if (copilotDataForAi === null && cursorDataForAi === null && typeof AiDevToolsContext !== 'undefined' && AiDevToolsContext.fetchDevToolsJson) {
        try {
            const o = await AiDevToolsContext.fetchDevToolsJson();
            copilotDataForAi = o.copilot;
            cursorDataForAi = o.cursor;
        } catch (e) { /* ignore */ }
    }
    const aiPayload = buildAiPayloadForProject(historySlice);

    if (statusContainer) {
        statusContainer.classList.remove('hidden');
        statusContainer.classList.add('flex');
    }
    if (aiStatusText) aiStatusText.innerText = 'Analyzing...';
    if (aiSpinner) aiSpinner.classList.remove('hidden');
    if (generateBtn) {
        generateBtn.disabled = true;
        generateBtn.classList.add('opacity-50', 'cursor-not-allowed');
    }
    if (aiResponseDiv) aiResponseDiv.innerHTML = '<span class="italic text-slate-600">Sending data to AI...</span>';

    try {
        const response = await fetch("/api/ai/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({
                "model": selectedModel,
				"temperature": 0.1, // ?? Consistency
				"seed": 42,         // ?? Same output pattern
                "messages": [
                    {
                        "role": "system",
                        "content": `You are a senior IT project lead writing a crisp sprint summary for a single project.

OUTPUT FORMAT — strictly follow every rule:
- Exactly 6 bullet points, each a single sentence of = 25 words.
- Start each bullet with a dash (-). No sub-bullets, no lists inside bullets.
- Cover in order: (1) overall velocity, (2) quality/bugs, (3) predictability/cycle time, (4) AI tooling signal, (5) key risk or anomaly, (6) one actionable recommendation.
- Use only data present in the payload; skip sections that are null.

NUMBER RULES — critical:
- Never paste raw JSON field names or JSON values verbatim.
- Round all percentages to the nearest whole number (e.g. 72%, not 71.8%).
- Round decimals to 1 significant figure max (e.g. 0.3, not 0.2950).
- Always attach a unit/label to every number (e.g. "72% completion", "8 bugs", "4-day cycle time").

STYLING RULES (strictly follow, use double quotes for class attributes):
- Positive / on-track phrases: <span class="text-emerald-600 font-bold">text</span>
- Moderate concern phrases: <span class="text-amber-600 font-bold">text</span>
- Red flag / risk phrases: <span class="text-red-600 font-bold">text</span>
- Key numbers (with their label): <span class="text-blue-600 font-mono">72%</span>
- NO asterisks, NO markdown, NO HTML outside the spans above.`
                    
                    },
                    {
                        "role": "user",
                        "content": `Project intelligence payload (selected timeline only): ${JSON.stringify(aiPayload)}`
                    }
                ]
            })
        });

        if (!response.ok) {
            if (retries > 0) {
                if (aiStatusText) aiStatusText.innerText = "Retrying Analysis...";
                return triggerAIAnalysis(retries - 1);
            }
            const errorData = await response.json().catch(() => ({}));
            const msg = errorData?.error?.message ?? errorData?.error ?? errorData?.message ?? `Error ${response.status}`;
            console.error("OpenRouter Error:", errorData);
            if (aiResponseDiv) aiResponseDiv.innerText = `API Error ${response.status}: ${msg}`;
            if (aiSpinner) aiSpinner.classList.add('hidden');
            if (aiStatusText) aiStatusText.innerText = 'Error';
            if (generateBtn) {
                generateBtn.disabled = false;
                generateBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
            return;
        }

        const data = await response.json();
        const summary = data.choices[0].message.content;
        
		    
        typeWriter(summary, aiResponseDiv, 5, () => {
            if (aiSpinner) aiSpinner.classList.add('hidden');
            if (aiStatusText) {
                aiStatusText.innerText = 'Analysis Complete';
                aiStatusText.classList.add('text-emerald-500');
            }
            if (generateBtn) {
                generateBtn.disabled = false;
                generateBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        });
        aiResponseDiv.classList.add('loaded');

    } catch (error) {
        console.error("Fetch Error:", error);
        if (aiResponseDiv) aiResponseDiv.innerText = "API down";
        if (aiSpinner) aiSpinner.classList.add('hidden');
        if (aiStatusText) aiStatusText.innerText = 'Error';
        if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }
}

function initSlider(projectName) {
    const startInput = document.getElementById('rangeStart');
    const endInput = document.getElementById('rangeEnd');
    const track = document.getElementById('sliderTrack');
    const labelsContainer = document.getElementById('sliderLabels'); // ??
    
    const maxIdx = fullProjectHistory.length - 1;
    startInput.max = maxIdx;
    endInput.max = maxIdx;

    const cleanName = (projectName || '').replace(/^\*+\s*/, '').trim().toLowerCase();
    const stripProjectName = (period) => {
        if (!period || !cleanName) return (period || '').trim() || '—';
        let s = period.trim();
        const lower = s.toLowerCase();
        if (lower.startsWith(cleanName)) {
            s = s.slice(cleanName.length).trim();
        }
        if (s.startsWith('-') || s.startsWith('–') || s.startsWith('—')) s = s.slice(1).trim();
        return s || '—';
    };
    
    labelsContainer.innerHTML = fullProjectHistory.map((entry, i) => {
        const leftPerc = (i / maxIdx) * 100;
        const dateStr = entry.reviewDate ? entry.reviewDate.split('-').slice(1).join('/') : '—';
        const shortPeriod = stripProjectName(entry.period);
        return `
            <div class="tick-mark" style="left: ${leftPerc}%">
                <div class="tick-line"></div>
                <div class="tick-text">${dateStr}</div>
                <div class="tick-sprint">${shortPeriod}</div>
            </div>`;
    }).join('');

    const updateView = () => {
        let s = parseInt(startInput.value);
        let e = parseInt(endInput.value);
        if (s > e) { [s, e] = [e, s]; }

        const startEntry = fullProjectHistory[s];
        const endEntry = fullProjectHistory[e];
        document.getElementById('startDateLabel').innerText = startEntry.reviewDate + (startEntry.period ? ` · ${stripProjectName(startEntry.period)}` : '');
        document.getElementById('endDateLabel').innerText = endEntry.reviewDate + (endEntry.period ? ` · ${stripProjectName(endEntry.period)}` : '');

        // Visual Track
        const left = (s / maxIdx) * 100;
        const right = 100 - (e / maxIdx) * 100;
        track.style.left = left + "%";
        track.style.right = right + "%";

        // ?? Highlight Active Ticks
        const ticks = labelsContainer.querySelectorAll('.tick-mark');
        ticks.forEach((t, i) => {
            if (i >= s && i <= e) t.classList.add('active');
            else t.classList.remove('active');
        });

        updateDashboard(projectName, fullProjectHistory.slice(s, e + 1));
    };

    startInput.oninput = updateView;
    endInput.oninput = updateView;
    updateView();
}

function updateDashboard(name, data) {
    renderSprintHealthMatrix(data);
    renderUI(name, data);
    if (data.length > 0) renderActionables(data);
}

function renderActionables(history) {
    const aContainer = document.getElementById('anomalyContainer');
    const rows = [];
    (history || []).forEach(entry => {
        const rd = entry.reviewDate || '—';
        (entry.anomalies || []).forEach(a => {
            if (a.what && a.what.trim().length > 2 && a.what !== '—' && a.what !== '-' && a.severity && a.severity.trim() !== '-' && a.severity.trim() !== '—') {
                rows.push({ ...a, reviewDate: rd });
            }
        });
    });
    if (rows.length === 0) {
        aContainer.innerHTML = '<div class="col-span-full text-slate-500 text-sm italic py-6">No anomalies in the selected review period.</div>';
        return;
    }
    aContainer.innerHTML = rows.map(a => {
        const sev = String(a.severity || '').toLowerCase();
        const sevClass = (sev === 'high' || sev === 'blocker' || sev === 'critical') ? 'text-red-400' : 'text-amber-400';
        return `
        <div class="pd-anomaly-card group w-full min-w-0 rounded-xl border border-slate-700/60 bg-slate-900/55 p-3 sm:p-4 shadow-sm transition-colors hover:border-red-500/45">
            <div class="pd-anomaly-meta grid w-full min-w-0 grid-cols-1 gap-y-1 text-[11px] font-semibold sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center sm:gap-x-2">
                <span class="pd-anomaly-date truncate font-mono text-[11px] font-medium normal-case tracking-normal text-slate-300">${a.reviewDate}</span>
                <span class="pd-anomaly-severity shrink-0 text-center text-[10px] font-black uppercase tracking-widest ${sevClass} sm:justify-self-center">${a.severity} priority</span>
                <span class="pd-anomaly-owner truncate text-left text-[11px] font-medium normal-case tracking-normal text-slate-300 sm:text-right">Owner: ${a.owner}</span>
            </div>
            <h4 class="pd-anomaly-title mt-2 w-full min-w-0 break-words text-sm font-bold leading-snug text-white sm:text-base">${a.what}</h4>
            <p class="pd-anomaly-issue mt-2 w-full max-w-none border-t border-slate-600/45 pt-2 text-xs leading-relaxed text-slate-300 sm:text-[13px]">ISSUE: ${a.issue}</p>
        </div>`;
    }).join('');
}

function renderUI(name, history) {
    const projectNameEl = document.getElementById('projectNameDisplay');
    const bt = (history[0]?.boardType || 'Sprint').toLowerCase() === 'kanban' ? 'Kanban' : 'Sprint';
    const badgeColor = bt === 'Kanban'
        ? 'bg-violet-500/20 text-violet-300 border-violet-400/30'
        : 'bg-teal-500/20 text-teal-300 border-teal-400/30';
    projectNameEl.innerHTML = `${name} <span class="inline-block text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border align-middle ml-2 ${badgeColor}">${bt}</span>`;
    document.getElementById('managerDisplay').innerText = `Manager: ${history[0]?.manager || 'N/A'}`;
    const labels = history.map(e => e.reviewDate);
    const dp = detailChartPalette();

    // 1. Velocity & Success Chart (Remains same)
    if (trendChartInst) trendChartInst.destroy();
    trendChartInst = new Chart(document.getElementById('trendChart'), {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                { label: 'Estimated SP', data: history.map(e => e.points), borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)', fill: true, tension: 0.4, yAxisID: 'y' },
                ...(history.some(e => (e.actualPoints || 0) > 0) ? [{ label: 'Actual SP', data: history.map(e => e.actualPoints || 0), borderColor: '#60a5fa', backgroundColor: 'rgba(96, 165, 250, 0.08)', borderDash: [6, 3], fill: true, tension: 0.4, yAxisID: 'y' }] : []),
                { label: 'Success %', data: history.map(e => e.completion), borderColor: '#10b981', tension: 0.4, yAxisID: 'y1' }
            ]
        },
        options: { 
            responsive: true, maintainAspectRatio: false,
            layout: { padding: { bottom: 10, left: 2, right: 4 } },
            plugins: {
                legend: { labels: { color: dp.legend, font: { size: 10, weight: '600' } } },
            },
            scales: { 
                x: {
                    ticks: { color: dp.tick, maxRotation: 40, font: { size: 9, weight: '600' } },
                    grid: { color: dp.gridFaint },
                    border: { color: dp.border },
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: dp.tick, font: { size: 10, weight: '600' } },
                    grid: { color: dp.grid },
                    border: { color: dp.border },
                },
                y1: {
                    position: 'right',
                    min: 0,
                    max: 100,
                    grid: { display: false },
                    ticks: { color: dp.tick, font: { size: 10, weight: '600' } },
                    border: { display: false },
                },
            },
        }
    });
    if (window.ChartZoom) window.ChartZoom.enable(trendChartInst, { title: 'Velocity & Success Trend', eyebrow: 'Story Points · Completion %' });

    // 2. Developer Insights (FIXED COLORS HERE ??)
  // 2. Developer Insights (DUAL AXIS FIXED ??)
    const devNames = [...new Set(history.flatMap(e => (e.individuals || []).map(i => i.name)))]
        .filter(n => !isDetailDevExcluded(n));
    const SPRINT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];

    const ADC = typeof AiDevToolsContext !== 'undefined' ? AiDevToolsContext : null;
    const canComputeAi = ADC && ADC.computePersonAiAdoptionRating && (cursorDataForAi || copilotDataForAi);

    if (devChartInst) devChartInst.destroy();
    devChartInst = new Chart(document.getElementById('devChart'), {
        data: {
            labels: devNames,
            datasets: [
                // 1. AI Adoption Line (Right Axis - y1)
                {
                    label: 'AI Adoption (Avg)',
                    type: 'line',
                    data: devNames.map(n => {
                        const scores = history.flatMap(s => {
                            return (s.individuals || [])
                                .filter(ind => ind.name === n)
                                .map(ind => {
                                    if (canComputeAi) {
                                        const computed = ADC.computePersonAiAdoptionRating(
                                            ind.name, ind.pts, s.individuals, name, cursorDataForAi, copilotDataForAi
                                        );
                                        if (computed != null) return computed;
                                    }
                                    return parseFloat(ind.ai) || 0;
                                });
                        });
                        return scores.length ? (scores.reduce((a, b) => a + b) / scores.length).toFixed(1) : 0;
                    }),
                    borderColor: '#10b981',
                    borderWidth: 3,
                    pointBackgroundColor: '#10b981',
                    yAxisID: 'y1', // ?? Right Axis mapping
                    zIndex: 10,
                    tension: 0.4
                },
                // 2. Story Points Bars (Left Axis - y)
                ...history.map((sprint, i) => ({
                    label: sprint.reviewDate,
                    type: 'bar',
                    data: devNames.map(n => {
                        const ind = (sprint.individuals || []).find(ind => ind.name === n);
                        return ind ? ind.pts : 0;
                    }),
                    backgroundColor: SPRINT_COLORS[i % SPRINT_COLORS.length], 
                    borderRadius: 6,
                    yAxisID: 'y' // ?? Left Axis mapping
                }))
            ]
        },
        options: { 
            responsive: true, 
            maintainAspectRatio: false,
            layout: { padding: { bottom: 12 } },
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10, weight: '600' }, color: dp.legend } }
            },
            scales: {
                x: {
                    ticks: { color: dp.tick, maxRotation: 45, font: { size: 9, weight: '600' } },
                    grid: { color: dp.gridFaint },
                    border: { color: dp.border },
                },
                y: { 
                    type: 'linear',
                    display: true,
                    position: 'left',
                    beginAtZero: true, 
                    title: { display: true, text: 'STORY POINTS', color: '#3b82f6', font: { size: 10, weight: 'bold' } },
                    ticks: { color: dp.tick, font: { size: 10, weight: '600' } },
                    grid: { color: dp.grid },
                    border: { color: dp.border },
                },
                y1: { 
                    type: 'linear',
                    display: true,
                    position: 'right',
                    beginAtZero: true,
                    max: 5, // Scale 1-5 for AI
                    title: { display: true, text: 'AI ADOPTION (1-5)', color: '#10b981', font: { size: 10, weight: 'bold' } },
                    grid: { drawOnChartArea: false }, // Prevent grid clutter
                    ticks: { color: '#10b981', font: { size: 10, weight: '600' } },
                    border: { display: false },
                }
            }
        }
    });
    if (window.ChartZoom) window.ChartZoom.enable(devChartInst, { title: 'Developer Insights — Points vs AI', eyebrow: 'Per developer, by sprint' });

    // 3. QA Insights — QA Points per QA assignee, stacked by sprint (mirrors Dev Insights)
    const qaNames = [...new Set(history.flatMap(e => (e.qaIndividuals || []).map(q => q.name)))];
    const QA_SPRINT_COLORS = ['#10b981', '#06b6d4', '#8b5cf6', '#f59e0b', '#ec4899', '#3b82f6'];
    if (qaChartInst) qaChartInst.destroy();
    if (qaNames.length) {
        qaChartInst = new Chart(document.getElementById('qaChart'), {
            type: 'bar',
            data: {
                labels: qaNames,
                datasets: history.map((sprint, i) => ({
                    label: sprint.reviewDate,
                    data: qaNames.map(n => {
                        const q = (sprint.qaIndividuals || []).find(q => q.name === n);
                        return q ? q.qaPts : 0;
                    }),
                    backgroundColor: QA_SPRINT_COLORS[i % QA_SPRINT_COLORS.length],
                    borderRadius: 6,
                }))
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { bottom: 12 } },
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10, weight: '600' }, color: dp.legend } },
                    tooltip: {
                        callbacks: {
                            afterBody(items) {
                                if (!items.length) return '';
                                const name = items[0].label;
                                const totalPts = history.reduce((s, sp) => {
                                    const q = (sp.qaIndividuals || []).find(q => q.name === name);
                                    return s + (q ? q.qaPts : 0);
                                }, 0);
                                const totalTix = history.reduce((s, sp) => {
                                    const q = (sp.qaIndividuals || []).find(q => q.name === name);
                                    return s + (q ? q.qaTickets : 0);
                                }, 0);
                                return `Total QA Pts: ${totalPts}  |  Tickets: ${totalTix}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: { color: dp.tick, maxRotation: 45, font: { size: 9, weight: '600' } },
                        grid: { color: dp.gridFaint },
                        border: { color: dp.border },
                    },
                    y: {
                        beginAtZero: true,
                        title: { display: true, text: 'QA POINTS', color: '#10b981', font: { size: 10, weight: 'bold' } },
                        ticks: { color: dp.tick, font: { size: 10, weight: '600' } },
                        grid: { color: dp.grid },
                        border: { color: dp.border },
                    }
                }
            }
        });
        if (window.ChartZoom) window.ChartZoom.enable(qaChartInst, { title: 'QA Insights — QA Points by Assignee', eyebrow: 'Per QA, by sprint' });
    } else {
        const qaCtx = document.getElementById('qaChart').getContext('2d');
        qaCtx.fillStyle = '#475569';
        qaCtx.font = '12px JetBrains Mono';
        qaCtx.textAlign = 'center';
        qaCtx.fillText('No QA data available for selected range', qaCtx.canvas.width / 2, qaCtx.canvas.height / 2);
    }

    refreshDetailDistributionCharts(history);
    renderMiniCharts(labels, history);
    renderTestRailCharts(labels, history);
    updateTable(history);
    renderGitHubDataTableDetail(aggregateGitHubMetricsFromHistory(history), history);
    renderQaLeaderboardDetail(history);

    // Regulatory & Compliance % — absolute total across selected sprints
    // Uses raw cycle day sums so multi-sprint selection gives a true weighted result
    const regEl = document.getElementById('regulatoryPctDisplay');
    if (regEl) {
        const totalRegDays = history.reduce((s, e) => s + (e.regulatoryDays || 0), 0);
        const totalAllDays = history.reduce((s, e) => s + (e.totalCycleDays || 0), 0);
        if (totalAllDays > 0) {
            const absPct = Math.round((totalRegDays / totalAllDays) * 100);
            regEl.innerText = absPct + '%';
        } else {
            regEl.innerHTML = '&#8212;';
        }
    }
}

function renderMiniCharts(labels, history) {
    const dp = detailChartPalette();
    const normalizePercent = (value) => {
        const num = Number(value);
        return Number.isFinite(num) && num >= 0 ? num : null;
    };
    const computeBugFixRatePct = (entry) => {
        const bo = Number(entry?.bugsOpened);
        const bc = Number(entry?.bugsClosed);
        if (bo > 0 && Number.isFinite(bo) && Number.isFinite(bc)) {
            return Math.round((bc / bo) * 100);
        }
        return null;
    };

    if (cycleChartInst) cycleChartInst.destroy();
    cycleChartInst = new Chart(document.getElementById('cycleChart'), {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{ label: 'Days', data: history.map(e => e.cycleTime || 0), borderColor: '#f59e0b', tension: 0.3 }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { bottom: 8 } },
            plugins: {
                legend: { labels: { color: dp.legend, font: { size: 10, weight: '600' } } },
            },
            scales: {
                x: {
                    ticks: { color: dp.tick, maxRotation: 40, font: { size: 9, weight: '600' } },
                    grid: { color: dp.gridFaint },
                    border: { color: dp.border },
                },
                y: {
                    suggestedMax: 30,
                    ticks: { color: dp.tick, font: { size: 10, weight: '600' } },
                    grid: { color: dp.grid },
                    border: { color: dp.border },
                },
            },
        },
    });
    if (window.ChartZoom) window.ChartZoom.enable(cycleChartInst, { title: 'Cycle Time Trend (Avg Days)', eyebrow: 'Per sprint' });

    if (carryBugChartInst) carryBugChartInst.destroy();
    const bugFixTrend = history.map(e => computeBugFixRatePct(e));
    const carryOverTrend = history.map(e => normalizePercent(e?.carryOver));
    const trendMax = Math.max(
        100,
        ...bugFixTrend.map(v => (v == null ? 0 : v)),
        ...carryOverTrend.map(v => (v == null ? 0 : v))
    );
    const trendAxisMax = Math.ceil((trendMax * 1.1) / 10) * 10;
    carryBugChartInst = new Chart(document.getElementById('carryBugChart'), {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Bug Fix Rate (%)',
                    data: bugFixTrend,
                    borderColor: '#84cc16',
                    backgroundColor: 'rgba(132,204,22,0.08)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    spanGaps: true
                },
                {
                    label: 'Carry-over Rate (%)',
                    data: carryOverTrend,
                    borderColor: '#f43f5e',
                    backgroundColor: 'rgba(244,63,94,0.08)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    spanGaps: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { bottom: 10 } },
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10, weight: '600' }, color: dp.legend } },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y + '%' : 'N/A'}`
                    }
                }
            },
            scales: {
                y: {
                    min: 0,
                    max: trendAxisMax,
                    grid: { color: dp.grid },
                    ticks: { callback: v => v + '%', color: dp.tick, font: { size: 10, weight: '600' } },
                    border: { color: dp.border },
                },
                x: {
                    ticks: { color: dp.tick, maxRotation: 40, font: { size: 9, weight: '600' } },
                    grid: { color: dp.gridFaint },
                    border: { color: dp.border },
                },
            },
        }
    });
    if (window.ChartZoom) window.ChartZoom.enable(carryBugChartInst, { title: 'Bug Fix Rate vs Carry-over Rate', eyebrow: 'Trend (%)' });
}

function renderTestRailCharts(labels, history) {
    var section = document.getElementById('testRailChartSection');
    var execCanvas = document.getElementById('trExecutionChart');
    var rateCanvas = document.getElementById('trRateChart');
    if (!section || !execCanvas || !rateCanvas) return;

    var hasData = history.some(function (e) { return e.testRailExecution && (e.testRailExecution.casesCreated > 0 || e.testRailExecution.runsCreated > 0 || e.testRailExecution.plansCreated > 0); });
    if (!hasData) {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');

    var casesCr = [], runsCr = [], plansCr = [], totals = [];
    for (var i = 0; i < history.length; i++) {
        var tr = history[i].testRailExecution;
        var cc = tr ? (tr.casesCreated || 0) : 0;
        var rc = tr ? (tr.runsCreated || 0) : 0;
        var pc = tr ? (tr.plansCreated || 0) : 0;
        casesCr.push(cc);
        runsCr.push(rc);
        plansCr.push(pc);
        totals.push(cc + rc + pc);
    }

    var fontMono = "'JetBrains Mono', ui-monospace, monospace";
    var dp = detailChartPalette();
    var tt = detailTooltipChartTheme();

    if (trExecutionChartInst) trExecutionChartInst.destroy();
    trExecutionChartInst = new Chart(execCanvas, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Cases Created',
                    data: casesCr,
                    backgroundColor: 'rgba(20, 184, 166, 0.85)',
                    borderColor: 'rgba(20, 184, 166, 1)',
                    borderWidth: 1,
                    borderRadius: 4,
                    stack: 'tr'
                },
                {
                    label: 'Runs Created',
                    data: runsCr,
                    backgroundColor: 'rgba(59, 130, 246, 0.85)',
                    borderColor: 'rgba(59, 130, 246, 1)',
                    borderWidth: 1,
                    borderRadius: 4,
                    stack: 'tr'
                },
                {
                    label: 'Plans Created',
                    data: plansCr,
                    backgroundColor: 'rgba(139, 92, 246, 0.85)',
                    borderColor: 'rgba(139, 92, 246, 1)',
                    borderWidth: 1,
                    borderRadius: 4,
                    stack: 'tr'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10, family: fontMono, weight: '600' }, color: dp.legend, padding: 16 } },
                title: { display: true, text: 'Cases / Runs / Plans Created', color: dp.axisTitle, font: { size: 10, weight: 'bold', family: fontMono }, padding: { bottom: 12 } },
                tooltip: {
                    ...tt,
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 10,
                    titleFont: { family: fontMono, size: 11 },
                    bodyFont: { family: fontMono, size: 11 },
                    callbacks: {
                        afterBody: function (items) {
                            var idx = items[0].dataIndex;
                            var total = (casesCr[idx] || 0) + (runsCr[idx] || 0) + (plansCr[idx] || 0);
                            return 'Total: ' + total;
                        }
                    }
                }
            },
            scales: {
                x: {
                    stacked: true,
                    grid: { color: dp.gridFaint },
                    ticks: { font: { size: 9, family: fontMono, weight: '600' }, color: dp.tick, maxRotation: 45 },
                    border: { color: dp.border },
                },
                y: {
                    stacked: true,
                    grid: { color: dp.grid },
                    ticks: { font: { size: 10, family: fontMono, weight: '600' }, color: dp.tick, stepSize: 5 },
                    title: { display: true, text: 'Count', color: dp.axisTitle, font: { size: 10, family: fontMono, weight: '600' } },
                    border: { color: dp.border },
                }
            }
        }
    });
    if (window.ChartZoom) window.ChartZoom.enable(trExecutionChartInst, { title: 'TestRail — Cases / Runs / Plans Created', eyebrow: 'Per sprint, stacked' });

    if (trRateChartInst) trRateChartInst.destroy();
    trRateChartInst = new Chart(rateCanvas, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Total Authored',
                    data: totals,
                    borderColor: '#14b8a6',
                    backgroundColor: 'rgba(20, 184, 166, 0.10)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 5,
                    pointBackgroundColor: '#14b8a6',
                    pointBorderColor: '#0f172a',
                    pointBorderWidth: 2,
                    pointHoverRadius: 7,
                    spanGaps: true,
                    borderWidth: 2.5
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10, family: fontMono, weight: '600' }, color: dp.legend, padding: 16 } },
                title: { display: true, text: 'Total Authorship Trend', color: dp.axisTitle, font: { size: 10, weight: 'bold', family: fontMono }, padding: { bottom: 12 } },
                tooltip: {
                    ...tt,
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 10,
                    titleFont: { family: fontMono, size: 11 },
                    bodyFont: { family: fontMono, size: 11 },
                    callbacks: {
                        label: function (ctx) { return ctx.dataset.label + ': ' + (ctx.parsed.y != null ? ctx.parsed.y + '%' : 'N/A'); }
                    }
                }
            },
            scales: {
                y: {
                    min: 0,
                    grid: { color: dp.grid },
                    ticks: { font: { size: 10, family: fontMono, weight: '600' }, color: dp.tick, stepSize: 5 },
                    title: { display: true, text: 'Total items authored', color: dp.axisTitle, font: { size: 10, family: fontMono, weight: '600' } },
                    border: { color: dp.border },
                },
                x: {
                    grid: { color: dp.gridFaint },
                    ticks: { font: { size: 9, family: fontMono, weight: '600' }, color: dp.tick, maxRotation: 45 },
                    border: { color: dp.border },
                }
            }
        }
    });
    if (window.ChartZoom) window.ChartZoom.enable(trRateChartInst, { title: 'TestRail — Total Authorship Trend', eyebrow: 'Per sprint' });
}

function aggregateGitHubMetricsFromHistory(history) {
    const byName = new Map();
    (history || []).forEach(entry => {
        (entry.githubMetrics || []).forEach(row => {
            const name = (row.name || '').trim() || '—';
            if (!byName.has(name)) byName.set(name, { name, repos: new Set(), prs: 0, commits: 0, additions: 0, deletions: 0, notes: [], confluencePages: 0 });
            const rec = byName.get(name);
            rec.prs += Number(row.prs) || 0;
            rec.commits += Number(row.commits) || 0;
            rec.additions += Number(row.additions) || 0;
            rec.deletions += Number(row.deletions) || 0;
            if (row.repos && String(row.repos).trim() && row.repos !== '—') {
                String(row.repos).split(',').map(s => s.trim()).filter(Boolean).forEach(r => rec.repos.add(r));
            }
            if (row.notes && String(row.notes).trim()) rec.notes.push(String(row.notes).trim());
        });
        (entry.confluenceActivity || []).forEach(c => {
            const nm = (c.name || '').trim();
            if (!nm || nm === '—') return;
            if (!byName.has(nm)) byName.set(nm, { name: nm, repos: new Set(), prs: 0, commits: 0, additions: 0, deletions: 0, notes: [], confluencePages: 0 });
            byName.get(nm).confluencePages += (Number(c.pagesCreated) || 0) + (Number(c.pagesEdited) || 0);
        });
    });
    const rows = Array.from(byName.values()).map(r => ({
        name: r.name,
        repos: r.repos.size ? Array.from(r.repos).slice(0, 5).join(', ') + (r.repos.size > 5 ? ` +${r.repos.size - 5} more` : '') : '—',
        prs: r.prs,
        commits: r.commits,
        additions: r.additions,
        deletions: r.deletions,
        notes: r.notes.length ? r.notes[r.notes.length - 1] : '',
        confluencePages: r.confluencePages,
    }));
    rows.sort((a, b) => (b.commits - a.commits) || (b.prs - a.prs));
    return rows;
}

function escapeHtmlDetail(s) {
    if (s == null) return '';
    const div = document.createElement('div');
    div.textContent = String(s);
    return div.innerHTML;
}

function renderGitHubDataTableDetail(rows, history) {
    const tbody = document.getElementById('githubLeaderboardDetailBody');
    if (!tbody) return;
    if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="py-8 text-center text-slate-500 italic">No dev data for selected range.</td></tr>';
        return;
    }
    var inds = buildresourceIndsFromHistory(history || [], detailProjectName || '');
    var scores = computeDetailresourceScores(inds, rows);
    var scoreMap = new Map();
    scores.forEach(function (s) {
        var k = (s.name || '').trim();
        if (k) scoreMap.set(k, s.score);
    });
    rows.forEach(function (r) {
        var k = (r.name || '').trim();
        r.devScore = scoreMap.has(k) ? scoreMap.get(k) : null;
    });
    rows.sort(function (a, b) { return (b.devScore || 0) - (a.devScore || 0); });
    var devTiers = window.DashboardScoringRuntime && window.DashboardScoringRuntime.devData && window.DashboardScoringRuntime.devData.displayTiers;
    var gMin = devTiers && Number(devTiers.goodMin) >= 0 ? Number(devTiers.goodMin) : 8;
    var mMin = devTiers && Number(devTiers.midMin) >= 0 ? Number(devTiers.midMin) : 5;
    var lMin = devTiers && Number(devTiers.lowMin) >= 0 ? Number(devTiers.lowMin) : 3;
    tbody.innerHTML = rows.map((r, i) => {
        const zebra = i % 2 === 0 ? 'gh-leader-row--even' : 'gh-leader-row--odd';
        const docs = Number(r.confluencePages) || 0;
        const docsClass = docs > 0 ? 'text-orange-600 font-semibold' : 'text-slate-500';
        const score = r.devScore;
        const scoreNum = score != null ? score : null;
        const scoreClass = scoreNum == null ? 'text-slate-500' : scoreNum >= gMin ? 'text-emerald-600 font-black' : scoreNum >= mMin ? 'text-amber-600 font-bold' : scoreNum >= lMin ? 'text-slate-700 font-bold' : 'text-slate-500';
        const barWidth = scoreNum != null ? Math.max(4, scoreNum * 10) : 4;
        const barColor = scoreNum == null ? 'from-slate-600 to-slate-500' : scoreNum >= gMin ? 'from-emerald-500 to-emerald-400' : scoreNum >= mMin ? 'from-amber-500 to-amber-400' : scoreNum >= lMin ? 'from-slate-500 to-slate-400' : 'from-slate-600 to-slate-500';
        const scoreLabel = scoreNum != null ? String(scoreNum) : '—';
        return `<tr class="gh-leader-row border-b transition-colors ${zebra}">
            <td class="py-3 px-4 gh-leader-name">${escapeHtmlDetail(r.name)}</td>
            <td class="py-3 px-4 gh-leader-repos truncate" style="max-width:0" title="${escapeHtmlDetail(r.repos)}">${escapeHtmlDetail(r.repos)}</td>
            <td class="py-3 px-4 gh-num tabular-nums text-cyan-600 font-bold"><span class="gh-num-block">${r.prs}</span></td>
            <td class="py-3 px-4 gh-num tabular-nums text-emerald-600 font-bold"><span class="gh-num-block">${r.commits}</span></td>
            <td class="py-3 px-4 gh-num tabular-nums text-green-700 font-semibold"><span class="gh-num-block">${r.additions}</span></td>
            <td class="py-3 px-4 gh-num tabular-nums text-rose-600 font-semibold"><span class="gh-num-block">${r.deletions}</span></td>
            <td class="py-3 px-4 gh-num tabular-nums ${docsClass}"><span class="gh-num-block">${docs}</span></td>
            <td class="py-3 px-4">
                <div class="flex items-center gap-2">
                    <span class="tabular-nums ${scoreClass} text-sm w-6 text-right shrink-0">${scoreLabel}</span>
                    <div class="flex-1 h-1.5 rounded-full gh-score-track overflow-hidden">
                        <div class="h-full rounded-full bg-gradient-to-r ${barColor}" style="width:${barWidth}%"></div>
                    </div>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function renderQaLeaderboardDetail(history) {
    var tbody = document.getElementById('qaLeaderboardDetailBody');
    if (!tbody) return;
    var byName = new Map();
    var sprintCount = (history || []).length;
    for (var s = 0; s < (history || []).length; s++) {
        var entry = history[s];
        var ensure = function (n) {
            if (!byName.has(n)) byName.set(n, { name: n, totalPts: 0, totalTickets: 0, confluencePages: 0, trCasesCreated: 0, trRunsCreated: 0, trPlansCreated: 0, sprints: new Set() });
            return byName.get(n);
        };
        if (Array.isArray(entry.qaIndividuals)) {
            for (var q = 0; q < entry.qaIndividuals.length; q++) {
                var qi = entry.qaIndividuals[q];
                var n = (qi.name || '').trim();
                if (!n || n === '—') continue;
                var rec = ensure(n);
                rec.totalPts += qi.qaPts || 0;
                rec.totalTickets += qi.qaTickets || 0;
                rec.sprints.add(s);
            }
        }
        if (Array.isArray(entry.testRailQA)) {
            for (var t = 0; t < entry.testRailQA.length; t++) {
                var tr = entry.testRailQA[t];
                var tn = (tr.name || '').trim();
                if (!tn || tn === '—' || /^QA Tester #\d+$/i.test(tn)) continue;
                var trec = ensure(tn);
                trec.trCasesCreated += tr.casesCreated || 0;
                trec.trRunsCreated += tr.runsCreated || 0;
                trec.trPlansCreated += tr.plansCreated || 0;
                trec.sprints.add(s);
            }
        }
        (entry.confluenceActivity || []).forEach(function (c) {
            var nm = (c.name || '').trim();
            if (!nm || nm === '—') return;
            var r = byName.get(nm);
            if (r) r.confluencePages += (Number(c.pagesCreated) || 0) + (Number(c.pagesEdited) || 0);
        });
    }
    var rows = Array.from(byName.values()).map(function (r) {
        var ppt = r.totalTickets > 0 ? +(r.totalPts / r.totalTickets).toFixed(1) : 0;
        var participation = sprintCount > 0 ? r.sprints.size / sprintCount : 0;
        return {
            name: r.name, totalPts: r.totalPts, totalTickets: r.totalTickets,
            ptsPerTicket: ppt, confluencePages: r.confluencePages,
            trCasesCreated: r.trCasesCreated, trRunsCreated: r.trRunsCreated, trPlansCreated: r.trPlansCreated,
            participation: participation
        };
    });
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="11" class="py-8 text-center text-slate-500 italic">No QA data for selected range.</td></tr>';
        return;
    }
    var maxPts = Math.max(1, ...rows.map(function (r) { return r.totalPts; }));
    var maxTix = Math.max(1, ...rows.map(function (r) { return r.totalTickets; }));
    var maxPpt = Math.max(1, ...rows.map(function (r) { return r.ptsPerTicket; }));
    var maxDocs = Math.max(1, ...rows.map(function (r) { return r.confluencePages; }));
    var maxTRTotal = Math.max(1, ...rows.map(function (r) { return r.trCasesCreated + r.trRunsCreated + r.trPlansCreated; }));
    var QD = qaDetailWeights();
    var wv = Number(QD.VOLUME) || 0;
    var wc = Number(QD.COVERAGE) || 0;
    var ws = Number(QD.CONSISTENCY) || 0;
    var wx = Number(QD.COMPLEXITY) || 0;
    var wd = Number(QD.DOCS) || 0;
    var wa = Number(QD.AUTHORSHIP) || 0;
    rows.forEach(function (r) {
        var volume      = (r.totalPts / maxPts) * 100;
        var coverage    = (r.totalTickets / maxTix) * 100;
        var consistency = r.participation * 100;
        var complexity  = (r.ptsPerTicket / maxPpt) * 100;
        var docs        = (r.confluencePages / maxDocs) * 100;
        var authorship  = ((r.trCasesCreated + r.trRunsCreated + r.trPlansCreated) / maxTRTotal) * 100;
        var raw10 = (volume * wv + coverage * wc + authorship * wa + consistency * ws + complexity * wx + docs * wd) / 10;
        r.qaScore = Math.round(raw10);
    });
    rows.sort(function (a, b) { return b.qaScore - a.qaScore; });
    var bands = qaDetailBandTiers();
    var tierInfo = function (qaScore) {
        var s = qaScore * 10;
        if (s >= bands.stellar) return { label: 'Stellar',  color: 'text-emerald-700', bg: 'bg-emerald-100 border-emerald-300 text-emerald-800', barColor: 'from-emerald-500 to-emerald-400' };
        if (s >= bands.surge) return { label: 'Surge',    color: 'text-blue-700',    bg: 'bg-blue-100 border-blue-300 text-blue-800',         barColor: 'from-blue-500 to-blue-400' };
        if (s >= bands.cruise) return { label: 'Cruise',   color: 'text-amber-700',   bg: 'bg-amber-100 border-amber-300 text-amber-900',      barColor: 'from-amber-500 to-amber-400' };
        return                   { label: 'Emerging', color: 'text-rose-700',    bg: 'bg-rose-100 border-rose-300 text-rose-800',          barColor: 'from-rose-500 to-rose-400' };
    };
    tbody.innerHTML = rows.map(function (r, i) {
        var tier = tierInfo(r.qaScore);
        var zebra = i % 2 === 0 ? 'gh-leader-row--even' : 'gh-leader-row--odd';
        var barWidth = Math.max(4, r.qaScore * 10);
        var rankBadge = '<span class="inline-flex items-center justify-center w-6 h-6 rounded-full border font-black text-[10px] ' + tier.bg + '">' + (i + 1) + '</span>';
        var ptsColor = r.totalPts > 0 ? 'text-emerald-600 font-semibold' : 'text-slate-500';
        var tixColor = r.totalTickets > 0 ? 'text-cyan-600 font-semibold' : 'text-slate-500';
        var pptColor = r.ptsPerTicket > 0 ? 'text-violet-600 font-medium' : 'text-slate-500';
        var numCell = function (innerClass, text) {
            return '<td class="align-middle px-2 py-3"><span class="flex min-h-[2.25rem] w-full items-center justify-center tabular-nums leading-none ' + innerClass + '">' + text + '</span></td>';
        };
        return '<tr class="gh-leader-row border-b transition-colors ' + zebra + '">' +
            '<td class="align-middle px-3 py-3 text-center">' + rankBadge + '</td>' +
            '<td class="align-middle px-3 py-3 gh-leader-name">' + escapeHtmlDetail(r.name) + '</td>' +
            numCell(ptsColor, String(r.totalPts)) +
            numCell(tixColor, String(r.totalTickets)) +
            numCell(pptColor, String(r.ptsPerTicket)) +
            numCell((r.confluencePages > 0 ? 'text-orange-600 font-semibold' : 'text-slate-500'), String(r.confluencePages || 0)) +
            numCell((r.trCasesCreated > 0 ? 'text-teal-600 font-semibold' : 'text-slate-500'), String(r.trCasesCreated || 0)) +
            numCell((r.trRunsCreated > 0 ? 'text-blue-600 font-semibold' : 'text-slate-500'), String(r.trRunsCreated || 0)) +
            numCell((r.trPlansCreated > 0 ? 'text-violet-600 font-semibold' : 'text-slate-500'), String(r.trPlansCreated || 0)) +
            numCell(tier.color + ' font-black text-sm', String(r.qaScore)) +
            '<td class="align-middle py-3 pl-4 pr-5"><div class="flex min-h-[2.25rem] items-center gap-2">' +
                '<div class="flex-1 h-2 rounded-full gh-score-track overflow-hidden"><div class="h-full rounded-full bg-gradient-to-r ' + tier.barColor + ' transition-all" style="width:' + barWidth + '%"></div></div>' +
                '<span class="text-[9px] font-black uppercase tracking-widest ' + tier.color + ' w-[4.5rem] text-right shrink-0">' + tier.label + '</span>' +
            '</div></td>' +
        '</tr>';
    }).join('');
}

function updateTable(history) {
    document.getElementById('historyTableBody').innerHTML = [...history].reverse().map(e => {
        const bo = Number(e.bugsOpened);
        const bc = Number(e.bugsClosed);
        const bfrValid = bo > 0 && Number.isFinite(bo) && Number.isFinite(bc);
        const bfrPct = bfrValid ? Math.round((bc / bo) * 100) : null;
        const bfr = bfrValid ? bfrPct + '%' : 'N/A';
        const bfrColor = bfrValid
            ? (bfrPct >= 80 ? 'text-emerald-400' : bfrPct >= 50 ? 'text-amber-400' : 'text-red-400')
            : 'text-slate-600';
        const carryOverVal = Number(e.carryOver);
        const carryOverValid = e.carryOver != null && e.carryOver !== '' && Number.isFinite(carryOverVal) && carryOverVal >= 0;
        const car = carryOverValid ? carryOverVal + '%' : 'N/A';
        const carColor = carryOverValid
            ? (carryOverVal <= 10 ? 'text-emerald-400' : carryOverVal <= 25 ? 'text-amber-400' : 'text-red-400')
            : 'text-slate-600';
        return `
        <tr class="hover:bg-white/5 transition-all">
            <td class="p-5 font-bold align-middle pd-history-review-date">${e.reviewDate}</td>
            <td class="p-5 text-blue-400 align-middle text-right tabular-nums">${e.points}</td>
            <td class="p-5 text-pink-400 align-middle text-right tabular-nums">${e.completion}%</td>
            <td class="p-5 text-slate-400 align-middle text-right tabular-nums">${e.bugsClosed}/${e.bugsOpened}</td>
            <td class="p-5 text-amber-500 align-middle text-right tabular-nums">${e.cycleTime}d</td>
            <td class="p-5 align-middle text-right tabular-nums"><span class="font-bold ${bfrColor}">${bfr}</span></td>
            <td class="p-5 align-middle text-right tabular-nums"><span class="font-bold ${carColor}">${car}</span></td>
        </tr>`;
    }).join('');
}