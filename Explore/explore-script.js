/* ================================================================
   Explore JIRA Dashboard — explore-script.js
   Fetches board data via /api/jira/explore, computes Ops/IT
   performance metrics, and renders Chart.js visualizations.
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
const IN_PROGRESS_NAMES = new Set([
  'in progress', 'in development', 'in-progress', 'in dev', 'coding',
  'implementation', 'developing', 'active', 'working', 'started'
]);
const DONE_NAMES = new Set([
  'done', 'closed', 'canceled', 'cancelled', 'resolved', 'released', 'completed', 'deployed',
  'accepted', 'production', 'ready for production', 'ready for prod',
  'ready for release', 'ready for staging', 'staging', 'release',
  'in staging', 'in release', 'delivered', 'verified'
]);

function classifyStatus(statusName, categoryKey) {
  const lc = (statusName || '').toLowerCase().trim();
  // Name-based sets before JIRA category so post-handoff statuses (e.g. Staging) are not
  // misclassified as in_progress when the workflow maps them to indeterminate.
  if (DONE_NAMES.has(lc)) return 'done';
  if (IN_PROGRESS_NAMES.has(lc)) return 'in_progress';
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

// -- DOM References --
const boardUrlInput    = document.getElementById('boardUrl');
const analyzeBtn       = document.getElementById('analyzeBtn');
const loader           = document.getElementById('loader');
const errorBox         = document.getElementById('errorBox');
const metricsSection   = document.getElementById('metricsSection');
const projectBadge     = document.getElementById('projectBadge');
const totalBadge       = document.getElementById('totalBadge');

// KPI elements
const kpiOpen          = document.getElementById('kpiOpen');
const kpiOpenSub       = document.getElementById('kpiOpenSub');
const kpiCritical      = document.getElementById('kpiCritical');
const kpiCriticalSub   = document.getElementById('kpiCriticalSub');
const kpiCycleTime     = document.getElementById('kpiCycleTime');
const kpiCycleTimeSub  = document.getElementById('kpiCycleTimeSub');
const kpiThroughput    = document.getElementById('kpiThroughput');
const kpiThroughputSub = document.getElementById('kpiThroughputSub');

// Chart canvases
const canvasIds = ['statusChart','priorityChart','cycleTimeChart','agingChart','workloadChart','throughputChart'];
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

// -- Event Listeners --
analyzeBtn.addEventListener('click', analyze);
boardUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });

// -- Progress UI elements --
const loaderStep    = document.getElementById('loaderStep');
const progressBar   = document.getElementById('progressBar');
const loaderDetail  = document.getElementById('loaderDetail');
const loaderPercent = document.getElementById('loaderPercent');

function updateProgress(step, percent, detail) {
  if (loaderStep)    loaderStep.textContent = step;
  if (progressBar)   progressBar.style.width = percent + '%';
  if (loaderDetail)  loaderDetail.textContent = detail || '';
  if (loaderPercent) loaderPercent.textContent = percent + '%';
}

function resetProgress() {
  updateProgress('Connecting to JIRA\u2026', 0, '');
}

// -- Main Flow --
async function analyze() {
  const url = boardUrlInput.value.trim();
  if (!url) return showError('Please enter a JIRA board URL.');

  if (!/projects\/[A-Z0-9]+\/boards\/\d+/i.test(url)) {
    return showError('Invalid URL format. Expected something like: .../projects/SE/boards/161');
  }

  resetProgress();
  showLoader();
  hideError();
  metricsSection.classList.add('hidden');

  const days = selectedDays;

  try {
    const resp = await fetch('/api/jira/explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boardUrl: url, days }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let msg = `JIRA returned HTTP ${resp.status}`;
      try { const j = JSON.parse(text); msg = j.error?.message || j.error || msg; } catch (_) {}
      throw new Error(msg);
    }

    // Read NDJSON stream for real-time progress
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

    if (!finalData || !finalData.issues || finalData.issues.length === 0) {
      throw new Error('No issues found for this project in the last 30 days.');
    }

    const metrics = computeMetrics(finalData.issues, days);
    render(finalData, metrics, days);
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

function computeMetrics(issues, days = 30) {
  const now = new Date();
  const openIssues = issues.filter(i => !isDone(i));
  const resolvedIssues = issues.filter(i => isDone(i));

  // --- Status distribution ---
  const statusMap = {};
  issues.forEach(i => {
    const name = i.fields?.status?.name || 'Unknown';
    statusMap[name] = (statusMap[name] || 0) + 1;
  });

  // --- Priority distribution ---
  const priorityMap = {};
  issues.forEach(i => {
    const name = i.fields?.priority?.name || 'None';
    priorityMap[name] = (priorityMap[name] || 0) + 1;
  });

  // --- Critical/High open ---
  const critHighNames = new Set(['highest', 'critical', 'high', 'blocker']);
  const critHighOpen = openIssues.filter(i => {
    const p = (i.fields?.priority?.name || '').toLowerCase();
    return critHighNames.has(p);
  });

  // --- Cycle times (from changelog) ---
  const cycleTimes = [];
  resolvedIssues.forEach(i => {
    const ct = computeCycleTime(i);
    if (ct !== null && ct >= 0) cycleTimes.push(ct);
  });

  const avgCycleTime = cycleTimes.length
    ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length
    : null;

  // --- Aging of open tickets ---
  const agingDays = openIssues.map(i => {
    const created = new Date(i.fields?.created);
    return Math.max(0, (now - created) / (1000 * 60 * 60 * 24));
  });

  // --- Weekly throughput ---
  const numWeeks = Math.max(4, Math.floor(days / 7));
  const weeklyThroughput = computeWeeklyThroughput(resolvedIssues, now, numWeeks);

  // --- Assignee workload (open tickets) ---
  const assigneeMap = {};
  openIssues.forEach(i => {
    const name = i.fields?.assignee?.displayName || 'Unassigned';
    assigneeMap[name] = (assigneeMap[name] || 0) + 1;
  });

  // --- Critical/High open tickets for table ---
  const criticalTableRows = critHighOpen.map(i => ({
    key: i.key,
    summary: i.fields?.summary || '',
    reporter: i.fields?.reporter?.displayName || 'Unknown',
    assignee: i.fields?.assignee?.displayName || 'Unassigned',
    priority: i.fields?.priority?.name || 'None',
    age: Math.round((now - new Date(i.fields?.created)) / (1000 * 60 * 60 * 24)),
    status: i.fields?.status?.name || 'Unknown',
  })).sort((a, b) => b.age - a.age);

  // --- Assignee resolved count (for avg/day) ---
  const assigneeresolvedMap = {};
  resolvedIssues.forEach(i => {
    const name = i.fields?.assignee?.displayName || 'Unassigned';
    assigneeresolvedMap[name] = (assigneeresolvedMap[name] || 0) + 1;
  });

  // --- Per-assignee cycle times ---
  const assigneeCycleTimes = {};
  resolvedIssues.forEach(i => {
    const name = i.fields?.assignee?.displayName || 'Unassigned';
    const ct = computeCycleTime(i);
    if (ct !== null && ct >= 0) {
      if (!assigneeCycleTimes[name]) assigneeCycleTimes[name] = [];
      assigneeCycleTimes[name].push(ct);
    }
  });

  // --- Per-assignee oldest open ticket (days) ---
  const assigneeOldestOpen = {};
  openIssues.forEach(i => {
    const name = i.fields?.assignee?.displayName || 'Unassigned';
    const age = Math.round((now - new Date(i.fields?.created)) / (1000 * 60 * 60 * 24));
    assigneeOldestOpen[name] = Math.max(assigneeOldestOpen[name] || 0, age);
  });

  // --- Per-assignee critical/high open count ---
  const assigneeCritHigh = {};
  critHighOpen.forEach(i => {
    const name = i.fields?.assignee?.displayName || 'Unassigned';
    assigneeCritHigh[name] = (assigneeCritHigh[name] || 0) + 1;
  });

  return {
    days,
    total: issues.length,
    openCount: openIssues.length,
    resolvedCount: resolvedIssues.length,
    critHighOpenCount: critHighOpen.length,
    avgCycleTime,
    cycleTimes,
    statusMap,
    priorityMap,
    agingDays,
    weeklyThroughput,
    assigneeMap,
    assigneeresolvedMap,
    assigneeCycleTimes,
    assigneeOldestOpen,
    assigneeCritHigh,
    criticalTableRows,
  };
}

function computeCycleTime(issue) {
  const histories = issue.changelog?.histories;
  if (!histories || !histories.length) return null;

  let startTime = null;
  let endTime = null;

  const sorted = [...histories].sort((a, b) => new Date(a.created) - new Date(b.created));

  for (const history of sorted) {
    for (const item of history.items) {
      if (item.field !== 'status') continue;
      const toName = (item.toString || '').toLowerCase().trim();
      const toCat = classifyStatusByName(toName);

      if (!startTime && toCat === 'in_progress') {
        startTime = new Date(history.created);
      }
      if (startTime && toCat === 'done') {
        endTime = new Date(history.created);
      }
    }
  }

  if (startTime && endTime) {
    return (endTime - startTime) / (1000 * 60 * 60 * 24);
  }

  // Fallback: use resolution date if we found a start
  if (startTime && issue.fields?.resolutiondate) {
    return (new Date(issue.fields.resolutiondate) - startTime) / (1000 * 60 * 60 * 24);
  }

  return null;
}

function classifyStatusByName(lcName) {
  if (DONE_NAMES.has(lcName)) return 'done';
  if (IN_PROGRESS_NAMES.has(lcName)) return 'in_progress';
  if (/progress|develop|coding|implement|active|review|test|qa/i.test(lcName)) return 'in_progress';
  if (/done|closed|resolv|releas|complet|deploy|accept|stag|prod|deliver|verif/i.test(lcName)) return 'done';
  return 'todo';
}

function computeWeeklyThroughput(resolvedIssues, now, numWeeks = 4) {
  const weeks = [];
  for (let w = numWeeks - 1; w >= 0; w--) {
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() - w * 7);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 7);

    const count = resolvedIssues.filter(i => {
      const rd = i.fields?.resolutiondate ? new Date(i.fields.resolutiondate) : null;
      if (!rd) return false;
      return rd >= weekStart && rd < weekEnd;
    }).length;

    const label = `${weekStart.getDate()}/${weekStart.getMonth()+1}`;
    weeks.push({ label: `Week of ${label}`, count });
  }
  return weeks;
}

// --------------------------------------------------------------
//  RENDERING
// --------------------------------------------------------------

function render(data, m, days = 30) {
  // Badges
  projectBadge.textContent = `Project: ${data.projectKey}`;
  totalBadge.textContent = `${m.total} issues found`;
  const daysBadge = document.getElementById('daysBadge');
  if (daysBadge) daysBadge.textContent = `LAST ${days} DAYS`;

  // KPI cards
  kpiOpen.textContent = m.openCount;
  kpiOpenSub.textContent = `of ${m.total} total issues`;
  kpiCritical.textContent = m.critHighOpenCount;
  kpiCriticalSub.textContent = m.critHighOpenCount === 0 ? 'All clear' : `Needs attention`;
  kpiCycleTime.textContent = m.avgCycleTime !== null ? m.avgCycleTime.toFixed(1) + 'd' : 'N/A';
  kpiCycleTimeSub.textContent = m.cycleTimes.length ? `Based on ${m.cycleTimes.length} resolved tickets` : 'No resolved tickets with transition data';
  kpiThroughput.textContent = m.resolvedCount;
  kpiThroughputSub.textContent = `Tickets resolved in ${days} days`;

  renderCharts(m);
  renderTable(m);
  renderAssigneeStats(m);
}

function destroyCharts() {
  Object.values(charts).forEach(c => c.destroy());
  charts = {};
}

function renderCharts(m) {
  destroyCharts();

  const S = typeof SatelliteChartTheme !== 'undefined' ? SatelliteChartTheme : null;
  const p = S ? S.palette() : {
    tick: '#e2e8f0', legend: '#e2e8f0', doughnutBorder: 'rgba(15,23,42,0.45)',
    grid: 'rgba(148,163,184,0.22)', gridFaint: 'rgba(148,163,184,0.12)', axisBorder: 'rgba(148,163,184,0.3)',
  };
  const doughnutStroke = S && S.isLight() ? 1 : 0;

  // 1) Status Distribution — Doughnut
  const statusEntries = Object.entries(m.statusMap).sort((a, b) => b[1] - a[1]);
  charts.status = new Chart(document.getElementById('statusChart'), {
    type: 'doughnut',
    data: {
      labels: statusEntries.map(e => e[0]),
      datasets: [{
        data: statusEntries.map(e => e[1]),
        backgroundColor: statusEntries.map((_, i) => statusColor(i)),
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

  // 2) Priority Breakdown — Horizontal Bar
  const prioOrder = ['Highest', 'Critical', 'Blocker', 'High', 'Medium', 'Low', 'Lowest', 'Trivial', 'None'];
  const prioEntries = prioOrder
    .filter(p => m.priorityMap[p])
    .map(p => [p, m.priorityMap[p]]);
  // Add any priorities not in our ordered list
  Object.keys(m.priorityMap).forEach(p => {
    if (!prioOrder.includes(p)) prioEntries.push([p, m.priorityMap[p]]);
  });

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
          ticks: { color: p.tick, font: { size: 10, weight: '600' } },
          border: { color: p.axisBorder },
        },
        y: {
          grid: { display: false },
          ticks: { color: p.tick, font: { size: 10, weight: '700' } },
          border: { display: false },
        },
      },
    },
  });

  // 3) Cycle Time Distribution — Bar
  const ctBuckets = bucketize(m.cycleTimes, [1, 3, 7, 14], ['< 1 day', '1–3 days', '3–7 days', '7–14 days', '14+ days']);
  const ctColors = ['#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444'];
  charts.cycleTime = new Chart(document.getElementById('cycleTimeChart'), {
    type: 'bar',
    data: {
      labels: ctBuckets.map(b => b.label),
      datasets: [{
        data: ctBuckets.map(b => b.count),
        backgroundColor: ctColors.slice(0, ctBuckets.length),
        borderRadius: 6,
        barThickness: 36,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { bottom: 12 } },
      plugins: { legend: { display: false } },
      scales: {
        y: {
          grid: { color: p.grid },
          ticks: { color: p.tick, font: { size: 10, weight: '600' }, stepSize: 1 },
          border: { color: p.axisBorder },
          beginAtZero: true,
        },
        x: {
          grid: { display: false },
          ticks: { color: p.tick, font: { size: 10, weight: '600' }, maxRotation: 40 },
          border: { color: p.axisBorder },
        },
      },
    },
  });

  // 4) Aging of Open Tickets — Bar
  const ageBuckets = bucketize(m.agingDays, [3, 7, 14, 30], ['< 3 days', '3–7 days', '7–14 days', '14–30 days', '30+ days']);
  const ageColors = ['#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444'];
  charts.aging = new Chart(document.getElementById('agingChart'), {
    type: 'bar',
    data: {
      labels: ageBuckets.map(b => b.label),
      datasets: [{
        data: ageBuckets.map(b => b.count),
        backgroundColor: ageColors.slice(0, ageBuckets.length),
        borderRadius: 6,
        barThickness: 36,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { bottom: 12 } },
      plugins: { legend: { display: false } },
      scales: {
        y: {
          grid: { color: p.grid },
          ticks: { color: p.tick, font: { size: 10, weight: '600' }, stepSize: 1 },
          border: { color: p.axisBorder },
          beginAtZero: true,
        },
        x: {
          grid: { display: false },
          ticks: { color: p.tick, font: { size: 10, weight: '600' }, maxRotation: 40 },
          border: { color: p.axisBorder },
        },
      },
    },
  });

  // 5) Assignee Workload — Horizontal Bar (top 10)
  const assigneeEntries = Object.entries(m.assigneeMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  charts.workload = new Chart(document.getElementById('workloadChart'), {
    type: 'bar',
    data: {
      labels: assigneeEntries.map(e => truncate(e[0], 20)),
      datasets: [{
        data: assigneeEntries.map(e => e[1]),
        backgroundColor: 'rgba(59,130,246,0.6)',
        hoverBackgroundColor: 'rgba(59,130,246,0.85)',
        borderRadius: 6,
        barThickness: 20,
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
          ticks: { color: p.tick, font: { size: 10, weight: '600' } },
          border: { display: false },
        },
      },
    },
  });

  // 6) Weekly Throughput — Line
  charts.throughput = new Chart(document.getElementById('throughputChart'), {
    type: 'line',
    data: {
      labels: m.weeklyThroughput.map(w => w.label),
      datasets: [{
        data: m.weeklyThroughput.map(w => w.count),
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,0.1)',
        fill: true,
        tension: 0.35,
        pointRadius: 5,
        pointBackgroundColor: '#22c55e',
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

function renderTable(m) {
  const tbody = document.getElementById('criticalTableBody');
  const noMsg = document.getElementById('noTicketsMsg');
  tbody.innerHTML = '';

  if (m.criticalTableRows.length === 0) {
    noMsg.classList.remove('hidden');
    return;
  }
  noMsg.classList.add('hidden');

  m.criticalTableRows.forEach(row => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/30 transition-colors';
    const prioClass = row.priority.toLowerCase().replace(/\s+/g, '');
    tr.innerHTML = `
      <td class="tbl-td key-cell">${esc(row.key)}</td>
      <td class="tbl-td summary-cell" title="${esc(row.summary)}">${esc(row.summary)}</td>
      <td class="tbl-td">${esc(row.reporter)}</td>
      <td class="tbl-td">${esc(row.assignee)}</td>
      <td class="tbl-td"><span class="priority-pill ${prioClass}">${esc(row.priority)}</span></td>
      <td class="tbl-td mono font-bold ${row.age > 14 ? 'text-red-400' : row.age > 7 ? 'text-amber-400' : 'text-slate-400'}">${row.age}</td>
      <td class="tbl-td"><span class="status-pill">${esc(row.status)}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

// --------------------------------------------------------------
//  HELPERS
// --------------------------------------------------------------

function bucketize(values, thresholds, labels) {
  const counts = new Array(thresholds.length + 1).fill(0);
  values.forEach(v => {
    let placed = false;
    for (let i = 0; i < thresholds.length; i++) {
      if (v < thresholds[i]) { counts[i]++; placed = true; break; }
    }
    if (!placed) counts[thresholds.length]++;
  });
  return labels.map((label, i) => ({ label, count: counts[i] }));
}

const STATUS_PALETTE = [
  '#3b82f6','#f59e0b','#06b6d4','#22c55e','#8b5cf6',
  '#ec4899','#f97316','#14b8a6','#a855f7','#64748b',
];
function statusColor(i) { return STATUS_PALETTE[i % STATUS_PALETTE.length]; }

function priorityColor(name) {
  const lc = (name || '').toLowerCase();
  if (lc === 'highest' || lc === 'critical' || lc === 'blocker') return '#ef4444';
  if (lc === 'high')   return '#f97316';
  if (lc === 'medium') return '#eab308';
  if (lc === 'low')    return '#3b82f6';
  if (lc === 'lowest' || lc === 'trivial') return '#6b7280';
  return '#8b5cf6';
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
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

// -- Assignee performance scorecard table --
function renderAssigneeStats(m) {
  const wrap = document.getElementById('assigneeStatsWrap');
  const tbody = document.getElementById('assigneeStatsBody');
  if (!wrap || !tbody) return;
  tbody.innerHTML = '';

  const allNames = new Set([
    ...Object.keys(m.assigneeMap),
    ...Object.keys(m.assigneeresolvedMap),
  ]);

  const days = m.days || 30;

  const rows = [...allNames].map(name => {
    const open = m.assigneeMap[name] || 0;
    const resolved = m.assigneeresolvedMap[name] || 0;
    const ctArr = m.assigneeCycleTimes[name] || [];
    const avgCT = ctArr.length ? ctArr.reduce((a, b) => a + b, 0) / ctArr.length : null;
    const total = open + resolved;
    return {
      name,
      open,
      resolved,
      avgPerDay: resolved / days,
      avgCycleTime: avgCT,
      oldestOpen: m.assigneeOldestOpen[name] || 0,
      critHigh: m.assigneeCritHigh[name] || 0,
      resolutionRate: total > 0 ? (resolved / total) * 100 : 0,
    };
  }).sort((a, b) => b.avgPerDay - a.avgPerDay);

  if (rows.length === 0) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');

  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/30 transition-colors';
    const avgColor = r.avgPerDay >= 1 ? 'text-emerald-400' : r.avgPerDay >= 0.3 ? 'text-amber-400' : 'text-slate-500';
    const ctColor = r.avgCycleTime === null ? 'text-slate-600' : r.avgCycleTime <= 3 ? 'text-emerald-400' : r.avgCycleTime <= 7 ? 'text-amber-400' : 'text-red-400';
    const oldColor = r.open === 0 ? 'text-slate-600' : r.oldestOpen > 14 ? 'text-red-400' : r.oldestOpen > 7 ? 'text-amber-400' : 'text-slate-400';
    const critColor = r.critHigh > 0 ? 'text-red-400' : 'text-slate-600';
    const rateColor = r.resolutionRate >= 70 ? 'text-emerald-400' : r.resolutionRate >= 40 ? 'text-amber-400' : 'text-red-400';
    tr.innerHTML = `
      <td class="tbl-td font-medium">${esc(r.name)}</td>
      <td class="tbl-td text-center mono">${r.open}</td>
      <td class="tbl-td text-center mono">${r.resolved}</td>
      <td class="tbl-td text-center mono font-bold ${avgColor}">${r.avgPerDay.toFixed(2)}</td>
      <td class="tbl-td text-center mono font-bold ${ctColor}">${r.avgCycleTime !== null ? r.avgCycleTime.toFixed(1) + 'd' : '—'}</td>
      <td class="tbl-td text-center mono font-bold ${oldColor}">${r.open > 0 ? r.oldestOpen + 'd' : '—'}</td>
      <td class="tbl-td text-center mono font-bold ${critColor}">${r.critHigh > 0 ? r.critHigh : '—'}</td>
      <td class="tbl-td text-center mono font-bold ${rateColor}">${r.resolutionRate.toFixed(0)}%</td>
    `;
    tbody.appendChild(tr);
  });
}

// -- Table sort by age --
document.querySelector('[data-sort="age"]')?.addEventListener('click', () => {
  const tbody = document.getElementById('criticalTableBody');
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
