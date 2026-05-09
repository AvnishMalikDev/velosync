/**
 * Fetches /api/dashboard-scoring and applies to DashboardConstants + Dev Data weights on the main dashboard.
 */
(function (global) {
  function mergeHealth(cfg) {
    const DC = global.DashboardConstants;
    if (!DC) return;
    const hm = cfg.healthMatrix || {};
    if (hm.weights && DC.RATING_WEIGHTS) Object.assign(DC.RATING_WEIGHTS, hm.weights);
    if (hm.benchmarks && DC.RATING_BENCHMARKS) Object.assign(DC.RATING_BENCHMARKS, hm.benchmarks);
  }

  function applyDashboardScoringConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    global.DashboardScoringRuntime = {
      raw: cfg,
      healthMatrix: cfg.healthMatrix || {},
      devData: cfg.devData || {},
      qaData: cfg.qaData || {},
    };
    mergeHealth(cfg);
    if (typeof global.applyresourceScoreWeightsFromServer === 'function') {
      global.applyresourceScoreWeightsFromServer(cfg.devData || {});
    }
    if (typeof global.refreshHealthScoringUIFromServer === 'function') {
      global.refreshHealthScoringUIFromServer();
    }
  }

  global.applyDashboardScoringConfig = applyDashboardScoringConfig;

  global.fetchDashboardScoring = async function fetchDashboardScoring() {
    const r = await fetch(`/api/dashboard-scoring?_=${Date.now()}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!r.ok) throw new Error(`Scoring config HTTP ${r.status}`);
    const cfg = await r.json();
    applyDashboardScoringConfig(cfg);
    return cfg;
  };
})(typeof window !== 'undefined' ? window : this);
