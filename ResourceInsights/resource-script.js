/* ================================================================
   resource Insights — resource-script.js
   Fetches per-person data from JIRA, Cursor, and Sprint reports,
   then renders comprehensive individual contribution metrics.
   ================================================================ */

// -- Chart.js defaults (contrast-aware; theme-light ready) --
if (typeof SatelliteChartTheme !== 'undefined') {
  SatelliteChartTheme.applyChartJsDefaults(Chart);
} else {
  Chart.defaults.color = '#94a3b8';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.08)';
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
  Chart.defaults.plugins.legend.labels.padding = 14;
  Chart.defaults.plugins.legend.labels.color = '#e2e8f0';
  Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(15,23,42,0.95)';
  Chart.defaults.plugins.tooltip.borderColor = 'rgba(255,255,255,0.12)';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleFont = { weight: 'bold', size: 11 };
  Chart.defaults.plugins.tooltip.bodyFont = { size: 11 };
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
}

// -- Status classification --
// NOTE: 'ready for staging' is the dev END stage per projects.json — it lives in DONE_NAMES.
// Anything at or beyond Ready for Staging (staging, release, done, etc.) is considered closed.
const IN_PROGRESS_NAMES = new Set([
  'in progress', 'in development', 'in-progress', 'in dev', 'coding',
  'implementation', 'developing', 'active', 'working', 'started',
  'in review', 'in qa', 'in testing', 'ready for review', 'ready for qa',
  'ready for dev'
]);
const DONE_NAMES = new Set([
  'ready for staging',
  'done', 'closed', 'canceled', 'cancelled', 'resolved', 'released', 'completed', 'complete', 'deployed',
  'accepted', 'production', 'ready for production', 'ready for prod',
  'ready for release', 'staging', 'release',
  'in staging', 'in release', 'delivered', 'verified'
]);

// -- Project-stage awareness (populated from projects.json consensus via API response) --
let activeProjectStages = null; // { startStage: string, endStage: string }

/**
 * Apply the majority-voted project stages from projects.json.
 * Ensures the endStage is counted as "done" (not in-progress) and
 * the startStage is counted as "in_progress".
 */
function applyProjectStages(stages) {
  if (!stages) return;
  activeProjectStages = stages;
  const endLc = (stages.endStage || '').toLowerCase().trim();
  const startLc = (stages.startStage || '').toLowerCase().trim();
  // endStage = done (ticket handed off from dev)
  if (endLc) { DONE_NAMES.add(endLc); IN_PROGRESS_NAMES.delete(endLc); }
  // startStage = in_progress
  if (startLc) { IN_PROGRESS_NAMES.add(startLc); DONE_NAMES.delete(startLc); }
}

/**
 * Find the date a ticket moved to the project endStage using its changelog.
 * Returns the most recent such transition date, or null if not found.
 */
function getEndStageDate(issue) {
  if (!activeProjectStages?.endStage) return null;
  const endLc = activeProjectStages.endStage.toLowerCase().trim();
  const histories = issue.changelog?.histories;
  if (!histories || !histories.length) return null;
  const sorted = [...histories].sort((a, b) => new Date(b.created) - new Date(a.created));
  for (const h of sorted) {
    for (const item of h.items) {
      if (item.field === 'status' && (item.toString || '').toLowerCase().trim() === endLc) {
        return new Date(h.created);
      }
    }
  }
  return null;
}

function classifyStatus(statusName, categoryKey) {
  const lc = (statusName || '').toLowerCase().trim();
  // Project-configured end/start stages always win over JIRA's category key.
  // This ensures e.g. 'ready for staging' (endStage) is never overridden by
  // JIRA's 'indeterminate' category to become in_progress.
  if (activeProjectStages) {
    const endLc = (activeProjectStages.endStage || '').toLowerCase().trim();
    const startLc = (activeProjectStages.startStage || '').toLowerCase().trim();
    if (endLc && lc === endLc) return 'done';
    if (startLc && lc === startLc) return 'in_progress';
  }
  // Static name sets (checked before JIRA category so DONE_NAMES always wins)
  if (DONE_NAMES.has(lc)) return 'done';
  if (IN_PROGRESS_NAMES.has(lc)) return 'in_progress';
  // Fall back to JIRA status category
  if (categoryKey === 'done') return 'done';
  if (categoryKey === 'indeterminate') return 'in_progress';
  if (categoryKey === 'new') return 'todo';
  return 'todo';
}

function isDone(issue) {
  const cat = issue.fields?.status?.statusCategory?.key;
  const name = issue.fields?.status?.name;
  return classifyStatus(name, cat) === 'done';
}

function isInProgress(issue) {
  const cat = issue.fields?.status?.statusCategory?.key;
  const name = issue.fields?.status?.name;
  return classifyStatus(name, cat) === 'in_progress';
}

// -- DOM References --
const personNameInput   = document.getElementById('personName');
const analyzeBtn        = document.getElementById('analyzeBtn');
const loader            = document.getElementById('loader');
const errorBox          = document.getElementById('errorBox');
const metricsSection    = document.getElementById('metricsSection');

const loaderStep    = document.getElementById('loaderStep');
const progressBar   = document.getElementById('progressBar');
const loaderDetail  = document.getElementById('loaderDetail');
const loaderPercent = document.getElementById('loaderPercent');

let charts = {};

// -- Custom Days Dropdown --
let selectedDays = 30;
const daysDropdown = document.getElementById('daysDropdown');
const daysDropdownBtn = document.getElementById('daysDropdownBtn');
const daysMenu = document.getElementById('daysMenu');
const daysLabel = document.getElementById('daysLabel');

daysDropdownBtn?.addEventListener('click', () => {
  daysDropdown.classList.toggle('open');
});

daysMenu?.addEventListener('click', (e) => {
  const item = e.target.closest('.days-dropdown-item');
  if (!item) return;
  selectedDays = parseInt(item.dataset.value) || 30;
  daysLabel.textContent = selectedDays + ' Days';
  daysMenu.querySelectorAll('.days-dropdown-item').forEach(el => el.classList.remove('active'));
  item.classList.add('active');
  daysDropdown.classList.remove('open');
});

document.addEventListener('click', (e) => {
  if (!daysDropdown?.contains(e.target)) daysDropdown?.classList.remove('open');
});

// --------------------------------------------------------------
//  resource DIRECTORY — autocomplete from cached JIRA user list
// --------------------------------------------------------------

let directoryUsers = [];
let directoryReady = false;
let activeSuggestionIdx = -1;

const suggestionsDropdown = document.getElementById('suggestionsDropdown');
const directoryOverlay = document.getElementById('directoryOverlay');
const directoryStatus = document.getElementById('directoryStatus');

function showDirOverlay()  { if (directoryOverlay) directoryOverlay.classList.remove('hidden'); }
function hideDirOverlay()  { if (directoryOverlay) directoryOverlay.classList.add('hidden'); }

function applyDirectoryData(data, label) {
  directoryUsers = data.users || [];
  directoryReady = true;
  showDirectoryStatus(label.state, label.text);
  personNameInput.placeholder = directoryUsers.length
    ? `Search ${directoryUsers.length} VeloSync employees\u2026`
    : 'Start typing a name\u2026';
}

async function checkAndRefreshDirectory() {
  try {
    // Fast call — server returns instantly from cache or signals needsRefresh
    const resp = await fetch('/api/resource/directory');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    if (!data.needsRefresh) {
      const age = timeSince(data.lastRefresh);
      applyDirectoryData(data, { state: 'cached', text: `${data.count} employees \xb7 updated ${age}` });
      return;
    }

    // Cache is missing or stale — show the overlay and do the real sync
    showDirOverlay();

    // If we got stale data, load it in the background so autocomplete works while syncing
    if (data.users && data.users.length > 0) {
      directoryUsers = data.users;
      directoryReady = true;
    }

    const freshResp = await fetch('/api/resource/directory?force=1');
    if (!freshResp.ok) throw new Error(`HTTP ${freshResp.status}`);
    const fresh = await freshResp.json();

    applyDirectoryData(fresh, { state: 'fresh', text: `${fresh.count} employees \xb7 just synced` });
  } catch (err) {
    console.error('[Directory]', err);
    showDirectoryStatus('cached', 'Directory unavailable');
  } finally {
    hideDirOverlay();
  }
}

function showDirectoryStatus(state, text) {
  if (!directoryStatus) return;
  directoryStatus.className = `directory-status ${state}`;
  directoryStatus.innerHTML = `<span class="ds-dot"></span>${escText(text)}`;
}

function timeSince(isoDate) {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const d = Math.floor(hrs / 24);
  return `${d}d ago`;
}

function escText(s) {
  const d = document.createElement('span');
  d.textContent = s;
  return d.innerHTML;
}

// -- Autocomplete filtering (fuzzy) --
function filterUsers(query) {
  if (!query || query.length < 1) return [];
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(t => t.length >= 1);

  return directoryUsers
    .map(u => {
      const dn = (u.displayName || '').toLowerCase();
      const em = (u.email || '').toLowerCase();
      const emLocal = em.split('@')[0] || '';

      // Exact display name or email match
      if (dn === q || em === q) return { ...u, score: 1 };
      // Display name starts with query
      if (dn.startsWith(q)) return { ...u, score: 0.95 };
      // Email local part starts with query (e.g. "avnish" ? "avnish.malik@")
      if (emLocal.startsWith(q) || emLocal.replace(/[._-]/g, ' ').startsWith(q)) return { ...u, score: 0.93 };
      // All typed tokens found in name or email
      const allInName = tokens.every(t => dn.includes(t));
      if (allInName) return { ...u, score: 0.88 };
      const allInAny = tokens.every(t => dn.includes(t) || em.includes(t));
      if (allInAny) return { ...u, score: 0.8 };
      // Any word in the display name starts with any typed token
      const nameWords = dn.replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
      const wordStartMatch = tokens.some(t => t.length >= 2 && nameWords.some(w => w.startsWith(t)));
      if (wordStartMatch) return { ...u, score: 0.6 };
      // Substring match — any token appears anywhere
      if (tokens.some(t => t.length >= 2 && (dn.includes(t) || emLocal.includes(t)))) return { ...u, score: 0.4 };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function showSuggestions(matches) {
  if (!suggestionsDropdown) return;
  if (matches.length === 0) {
    suggestionsDropdown.classList.add('hidden');
    activeSuggestionIdx = -1;
    return;
  }

  suggestionsDropdown.innerHTML = matches.map((u, i) => `
    <div class="suggestion-item${i === activeSuggestionIdx ? ' active-suggestion' : ''}" data-idx="${i}" data-name="${esc(u.displayName)}">
      <div class="flex-1 min-w-0">
        <div class="suggestion-name">${esc(u.displayName)}</div>
        <div class="suggestion-source">${esc(u.email || '')}</div>
      </div>
    </div>
  `).join('');
  suggestionsDropdown.classList.remove('hidden');
}

function hideSuggestions() {
  if (suggestionsDropdown) suggestionsDropdown.classList.add('hidden');
  activeSuggestionIdx = -1;
}

let debounceTimer = null;
personNameInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (!directoryReady) return;
    const q = personNameInput.value.trim();
    if (q.length < 1) { hideSuggestions(); return; }
    const matches = filterUsers(q);
    activeSuggestionIdx = -1;
    showSuggestions(matches);
  }, 120);
});

personNameInput.addEventListener('keydown', (e) => {
  if (!suggestionsDropdown || suggestionsDropdown.classList.contains('hidden')) {
    if (e.key === 'Enter') analyze();
    return;
  }
  const items = suggestionsDropdown.querySelectorAll('.suggestion-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeSuggestionIdx = Math.min(activeSuggestionIdx + 1, items.length - 1);
    highlightSuggestion(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeSuggestionIdx = Math.max(activeSuggestionIdx - 1, -1);
    highlightSuggestion(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeSuggestionIdx >= 0 && items[activeSuggestionIdx]) {
      selectSuggestion(items[activeSuggestionIdx].dataset.name);
    } else {
      hideSuggestions();
      analyze();
    }
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

function highlightSuggestion(items) {
  items.forEach((el, i) => el.classList.toggle('active-suggestion', i === activeSuggestionIdx));
}

function selectSuggestion(name) {
  personNameInput.value = name;
  hideSuggestions();
  personNameInput.focus();
}

suggestionsDropdown?.addEventListener('click', (e) => {
  const item = e.target.closest('.suggestion-item');
  if (item) selectSuggestion(item.dataset.name);
});

document.addEventListener('click', (e) => {
  if (e.target !== personNameInput && !suggestionsDropdown?.contains(e.target)) {
    hideSuggestions();
  }
});

personNameInput.addEventListener('focus', () => {
  const q = personNameInput.value.trim();
  if (q.length >= 1 && directoryReady) {
    const matches = filterUsers(q);
    if (matches.length > 0) showSuggestions(matches);
  }
});

// -- Bootstrap directory on page load --
checkAndRefreshDirectory();

// -- Event Listeners --
analyzeBtn.addEventListener('click', analyze);

// -- Progress helpers --
function updateProgress(step, percent, detail) {
  if (loaderStep)    loaderStep.textContent = step;
  if (progressBar)   progressBar.style.width = percent + '%';
  if (loaderDetail)  loaderDetail.textContent = detail || '';
  if (loaderPercent) loaderPercent.textContent = percent + '%';
}

function resetProgress() {
  updateProgress('Searching for resource\u2026', 0, '');
}

// --------------------------------------------------------------
//  MAIN FLOW
// --------------------------------------------------------------

async function analyze() {
  const name = personNameInput.value.trim();
  if (!name) return showError('Please enter a resource name.');
  if (name.length < 2) return showError('Name must be at least 2 characters.');

  resetProgress();
  showLoader();
  hideError();
  metricsSection.classList.add('hidden');

  const days = selectedDays;

  try {
    const resp = await fetch('/api/resource/insights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, days }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let msg = `Server returned HTTP ${resp.status}`;
      try { const j = JSON.parse(text); msg = j.error?.message || j.error || msg; } catch (_) {}
      throw new Error(msg);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalData = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'progress') {
          updateProgress(msg.step, msg.percent, msg.detail);
        } else if (msg.type === 'done') {
          updateProgress('Complete!', 100, 'Rendering dashboard\u2026');
          finalData = msg.data;
        } else if (msg.type === 'error') {
          throw new Error(msg.message);
        }
      }
    }

    if (!finalData) {
      throw new Error('No data returned. The person may not exist in any data source.');
    }

    // Apply project-stage consensus so isDone/isInProgress and cycle-time use the right boundaries
    applyProjectStages(finalData.projectStages);

    const metrics = computeMetrics(finalData);
    render(finalData, metrics);
    metricsSection.classList.remove('hidden');
  } catch (err) {
    showError(err.message);
  } finally {
    hideLoader();
  }
}

// --------------------------------------------------------------
//  DATA PROCESSING
// --------------------------------------------------------------

function computeMetrics(data) {
  const now = new Date();
  const days = data.days || 30;
  const assigned = data.jira?.assigned || [];
  const reported = data.jira?.reported || [];

  const openIssues = assigned.filter(i => !isDone(i));
  const wipIssues = assigned.filter(i => isInProgress(i));
  const resolvedIssues = assigned.filter(i => isDone(i));

  // Story points — try all common Jira custom field IDs for story points
  let totalSP = 0;
  let resolvedSP = 0;
  assigned.forEach(i => {
    const sp = Number(
      i.fields?.story_points ||
      i.fields?.customfield_10028 ||
      i.fields?.customfield_10016 ||
      i.fields?.customfield_10025 ||
      0
    );
    totalSP += sp;
    if (isDone(i)) resolvedSP += sp;
  });

  // Fallback: if Jira returned no story points (field not configured / not fetched),
  // sum from parsed sprint MD files which always have accurate hand-entered SP data.
  const sprints = data.sprints || [];
  if (resolvedSP === 0 && sprints.length > 0) {
    sprints.forEach(s => {
      resolvedSP += Number(s.individual?.storyPoints) || 0;
    });
    // totalSP = resolvedSP in this case (sprints only track completed SP)
    if (totalSP === 0) totalSP = resolvedSP;
  }

  // Status distribution
  const statusMap = {};
  assigned.forEach(i => {
    const name = i.fields?.status?.name || 'Unknown';
    statusMap[name] = (statusMap[name] || 0) + 1;
  });

  // Priority distribution
  const priorityMap = {};
  assigned.forEach(i => {
    const name = i.fields?.priority?.name || 'None';
    priorityMap[name] = (priorityMap[name] || 0) + 1;
  });

  // Issue type distribution
  const typeMap = {};
  assigned.forEach(i => {
    const name = i.fields?.issuetype?.name || 'Other';
    typeMap[name] = (typeMap[name] || 0) + 1;
  });

  // Bugs
  const bugsFixed = resolvedIssues.filter(i =>
    /bug/i.test(i.fields?.issuetype?.name || '')
  ).length;
  const bugsOpen = openIssues.filter(i =>
    /bug/i.test(i.fields?.issuetype?.name || '')
  ).length;

  // Cycle times
  const cycleTimes = [];
  resolvedIssues.forEach(i => {
    const ct = computeCycleTime(i);
    if (ct !== null && ct >= 0) cycleTimes.push(ct);
  });
  const avgCycleTime = cycleTimes.length
    ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length
    : null;

  // Weekly throughput
  const numWeeks = Math.max(4, Math.ceil(days / 7));
  const weeklyThroughput = computeWeeklyThroughput(resolvedIssues, now, numWeeks);

  // resolution rate
  const totalAssigned = assigned.length;
  const resolutionRate = totalAssigned > 0
    ? (resolvedIssues.length / totalAssigned) * 100
    : 0;

  // Avg tickets per week
  const avgPerWeek = days > 0
    ? resolvedIssues.length / (days / 7)
    : 0;

  // Role detection
  const role = detectRole(data, resolvedIssues, reported, bugsFixed);

  // Open tickets table data
  const openTableRows = openIssues.map(i => ({
    key: i.key,
    summary: i.fields?.summary || '',
    type: i.fields?.issuetype?.name || 'Unknown',
    priority: i.fields?.priority?.name || 'None',
    status: i.fields?.status?.name || 'Unknown',
    statusClass: classifyStatus(i.fields?.status?.name, i.fields?.status?.statusCategory?.key),
    age: Math.round((now - new Date(i.fields?.created)) / (1000 * 60 * 60 * 24)),
  })).sort((a, b) => b.age - a.age);

  // Completed tickets table data
  const completedTableRows = resolvedIssues.map(i => {
    const ct = computeCycleTime(i);
    const esd = getEndStageDate(i);
    const resolvedDate = esd
      ? esd.toISOString()
      : (i.fields?.resolutiondate || i.fields?.statuscategorychangedate || '');
    return {
      key: i.key,
      summary: i.fields?.summary || '',
      type: i.fields?.issuetype?.name || 'Unknown',
      priority: i.fields?.priority?.name || 'None',
      status: i.fields?.status?.name || 'Done',
      resolved: resolvedDate,
      cycleTime: ct,
    };
  }).sort((a, b) => new Date(b.resolved) - new Date(a.resolved));

  return {
    days,
    role,
    totalAssigned,
    openCount: openIssues.length,
    wipCount: wipIssues.length,
    resolvedCount: resolvedIssues.length,
    totalSP,
    resolvedSP,
    avgCycleTime,
    cycleTimes,
    bugsFixed,
    bugsOpen,
    reportedCount: reported.length,
    resolutionRate,
    avgPerWeek,
    statusMap,
    priorityMap,
    typeMap,
    weeklyThroughput,
    openTableRows,
    completedTableRows,
  };
}

function detectRole(data, resolved, reported, bugsFixed) {
  const assigned = data.jira?.assigned || [];
  const cursor = data.cursor;
  const hasCursorActivity = cursor && (cursor.total_lines_accepted > 0 || cursor.total_accepts > 0);
  const totalBugs = assigned.filter(i => /bug/i.test(i.fields?.issuetype?.name || '')).length;
  const totalStories = assigned.filter(i => /story/i.test(i.fields?.issuetype?.name || '')).length;
  const qaTypes = assigned.filter(i => /qa|test|sdet/i.test(i.fields?.issuetype?.name || '')).length;

  if (reported.length > assigned.length * 1.5 && !hasCursorActivity) return 'manager';
  if (qaTypes > totalStories || (totalBugs > totalStories && !hasCursorActivity)) return 'qa';
  if (hasCursorActivity || totalStories > 0) return 'dev';
  if (assigned.length === 0 && reported.length > 0) return 'manager';
  return 'dev';
}

function computeCycleTime(issue) {
  const histories = issue.changelog?.histories;
  if (!histories || !histories.length) return null;

  // Use project-specific stage names when available (from projects.json consensus)
  const startLc = activeProjectStages?.startStage?.toLowerCase().trim() || null;
  const endLc = activeProjectStages?.endStage?.toLowerCase().trim() || null;

  let startTime = null;
  let endTime = null;
  const sorted = [...histories].sort((a, b) => new Date(a.created) - new Date(b.created));

  for (const history of sorted) {
    for (const item of history.items) {
      if (item.field !== 'status') continue;
      const toName = (item.toString || '').toLowerCase().trim();
      const isStart = startLc
        ? toName === startLc
        : (IN_PROGRESS_NAMES.has(toName) || /progress|develop|coding|implement|active|review|test|qa/i.test(toName));
      // With project endStage (e.g. Ready for Staging), also end on any post-handoff name in DONE_NAMES
      // so skipped transitions still close the interval (aligned with jira-md-export getStageSets).
      const isEnd = endLc
        ? (toName === endLc || DONE_NAMES.has(toName))
        : (DONE_NAMES.has(toName) || /done|closed|resolv|releas|complet|deploy|accept|stag|prod|deliver|verif/i.test(toName));
      if (!startTime && isStart) startTime = new Date(history.created);
      if (startTime && !endTime && isEnd) endTime = new Date(history.created);
    }
  }

  if (startTime && endTime) return (endTime - startTime) / (1000 * 60 * 60 * 24);
  if (startTime) {
    const fallbackEnd = getEndStageDate(issue) || (issue.fields?.resolutiondate ? new Date(issue.fields.resolutiondate) : null);
    if (fallbackEnd) return (fallbackEnd - startTime) / (1000 * 60 * 60 * 24);
  }
  return null;
}

function computeWeeklyThroughput(resolvedIssues, now, numWeeks) {
  const weeks = [];
  for (let w = numWeeks - 1; w >= 0; w--) {
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() - w * 7);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 7);

    const count = resolvedIssues.filter(i => {
      // Prefer changelog-based endStage date (most accurate), then resolutiondate, then statuscategorychangedate
      const esd = getEndStageDate(i);
      if (esd) return esd >= weekStart && esd < weekEnd;
      const rd = i.fields?.resolutiondate ? new Date(i.fields.resolutiondate) : null;
      if (rd) return rd >= weekStart && rd < weekEnd;
      const scd = i.fields?.statuscategorychangedate ? new Date(i.fields.statuscategorychangedate) : null;
      return scd && scd >= weekStart && scd < weekEnd;
    }).length;

    const label = `${weekStart.getDate()}/${weekStart.getMonth() + 1}`;
    weeks.push({ label: `Wk ${label}`, count });
  }
  return weeks;
}

// --------------------------------------------------------------
//  RENDERING
// --------------------------------------------------------------

function render(data, m) {
  renderProfile(data, m);
  renderKPIs(data, m);
  renderCharts(m);
  renderAITools(data);
  renderSprintPerformance(data);
  renderOpenTickets(m);
  renderCompletedTickets(m);
}

function renderProfile(data, m) {
  const person = data.person || {};
  const name = person.name || personNameInput.value.trim();
  const email = person.email || '';

  document.getElementById('personDisplayName').textContent = name;
  document.getElementById('personEmail').textContent = email || 'Email not available';

  // Hide role badge — we cannot reliably determine role from data alone
  document.getElementById('roleBadge').classList.add('hidden');

  document.getElementById('daysBadge').textContent = `LAST ${m.days} DAYS`;

  const totalIssues = m.totalAssigned + m.reportedCount;
  document.getElementById('jiraMatchBadge').textContent = person.accountId
    ? `${totalIssues} issues tracked`
    : 'Fuzzy match \u2014 verify name';

  // Source indicators
  const hasJira = m.totalAssigned > 0 || m.reportedCount > 0;
  const hasCursor = !!data.cursor;
  const hasSprints = data.sprints && data.sprints.length > 0;
  const hasCopilot = !!data.copilot;
  const hasConfluence = (data.sprints || []).some(s => s.individual && s.individual.confluence && ((s.individual.confluence.pagesCreated || 0) + (s.individual.confluence.pagesEdited || 0)) > 0);
  togglVeloSyncurce('srcJira', hasJira);
  togglVeloSyncurce('srcCursor', hasCursor);
  togglVeloSyncurce('srcSprints', hasSprints);
  togglVeloSyncurce('srcCopilot', hasCopilot);
  togglVeloSyncurce('srcConfluence', hasConfluence);
}

function togglVeloSyncurce(id, active) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('active', active);
}

function renderKPIs(data, m) {
  const noAssignedData = m.totalAssigned === 0;

  // Row 1
  document.getElementById('kpiCompleted').textContent = noAssignedData ? '—' : m.resolvedCount;
  document.getElementById('kpiCompletedSub').textContent = noAssignedData
    ? 'No assigned tickets in this window'
    : `of ${m.totalAssigned} assigned tickets`;

  document.getElementById('kpiStoryPoints').textContent = noAssignedData ? '—' : (m.resolvedSP || '0');
  document.getElementById('kpiStoryPointsSub').textContent = noAssignedData
    ? 'No assigned work to measure'
    : m.totalSP ? `${m.totalSP} total SP assigned` : 'No story points data';

  document.getElementById('kpiCycleTime').textContent = m.avgCycleTime !== null
    ? m.avgCycleTime.toFixed(1) + 'd'
    : '—';
  document.getElementById('kpiCycleTimeSub').textContent = m.cycleTimes.length
    ? `Based on ${m.cycleTimes.length} resolved tickets`
    : noAssignedData ? 'Requires assigned tickets' : 'No cycle time data available';

  document.getElementById('kpiWorkload').textContent = noAssignedData ? '—' : m.openCount;
  document.getElementById('kpiWorkloadSub').textContent = noAssignedData
    ? 'No open assignments'
    : m.wipCount ? `${m.wipCount} in progress` : 'No active tickets';

  // Row 2
  const bugsLabel = document.getElementById('kpiBugsLabel');
  bugsLabel.textContent = 'Bugs Fixed';
  document.getElementById('kpiBugs').textContent = noAssignedData ? '—' : m.bugsFixed;
  document.getElementById('kpiBugsSub').textContent = noAssignedData
    ? 'No assigned bugs'
    : m.bugsOpen ? `${m.bugsOpen} bugs still open` : 'No open bugs';

  document.getElementById('kpiReported').textContent = m.reportedCount;
  document.getElementById('kpiReportedSub').textContent = m.reportedCount > 0
    ? 'Tickets created / reported'
    : 'No reported tickets';

  document.getElementById('kpiResRate').textContent = noAssignedData ? '—' : m.resolutionRate.toFixed(0) + '%';
  const resColor = noAssignedData ? 'text-slate-500' : m.resolutionRate >= 70 ? 'text-emerald-400' : m.resolutionRate >= 40 ? 'text-amber-400' : 'text-red-400';
  document.getElementById('kpiResRate').className = `kpi-value ${resColor}`;
  document.getElementById('kpiResRateSub').textContent = noAssignedData
    ? 'No assigned tickets to resolve'
    : `${m.resolvedCount} resolved / ${m.totalAssigned} assigned`;

  document.getElementById('kpiAvgWeek').textContent = noAssignedData ? '—' : m.avgPerWeek.toFixed(1);
  document.getElementById('kpiAvgWeekSub').textContent = noAssignedData
    ? 'No completions to average'
    : `Over ${m.days}-day window`;
}

function destroyCharts() {
  Object.values(charts).forEach(c => c.destroy());
  charts = {};
}

function renderCharts(m) {
  destroyCharts();

  const chartsRow1 = document.getElementById('chartsRow1');
  const chartsRow2 = document.getElementById('chartsRow2');

  // Hide chart rows entirely when there's no assigned data
  if (m.totalAssigned === 0) {
    if (chartsRow1) chartsRow1.classList.add('hidden');
    if (chartsRow2) chartsRow2.classList.add('hidden');
    return;
  }
  if (chartsRow1) chartsRow1.classList.remove('hidden');
  if (chartsRow2) chartsRow2.classList.remove('hidden');

  const S = typeof SatelliteChartTheme !== 'undefined' ? SatelliteChartTheme : null;
  const p = S ? S.palette() : {
    tick: '#e2e8f0', legend: '#e2e8f0', doughnutBorder: 'rgba(15,23,42,0.45)',
    grid: 'rgba(148,163,184,0.22)', gridFaint: 'rgba(148,163,184,0.12)', axisBorder: 'rgba(148,163,184,0.3)',
  };
  const doughnutStroke = S && S.isLight() ? 1 : 0;

  // 1) Status Distribution — Doughnut
  const statusEntries = Object.entries(m.statusMap).sort((a, b) => b[1] - a[1]);
  if (statusEntries.length > 0) {
    charts.status = new Chart(document.getElementById('statusChart'), {
      type: 'doughnut',
      data: {
        labels: statusEntries.map(e => e[0]),
        datasets: [{
          data: statusEntries.map(e => e[1]),
          backgroundColor: statusEntries.map((_, i) => STATUS_PALETTE[i % STATUS_PALETTE.length]),
          borderWidth: doughnutStroke || 0,
          borderColor: p.doughnutBorder,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { bottom: 4, right: 4 } },
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { font: { size: 10, weight: '600' }, padding: 8, color: p.legend } },
        },
      },
    });
  }

  // 2) Priority Breakdown — Horizontal Bar
  const prioOrder = ['Highest', 'Critical', 'Blocker', 'High', 'Medium', 'Low', 'Lowest', 'Trivial', 'None'];
  const prioEntries = prioOrder
    .filter(p => m.priorityMap[p])
    .map(p => [p, m.priorityMap[p]]);
  Object.keys(m.priorityMap).forEach(p => {
    if (!prioOrder.includes(p)) prioEntries.push([p, m.priorityMap[p]]);
  });

  if (prioEntries.length > 0) {
    charts.priority = new Chart(document.getElementById('priorityChart'), {
      type: 'bar',
      data: {
        labels: prioEntries.map(e => e[0]),
        datasets: [{
          data: prioEntries.map(e => e[1]),
          backgroundColor: prioEntries.map(e => priorityColor(e[0])),
          borderRadius: 6,
          barThickness: 22,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { left: 4, right: 8, bottom: 8 } },
        plugins: { legend: { display: false } },
        scales: {
          x: {
            grid: { color: p.grid },
            ticks: { color: p.tick, font: { size: 10, weight: '600' }, stepSize: 1 },
            border: { color: p.axisBorder },
            beginAtZero: true,
          },
          y: {
            grid: { display: false },
            ticks: { color: p.tick, font: { size: 10, weight: '700' } },
            border: { display: false },
          },
        },
      },
    });
  }

  // 3) Weekly Throughput — Line
  if (m.weeklyThroughput.length > 0) {
    charts.throughput = new Chart(document.getElementById('throughputChart'), {
      type: 'line',
      data: {
        labels: m.weeklyThroughput.map(w => w.label),
        datasets: [{
          data: m.weeklyThroughput.map(w => w.count),
          borderColor: '#c084fc',
          backgroundColor: 'rgba(192,132,252,0.1)',
          fill: true,
          tension: 0.35,
          pointRadius: 5,
          pointBackgroundColor: '#c084fc',
          pointBorderColor: S ? S.pointOutline() : '#0f172a',
          pointBorderWidth: 2,
          pointHoverRadius: 7,
          borderWidth: 2.5,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { bottom: 10 } },
        plugins: { legend: { display: false } },
        scales: {
          y: {
            grid: { color: p.grid },
            ticks: { color: p.tick, font: { size: 10, weight: '600' }, stepSize: 1 },
            beginAtZero: true,
            border: { color: p.axisBorder },
          },
          x: {
            grid: { display: false },
            ticks: { color: p.tick, font: { size: 10, weight: '600' }, maxRotation: 35 },
            border: { color: p.axisBorder },
          },
        },
      },
    });
  }

  // 4) Issue Type Mix — Doughnut
  const typeEntries = Object.entries(m.typeMap).sort((a, b) => b[1] - a[1]);
  if (typeEntries.length > 0) {
    const typeColors = ['#34d399', '#f87171', '#60a5fa', '#c084fc', '#facc15', '#fb923c', '#14b8a6', '#64748b'];
    charts.issueType = new Chart(document.getElementById('issueTypeChart'), {
      type: 'doughnut',
      data: {
        labels: typeEntries.map(e => e[0]),
        datasets: [{
          data: typeEntries.map(e => e[1]),
          backgroundColor: typeEntries.map((_, i) => typeColors[i % typeColors.length]),
          borderWidth: doughnutStroke || 0,
          borderColor: p.doughnutBorder,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { bottom: 4, right: 4 } },
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { font: { size: 10, weight: '600' }, padding: 8, color: p.legend } },
        },
      },
    });
  }
}

function renderAITools(data) {
  const cursor = data.cursor;

  if (cursor && (cursor.total_accepts > 0 || cursor.total_lines_suggested > 0)) {
    document.getElementById('cursorMetrics').classList.remove('hidden');
    document.getElementById('cursorNoData').classList.add('hidden');

    document.getElementById('cursorRank').textContent = `#${cursor.rank || '—'}`;
    document.getElementById('cursorAccepts').textContent = cursor.total_accepts || 0;
    document.getElementById('cursorLinesAccepted').textContent = (cursor.total_lines_accepted || 0).toLocaleString();
    document.getElementById('cursorLinesSuggested').textContent = (cursor.total_lines_suggested || 0).toLocaleString();

    const acceptRate = cursor.line_acceptance_ratio
      ? (cursor.line_acceptance_ratio * 100).toFixed(1) + '%'
      : '0%';
    document.getElementById('cursorAcceptRate').textContent = acceptRate;
    document.getElementById('cursorAcceptBarFill').style.width = (cursor.line_acceptance_ratio || 0) * 100 + '%';

    const statusEl = document.getElementById('cursorStatus');
    if (cursor.total_accepts > 50) {
      statusEl.textContent = 'Power User';
      statusEl.style.cssText = 'background: rgba(16,185,129,0.15); color: #34d399;';
    } else if (cursor.total_accepts > 10) {
      statusEl.textContent = 'Active';
      statusEl.style.cssText = 'background: rgba(59,130,246,0.15); color: #60a5fa;';
    } else if (cursor.total_lines_suggested > 0) {
      statusEl.textContent = 'Getting Started';
      statusEl.style.cssText = 'background: rgba(234,179,8,0.15); color: #facc15;';
    } else {
      statusEl.textContent = 'Onboarding';
      statusEl.style.cssText = 'background: rgba(100,116,139,0.15); color: #94a3b8;';
    }
  } else {
    document.getElementById('cursorMetrics').classList.add('hidden');
    document.getElementById('cursorNoData').classList.remove('hidden');
  }

  // Sprint AI data
  const sprints = data.sprints || [];
  const aiSprints = sprints.filter(s => s.individual?.aiUsageLevel != null);

  if (aiSprints.length > 0) {
    document.getElementById('sprintAiMetrics').classList.remove('hidden');
    document.getElementById('sprintAiNoData').classList.add('hidden');

    const latest = aiSprints[aiSprints.length - 1];
    const level = latest.individual.aiUsageLevel;
    document.getElementById('aiUsageLevel').textContent = level + ' / 5';

    const starsHtml = Array.from({ length: 5 }, (_, i) =>
      `<svg class="ai-star ${i < level ? 'filled' : ''}" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>`
    ).join('');
    document.getElementById('aiStars').innerHTML = starsHtml;

    if (aiSprints.length > 1) {
      const tbody = document.getElementById('sprintAiBody');
      tbody.innerHTML = '';
      aiSprints.forEach(s => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-800/30 transition-colors';
        tr.innerHTML = `
          <td class="tbl-td mono font-bold text-purple-400">${esc(s.sprintName)}</td>
          <td class="tbl-td text-center mono font-bold">${s.individual.aiUsageLevel}/5</td>
          <td class="tbl-td text-slate-500">${esc(s.individual.aiNotes || '—')}</td>
        `;
        tbody.appendChild(tr);
      });
      document.getElementById('sprintAiTable').classList.remove('hidden');
    }
  } else {
    document.getElementById('sprintAiMetrics').classList.add('hidden');
    document.getElementById('sprintAiNoData').classList.remove('hidden');
  }
}

function renderSprintPerformance(data) {
  const sprints = data.sprints || [];
  const wrap = document.getElementById('sprintPerfWrap');
  const tbody = document.getElementById('sprintPerfBody');
  if (!wrap || !tbody) return;
  tbody.innerHTML = '';

  if (sprints.length === 0) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');

  sprints.forEach(s => {
    const ind = s.individual || {};
    const conf = ind.confluence || {};
    const docsTotal = (Number(conf.pagesCreated) || 0) + (Number(conf.pagesEdited) || 0);
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/30 transition-colors';
    const trendClass = ind.trend === '?' ? 'trend-up' : ind.trend === '?' ? 'trend-down' : 'trend-flat';
    const statusClass = s.status === 'Active' ? 'done' : s.status === 'Closed' ? 'wip' : '';
    const docsClass = docsTotal > 0 ? 'text-orange-400' : 'text-slate-600';
    tr.innerHTML = `
      <td class="tbl-td mono font-bold text-purple-400">${esc(s.sprintName)}</td>
      <td class="tbl-td">${esc(s.product || '—')}</td>
      <td class="tbl-td text-center mono font-bold">${ind.storyPoints ?? '—'}</td>
      <td class="tbl-td text-center mono font-bold">${ind.ticketsClosed ?? '—'}</td>
      <td class="tbl-td text-center text-lg ${trendClass}">${esc(ind.trend || '—')}</td>
      <td class="tbl-td text-center mono">${ind.aiUsageLevel != null ? ind.aiUsageLevel + '/5' : '—'}</td>
      <td class="tbl-td text-center mono ${docsClass}">${docsTotal}</td>
      <td class="tbl-td"><span class="status-pill ${statusClass}">${esc(s.status || '—')}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

function renderOpenTickets(m) {
  const wrap = document.getElementById('openTicketsWrap');
  const tbody = document.getElementById('openTicketsBody');
  const noMsg = document.getElementById('noOpenMsg');
  if (!wrap || !tbody) return;
  tbody.innerHTML = '';
  wrap.classList.remove('hidden');

  if (m.openTableRows.length === 0) {
    noMsg.classList.remove('hidden');
    return;
  }
  noMsg.classList.add('hidden');

  m.openTableRows.forEach(row => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/30 transition-colors';
    const prioClass = row.priority.toLowerCase().replace(/\s+/g, '');
    const typeClass = row.type.toLowerCase().replace(/[\s-]+/g, '');
    const statusPillClass = row.statusClass === 'in_progress' ? 'wip' : row.statusClass;
    tr.innerHTML = `
      <td class="tbl-td key-cell">${esc(row.key)}</td>
      <td class="tbl-td summary-cell" title="${esc(row.summary)}">${esc(row.summary)}</td>
      <td class="tbl-td"><span class="type-pill ${typeClass}">${esc(row.type)}</span></td>
      <td class="tbl-td"><span class="priority-pill ${prioClass}">${esc(row.priority)}</span></td>
      <td class="tbl-td"><span class="status-pill ${statusPillClass}">${esc(row.status)}</span></td>
      <td class="tbl-td mono font-bold ${row.age > 14 ? 'text-red-400' : row.age > 7 ? 'text-amber-400' : 'text-slate-400'}">${row.age}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderCompletedTickets(m) {
  const wrap = document.getElementById('completedTicketsWrap');
  const tbody = document.getElementById('completedTicketsBody');
  const noMsg = document.getElementById('noCompletedMsg');
  if (!wrap || !tbody) return;
  tbody.innerHTML = '';
  wrap.classList.remove('hidden');

  if (m.completedTableRows.length === 0) {
    noMsg.classList.remove('hidden');
    return;
  }
  noMsg.classList.add('hidden');

  m.completedTableRows.forEach(row => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/30 transition-colors';
    const prioClass = row.priority.toLowerCase().replace(/\s+/g, '');
    const typeClass = row.type.toLowerCase().replace(/[\s-]+/g, '');
    const ctDisplay = row.cycleTime !== null ? row.cycleTime.toFixed(1) + 'd' : '—';
    const ctColor = row.cycleTime === null ? 'text-slate-600' : row.cycleTime <= 3 ? 'text-emerald-400' : row.cycleTime <= 7 ? 'text-amber-400' : 'text-red-400';
    // Status badge colour — distinguish the different "done" stages at a glance
    const statusLc = (row.status || '').toLowerCase();
    let statusColor;
    if (statusLc === 'closed' || statusLc === 'done' || statusLc === 'resolved') {
      statusColor = 'background:rgba(16,185,129,0.15);color:#34d399;';
    } else if (statusLc === 'ready for staging' || statusLc === 'ready for release') {
      statusColor = 'background:rgba(59,130,246,0.15);color:#60a5fa;';
    } else if (statusLc === 'staging') {
      statusColor = 'background:rgba(139,92,246,0.15);color:#a78bfa;';
    } else if (statusLc === 'cancelled' || statusLc === 'canceled') {
      statusColor = 'background:rgba(100,116,139,0.15);color:#94a3b8;';
    } else {
      statusColor = 'background:rgba(234,179,8,0.15);color:#facc15;';
    }
    tr.innerHTML = `
      <td class="tbl-td key-cell">${esc(row.key)}</td>
      <td class="tbl-td summary-cell" title="${esc(row.summary)}">${esc(row.summary)}</td>
      <td class="tbl-td"><span class="type-pill ${typeClass}">${esc(row.type)}</span></td>
      <td class="tbl-td"><span class="priority-pill ${prioClass}">${esc(row.priority)}</span></td>
      <td class="tbl-td"><span style="${statusColor}font-size:0.7rem;font-weight:600;padding:2px 8px;border-radius:9999px;white-space:nowrap;">${esc(row.status)}</span></td>
      <td class="tbl-td mono font-bold ${ctColor}">${ctDisplay}</td>
    `;
    tbody.appendChild(tr);
  });
}

// --------------------------------------------------------------
//  HELPERS
// --------------------------------------------------------------

const STATUS_PALETTE = [
  '#a78bfa', '#3b82f6', '#f59e0b', '#22c55e', '#06b6d4',
  '#ec4899', '#f97316', '#14b8a6', '#8b5cf6', '#64748b',
];

function priorityColor(name) {
  const lc = (name || '').toLowerCase();
  if (lc === 'highest' || lc === 'critical' || lc === 'blocker') return '#ef4444';
  if (lc === 'high')   return '#f97316';
  if (lc === 'medium') return '#eab308';
  if (lc === 'low')    return '#3b82f6';
  if (lc === 'lowest' || lc === 'trivial') return '#6b7280';
  return '#8b5cf6';
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function showLoader()  { loader.classList.remove('hidden'); }
function hideLoader()  { loader.classList.add('hidden'); }
function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}
function hideError() { errorBox.classList.add('hidden'); }

// -- Table sort --
document.querySelector('[data-sort="open-age"]')?.addEventListener('click', () => {
  const tbody = document.getElementById('openTicketsBody');
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr'));
  const dir = tbody.dataset.sortDir === 'asc' ? 'desc' : 'asc';
  tbody.dataset.sortDir = dir;
  rows.sort((a, b) => {
    const aVal = parseInt(a.cells[5]?.textContent) || 0;
    const bVal = parseInt(b.cells[5]?.textContent) || 0;
    return dir === 'asc' ? aVal - bVal : bVal - aVal;
  });
  rows.forEach(r => tbody.appendChild(r));
});
