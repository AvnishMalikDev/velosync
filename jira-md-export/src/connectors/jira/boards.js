/**
 * JIRA Agile board helpers.
 *
 *   - `getBoardId(projectKey)`        find the first board for a project key
 *   - `getBoardInfo(boardId)`         fetch board metadata (id, name, type)
 *   - `getBoardFilterId(boardId)`     resolve the saved-filter id behind a board
 *
 * Used to drive Kanban-mode JQL scoping (`filter = <id>` instead of
 * `project = <KEY>`) so we don't accidentally pull issues from sibling boards
 * that share a Jira project key.
 */

import { jiraGet, jiraUrl } from "./client.js";

/**
 * Find the first Agile board for the given project key.
 * Returns the numeric board id or null when none exist / on error.
 */
export async function getBoardId(projectKey) {
  try {
    const response = await jiraGet(jiraUrl(`/rest/agile/1.0/board?projectKeyOrId=${projectKey}`));
    if (!response.ok) {
      throw new Error(`Board fetch failed: ${response.status}`);
    }
    const data = await response.json();
    if (!data.values || data.values.length === 0) {
      console.log(`No board found for ${projectKey}`);
      return null;
    }
    return data.values[0].id;
  } catch (err) {
    console.error(`Error getting board for ${projectKey}:`, err.message);
    return null;
  }
}

/**
 * Fetch board metadata so we can log "Board Type: scrum" / "kanban" up-front
 * (helps operators spot mis-configured projects before sprint logic runs).
 */
export async function getBoardInfo(boardId) {
  try {
    const response = await jiraGet(jiraUrl(`/rest/agile/1.0/board/${boardId}`));
    if (!response.ok) {
      throw new Error(`Board info fetch failed: ${response.status}`);
    }
    const data = await response.json();
    return {
      id: data.id,
      name: data.name,
      type: data.type || "unknown",
    };
  } catch (err) {
    console.error(`Error getting board info for ${boardId}:`, err.message);
    return null;
  }
}

/**
 * resolve the saved-filter id for a JIRA board via
 * `/board/{id}/configuration`. Returns null on any failure so callers can
 * fall back to project-key JQL.
 */
export async function getBoardFilterId(boardId) {
  try {
    const res = await jiraGet(jiraUrl(`/rest/agile/1.0/board/${boardId}/configuration`));
    if (!res.ok) return null;
    const cfg = await res.json();
    const filterId = cfg?.filter?.id;
    return filterId ? String(filterId) : null;
  } catch {
    return null;
  }
}
