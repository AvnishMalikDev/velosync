/**
 * Shared constants for the dashboard (index and project-detail).
 */
(function (global) {
    const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#ef4444'];

    const PIE_TITLES = {
        piePoints: 'Story Points',
        pieCompletion: 'Sprint Completion',
        pieCycle: 'Review Cycle',
        pieBugFix: 'Bug Fix Rate',
        pieDefectDensity: 'Defect Density',
        pieThroughput: 'Throughput',
    };

    /** Star-band labels for portfolio filter & health UI (innovative tier names). */
    const RATING_LABELS = {
        5: { text: 'Stellar', class: 'border-elite' },
        4: { text: 'Surge', class: 'border-strong' },
        3: { text: 'Cruise', class: 'border-stable' },
        2: { text: 'Friction', class: 'border-risk' },
        1: { text: 'Breach', class: 'border-critical' },
    };

    const AI_MODELS = [
        { value: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
        { value: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
        { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
        { value: 'meta-llama/llama-3.1-70b-instruct', label: 'Llama 3.1 70B' },
    ];

    const DEFAULT_AI_MODEL = 'google/gemini-2.0-flash-001';

    const SCORE_THRESHOLDS = {
        COMPLETION_ELITE: 90,
        COMPLETION_STRONG: 80,
        COMPLETION_STABLE: 65,
        COMPLETION_AT_RISK: 45,
        CYCLE_ELITE: 12,
        CYCLE_STRONG: 21,
        DEFAULT_CYCLE: 25,
    };

    /**
     * Industry-aligned sprint health rating (weighted composite).
     * Based on: predictability (completion), flow (cycle time), stability (carry-over),
     * quality (bug fix rate), risk (blockers), and AI adoption. Composite 0–100 mapped to 1–5 stars.
     */
    const RATING_WEIGHTS = {
        DELIVERY_WEIGHT: 0.45,     // Sprint completion % (predictability)
        FLOW_WEIGHT: 0.10,         // Cycle time (speed)
        STABILITY_WEIGHT: 0.10,    // Carry-over % (planning / rollover)
        QUALITY_WEIGHT: 0.20,      // Bug fix rate (closed/opened)
        RISK_WEIGHT: 0.05,         // Blockers (impediments)
        AI_ADOPTION_WEIGHT: 0.10,  // Cursor/AI adoption signal
    };

    const RATING_BENCHMARKS = {
        // Completion % (Scrum/SAFe: ≥90 excellent, ≥80 strong, ≥70 stable, ≥50 at risk)
        COMPLETION_ELITE: 90,
        COMPLETION_STRONG: 80,
        COMPLETION_STABLE: 70,
        COMPLETION_AT_RISK: 50,
        // Cycle time (days): lower is better; elite ≤12 (P25), strong ≤21 (P50), at risk ≤52 (P75), poor >52
        // Data-driven thresholds from 30-day JIRA analysis (Apr 2026, 732 tickets across 7 projects)
        CYCLE_ELITE_DAYS: 12,
        CYCLE_STRONG_DAYS: 21,
        CYCLE_POOR_DAYS: 52,
        // Carry-over % (industry: <10% good, 10–20% watch, >20% at risk)
        CARRYOVER_GOOD_MAX: 10,
        CARRYOVER_POOR_MIN: 30,
        // Bug fix rate % (closed/opened): ≥80 good, <50 concerning)
        BUGFIX_GOOD_MIN: 80,
        BUGFIX_POOR_MAX: 50,
        // Composite score bands → star rating (0–100 → 1–5)
        COMPOSITE_ELITE: 85,
        COMPOSITE_STRONG: 70,
        COMPOSITE_STABLE: 55,
        COMPOSITE_AT_RISK: 40,
    };

    global.DashboardConstants = {
        PIE_COLORS,
        PIE_TITLES,
        RATING_LABELS,
        AI_MODELS,
        DEFAULT_AI_MODEL,
        SCORE_THRESHOLDS,
        RATING_WEIGHTS,
        RATING_BENCHMARKS,
    };
})(typeof window !== 'undefined' ? window : this);
