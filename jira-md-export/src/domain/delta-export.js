/**
 * Delta-mode export helpers.
 *
 * When `projects.json` sets `overwriteexistingdatafiles: false` (delta mode),
 * closed sprint files are skipped on re-runs since their data cannot change.
 * Active sprint files carry an ` [ACTIVE]` marker; when a sprint closes, the
 * stale marker file is re-exported under its plain name and the marker is
 * removed.
 */

import fs from "fs";
import path from "path";

/** Suffix (before `.md`) that marks a sprint file as the currently-active sprint snapshot. */
export const ACTIVE_SUFFIX = " [ACTIVE]";

/** Sanitize a string for use as a file name (strips characters illegal on Windows / POSIX). */
export function sanitizeFileName(name) {
  return (name || "untitled").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

/** Build the base (suffix-less) file name used for a sprint MD file. */
export function computeSprintBaseName(project, sprint, sprintDetails, isKanban) {
  const periodVal = isKanban
    ? `${project.name} (${sprint.name})`
    : (sprintDetails?.name || sprint.name || "");
  return sanitizeFileName(periodVal || `sprint-${sprint.id || "unknown"}`);
}

/** True when the sprint is the live/active one (JIRA state) — triggers always-refresh. */
export function isSprintActive(sprint, sprintDetails) {
  const state = (sprintDetails?.state || sprint.state || "").toLowerCase();
  return state === "active";
}

/**
 * Decide what to do with a sprint's MD file on this run.
 *
 * Returns `{ skip, targetPath, staleToDelete, reason }`.
 *
 * Rules (only applied when `project.overwriteexistingdatafiles === false`):
 *   - Active sprint              → always re-export to `<base> [ACTIVE].md`
 *                                   (live data).
 *   - Closed sprint, plain file  → SKIP (delta hit; data can't change).
 *     already exists.
 *   - Closed sprint, only the    → sprint just transitioned active→closed;
 *     [ACTIVE] file exists.        re-export to plain `<base>.md` and
 *                                   delete the stale `[ACTIVE]` variant
 *                                   (its snapshot was taken mid-sprint and
 *                                   may be incomplete).
 *   - Closed sprint, neither     → first-time export.
 *     exists.
 *
 * When the flag is missing or true, behaves like the legacy flow (always
 * overwrite, no `[ACTIVE]` suffix, no skipping).
 */
export function decideSprintAction(project, sprint, sprintDetails, isKanban, outDir) {
  const deltaMode = project.overwriteexistingdatafiles === false;
  const base = computeSprintBaseName(project, sprint, sprintDetails, isKanban);
  const active = isSprintActive(sprint, sprintDetails);
  const closedPath = path.join(outDir, base + ".md");
  const activePath = path.join(outDir, base + ACTIVE_SUFFIX + ".md");

  // Active sprints always write to the [ACTIVE] path regardless of mode so
  // the marker file is always present and the dashboard can identify the
  // live snapshot.
  if (active) {
    return { skip: false, targetPath: activePath, staleToDelete: null, reason: "active sprint — always refresh" };
  }

  if (!deltaMode) {
    return { skip: false, targetPath: closedPath, staleToDelete: null, reason: "overwrite mode (legacy)" };
  }

  if (fs.existsSync(closedPath)) {
    return { skip: true, targetPath: closedPath, staleToDelete: null, reason: "closed file exists (delta hit)" };
  }

  if (fs.existsSync(activePath)) {
    return { skip: false, targetPath: closedPath, staleToDelete: activePath, reason: "sprint closed since last run — re-export" };
  }

  return { skip: false, targetPath: closedPath, staleToDelete: null, reason: "first export for this sprint" };
}
