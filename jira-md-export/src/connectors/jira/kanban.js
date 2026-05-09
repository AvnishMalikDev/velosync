/**
 * Kanban (no-sprint) issue fetching for JIRA boards.
 *
 *   - `fetchKanbanWindowIssues(projectKey, startDate, endDate, boardId?)`
 *     Pulls assigned issues that were either Done within the window or
 *     updated within the window. Scoped to a board's saved filter when a
 *     `boardId` is provided so we don't pull tickets from sibling boards
 *     that share a Jira project key.
 *
 *   - `generateFallbackWindows(count, windowDays = 14)`
 *     Synthetic 14-day windows used when no Scrum project is available to
 *     supply real sprint date boundaries.
 */

import { jiraGet, jiraUrl } from "./client.js";
import { getBoardFilterId } from "./boards.js";

/**
 * Fetch Kanban issues for a date window.
 *
 * When `boardId` is supplied, the board's own saved filter is used as the
 * JQL scope (`filter = <id>`) so only issues actually on that board are
 * returned. Falls back to `project = <key>` when the filter id cannot be
 * resolved.
 */
export async function fetchKanbanWindowIssues(projectKey, startDate, endDate, boardId = null) {
  const issues = [];
  const maxResults = 100;

  // Prefer board-filter scoping over raw project key to avoid pulling in
  // issues from sibling boards that share the same Jira project key (e.g.
  // multiple PR boards under one product).
  let scopeClause = `project = ${projectKey}`;
  if (boardId) {
    const filterId = await getBoardFilterId(boardId);
    if (filterId) {
      scopeClause = `filter = ${filterId}`;
      console.log(`[Kanban] Using board filter ${filterId} for boardId ${boardId}`);
    } else {
      console.warn(`[Kanban] Could not resolve filter for boardId ${boardId} — falling back to project = ${projectKey}`);
    }
  }

  const jql = `${scopeClause} AND assignee is not EMPTY AND ((statusCategory = Done AND resolved >= "${startDate}" AND resolved <= "${endDate}") OR (statusCategory != Done AND updated >= "${startDate}"))`;
  let nextPageToken = null;
  for (;;) {
    const params = new URLSearchParams();
    params.set("jql", jql);
    params.set("maxResults", String(maxResults));
    params.set("fields", "*all");
    // Embed changelog in bulk response — eliminates per-issue changelog fetch in processRawIssues.
    params.set("expand", "changelog");
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const url = jiraUrl(`/rest/api/3/search/jql?${params.toString()}`);
    const response = await jiraGet(url);
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`Kanban JQL failed: ${response.status} ${errBody.slice(0, 300)}`);
    }
    const data = await response.json();
    const batch = data.issues || [];
    issues.push(...batch);
    if (data.isLast === true || batch.length === 0) break;
    if (!data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
    if (issues.length > 50000) break;
  }
  return issues;
}

/**
 * Synthetic 14-day rolling windows used when no Scrum project is available
 * to provide real sprint date boundaries. Newest first; the index-0 window
 * is marked `state: 'active'`, the rest `closed`.
 */
export function generateFallbackWindows(count, windowDays = 14) {
  const windows = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const end = new Date(now);
    end.setDate(end.getDate() - i * windowDays);
    const start = new Date(end);
    start.setDate(start.getDate() - windowDays);
    const startStr = start.toISOString().split("T")[0];
    const endStr = end.toISOString().split("T")[0];
    windows.push({
      id: `fallback-window-${i}`,
      name: `${startStr} to ${endStr}`,
      startDate: startStr,
      endDate: endStr,
      state: i === 0 ? "active" : "closed",
    });
  }
  return windows;
}
