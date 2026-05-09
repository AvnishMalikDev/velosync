/**
 * Dashboard scoring config:
 * - Canonical file: jira-md-export/Template/dashboard-scoring.template.json
 * - Optional overrides: jira-md-export/dashboard-scoring.json (merged on top when non-empty)
 * Admin "Save" writes the normalized config to the template and clears the overrides file.
 */
const fs = require('fs');
const path = require('path');

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v != null && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] != null && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function templatePath(productRoot) {
  return path.join(productRoot, 'jira-md-export', 'Template', 'dashboard-scoring.template.json');
}

function livePath(productRoot) {
  return path.join(productRoot, 'jira-md-export', 'dashboard-scoring.json');
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readTemplate(productRoot) {
  const p = templatePath(productRoot);
  const data = readJsonSafe(p, null);
  if (!data || typeof data !== 'object') {
    throw new Error(`Missing or invalid dashboard scoring template: ${p}`);
  }
  return data;
}

function readLiveOverrides(productRoot) {
  return readJsonSafe(livePath(productRoot), {});
}

/** Effective config for dashboards (template merged with live file). */
function readDashboardScoring(productRoot) {
  const template = readTemplate(productRoot);
  const live = readLiveOverrides(productRoot);
  const merged =
    !live || typeof live !== 'object' || Object.keys(live).length === 0
      ? template
      : deepMerge(template, live);
  return validateAndNormalize(merged);
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.dash-score.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function num(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * Merge legacy devDataMain/devDataDetail/qaDataMain/qaDataDetail into devData + qaData.
 * Later keys win (live overrides on top of template).
 */
function migrateLegacyDashboardScoring(body) {
  if (!body || typeof body !== 'object') return {};
  const t = deepMerge({}, body);

  t.devData = deepMerge(deepMerge({}, t.devData || {}), t.devDataMain || {});

  const qa = deepMerge({}, t.qaData || {});
  const wMerged = deepMerge(
    deepMerge({}, (t.qaDataMain || {}).weights || {}),
    (t.qaDataDetail || {}).weights || {},
  );
  qa.weights = deepMerge(wMerged, qa.weights || {});
  qa.displayTiers = deepMerge(deepMerge({}, (t.qaDataMain || {}).displayTiers || {}), qa.displayTiers || {});
  const bt = (t.qaDataDetail || {}).bandTiers || {};
  const btNorm = {};
  if (bt.stellarMin != null) btNorm.stellarMin = bt.stellarMin;
  if (bt.surgeMin != null) btNorm.surgeMin = bt.surgeMin;
  if (bt.cruiseMin != null) btNorm.cruiseMin = bt.cruiseMin;
  qa.bands = deepMerge(btNorm, qa.bands || {});

  t.devData = t.devData || {};
  t.qaData = qa;
  delete t.devDataMain;
  delete t.devDataDetail;
  delete t.qaDataMain;
  delete t.qaDataDetail;
  return t;
}

function validateAndNormalize(body) {
  const template = migrateLegacyDashboardScoring(body);
  if (template.version == null) template.version = 1;

  const hm = template.healthMatrix || {};
  hm.weights = hm.weights || {};
  const wk = [
    'DELIVERY_WEIGHT',
    'FLOW_WEIGHT',
    'STABILITY_WEIGHT',
    'QUALITY_WEIGHT',
    'RISK_WEIGHT',
    'AI_ADOPTION_WEIGHT',
  ];
  for (const k of wk) {
    hm.weights[k] = num(hm.weights[k], 0, 1, 0);
  }
  hm.benchmarks = hm.benchmarks || {};
  const b = hm.benchmarks;
  b.COMPOSITE_ELITE = num(b.COMPOSITE_ELITE, 50, 100, 85);
  b.COMPOSITE_STRONG = num(b.COMPOSITE_STRONG, 30, 99, 70);
  b.COMPOSITE_STABLE = num(b.COMPOSITE_STABLE, 20, 95, 55);
  b.COMPOSITE_AT_RISK = num(b.COMPOSITE_AT_RISK, 0, 90, 40);
  if (b.COMPOSITE_ELITE <= b.COMPOSITE_STRONG) {
    throw new Error('Health matrix: COMPOSITE_ELITE must be greater than COMPOSITE_STRONG');
  }
  if (b.COMPOSITE_STRONG <= b.COMPOSITE_STABLE) {
    throw new Error('Health matrix: COMPOSITE_STRONG must be greater than COMPOSITE_STABLE');
  }
  if (b.COMPOSITE_STABLE <= b.COMPOSITE_AT_RISK) {
    throw new Error('Health matrix: COMPOSITE_STABLE must be greater than COMPOSITE_AT_RISK');
  }
  b.CYCLE_ELITE_DAYS = num(b.CYCLE_ELITE_DAYS, 1, 120, 12);
  b.CYCLE_STRONG_DAYS = num(b.CYCLE_STRONG_DAYS, 1, 180, 21);
  b.CYCLE_POOR_DAYS = num(b.CYCLE_POOR_DAYS, 1, 365, 52);
  b.CARRYOVER_GOOD_MAX = num(b.CARRYOVER_GOOD_MAX, 0, 100, 10);
  b.CARRYOVER_POOR_MIN = num(b.CARRYOVER_POOR_MIN, 0, 100, 30);
  b.BUGFIX_GOOD_MIN = num(b.BUGFIX_GOOD_MIN, 0, 100, 80);
  b.BUGFIX_POOR_MAX = num(b.BUGFIX_POOR_MAX, 0, 100, 50);
  b.COMPLETION_ELITE = num(b.COMPLETION_ELITE, 0, 100, 90);
  b.COMPLETION_STRONG = num(b.COMPLETION_STRONG, 0, 100, 80);
  b.COMPLETION_STABLE = num(b.COMPLETION_STABLE, 0, 100, 70);
  b.COMPLETION_AT_RISK = num(b.COMPLETION_AT_RISK, 0, 100, 50);
  template.healthMatrix = hm;

  const dm = template.devData || {};
  dm.combinedToolsMaxWeight = num(dm.combinedToolsMaxWeight, 0, 0.5, 0.24);
  dm.weights = dm.weights || {};
  const dwKeys = [
    'DELIVERY',
    'GITHUB_IMPACT',
    'GITHUB_QUALITY',
    'CONSISTENCY',
    'IMPACT_BREADTH',
    'CONFLUENCE_DOCS',
    'CURSOR_LEADERBOARD',
    'COPILOT_INDIVIDUAL',
    'AI_TOOLS_ADOPTION',
  ];
  for (const k of dwKeys) {
    dm.weights[k] = num(dm.weights[k], 0, 1, 0);
  }
  dm.displayTiers = dm.displayTiers || {};
  dm.displayTiers.goodMin = num(dm.displayTiers.goodMin, 0, 10, 8);
  dm.displayTiers.midMin = num(dm.displayTiers.midMin, 0, 10, 5);
  dm.displayTiers.lowMin = num(dm.displayTiers.lowMin, 0, 10, 3);
  if (dm.displayTiers.midMin >= dm.displayTiers.goodMin) {
    throw new Error('Dev data: mid score tier must be less than good tier');
  }
  if (dm.displayTiers.lowMin >= dm.displayTiers.midMin) {
    throw new Error('Dev data: low tier must be less than mid tier');
  }
  template.devData = dm;

  const qa = template.qaData || {};
  qa.weights = qa.weights || {};
  const qmk = ['VOLUME', 'COVERAGE', 'AUTHORSHIP', 'CONSISTENCY', 'COMPLEXITY', 'DOCS'];
  const qaWeightDefaults = {
    VOLUME: 0.4,
    COVERAGE: 0.3,
    AUTHORSHIP: 0.1,
    CONSISTENCY: 0.05,
    COMPLEXITY: 0.1,
    DOCS: 0.05,
  };
  for (const k of qmk) {
    qa.weights[k] = num(qa.weights[k], 0, 1, 0);
  }
  let qmsum = qmk.reduce((s, k) => s + qa.weights[k], 0);
  if (qmsum <= 0) {
    for (const k of qmk) {
      qa.weights[k] = num(qaWeightDefaults[k], 0, 1, qaWeightDefaults[k]);
    }
    qmsum = qmk.reduce((s, k) => s + qa.weights[k], 0);
  }
  if (qmsum <= 0) throw new Error('QA data: weights must sum to a positive value');
  qa.displayTiers = qa.displayTiers || {};
  qa.displayTiers.goodMin = num(qa.displayTiers.goodMin, 0, 10, 8);
  qa.displayTiers.midMin = num(qa.displayTiers.midMin, 0, 10, 5);
  if (qa.displayTiers.midMin >= qa.displayTiers.goodMin) {
    throw new Error('QA data: mid tier must be less than good tier');
  }
  qa.bands = qa.bands || {};
  qa.bands.stellarMin = num(qa.bands.stellarMin, 0, 100, 90);
  qa.bands.surgeMin = num(qa.bands.surgeMin, 0, 100, 70);
  qa.bands.cruiseMin = num(qa.bands.cruiseMin, 0, 100, 50);
  if (qa.bands.surgeMin >= qa.bands.stellarMin) {
    throw new Error('QA data: Surge threshold must be below Stellar');
  }
  if (qa.bands.cruiseMin >= qa.bands.surgeMin) {
    throw new Error('QA data: Cruise threshold must be below Surge');
  }
  template.qaData = qa;

  return template;
}

function liveOverridesActive(productRoot) {
  const p = livePath(productRoot);
  if (!fs.existsSync(p)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data != null && typeof data === 'object' && Object.keys(data).length > 0;
  } catch {
    return false;
  }
}

/** Persist admin edits to the template (versioned defaults) and reset optional live overrides. */
function writeDashboardScoring(productRoot, body) {
  const normalized = validateAndNormalize(body);
  atomicWriteJson(templatePath(productRoot), normalized);
  atomicWriteJson(livePath(productRoot), {});
  return normalized;
}

function pathRelativeToProduct(productRoot, absolutePath) {
  const rel = path.relative(productRoot, absolutePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return path.basename(path.dirname(absolutePath)) + '/' + path.basename(absolutePath);
  }
  return rel.split(path.sep).join('/');
}

module.exports = {
  readDashboardScoring,
  readTemplate,
  writeDashboardScoring,
  validateAndNormalize,
  liveOverridesActive,
  templatePath,
  livePath,
  pathRelativeToProduct,
};
