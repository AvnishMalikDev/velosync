window.onload = autoLoadData;

function formatLastSync(isoString) {
    if (!isoString) return null;
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return null;
    const hours = d.getHours();
    const mins = d.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const h12 = hours % 12 || 12;
    const timeStr = `${h12}:${String(mins).padStart(2, '0')} ${ampm}`;
    const day = d.getDate();
    const ord = (n) => { const v = n % 100; if (v >= 11 && v <= 13) return 'th'; const r = n % 10; return r === 1 ? 'st' : r === 2 ? 'nd' : r === 3 ? 'rd' : 'th'; };
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dateStr = `${day}${ord(day)} ${months[d.getMonth()]} ${d.getFullYear()}`;
    return `${timeStr}, ${dateStr}`;
}

function setLastSyncDisplay(isoOrDisplayString) {
    const el = document.getElementById('liveClock');
    if (!el) return;
    if (!isoOrDisplayString) { el.innerText = 'Last sync: —'; return; }
    const isISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(isoOrDisplayString);
    const formatted = isISO ? formatLastSync(isoOrDisplayString) : isoOrDisplayString;
    el.innerText = `Last sync: ${formatted}`;
}

function parseDataAtDisplay(str) {
    if (!str || typeof str !== 'string') return null;
    const m = str.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM),\s*(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$/i);
    if (!m) return null;
    const [, h, min, ampm, day, monName, year] = m;
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const mon = months.indexOf(monName.toLowerCase());
    if (mon === -1) return null;
    let hour = parseInt(h, 10);
    if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
    const d = new Date(year, mon, parseInt(day, 10), hour, parseInt(min, 10), 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
}

function isDashboardLightTheme() {
    return typeof document !== 'undefined' && document.documentElement.classList.contains('theme-light');
}

function chartTooltipTheme() {
    if (isDashboardLightTheme()) {
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

function chartAxisTickColor() {
    return isDashboardLightTheme() ? '#334155' : '#94a3b8';
}

function chartAxisSecondaryColor() {
    return isDashboardLightTheme() ? '#475569' : '#64748b';
}

function chartLegendPrimaryColor() {
    return isDashboardLightTheme() ? '#334155' : '#cbd5e1';
}

function chartPieDoughnutBorder() {
    return isDashboardLightTheme() ? '#e2e8f0' : '#0f172a';
}

function chartPluginMutedColor() {
    return isDashboardLightTheme() ? '#475569' : '#94a3b8';
}

/** Portfolio bar charts (mainarea cards + pie zoom): ticks/legend readable on light or dark card backgrounds */
function portfolioBarChartTheme() {
    if (isDashboardLightTheme()) {
        return {
            legend: '#334155',
            legendItem: '#1e293b',
            tickX: '#334155',
            tickY: '#64748b',
            grid: 'rgba(230, 230, 233, 0.95)',
            axisLine: 'rgba(148, 163, 184, 0.5)',
        };
    }
    return {
        legend: '#94a3b8',
        legendItem: '#e2e8f0',
        tickX: '#e2e8f0',
        tickY: '#94a3b8',
        grid: 'rgba(148, 163, 184, 0.2)',
        axisLine: 'rgba(148, 163, 184, 0.25)',
    };
}

const DC = window.DashboardConstants || {};
const PIE_COLORS = DC.PIE_COLORS || ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#ef4444'];
const PIE_OTHERS_THRESHOLD = 1; // aggregate segments < this % into "other(s)"; Copilot/Cursor use 1%

/**
 * Normalized sort key for project names. Strips a leading `**` marker (plus any
 * surrounding whitespace/asterisks) so that charts on the main dashboard order
 * projects by their human name — not by the markdown emphasis used to flag
 * featured items — keeping every per-project chart's x-axis consistent.
 */
function projectSortKey(name) {
    return String(name == null ? '' : name).replace(/^[\s*]+/, '').trim().toLowerCase();
}

/** Sort a list of project names alphabetically, ignoring a leading `**` prefix. */
function sortProjectNamesForChart(names) {
    return [...names].sort((a, b) => projectSortKey(a).localeCompare(projectSortKey(b), undefined, { sensitivity: 'base' }));
}

function isOtherLabel(l) {
    return /^others?$/i.test(String(l || '').trim());
}

/** Aggregate pie segments under threshold into one segment. Use 1% for Copilot/Cursor. If "other" or "Others" (case insensitive) already exists, add below-threshold items to that group; otherwise use "Others". Returns { labels, data }. */
function collapsePieUnderThreshold(entries, thresholdPct) {
    const t = thresholdPct != null ? thresholdPct : PIE_OTHERS_THRESHOLD;
    const main = [];
    const smallList = [];
    let othersSum = 0;
    for (const [label, value] of entries) {
        const pct = Number(value) || 0;
        if (pct >= t) main.push([label, pct]);
        else {
            smallList.push([label, pct]);
            othersSum += pct;
        }
    }
    if (othersSum > 0) {
        const existingOtherInMain = main.find(([l]) => isOtherLabel(l));
        const otherLabelInSmall = smallList.find(([l]) => isOtherLabel(l))?.[0];
        const combinedLabel = otherLabelInSmall || existingOtherInMain?.[0] || 'Others';
        if (existingOtherInMain) existingOtherInMain[1] = Math.round((existingOtherInMain[1] + othersSum) * 10) / 10;
        else main.push([combinedLabel, Math.round(othersSum * 10) / 10]);
    }
    return {
        labels: main.map(([l]) => l),
        data: main.map(([, v]) => v),
    };
}

const PIE_TITLES = DC.PIE_TITLES || { piePoints: 'Avg Story Points', pieCompletion: 'Sprint Success', pieCycle: 'Avg Review Cycle', pieThroughput: 'Throughput' };
const RATING_LABELS = DC.RATING_LABELS || { 5: { text: 'Stellar', class: 'border-elite' }, 4: { text: 'Surge', class: 'border-strong' }, 3: { text: 'Cruise', class: 'border-stable' }, 2: { text: 'Friction', class: 'border-risk' }, 1: { text: 'Breach', class: 'border-critical' } };
const RATING_TIER_ORDER = [5, 4, 3, 2, 1];
const RATING_TIER_BAR_COLORS = [
    'rgba(52, 211, 153, 0.55)',
    'rgba(96, 165, 250, 0.55)',
    'rgba(251, 191, 36, 0.5)',
    'rgba(251, 146, 60, 0.52)',
    'rgba(248, 113, 113, 0.52)',
];
function ratingTierActiveBorder() {
    return isDashboardLightTheme() ? 'rgba(15, 23, 42, 0.5)' : 'rgba(255, 255, 255, 0.35)';
}
const RATING_TIER_HOVER = [
    'rgba(52, 211, 153, 0.78)',
    'rgba(96, 165, 250, 0.78)',
    'rgba(251, 191, 36, 0.75)',
    'rgba(251, 146, 60, 0.76)',
    'rgba(248, 113, 113, 0.76)',
];
const SCORE = DC.SCORE_THRESHOLDS || { COMPLETION_ELITE: 90, COMPLETION_STRONG: 80, COMPLETION_STABLE: 65, COMPLETION_AT_RISK: 45, CYCLE_ELITE: 12, CYCLE_STRONG: 21, DEFAULT_CYCLE: 25 };
const WEIGHTS = DC.RATING_WEIGHTS || { DELIVERY_WEIGHT: 0.45, FLOW_WEIGHT: 0.10, STABILITY_WEIGHT: 0.10, QUALITY_WEIGHT: 0.20, RISK_WEIGHT: 0.05, AI_ADOPTION_WEIGHT: 0.10 };
const BENCH = DC.RATING_BENCHMARKS || { COMPLETION_ELITE: 90, COMPLETION_STRONG: 80, COMPLETION_STABLE: 70, COMPLETION_AT_RISK: 50, CYCLE_ELITE_DAYS: 12, CYCLE_STRONG_DAYS: 21, CYCLE_POOR_DAYS: 52, CARRYOVER_GOOD_MAX: 10, CARRYOVER_POOR_MIN: 30, BUGFIX_GOOD_MIN: 80, BUGFIX_POOR_MAX: 50, COMPOSITE_ELITE: 85, COMPOSITE_STRONG: 70, COMPOSITE_STABLE: 55, COMPOSITE_AT_RISK: 40 };
/** Dev tools (Cursor + Copilot + AI adoption) combined weight cap (configurable via Admin). */
let DEV_DATA_COMBINED_MAX_WEIGHT = 0.24;
/**
 * Weights for resource score 0–10:
 * - Core engineering delivery signals (JIRA + GitHub + Docs) = 76%
 * - Dev tools combined (Cursor + Copilot individual + AI adoption) = 24% max
 * Sum = 1.
 */
const resource_SCORE_WEIGHTS = {
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

function applyresourceScoreWeightsFromServer(devData) {
    if (!devData || typeof devData !== 'object') return;
    if (devData.weights && typeof devData.weights === 'object') {
        Object.assign(resource_SCORE_WEIGHTS, devData.weights);
    }
    const cap = Number(devData.combinedToolsMaxWeight);
    if (Number.isFinite(cap)) {
        DEV_DATA_COMBINED_MAX_WEIGHT = Math.min(0.5, Math.max(0, cap));
    }
}
window.applyresourceScoreWeightsFromServer = applyresourceScoreWeightsFromServer;

function qaMainWeights() {
    const w = window.DashboardScoringRuntime && window.DashboardScoringRuntime.qaData && window.DashboardScoringRuntime.qaData.weights;
    if (w && typeof w === 'object') return w;
    return {
        VOLUME: 0.4,
        COVERAGE: 0.3,
        AUTHORSHIP: 0.1,
        CONSISTENCY: 0.05,
        COMPLEXITY: 0.1,
        DOCS: 0.05,
    };
}

/** QA band thresholds on 0–100 scale; main dashboard score is 0–10 ? compare as score×10. */
function qaScoreBands() {
    const b = window.DashboardScoringRuntime && window.DashboardScoringRuntime.qaData && window.DashboardScoringRuntime.qaData.bands;
    if (b && typeof b === 'object') {
        return {
            stellar: Number(b.stellarMin) || 90,
            surge: Number(b.surgeMin) || 70,
            cruise: Number(b.cruiseMin) || 50,
        };
    }
    return { stellar: 90, surge: 70, cruise: 50 };
}

function devMainDisplayTiers() {
    const d = window.DashboardScoringRuntime && window.DashboardScoringRuntime.devData && window.DashboardScoringRuntime.devData.displayTiers;
    if (d && typeof d === 'object') {
        return {
            goodMin: Number(d.goodMin) || 8,
            midMin: Number(d.midMin) || 5,
            lowMin: Number(d.lowMin) || 3,
        };
    }
    return { goodMin: 8, midMin: 5, lowMin: 3 };
}

/** Main QA table score-column tints vs 0–10 score (admin: qaData.displayTiers). */
function qaMainDisplayTiers() {
    const d = window.DashboardScoringRuntime && window.DashboardScoringRuntime.qaData && window.DashboardScoringRuntime.qaData.displayTiers;
    if (d && typeof d === 'object') {
        return {
            goodMin: Number(d.goodMin) || 8,
            midMin: Number(d.midMin) || 5,
        };
    }
    return { goodMin: 8, midMin: 5 };
}

/** Only the first N entries in Cursor leaderboard data are used for name matching (resource score + adoption rating). Match jira-md-export/connectors/cursor.js CURSOR_LEADERBOARD_TOP_N. */
const CURSOR_LEADERBOARD_MATCH_LIMIT = 25;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

let allProjectData = {}, selectedProjects = new Set(), selectedManagers = new Set(['All']);
let masterProjectData = {};
let activeParent = null, pieCharts = {};
let pieZoomChart = null;
let copilotLanguageChart = null;
/** Normalized copilot rows from copilotdata.json (each has day, copilot_chat, copilot_ide_code_completions) */
let copilotNormalizedRows = null;
/** Raw copilot data loaded on page load or Sync Data (from output/copilotdata.json or folder). */
let copilotDataInMemory = null;
/** Raw Cursor usage data from cursordata.json (last 30d). */
let cursorDataInMemory = null;
/** Per-user Copilot leaderboard from copilotdata.json (user-level 28-day report). */
let copilotUserLeaderboard = null;
/** Lowercase display-name set from resource-directory.json — used to filter QA leaderboard to known org members.
 *  Contains both full names and short forms ("FirstName L") for fuzzy matching against MD short-display names. */
let knownOrgNamesLower = null;

function buildKnownOrgNames(users) {
    const set = new Set();
    for (const u of users) {
        const full = (u.displayName || '').trim();
        if (!full) continue;
        set.add(full.toLowerCase());
        const parts = full.replace(/\s*\(.*?\)\s*/g, ' ').trim().split(/\s+/);
        if (parts.length >= 2) {
            const first = parts[0];
            const lastInitial = parts[parts.length - 1][0];
            if (first && lastInitial) set.add((first + ' ' + lastInitial).toLowerCase());
        }
    }
    return set;
}
let cursorModelChart = null, cursorLanguageChart = null, cursorIntentChart = null, cursorCategoriesChart = null;
let workCategorizationChart = null;
let stageDwellChart = null;
let ratingTierChart = null;
/** Reserved for future QA/SDET title exclusions from roster (none without external file). */
let excludedDevPeople = [];
let projectHistory = {};
let showActiveSprints = false;
function avgAiAdoptionScore(individuals) {
    const vals = (Array.isArray(individuals) ? individuals : [])
        .map((i) => Number(i.ai))
        .filter((v) => Number.isFinite(v) && v > 0);
    if (!vals.length) return '';
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Number(avg.toFixed(2));
}

let currentRatingFilter = null;

// --- Cursor-based AI adoption scoring (similarity match for names/repos) ---
function normalizeForMatch(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
/** Levenshtein distance (capped at 3) for approximate first-name matching. */
function _editDist(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const curr = [i];
        for (let j = 1; j <= n; j++) {
            curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
        }
        prev = curr;
    }
    return prev[n];
}
function similarEnough(a, b, minLen) {
    const na = normalizeForMatch(a);
    const nb = normalizeForMatch(b);
    if (na.length < (minLen || 2) || nb.length < (minLen || 2)) return na === nb;
    if (na.includes(nb) || nb.includes(na)) return true;
    // "First L" format fallback: handles (c) contractor-suffix artifacts and transliteration variants.
    // When one side is "Firstname X" (single initial), try matching on first name alone.
    // Exact first-name match handles "(c)" artifacts (e.g. "Ramraj C" ? "Ramraj Illale").
    // Edit-distance =1 match handles spelling variants (e.g. "Khushboo" ? "Khusboo", "Sapana" ? "Sapna").
    const aParts = na.split(' ');
    const bParts = nb.split(' ');
    const aIsShortForm = aParts.length === 2 && aParts[1].length === 1;
    const bIsShortForm = bParts.length === 2 && bParts[1].length === 1;
    if ((aIsShortForm || aParts.length === 1) && bParts.length >= 2) {
        const aFirst = aParts[0], bFirst = bParts[0];
        if (aFirst.length >= 5 && bFirst.length >= 5 &&
            (aFirst === bFirst || _editDist(aFirst, bFirst) <= 1)) return true;
    }
    if ((bIsShortForm || bParts.length === 1) && aParts.length >= 2) {
        const aFirst = aParts[0], bFirst = bParts[0];
        if (aFirst.length >= 5 && bFirst.length >= 5 &&
            (aFirst === bFirst || _editDist(aFirst, bFirst) <= 1)) return true;
    }
    return false;
}
/** True if personName matches any IDC roster entry (fuzzy). */
function memberMatchesIdcRoster(personName, idcNames) {
    if (!idcNames || !idcNames.length) return false;
    return idcNames.some((idc) => similarEnough(personName, idc));
}
function setExcludedDevPeople(names) {
    const unique = new Map();
    (Array.isArray(names) ? names : []).forEach((name) => {
        const n = String(name || '').trim();
        if (!n) return;
        const key = normalizeForMatch(n);
        if (!key) return;
        if (!unique.has(key)) unique.set(key, n);
    });
    excludedDevPeople = Array.from(unique.values());
}

function isExcludedFromDevData(personName) {
    const p = String(personName || '').trim();
    if (!p || !excludedDevPeople.length) return false;
    return memberMatchesIdcRoster(p, excludedDevPeople);
}
async function loadIdcEmployeeNames() {
    setExcludedDevPeople([]);
}
function wordTokens(s) {
    return String(s || '').toLowerCase().split(/[\s\-_.]+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(w => w.length >= 2);
}
function projectRepoSimilar(projectName, repoOrProjectStr) {
    if (similarEnough(projectName, repoOrProjectStr)) return true;
    const a = wordTokens(projectName);
    const b = wordTokens(repoOrProjectStr);
    if (a.length === 0 || b.length === 0) return false;
    const overlap = a.filter(t => b.some(u => t.includes(u) || u.includes(t) || similarEnough(t, u))).length;
    return overlap >= Math.min(2, a.length, b.length) || (a.length === 1 && b.some(u => u.includes(a[0]) || a[0].includes(u)));
}
function projectMatchesCursorRepo(projectName, cursorData) {
    if (!cursorData || !projectName) return { match: false };
    const repos = cursorData.aiEditsByRepository || [];
    if (!Array.isArray(repos) || repos.length === 0) return { match: false };
    for (const r of repos) {
        const proj = (r.projectName || r.repository || '').trim();
        const fullRepo = (r.repository || '').trim();
        if (projectRepoSimilar(projectName, proj) || projectRepoSimilar(projectName, fullRepo)) {
            return { match: true, codeCommittedByAiPct: r.codeCommittedByAiPct ?? 0 };
        }
    }
    return { match: false };
}
/**
 * Leaderboard rows used for name matching and main-page table, in rank / activity order.
 * Prefers daily-usage aggregate (top10Users); otherwise sorts API rows by rank ascending.
 */
function getCursorLeaderboardRowsForMatch(cursorData) {
    const limit = CURSOR_LEADERBOARD_MATCH_LIMIT;
    const filterExcludedRows = (rows) => rows.filter((u) => {
        const display = u.name || u.display_name || u.displayName || u.email || u.user || '';
        return !isExcludedFromDevData(display);
    });
    const fromAgg = cursorData && cursorData.top10Users;
    if (Array.isArray(fromAgg) && fromAgg.length > 0) {
        return filterExcludedRows(fromAgg.slice(0, limit));
    }
    const lb = cursorData && cursorData.leaderboard;
    if (!lb) return [];
    if (Array.isArray(lb)) {
        const sorted = [...lb].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
        return filterExcludedRows(sorted.slice(0, limit).map((u) => ({
            ...u,
            name: u.name || u.display_name || u.displayName,
        })));
    }
    if (typeof lb === 'object' && Array.isArray(lb.data) && !lb.tab_leaderboard) {
        const sorted = [...lb.data].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
        return filterExcludedRows(sorted.slice(0, limit).map((u) => ({
            ...u,
            name: u.name || u.display_name || u.displayName,
        })));
    }
    const tabData = lb.tab_leaderboard && Array.isArray(lb.tab_leaderboard.data) ? lb.tab_leaderboard.data : [];
    const agentData = lb.agent_leaderboard && Array.isArray(lb.agent_leaderboard.data) ? lb.agent_leaderboard.data : [];
    const pick = tabData.length ? tabData : agentData;
    if (pick.length === 0) return [];
    const sorted = [...pick].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
    return filterExcludedRows(sorted.slice(0, limit).map((u) => ({
        ...u,
        email: u.email,
        user: u.user || u.email,
        name: u.name || u.display_name || u.displayName || '',
    })));
}

/** Map API leaderboard row shape to daily-usage row shape for the main Cursor table. */
function normalizeCursorLeaderboardRowForTable(u) {
    if (u == null) return u;
    if (u.lines_added != null || u.linesAdded != null) return u;
    if (u.total_lines_accepted != null || u.total_lines_suggested != null || u.display_name != null) {
        return {
            ...u,
            email: u.email,
            user: u.user || u.email,
            name: u.name || u.display_name,
            lines_added: u.total_lines_accepted ?? u.total_lines_suggested ?? 0,
            lines_deleted: u.total_lines_deleted ?? 0,
            acceptance_rate: u.line_acceptance_ratio ?? u.accept_ratio,
            composer_requests: u.composer_requests ?? 0,
            chat_requests: u.chat_requests ?? 0,
            agent_requests: u.agent_requests ?? u.total_accepts ?? 0,
            cmdk_usages: u.cmdk_usages ?? 0,
        };
    }
    return u;
}

/** Min length for first/last token when matching email local-part (avoids "Khushboo M" ? last "m" matching every *m* in emails). */
const CURSOR_NAME_LOCAL_MIN_FIRST = 2;
const CURSOR_NAME_LOCAL_MIN_LAST = 2;

function memberMatchesCursorLeaderboard(memberName, cursorData) {
    if (!cursorData || !memberName) return false;
    const list = getCursorLeaderboardRowsForMatch(cursorData);
    const nameNorm = normalizeForMatch(memberName);
    const parts = nameNorm.split(/\s+/).filter(Boolean);
    const firstFromName = parts[0] || '';
    const lastFromName = parts.length > 1 ? parts[parts.length - 1] : '';
    for (const u of list) {
        const email = (u.email || u.user || '').toLowerCase();
        const displayName = (u.name || u.display_name || u.displayName || '').toLowerCase();
        if (similarEnough(memberName, email) || similarEnough(memberName, displayName)) return true;
        const localPart = (email.split('@')[0] || '').replace(/\./g, '');
        const nameNormNoSpace = nameNorm.replace(/\s/g, '');
        if (localPart && (nameNormNoSpace.includes(localPart) || localPart.includes(nameNormNoSpace))) return true;
        if (localPart && firstFromName.length >= CURSOR_NAME_LOCAL_MIN_FIRST && (localPart.includes(firstFromName) || firstFromName.includes(localPart))) return true;
        if (lastFromName.length >= CURSOR_NAME_LOCAL_MIN_LAST && localPart && localPart.includes(lastFromName)) return true;
    }
    return false;
}
/** Check if a member appears on the Copilot user leaderboard (top 25). */
function memberMatchesCopilotLeaderboard(memberName, copilotUsers) {
    if (!copilotUsers || !Array.isArray(copilotUsers) || !copilotUsers.length || !memberName) return false;
    const nameNorm = normalizeForMatch(memberName);
    const parts = nameNorm.split(/\s+/).filter(Boolean);
    const firstFromName = parts[0] || '';
    const lastFromName = parts.length > 1 ? parts[parts.length - 1] : '';
    for (const u of copilotUsers) {
        const login = (u.user_login || '').toLowerCase();
        const loginSpaced = login.replace(/[._-]/g, ' ');
        if (similarEnough(memberName, login) || similarEnough(memberName, loginSpaced)) return true;
        const localPart = login.replace(/[._-]/g, '');
        const nameNoSpace = nameNorm.replace(/\s/g, '');
        if (localPart && (nameNoSpace.includes(localPart) || localPart.includes(nameNoSpace))) return true;
        if (localPart && firstFromName.length >= 2 && (localPart.includes(firstFromName) || firstFromName.includes(localPart))) return true;
        if (lastFromName.length >= 2 && localPart && localPart.includes(lastFromName)) return true;
    }
    return false;
}

/** Per-person AI adoption rating 1–4 for Dev Data chart: SP-based base + Cursor leaderboard + Copilot leaderboard + project repo match. */
function computeAiAdoptionRatingForPerson(memberName, sp, individuals, projectName, cursorData) {
    if (!cursorData && !copilotUserLeaderboard) return null;
    const list = individuals || [];
    const spValues = list.map(i => Number(i?.pts) || 0).filter(() => true);
    const minSp = spValues.length ? Math.min(...spValues) : 0;
    const maxSp = spValues.length ? Math.max(...spValues) : 0;
    const spRange = maxSp - minSp;
    let rating = spRange === 0 ? 2 : 1 + Math.round(((Number(sp) || 0) - minSp) / spRange * 3);
    rating = Math.max(1, Math.min(4, rating));
    if (memberMatchesCursorLeaderboard(memberName, cursorData)) rating = Math.max(rating, 2);
    if (memberMatchesCopilotLeaderboard(memberName, copilotUserLeaderboard)) rating = Math.max(rating, 2);
    const repoMatch = projectMatchesCursorRepo(projectName, cursorData);
    if (repoMatch.match) {
        const pct = repoMatch.codeCommittedByAiPct || 0;
        if (pct >= 60) rating = Math.min(4, rating + 1);
        else if (pct >= 40) rating = Math.max(rating, 3);
        else if (pct >= 20) rating = Math.max(rating, 2);
    }
    if (memberMatchesCursorLeaderboard(memberName, cursorData) && memberMatchesCopilotLeaderboard(memberName, copilotUserLeaderboard)) {
        rating = Math.max(rating, 3);
    }
    return Math.max(1, Math.min(4, rating));
}

/** Project-level AI adoption score 0–100 from Cursor + Copilot: repo match + team on either leaderboard. No data ? 50 (neutral). */
function computeProjectAiAdoptionScore(projectName, individuals, cursorData) {
    if (!cursorData && !copilotUserLeaderboard) return 50;
    let score = 50;
    const repoMatch = cursorData ? projectMatchesCursorRepo(projectName, cursorData) : { match: false };
    if (repoMatch.match) {
        const pct = repoMatch.codeCommittedByAiPct || 0;
        if (pct >= 60) score = 62;
        else if (pct >= 40) score = 56;
        else if (pct >= 20) score = 52;
        else score = 48;
    }
    const names = (individuals || []).map(i => i && i.name).filter(Boolean);
    let onCursorLb = 0;
    let onCopilotLb = 0;
    names.forEach(name => {
        if (memberMatchesCursorLeaderboard(name, cursorData)) onCursorLb++;
        if (memberMatchesCopilotLeaderboard(name, copilotUserLeaderboard)) onCopilotLb++;
    });
    const onEitherLb = new Set();
    names.forEach(name => {
        if (memberMatchesCursorLeaderboard(name, cursorData) || memberMatchesCopilotLeaderboard(name, copilotUserLeaderboard)) {
            onEitherLb.add(name);
        }
    });
    if (names.length > 0 && onEitherLb.size > 0) {
        const boost = Math.min(20, onEitherLb.size * 5);
        score = Math.min(100, score + boost);
    }
    return Math.max(0, Math.min(100, score));
}

/**
 * Industry-aligned sprint health: weighted composite of delivery, flow, stability, quality, risk, and AI adoption.
 * Each dimension scored 0–100; composite mapped to 1–5 bands (Stellar / Surge / Cruise / Friction / Breach).
 * @param {object} data - Project metrics (completion, cycleTime, carryOver, bugsOpened, bugsClosed, blockers, individuals).
 * @param {string} [projectName] - Project name for Cursor repo/leaderboard matching; if omitted, AI adoption uses neutral 50.
 */
function computeSubScores(data, projectName) {
    const comp = parseFloat(data.completion) || 0;
    const cycleRaw = parseFloat(data.cycleTime);
    const cycleVal = Number.isFinite(cycleRaw) ? cycleRaw : (SCORE.DEFAULT_CYCLE || 3);
    const carryOver = parseFloat(data.carryOver);
    const carryVal = Number.isFinite(carryOver) ? Math.min(100, Math.max(0, carryOver)) : 0;
    const bugsOpened = parseInt(data.bugsOpened, 10) || 0;
    const bugsClosed = parseInt(data.bugsClosed, 10) || 0;
    const bugFixRate = bugsOpened > 0 ? Math.round((bugsClosed / bugsOpened) * 100) : 100;
    const blockers = parseInt(data.blockers, 10) || 0;

    const deliveryScore = Math.min(100, Math.max(0, comp));
    const cyclePoor = BENCH.CYCLE_POOR_DAYS || 52;
    const cycleElite = BENCH.CYCLE_ELITE_DAYS || 12;
    const flowScore = cycleVal <= cycleElite ? 100 : cycleVal >= cyclePoor ? 0 : Math.round(100 - (100 * (cycleVal - cycleElite)) / (cyclePoor - cycleElite));
    const carryGood = BENCH.CARRYOVER_GOOD_MAX || 10;
    const carryPoor = BENCH.CARRYOVER_POOR_MIN || 30;
    const stabilityScore = carryVal <= carryGood ? 100 : carryVal >= carryPoor ? 0 : Math.round(100 - (100 * (carryVal - carryGood)) / (carryPoor - carryGood));
    const qualityScore = Math.min(100, Math.max(0, bugFixRate));
    const riskScore = blockers === 0 ? 100 : blockers === 1 ? 60 : 0;

    const hasAiSource = (WEIGHTS.AI_ADOPTION_WEIGHT || 0) > 0 && projectName && (cursorDataInMemory || copilotUserLeaderboard);
    const aiAdoptionScore = hasAiSource
        ? computeProjectAiAdoptionScore(projectName, data.individuals, cursorDataInMemory)
        : 50;

    const hasDelivery = comp > 0;
    const hasFlow = Number.isFinite(cycleRaw) && cycleRaw > 0;
    const hasStability = hasDelivery;
    const hasQuality = bugsOpened > 0 || bugsClosed > 0;
    const hasRisk = hasDelivery;
    const hasAI = !!hasAiSource;

    return {
        delivery:  { score: deliveryScore,    has: hasDelivery,  weight: WEIGHTS.DELIVERY_WEIGHT },
        flow:      { score: flowScore,        has: hasFlow,      weight: WEIGHTS.FLOW_WEIGHT },
        stability: { score: stabilityScore,   has: hasStability,  weight: WEIGHTS.STABILITY_WEIGHT },
        quality:   { score: qualityScore,     has: hasQuality,   weight: WEIGHTS.QUALITY_WEIGHT },
        risk:      { score: riskScore,        has: hasRisk,      weight: WEIGHTS.RISK_WEIGHT },
        aiAdoption:{ score: aiAdoptionScore,  has: hasAI,        weight: WEIGHTS.AI_ADOPTION_WEIGHT || 0 },
    };
}

function calculateProjectScore(data, projectName) {
    var subs = computeSubScores(data, projectName);
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
    var compositeRound = Math.round(composite);

    if (compositeRound >= (BENCH.COMPOSITE_ELITE || 85)) return 5;
    if (compositeRound >= (BENCH.COMPOSITE_STRONG || 70)) return 4;
    if (compositeRound >= (BENCH.COMPOSITE_STABLE || 55)) return 3;
    if (compositeRound >= (BENCH.COMPOSITE_AT_RISK || 40)) return 2;
    return 1;
}

function compositeToRating(score) {
    if (score >= (BENCH.COMPOSITE_ELITE || 85)) return 5;
    if (score >= (BENCH.COMPOSITE_STRONG || 70)) return 4;
    if (score >= (BENCH.COMPOSITE_STABLE || 55)) return 3;
    if (score >= (BENCH.COMPOSITE_AT_RISK || 40)) return 2;
    return 1;
}

const PILLAR_RATING_LABELS = { 5: 'Stellar', 4: 'Surge', 3: 'Cruise', 2: 'Friction', 1: 'Breach' };

function getProjectPillarScores(data, projectName) {
    var subs = computeSubScores(data, projectName);
    var overall = calculateProjectScore(data, projectName);
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
        delivery:   subs.delivery.has   ? compositeToRating(subs.delivery.score)   : null,
        flow:       subs.flow.has       ? compositeToRating(subs.flow.score)       : null,
        stability:  subs.stability.has  ? compositeToRating(subs.stability.score)  : null,
        quality:    subs.quality.has    ? compositeToRating(subs.quality.score)    : null,
        risk:       subs.risk.has       ? compositeToRating(subs.risk.score)       : null,
        aiAdoption: subs.aiAdoption.has ? compositeToRating(subs.aiAdoption.score) : null,
        overall:    overall,
        scores:       scores,
        overallScore: overallScore,
    };
}

function healthDotHtml(rating, label) {
    if (rating === null || rating === undefined) {
        return '<span class="health-dot health-dot-null" title="' + label + ': No Data"></span>';
    }
    const tag = PILLAR_RATING_LABELS[rating] || '';
    return '<span class="health-dot health-dot-' + rating + '" title="' + label + ': ' + rating + '/5 – ' + tag + '"></span>';
}

function renderTeamHealthMatrix() {
    var section = document.getElementById('teamHealthMatrixSection');
    var mount = document.getElementById('teamHealthMatrixMount');
    if (!section || !mount) return;

    var keys = selectedProjects.size ? Array.from(selectedProjects) : Object.keys(allProjectData).filter(function (p) {
        var d = allProjectData[p];
        return selectedManagers.has('All') || selectedManagers.has(d.manager);
    });

    if (!keys.length) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');

    var rows = keys.map(function (name) {
        var data = allProjectData[name];
        var pillars = getProjectPillarScores(data, name);
        return {
            name: name,
            subtitle: (data.parent && data.parent !== 'Independent') ? data.parent : '',
            boardType: data.boardType || 'Sprint',
            scores: pillars.scores,
            overall: pillars.overall,
            overallScore: pillars.overallScore,
            href: 'project-detail.html?project=' + encodeURIComponent(name),
        };
    });

    rows.sort(function (a, b) {
        var ao = Number(a.overallScore); if (!Number.isFinite(ao)) ao = -1;
        var bo = Number(b.overallScore); if (!Number.isFinite(bo)) bo = -1;
        if (bo !== ao) return bo - ao;
        return a.name.localeCompare(b.name);
    });

    if (typeof window !== 'undefined' && window.HealthMatrixChart && typeof window.HealthMatrixChart.render === 'function') {
        window.HealthMatrixChart.render(mount, rows, { emptyMessage: 'No teams match the current filters.' });
    } else {
        mount.innerHTML = '<div class="hmx-empty">Health chart module is unavailable.</div>';
    }

    renderHealthScoreTrend(keys);
}

/**
 * Health Score Trend — sprint over sprint.
 * Pulls the last 3 closed sprints per project from `projectHistory`,
 * computes the same weighted composite that powers the matrix, and hands
 * it to the HealthTrendChart renderer. Right-aligns the bars so the
 * "Current Sprint" slot always reflects the most recent data.
 */
function renderHealthScoreTrend(keys) {
    const section = document.getElementById('healthScoreTrendSection');
    const canvas  = document.getElementById('healthScoreTrendChart');
    const empty   = document.getElementById('healthScoreTrendEmpty');
    if (!section || !canvas) return;

    if (!Array.isArray(keys) || !keys.length) {
        if (window.HealthTrendChart) window.HealthTrendChart.destroy();
        section.classList.add('hidden');
        return;
    }

    function compositeForSprint(sprintData, projectName) {
        if (!sprintData) return null;
        const subs = computeSubScores(sprintData, projectName);
        const dimKeys = ['delivery', 'flow', 'stability', 'quality', 'risk', 'aiAdoption'];
        let composite = 0, totalW = 0;
        for (let i = 0; i < dimKeys.length; i++) {
            const d = subs[dimKeys[i]];
            if (d.has) { composite += (d.weight || 0) * d.score; totalW += (d.weight || 0); }
        }
        return totalW > 0 ? Math.round(composite / totalW) : null;
    }

    const rows = keys.map(name => {
        // Include both closed AND active sprints so a 1-closed + 1-active
        // history (the common case mid-PI) still renders a meaningful trend.
        // The active sprint naturally lands in the rightmost "Current Sprint"
        // slot since it has the latest reviewDate.
        const sorted = (projectHistory[name] || [])
            .slice()
            .sort((a, b) => ((a.reviewDate || '') > (b.reviewDate || '') ? 1 : -1));

        // Take the last (up to) 3 sprints, oldest first.
        const tail = sorted.slice(-3);
        const sprints = tail.map(s => {
            const isActive = (s.status || '').toLowerCase() === 'active';
            const baseLabel = s.period || s.reviewDate || '';
            return {
                label: isActive && baseLabel && !/active/i.test(baseLabel)
                    ? baseLabel + ' (Active)'
                    : baseLabel,
                score: compositeForSprint(s, name),
            };
        });
        return { name, sprints };
    });

    // Need at least one team with 2+ usable scores to make a meaningful trend.
    const hasTrend = rows.some(r => r.sprints.filter(s => Number.isFinite(Number(s.score))).length >= 2);
    if (!hasTrend) {
        if (window.HealthTrendChart) window.HealthTrendChart.destroy();
        section.classList.remove('hidden');
        if (empty) empty.classList.remove('hidden');
        canvas.style.display = 'none';
        return;
    }

    if (empty) empty.classList.add('hidden');
    canvas.style.display = '';
    section.classList.remove('hidden');

    const bands = {
        elite:  Number.isFinite(Number(BENCH.COMPOSITE_ELITE))   ? Number(BENCH.COMPOSITE_ELITE)   : 85,
        strong: Number.isFinite(Number(BENCH.COMPOSITE_STRONG))  ? Number(BENCH.COMPOSITE_STRONG)  : 70,
        stable: Number.isFinite(Number(BENCH.COMPOSITE_STABLE))  ? Number(BENCH.COMPOSITE_STABLE)  : 55,
        atRisk: Number.isFinite(Number(BENCH.COMPOSITE_AT_RISK)) ? Number(BENCH.COMPOSITE_AT_RISK) : 40,
    };

    if (window.HealthTrendChart && typeof window.HealthTrendChart.render === 'function') {
        window.HealthTrendChart.render(canvas, rows, {
            bands,
            isLight: isDashboardLightTheme(),
            onEmpty: () => {
                section.classList.add('hidden');
            },
        });
    }
}

/**
 * Team Health Matrix: legend + expandable scoring guide use the same WEIGHTS / BENCH
 * as pillar dots (updated from /api/dashboard-scoring via mergeHealth).
 */
function refreshHealthMatrixHeaderLegend() {
    var e = Number(BENCH.COMPOSITE_ELITE);
    var s = Number(BENCH.COMPOSITE_STRONG);
    var st = Number(BENCH.COMPOSITE_STABLE);
    var ar = Number(BENCH.COMPOSITE_AT_RISK);
    if (!Number.isFinite(e)) e = 85;
    if (!Number.isFinite(s)) s = 70;
    if (!Number.isFinite(st)) st = 55;
    if (!Number.isFinite(ar)) ar = 40;
    var el = document.getElementById('healthMatrixLegendElite');
    var el2 = document.getElementById('healthMatrixLegendStrong');
    var el3 = document.getElementById('healthMatrixLegendStable');
    var el4 = document.getElementById('healthMatrixLegendRisk');
    var el5 = document.getElementById('healthMatrixLegendBreach');
    if (el) el.textContent = '\u2265' + e;
    if (el2) el2.textContent = s + '\u2013' + (e - 1);
    if (el3) el3.textContent = st + '\u2013' + (s - 1);
    if (el4) el4.textContent = ar + '\u2013' + (st - 1);
    if (el5) el5.textContent = '<' + ar;
}

function scoringGuideWeightPct(key) {
    var map = {
        delivery: 'DELIVERY_WEIGHT',
        flow: 'FLOW_WEIGHT',
        stability: 'STABILITY_WEIGHT',
        quality: 'QUALITY_WEIGHT',
        risk: 'RISK_WEIGHT',
        aiAdoption: 'AI_ADOPTION_WEIGHT',
    };
    var v = Number(WEIGHTS[map[key]]);
    if (!Number.isFinite(v)) return '0%';
    return Math.round(v * 100) + '%';
}

/** 0–100 score tier columns for metrics that use compositeToRating on raw 0–100 (delivery, quality). */
function scoringGuidePercentMetricTiers() {
    var e = Number(BENCH.COMPOSITE_ELITE);
    var s = Number(BENCH.COMPOSITE_STRONG);
    var st = Number(BENCH.COMPOSITE_STABLE);
    var ar = Number(BENCH.COMPOSITE_AT_RISK);
    if (!Number.isFinite(e)) e = 85;
    if (!Number.isFinite(s)) s = 70;
    if (!Number.isFinite(st)) st = 55;
    if (!Number.isFinite(ar)) ar = 40;
    return [
        '\u2265' + e + '%',
        s + '\u2013' + (e - 1) + '%',
        st + '\u2013' + (s - 1) + '%',
        ar + '\u2013' + (st - 1) + '%',
        '<' + ar + '%',
    ];
}

function scoringGuideFlowDayTiers() {
    var ce = Number(BENCH.CYCLE_ELITE_DAYS);
    var cp = Number(BENCH.CYCLE_POOR_DAYS);
    var e = Number(BENCH.COMPOSITE_ELITE);
    var s = Number(BENCH.COMPOSITE_STRONG);
    var st = Number(BENCH.COMPOSITE_STABLE);
    var ar = Number(BENCH.COMPOSITE_AT_RISK);
    if (!Number.isFinite(ce)) ce = 12;
    if (!Number.isFinite(cp)) cp = 52;
    if (!Number.isFinite(e)) e = 85;
    if (!Number.isFinite(s)) s = 70;
    if (!Number.isFinite(st)) st = 55;
    if (!Number.isFinite(ar)) ar = 40;
    var span = Math.max(1, cp - ce);
    function dForScore(T) {
        return ce + ((100 - T) / 100) * span;
    }
    var d5 = Math.round(dForScore(e));
    var d4 = Math.round(dForScore(s));
    var d3 = Math.round(dForScore(st));
    var d2 = Math.round(dForScore(ar));
    return [
        '\u2264' + d5 + 'd',
        (d5 + 1) + '\u2013' + d4 + 'd',
        (d4 + 1) + '\u2013' + d3 + 'd',
        (d3 + 1) + '\u2013' + d2 + 'd',
        '>' + d2 + 'd',
    ];
}

function scoringGuideCarryTiers() {
    var cg = Number(BENCH.CARRYOVER_GOOD_MAX);
    var cpm = Number(BENCH.CARRYOVER_POOR_MIN);
    var e = Number(BENCH.COMPOSITE_ELITE);
    var s = Number(BENCH.COMPOSITE_STRONG);
    var st = Number(BENCH.COMPOSITE_STABLE);
    var ar = Number(BENCH.COMPOSITE_AT_RISK);
    if (!Number.isFinite(cg)) cg = 10;
    if (!Number.isFinite(cpm)) cpm = 30;
    if (!Number.isFinite(e)) e = 85;
    if (!Number.isFinite(s)) s = 70;
    if (!Number.isFinite(st)) st = 55;
    if (!Number.isFinite(ar)) ar = 40;
    var span = Math.max(1, cpm - cg);
    function cForScore(T) {
        return cg + ((100 - T) / 100) * span;
    }
    var c5 = Math.round(cForScore(e));
    var c4 = Math.round(cForScore(s));
    var c3 = Math.round(cForScore(st));
    var c2 = Math.round(cForScore(ar));
    return [
        '\u2264' + c5 + '%',
        (c5 + 1) + '\u2013' + c4 + '%',
        (c4 + 1) + '\u2013' + c3 + '%',
        (c3 + 1) + '\u2013' + c2 + '%',
        '>' + c2 + '%',
    ];
}

function scoringGuideOverallTiers() {
    var e = Number(BENCH.COMPOSITE_ELITE);
    var s = Number(BENCH.COMPOSITE_STRONG);
    var st = Number(BENCH.COMPOSITE_STABLE);
    var ar = Number(BENCH.COMPOSITE_AT_RISK);
    if (!Number.isFinite(e)) e = 85;
    if (!Number.isFinite(s)) s = 70;
    if (!Number.isFinite(st)) st = 55;
    if (!Number.isFinite(ar)) ar = 40;
    return [
        '\u2265' + e,
        s + '\u2013' + (e - 1),
        st + '\u2013' + (s - 1),
        ar + '\u2013' + (st - 1),
        '<' + ar,
    ];
}

function refreshHealthScoringGuideTable() {
    var tb = document.getElementById('healthScoringGuideTbody');
    if (!tb) return;
    var delQ = scoringGuidePercentMetricTiers();
    var flow = scoringGuideFlowDayTiers();
    var carry = scoringGuideCarryTiers();
    var overall = scoringGuideOverallTiers();
    var rows = [];
    function row(pillar, metric, w, c0, c1, c2, c3, c4) {
        rows.push(
            '<tr><td class="px-3 py-2 font-bold text-slate-300">' + pillar + '</td><td class="px-3 py-2">' + metric + '</td><td class="px-3 py-2">' + w + '</td>'
            + '<td class="px-3 py-2 text-center text-emerald-400 font-semibold">' + c0 + '</td>'
            + '<td class="px-3 py-2 text-center text-blue-400 font-semibold">' + c1 + '</td>'
            + '<td class="px-3 py-2 text-center text-amber-400 font-semibold">' + c2 + '</td>'
            + '<td class="px-3 py-2 text-center text-orange-400 font-semibold">' + c3 + '</td>'
            + '<td class="px-3 py-2 text-center text-red-400 font-semibold">' + c4 + '</td></tr>',
        );
    }
    row('Delivery', 'Sprint Completion %', scoringGuideWeightPct('delivery'), delQ[0], delQ[1], delQ[2], delQ[3], delQ[4]);
    row('Flow', 'Avg Review Cycle Time', scoringGuideWeightPct('flow'), flow[0], flow[1], flow[2], flow[3], flow[4]);
    row('Stability', 'Carry-Over Rate %', scoringGuideWeightPct('stability'), carry[0], carry[1], carry[2], carry[3], carry[4]);
    row('Quality', 'Bug Fix Rate %', scoringGuideWeightPct('quality'), delQ[0], delQ[1], delQ[2], delQ[3], delQ[4]);
    rows.push(
        '<tr><td class="px-3 py-2 font-bold text-slate-300">Risk</td><td class="px-3 py-2">Active Blockers</td><td class="px-3 py-2">' + scoringGuideWeightPct('risk') + '</td>'
        + '<td class="px-3 py-2 text-center text-emerald-400 font-semibold">0</td>'
        + '<td class="px-3 py-2 text-center text-slate-600 font-semibold">\u2014</td>'
        + '<td class="px-3 py-2 text-center text-amber-400 font-semibold">1</td>'
        + '<td class="px-3 py-2 text-center text-slate-600 font-semibold">\u2014</td>'
        + '<td class="px-3 py-2 text-center text-red-400 font-semibold">2+</td></tr>',
    );
    rows.push(
        '<tr><td class="px-3 py-2 font-bold text-slate-300">AI Adoption</td><td class="px-3 py-2">Cursor / Copilot Signal</td><td class="px-3 py-2">' + scoringGuideWeightPct('aiAdoption') + '</td>'
        + '<td colspan="5" class="px-3 py-2 text-center text-slate-500 italic">Composite of tool usage &amp; adoption signals (0\u2013100 score uses same star bands)</td></tr>',
    );
    rows.push(
        '<tr style="background: rgba(255,255,255,0.02);"><td class="px-3 py-2 font-bold text-slate-300">Overall</td><td class="px-3 py-2">Weighted Composite</td><td class="px-3 py-2">100%</td>'
        + '<td class="px-3 py-2 text-center text-emerald-400 font-semibold">' + overall[0] + '</td>'
        + '<td class="px-3 py-2 text-center text-blue-400 font-semibold">' + overall[1] + '</td>'
        + '<td class="px-3 py-2 text-center text-amber-400 font-semibold">' + overall[2] + '</td>'
        + '<td class="px-3 py-2 text-center text-orange-400 font-semibold">' + overall[3] + '</td>'
        + '<td class="px-3 py-2 text-center text-red-400 font-semibold">' + overall[4] + '</td></tr>',
    );
    tb.innerHTML = rows.join('');
}

function refreshHealthScoringUIFromServer() {
    refreshHealthMatrixHeaderLegend();
    refreshHealthScoringGuideTable();
}

/* -- Pillar Info Popover (hover overlay on matrix column headers) -- */
(function () {
    var PILLAR_INFO = {
        delivery: {
            title: 'Delivery',
            metric: 'Sprint Completion %',
            weight: '45%',
            rows: [
                { rating: 5, label: 'Stellar',    range: '\u2265 85%' },
                { rating: 4, label: 'Surge',   range: '70 \u2013 84%' },
                { rating: 3, label: 'Cruise',   range: '55 \u2013 69%' },
                { rating: 2, label: 'Friction',  range: '40 \u2013 54%' },
                { rating: 1, label: 'Breach', range: '< 40%' }
            ],
            note: 'Percentage of committed stories/points completed in the sprint.'
        },
        flow: {
            title: 'Flow',
            metric: 'Avg Review Cycle Time (days)',
            weight: '10%',
            rows: [
                { rating: 5, label: 'Stellar',    range: '\u2264 12 days' },
                { rating: 4, label: 'Surge',   range: '13 \u2013 21 days' },
                { rating: 3, label: 'Cruise',   range: '22 \u2013 36 days' },
                { rating: 2, label: 'Friction',  range: '37 \u2013 52 days' },
                { rating: 1, label: 'Breach', range: '> 52 days' }
            ],
            note: 'Days from Ready for Dev \u2192 Ready for Staging. Stellar \u2264 12d scores 100; \u2265 52d scores 0. (Data-driven: P25/P75 across 732 tickets, Apr 2026)'
        },
        stability: {
            title: 'Stability',
            metric: 'Carry-Over Rate %',
            weight: '10%',
            rows: [
                { rating: 5, label: 'Stellar',    range: '\u2264 13%' },
                { rating: 4, label: 'Surge',   range: '14 \u2013 16%' },
                { rating: 3, label: 'Cruise',   range: '17 \u2013 19%' },
                { rating: 2, label: 'Friction',  range: '20 \u2013 22%' },
                { rating: 1, label: 'Breach', range: '> 22%' }
            ],
            note: 'Stories spilling into the next sprint. \u2264 10% scores 100; \u2265 30% scores 0.'
        },
        quality: {
            title: 'Quality',
            metric: 'Bug Fix Rate %',
            weight: '20%',
            rows: [
                { rating: 5, label: 'Stellar',    range: '\u2265 85%' },
                { rating: 4, label: 'Surge',   range: '70 \u2013 84%' },
                { rating: 3, label: 'Cruise',   range: '55 \u2013 69%' },
                { rating: 2, label: 'Friction',  range: '40 \u2013 54%' },
                { rating: 1, label: 'Breach', range: '< 40%' }
            ],
            note: 'Bugs closed \u00F7 bugs opened. Higher = healthier.'
        },
        risk: {
            title: 'Risk',
            metric: 'Active Blockers',
            weight: '5%',
            rows: [
                { rating: 5, label: 'Stellar',    range: '0 blockers' },
                { rating: 3, label: 'Cruise',   range: '1 blocker' },
                { rating: 1, label: 'Breach', range: '2+ blockers' }
            ],
            note: 'Number of unresolved blocking issues. Only three tiers: 0, 1, or 2+.'
        },
        aiAdoption: {
            title: 'AI Adoption',
            metric: 'Cursor / Copilot Signal',
            weight: '10%',
            rows: [
                { rating: 5, label: 'Stellar',    range: '\u2265 85' },
                { rating: 4, label: 'Surge',   range: '70 \u2013 84' },
                { rating: 3, label: 'Cruise',   range: '55 \u2013 69' },
                { rating: 2, label: 'Friction',  range: '40 \u2013 54' },
                { rating: 1, label: 'Breach', range: '< 40' }
            ],
            note: 'Composite of Cursor leaderboard, Copilot individual, and tool adoption signals.'
        },
        overall: {
            title: 'Overall Status',
            metric: 'Weighted Composite',
            weight: '100%',
            rows: [
                { rating: 5, label: 'Stellar',    range: '\u2265 85' },
                { rating: 4, label: 'Surge',   range: '70 \u2013 84' },
                { rating: 3, label: 'Cruise',   range: '55 \u2013 69' },
                { rating: 2, label: 'Friction',  range: '40 \u2013 54' },
                { rating: 1, label: 'Breach', range: '< 40' }
            ],
            note: 'Sum of all pillar scores multiplied by their weights.'
        }
    };

    var LABEL_CLS = { 5: 'pp-label-elite', 4: 'pp-label-strong', 3: 'pp-label-stable', 2: 'pp-label-risk', 1: 'pp-label-critical' };
    var RANGE_CLS = { 5: 'pp-range-elite', 4: 'pp-range-strong', 3: 'pp-range-stable', 2: 'pp-range-risk', 1: 'pp-range-critical' };

    function wPct(v) {
        var n = Number(v);
        if (!Number.isFinite(n)) return '0%';
        return Math.round(n * 100) + '%';
    }

    /** Merge static blurbs with live DashboardConstants (from dashboard-scoring API). */
    function resolvePillarInfo(key) {
        var base = PILLAR_INFO[key];
        if (!base) return null;
        var DC = window.DashboardConstants || {};
        var RW = DC.RATING_WEIGHTS || {};
        var BENCH = DC.RATING_BENCHMARKS || {};
        var out = {};
        for (var prop in base) {
            if (Object.prototype.hasOwnProperty.call(base, prop)) out[prop] = base[prop];
        }
        var wmap = {
            delivery: 'DELIVERY_WEIGHT',
            flow: 'FLOW_WEIGHT',
            stability: 'STABILITY_WEIGHT',
            quality: 'QUALITY_WEIGHT',
            risk: 'RISK_WEIGHT',
            aiAdoption: 'AI_ADOPTION_WEIGHT',
        };
        if (key === 'overall') {
            out.weight = '100%';
            var e = Number(BENCH.COMPOSITE_ELITE);
            var s = Number(BENCH.COMPOSITE_STRONG);
            var st = Number(BENCH.COMPOSITE_STABLE);
            var ar = Number(BENCH.COMPOSITE_AT_RISK);
            if (!Number.isFinite(e)) e = 85;
            if (!Number.isFinite(s)) s = 70;
            if (!Number.isFinite(st)) st = 55;
            if (!Number.isFinite(ar)) ar = 40;
            out.rows = [
                { rating: 5, label: 'Stellar', range: '\u2265 ' + e },
                { rating: 4, label: 'Surge', range: s + ' \u2013 ' + (e - 1) },
                { rating: 3, label: 'Cruise', range: st + ' \u2013 ' + (s - 1) },
                { rating: 2, label: 'Friction', range: ar + ' \u2013 ' + (st - 1) },
                { rating: 1, label: 'Breach', range: '< ' + ar },
            ];
            return out;
        }
        out.weight = wPct(RW[wmap[key]]);
        if (key === 'flow') {
            var ce = Number(BENCH.CYCLE_ELITE_DAYS);
            var cs = Number(BENCH.CYCLE_STRONG_DAYS);
            var cp = Number(BENCH.CYCLE_POOR_DAYS);
            if (!Number.isFinite(ce)) ce = 12;
            if (!Number.isFinite(cs)) cs = 21;
            if (!Number.isFinite(cp)) cp = 52;
            var mid = Math.min(cp - 1, Math.max(cs + 1, Math.round((cs + cp) / 2)));
            out.rows = [
                { rating: 5, label: 'Stellar', range: '\u2264 ' + ce + ' days' },
                { rating: 4, label: 'Surge', range: (ce + 1) + ' \u2013 ' + cs + ' days' },
                { rating: 3, label: 'Cruise', range: (cs + 1) + ' \u2013 ' + mid + ' days' },
                { rating: 2, label: 'Friction', range: (mid + 1) + ' \u2013 ' + cp + ' days' },
                { rating: 1, label: 'Breach', range: '> ' + cp + ' days' },
            ];
        }
        if (key === 'stability') {
            var cg = Number(BENCH.CARRYOVER_GOOD_MAX);
            var cpm = Number(BENCH.CARRYOVER_POOR_MIN);
            if (!Number.isFinite(cg)) cg = 10;
            if (!Number.isFinite(cpm)) cpm = 30;
            out.note = 'Stories spilling into the next sprint. \u2264 ' + cg + '% scores 100; \u2265 ' + cpm + '% scores 0.';
        }
        return out;
    }

    function buildPopoverHtml(info) {
        var h = '<div class="pillar-popover-header">'
            + '<div class="pp-title">' + info.title + '</div>'
            + '<div class="pp-subtitle">' + info.metric + ' &middot; Weight: ' + info.weight + '</div>'
            + '</div><div class="pillar-popover-body">';
        for (var i = 0; i < info.rows.length; i++) {
            var r = info.rows[i];
            h += '<div class="pillar-popover-row">'
                + '<span class="pp-dot health-dot health-dot-' + r.rating + '" style="width:10px;height:10px;"></span>'
                + '<span class="pp-label ' + LABEL_CLS[r.rating] + '">' + r.label + '</span>'
                + '<span class="pp-range ' + RANGE_CLS[r.rating] + '">' + r.range + '</span>'
                + '</div>';
        }
        if (info.note) {
            h += '<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);font-size:10px;color:#64748b;line-height:1.5;">' + info.note + '</div>';
        }
        h += '</div>';
        return h;
    }

    var popover = document.getElementById('pillarPopover');
    var content = document.getElementById('pillarPopoverContent');
    var arrow = popover ? popover.querySelector('.pillar-popover-arrow') : null;
    var hideTimer = null;
    var showTimer = null;

    function showPopover(th) {
        clearTimeout(hideTimer);
        clearTimeout(showTimer);
        var key = th.getAttribute('data-pillar');
        var info = resolvePillarInfo(key);
        if (!info || !popover) return;
        content.innerHTML = buildPopoverHtml(info);
        popover.classList.remove('hidden');

        showTimer = setTimeout(function () {
            var rect = th.getBoundingClientRect();
            var pw = 340;
            var left = rect.left + rect.width / 2 - pw / 2;
            left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
            var top = rect.bottom + 10;
            if (top + popover.offsetHeight > window.innerHeight - 8) {
                top = rect.top - popover.offsetHeight - 10;
                arrow.style.top = '';
                arrow.style.bottom = '-6px';
                arrow.style.transform = 'translateX(-50%) rotate(225deg)';
            } else {
                arrow.style.top = '-6px';
                arrow.style.bottom = '';
                arrow.style.transform = 'translateX(-50%) rotate(45deg)';
            }
            var arrowLeft = rect.left + rect.width / 2 - left;
            arrowLeft = Math.max(20, Math.min(arrowLeft, pw - 20));
            arrow.style.left = arrowLeft + 'px';
            popover.style.left = left + 'px';
            popover.style.top = top + 'px';
            popover.classList.add('visible');
        }, 12);
    }

    function hidePopover() {
        clearTimeout(showTimer);
        hideTimer = setTimeout(function () {
            if (!popover) return;
            popover.classList.remove('visible');
            setTimeout(function () { popover.classList.add('hidden'); }, 220);
        }, 180);
    }

    function keepPopover() {
        clearTimeout(hideTimer);
    }

    document.addEventListener('mouseover', function (e) {
        var th = e.target.closest('.pillar-th');
        if (th) { showPopover(th); return; }
        if (popover && popover.contains(e.target)) { keepPopover(); }
    });
    document.addEventListener('mouseout', function (e) {
        var th = e.target.closest('.pillar-th');
        if (th) { hidePopover(); return; }
        if (popover && popover.contains(e.target)) { hidePopover(); }
    });
    if (popover) {
        popover.addEventListener('mouseenter', keepPopover);
        popover.addEventListener('mouseleave', hidePopover);
    }
})();

function updateRatingSummary() {
    const container = document.getElementById('ratingSummaryBar');
    const canvas = document.getElementById('ratingTierChart');
    if (!container || !canvas) return;

    const counts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    Object.keys(masterProjectData).forEach(name => {
        const score = calculateProjectScore(masterProjectData[name], name);
        masterProjectData[name].rating = score;
        counts[score]++;
    });

    const labels = RATING_TIER_ORDER.map(r => RATING_LABELS[r].text);
    const data = RATING_TIER_ORDER.map(r => counts[r]);
    const maxCount = Math.max(...data, 0);

    if (ratingTierChart) {
        try { ratingTierChart.destroy(); } catch (e) { /* ignore */ }
        ratingTierChart = null;
    }
    if (typeof Chart === 'undefined') return;

    const pb = portfolioBarChartTheme();
    const tt = chartTooltipTheme();
    const fontMono = "'JetBrains Mono', ui-monospace, monospace";

    ratingTierChart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: RATING_TIER_ORDER.map((r, i) => RATING_TIER_BAR_COLORS[i]),
                borderColor: RATING_TIER_ORDER.map((r) => (currentRatingFilter === r ? ratingTierActiveBorder() : 'transparent')),
                borderWidth: RATING_TIER_ORDER.map((r) => (currentRatingFilter === r ? 2 : 0)),
                borderRadius: 8,
                borderSkipped: false,
                hoverBackgroundColor: RATING_TIER_HOVER,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 420 },
            onClick: (e, elements) => {
                if (!elements.length) return;
                const idx = elements[0].index;
                const rating = RATING_TIER_ORDER[idx];
                filterByRating(rating);
            },
            // Hand-pointer cue: each bar is a portfolio filter, so the cursor
            // flips to "pointer" the moment a bar is hovered.
            onHover: (e, elements) => {
                const tgt = e && e.native && e.native.target;
                if (tgt && tgt.style) {
                    tgt.style.cursor = elements && elements.length ? 'pointer' : 'default';
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...tt,
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 10,
                    callbacks: {
                        label: (ctx) => ` Teams: ${ctx.parsed.y}  ·  Click to filter`,
                    },
                },
            },
            scales: {
                x: {
                    ticks: {
                        color: pb.tickX,
                        font: { size: 10, weight: '600', family: fontMono },
                        maxRotation: 0,
                    },
                    grid: { display: false },
                    border: { display: true, color: pb.axisLine },
                },
                y: {
                    beginAtZero: true,
                    suggestedMax: maxCount <= 0 ? 1 : Math.max(maxCount + 1, Math.ceil(maxCount * 1.12)),
                    ticks: {
                        stepSize: 1,
                        precision: 0,
                        color: pb.tickY,
                        font: { size: 10, family: fontMono },
                    },
                    grid: { color: pb.grid, lineWidth: 1 },
                    border: { display: true, color: pb.axisLine },
                },
            },
        },
    });
    // Note: deliberately NOT enabling ChartZoom on the bucket bar — its bars
    // are portfolio filters (click ? filterByRating), so a magnifier icon
    // would muddle the affordance. The hand-pointer onHover handler above is
    // the discoverability cue here.
}

// Filter Logic: Switch working copy (allProjectData) based on Master
function filterByRating(r) {
    if (currentRatingFilter === r) {
        resetProjectFilter();
        return;
    }

    currentRatingFilter = r;
    document.getElementById('clearFilterContainer').classList.remove('hidden');

    const filtered = {};
    const uniqueManagers = new Set();
    Object.keys(masterProjectData).forEach(name => {
        const p = masterProjectData[name];
        if (p.rating === r) {
            filtered[name] = p;
            uniqueManagers.add(p.manager);
        }
    });
    allProjectData = filtered;
    selectedProjects.clear();
    activeParent = null;
    selectedManagers = new Set(['All']);
    populateManagerDropdown(Array.from(uniqueManagers).sort());

    refreshUI();
    updateRatingSummary();
}

function resetProjectFilter() {
    currentRatingFilter = null;
    allProjectData = JSON.parse(JSON.stringify(masterProjectData));
    document.getElementById('clearFilterContainer').classList.add('hidden');
    activeParent = null;
    const allManagers = new Set();
    Object.values(masterProjectData).forEach(p => allManagers.add(p.manager));
    populateManagerDropdown(Array.from(allManagers).sort());
    selectedManagers = new Set(['All']);
    refreshUI();
    updateRatingSummary();
}

function rebuildFromHistory() {
    allProjectData = {};
    const targetStatus = showActiveSprints ? 'active' : 'closed';
    Object.keys(projectHistory).forEach(product => {
        const sprints = projectHistory[product];
        const matching = sprints.filter(s => (s.status || '').toLowerCase() === targetStatus);
        if (matching.length === 0) return;
        matching.sort((a, b) => ((b.reviewDate || '') > (a.reviewDate || '') ? 1 : -1));
        allProjectData[product] = matching[0];
    });
    masterProjectData = JSON.parse(JSON.stringify(allProjectData));
    currentRatingFilter = null;
}

function toggleActiveSprintFilter() {
    const toggle = document.getElementById('activeSprintToggle');
    const knob = document.querySelector('#activeSprintSlider div');
    showActiveSprints = toggle.checked;
    knob.style.left = showActiveSprints ? '28px' : '4px';
    rebuildFromHistory();
    document.getElementById('clearFilterContainer').classList.add('hidden');
    activeParent = null;
    selectedProjects.clear();
    const uniqueManagers = new Set();
    Object.values(allProjectData).forEach(p => uniqueManagers.add(p.manager));
    populateManagerDropdown(Array.from(uniqueManagers).sort());
    selectedManagers = new Set(['All']);
    updateRatingSummary();
    refreshUI();
    updateSprintList();
}

document.getElementById('folderInput').addEventListener('change', async (e) => {
    const allFiles = Array.from(e.target.files);
    const files = allFiles.filter(f => f.name.endsWith('.md'));
    const copilotFile = allFiles.find(f => f.name === 'copilotdata.json');
    if (copilotFile) {
        try {
            const text = await copilotFile.text();
            copilotDataInMemory = JSON.parse(text);
            copilotUserLeaderboard = extractCopilotUserLeaderboard(copilotDataInMemory);
        } catch (err) { copilotDataInMemory = null; copilotUserLeaderboard = null; }
    } else {
        copilotDataInMemory = null;
        copilotUserLeaderboard = null;
    }
    const cursorFile = allFiles.find(f => f.name === 'cursordata.json');
    if (cursorFile) {
        try {
            const text = await cursorFile.text();
            cursorDataInMemory = JSON.parse(text);
        } catch (err) { cursorDataInMemory = null; }
    } else {
        cursorDataInMemory = null;
    }
    const rdFile = allFiles.find(f => f.name === 'resource-directory.json');
    if (rdFile) {
        try {
            const rd = JSON.parse(await rdFile.text());
            if (rd && Array.isArray(rd.users)) {
                knownOrgNamesLower = buildKnownOrgNames(rd.users);
            }
        } catch (err) { knownOrgNamesLower = null; }
    }
    await loadIdcEmployeeNames();
    projectHistory = {};
    const uniqueManagers = new Set();
    const dataAtCandidates = [];
    for (const file of files) {
        const text = await file.text();
        const dataAtStr = text.match(/\*\*DataAt:\*\*\s*(.+?)(?:\n|$)/)?.[1]?.trim();
        if (dataAtStr) dataAtCandidates.push({ str: dataAtStr, date: parseDataAtDisplay(dataAtStr) });
        const product = text.match(/\*{0,2}Product:\*{0,2}\s*(.*?)\s*\*{0,2}\s*$/m)?.[1]?.trim() || file.name.replace('.md', '');
        const parent = text.match(/\*{0,2}Parent:\*{0,2}\s*(.*?)\s*\*{0,2}\s*$/m)?.[1]?.trim() || "Independent";
        const manager = text.match(/\*{0,2}Manager:\*{0,2}\s*(.*?)\s*\*{0,2}\s*$/m)?.[1]?.trim() || "N/A";
        const boardType = (text.match(/\*\*Board:\*\*\s*(.*)/)?.[1]?.trim() || 'Sprint').toLowerCase() === 'kanban' ? 'Kanban' : 'Sprint';
        const period = text.match(/\*\*(?:Period|Sprint name):\*\*\s*(.*)/i)?.[1]?.trim() || '';
        const data = (typeof parseMD === 'function' ? parseMD : function () { return {}; })(text);
		
		const projectInfo = { ...data, parent, name: product, manager, period, boardType };
        if (!projectHistory[product]) { projectHistory[product] = []; }
        projectHistory[product].push(projectInfo);
        uniqueManagers.add(manager);
    }
	
    localStorage.setItem('allProjectsHistory', JSON.stringify(projectHistory));
    rebuildFromHistory();

    const withDate = dataAtCandidates.filter(x => x.date);
    const latest = withDate.length ? withDate.sort((a, b) => a.date - b.date).pop() : null;
    const fallbackISO = files.length ? new Date(Math.max(...files.map(f => f.lastModified))).toISOString() : null;
    setLastSyncDisplay(latest ? latest.str : fallbackISO);

    populateManagerDropdown(Array.from(uniqueManagers).sort());
    document.getElementById('filterSection').classList.remove('hidden');
	document.getElementById('mainarea').classList.remove('hidden');
	document.getElementById('aiOrgSection').classList.remove('hidden');
	const ratingBar = document.getElementById('ratingSummaryBar');
	if (ratingBar) ratingBar.classList.remove('hidden');
	updateRatingSummary(); 
	refreshUI();
	Promise.all([loadCopilotDashboard(), loadCursorDashboard()]).then(function () {
		renderUnifiedLeaderboard();
		updateIntegrationStatus();
	}).catch(function () { updateIntegrationStatus(); });
	loadStageDwellChart();
	updateIntegrationStatus();
});

function populateManagerDropdown(managers) {
    const dropdown = document.getElementById('managerDropdown');
    dropdown.innerHTML = '<option value="All" selected>ALL MANAGERS</option>';
    managers.forEach(m => {
        const opt = document.createElement('option'); opt.value = m; opt.innerText = m.toUpperCase();
        dropdown.appendChild(opt);
    });
}

document.getElementById('applyFilterBtn').onclick = () => {
    const options = document.getElementById('managerDropdown').selectedOptions;
    selectedManagers = new Set(Array.from(options).map(o => o.value));
    selectedProjects.clear(); activeParent = null;
    refreshUI();
};

const clearFilterBtn = document.getElementById('clearFilterBtn');
if (clearFilterBtn) clearFilterBtn.addEventListener('click', resetProjectFilter);
const activeSprintToggle = document.getElementById('activeSprintToggle');
if (activeSprintToggle) activeSprintToggle.addEventListener('change', toggleActiveSprintFilter);
const generateOrgAiBtn = document.getElementById('generateOrgAiBtn');
if (generateOrgAiBtn) generateOrgAiBtn.addEventListener('click', generateOrgAISummary);
const pieZoomOverlay = document.getElementById('pieZoomOverlay');
if (pieZoomOverlay) pieZoomOverlay.addEventListener('click', handlePieOverlayClick);
const pieZoomCloseBtn = document.getElementById('pieZoomCloseBtn');
if (pieZoomCloseBtn) pieZoomCloseBtn.addEventListener('click', closePieZoom);
const devScoreOverlay = document.getElementById('devScoreOverlay');
if (devScoreOverlay) devScoreOverlay.addEventListener('click', (e) => { if (!document.getElementById('devScoreCard').contains(e.target)) closeDevScoreOverlay(); });
const devScoreCloseBtn = document.getElementById('devScoreCloseBtn');
if (devScoreCloseBtn) devScoreCloseBtn.addEventListener('click', closeDevScoreOverlay);
const qaScoreOverlay = document.getElementById('qaScoreOverlay');
if (qaScoreOverlay) qaScoreOverlay.addEventListener('click', (e) => { if (!document.getElementById('qaScoreCard').contains(e.target)) closeQaScoreOverlay(); });
const qaScoreCloseBtn = document.getElementById('qaScoreCloseBtn');
if (qaScoreCloseBtn) qaScoreCloseBtn.addEventListener('click', closeQaScoreOverlay);

// initSelectors / updateChildPills / createProjectCard removed along with the
// "Project Portfolio" selector card. The dashboard now runs on the aggregate
// (all-projects) view; selectedProjects stays at default (empty Set = all).
function initSelectors() { /* no-op: selector card removed */ }

function createPill(name, onclick) {
    const b = document.createElement('button');
    const isSel = selectedProjects.has(name);
    b.className = `pill ${isSel ? 'pill-selected' : 'pill-unselected'} px-8 py-4 rounded-2xl text-sm font-black uppercase`;
    b.innerText = name; b.onclick = onclick;
    return b;
}
function syncWorkCatRow() {
    const row = document.getElementById('workCategorizationRow');
    const work = document.getElementById('workCategorizationSection');
    if (!row || !work) return;
    if (work.classList.contains('hidden')) row.classList.add('hidden');
    else row.classList.remove('hidden');
}

/** Hue steps for Work Categorization stacked segments (distinct, readable on dark bg). */
function workCatSegmentColor(index) {
    const h = (38 + index * 47.3) % 360;
    return {
        bg: `hsla(${h}, 58%, 52%, 0.88)`,
        border: `hsla(${h}, 58%, 68%, 0.35)`,
    };
}

/**
 * Stacked bar chart: per project, % of each JIRA Work Classification (closed items, else opened).
 * Data from parseMD ? workClassification on each project (sprint MD).
 */
function updateWorkCategorizationChart(keys) {
    const canvas = document.getElementById('workCategorizationChart');
    const section = document.getElementById('workCategorizationSection');
    if (!canvas || !section) return;
    if (!keys || !keys.length) {
        if (workCategorizationChart) {
            workCategorizationChart.destroy();
            workCategorizationChart = null;
        }
        section.classList.add('hidden');
        syncWorkCatRow();
        return;
    }

    const sortedKeys = sortProjectNamesForChart(keys);

    /** @type {{ projectKey: string, label: string, useClosed: boolean, total: number, byCat: Map<string, { opened: number, closed: number }> }[]} */
    const perProject = sortedKeys.map((k) => {
        const d = allProjectData[k];
        const wc = (d && Array.isArray(d.workClassification)) ? d.workClassification : [];
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
        return {
            projectKey: k,
            label: k,
            useClosed,
            total,
            byCat,
        };
    });

    const hasAnyData = perProject.some((p) => p.total > 0);
    if (!hasAnyData) {
        if (workCategorizationChart) {
            workCategorizationChart.destroy();
            workCategorizationChart = null;
        }
        section.classList.add('hidden');
        syncWorkCatRow();
        return;
    }

    const catSet = new Set();
    perProject.forEach((p) => {
        if (p.total <= 0) return;
        p.byCat.forEach((_, cat) => {
            const v = p.useClosed ? (p.byCat.get(cat).closed || 0) : (p.byCat.get(cat).opened || 0);
            if (v > 0) catSet.add(cat);
        });
    });
    if (catSet.size === 0) {
        if (workCategorizationChart) {
            workCategorizationChart.destroy();
            workCategorizationChart = null;
        }
        section.classList.add('hidden');
        syncWorkCatRow();
        return;
    }

    const categories = [...catSet].sort((a, b) => {
        const ua = /^uncategorized$/i.test(a);
        const ub = /^uncategorized$/i.test(b);
        if (ua && !ub) return 1;
        if (!ua && ub) return -1;
        return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });

    const labels = perProject.map((p) => p.label);
    const datasets = categories.map((cat, idx) => {
        const colors = workCatSegmentColor(idx);
        const data = perProject.map((p) => {
            if (p.total <= 0) return 0;
            const row = p.byCat.get(cat);
            const raw = p.useClosed ? (row ? row.closed : 0) : (row ? row.opened : 0);
            return (100 * raw) / p.total;
        });
        return {
            label: cat,
            data,
            backgroundColor: colors.bg,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 4,
            stack: 'wc',
        };
    });

    const fontMono = "'JetBrains Mono', ui-monospace, monospace";

    /** Tooltip: % and raw count for that segment */
    const tooltipMeta = {
        perProject,
        categories,
    };

    section.classList.remove('hidden');
    syncWorkCatRow();
    if (workCategorizationChart) {
        try {
            workCategorizationChart.destroy();
        } catch (e) { /* ignore */ }
        workCategorizationChart = null;
    }
    if (typeof Chart === 'undefined') {
        section.classList.add('hidden');
        syncWorkCatRow();
        return;
    }

    const wcTip = chartTooltipTheme();
    const pbWc = portfolioBarChartTheme();
    try {
        workCategorizationChart = new Chart(canvas, {
            type: 'bar',
            data: {
                labels,
                datasets,
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 500 },
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: {
                        stacked: true,
                        ticks: {
                            color: chartAxisTickColor(),
                            font: { size: 10, family: fontMono },
                            maxRotation: 55,
                            minRotation: 0,
                        },
                        grid: { display: false },
                        border: { display: true, color: pbWc.axisLine },
                    },
                    y: {
                        stacked: true,
                        min: 0,
                        max: 100,
                        ticks: {
                            color: chartAxisTickColor(),
                            font: { size: 10, family: fontMono },
                            callback: (v) => (Number.isFinite(v) ? `${v}%` : ''),
                        },
                        title: {
                            display: true,
                            text: 'Share (%)',
                            color: chartAxisSecondaryColor(),
                            font: { size: 11, family: fontMono, weight: '600' },
                        },
                        grid: { color: pbWc.grid, lineWidth: 1 },
                        border: { display: false },
                    },
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'bottom',
                        align: 'start',
                        labels: {
                            color: chartLegendPrimaryColor(),
                            font: { size: 10, family: fontMono },
                            usePointStyle: true,
                            pointStyle: 'rectRounded',
                            padding: 16,
                            boxWidth: 10,
                            boxHeight: 10,
                        },
                    },
                    tooltip: {
                        backgroundColor: wcTip.backgroundColor,
                        titleColor: wcTip.titleColor,
                        bodyColor: wcTip.bodyColor,
                        borderColor: wcTip.borderColor,
                        borderWidth: 1,
                        padding: 12,
                        cornerRadius: 12,
                        displayColors: true,
                        boxPadding: 6,
                        titleFont: { family: fontMono, size: 11 },
                        bodyFont: { family: fontMono, size: 11 },
                        callbacks: {
                            title: (items) => {
                                const idx = items && items[0] ? items[0].dataIndex : 0;
                                return labels[idx] || '';
                            },
                            label: (ctx) => {
                                const cat = ctx.dataset.label || '';
                                const idx = ctx.dataIndex;
                                const pct = ctx.parsed && typeof ctx.parsed.y === 'number' ? ctx.parsed.y : Number(ctx.raw) || 0;
                                const pp = tooltipMeta.perProject[idx];
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
        if (window.ChartZoom) window.ChartZoom.enable(workCategorizationChart, { title: 'Work Categorization by Project', eyebrow: 'Stacked share (%)' });
    } catch (err) {
        console.error('[Work Categorization] Chart failed:', err);
        workCategorizationChart = null;
        section.classList.add('hidden');
        syncWorkCatRow();
    }
}

function refreshUI() {
    const keys = selectedProjects.size ? Array.from(selectedProjects) : Object.keys(allProjectData).filter(p => {
        const d = allProjectData[p];
        const inManager = selectedManagers.has('All') || selectedManagers.has(d.manager);
        return inManager;
    });

    if (!keys.length) {
        document.querySelectorAll('.stat-value').forEach(el => el.innerText = '0');
        updateWorkCategorizationChart([]);
        return;
    }

    const isMulti = keys.length > 1;
    document.getElementById('viewType').innerText = isMulti ? 'Global Ops Mode' : `Local: ${keys[0]}`;

    let agg = { inds: {}, splits: {} };

    keys.forEach(k => {
        const d = allProjectData[k];
        if(!d) return;
        agg.splits[k] = d;
        (d.individuals || []).forEach(i => {
            if(!agg.inds[i.name]) agg.inds[i.name] = { pts: 0, ai: [], team: d.name, sprintPresence: 0, projects: new Set(), confluencePages: 0 };
            agg.inds[i.name].pts += Number.isFinite(Number(i.pts)) ? Number(i.pts) : 0;
            const hasDevToolsData = (cursorDataInMemory || copilotUserLeaderboard) && d.name;
            const aiVal = hasDevToolsData
                ? computeAiAdoptionRatingForPerson(i.name, i.pts, d.individuals, d.name, cursorDataInMemory)
                : (i.ai != null ? Number(i.ai) : 0);
            agg.inds[i.name].ai.push(Number.isFinite(aiVal) ? aiVal : 0);
            if ((Number(i.pts) || 0) > 0 || Number.isFinite(Number(aiVal))) agg.inds[i.name].sprintPresence += 1;
            if (d.name) agg.inds[i.name].projects.add(d.name);
        });
        (d.confluenceActivity || []).forEach(c => {
            const nm = (c.name || '').trim();
            if (!nm || nm === '—') return;
            if (!agg.inds[nm]) agg.inds[nm] = { pts: 0, ai: [], team: d.name, sprintPresence: 0, projects: new Set(), confluencePages: 0 };
            agg.inds[nm].confluencePages += (Number(c.pagesCreated) || 0) + (Number(c.pagesEdited) || 0);
        });
    });

    updatePieCharts(agg.splits);
    updateSprintList();
    const ghRows = getAggregatedGitHubLeaderboard();
    const scores = computeresourceScores(agg.inds, ghRows, cursorDataInMemory, copilotDataInMemory);
    lastGhRows = ghRows;
    lastresourceScores = scores;
    renderGitHubDataTable(ghRows, scores);
    renderQaLeaderboard(keys);
    updateWorkCategorizationChart(keys);
    renderHygienePanel(keys);
    renderTeamHealthMatrix();
}

// ----------------------------
// JIRA Hygiene Panel
// ----------------------------

function hygieneScoreColor(score) {
    if (score == null) return { text: 'text-slate-400', bg: 'rgba(100,116,139,0.18)', border: 'rgba(100,116,139,0.3)' };
    if (score >= 80) return { text: 'text-emerald-400', bg: 'rgba(16,185,129,0.15)', border: 'rgba(16,185,129,0.35)' };
    if (score >= 60) return { text: 'text-amber-400',   bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.35)' };
    return                 { text: 'text-rose-400',    bg: 'rgba(239,68,68,0.15)',  border: 'rgba(239,68,68,0.35)' };
}

/**
 * Render (or re-render) the JIRA Hygiene panel.
 * Always uses the latest CLOSED sprint per project from projectHistory,
 * regardless of the active-sprint toggle, since hygiene on a mid-sprint
 * board is incomplete and misleading.
 */
function renderHygienePanel(keys) {
    const section    = document.getElementById('hygieneSection');
    const scoreCards = document.getElementById('hygieneScoreCards');
    const tbody      = document.getElementById('hygieneBreakdownBody');
    const noData     = document.getElementById('hygieneNoData');
    if (!section || !scoreCards || !tbody) return;

    // For each visible project, find the latest closed sprint in history
    const rows = (keys || []).map(k => {
        const sprints = (projectHistory[k] || [])
            .filter(s => (s.status || '').toLowerCase() === 'closed')
            .sort((a, b) => ((b.reviewDate || '') > (a.reviewDate || '') ? 1 : -1));
        const d = sprints[0] || null;
        return { key: k, d, sprintLabel: d ? (d.period || '') : null };
    }).filter(({ d }) => d && d.hygiene && d.hygiene.score != null);

    if (rows.length === 0) {
        scoreCards.innerHTML = '';
        tbody.innerHTML = '';
        if (noData) noData.classList.add('hidden');
        section.classList.add('hidden');
        return;
    }
    if (noData) noData.classList.add('hidden');

    // --- Score Cards (one per project) ---
    scoreCards.innerHTML = rows.map(({ key, d, sprintLabel }) => {
        const h = d.hygiene;
        const clr = hygieneScoreColor(h.score);
        const emoji = h.score >= 80 ? '??' : h.score >= 60 ? '??' : '??';
        const sprintTip = sprintLabel ? ` title="Last closed sprint: ${escapeHtml(sprintLabel)}"` : '';
        return `<div class="rounded-xl px-3 py-3 flex flex-col items-center gap-1 border"
                     style="background:${clr.bg}; border-color:${clr.border};"${sprintTip}>
            <div class="text-[10px] text-slate-400 font-semibold uppercase tracking-wider truncate w-full text-center" title="${escapeHtml(key)}">${escapeHtml(key)}</div>
            <div class="text-2xl font-black tabular-nums ${clr.text}">${h.score}</div>
            <div class="text-[11px] text-slate-400">/100 ${emoji}</div>
            <div class="text-[9px] text-slate-500">${h.total} tickets</div>
            ${sprintLabel ? `<div class="text-[8px] text-slate-600 truncate w-full text-center mt-0.5">${escapeHtml(sprintLabel)}</div>` : ''}
        </div>`;
    }).join('');

    // Column order for the breakdown table (matches header order in HTML)
    const METRIC_KEYS = [
        'Unestimated tickets (0 SP, not done)',
        'No Work Classification',
        'Mid-sprint additions (scope creep)',
        'Missing priority',
        'Unresolved blockers',
        'Carry-over (not completed)',
    ];
    const SHORT_LABELS = [
        'Unestimated', 'No Class.', 'Scope Creep', 'Priority', 'Blockers', 'Carry-over'
    ];

    const findMetric = (metrics, label) =>
        (metrics || []).find(m => m.label && m.label.toLowerCase().includes(label.toLowerCase().split(' ')[0].replace(',', '')));

    // --- Breakdown Table rows ---
    tbody.innerHTML = rows.map(({ key, d, sprintLabel }, idx) => {
        const h = d.hygiene;
        const clr = hygieneScoreColor(h.score);
        const glassRow = idx % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'transparent';

        const cells = METRIC_KEYS.map((label, i) => {
            const m = findMetric(h.metrics, label);
            if (!m) return `<td class="px-3 py-2.5 text-center text-slate-600">—</td>`;
            const pct = Math.round((m.rate || 0) * 100);
            const statusEmoji = m.statusEmoji || (pct === 0 ? '??' : pct <= 15 ? '??' : '??');
            const tipText = m.sample && m.sample !== '—' ? `title="${escapeHtml(m.sample)}"` : '';
            const countTxt = m.count > 0
                ? `<span class="${m.count > 0 ? 'text-white font-semibold' : 'text-slate-500'}">${m.count}</span> <span class="text-slate-500">(${pct}%)</span>`
                : `<span class="text-slate-500">0</span>`;
            return `<td class="px-3 py-2.5 text-center whitespace-nowrap" ${tipText}>${statusEmoji} ${countTxt}</td>`;
        }).join('');

        const sprintTip = sprintLabel ? ` title="Last closed sprint: ${escapeHtml(sprintLabel)}"` : '';
        return `<tr style="background:${glassRow}; border-bottom: 1px solid rgba(255,255,255,0.04);">
            <td class="px-3 py-2.5 font-semibold text-white whitespace-nowrap"${sprintTip}>
                ${escapeHtml(key)}
                ${sprintLabel ? `<div class="text-[9px] text-slate-500 font-normal">${escapeHtml(sprintLabel)}</div>` : ''}
            </td>
            <td class="px-3 py-2.5 text-center font-black tabular-nums ${clr.text} whitespace-nowrap">${h.score}<span class="text-slate-500 font-normal text-[9px]">/100</span></td>
            ${cells}
        </tr>`;
    }).join('');

    section.classList.remove('hidden');
}

/**
 * Compute overall score 0–10 per resource (shared with project detail via resource-score-compute.js).
 */
function computeresourceScores(inds, ghRows, cursorData, copilotData) {
    if (!window.VelosyncresourceScore || typeof window.VelosyncresourceScore.compute !== 'function') {
        console.warn('[VeloSync] resource-score-compute.js not loaded');
        return [];
    }
    return window.VelosyncresourceScore.compute(
        inds,
        ghRows,
        cursorData,
        copilotData,
        copilotUserLeaderboard,
        resource_SCORE_WEIGHTS,
        DEV_DATA_COMBINED_MAX_WEIGHT,
        { similarEnough, getCursorLeaderboardRowsForMatch }
    );
}

/** Dev Data table sort state (used by renderGitHubDataTable and header clicks). */
let devDataSortColumn = 'score';
let devDataSortDirection = 'desc';
let lastGhRows = null;
let lastresourceScores = null;
let devDataSortBound = false;
let devScoreRowClickBound = false;

/** QA Leaderboard sort state. */
let qaDataSortColumn = 'score';
let qaDataSortDirection = 'desc';
let lastQaRows = null;
let qaDataSortBound = false;
let qaScoreRowClickBound = false;

/** Build map: resource display name -> score (0–10) for lookup in GitHub table. */
function scoreByresourceName(scores) {
    const map = new Map();
    (scores || []).forEach(r => {
        const key = (r.name || '').trim();
        if (key) map.set(key, Math.max(map.get(key) ?? 0, r.score));
    });
    return map;
}

/** Full score row (including breakdown) for the highest score when names repeat. */
function resourceScoreDetailByName(scores) {
    const map = new Map();
    (scores || []).forEach(r => {
        const key = (r.name || '').trim();
        if (!key) return;
        const prev = map.get(key);
        if (!prev || r.score > prev.score) map.set(key, r);
    });
    return map;
}

/** HTML for Dev score hover panel (weights + contributions out of 10). */
function formatDevScoreTooltipHtml(detail) {
    const b = detail && detail.breakdown;
    if (!b) return '';
    const w = b.weights || resource_SCORE_WEIGHTS;
    const we = b.weightsEffective || w;
    const pct = (x) => `${Math.round(Number(x) * 100)}%`;
    const n = (v) => (Number(v) || 0).toFixed(2);
    const pts = (v) => (Number(v) || 0).toFixed(2);
    const raw10 = Number(b.raw10) || 0;
    const a = b.actuals;
    const fmtInt = (v) => String(Math.round(Number(v) || 0));
    const fmtDec = (v, d) => (Number(v) || 0).toFixed(d);
    const actualsBlock = a
        ? `<div class="mb-3 rounded-lg border border-slate-700 bg-slate-900 p-2.5 text-[10px] text-slate-300">
        <div class="text-[9px] font-black uppercase tracking-wider text-slate-500 mb-2">Your inputs (filtered period)</div>
        <div class="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">Story points</span><span class="text-white font-bold tabular-nums">${fmtDec(a.storyPoints, 1)}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">PRs</span><span class="text-cyan-300 font-bold tabular-nums">${fmtInt(a.githubPrs)}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">Commits</span><span class="text-emerald-300 font-bold tabular-nums">${fmtInt(a.githubCommits)}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">Lines (+)</span><span class="text-green-300 font-bold tabular-nums">${fmtInt(a.githubAdditions)}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">Lines (-)</span><span class="text-rose-300 font-bold tabular-nums">${fmtInt(a.githubDeletions)}</span></div>
            <div class="flex justify-between gap-2 min-w-0"><span class="text-slate-500 min-w-0 pr-2 leading-snug">Review ratio (PR/commit)</span><span class="text-cyan-200 font-bold tabular-nums shrink-0">${fmtDec(a.githubReviewRatio, 2)}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">Churn / commit</span><span class="text-cyan-200 font-bold tabular-nums">${fmtDec(a.githubChurnPerCommit, 1)}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">Sprint presence</span><span class="text-emerald-200 font-bold tabular-nums">${fmtInt(a.sprintPresence)}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">Project breadth</span><span class="text-emerald-200 font-bold tabular-nums">${fmtInt(a.projectCount)}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">Repo breadth</span><span class="text-emerald-200 font-bold tabular-nums">${fmtInt(a.repoCount)}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">AI avg (1–4)</span><span class="text-amber-200 font-bold tabular-nums">${(Number(a.avgAiRating) || 0) > 0 ? fmtDec(a.avgAiRating, 2) : 'N/A'}</span></div>
            <div class="col-span-2 flex justify-between gap-2"><span class="text-slate-500 shrink-0">Cursor org leaderboard (top ${CURSOR_LEADERBOARD_MATCH_LIMIT})</span><span class="text-violet-300 font-bold">${a.cursorOnLeaderboard ? 'Yes' : 'No'}</span></div>
            <div class="col-span-2 flex justify-between gap-2"><span class="text-slate-500 shrink-0">Copilot user leaderboard (top 25)</span><span class="text-teal-300 font-bold">${a.copilotOnLeaderboard ? 'Yes' : 'No'}</span></div>
            <div class="col-span-2 flex justify-between gap-2"><span class="text-slate-500 shrink-0">Copilot org signal (30d)</span><span class="text-amber-300 font-bold">${Math.round((Number(a.copilotOrgSignal) || 0.5) * 100)}%</span></div>
            <div class="col-span-2 flex justify-between gap-2"><span class="text-slate-500 shrink-0">Confluence pages (created + edited)</span><span class="text-orange-300 font-bold">${fmtInt(a.confluencePages)}</span></div>
        </div>
        <div class="mt-2 pt-2 border-t border-slate-700 text-[9px] text-slate-500 leading-snug">Activity index: <span class="text-slate-300 font-mono tabular-nums">${fmtDec(a.ghActivityIndex, 2)}</span> (1.8×commits + 1.2×PRs + ln(1+lines changed))</div>
    </div>`
        : '';
    const totalContrib = (Number(b.contribDelivery) || 0)
        + (Number(b.contribGitHubImpact) || 0)
        + (Number(b.contribGitHubQuality) || 0)
        + (Number(b.contribConsistency) || 0)
        + (Number(b.contribImpactBreadth) || 0)
        + (Number(b.contribConfluence) || 0)
        + (Number(b.contribCursor) || 0)
        + (Number(b.contribCopilot) || 0)
        + (Number(b.contribAI) || 0);
    const seg = (c) => {
        if (totalContrib <= 0) return '0';
        return `${((Number(c) || 0) / totalContrib) * 100}%`;
    };
    const rows = [
        { label: 'Delivery', sub: 'story points vs peers', weight: we.DELIVERY, norm: b.normDelivery, contrib: b.contribDelivery, color: 'bg-emerald-600' },
        { label: 'GitHub impact', sub: 'commits/PR/lines index', weight: we.GITHUB_IMPACT, norm: b.normGitHubImpact, contrib: b.contribGitHubImpact, color: 'bg-cyan-600' },
        { label: 'GitHub quality', sub: 'PR ratio + churn health', weight: we.GITHUB_QUALITY, norm: b.normGitHubQuality, contrib: b.contribGitHubQuality, color: 'bg-sky-600' },
        { label: 'Consistency', sub: 'presence + stable AI usage', weight: we.CONSISTENCY, norm: b.normConsistency, contrib: b.contribConsistency, color: 'bg-lime-600' },
        { label: 'Impact breadth', sub: 'projects + repos touched', weight: we.IMPACT_BREADTH, norm: b.normImpactBreadth, contrib: b.contribImpactBreadth, color: 'bg-teal-600' },
        { label: 'Docs activity', sub: 'Confluence pages created + edited', weight: we.CONFLUENCE_DOCS, norm: b.normConfluence, contrib: b.contribConfluence, color: 'bg-orange-600' },
        { label: 'Cursor', sub: 'leaderboard quality/volume/rank (inside 24%)', weight: we.CURSOR_LEADERBOARD, norm: b.normCursor, contrib: b.contribCursor, color: 'bg-violet-600' },
        { label: 'Copilot', sub: 'user-level lines/acceptance/features/rank (inside 24%)', weight: we.COPILOT_INDIVIDUAL, norm: b.normCopilot, contrib: b.contribCopilot, color: 'bg-teal-500' },
        { label: 'AI tools adoption', sub: 'JIRA AI rating with Copilot org signal (inside 24%)', weight: we.AI_TOOLS_ADOPTION, norm: b.normAiTools, contrib: b.contribAI, color: 'bg-amber-600' },
    ];
    const bar = `<div class="flex h-2 w-full rounded overflow-hidden bg-slate-800 ring-1 ring-slate-600" aria-hidden="true">${rows.map(r => `<div class="${r.color} h-full transition-[width]" style="width:${seg(r.contrib)}"></div>`).join('')}</div>`;
    const list = rows.map((r) => {
        const normLabel = r.label === 'Cursor' ? ((Number(r.norm) || 0) >= 1 ? '1 (yes)' : '0 (no)') : n(r.norm);
        return `<div class="flex justify-between gap-3 border-b border-slate-700 pb-1.5 last:border-0 last:pb-0">
            <div class="min-w-0"><span class="text-slate-200 font-bold">${r.label}</span> <span class="text-slate-500">${pct(r.weight)}</span><div class="text-slate-500 mt-0.5">${r.sub}</div></div>
            <div class="text-right shrink-0 tabular-nums"><span class="text-slate-400">${normLabel}</span><div class="text-emerald-400 font-bold">+${pts(r.contrib)}</div></div>
        </div>`;
    }).join('');
    return `<div class="text-left font-sans">
        ${actualsBlock}
        <div class="text-[11px] font-black uppercase tracking-wider text-slate-400 mb-1.5">Dev score breakdown</div>
        <div class="text-[9px] text-slate-500 mb-2">Cursor + Copilot + AI adoption are combined and capped at ${Math.round(DEV_DATA_COMBINED_MAX_WEIGHT * 100)}% total weight.</div>
        <div class="text-[10px] text-slate-500 mb-2">Weighted sum ? <span class="text-slate-200 font-bold">${pts(raw10)}</span> / 10 ? rounded <span class="text-white font-black">${detail.score}</span></div>
        <p class="text-[9px] text-slate-600 mb-2">Each +value is weight × normalized factor × 10 (points toward 10).</p>
        <div class="mb-2"><div class="text-[9px] uppercase tracking-wider text-slate-500 mb-1">Distribution of contributions</div>${bar}</div>
        <div class="space-y-2">${list}</div>
    </div>`;
}

/** Aggregate GitHub metrics (section 2.3) from filtered projects; merge by name, sort by commits then PRs. */
function getAggregatedGitHubLeaderboard() {
    const keys = selectedProjects.size
        ? Array.from(selectedProjects)
        : Object.keys(allProjectData).filter(p => {
            const d = allProjectData[p];
            return selectedManagers.has('All') || selectedManagers.has(d.manager);
        });
    const byName = new Map();
    for (const k of keys) {
        const d = allProjectData[k];
        if (!d || !Array.isArray(d.githubMetrics)) continue;
        for (const row of d.githubMetrics) {
            const name = (row.name || '').trim() || '—';
            if (isExcludedFromDevData(name)) continue;
            if (!byName.has(name)) byName.set(name, { name, repos: new Set(), prs: 0, commits: 0, additions: 0, deletions: 0, notes: [] });
            const rec = byName.get(name);
            rec.prs += Number(row.prs) || 0;
            rec.commits += Number(row.commits) || 0;
            rec.additions += Number(row.additions) || 0;
            rec.deletions += Number(row.deletions) || 0;
            if (row.repos && String(row.repos).trim() && row.repos !== '—') {
                String(row.repos).split(',').map(s => s.trim()).filter(Boolean).forEach(r => rec.repos.add(r));
            }
            if (row.notes && String(row.notes).trim()) rec.notes.push(String(row.notes).trim());
        }
    }
    const rows = Array.from(byName.values())
        .filter(r => r.prs > 0 || r.commits > 0 || r.additions > 0 || r.deletions > 0)
        .map(r => ({
            name: r.name,
            repos: r.repos.size ? Array.from(r.repos).slice(0, 5).join(', ') + (r.repos.size > 5 ? ` +${r.repos.size - 5} more` : '') : '—',
            prs: r.prs,
            commits: r.commits,
            additions: r.additions,
            deletions: r.deletions,
            notes: r.notes.length ? r.notes[r.notes.length - 1] : '',
        }));

    // When 2+ people share identical non-zero (commits, additions, deletions), their GitHub
    // login almost certainly resolved to the same wrong account during data generation.
    // Blank out just the numeric metrics for those rows so we never display identical figures
    // as if they represent different individuals — rows remain visible for the person's name/score.
    const sigCount = new Map();
    for (const r of rows) {
        if (r.commits > 0 || r.additions > 0 || r.deletions > 0) {
            const sig = `${r.commits}|${r.additions}|${r.deletions}`;
            sigCount.set(sig, (sigCount.get(sig) || 0) + 1);
        }
    }
    for (const r of rows) {
        const sig = `${r.commits}|${r.additions}|${r.deletions}`;
        if ((sigCount.get(sig) || 0) > 1) {
            r.prs = null;
            r.commits = null;
            r.additions = null;
            r.deletions = null;
            r.repos = '—';
        }
    }

    return rows.filter(r => r.prs != null || r.commits != null || r.additions != null || r.deletions != null);
}

function renderGitHubDataTable(rows, resourceScores) {
    const tbody = document.getElementById('githubLeaderboardBody');
    if (!tbody) return;
    const scoreMap = scoreByresourceName(resourceScores);
    const detailMap = resourceScoreDetailByName(resourceScores);
    if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="py-8 text-center text-slate-500 italic">No GitHub metrics in selected filter.</td></tr>';
        updateDevDataSortHeaders();
        bindDevDataSortOnce();
        return;
    }
    const getDocsCount = (name) => {
        const d = detailMap.get((name || '').trim());
        return (d && d.breakdown && d.breakdown.actuals) ? (Number(d.breakdown.actuals.confluencePages) || 0) : 0;
    };
    const dir = devDataSortDirection === 'asc' ? 1 : -1;
    const cmp = (a, b) => {
        let va, vb;
        switch (devDataSortColumn) {
            case 'name': va = (a.name || '').trim(); vb = (b.name || '').trim(); return dir * (va.localeCompare(vb, undefined, { sensitivity: 'base' }));
            case 'repos': va = (a.repos || '').trim(); vb = (b.repos || '').trim(); return dir * (va.localeCompare(vb, undefined, { sensitivity: 'base' }));
            case 'prs': return dir * ((a.prs ?? 0) - (b.prs ?? 0));
            case 'commits': return dir * ((a.commits ?? 0) - (b.commits ?? 0));
            case 'additions': return dir * ((a.additions ?? 0) - (b.additions ?? 0));
            case 'deletions': return dir * ((a.deletions ?? 0) - (b.deletions ?? 0));
            case 'docs': return dir * (getDocsCount(a.name) - getDocsCount(b.name));
            case 'score':
                va = scoreMap.get((a.name || '').trim()) ?? 0;
                vb = scoreMap.get((b.name || '').trim()) ?? 0;
                return dir * (va - vb);
            default: return dir * ((b.prs ?? 0) - (a.prs ?? 0));
        }
    };
    const sorted = [...rows].sort(cmp);
    const devTiers = devMainDisplayTiers();
    tbody.innerHTML = sorted.map((r, i) => {
        const zebra = i % 2 === 0 ? 'gh-leader-row--even' : 'gh-leader-row--odd';
        const nameKey = (r.name || '').trim();
        const score = scoreMap.get(nameKey);
        const scoreDetail = detailMap.get(nameKey);
        const hasBreakdown = !!(scoreDetail && scoreDetail.breakdown);
        const docsCount = getDocsCount(r.name);
        const scoreCell = score != null
            ? (() => {
                let scoreClass = 'text-slate-600';
                if (score >= devTiers.goodMin) scoreClass = 'text-emerald-600 font-bold';
                else if (score >= devTiers.midMin) scoreClass = 'text-amber-600 font-bold';
                else if (score >= devTiers.lowMin) scoreClass = 'text-slate-700 font-bold';
                return `<td class="py-3 px-4 gh-num tabular-nums ${scoreClass}"><span class="gh-num-block">${score}</span></td>`;
            })()
            : '<td class="py-3 px-4 gh-num tabular-nums text-slate-500">—</td>';
        const clickable = hasBreakdown ? `data-dev-score-name="${escapeHtml(nameKey)}" style="cursor:pointer" title="Click to see score breakdown"` : '';
        const numCell = (val, cls) => val != null
            ? `<td class="py-3 px-4 gh-num tabular-nums ${cls}"><span class="gh-num-block">${val}</span></td>`
            : `<td class="py-3 px-4 gh-num tabular-nums text-slate-500">—</td>`;
        const docsCell = docsCount > 0
            ? `<td class="py-3 px-4 gh-num tabular-nums text-orange-600 font-semibold"><span class="gh-num-block">${docsCount}</span></td>`
            : `<td class="py-3 px-4 gh-num tabular-nums text-slate-500"><span class="gh-num-block">0</span></td>`;
        return `<tr class="gh-leader-row border-b transition-colors ${zebra}" ${clickable}>
            <td class="py-3 px-4 gh-leader-name">${escapeHtml(r.name)}</td>
            <td class="py-3 px-4 gh-leader-repos truncate" style="max-width:0" title="${escapeHtml(r.repos)}">${escapeHtml(r.repos)}</td>
            ${numCell(r.prs, 'text-cyan-600 font-bold')}
            ${numCell(r.commits, 'text-emerald-600 font-bold')}
            ${numCell(r.additions, 'text-green-700 font-semibold')}
            ${numCell(r.deletions, 'text-rose-600 font-semibold')}
            ${docsCell}
            ${scoreCell}
        </tr>`;
    }).join('');
    updateDevDataSortHeaders();
    bindDevDataSortOnce();
    bindDevScoreRowClickOnce();
}

function updateDevDataSortHeaders() {
    const dashboard = document.getElementById('githubDataDashboard');
    if (!dashboard) return;
    dashboard.querySelectorAll('th.dev-data-sort').forEach(th => {
        const key = th.getAttribute('data-sort');
        th.classList.remove('sort-asc', 'sort-desc');
        if (key === devDataSortColumn) th.classList.add(devDataSortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
    });
}

function bindDevDataSortOnce() {
    if (devDataSortBound) return;
    const dashboard = document.getElementById('githubDataDashboard');
    if (!dashboard) return;
    devDataSortBound = true;
    dashboard.addEventListener('click', (e) => {
        const th = e.target.closest('th.dev-data-sort');
        if (!th) return;
        const column = th.getAttribute('data-sort');
        if (!column) return;
        if (devDataSortColumn === column) devDataSortDirection = devDataSortDirection === 'asc' ? 'desc' : 'asc';
        else { devDataSortColumn = column; devDataSortDirection = column === 'name' || column === 'repos' ? 'asc' : 'desc'; }
        if (lastGhRows && lastresourceScores) renderGitHubDataTable(lastGhRows, lastresourceScores);
    });
}

function bindDevScoreRowClickOnce() {
    if (devScoreRowClickBound) return;
    const tbody = document.getElementById('githubLeaderboardBody');
    if (!tbody) return;
    devScoreRowClickBound = true;
    tbody.addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-dev-score-name]');
        if (!row) return;
        const nameKey = row.getAttribute('data-dev-score-name');
        if (!nameKey || !lastresourceScores) return;
        const detailMap = resourceScoreDetailByName(lastresourceScores);
        const scoreDetail = detailMap.get(nameKey);
        if (!scoreDetail || !scoreDetail.breakdown) return;
        openDevScoreOverlay(nameKey, scoreDetail);
    });
}

function openDevScoreOverlay(name, scoreDetail) {
    const overlay = document.getElementById('devScoreOverlay');
    if (!overlay) return;
    document.getElementById('devScoreTitle').textContent = name;
    const scoreVal = document.getElementById('devScoreValue');
    const score = scoreDetail.score;
    const devTiers = devMainDisplayTiers();
    let scoreColor = 'text-slate-300';
    if (score >= devTiers.goodMin) scoreColor = 'text-emerald-400';
    else if (score >= devTiers.midMin) scoreColor = 'text-amber-400';
    scoreVal.className = `text-3xl font-black tabular-nums mt-1 ${scoreColor}`;
    scoreVal.textContent = `${score} / 10`;
    document.getElementById('devScoreBody').innerHTML = formatDevScoreTooltipHtml(scoreDetail);
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('dev-score-active')));
}

function closeDevScoreOverlay() {
    const overlay = document.getElementById('devScoreOverlay');
    if (!overlay) return;
    overlay.classList.remove('dev-score-active');
    setTimeout(() => overlay.classList.add('hidden'), 300);
}

function escapeHtml(s) {
    if (s == null) return '';
    const str = String(s);
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ----------------------------
// QA Leaderboard
// ----------------------------
function getAggregatedQaLeaderboard(keys) {
    const byName = new Map();
    const totalProjects = keys.length;
    var ensureRec = function (n) {
        if (!byName.has(n)) byName.set(n, { name: n, totalPts: 0, totalTickets: 0, projects: new Set(), confluencePages: 0, trCasesCreated: 0, trRunsCreated: 0, trPlansCreated: 0 });
        return byName.get(n);
    };
    for (const k of keys) {
        const d = allProjectData[k];
        if (!d) continue;
        if (Array.isArray(d.qaIndividuals)) {
            for (const q of d.qaIndividuals) {
                const n = (q.name || '').trim();
                if (!n || n === '—') continue;
                const rec = ensureRec(n);
                rec.totalPts += q.qaPts || 0;
                rec.totalTickets += q.qaTickets || 0;
                rec.projects.add(k);
            }
        }
        if (Array.isArray(d.testRailQA)) {
            for (const t of d.testRailQA) {
                const n = (t.name || '').trim();
                if (!n || n === '—') continue;
                const rec = ensureRec(n);
                rec.trCasesCreated += t.casesCreated || 0;
                rec.trRunsCreated += t.runsCreated || 0;
                rec.trPlansCreated += t.plansCreated || 0;
                rec.projects.add(k);
            }
        }
        (d.confluenceActivity || []).forEach(c => {
            const nm = (c.name || '').trim();
            if (!nm || nm === '—') return;
            const rec = byName.get(nm);
            if (rec) rec.confluencePages += (Number(c.pagesCreated) || 0) + (Number(c.pagesEdited) || 0);
        });
    }
    const allEntries = Array.from(byName.values());
    const filtered = knownOrgNamesLower && knownOrgNamesLower.size > 0
        ? allEntries.filter(r => knownOrgNamesLower.has(r.name.toLowerCase()))
        : allEntries.filter(r => !/^QA Tester #\d+$/i.test(r.name));
    const rows = filtered.map(r => {
        const ptsPerTicket = r.totalTickets > 0 ? +(r.totalPts / r.totalTickets).toFixed(1) : 0;
        const participation = totalProjects > 0 ? r.projects.size / totalProjects : 0;
        return {
            name: r.name,
            totalPts: r.totalPts,
            totalTickets: r.totalTickets,
            ptsPerTicket,
            projectNames: Array.from(r.projects).slice(0, 4).join(', ') + (r.projects.size > 4 ? ` +${r.projects.size - 4}` : ''),
            projectCount: r.projects.size,
            totalProjects,
            participation,
            confluencePages: r.confluencePages,
            trCasesCreated: r.trCasesCreated,
            trRunsCreated: r.trRunsCreated,
            trPlansCreated: r.trPlansCreated,
        };
    });
    if (!rows.length) return [];
    const maxPts = Math.max(1, ...rows.map(r => r.totalPts));
    const maxTix = Math.max(1, ...rows.map(r => r.totalTickets));
    const maxPpt = Math.max(1, ...rows.map(r => r.ptsPerTicket));
    const maxDocs = Math.max(1, ...rows.map(r => r.confluencePages));
    const maxTRTotal = Math.max(1, ...rows.map(r => r.trCasesCreated + r.trRunsCreated + r.trPlansCreated));
    const QW = qaMainWeights();
    rows.forEach(r => {
        const volume      = (r.totalPts / maxPts) * 100;
        const coverage    = (r.totalTickets / maxTix) * 100;
        const consistency = r.participation * 100;
        const complexity  = (r.ptsPerTicket / maxPpt) * 100;
        const docs        = (r.confluencePages / maxDocs) * 100;
        const authorship  = ((r.trCasesCreated + r.trRunsCreated + r.trPlansCreated) / maxTRTotal) * 100;
        const wv = Number(QW.VOLUME) || 0;
        const wc = Number(QW.COVERAGE) || 0;
        const wa = Number(QW.AUTHORSHIP) || 0;
        const ws = Number(QW.CONSISTENCY) || 0;
        const wx = Number(QW.COMPLEXITY) || 0;
        const wd = Number(QW.DOCS) || 0;
        const raw10 =
            (volume * wv + coverage * wc + authorship * wa + consistency * ws + complexity * wx + docs * wd) / 10;
        r.qaScore = Math.round(raw10);
        r.qaBreakdown = {
            normVolume: volume, normCoverage: coverage, normAuthorship: authorship,
            normConsistency: consistency, normComplexity: complexity, normDocs: docs,
            weights: { VOLUME: wv, COVERAGE: wc, AUTHORSHIP: wa, CONSISTENCY: ws, COMPLEXITY: wx, DOCS: wd },
            contribVolume:      volume      * wv / 10,
            contribCoverage:    coverage    * wc / 10,
            contribAuthorship:  authorship  * wa / 10,
            contribConsistency: consistency * ws / 10,
            contribComplexity:  complexity  * wx / 10,
            contribDocs:        docs        * wd / 10,
            raw10,
        };
    });
    rows.sort((a, b) => b.qaScore - a.qaScore);
    return rows;
}

function renderQaLeaderboard(keys) {
    const tbody = document.getElementById('qaLeaderboardBody');
    if (!tbody) return;
    const allRows = getAggregatedQaLeaderboard(keys);
    lastQaRows = allRows;
    if (!allRows.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="py-8 text-center text-slate-500 italic">No QA data in selected filter.</td></tr>';
        updateQaDataSortHeaders();
        bindQaDataSortOnce();
        return;
    }
    const dir = qaDataSortDirection === 'asc' ? 1 : -1;
    const cmp = (a, b) => {
        switch (qaDataSortColumn) {
            case 'name':     return dir * ((a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
            case 'projects': return dir * ((a.projectNames || '').localeCompare(b.projectNames || '', undefined, { sensitivity: 'base' }));
            case 'qapts':    return dir * (a.totalPts - b.totalPts);
            case 'tickets':  return dir * (a.totalTickets - b.totalTickets);
            case 'docs':     return dir * (a.confluencePages - b.confluencePages);
            case 'trcases':  return dir * (a.trCasesCreated - b.trCasesCreated);
            case 'trruns':   return dir * (a.trRunsCreated - b.trRunsCreated);
            case 'trplans':  return dir * (a.trPlansCreated - b.trPlansCreated);
            case 'score':    return dir * (a.qaScore - b.qaScore);
            default:         return dir * (a.qaScore - b.qaScore);
        }
    };
    const sorted = [...allRows].sort(cmp);
    const numCell = (val, cls) => val != null
        ? `<td class="py-3 px-4 gh-num tabular-nums ${cls}"><span class="gh-num-block">${val}</span></td>`
        : `<td class="py-3 px-4 gh-num tabular-nums text-slate-600">—</td>`;
    const qaTint = qaMainDisplayTiers();
    tbody.innerHTML = sorted.map((r, i) => {
        const zebra = i % 2 === 0 ? 'gh-leader-row--even' : 'gh-leader-row--odd';
        let scoreClass = 'text-slate-600';
        if (r.qaScore >= qaTint.goodMin) scoreClass = 'text-emerald-600 font-bold';
        else if (r.qaScore >= qaTint.midMin) scoreClass = 'text-amber-600 font-bold';
        const nameKey = escapeHtml(r.name);
        return `<tr class="gh-leader-row border-b transition-colors ${zebra}" data-qa-score-name="${nameKey}" style="cursor:pointer" title="Click to see score breakdown">
            <td class="py-3 px-4 gh-leader-name">${nameKey}</td>
            <td class="py-3 px-4 gh-leader-repos truncate" style="max-width:0" title="${escapeHtml(r.projectNames)}">${escapeHtml(r.projectNames)}</td>
            ${numCell(r.totalPts, 'text-emerald-600 font-bold')}
            ${numCell(r.totalTickets, 'text-cyan-600 font-bold')}
            ${r.confluencePages > 0 ? numCell(r.confluencePages, 'text-orange-600 font-semibold') : numCell(r.confluencePages || 0, 'text-slate-500')}
            ${r.trCasesCreated > 0 ? numCell(r.trCasesCreated, 'text-teal-600 font-bold') : numCell(r.trCasesCreated || 0, 'text-slate-500')}
            ${r.trRunsCreated > 0 ? numCell(r.trRunsCreated, 'text-blue-600 font-bold') : numCell(r.trRunsCreated || 0, 'text-slate-500')}
            ${r.trPlansCreated > 0 ? numCell(r.trPlansCreated, 'text-violet-600 font-bold') : numCell(r.trPlansCreated || 0, 'text-slate-500')}
            <td class="py-3 px-4 gh-num tabular-nums ${scoreClass}"><span class="gh-num-block">${r.qaScore}</span></td>
        </tr>`;
    }).join('');
    updateQaDataSortHeaders();
    bindQaDataSortOnce();
    bindQaScoreRowClickOnce();
}

function updateQaDataSortHeaders() {
    const dashboard = document.getElementById('qaDataDashboard');
    if (!dashboard) return;
    dashboard.querySelectorAll('th.qa-data-sort').forEach(th => {
        const key = th.getAttribute('data-sort');
        th.classList.remove('sort-asc', 'sort-desc');
        if (key === qaDataSortColumn) th.classList.add(qaDataSortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
    });
}

function bindQaDataSortOnce() {
    if (qaDataSortBound) return;
    const dashboard = document.getElementById('qaDataDashboard');
    if (!dashboard) return;
    qaDataSortBound = true;
    dashboard.addEventListener('click', (e) => {
        const th = e.target.closest('th.qa-data-sort');
        if (!th) return;
        const column = th.getAttribute('data-sort');
        if (!column) return;
        if (qaDataSortColumn === column) qaDataSortDirection = qaDataSortDirection === 'asc' ? 'desc' : 'asc';
        else { qaDataSortColumn = column; qaDataSortDirection = column === 'name' || column === 'projects' ? 'asc' : 'desc'; }
        if (lastQaRows) {
            const keys = selectedProjects.size
                ? Array.from(selectedProjects)
                : Object.keys(allProjectData).filter(p => selectedManagers.has('All') || selectedManagers.has(allProjectData[p].manager));
            renderQaLeaderboard(keys);
        }
    });
}

function bindQaScoreRowClickOnce() {
    if (qaScoreRowClickBound) return;
    const tbody = document.getElementById('qaLeaderboardBody');
    if (!tbody) return;
    qaScoreRowClickBound = true;
    tbody.addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-qa-score-name]');
        if (!row) return;
        const nameKey = row.getAttribute('data-qa-score-name');
        if (!nameKey || !lastQaRows) return;
        const found = lastQaRows.find(r => escapeHtml(r.name) === nameKey);
        if (!found || !found.qaBreakdown) return;
        openQaScoreOverlay(found.name, found.qaScore, found.qaBreakdown, found);
    });
}

function formatQaScoreBreakdownHtml(score, breakdown, row) {
    const b = breakdown;
    const W = (b.weights && typeof b.weights === 'object') ? b.weights : qaMainWeights();
    const n   = (v) => (Number(v) || 0).toFixed(1);
    const pts = (v) => (Number(v) || 0).toFixed(2);
    const pct = (v) => `${Math.round(Number(v) * 100)}%`;
    const trTotal = (row.trCasesCreated || 0) + (row.trRunsCreated || 0) + (row.trPlansCreated || 0);
    const actualsBlock = `<div class="mb-3 rounded-lg border border-slate-700 bg-slate-900 p-2.5 text-[10px] text-slate-300">
        <div class="text-[9px] font-black uppercase tracking-wider text-slate-500 mb-2">Your inputs (filtered period)</div>
        <div class="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">QA Story pts</span><span class="text-emerald-300 font-bold tabular-nums">${row.totalPts}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">Tickets verified</span><span class="text-cyan-300 font-bold tabular-nums">${row.totalTickets}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">TR Cases</span><span class="text-teal-300 font-bold tabular-nums">${row.trCasesCreated || 0}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">TR Runs</span><span class="text-blue-300 font-bold tabular-nums">${row.trRunsCreated || 0}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">TR Plans</span><span class="text-violet-300 font-bold tabular-nums">${row.trPlansCreated || 0}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">TR Total</span><span class="text-teal-200 font-bold tabular-nums">${trTotal}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">Confluence pages</span><span class="text-orange-300 font-bold tabular-nums">${row.confluencePages || 0}</span></div>
            <div class="flex justify-between gap-2"><span class="text-slate-500 shrink-0">Projects active</span><span class="text-emerald-200 font-bold tabular-nums">${row.projectCount}</span></div>
        </div>
    </div>`;
    const factors = [
        { label: 'Volume',      sub: 'Total QA story points',                weight: Number(W.VOLUME) || 0,      norm: b.normVolume,      contrib: b.contribVolume,      color: 'bg-emerald-600' },
        { label: 'Coverage',    sub: 'Tickets verified',                      weight: Number(W.COVERAGE) || 0,    norm: b.normCoverage,    contrib: b.contribCoverage,    color: 'bg-cyan-600' },
        { label: 'Complexity',  sub: 'Avg pts/ticket vs top performer',       weight: Number(W.COMPLEXITY) || 0,  norm: b.normComplexity,  contrib: b.contribComplexity,  color: 'bg-violet-600' },
        { label: 'Authorship',  sub: 'TestRail cases + runs + plans created', weight: Number(W.AUTHORSHIP) || 0,  norm: b.normAuthorship,  contrib: b.contribAuthorship,  color: 'bg-teal-600' },
        { label: 'Consistency', sub: 'Projects active / total projects',      weight: Number(W.CONSISTENCY) || 0, norm: b.normConsistency, contrib: b.contribConsistency, color: 'bg-lime-600' },
        { label: 'Docs',        sub: 'Confluence pages created + edited',     weight: Number(W.DOCS) || 0,        norm: b.normDocs,        contrib: b.contribDocs,        color: 'bg-orange-600' },
    ];
    const totalContrib = factors.reduce((s, f) => s + (Number(f.contrib) || 0), 0);
    const seg = (c) => totalContrib <= 0 ? '0' : `${((Number(c) || 0) / totalContrib) * 100}%`;
    const bar = `<div class="flex h-2 w-full rounded overflow-hidden bg-slate-800 ring-1 ring-slate-600" aria-hidden="true">${factors.map(f => `<div class="${f.color} h-full transition-[width]" style="width:${seg(f.contrib)}"></div>`).join('')}</div>`;
    const list = factors.map(f => `<div class="flex justify-between gap-3 border-b border-slate-700 pb-1.5 last:border-0 last:pb-0">
            <div class="min-w-0"><span class="text-slate-200 font-bold">${f.label}</span> <span class="text-slate-500">${pct(f.weight)}</span><div class="text-slate-500 mt-0.5">${f.sub}</div></div>
            <div class="text-right shrink-0 tabular-nums"><span class="text-slate-400">${n(f.norm)}%</span><div class="text-emerald-400 font-bold">+${pts(f.contrib)}</div></div>
        </div>`).join('');
    return `<div class="text-left font-sans">
        ${actualsBlock}
        <div class="text-[11px] font-black uppercase tracking-wider text-slate-400 mb-1.5">QA score breakdown</div>
        <div class="text-[10px] text-slate-500 mb-2">Weighted sum ? <span class="text-slate-200 font-bold">${pts(b.raw10)}</span> / 10 ? rounded <span class="text-white font-black">${score}</span></div>
        <p class="text-[9px] text-slate-600 mb-2">Each +value is weight × normalized factor × 10 (points toward 10).</p>
        <div class="mb-2"><div class="text-[9px] uppercase tracking-wider text-slate-500 mb-1">Distribution of contributions</div>${bar}</div>
        <div class="space-y-2">${list}</div>
    </div>`;
}

function openQaScoreOverlay(name, score, breakdown, row) {
    const overlay = document.getElementById('qaScoreOverlay');
    if (!overlay) return;
    document.getElementById('qaScoreTitle').textContent = name;
    const scoreVal = document.getElementById('qaScoreValue');
    const qaTint = qaMainDisplayTiers();
    let scoreColor = 'text-slate-300';
    if (score >= qaTint.goodMin) scoreColor = 'text-emerald-400';
    else if (score >= qaTint.midMin) scoreColor = 'text-amber-400';
    scoreVal.className = `text-3xl font-black tabular-nums mt-1 ${scoreColor}`;
    scoreVal.textContent = `${score} / 10`;
    document.getElementById('qaScoreBody').innerHTML = formatQaScoreBreakdownHtml(score, breakdown, row);
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('qa-score-active')));
}

function closeQaScoreOverlay() {
    const overlay = document.getElementById('qaScoreOverlay');
    if (!overlay) return;
    overlay.classList.remove('qa-score-active');
    setTimeout(() => overlay.classList.add('hidden'), 300);
}

function updateSprintList() {
    const container = document.getElementById('sprintListDisplay');
    if (!container) return;

    const keys = selectedProjects.size
        ? Array.from(selectedProjects)
        : Object.keys(allProjectData).filter(p => {
            const d = allProjectData[p];
            return selectedManagers.has('All') || selectedManagers.has(d.manager);
        });

    if (!keys.length) { container.innerHTML = ''; return; }

    const lt = isDashboardLightTheme();
    const rowClass = lt
        ? (showActiveSprints
            ? 'border-emerald-200/90 bg-emerald-50/95 shadow-sm hover:border-emerald-400/80 hover:bg-emerald-50 hover:shadow-md'
            : 'border-slate-200/90 bg-white shadow-sm hover:border-indigo-400/80 hover:bg-indigo-50/50 hover:shadow-md')
        : (showActiveSprints
            ? 'text-emerald-400 border-emerald-900/40 bg-emerald-950/20 hover:border-emerald-500/70 hover:bg-emerald-950/40'
            : 'text-slate-400 border-slate-800/40 bg-slate-900/40 hover:border-indigo-500/60 hover:bg-slate-900/70');
    const dotClass = showActiveSprints
        ? (lt ? 'bg-emerald-500' : 'bg-emerald-400')
        : (lt ? 'bg-slate-400' : 'bg-slate-500');
    const nameClass = lt ? 'text-slate-900' : 'text-white';
    const periodClass = lt
        ? (showActiveSprints ? 'text-emerald-700' : 'text-slate-500')
        : (showActiveSprints ? 'text-emerald-400' : 'text-slate-500');
    const arrowClass = lt ? 'text-slate-400 group-hover:text-indigo-500' : 'text-slate-600 group-hover:text-indigo-400';

    container.innerHTML = keys.map(k => {
        const d = allProjectData[k];
        if (!d) return '';
        const period = d.period || '—';
        const href = 'project-detail.html?project=' + encodeURIComponent(k);
        const safeName = String(k).replace(/"/g, '&quot;');
        return `
        <a href="${href}"
           target="_blank" rel="noopener noreferrer"
           class="group flex items-center justify-between py-2 px-3 rounded-xl border ${rowClass} transition-all min-w-0 cursor-pointer no-underline"
           title="Open ${safeName} detail"
           aria-label="Open ${safeName} detail view">
            <div class="flex items-center gap-2 min-w-0 flex-shrink">
                <span class="w-1.5 h-1.5 rounded-full ${dotClass} flex-shrink-0"></span>
                <span class="text-[9px] font-black ${nameClass} uppercase tracking-wider truncate">${k}</span>
            </div>
            <div class="flex items-center gap-2 ml-3 flex-shrink-0">
                <span class="text-[9px] font-bold mono ${periodClass} whitespace-nowrap">${period}</span>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
                     class="h-3 w-3 ${arrowClass} transition-transform group-hover:translate-x-0.5">
                    <polyline points="9 18 15 12 9 6"/>
                </svg>
            </div>
        </a>`;
    }).join('');
}

function pieMetricHasData(m, splits, labels) {
    const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
    if (!labels.length) return false;
    if (m.id === 'piePoints') {
        return labels.some((l) => num(splits[l].points) > 0 || num(splits[l].qaPoints) > 0 || num(splits[l].actualPoints) > 0);
    }
    if (m.id === 'pieCompletion') return labels.some((l) => num(splits[l].completion) > 0);
    if (m.id === 'pieCycle') return labels.some((l) => num(splits[l].cycleTime) > 0);
    if (m.id === 'pieThroughput') return labels.some((l) => num(splits[l].tickets) > 0);
    return false;
}

/**
 * Beyond this project count, the 2-column pie/bar grid gets too cramped
 * (per-bar width shrinks, x-axis labels collide, legend wraps). Stack the
 * cards full-width instead so each chart breathes.
 */
const MAINAREA_STACK_THRESHOLD = 6;

function applyMainareaLayout(projectCount) {
    const mainarea = document.getElementById('mainarea');
    if (!mainarea) return;
    const stack = projectCount > MAINAREA_STACK_THRESHOLD;
    mainarea.classList.toggle('md:grid-cols-2', !stack);
    mainarea.classList.toggle('lg:grid-cols-2', !stack);
    mainarea.classList.toggle('md:grid-cols-1', stack);
    mainarea.dataset.stacked = stack ? '1' : '0';
}

function updatePieCharts(splits) {
    const labels = sortProjectNamesForChart(Object.keys(splits));
    applyMainareaLayout(labels.length);
    const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
    const metrics = [
        { id: 'piePoints',        fn: d => num(d.points) },
        { id: 'pieCompletion',    fn: d => num(d.completion) },
        { id: 'pieCycle',         fn: d => num(d.cycleTime) },

        { id: 'pieThroughput',    fn: d => num(d.tickets) },
    ];

    const ACTUAL_COLORS = PIE_COLORS.map(c => {
        const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, 0.40)`;
    });

    metrics.forEach(m => {
        const canvas = document.getElementById(m.id);
        if (!canvas) return;
        const card = canvas.closest('.card');
        if (!pieMetricHasData(m, splits, labels)) {
            if (pieCharts[m.id]) {
                try { pieCharts[m.id].destroy(); } catch (e) { /* ignore */ }
                pieCharts[m.id] = null;
            }
            if (card) card.classList.add('hidden');
            return;
        }
        if (card) card.classList.remove('hidden');
        if (pieCharts[m.id]) pieCharts[m.id].destroy();

        const pb = portfolioBarChartTheme();
        const ttBar = chartTooltipTheme();
        const fontMono = "'JetBrains Mono', ui-monospace, monospace";
        const barDensity = { categoryPercentage: 0.72, barPercentage: 0.82 };

        const isPiePoints = m.id === 'piePoints';
        const hasActuals = isPiePoints && labels.some(l => num(splits[l].actualPoints) > 0);
        const hasQaData = isPiePoints && labels.some(l => num(splits[l].qaPoints) > 0);
        let datasets, legendDisplay, chartOptions;

        if (isPiePoints && hasQaData) {
            const devColor = '#3b82f6';
            const qaColor  = '#10b981';
            datasets = [
                {
                    label: 'Dev',
                    data: labels.map(l => {
                        const total = num(splits[l].points);
                        const qa = num(splits[l].qaPoints);
                        return Math.max(0, total - qa);
                    }),
                    backgroundColor: devColor,
                    stack: 'sp',
                    borderRadius: { topLeft: 0, topRight: 0, bottomLeft: 6, bottomRight: 6 },
                    borderWidth: 0
                },
                {
                    label: 'QA',
                    data: labels.map(l => num(splits[l].qaPoints)),
                    backgroundColor: qaColor,
                    stack: 'sp',
                    borderRadius: { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 },
                    borderWidth: 0
                }
            ];
            if (hasActuals) {
                datasets.push({
                    label: 'Actual',
                    data: labels.map(l => num(splits[l].actualPoints)),
                    backgroundColor: 'rgba(59,130,246,0.30)',
                    stack: 'actual',
                    borderRadius: 6, borderWidth: 0,
                    borderDash: [4, 2]
                });
            }
            legendDisplay = true;
            const legendColors = { 'Dev': devColor, 'QA': qaColor, 'Actual': 'rgba(59,130,246,0.30)' };
            const lightActualLegendStroke = isDashboardLightTheme();
            chartOptions = {
                responsive: true, maintainAspectRatio: false,
                layout: { padding: { left: 10, right: 10, top: 8, bottom: 22 } },
                datasets: { bar: barDensity },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        align: 'center',
                        labels: {
                            color: pb.legend,
                            font: { size: 10, weight: '600', family: fontMono },
                            boxWidth: 12,
                            boxHeight: 8,
                            padding: 14,
                            generateLabels: (chart) => chart.data.datasets.map((ds, idx) => ({
                                text: ds.label,
                                fontColor: pb.legendItem,
                                color: pb.legendItem,
                                fillStyle: legendColors[ds.label] || PIE_COLORS[idx % PIE_COLORS.length],
                                strokeStyle: (lightActualLegendStroke && ds.label === 'Actual') ? 'rgba(59,130,246,0.55)' : 'transparent',
                                lineWidth: (lightActualLegendStroke && ds.label === 'Actual') ? 1 : 0,
                                datasetIndex: idx
                            }))
                        }
                    },
                    tooltip: {
                        ...ttBar,
                        borderWidth: 1,
                        padding: 10,
                        cornerRadius: 10,
                        callbacks: { afterBody: (ctx) => {
                            if (!ctx.length) return '';
                            const idx = ctx[0].dataIndex;
                            const lbl = labels[idx];
                            const d = splits[lbl];
                            const total = num(d.points);
                            const qa = num(d.qaPoints);
                            const dev = Math.max(0, total - qa);
                            const devPct = total > 0 ? Math.round((dev / total) * 100) : 0;
                            const qaPct = total > 0 ? Math.round((qa / total) * 100) : 0;
                            return `Total: ${total}  (Dev ${devPct}% · QA ${qaPct}%)`;
                        }}
                    }
                },
                scales: {
                    x: {
                        stacked: true,
                        ticks: {
                            color: pb.tickX,
                            maxRotation: 35,
                            minRotation: 18,
                            autoSkip: true,
                            font: { size: 10, weight: '600', family: fontMono },
                            padding: 6,
                        },
                        grid: { display: false },
                        border: { display: true, color: pb.axisLine },
                    },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        ticks: { color: pb.tickY, font: { size: 10, weight: '600', family: fontMono }, padding: 8 },
                        grid: { color: pb.grid, lineWidth: 1 },
                        border: { display: true, color: pb.axisLine },
                    },
                },
            };
        } else if (isPiePoints && hasActuals) {
            datasets = [
                {
                    label: 'Estimated',
                    data: labels.map(l => m.fn(splits[l])),
                    backgroundColor: labels.map((_, i) => PIE_COLORS[i % PIE_COLORS.length]),
                    borderRadius: 6, borderWidth: 0
                },
                {
                    label: 'Actual',
                    data: labels.map(l => num(splits[l].actualPoints)),
                    backgroundColor: labels.map((_, i) => ACTUAL_COLORS[i % ACTUAL_COLORS.length]),
                    borderRadius: 6, borderWidth: 0,
                    borderDash: [4, 2]
                }
            ];
            legendDisplay = true;
            chartOptions = null;
        } else {
            datasets = [{ data: labels.map(l => m.fn(splits[l])), backgroundColor: labels.map((_, i) => PIE_COLORS[i % PIE_COLORS.length]), borderRadius: 6, borderWidth: 0 }];
            legendDisplay = false;
            chartOptions = null;
        }

        const defaultOptions = {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { left: 10, right: 10, top: 6, bottom: 20 } },
            datasets: { bar: barDensity },
            plugins: {
                legend: {
                    display: legendDisplay,
                    position: 'top',
                    align: 'center',
                    labels: {
                        color: pb.legend,
                        font: { size: 10, weight: '600', family: fontMono },
                        boxWidth: 12, boxHeight: 8, padding: 14,
                        usePointStyle: false,
                        generateLabels: legendDisplay && !chartOptions ? (chart) => {
                            return chart.data.datasets.map((ds, idx) => ({
                                text: ds.label,
                                fontColor: pb.legendItem,
                                color: pb.legendItem,
                                fillStyle: idx === 0 ? '#3b82f6' : 'rgba(59,130,246,0.40)',
                                strokeStyle: (isDashboardLightTheme() && idx === 1) ? 'rgba(59,130,246,0.55)' : 'transparent',
                                lineWidth: (isDashboardLightTheme() && idx === 1) ? 1 : 0,
                                datasetIndex: idx
                            }));
                        } : undefined
                    }
                },
                tooltip: {
                    ...ttBar,
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 10,
                },
            },
            scales: {
                x: {
                    ticks: {
                        color: pb.tickX,
                        maxRotation: 35,
                        minRotation: 18,
                        autoSkip: true,
                        font: { size: 10, weight: '600', family: fontMono },
                        padding: 6,
                    },
                    grid: { display: false },
                    border: { display: true, color: pb.axisLine },
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: pb.tickY, font: { size: 10, weight: '600', family: fontMono }, padding: 8 },
                    grid: { color: pb.grid, lineWidth: 1 },
                    border: { display: true, color: pb.axisLine },
                },
            },
        };

        pieCharts[m.id] = new Chart(canvas, {
            type: 'bar',
            data: { labels, datasets },
            options: chartOptions || defaultOptions
        });
        if (window.ChartZoom) window.ChartZoom.enable(pieCharts[m.id], { title: (typeof PIE_TITLES !== 'undefined' && PIE_TITLES[m.id]) || m.id, eyebrow: 'Per Project' });
        if (card) {
            card.onclick = null;
            card.style.cursor = '';
        }
    });
}



// ----------------------------
// Pie Chart Zoom
// ----------------------------
function openPieZoom(id, labels, values, customTitle) {
    const pb = portfolioBarChartTheme();
    const ttBar = chartTooltipTheme();
    const overlay = document.getElementById('pieZoomOverlay');
    document.getElementById('pieZoomTitle').innerText = customTitle != null ? customTitle : (PIE_TITLES[id] || id);

    // Build legend
    const legend = document.getElementById('pieZoomLegend');
    const total = values.reduce((a, b) => a + (b || 0), 0);
    legend.innerHTML = labels.map((lbl, i) => {
        const val = values[i] || 0;
        const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0.0';
        return `<div class="flex items-center justify-between gap-3 text-[11px]">
            <div class="flex items-center gap-2 min-w-0">
                <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></span>
                <span class="text-slate-300 font-bold truncate">${lbl}</span>
            </div>
            <span class="text-slate-400 font-mono flex-shrink-0">${val} <span class="text-slate-600">(${pct}%)</span></span>
        </div>`;
    }).join('');

    // Destroy previous zoom chart
    if (pieZoomChart) { pieZoomChart.destroy(); pieZoomChart = null; }
    const zoomCanvas = document.getElementById('pieZoomCanvas');
    pieZoomChart = new Chart(zoomCanvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [{ data: values, backgroundColor: labels.map((_, i) => PIE_COLORS[i % PIE_COLORS.length]), borderRadius: 8, borderWidth: 0 }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { left: 4, right: 12, top: 8, bottom: 22 } },
            animation: { duration: 600, easing: 'easeOutQuart' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...ttBar,
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 10,
                    callbacks: {
                        label: ctx => {
                            const t = ctx.parsed;
                            const tot = ctx.dataset.data.reduce((a, b) => a + (b || 0), 0);
                            return ` ${ctx.label}: ${t} (${tot > 0 ? ((t / tot) * 100).toFixed(1) : 0}%)`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: pb.tickX,
                        maxRotation: 35,
                        minRotation: 18,
                        autoSkip: true,
                        font: { size: 10, weight: '600' },
                        padding: 4,
                    },
                    grid: { display: false },
                    border: { display: true, color: pb.axisLine },
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: pb.tickY, font: { size: 10, weight: '600' } },
                    grid: { color: pb.grid },
                    border: { display: true, color: pb.axisLine },
                },
            },
        }
    });

    // Show overlay with spring animation
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => overlay.classList.add('pie-zoom-active'));
    });
}

function closePieZoom() {
    const overlay = document.getElementById('pieZoomOverlay');
    overlay.classList.remove('pie-zoom-active');
    setTimeout(() => overlay.classList.add('hidden'), 400);
}

function handlePieOverlayClick(e) {
    if (e.target === document.getElementById('pieZoomOverlay') || e.target === e.currentTarget.querySelector('::before')) {
        closePieZoom();
    }
    // Close when clicking the backdrop (anything outside the card)
    if (!document.getElementById('pieZoomCard').contains(e.target)) {
        closePieZoom();
    }
}

// ----------------------------
// Org-Level AI Summary
// ----------------------------
async function generateOrgAISummary() {
    const responseDiv = document.getElementById('orgAiResponse');
    const statusContainer = document.getElementById('orgAiStatusContainer');
    const spinner = document.getElementById('orgAiSpinner');
    const statusText = document.getElementById('orgAiStatusText');
    const btn = document.getElementById('generateOrgAiBtn');
    const model = document.getElementById('orgModelSelector')?.value || 'anthropic/claude-sonnet-4.6';

    // Collect currently visible projects
    const keys = selectedProjects.size
        ? Array.from(selectedProjects)
        : Object.keys(allProjectData).filter(p => {
            const d = allProjectData[p];
            return selectedManagers.has('All') || selectedManagers.has(d.manager);
        });

    if (!keys.length) {
        responseDiv.innerHTML = '<span class="text-amber-400 font-bold">No projects visible — apply filters first.</span>';
        return;
    }

    // Show spinner, disable button
    statusContainer.classList.remove('hidden');
    statusContainer.classList.add('flex');
    statusText.innerText = 'Analyzing ' + keys.length + ' project(s)...';
    statusText.className = 'text-[9px] font-bold text-slate-500 uppercase tracking-widest';
    spinner.classList.remove('hidden');
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
    responseDiv.innerHTML = '<span class="italic text-slate-600">Sending data to AI...</span>';

    const ADC = typeof AiDevToolsContext !== 'undefined' ? AiDevToolsContext : null;
    const orgDevTools = ADC ? {
        copilot_org: ADC.getCopilotOrgSnapshot(copilotDataInMemory),
        copilot_user_leaderboard: ADC.getCopilotUserLeaderboardSnapshot ? ADC.getCopilotUserLeaderboardSnapshot(copilotDataInMemory) : null,
        cursor_org: ADC.buildCursorOrgSnapshot(cursorDataInMemory)
    } : { copilot_org: null, copilot_user_leaderboard: null, cursor_org: null };

    // Build project payload (JIRA sprint row + GitHub 2.3 + Cursor signals per project)
    const projectPayload = keys.map(k => {
        const d = allProjectData[k];
        if (!d) return null;
        const teamNames = (d.individuals || []).map(i => i.name).filter(Boolean);
        const base = {
            project: k,
            parent: d.parent || 'Independent',
            manager: d.manager || 'N/A',
            period: d.period || 'N/A',
            status: d.status || 'N/A',
            story_points_completed: d.points || 0,
            tickets_closed: d.tickets || 0,
            sprint_completion_pct: (d.completion || 0) + '%',
            prev_completion_pct: (d.lastCompletion || 0) + '%',
            bugs_opened: d.bugsOpened || 0,
            bugs_closed: d.bugsClosed || 0,
            bug_fix_rate: (Number(d.bugsOpened) > 0 && Number.isFinite(Number(d.bugsClosed))) ? Math.round((d.bugsClosed / d.bugsOpened) * 100) + '%' : 'N/A',
            defect_density: d.points > 0 ? parseFloat(((d.bugsOpened || 0) / d.points).toFixed(2)) : 0,
            carry_over_pct: (d.carryOver || 0) + '%',
            avg_cycle_time_days: d.cycleTime || 0,
            blockers: d.blockers || 0,
            team_ai_adoption_ratings_1_to_5: (d.individuals || []).map(i => ({ name: i.name, story_points: i.pts || 0, ai_rating: i.ai != null ? i.ai : null })),
            anomalies: (d.anomalies || []).filter(a => a.what && a.what.trim().length > 2 && a.what !== '—' && a.what !== '-').map(a => ({ what: a.what, severity: a.severity, owner: a.owner }))
        };
        if (ADC) {
            const ghRows = ADC.compactGithubMetrics(d.githubMetrics, 14);
            base.github_team = ghRows;
            base.github_team_totals = ADC.aggregateGithubTeamTotals(d.githubMetrics || []);
            base.cursor_vs_project = ADC.buildCursorProjectSignals(k, cursorDataInMemory, teamNames);
        }
        return base;
    }).filter(Boolean);

    try {
        const response = await fetch('/api/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
                model,
                temperature: 0.15,
                seed: 42,
                messages: [
                    {
                        role: 'system',
                        content: `You are a senior engineering director writing a crisp executive sprint summary for ${keys.length} project(s).

OUTPUT FORMAT — strictly follow every rule:
- Exactly 6 bullet points, each a single sentence of = 25 words.
- Start each bullet with a dash (-). No sub-bullets, no lists inside bullets.
- Cover in order: (1) overall velocity, (2) quality, (3) predictability, (4) top performer(s), (5) project(s) needing attention, (6) one recommendation.
- Name specific projects only when directly supported by the data.

NUMBER RULES — critical:
- Never paste raw JSON field names or JSON values verbatim.
- Round all percentages to the nearest whole number (e.g. 66%, not 65.8%).
- Round decimals to 1 significant figure max (e.g. 0.3, not 0.2950).
- Express counts as round numbers where precision is not meaningful.
- Always attach a unit/label to every number (e.g. "66% completion", "12 bugs", "3.2-day cycle time").

STYLING RULES (strictly follow, use double quotes for class attributes):
- Positive / on-track phrases: <span class="text-emerald-600 font-bold">text</span>
- Moderate concern phrases: <span class="text-amber-600 font-bold">text</span>
- Red flag / risk phrases: <span class="text-red-600 font-bold">text</span>
- Project names: <span class="text-violet-700 font-bold">Project Name</span>
- Key numbers (with their label): <span class="text-blue-600 font-mono">66%</span>
- NO asterisks, NO markdown, NO HTML outside the spans above.`
                    },
                    {
                        role: 'user',
                        content: `Org sprint data (${keys.length} projects, sprint view: ${showActiveSprints ? 'Active' : 'Latest Closed'}):\n${JSON.stringify({ org_dev_tools: orgDevTools, projects: projectPayload }, null, 2)}`
                    }
                ]
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            const msg = err?.error?.message ?? err?.error ?? (typeof err?.message === 'string' ? err.message : 'Unknown error');
            responseDiv.innerHTML = `<span class="text-red-500 font-bold">API Error ${response.status}: ${msg}</span>`;
            return;
        }

        const data = await response.json();
        const summary = data.choices?.[0]?.message?.content || 'No response received.';

        (typeWriter || function (t, el) { el.innerHTML = (t || '').replace(/\*/g, '').replace(/\n/g, '<br>'); })(summary, responseDiv, 5, () => {
            spinner.classList.add('hidden');
            statusText.innerText = 'Analysis Complete';
            statusText.className = 'text-[9px] font-bold text-emerald-500 uppercase tracking-widest';
        });

    } catch (err) {
        console.error('Org AI Error:', err);
        responseDiv.innerHTML = `<span class="text-red-500 font-bold">Network error: ${err.message}</span>`;
    } finally {
        btn.disabled = false;
        btn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
}

/**
 * Normalize GitHub API copilot metrics row to UI shape.
 * API has date, copilot_ide_chat (editors/models), copilot_ide_code_completions (editors/models/languages).
 */
function normalizeCopilotApiRow(row) {
    if (!row || typeof row !== 'object') return null;
    const day = row.day || row.date;
    if (!day) return null;
    // Already template/legacy shape: has copilot_chat with user counts (not API which has top-level total_active_users only)
    const chat = row.copilot_chat;
    if (chat && (chat.total_active_users != null || chat.total_chats != null) && row.copilot_ide_code_completions) {
        return { day, copilot_chat: chat, copilot_ide_code_completions: row.copilot_ide_code_completions };
    }
    let totalChats = 0;
    const ideChat = row.copilot_ide_chat;
    if (ideChat && Array.isArray(ideChat.editors)) {
        for (const ed of ideChat.editors) {
            if (ed.models) for (const m of ed.models) totalChats += Number(m.total_chats) || 0;
        }
    }
    const dotcomChat = row.copilot_dotcom_chat;
    if (dotcomChat && Array.isArray(dotcomChat.models)) {
        for (const m of dotcomChat.models) totalChats += Number(m.total_chats) || 0;
    }
    let totalAccepted = 0, totalSuggested = 0;
    const langMap = {};
    const code = row.copilot_ide_code_completions;
    if (code && Array.isArray(code.editors)) {
        for (const ed of code.editors) {
            if (!ed.models) continue;
            for (const m of ed.models) {
                if (!Array.isArray(m.languages)) continue;
                for (const lang of m.languages) {
                    const name = (lang.name || '').trim() || 'Other';
                    const acc = Number(lang.total_code_lines_accepted) || 0;
                    const sug = Number(lang.total_code_lines_suggested) || 0;
                    totalAccepted += acc;
                    totalSuggested += sug;
                    langMap[name] = (langMap[name] || 0) + acc;
                }
            }
        }
    }
    const languages = Object.entries(langMap).map(([name, total_code_lines_accepted]) => ({ name, total_code_lines_accepted }));
    return {
        day,
        copilot_chat: {
            total_active_users: row.total_active_users,
            total_engaged_users: row.total_engaged_users,
            total_chats: totalChats
        },
        copilot_ide_code_completions: {
            total_code_lines_accepted: totalAccepted,
            total_code_lines_suggested: totalSuggested,
            languages
        }
    };
}

/** Filter rows to last N days (by day/date) and aggregate into one UI row. */
function getCopilotAggregateForLastNDays(rows, days) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    let filtered = rows.filter(r => {
        const d = r.day || r.date;
        return d && String(d).slice(0, 10) >= cutoffStr;
    });
    if (filtered.length === 0) filtered = rows;
    const agg = {
        day: null,
        copilot_chat: { total_active_users: 0, total_engaged_users: 0, total_chats: 0 },
        copilot_ide_code_completions: { total_code_lines_accepted: 0, total_code_lines_suggested: 0, languages: [] }
    };
    const langMap = {};
    for (const r of filtered) {
        const c = r.copilot_chat || {};
        const code = r.copilot_ide_code_completions || {};
        agg.copilot_chat.total_chats += Number(c.total_chats) || 0;
        const active = Number(c.total_active_users);
        const engaged = Number(c.total_engaged_users);
        if (Number.isFinite(active)) agg.copilot_chat.total_active_users = Math.max(agg.copilot_chat.total_active_users, active);
        if (Number.isFinite(engaged)) agg.copilot_chat.total_engaged_users = Math.max(agg.copilot_chat.total_engaged_users, engaged);
        agg.copilot_ide_code_completions.total_code_lines_accepted += Number(code.total_code_lines_accepted) || 0;
        agg.copilot_ide_code_completions.total_code_lines_suggested += Number(code.total_code_lines_suggested) || 0;
        for (const l of code.languages || []) {
            const name = (l.name || '').trim() || 'Other';
            langMap[name] = (langMap[name] || 0) + (Number(l.total_code_lines_accepted) || 0);
        }
    }
    agg.copilot_ide_code_completions.languages = Object.entries(langMap).map(([name, total_code_lines_accepted]) => ({ name, total_code_lines_accepted }));
    agg.periodLabel = days === 30 ? 'Last 30 days' : `Last ${days} days`;
    return agg;
}

function renderCopilotSection(row) {
    const container = document.getElementById('aiDevToolsPanel');
    if (!container || !row) return;
    const chat = row.copilot_chat || {};
    const code = row.copilot_ide_code_completions || {};
    const languages = code.languages || [];
    const setEl = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text ?? '—'; };
    const activeUsers = Number(chat.total_active_users);
    const engagedUsers = Number(chat.total_engaged_users);
    setEl('copilotChatActive', Number.isFinite(activeUsers) ? activeUsers : '—');
    setEl('copilotChatEngaged', Number.isFinite(engagedUsers) ? engagedUsers : '—');
    setEl('copilotTotalChats', chat.total_chats);
    setEl('copilotLinesAccepted', code.total_code_lines_accepted != null ? code.total_code_lines_accepted.toLocaleString() : '—');
    setEl('copilotLinesSuggested', code.total_code_lines_suggested != null ? code.total_code_lines_suggested.toLocaleString() : '—');
    const canvas = document.getElementById('copilotLanguagePie');
    if (canvas && languages.length > 0) {
        if (copilotLanguageChart) { copilotLanguageChart.destroy(); copilotLanguageChart = null; }
        const total = languages.reduce((sum, l) => sum + (Number(l.total_code_lines_accepted) || 0), 0);
        const rawLabels = languages.map(l => (l.name || '').trim() || 'Other');
        const rawData = total > 0 ? languages.map(l => (Number(l.total_code_lines_accepted) || 0) / total * 100) : languages.map(() => 0);
        const entries = rawLabels.map((l, i) => [l, rawData[i]]);
        const { labels, data } = collapsePieUnderThreshold(entries);
        copilotLanguageChart = new Chart(canvas, {
            type: 'doughnut',
            data: {
                labels,
                datasets: [{
                    data,
                    backgroundColor: PIE_COLORS.slice(0, labels.length),
                    borderColor: chartPieDoughnutBorder(),
                    borderWidth: 2,
                    hoverOffset: 10,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                cutout: '58%',
                onClick: () => openPieZoom('copilotLanguagePie', labels, data, 'Copilot — Code language share'),
                layout: { padding: { top: 4, bottom: 4 } },
                animation: { animateRotate: true, duration: 500 },
                plugins: {
                    legend: { display: true, position: 'bottom', labels: { color: chartPluginMutedColor(), font: { size: 10, weight: '600' }, padding: 12, usePointStyle: true } },
                    title: { display: true, text: 'Code language share (accepted)', color: chartPluginMutedColor(), font: { size: 11, weight: '600' } },
                    tooltip: {
                        ...chartTooltipTheme(),
                        borderWidth: 1,
                        padding: 10,
                        cornerRadius: 10,
                        callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed?.toFixed(1) ?? 0}%` },
                    },
                }
            }
        });
        const copilotPieWrap = canvas.closest('div');
        if (copilotPieWrap) { copilotPieWrap.style.cursor = 'pointer'; copilotPieWrap.title = 'Click to zoom'; }
    } else if (canvas && copilotLanguageChart) {
        copilotLanguageChart.destroy();
        copilotLanguageChart = null;
    }
    const periodEl = document.getElementById('copilotPeriodLabel');
    const lastSyncEl = document.getElementById('copilotLastSync');
    if (periodEl) periodEl.textContent = 'Last 30 days';
    if (lastSyncEl) lastSyncEl.textContent = (document.getElementById('liveClock')?.innerText?.replace(/^Last sync:\s*/i, '').trim()) || '—';
    container.classList.remove('hidden');
    document.getElementById('aiAssistantSection')?.classList.remove('hidden');
}

/**
 * Extract the enterprise aggregate array from the possibly-wrapped copilotdata.json.
 * New shape: { enterprise: [...], userLeaderboard: [...] }
 * Old shape: [ ...enterprise day rows... ]
 */
function extractCopilotEnterpriseRows(raw) {
    if (!raw) return null;
    if (Array.isArray(raw)) return raw;
    if (raw.enterprise && Array.isArray(raw.enterprise)) return raw.enterprise;
    return null;
}

function extractCopilotUserLeaderboard(raw) {
    if (!raw) return null;
    if (raw.userLeaderboard && Array.isArray(raw.userLeaderboard)) return raw.userLeaderboard;
    return null;
}

function renderCopilotUserLeaderboard(users) {
    const tbody = document.getElementById('copilotLeaderboardBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!users || users.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="7" class="py-4 px-3 text-center text-slate-500 text-xs uppercase">No user-level data (requires "Copilot usage metrics" policy enabled for the enterprise)</td>';
        tbody.appendChild(row);
        return;
    }
    users.forEach((u, i) => {
        const login = escapeHtml(u.user_login || '');
        const linesAcc = u.lines_accepted != null ? Number(u.lines_accepted).toLocaleString() : '—';
        const linesSug = u.lines_suggested != null ? Number(u.lines_suggested).toLocaleString() : '—';
        const acc = u.acceptance_rate != null ? (Math.round(u.acceptance_rate * 100) + '%') : '—';
        const days = u.active_days != null ? u.active_days : '—';
        const features = [
            u.used_chat ? 'Chat' : null,
            u.used_agent ? 'Agent' : null,
            u.used_cli ? 'CLI' : null,
            'Completions',
        ].filter(Boolean);
        const featureBadges = features.map(f => {
            const c = f === 'Chat' ? 'bg-blue-500/20 text-blue-300' : f === 'Agent' ? 'bg-purple-500/20 text-purple-300' : f === 'CLI' ? 'bg-orange-500/20 text-orange-300' : 'bg-teal-500/20 text-teal-300';
            return `<span class="inline-block text-[9px] font-bold px-1.5 py-0.5 rounded ${c}">${f}</span>`;
        }).join(' ');
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-700/30 hover:bg-slate-800/30';
        row.innerHTML = `<td class="py-2 px-3 text-xs text-slate-400">${i + 1}</td><td class="py-2 px-3 text-xs text-white font-medium">${login}</td><td class="py-2 px-3 text-xs text-right text-emerald-400">${linesAcc}</td><td class="py-2 px-3 text-xs text-right text-slate-300">${linesSug}</td><td class="py-2 px-3 text-xs text-right text-slate-300">${acc}</td><td class="py-2 px-3 text-xs text-right text-slate-400">${days}</td><td class="py-2 px-3 text-xs text-right">${featureBadges}</td>`;
        tbody.appendChild(row);
    });
}

async function loadCopilotDashboard() {
    const container = document.getElementById('aiDevToolsPanel');
    if (!container) return;
    const errorBanner = document.getElementById('copilotErrorBanner');
    const errorMsg = document.getElementById('copilotErrorMsg');
    const statsGrid = document.getElementById('copilotStatsGrid');

    const showError = (msg) => {
        if (errorBanner) errorBanner.classList.remove('hidden');
        if (errorMsg) errorMsg.textContent = msg;
        if (statsGrid) statsGrid.classList.add('hidden');
    };

    let raw = copilotDataInMemory != null ? copilotDataInMemory : null;
    if (!raw) {
        try {
            const res = await fetch('./output/copilotdata.json');
            if (res.ok) raw = JSON.parse(await res.text());
        } catch (e) { /* ignore */ }
    }
    if (!raw) return;

    if (!Array.isArray(raw) && raw.error) {
        const status = raw.status;
        if (status === 403) {
            showError('Insufficient permissions — the GitHub token is missing the manage_billing:copilot scope or the account is not an org owner / billing manager.');
        } else if (status === 401) {
            showError('GitHub token expired or invalid — please generate a new token and update COPILOT_TOKEN in Product/.env.');
        } else {
            showError(`Copilot data unavailable (${raw.error}).`);
        }
        return;
    }

    document.getElementById('aiAssistantSection')?.classList.remove('hidden');

    copilotUserLeaderboard = extractCopilotUserLeaderboard(raw);
    renderCopilotUserLeaderboard(copilotUserLeaderboard);

    let arr = extractCopilotEnterpriseRows(raw);
    if (!arr || arr.length === 0) return;
    if (!Array.isArray(arr)) arr = [arr];
    const isApiShape = arr.length > 0 && arr[0].date && (arr[0].copilot_ide_chat != null || arr[0].copilot_ide_code_completions != null);
    copilotNormalizedRows = isApiShape ? arr.map(normalizeCopilotApiRow).filter(Boolean) : arr.map(r => ({ day: r.day || r.date, copilot_chat: r.copilot_chat || {}, copilot_ide_code_completions: r.copilot_ide_code_completions || {} }));
    if (copilotNormalizedRows.length === 0) return;
    const agg = getCopilotAggregateForLastNDays(copilotNormalizedRows, 30);
    renderCopilotSection(agg);
}

async function loadStageDwellChart() {
    const section = document.getElementById('stageDwellSection');
    const noDataEl = document.getElementById('stageDwellNoData');
    const canvas = document.getElementById('stageDwellChart');
    if (!section || !canvas) return;

    let data = null;
    try {
        const res = await fetch('./output/stagedwelldata.json');
        if (res.ok) data = await res.json();
    } catch (e) { /* non-fatal */ }

    if (!data || !Array.isArray(data.avgDwellByStage) || data.avgDwellByStage.length === 0) {
        if (stageDwellChart) {
            try { stageDwellChart.destroy(); } catch (e) { /* ignore */ }
            stageDwellChart = null;
        }
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    if (noDataEl) noDataEl.classList.add('hidden');
    canvas.style.display = '';

    const ticketCountEl = document.getElementById('stageDwellTicketCount');
    if (ticketCountEl && data.totalTickets != null) {
        const dwellNote = data.ticketsWithDwellData != null && data.ticketsWithDwellData < data.totalTickets
            ? ` (${data.ticketsWithDwellData} with stage transitions)`
            : '';
        ticketCountEl.textContent = `${data.totalTickets.toLocaleString()} tickets${dwellNote}`;
    }

    // Canonical JIRA workflow order (matches the board configuration screenshot)
    const CANONICAL_ORDER = [
        'ready for dev',
        'in dev',
        'ready for review',
        'in review',
        'ready for qa',
        'in qa',
        'ready for staging',
        'staging',
        'ready for release',
    ];
    const canonicalRank = (stageName) => {
        const idx = CANONICAL_ORDER.indexOf((stageName || '').toLowerCase().trim());
        return idx >= 0 ? idx : CANONICAL_ORDER.length;
    };

    const filtered = data.avgDwellByStage
        .filter(s => s.avgDays > 0 && canonicalRank(s.stage) < CANONICAL_ORDER.length)
        .sort((a, b) => canonicalRank(a.stage) - canonicalRank(b.stage));

    if (filtered.length === 0) {
        if (stageDwellChart) {
            try { stageDwellChart.destroy(); } catch (e) { /* ignore */ }
            stageDwellChart = null;
        }
        section.classList.add('hidden');
        return;
    }
    const stages = filtered.map(s => s.stage);
    const avgDays = filtered.map(s => s.avgDays);
    const maxDays = Math.max(...avgDays, 0.1);

    // Generate per-bar colours spanning violet ? indigo ? cyan
    const barColors = stages.map((_, i) => {
        const t = stages.length > 1 ? i / (stages.length - 1) : 0;
        const h = Math.round(270 - t * 80);   // 270 (violet) ? 190 (cyan)
        const s2 = 70, l = 62;
        return `hsla(${h},${s2}%,${l}%,0.82)`;
    });
    const borderColors = barColors.map(c => c.replace('0.82)', '1)'));

    if (stageDwellChart) { stageDwellChart.destroy(); stageDwellChart = null; }

    const pb = portfolioBarChartTheme();
    const stTip = chartTooltipTheme();

    stageDwellChart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: stages,
            datasets: [{
                label: 'Avg Days',
                data: avgDays,
                backgroundColor: barColors,
                borderColor: borderColors,
                borderWidth: 1.5,
                borderRadius: 8,
                borderSkipped: false,
                hoverBackgroundColor: barColors.map(c => c.replace('0.82)', '1)')),
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 700, easing: 'easeOutQuart' },
            layout: { padding: { top: 4, right: 24, bottom: 4, left: 4 } },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...stTip,
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 10,
                    callbacks: {
                        title: (items) => items[0]?.label || '',
                        label: (ctx) => {
                            const d = filtered[ctx.dataIndex];
                            const days = ctx.parsed.x;
                            const pct = maxDays > 0 ? ((days / maxDays) * 100).toFixed(0) : 0;
                            return [
                                ` Avg: ${days.toFixed(1)} days`,
                                ` Tickets: ${d?.count ?? '—'}`,
                                ` Share of longest: ${pct}%`
                            ];
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: pb.grid, lineWidth: 1 },
                    border: { dash: [4, 4], color: pb.axisLine },
                    ticks: {
                        color: pb.tickY,
                        font: { size: 10, weight: '600', family: "'JetBrains Mono', monospace" },
                        callback: (v) => `${v}d`
                    },
                    title: {
                        display: true,
                        text: 'Average Days at Stage',
                        color: pb.tickY,
                        font: { size: 10, weight: 'bold' },
                        padding: { top: 8 }
                    }
                },
                y: {
                    grid: { display: false },
                    border: { display: false },
                    ticks: {
                        color: pb.tickX,
                        font: { size: 11, weight: '700' },
                        padding: 8
                    }
                }
            }
        }
    });
    if (window.ChartZoom) window.ChartZoom.enable(stageDwellChart, { title: 'Stage Dwell — Average Days at Stage', eyebrow: 'Flow Analysis' });
}


/* -- Loader helpers -- */
function loaderSetProgress(pct, subtitle, file) {
    const fill = document.getElementById('loaderBarFill');
    const sub  = document.getElementById('loaderSubtitle');
    const fi   = document.getElementById('loaderFile');
    if (fill) fill.style.width = Math.min(100, Math.round(pct)) + '%';
    if (sub  && subtitle) sub.textContent  = subtitle;
    if (fi) fi.textContent = file || '\u00a0';
}
function loaderHide() {
    const el = document.getElementById('loadingOverlay');
    if (el) el.classList.add('loader-hidden');
}

async function autoLoadData() {
    loaderSetProgress(2, 'Connecting…', '');
    try {
        if (typeof fetchDashboardScoring === 'function') {
            try {
                await fetchDashboardScoring();
            } catch (e) {
                console.warn('[dashboard-scoring]', e.message || e);
            }
        }
        refreshHealthScoringUIFromServer();
        const listResponse = await fetch('./output/files.json');
        if (!listResponse.ok) throw new Error();
        const listData = await listResponse.json();
        const fileNames = Array.isArray(listData) ? listData : (listData.files || []);
        try {
            await loadIdcEmployeeNames();
        } catch (e) { /* ignore */ }
        projectHistory = {}; const uniqueManagers = new Set();
        let dataAtCandidates = [];

        // MD files occupy 0–65% of the progress bar
        const mdShare = 65;
        const total = fileNames.length || 1;
        for (let i = 0; i < fileNames.length; i++) {
            const fileName = fileNames[i];
            loaderSetProgress(
                2 + Math.round((i / total) * mdShare),
                `Loading sprint data… (${i + 1}/${total})`,
                fileName
            );
            const response = await fetch(`./output/${fileName}`);
            if (!response.ok) continue;
            const text = await response.text();
            const dataAtStr = text.match(/\*\*DataAt:\*\*\s*(.+?)(?:\n|$)/)?.[1]?.trim();
            if (dataAtStr) dataAtCandidates.push({ str: dataAtStr, date: parseDataAtDisplay(dataAtStr) });
            const product = text.match(/\*{0,2}Product:\*{0,2}\s*(.*?)\s*\*{0,2}\s*$/m)?.[1]?.trim() || fileName.replace('.md', '');
            const parent = text.match(/\*{0,2}Parent:\*{0,2}\s*(.*?)\s*\*{0,2}\s*$/m)?.[1]?.trim() || "Independent";
            const manager = text.match(/\*{0,2}Manager:\*{0,2}\s*(.*?)\s*\*{0,2}\s*$/m)?.[1]?.trim() || "N/A";
            const boardType = (text.match(/\*\*Board:\*\*\s*(.*)/)?.[1]?.trim() || 'Sprint').toLowerCase() === 'kanban' ? 'Kanban' : 'Sprint';
            const period = text.match(/\*\*(?:Period|Sprint name):\*\*\s*(.*)/i)?.[1]?.trim() || '';
            const data = (typeof parseMD === 'function' ? parseMD : function () { return {}; })(text);
			
			const projectInfo = { ...data, parent, name: product, manager, period, boardType };
			if (!projectHistory[product]) { projectHistory[product] = []; }
			projectHistory[product].push(projectInfo);
            uniqueManagers.add(manager);
        }
        const withDate = dataAtCandidates.filter(x => x.date);
        const latest = withDate.length ? withDate.sort((a, b) => a.date - b.date).pop() : null;
        setLastSyncDisplay(latest ? latest.str : null);

        loaderSetProgress(68, 'Loading Copilot data…', 'copilotdata.json');
        try {
            const copilotRes = await fetch('./output/copilotdata.json');
            if (copilotRes.ok) {
                copilotDataInMemory = await copilotRes.json();
                copilotUserLeaderboard = extractCopilotUserLeaderboard(copilotDataInMemory);
            } else {
                copilotDataInMemory = null;
                copilotUserLeaderboard = null;
            }
        } catch (e) { copilotDataInMemory = null; copilotUserLeaderboard = null; }

        loaderSetProgress(73, 'Loading Cursor data…', 'cursordata.json');
        try {
            const cursorRes = await fetch('./output/cursordata.json');
            if (cursorRes.ok) cursorDataInMemory = await cursorRes.json();
            else cursorDataInMemory = null;
        } catch (e) { cursorDataInMemory = null; }

        loaderSetProgress(77, 'Loading resource directory…', 'resource-directory.json');
        try {
            const rdRes = await fetch('./output/resource-directory.json');
            if (rdRes.ok) {
                const rd = await rdRes.json();
                if (rd && Array.isArray(rd.users)) {
                    knownOrgNamesLower = buildKnownOrgNames(rd.users);
                }
            }
        } catch (e) { knownOrgNamesLower = null; }

        loaderSetProgress(82, 'Building project history…', '');
		localStorage.setItem('allProjectsHistory', JSON.stringify(projectHistory));
        rebuildFromHistory();
	
        if (Object.keys(allProjectData).length > 0) {
            loaderSetProgress(87, 'Rendering dashboard…', '');
            populateManagerDropdown(Array.from(uniqueManagers).sort());
			document.getElementById('filterSection').classList.remove('hidden');
			document.getElementById('mainarea').classList.remove('hidden');
			document.getElementById('aiOrgSection').classList.remove('hidden');
			const rb = document.getElementById('ratingSummaryBar');
			if (rb) rb.classList.remove('hidden');
            updateRatingSummary();
            try {
                refreshUI();
            } catch (refreshErr) {
                console.error('[Dashboard] refreshUI failed:', refreshErr);
            }
        }
        loaderSetProgress(91, 'Loading AI dashboards…', '');
        try {
            await loadCopilotDashboard();
        } catch (e) { /* non-fatal */ }
        try {
            await loadCursorDashboard();
        } catch (e) { /* non-fatal */ }
        loaderSetProgress(95, 'Building leaderboard…', '');
        try {
            renderUnifiedLeaderboard();
        } catch (e) { /* non-fatal */ }
        loaderSetProgress(98, 'Finalising…', '');
        try {
            await loadStageDwellChart();
        } catch (e) { /* non-fatal */ }
        updateIntegrationStatus();
        loaderSetProgress(100, 'Ready', '');
        setTimeout(loaderHide, 400);
    } catch (err) {
        console.error('[Dashboard] autoLoadData failed:', err);
        setLastSyncDisplay(null);
        loaderHide();
        container.innerHTML = '<div class="p-10 border-2 border-dashed border-slate-800 rounded-3xl text-center"><button onclick="document.getElementById(\'folderInput\').click()" class="px-4 py-2 bg-blue-600 text-white rounded-lg text-[10px] font-black uppercase">Sync Folder Data</button></div>';
        updateIntegrationStatus();
    }
}

/**
 * Toggle integration status icons between glow (data available) and dim (no data).
 * Called after all data sources have been attempted in autoLoadData / folder-sync.
 */
function updateIntegrationStatus() {
    var setStatus = function (id, active) {
        var el = document.getElementById(id);
        if (!el) return;
        el.classList.remove('integ-glow', 'integ-dim');
        el.classList.add(active ? 'integ-glow' : 'integ-dim');
    };

    var hasJira = Object.keys(allProjectData).length > 0;
    setStatus('integ-jira', hasJira);

    var hasGithub = false;
    if (hasJira) {
        for (var k in allProjectData) {
            var gm = allProjectData[k].githubMetrics;
            if (Array.isArray(gm) && gm.some(function (r) { return r.prs > 0 || r.commits > 0; })) { hasGithub = true; break; }
        }
    }
    setStatus('integ-github', hasGithub);

    setStatus('integ-copilot', !!(copilotDataInMemory && !copilotDataInMemory.error));
    setStatus('integ-cursor', !!(cursorDataInMemory && !cursorDataInMemory.error));

    var hasConfluence = false;
    if (hasJira) {
        for (var c in allProjectData) {
            var ca = allProjectData[c].confluenceActivity;
            if (Array.isArray(ca) && ca.some(function (r) { return r.pagesCreated > 0 || r.pagesEdited > 0; })) { hasConfluence = true; break; }
        }
    }
    setStatus('integ-confluence', hasConfluence);

    var hasTestRail = false;
    if (hasJira) {
        for (var t in allProjectData) {
            var tr = allProjectData[t].testRailExecution;
            if (tr && (tr.casesCreated > 0 || tr.runsCreated > 0)) { hasTestRail = true; break; }
        }
    }
    setStatus('integ-testrail', hasTestRail);
}

function buildPieChart(canvasId, obj, defaultTitle, colorSlice, othersThresholdPct) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const chart = canvasId === 'cursorModelPie' ? cursorModelChart : canvasId === 'cursorLanguagePie' ? cursorLanguageChart : canvasId === 'cursorIntentPie' ? cursorIntentChart : cursorCategoriesChart;
    if (chart) { chart.destroy(); }
    const rawEntries = obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.entries(obj).filter(([, v]) => Number(v) > 0) : [];
    const threshold = canvasId === 'cursorLanguagePie' ? (othersThresholdPct != null ? othersThresholdPct : 1) : othersThresholdPct;
    const { labels, data } = collapsePieUnderThreshold(rawEntries, threshold);
    if (labels.length === 0) {
        if (canvasId === 'cursorModelPie') cursorModelChart = null;
        else if (canvasId === 'cursorLanguagePie') cursorLanguageChart = null;
        else if (canvasId === 'cursorIntentPie') cursorIntentChart = null;
        else cursorCategoriesChart = null;
        const cell = canvas.closest('.cursor-chart-cell');
        if (cell) cell.classList.add('hidden');
        return;
    }
    const cell = canvas.closest('.cursor-chart-cell');
    if (cell) cell.classList.remove('hidden');
    const colors = colorSlice ? PIE_COLORS.slice(0, labels.length) : [...PIE_COLORS];
    while (colors.length < labels.length) colors.push(`hsl(${(colors.length * 47) % 360}, 60%, 55%)`);
    const zoomTitle = canvasId === 'cursorModelPie' ? 'Cursor — Model share' : canvasId === 'cursorLanguagePie' ? 'Cursor — Language / extension share' : canvasId === 'cursorIntentPie' ? 'Cursor — Intent distribution' : 'Cursor — Categories';
    const newChart = new Chart(canvas, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: colors.slice(0, labels.length),
                borderColor: chartPieDoughnutBorder(),
                borderWidth: 2,
                hoverOffset: 10,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            cutout: '58%',
            onClick: () => openPieZoom(canvasId, labels, data, zoomTitle),
            layout: { padding: { top: 4, bottom: 4 } },
            animation: { animateRotate: true, duration: 500 },
            plugins: {
                legend: { display: true, position: 'bottom', labels: { color: chartPluginMutedColor(), font: { size: 10, weight: '600' }, padding: 12, usePointStyle: true } },
                title: { display: !!(defaultTitle && String(defaultTitle).trim()), text: defaultTitle || '', color: chartPluginMutedColor(), font: { size: 11, weight: '600' } },
                tooltip: {
                    ...chartTooltipTheme(),
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 10,
                    callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed?.toFixed(1) ?? 0}%` },
                },
            }
        }
    });
    const wrap = canvas.closest('div');
    if (wrap) { wrap.style.cursor = 'pointer'; wrap.title = 'Click to zoom'; }
    if (canvasId === 'cursorModelPie') cursorModelChart = newChart;
    else if (canvasId === 'cursorLanguagePie') cursorLanguageChart = newChart;
    else if (canvasId === 'cursorIntentPie') cursorIntentChart = newChart;
    else cursorCategoriesChart = newChart;
}

async function loadCursorDashboard() {
    const section = document.getElementById('aiAssistantSection');
    const container = document.getElementById('aiDevToolsPanel');
    if (!container) return;
    let data = cursorDataInMemory;
    if (!data) {
        try {
            const res = await fetch('./output/cursordata.json');
            if (res.ok) data = await res.json();
        } catch (e) { data = null; }
    }
    if (!data || data.error) {
        return;
    }
    document.getElementById('aiAssistantSection')?.classList.remove('hidden');

    const setEl = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text ?? '—'; };
    setEl('cursorPeriodLabel', data.period === '30d' ? 'Last 30 days' : (data.period || 'Last 30 days'));
    setEl('cursorLastSync', data.lastSync ? formatLastSync(data.lastSync) || data.lastSync : '—');

    const sum = data.summary || {};
    setEl('cursorChatActive', sum.totalActiveUsers != null ? sum.totalActiveUsers : '—');
    setEl('cursorChatEngaged', sum.totalEngagedUsers != null ? sum.totalEngagedUsers : '—');
    setEl('cursorTotalRequests', sum.totalRequests != null ? sum.totalRequests.toLocaleString() : '—');
    setEl('cursorLinesAccepted', sum.linesAccepted != null ? sum.linesAccepted.toLocaleString() : '—');
    setEl('cursorLinesSuggested', sum.linesSuggested != null ? sum.linesSuggested.toLocaleString() : '—');

    buildPieChart('cursorModelPie', data.modelShare, '', true);
    buildPieChart('cursorLanguagePie', data.languageShare, '', true, 1);
    const intentData = data.intentDistribution && typeof data.intentDistribution === 'object' && Object.keys(data.intentDistribution).length > 0
        ? data.intentDistribution
        : {};
    buildPieChart('cursorIntentPie', intentData, '', true);
    const categoriesData = data.categories && typeof data.categories === 'object' && Object.keys(data.categories).length > 0
        ? data.categories
        : {};
    const categoriesCanvas = document.getElementById('cursorCategoriesPie');
    const categoriesNoData = document.getElementById('cursorCategoriesNoData');
    if (categoriesCanvas && categoriesNoData) {
        if (Object.keys(categoriesData).length > 0) {
            categoriesNoData.classList.add('hidden');
            categoriesCanvas.classList.remove('hidden');
            buildPieChart('cursorCategoriesPie', categoriesData, '', true, 1);
        } else {
            if (cursorCategoriesChart) { cursorCategoriesChart.destroy(); cursorCategoriesChart = null; }
            categoriesCanvas.classList.add('hidden');
            categoriesNoData.classList.remove('hidden');
        }
    }

    const leaderboardRows = getCursorLeaderboardRowsForMatch(data).map(normalizeCursorLeaderboardRowForTable);
    const tbody = document.getElementById('cursorLeaderboardBody');
    if (tbody) {
        tbody.innerHTML = '';
        leaderboardRows.forEach((u, i) => {
            const email = (u.email || u.user || '').replace(/^(.{20}).*(@.*)$/, '$1…$2');
            const linesAdded = u.lines_added != null ? u.lines_added.toLocaleString() : (u.linesAdded != null ? u.linesAdded.toLocaleString() : '—');
            const linesDeleted = u.lines_deleted != null ? u.lines_deleted.toLocaleString() : (u.linesDeleted != null ? u.linesDeleted.toLocaleString() : '—');
            const acc = u.acceptance_rate != null ? (Math.round(u.acceptance_rate * 100) + '%') : '—';
            const composer = u.composer_requests != null ? u.composer_requests : (u.composerRequests != null ? u.composerRequests : '—');
            const chat = u.chat_requests != null ? u.chat_requests : (u.chatRequests != null ? u.chatRequests : '—');
            const agent = u.agent_requests != null ? u.agent_requests : (u.agentRequests != null ? u.agentRequests : '—');
            const cmdk = u.cmdk_usages != null ? u.cmdk_usages : (u.cmdkUsages != null ? u.cmdkUsages : '—');
            const row = document.createElement('tr');
            row.className = 'border-b border-slate-700/30 hover:bg-slate-800/30';
            row.innerHTML = `<td class="py-2 px-3 text-xs text-slate-400">${i + 1}</td><td class="py-2 px-3 text-xs text-white font-medium" title="${(u.email || u.user || '').replace(/"/g, '&quot;')}">${email}</td><td class="py-2 px-3 text-xs text-right text-emerald-400">${linesAdded}</td><td class="py-2 px-3 text-xs text-right text-red-400">${linesDeleted}</td><td class="py-2 px-3 text-xs text-right text-slate-300">${acc}</td><td class="py-2 px-3 text-xs text-right text-slate-400">${composer}</td><td class="py-2 px-3 text-xs text-right text-slate-400">${chat}</td><td class="py-2 px-3 text-xs text-right text-slate-400">${agent}</td><td class="py-2 px-3 text-xs text-right text-slate-400">${cmdk}</td>`;
            tbody.appendChild(row);
        });
        if (leaderboardRows.length === 0) {
            const row = document.createElement('tr');
            row.innerHTML = '<td colspan="9" class="py-4 px-3 text-center text-slate-500 text-xs uppercase">No leaderboard data</td>';
            tbody.appendChild(row);
        }
    }

    const repoList = Array.isArray(data.aiEditsByRepository) ? data.aiEditsByRepository : [];
    const repoBody = document.getElementById('cursorAiEditsByRepoBody');
    if (repoBody) {
        repoBody.innerHTML = '';
        repoList.forEach((r) => {
            const projectName = r.projectName != null ? String(r.projectName) : (r.repository ? r.repository.replace(/^.*\//, '') : '—');
            const aiLines = r.aiLinesCommitted != null ? r.aiLinesCommitted.toLocaleString() : '—';
            const totalLines = r.totalLinesCommitted != null ? r.totalLinesCommitted.toLocaleString() : '—';
            const pct = r.codeCommittedByAiPct != null ? r.codeCommittedByAiPct + '%' : '—';
            const row = document.createElement('tr');
            row.className = 'border-b border-slate-700/30 hover:bg-slate-800/30';
            row.innerHTML = `<td class="py-2 px-3 text-xs text-white font-medium" title="${(r.repository || '').replace(/"/g, '&quot;')}">${projectName}</td><td class="py-2 px-3 text-xs text-right text-emerald-400">${aiLines}</td><td class="py-2 px-3 text-xs text-right text-slate-300">${totalLines}</td><td class="py-2 px-3 text-xs text-right text-amber-400">${pct}</td>`;
            repoBody.appendChild(row);
        });
        if (repoList.length === 0) {
            const row = document.createElement('tr');
            row.innerHTML = '<td colspan="4" class="py-4 px-3 text-center text-slate-500 text-xs uppercase">No repository data (AI Code Tracking may require Enterprise)</td>';
            repoBody.appendChild(row);
        }
    }
}

// ---------------------------------------------------
// AI Dev Tools Command Center — accordion + tabs + unified leaderboard
// ---------------------------------------------------

(function initAiDevToolsPanel() {
    // Accordion toggle
    const toggle = document.getElementById('aiDevToolsToggle');
    const body = document.getElementById('aiDevToolsBody');
    if (toggle && body) {
        toggle.addEventListener('click', function () {
            const hint = toggle.querySelector('[data-hint]');
            const chevron = toggle.querySelector('[data-chevron]');
            if (body.classList.contains('hidden')) {
                body.classList.remove('hidden');
                if (chevron) chevron.style.transform = 'rotate(180deg)';
                if (hint) hint.textContent = 'Click to collapse';
            } else {
                body.classList.add('hidden');
                if (chevron) chevron.style.transform = 'rotate(0deg)';
                if (hint) hint.textContent = 'Click to expand';
            }
        });
    }

    // Tab switching (Copilot / Cursor deep-dive)
    var tabs = document.querySelectorAll('[data-tool-tab]');
    tabs.forEach(function (tab) {
        tab.addEventListener('click', function () {
            var tool = tab.getAttribute('data-tool-tab');
            tabs.forEach(function (t) {
                var isCurrent = t.getAttribute('data-tool-tab') === tool;
                if (isCurrent) {
                    t.classList.add('active');
                    t.style.background = tool === 'copilot' ? 'rgba(20,184,166,0.2)' : 'rgba(245,158,11,0.2)';
                    t.style.borderColor = tool === 'copilot' ? 'rgba(20,184,166,0.4)' : 'rgba(245,158,11,0.4)';
                    t.style.color = tool === 'copilot' ? '#5eead4' : '#fbbf24';
                } else {
                    t.classList.remove('active');
                    t.style.background = 'rgba(255,255,255,0.03)';
                    t.style.borderColor = 'rgba(255,255,255,0.06)';
                    t.style.color = '#64748b';
                }
            });
            document.querySelectorAll('[data-tool-panel]').forEach(function (p) {
                p.classList.toggle('hidden', p.getAttribute('data-tool-panel') !== tool);
            });
        });
    });
})();

/**
 * Build the unified leaderboard by merging Copilot + Cursor user data.
 * Called after both loadCopilotDashboard and loadCursorDashboard complete.
 */
function renderUnifiedLeaderboard() {
    var tbody = document.getElementById('unifiedLeaderboardBody');
    if (!tbody) return;

    var copilotRows = (copilotUserLeaderboard || []).map(function (u) {
        return {
            key: (u.user_login || '').toLowerCase().replace(/[._-]/g, ''),
            display: u.user_login || '',
            copilotLines: (u.lines_accepted || 0),
            copilotAcc: u.acceptance_rate,
            copilotFeatures: [
                u.used_completions !== false ? 'Completions' : '',
                u.used_chat ? 'Chat' : '',
                u.used_agent ? 'Agent' : '',
                u.used_cli ? 'CLI' : ''
            ].filter(Boolean)
        };
    });

    var cursorBody = document.getElementById('cursorLeaderboardBody');
    var cursorRows = [];
    if (cursorBody) {
        var trs = cursorBody.querySelectorAll('tr');
        trs.forEach(function (tr) {
            var cells = tr.querySelectorAll('td');
            if (cells.length < 5) return;
            var email = (cells[1] && cells[1].getAttribute('title')) || (cells[1] && cells[1].textContent) || '';
            var linesAdded = parseInt((cells[2] && cells[2].textContent || '0').replace(/[^0-9]/g, ''), 10) || 0;
            var acc = (cells[4] && cells[4].textContent || '').trim();
            var composer = (cells[5] && cells[5].textContent || '').trim();
            var chat = (cells[6] && cells[6].textContent || '').trim();
            var agent = (cells[7] && cells[7].textContent || '').trim();
            var cmdk = (cells[8] && cells[8].textContent || '').trim();
            cursorRows.push({
                key: email.toLowerCase().split('@')[0].replace(/[^a-z0-9]/g, ''),
                display: email,
                cursorLines: linesAdded,
                cursorAcc: acc,
                cursorFeatures: [
                    composer !== '—' && composer !== '0' ? 'Composer' : '',
                    chat !== '—' && chat !== '0' ? 'Chat' : '',
                    agent !== '—' && agent !== '0' ? 'Agent' : '',
                    cmdk !== '—' && cmdk !== '0' ? 'Cmd+K' : ''
                ].filter(Boolean)
            });
        });
    }

    // Merge by fuzzy key matching
    var merged = {};
    copilotRows.forEach(function (r) {
        merged[r.key] = {
            display: r.display,
            copilotLines: r.copilotLines,
            cursorLines: 0,
            copilotAcc: r.copilotAcc,
            cursorAcc: null,
            tools: ['Copilot'],
            copilotFeatures: r.copilotFeatures,
            cursorFeatures: []
        };
    });

    cursorRows.forEach(function (r) {
        var matchKey = null;
        Object.keys(merged).forEach(function (k) {
            if (matchKey) return;
            if (k === r.key) { matchKey = k; return; }
            if (k.length >= 3 && r.key.length >= 3 && (k.includes(r.key) || r.key.includes(k))) matchKey = k;
        });
        if (matchKey) {
            merged[matchKey].cursorLines = r.cursorLines;
            merged[matchKey].cursorAcc = r.cursorAcc;
            if (merged[matchKey].tools.indexOf('Cursor') === -1) merged[matchKey].tools.push('Cursor');
            merged[matchKey].cursorFeatures = r.cursorFeatures;
        } else {
            merged[r.key] = {
                display: r.display,
                copilotLines: 0,
                cursorLines: r.cursorLines,
                copilotAcc: null,
                cursorAcc: r.cursorAcc,
                tools: ['Cursor'],
                copilotFeatures: [],
                cursorFeatures: r.cursorFeatures
            };
        }
    });

    var list = Object.values(merged).sort(function (a, b) {
        return (b.copilotLines + b.cursorLines) - (a.copilotLines + a.cursorLines);
    });

    if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="py-6 text-center text-slate-500 italic text-xs">No leaderboard data available</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    list.forEach(function (u, i) {
        var toolBadges = u.tools.map(function (t) {
            if (t === 'Copilot') return '<span class="inline-block px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider" style="background:rgba(20,184,166,0.12);border:1px solid rgba(13,148,136,0.35);color:#0f766e">Copilot</span>';
            return '<span class="inline-block px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider" style="background:rgba(245,158,11,0.14);border:1px solid rgba(217,119,6,0.4);color:#b45309">Cursor</span>';
        }).join(' ');

        var allFeatures = u.copilotFeatures.concat(u.cursorFeatures);
        var uniqueFeatures = [];
        allFeatures.forEach(function (f) { if (uniqueFeatures.indexOf(f) === -1) uniqueFeatures.push(f); });
        var featureBadges = uniqueFeatures.slice(0, 5).map(function (f) {
            return '<span class="inline-block px-1 py-0.5 rounded text-[8px] font-bold text-slate-600 bg-slate-100 border border-slate-200">' + f + '</span>';
        }).join(' ');

        var bestAcc = '—';
        if (u.copilotAcc != null && u.copilotAcc !== '') {
            bestAcc = typeof u.copilotAcc === 'number' ? Math.round(u.copilotAcc * 100) + '%' : String(u.copilotAcc);
        }
        if (u.cursorAcc && u.cursorAcc !== '—') bestAcc = bestAcc === '—' ? u.cursorAcc : bestAcc;

        var combined = u.copilotLines + u.cursorLines;
        var zebra = i % 2 === 0 ? 'gh-leader-row--even' : 'gh-leader-row--odd';
        var tr = document.createElement('tr');
        tr.className = 'gh-leader-row border-b transition-colors ' + zebra;
        tr.innerHTML =
            '<td class="py-2.5 px-3 text-xs text-slate-600 tabular-nums">' + (i + 1) + '</td>' +
            '<td class="py-2.5 px-3 text-xs gh-leader-name">' + escapeHtml(u.display) + '</td>' +
            '<td class="py-2.5 px-3 text-right">' + toolBadges + '</td>' +
            '<td class="py-2.5 px-3 text-xs text-right tabular-nums" style="color:#0d9488">' + (u.copilotLines ? u.copilotLines.toLocaleString() : '<span class="text-slate-500">—</span>') + '</td>' +
            '<td class="py-2.5 px-3 text-xs text-right tabular-nums" style="color:#b45309">' + (u.cursorLines ? u.cursorLines.toLocaleString() : '<span class="text-slate-500">—</span>') + '</td>' +
            '<td class="py-2.5 px-3 text-xs text-right text-slate-900 font-bold tabular-nums">' + combined.toLocaleString() + '</td>' +
            '<td class="py-2.5 px-3 text-xs text-right text-slate-700">' + bestAcc + '</td>' +
            '<td class="py-2.5 px-3 text-right">' + (featureBadges || '<span class="text-slate-500">—</span>') + '</td>';
        tbody.appendChild(tr);
    });
}

/* -----------------------------------------------------------
   UI Polish: sticky header, back-to-top, section reveal,
   animated counters
   ----------------------------------------------------------- */
(function () {
    /* -- 1. Back-to-top button -- */
    var btt = document.getElementById('backToTopBtn');
    if (btt) {
        var bttTicking = false;
        window.addEventListener('scroll', function () {
            if (!bttTicking) {
                requestAnimationFrame(function () {
                    btt.classList.toggle('visible', window.scrollY > 400);
                    bttTicking = false;
                });
                bttTicking = true;
            }
        }, { passive: true });
        btt.addEventListener('click', function () {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    /* -- 3. Section reveal animation -- */
    var revealDelay = 0;
    var REVEAL_STEP = 90;
    var REVEAL_IDS = new Set([
        'teamHealthMatrixSection', 'aiOrgSection', 'filterSection',
        'mainarea', 'workCategorizationRow',
        'workCategorizationSection',
        'stageDwellSection', 'hygieneSection', 'aiAssistantSection'
    ]);

    var observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
            if (m.type === 'attributes' && m.attributeName === 'class') {
                var el = m.target;
                if (REVEAL_IDS.has(el.id) &&
                    !el.classList.contains('hidden') &&
                    !el.dataset.revealed) {
                    el.dataset.revealed = '1';
                    el.style.animationDelay = revealDelay + 'ms';
                    el.classList.add('section-reveal');
                    revealDelay += REVEAL_STEP;
                    setTimeout(function () { revealDelay = Math.max(0, revealDelay - REVEAL_STEP); }, 600);
                }
            }
        });
    });

    REVEAL_IDS.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
})();

/* -- 4. Animated number counter -- */
function animateCounter(el, target, duration) {
    if (!el || !Number.isFinite(target)) return;
    var start = 0;
    var startTime = null;
    var isFloat = target !== Math.floor(target);
    var suffix = '';
    var text = el.textContent || '';
    var suffixMatch = text.match(/[%?dxs]+$/);
    if (suffixMatch) suffix = suffixMatch[0];

    function step(ts) {
        if (!startTime) startTime = ts;
        var progress = Math.min((ts - startTime) / duration, 1);
        var eased = 1 - Math.pow(1 - progress, 3);
        var current = start + (target - start) * eased;
        el.textContent = (isFloat ? current.toFixed(1) : Math.round(current)) + suffix;
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}
