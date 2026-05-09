/**
 * Sprint stage configuration.
 *
 * Every project in `projects.json` may declare:
 *   - `startStage` comma-separated stage names that anchor `cycleStart`
 *     (the first transition into any of these is taken as the start).
 *   - `endStage`   comma-separated stage names that anchor `cycleEnd`
 *     (used STRICTLY — no defaults union — so the chart label
 *     "(days dev in progress ? ready for staging)" is measured exactly to
 *     the configured stage).
 *
 * `getStageSets(project)` returns three sets so different downstream metrics
 * can apply different semantics:
 *
 *   startStages    Falls back to `DEFAULT_START_STAGES` when projects.json
 *                  doesn't set it.
 *
 *   cycleEndStages STRICT — only what projects.json says (or the defaults
 *                  when the field is missing entirely). Used to anchor
 *                  cycleEnd. Never silently extended via defaults union, so
 *                  cycle time isn't inflated by post-staging dwell.
 *
 *   doneStages     UNION of project.endStage and DEFAULT_END_STAGES — used
 *                  for `isDone` detection so a ticket that has moved past
 *                  the configured endStage (Staging, Closed, Released, …)
 *                  still counts as complete for SP / ticket totals.
 */

/** Default end stages (lowercase) when project has no `endStage` in projects.json. */
export const DEFAULT_END_STAGES = new Set([
  "ready for staging", "staging", "ready for release", "release", "ready for production", "ready for prod",
  "done", "closed", "canceled", "cancelled", "released", "deployed", "complete", "completed", "resolved",
  "in staging", "in release", "accepted", "delivered",
]);

/** Default start stages (lowercase) when project has no `startStage` in projects.json. */
export const DEFAULT_START_STAGES = new Set([
  "ready for dev", "ready for development", "in progress", "in development", "in-progress",
]);

/**
 * Parse `project.startStage` and `project.endStage` into Sets.
 * Handles null/undefined, empty strings and type coercion so case-sensitive
 * config is normalised before we do lookups.
 */
export function getStageSets(project) {
  const parse = (val) => {
    if (val == null) return null;
    const str = typeof val === "string" ? val : String(val);
    const trimmed = str.trim();
    if (trimmed === "" || trimmed === "undefined") return null;
    const tokens = trimmed
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (tokens.length === 0) return null;
    return new Set(tokens);
  };
  const startStages = parse(project?.startStage) ?? new Set(DEFAULT_START_STAGES);
  const parsedEnd = parse(project?.endStage);
  // STRICT: cycle-time end anchor honours projects.json verbatim — no silent defaults union.
  const cycleEndStages = parsedEnd ?? new Set(DEFAULT_END_STAGES);
  // UNION: isDone detection still treats downstream/terminal stages as complete.
  const doneStages = parsedEnd
    ? new Set([...parsedEnd, ...DEFAULT_END_STAGES])
    : new Set(DEFAULT_END_STAGES);
  return { startStages, cycleEndStages, doneStages };
}
