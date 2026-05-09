/**
 * JIRA sprint helpers (Scrum boards only — Kanban path lives in `kanban.js`).
 *
 *   - `getRecentSprints`  recent active+closed sprints across one or all boards
 *                         for a project key
 *   - `getActiveSprint`   the live sprint on a single board (with optional
 *                         `mustHave` substring filter — required for shared
 *                         project keys where boards differ only by suffix)
 *   - `getSprintDetails`  resolve a sprint id back to its name / state / dates
 */

import { jiraGet, jiraUrl } from "./client.js";

/**
 * If `mustHave` is non-empty, the sprint name must contain it
 * (case-insensitive). Used by both `getRecentSprints` + `getActiveSprint` so a
 * mis-targeted board doesn't accidentally surface another team's sprint.
 */
export function sprintMatchesMustHave(sprintName, mustHave) {
  const m = mustHave != null ? String(mustHave).trim() : "";
  if (!m) return true;
  return String(sprintName || "").toLowerCase().includes(m.toLowerCase());
}

/**
 * Fetch recent sprints for a project, aggregated across boards.
 *
 * When `specificBoardId` is supplied (from `projects.json` `boardId`), we
 * query that board directly — avoids sprint-name collisions when multiple
 * projects share the same JIRA project key (e.g. several EHR boards).
 *
 * The fetch jumps straight to the last page of the sprint list (newest 30)
 * to avoid scanning every closed sprint a board has ever owned.
 */
export async function getRecentSprints(projectKey, limit = 6, mustHave = null, excludeWords = null, specificBoardId = null) {
  try {
    let boards = [];

    if (specificBoardId) {
      // Fast path: use the configured board directly — no project-key ? board lookup needed.
      boards = [{ id: specificBoardId }];
    } else {
      // Fallback: discover all boards for the project key (legacy behaviour).
      const boardsRes = await jiraGet(jiraUrl(`/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=50`));
      if (!boardsRes.ok) {
        throw new Error(`Boards fetch failed: ${boardsRes.status}`);
      }
      const boardsData = await boardsRes.json();
      boards = boardsData.values || [];
    }

    if (boards.length === 0) return [];

    const sprintMap = new Map();

    for (const b of boards) {
      try {
        const FETCH_LAST = 30;

        // Step 1: probe total count.
        const probeRes = await jiraGet(
          jiraUrl(`/rest/agile/1.0/board/${b.id}/sprint?state=active,closed&maxResults=1&startAt=0`),
        );
        if (!probeRes.ok) continue;
        const probeData = await probeRes.json();
        const total = probeData.total || 0;

        // Step 2: jump to last page.
        const startAt = Math.max(0, total - FETCH_LAST);
        const res = await jiraGet(
          jiraUrl(`/rest/agile/1.0/board/${b.id}/sprint?state=active,closed&maxResults=${FETCH_LAST}&startAt=${startAt}`),
        );
        if (!res.ok) continue;

        const data = await res.json();
        const items = data.values || [];

        const excludeList = excludeWords
          ? String(excludeWords).split(",").map((w) => w.toLowerCase()).filter(Boolean)
          : [];

        for (const s of items) {
          if (!s || !s.id) continue;
          if (!sprintMatchesMustHave(s.name, mustHave)) continue;
          if (excludeList.length > 0 && excludeList.some((w) => String(s.name || "").toLowerCase().includes(w))) continue;
          if (!sprintMap.has(s.id)) {
            // Normalize date strings and store a numeric sort timestamp so
            // ordering works even when Jira returns dates with offsets.
            const rawStart = s.startDate || null;
            const rawEnd = s.endDate || null;
            const normStart = rawStart ? String(rawStart).split("T")[0] : null;
            const normEnd = rawEnd ? String(rawEnd).split("T")[0] : null;
            const sortDate = rawEnd || rawStart || null;
            const sortTs = sortDate ? Date.parse(sortDate) : 0;

            sprintMap.set(s.id, {
              id: s.id,
              name: s.name || "TBD",
              startDate: normStart,
              endDate: normEnd,
              sortTs,
              boardIds: [b.id],
            });
          } else {
            const existing = sprintMap.get(s.id);
            if (existing && Array.isArray(existing.boardIds)) {
              if (!existing.boardIds.includes(b.id)) existing.boardIds.push(b.id);
            } else if (existing) {
              existing.boardIds = [b.id];
            }
          }
        }
      } catch {
        // continue on per-board failure
        continue;
      }
    }

    const sprints = Array.from(sprintMap.values());
    sprints.sort((a, b) => (b.sortTs || 0) - (a.sortTs || 0));
    return sprints.slice(0, limit);
  } catch (err) {
    console.error(`Error fetching recent sprints for project ${projectKey}:`, err.message);
    return [];
  }
}

/**
 * resolve the live (active) sprint on a board.
 *
 * When `mustHave` is set, only sprints whose name contains it are eligible —
 * critical for shared project keys where multiple boards run their own
 * sprints concurrently.
 */
export async function getActiveSprint(boardId, mustHave = null) {
  try {
    const response = await jiraGet(jiraUrl(`/rest/agile/1.0/board/${boardId}/sprint?state=active`));
    if (!response.ok) {
      throw new Error(`Sprint fetch failed: ${response.status}`);
    }
    const data = await response.json();
    const values = data.values || [];
    if (values.length === 0) {
      return null;
    }

    const mh = mustHave != null ? String(mustHave).trim() : "";
    const sprint = mh
      ? values.find((s) => sprintMatchesMustHave(s.name, mustHave)) || null
      : values[0];
    if (!sprint) {
      if (mh) {
        console.log(
          `  No active sprint matches mustHave "${mh}" (active on board: ${values.map((s) => s.name || "TBD").join(" | ")})`,
        );
      }
      return null;
    }

    return {
      id: sprint.id,
      name: sprint.name || "TBD",
      state: sprint.state || "TBD",
      startDate: sprint.startDate ? sprint.startDate.split("T")[0] : "TBD",
      endDate: sprint.endDate ? sprint.endDate.split("T")[0] : "TBD",
      goal: sprint.goal || "TBD",
    };
  } catch (err) {
    console.error("Error fetching sprint:", err.message);
    return null;
  }
}

/** resolve a sprint id back to its full details (name / state / dates / goal). */
export async function getSprintDetails(sprintId) {
  try {
    const response = await jiraGet(jiraUrl(`/rest/agile/1.0/sprint/${sprintId}`));
    if (!response.ok) {
      throw new Error(`Sprint details fetch failed: ${response.status}`);
    }
    const data = await response.json();
    return {
      id: data.id,
      name: data.name || "TBD",
      state: data.state || "TBD",
      startDate: data.startDate ? data.startDate.split("T")[0] : "TBD",
      endDate: data.endDate ? data.endDate.split("T")[0] : "TBD",
      goal: data.goal || "TBD",
    };
  } catch (err) {
    console.error(`Error fetching sprint details ${sprintId}:`, err.message);
    return null;
  }
}
