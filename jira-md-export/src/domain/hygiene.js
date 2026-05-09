/**
 * JIRA hygiene metrics + section markdown.
 *
 * Score = 100 - weighted penalty across six dimensions. Each dimension is
 * `(violatingTickets / totalTickets) × weight × 100`; weights are tuned so
 * Carry-over and Mid-sprint additions count as much as Unestimated tickets
 * (each 0.20), Unresolved blockers half as much (0.10).
 *
 * The section markdown returned by `formatHygieneSectionMd` replaces the
 * `HYGIENE_SECTION` placeholder in the template.
 */

/**
 * Hygiene score weights (must sum to 1.0).
 * Each rate is `(violatingTickets / totalTickets)`; penalty = rate × weight × 100.
 * Score = 100 - sum(penalties), clamped to `[0, 100]`.
 */
export const HYGIENE_WEIGHTS = {
  unestimated:       0.20,
  unclassified:      0.15,
  midSprintAdded:    0.20,
  missingPriority:   0.15,
  unresolvedBlocker: 0.10,
  carryOver:         0.20,
};

/** Traffic-light emoji for a 0-100 score. */
export function hygieneStatusEmoji(score) {
  if (score >= 80) return "??";
  if (score >= 60) return "??";
  return "??";
}

/** Traffic-light emoji for a single rate against `warnAt` / `alertAt` thresholds. */
function metricStatusEmoji(rate, warnAt, alertAt) {
  if (rate <= warnAt) return "??";
  if (rate <= alertAt) return "??";
  return "??";
}

/**
 * Compute per-sprint hygiene metrics from the issue list.
 *
 * Every input field (`storyPoints`, `workClassification`, `priority`,
 * `isBlocker`, `isDone`, `created`) is already on the normalised Issue
 * object returned by `getSprintIssues()`. Returns null when the sprint
 * has zero tickets so the caller can render a stable "no data" message.
 */
export function computeHygieneMetrics(issues, sprintStartDate) {
  const total = issues.length;
  if (total === 0) return null;

  const sprintStart = sprintStartDate ? new Date(sprintStartDate) : null;
  const sampleLimit = 3;

  const unestimatedKeys = [];
  const unclassifiedKeys = [];
  const midSprintKeys = [];
  const missingPriorityKeys = [];
  const unresolvedBlockerKeys = [];
  const carryOverKeys = [];

  for (const it of issues) {
    if (!it.isDone && it.storyPoints === 0) unestimatedKeys.push(it.key);
    if (it.workClassification === "Uncategorized") unclassifiedKeys.push(it.key);
    if (sprintStart && it.created) {
      const created = new Date(it.created);
      if (!isNaN(created.getTime()) && created > sprintStart) midSprintKeys.push(it.key);
    }
    const prio = String(it.priority || "").toLowerCase().trim();
    if (!prio || prio === "n/a" || prio === "none" || prio === "undefined") missingPriorityKeys.push(it.key);
    if (it.isBlocker && !it.isDone) unresolvedBlockerKeys.push(it.key);
    if (!it.isDone) carryOverKeys.push(it.key);
  }

  const rate = (keys) => total > 0 ? keys.length / total : 0;
  const sample = (keys) => {
    const s = keys.slice(0, sampleLimit);
    const rest = keys.length - s.length;
    return s.length === 0 ? "—" : rest > 0 ? s.join(", ") + `, +${rest}` : s.join(", ");
  };

  const unestimatedRate = rate(unestimatedKeys);
  const unclassifiedRate = rate(unclassifiedKeys);
  const midSprintRate = rate(midSprintKeys);
  const missingPriorityRate = rate(missingPriorityKeys);
  const unresolvedBlockerRate = rate(unresolvedBlockerKeys);
  const carryOverRate = rate(carryOverKeys);

  const penalty =
    unestimatedRate * HYGIENE_WEIGHTS.unestimated +
    unclassifiedRate * HYGIENE_WEIGHTS.unclassified +
    midSprintRate * HYGIENE_WEIGHTS.midSprintAdded +
    missingPriorityRate * HYGIENE_WEIGHTS.missingPriority +
    unresolvedBlockerRate * HYGIENE_WEIGHTS.unresolvedBlocker +
    carryOverRate * HYGIENE_WEIGHTS.carryOver;

  const score = Math.round(Math.max(0, Math.min(100, 100 - penalty * 100)));

  return {
    score,
    total,
    metrics: [
      {
        label:       "Unestimated tickets (0 SP, not done)",
        count:       unestimatedKeys.length,
        rate:        unestimatedRate,
        statusEmoji: metricStatusEmoji(unestimatedRate, 0.15, 0.30),
        sample:      sample(unestimatedKeys),
      },
      {
        label:       "No Work Classification",
        count:       unclassifiedKeys.length,
        rate:        unclassifiedRate,
        statusEmoji: metricStatusEmoji(unclassifiedRate, 0.20, 0.40),
        sample:      sample(unclassifiedKeys),
      },
      {
        label:       "Mid-sprint additions (scope creep)",
        count:       midSprintKeys.length,
        rate:        midSprintRate,
        statusEmoji: metricStatusEmoji(midSprintRate, 0.10, 0.20),
        sample:      sample(midSprintKeys),
      },
      {
        label:       "Missing priority",
        count:       missingPriorityKeys.length,
        rate:        missingPriorityRate,
        statusEmoji: metricStatusEmoji(missingPriorityRate, 0.15, 0.30),
        sample:      sample(missingPriorityKeys),
      },
      {
        label:       "Unresolved blockers",
        count:       unresolvedBlockerKeys.length,
        rate:        unresolvedBlockerRate,
        statusEmoji: unresolvedBlockerKeys.length > 0 ? "??" : "??",
        sample:      sample(unresolvedBlockerKeys),
      },
      {
        label:       "Carry-over (not completed)",
        count:       carryOverKeys.length,
        rate:        carryOverRate,
        statusEmoji: metricStatusEmoji(carryOverRate, 0.20, 0.40),
        sample:      "—",
      },
    ],
  };
}

/** Render the hygiene block that replaces `HYGIENE_SECTION` in the template. */
export function formatHygieneSectionMd(hygiene) {
  if (!hygiene) {
    return "_No hygiene data available (sprint has no tickets)._";
  }
  const emoji = hygieneStatusEmoji(hygiene.score);
  const lines = [
    `**Hygiene Score:** ${hygiene.score}/100 ${emoji}  `,
    `*${hygiene.total} ticket(s) analysed. Score = 100 - weighted penalty across 5 hygiene dimensions.*`,
    "",
    "| Hygiene Check | Count | Rate | Status | Tickets (sample) |",
    "|---|---|---|---|---|",
  ];
  for (const m of hygiene.metrics) {
    const ratePct = m.rate > 0 ? Math.round(m.rate * 100) + "%" : "0%";
    lines.push(`| ${m.label} | ${m.count} | ${ratePct} | ${m.statusEmoji} | ${m.sample} |`);
  }
  lines.push("");
  lines.push("*Thresholds — Score: =80 ?? Good · 60–79 ?? Watch · <60 ?? Action needed*");
  return lines.join("\n");
}
