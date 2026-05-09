/**
 * Top-level export orchestrator.
 *
 * Boots the entire JIRA / GitHub / Copilot / Cursor / Confluence / TestRail
 * sync pipeline:
 *
 *   1. Refresh `output/resource-directory.json` from JIRA (cached 7 days).
 *   2. Sync TestRail user IDs onto Jira rows by email (idempotent; skipped
 *      when TestRail env vars are unset).
 *   3. Pull Copilot + Cursor metrics (writes their own JSON files).
 *   4. Probe Confluence reachability with the JIRA token.
 *   5. Pre-fetch GitHub org members once (so per-project loops re-use them).
 *   6. Pre-run cleanup: delete `output/*.md` files whose **Product:** header
 *      doesn't match any project in `projects.json`.
 *   7. For each active project (Scrum first, then Kanban), iterate over
 *      `SPRINT_COUNT` recent sprints (or 14-day windows for Kanban),
 *      compute totals + hygiene + work-classification + epic + TestRail +
 *      GitHub + Confluence rows, and write the sprint MD file.
 *   8. Print unresolved-GitHub-login summary.
 *   9. Write `output/files.json` index + `output/stagedwelldata.json`.
 *
 * Wire-up only — every individual fetch / metric / format helper lives in a
 * module under `src/connectors/<system>/` or `src/domain/`. This file
 * exists to compose them and to own per-run state (stage-dwell accumulator,
 * loaded projects list).
 */

import "./core/env.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { OUTPUT_DIR, PROJECTS_JSON, ROOT_DIR, TEMPLATE_DIR } from "./core/paths.js";
import { jiraDomain, jiraEmail, jiraApiToken } from "./core/jira-auth.js";

// JIRA connector
import {
  resolveWorkClassificationFieldIds,
  resolveActualStoryPointsFieldId,
  resolveQaPointsFieldId,
  resolveQaAssigneeFieldId,
} from "./connectors/jira/fields.js";
import { getBoardId, getBoardInfo } from "./connectors/jira/boards.js";
import { getRecentSprints, getActiveSprint, getSprintDetails } from "./connectors/jira/sprints.js";
import { getSprintIssues, processRawIssues } from "./connectors/jira/issues.js";
import { fetchKanbanWindowIssues, generateFallbackWindows } from "./connectors/jira/kanban.js";
import { ensureresourceDirectory } from "./connectors/jira/resource-directory.js";

// Other connectors
import { getCopilotData } from "./connectors/copilot/client.js";
import { getCursorData } from "./connectors/cursor/client.js";
import {
  getConfluenceActivityForUser,
  buildConfluenceAuth,
  checkConfluenceAccess,
} from "./connectors/confluence/client.js";
import {
  getGitHubMetricsForUser,
  loadGitHubUserMapping,
  loadGithubLoginsFromresourceDirectory,
  backfillGithubLoginsInresourceDirectory,
  resolveJiraDisplayNameToGithubLogin,
  getOrgMemberLogins,
} from "./connectors/github/metrics.js";
import { getTestRailMetrics } from "./connectors/testrail/metrics.js";
import { syncTestRailUserIds } from "./connectors/testrail/user-sync.js";

// Domain helpers
import {
  aggregateWorkClassificationBySprint,
  formatWorkClassificationMarkdownTable,
} from "./domain/work-classification.js";
import { aggregateEpicWorkBySprint, formatEpicWorkMarkdownTable } from "./domain/epics.js";
import { computeHygieneMetrics, formatHygieneSectionMd } from "./domain/hygiene.js";
import { decideSprintAction } from "./domain/delta-export.js";
import { formatDataAt, shortDisplayName, bugresolvedInSprint } from "./domain/format.js";
import { applyTemplate } from "./domain/template.js";
import {
  computeAiAdoptionRating,
  memberMatchesCursorLeaderboard,
  projectMatchesCursorRepo,
} from "./domain/ai-adoption.js";

// --- Per-run state ----------------------------------------------------------

/** Total issues across all last-completed sprints (for accurate ticket count in stage-dwell output). */
let stageDwellTotalIssueCount = 0;

/**
 * Stage dwell accumulator — aggregated across ALL projects and ALL sprints
 * in a single run. Key: stage name lowercased; value:
 * `{ display, totalDays, count, minPosition }`.
 */
const stageDwellAccumulator = new Map();
let stageDwellTicketCount = 0;

// --- Project list (filtered to active) --------------------------------------

const config = JSON.parse(fs.readFileSync(PROJECTS_JSON, "utf-8"));
const projects = (config.projects || []).filter((p) => p && p.active === true);

/** True for Kanban-typed projects in projects.json (they go through the date-window path). */
function isKanbanProject(project) {
  return (project?.type || "").trim().toLowerCase() === "kanban";
}

const scrumProjects = projects.filter((p) => !isKanbanProject(p));
const kanbanProjects = projects.filter((p) => isKanbanProject(p));
/** Scrum first so Kanban iterations can borrow real sprint date windows. */
const allProjectsSorted = [...scrumProjects, ...kanbanProjects];

// --- Main runner ------------------------------------------------------------

export async function run() {
  // 1) resource-directory.json from Jira (required for QA filtering + TestRail name IDs)
  // 2) Map TestRail user IDs onto Jira users by email (needs TESTRAIL_* env; skipped if unset)
  // 3) Copilot/Cursor, then per-sprint MD (includes getTestRailMetrics per project + sprint dates)
  await ensureresourceDirectory();

  try {
    await syncTestRailUserIds({ skipIfNoEnv: true });
  } catch (e) {
    console.warn("[TestRail user sync]", e.message || e);
  }

  // -- Fetch Copilot and Cursor metrics first, then JIRA md export --
  await getCopilotData();
  await getCursorData();

  // Check Confluence accessibility (same token as JIRA).
  let confluenceAvailable = false;
  let confluenceAuth = null;
  try {
    confluenceAvailable = await checkConfluenceAccess(jiraDomain, jiraEmail, jiraApiToken);
    if (confluenceAvailable) {
      confluenceAuth = buildConfluenceAuth(jiraEmail, jiraApiToken);
      console.log("Confluence API: accessible (will fetch per-user docs activity)");
    } else {
      console.log("Confluence API: not accessible (skipping docs activity)");
    }
  } catch (e) {
    console.warn("Confluence API check failed:", e.message);
  }

  const githubUserMap = loadGitHubUserMapping(ROOT_DIR);
  let rdGithubByDisplay = loadGithubLoginsFromresourceDirectory(path.join(ROOT_DIR, ".."));
  const githubToken = process.env.GITHUB_TOKEN || process.env.GITHUB_METRICS_TOKEN;
  const githubOrg = process.env.ORG || "";

  // Track JIRA display names that could not be resolved to a real GitHub
  // login so we can print a one-shot diagnostic summary at the end of the
  // run. Lives at function scope: populated inside the per-project loop
  // below and consumed after that loop closes.
  const unresolvedGhNames = new Set();

  // Pre-fetch GitHub org member logins ONCE for the whole run (used for
  // fuzzy name?login matching and to gate the derived-login fallback
  // against real org membership). Previously this lived inside the
  // per-project loop, which meant we refetched ~200–300 members on every
  // project iteration — wasteful and a meaningful chunk of the GitHub
  // core-API rate-limit budget. Requires read:org scope on GITHUB_TOKEN;
  // degrades gracefully if missing.
  let orgMemberLogins = [];
  let orgMemberLoginsLower = new Set();
  if (githubToken && githubOrg) {
    orgMemberLogins = await getOrgMemberLogins(githubOrg, githubToken);
    orgMemberLoginsLower = new Set(orgMemberLogins.map((l) => String(l).toLowerCase()));
    if (orgMemberLogins.length > 0) {
      console.log(`Fetched ${orgMemberLogins.length} GitHub org member login(s) for fuzzy name matching.`);
      const bf = backfillGithubLoginsInresourceDirectory(path.join(ROOT_DIR, ".."), {
        githubUserMap,
        orgMemberLogins,
        orgMemberLoginsLower,
      });
      if (bf.updated > 0 && !bf.writeFailed) {
        console.log(`[resource Directory] Auto-filled githubLogin for ${bf.updated} / ${bf.totalUsers} user(s) (github-users + fuzzy + derived).`);
        rdGithubByDisplay = loadGithubLoginsFromresourceDirectory(path.join(ROOT_DIR, ".."));
      } else if (bf.updated > 0 && bf.writeFailed) {
        console.warn(`[resource Directory] resolved ${bf.updated} githubLogin(s) but failed to write file: ${bf.reason}`);
      }
      const rdGithubCount = Object.keys(rdGithubByDisplay).length;
      if (rdGithubCount > 0) {
        console.log(`[GitHub] ${rdGithubCount} display name(s) with githubLogin in output/resource-directory.json`);
      }
    } else {
      console.warn('Could not fetch GitHub org members (read:org scope may be missing) — derived-login fallback will be disabled and unresolved users will show "—".');
    }
  }

  if (!projects || projects.length === 0) {
    console.log("No projects found in projects.json");
    return;
  }

  // -- Pre-run orphan cleanup ---------------------------------------------
  // Delete any output/*.md whose **Product:** header does not match a
  // project name defined in projects.json (active or inactive). Keeps the
  // output folder tidy without ever touching valid history files.
  {
    const knownNames = new Set(
      (config.projects || []).map((p) => (p.name || "").trim().toLowerCase()),
    );
    let outFiles = [];
    try { outFiles = await fs.promises.readdir(OUTPUT_DIR); } catch { /* output dir may not exist yet */ }
    for (const f of outFiles.filter((n) => n.endsWith(".md"))) {
      const fPath = path.join(OUTPUT_DIR, f);
      let content;
      try { content = await fs.promises.readFile(fPath, "utf8"); } catch { continue; }
      const m = content.match(/\*\*Product:\*\*\s*(.+)/);
      if (!m) continue;
      const prod = m[1].trim().toLowerCase();
      if (!knownNames.has(prod)) {
        try {
          await fs.promises.unlink(fPath);
          console.log(`[Orphan cleanup] Deleted unrecognised product file: ${f}`);
        } catch (err) {
          if (err.code !== "ENOENT") console.warn(`[Orphan cleanup] Could not delete ${f}:`, err.message);
        }
      }
    }
  }

  let sprintDateWindows = [];

  for (const project of allProjectsSorted) {
    const isKanban = isKanbanProject(project);
    const boardTypeLabel = isKanban ? "Kanban" : "Sprint";

    const workClassificationFieldIds = await resolveWorkClassificationFieldIds(project);
    if (workClassificationFieldIds && workClassificationFieldIds.length > 0) {
      console.log("Work Classification field id(s):", workClassificationFieldIds.join(", "));
    } else {
      console.log(
        "Work Classification field: not found (set workClassificationFieldId in projects.json or JIRA_WORK_CLASSIFICATION_FIELD_ID) — falling back to JIRA Issue Type",
      );
    }

    const actualSpFieldId = await resolveActualStoryPointsFieldId();
    if (actualSpFieldId) {
      console.log("Actual Story Points field id:", actualSpFieldId);
    } else {
      console.log("Actual Story Points field: not found (set JIRA_ACTUAL_STORY_POINTS_FIELD_ID if needed) — actual SP will be 0");
    }

    const qaPointsFieldId = await resolveQaPointsFieldId();
    if (qaPointsFieldId) {
      console.log("QA Points field id:", qaPointsFieldId);
    } else {
      console.log("QA Points field: not found (set JIRA_QA_POINTS_FIELD_ID if needed) — QA points will be 0");
    }

    const qaAssigneeFieldId = await resolveQaAssigneeFieldId();
    if (qaAssigneeFieldId) {
      console.log("QA Assignee field id:", qaAssigneeFieldId);
    } else {
      console.log("QA Assignee field: not found (set JIRA_QA_ASSIGNEE_FIELD_ID if needed) — QA assignee will be null");
    }

    console.log("\n========================");
    console.log("Project Key  :", project.key);
    console.log("Project Name :", project.name);

    // Prefer `boardId` from projects.json when provided to avoid extra API calls.
    let boardId = project.boardId || null;
    if (boardId) {
      console.log("Board ID     : (from config)", boardId);
    } else {
      boardId = await getBoardId(project.key);
      if (!boardId) {
        console.log("Board ID     : Not found");
        continue;
      }
      console.log("Board ID     :", boardId);
    }

    const boardInfo = await getBoardInfo(boardId);
    if (boardInfo && boardInfo.type) {
      console.log("Board Type   :", boardInfo.type);
    } else {
      console.log("Board Type   : Unknown");
    }

    const sprintCount = parseInt(process.env.SPRINT_COUNT || "2", 10);
    const orderedSprints = [];
    let precedingForPSP = null;
    const issuesBySprint = new Map();

    if (isKanban) {
      // -- Kanban path: derive date windows from Scrum sprints when available,
      // but ALWAYS use date-based names (startDate to endDate) so file names
      // are stable regardless of which other projects are active in the run.
      const rawWindows = sprintDateWindows.length > 0
        ? sprintDateWindows
        : generateFallbackWindows(sprintCount + 1);

      // Normalise to date-based names: "YYYY-MM-DD to YYYY-MM-DD".
      const windows = rawWindows.map((w) => ({
        ...w,
        name: (w.startDate && w.endDate) ? `${w.startDate} to ${w.endDate}` : w.name,
      }));

      if (sprintDateWindows.length > 0) {
        console.log(`\nUsing sprint date windows from Scrum project (date-normalised, ${windows.length} window(s)):`);
      } else {
        console.log(`\nNo Scrum sprints available — using fallback ${14}-day windows:`);
      }
      windows.forEach((w) => console.log(`  - ${w.name} | ${w.startDate} to ${w.endDate} | ${w.state}`));

      for (let wi = 0; wi < Math.min(windows.length, sprintCount); wi++) {
        orderedSprints.push(windows[wi]);
      }
      if (windows.length > sprintCount) {
        precedingForPSP = windows[sprintCount];
      }

      const windowsToFetch = precedingForPSP ? [...orderedSprints, precedingForPSP] : [...orderedSprints];
      for (const w of windowsToFetch) {
        try {
          console.log(`\n  Fetching Kanban issues for window: ${w.name} (${w.startDate} to ${w.endDate})...`);
          const rawIssues = await fetchKanbanWindowIssues(project.key, w.startDate, w.endDate, project.boardId || null);
          // processRawIssues runs the same normalisation as the sprint
          // path (cycle markers, stage dwell, classification flags, …) so
          // every downstream metric stays consistent.
          const processed = await processRawIssues(rawIssues, project, workClassificationFieldIds, actualSpFieldId, qaPointsFieldId, qaAssigneeFieldId);
          issuesBySprint.set(w.id, processed);
          console.log(`    ? ${processed.length} assigned issue(s)`);
        } catch (err) {
          console.error(`  Kanban window fetch failed for ${w.name}:`, err.message);
          issuesBySprint.set(w.id, []);
        }
      }
    } else {
      // -- Sprint/Scrum path --
      const recentSprints = await getRecentSprints(project.key, 20, project.mustHave || null, project.excludeWords || null, project.boardId || null);

      console.log(`\nRecent sprints for project ${project.key}:`);
      if (!recentSprints || recentSprints.length === 0) {
        console.log("  (no sprints found)");
      } else {
        recentSprints.forEach((s) => {
          console.log(`  - ${s.name} | start: ${s.startDate || "TBD"} | end: ${s.endDate || "TBD"}`);
        });
      }

      const activeSprint = await getActiveSprint(boardId, project.mustHave || null);
      console.log("\nCurrent Active Sprint:");
      if (!activeSprint) {
        console.log("  None active");
      } else {
        console.log("Sprint Name    :", activeSprint.name || "TBD");
        console.log("State          :", activeSprint.state || "TBD");
        console.log("Start Date     :", activeSprint.startDate || "TBD");
        console.log("End Date       :", activeSprint.endDate || "TBD");
        console.log("Goal           :", activeSprint.goal || "TBD");
        orderedSprints.push(activeSprint);
      }

      for (const s of recentSprints) {
        if (orderedSprints.length >= sprintCount) break;
        if (!orderedSprints.find((x) => x.id === s.id)) orderedSprints.push(s);
      }

      precedingForPSP = recentSprints.find((s) =>
        !orderedSprints.find((x) => x.id === s.id) && s.endDate,
      ) || null;

      // Capture sprint date windows from the first Scrum project for Kanban reuse.
      if (sprintDateWindows.length === 0 && orderedSprints.length > 0) {
        sprintDateWindows = orderedSprints.map((s) => ({
          id: `window-${s.id}`,
          name: s.name || "TBD",
          startDate: s.startDate || null,
          endDate: s.endDate || null,
          state: s.state || "closed",
        }));
        if (precedingForPSP) {
          sprintDateWindows.push({
            id: `window-${precedingForPSP.id}`,
            name: precedingForPSP.name || "TBD",
            startDate: precedingForPSP.startDate || null,
            endDate: precedingForPSP.endDate || null,
            state: "closed",
          });
        }
        console.log(`  Captured ${sprintDateWindows.length} sprint date window(s) for Kanban projects.`);
      }

      const sprintsToFetch = precedingForPSP
        ? [...orderedSprints, precedingForPSP]
        : [...orderedSprints];

      const lastCompletedSprint = orderedSprints.find(
        (s) => !s.state || String(s.state).toLowerCase() !== "active",
      ) || null;
      const lastCompletedSprintId = lastCompletedSprint ? lastCompletedSprint.id : null;
      if (lastCompletedSprint) {
        console.log(`  Stage dwell will use sprint: "${lastCompletedSprint.name || lastCompletedSprint.id}"`);
      }

      for (const s of sprintsToFetch) {
        const issues = await getSprintIssues(s.id, project, workClassificationFieldIds, actualSpFieldId, qaPointsFieldId, qaAssigneeFieldId);
        issuesBySprint.set(s.id, issues);

        if (s.id === lastCompletedSprintId) {
          stageDwellTotalIssueCount += issues.length;
          for (const iss of issues) {
            if (!iss.stageDwells || Object.keys(iss.stageDwells).length === 0) continue;
            stageDwellTicketCount++;
            for (const [key, dwell] of Object.entries(iss.stageDwells)) {
              const existing = stageDwellAccumulator.get(key);
              if (!existing) {
                stageDwellAccumulator.set(key, { display: dwell.display, totalDays: dwell.days, count: 1, minPosition: dwell.position });
              } else {
                existing.totalDays += dwell.days;
                existing.count++;
                existing.minPosition = Math.min(existing.minPosition, dwell.position);
              }
            }
          }
        }

        const memberMap = new Map();
        for (const it of issues) {
          if (!memberMap.has(it.assignee)) memberMap.set(it.assignee, { completed: 0, inprogress: 0 });
          const rec = memberMap.get(it.assignee);
          if (it.isDone) rec.completed += it.storyPoints;
          else rec.inprogress += it.storyPoints;
        }
        if (memberMap.size > 0) {
          console.log(`\nSprint [${s.name}] — Team Members (story points):`);
          const sorted = [...memberMap.entries()].sort((a, b) => (b[1].completed + b[1].inprogress) - (a[1].completed + a[1].inprogress));
          for (const [name, v] of sorted) {
            console.log(`  ${name} — Completed: ${v.completed}, In Progress: ${v.inprogress}`);
          }
        }
      }
    }

    /**
     * Sum SPs / tickets / bugs / cycle-time / blockers / regulatory share
     * across an issue list, keyed to a sprint window.
     *
     * - bugs opened: Bug type + created in sprint window (JIRA `created` ts).
     * - bugs closed: Bug type + Done + resolution timestamp in sprint window
     *   when present; otherwise Done (fallback) — see `bugresolvedInSprint`.
     */
    const computeTotals = (issues, sprintStartDate = null, sprintEndDate = null) => {
      let sp = 0, totalSp = 0, asp = 0, ct = 0, bo = 0, bc = 0, blk = 0;
      let qasp = 0;
      let cycleDaysSum = 0, cycleCount = 0;
      let regCycleDaysSum = 0, regCycleCount = 0;
      const members = new Map(); // name ? { sp, ct }
      const sprintStart = sprintStartDate ? new Date(sprintStartDate) : null;
      const sprintEnd = sprintEndDate ? new Date(sprintEndDate) : null;
      for (const it of issues) {
        totalSp += it.storyPoints;
        if (it.isDone) {
          sp += it.storyPoints;
          asp += it.actualStoryPoints || 0;
          qasp += it.qaPoints || 0;
          ct++;
          // Cycle time: project startStage ? cycleEndStage; per-project from projects.json.
          if (it.cycleStart && it.effectiveCycleEnd) {
            const days = (new Date(it.effectiveCycleEnd) - new Date(it.cycleStart)) / (1000 * 60 * 60 * 24);
            if (days >= 0) {
              cycleDaysSum += days;
              cycleCount++;
              if (it.isRegulatory) { regCycleDaysSum += days; regCycleCount++; }
            }
          }
        }
        // Bugs opened: Bug type + created within the sprint window.
        const bugCreated = it.created ? new Date(it.created) : null;
        const createdInSprint = (!sprintStart || !bugCreated)
          ? true
          : bugCreated >= sprintStart && (!sprintEnd || bugCreated <= sprintEnd);
        if (it.isBug && createdInSprint) bo++;
        if (it.isBug && bugresolvedInSprint(it, sprintStart, sprintEnd)) bc++;
        if (it.isBlocker) blk++;
        const name = it.assignee || "Unassigned";
        if (!members.has(name)) members.set(name, { sp: 0, ct: 0 });
        const m = members.get(name);
        if (it.isDone) { m.sp += it.storyPoints; m.ct++; }
      }
      const scr = totalSp > 0 ? Math.round((sp / totalSp) * 100) + "%" : "N/A";
      const cyt = cycleCount > 0 ? (cycleDaysSum / cycleCount).toFixed(1) : "N/A";
      // Regulatory & Compliance %: portion of total cycle time from "1. Regulatory" tagged tickets.
      const regPct = cycleDaysSum > 0 ? Math.round((regCycleDaysSum / cycleDaysSum) * 100) : 0;
      return {
        sp, totalSp, asp, qasp, ct, scr, bo, bc, cyt, blk, members, regPct,
        regCycleDaysSum: parseFloat(regCycleDaysSum.toFixed(1)),
        cycleDaysSum: parseFloat(cycleDaysSum.toFixed(1)),
      };
    };

    // -- Load template content --
    let templateContent = "";
    try {
      // Prefer process.cwd()/template (legacy invocation), but fall back to
      // the canonical TEMPLATE_DIR so PM2 / cron runs locate the template
      // regardless of current working directory.
      const candidates = [
        path.join(process.cwd(), "template"),
        path.join(process.cwd(), "Template"),
        TEMPLATE_DIR,
      ];
      for (const dir of candidates) {
        try {
          const files = await fs.promises.readdir(dir);
          const mdFile = files.find((f) => f.toLowerCase().endsWith(".md"));
          if (mdFile) {
            templateContent = await fs.promises.readFile(path.join(dir, mdFile), "utf8");
            break;
          }
        } catch { /* try next candidate */ }
      }
      if (!templateContent) {
        const fallback = path.join(process.cwd(), "Actual-Data");
        const fallbackFiles = await fs.promises.readdir(fallback).catch(() => []);
        const fb = fallbackFiles.find((f) => f.toLowerCase().endsWith(".md"));
        if (fb) templateContent = await fs.promises.readFile(path.join(fallback, fb), "utf8");
      }
    } catch {
      templateContent = "";
    }

    await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
    // Load Cursor data for AI adoption scoring (leaderboard + AI edits by repo).
    let cursorData = null;
    try {
      const cursorPath = path.join(OUTPUT_DIR, "cursordata.json");
      const raw = await fs.promises.readFile(cursorPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed.error) cursorData = parsed;
    } catch {
      // No cursor data or invalid — fall back to SP-based rating only.
    }

    // -- Write one output file per sprint (generic — driven by SPRINT_COUNT) --
    console.log(`\nGenerating ${orderedSprints.length} sprint file(s) (SPRINT_COUNT=${sprintCount})...`);

    for (let i = 0; i < orderedSprints.length; i++) {
      try {
        const sprint = orderedSprints[i];

        // Skip any sprint whose name contains "Analytics".
        if (/analytics/i.test(sprint.name || "")) {
          console.log(`Skipping sprint (Analytics): ${sprint.name}`);
          continue;
        }

        // resolve sprint state + target path BEFORE any heavy work, so that
        // delta mode (overwriteexistingdatafiles=false) can short-circuit
        // closed sprints whose .md file already exists on disk.
        const sprintDetails = isKanban ? null : await getSprintDetails(sprint.id);
        const periodVal = isKanban
          ? `${project.name} (${sprint.name})`
          : (sprintDetails?.name || sprint.name || "");
        const reviewDateVal = sprintDetails?.endDate || sprint.endDate || "";

        const action = decideSprintAction(project, sprint, sprintDetails, isKanban, OUTPUT_DIR);
        if (action.skip) {
          console.log(`[Delta] Skipping ${project.key} / "${periodVal}" — ${action.reason}`);
          continue;
        }
        if (action.reason && project.overwriteexistingdatafiles === false) {
          console.log(`[Delta] Processing ${project.key} / "${periodVal}" — ${action.reason}`);
        }
        const outPath = action.targetPath;

        // Previous sprint for PSP/PCT: next entry in list, or the extra preceding sprint.
        const prevSprint = orderedSprints[i + 1] || precedingForPSP || null;

        const issues = issuesBySprint.get(sprint.id) || [];
        const prevIssues = prevSprint ? (issuesBySprint.get(prevSprint.id) || []) : [];

        const { sp: csp, totalSp: cTotalSp, asp: casp, qasp: cqasp, ct: cct, scr: cscr, bo: cbo, bc: cbc, cyt: ccyt, blk: cblk, members: curMembers, regPct: cRegPct, regCycleDaysSum: cRegDays, cycleDaysSum: cTotDays } = computeTotals(issues, sprint.startDate, sprint.endDate);
        const { sp: psp, totalSp: pTotalSp, asp: pasp, qasp: pqasp, ct: pct, scr: pscr, bo: pbo, bc: pbc, cyt: pcyt, blk: pblk, members: prevMembers, regPct: pRegPct } = computeTotals(prevIssues, prevSprint?.startDate, prevSprint?.endDate);

        const { opened: wcOpened, closed: wcClosed } = aggregateWorkClassificationBySprint(
          issues,
          sprint.startDate,
          sprint.endDate,
        );
        const workClassificationTableMd = formatWorkClassificationMarkdownTable(wcOpened, wcClosed);

        const { opened: epOpened, closed: epClosed } = aggregateEpicWorkBySprint(
          issues,
          sprint.startDate,
          sprint.endDate,
        );
        const epicWorkTableMd = formatEpicWorkMarkdownTable(epOpened, epClosed);

        const hygieneData = computeHygieneMetrics(issues, sprint.startDate);
        const hygieneSectionMd = formatHygieneSectionMd(hygieneData);

        // TestRail metrics for current and previous sprint.
        const trIds = project.testRailProjectIds || [];
        const trCur = await getTestRailMetrics(trIds, sprint.startDate, sprint.endDate);
        const trPrev = prevSprint
          ? await getTestRailMetrics(trIds, prevSprint.startDate, prevSprint.endDate)
          : null;

        // Derived quality metrics — only compute BFR when bugs opened > 0
        // and values are valid (exclude undefined/N/A/zero).
        const cBfrNum = (cbo > 0 && Number.isFinite(cbc)) ? Math.round((cbc / cbo) * 100) : null;
        const pBfrNum = (pbo > 0 && Number.isFinite(pbc)) ? Math.round((pbc / pbo) * 100) : null;
        const cDdrNum = csp > 0 ? parseFloat((cbo / csp).toFixed(2)) : null;
        const pDdrNum = psp > 0 ? parseFloat((pbo / psp).toFixed(2)) : null;
        const cCarNum = cTotalSp > 0 ? Math.round(((cTotalSp - csp) / cTotalSp) * 100) : null;
        const pCarNum = pTotalSp > 0 ? Math.round(((pTotalSp - psp) / pTotalSp) * 100) : null;

        // Per-member rows for section 2.1.
        const memberRows = [...curMembers.entries()]
          .sort((a, b) => b[1].sp - a[1].sp)
          .map(([name, cur]) => {
            const prev = prevMembers.get(name);
            const trend = !prev ? "?" : cur.ct > prev.ct ? "?" : cur.ct < prev.ct ? "?" : "?";
            return `| ${shortDisplayName(name)} | ${cur.sp} | ${cur.ct} | ${trend} | No |`;
          })
          .join("\n");
        const teamTotalRow = `| **Team total** | **${csp}** | **${cct}** | | |`;
        const memberSection = memberRows + (memberRows ? "\n" + teamTotalRow : teamTotalRow);

        const sprintStatus = sprintDetails?.state
          ? sprintDetails.state.charAt(0).toUpperCase() + sprintDetails.state.slice(1).toLowerCase()
          : (sprint.state ? sprint.state.charAt(0).toUpperCase() + sprint.state.slice(1).toLowerCase() : "Unknown");

        const dataAtFormatted = formatDataAt(new Date());

        let content = applyTemplate(templateContent, {
          meta: {
            Product:        project.name,
            ...(project.parent ? { Parent: project.parent } : {}),
            Manager:        project.manager || "",
            "Sprint name":  periodVal,
            "Review date":  reviewDateVal,
            Status:         sprintStatus,
            DataAt:         dataAtFormatted,
          },
          tokens: {
            CSP:               csp,
            PSP:               psp,
            CASP:              casp,
            PASP:              pasp,
            CQASP:             cqasp,
            PQASP:             pqasp,
            CDEVSP:            csp - cqasp,
            PDEVSP:            psp - pqasp,
            CCT:               cct,
            PCT:               pct,
            CSCR:              cscr,
            PSCR:              pscr,
            CBO:               cbo,
            PBO:               pbo,
            CBC:               cbc,
            PBC:               pbc,
            Arrow_StoryPoints: csp > psp ? "?" : csp < psp ? "?" : "-",
            Arrow_ActualStoryPoints: casp > pasp ? "?" : casp < pasp ? "?" : "-",
            Arrow_QAPoints: cqasp > pqasp ? "?" : cqasp < pqasp ? "?" : "-",
            Arrow_DevPoints: (csp - cqasp) > (psp - pqasp) ? "?" : (csp - cqasp) < (psp - pqasp) ? "?" : "-",
            Arrow_Tickets:     cct > pct ? "?" : cct < pct ? "?" : "-",
            Arrow_BugsOpened:  cbo > pbo ? "?" : cbo < pbo ? "?" : "-",
            Arrow_BugsClosed:  cbc > pbc ? "?" : cbc < pbc ? "?" : "-",
            CCYT:              ccyt,
            PCYT:              pcyt,
            // Lower cycle time is better — flip the arrow direction.
            Arrow_CycleTime:   (ccyt === "N/A" || pcyt === "N/A") ? "-" : Number(ccyt) < Number(pcyt) ? "?" : Number(ccyt) > Number(pcyt) ? "?" : "-",
            CB:                cblk,
            PB:                pblk,
            Arrow_Blockers:    cblk < pblk ? "?" : cblk > pblk ? "?" : "-",
            CBFR:              cBfrNum !== null ? cBfrNum + "%" : "N/A",
            PBFR:              pBfrNum !== null ? pBfrNum + "%" : "N/A",
            Arrow_BugFixRate:  (cBfrNum === null || pBfrNum === null) ? "-" : cBfrNum > pBfrNum ? "?" : cBfrNum < pBfrNum ? "?" : "-",
            CDDR:              cDdrNum !== null ? cDdrNum : "N/A",
            PDDR:              pDdrNum !== null ? pDdrNum : "N/A",
            Arrow_DefectDensity: (cDdrNum === null || pDdrNum === null) ? "-" : cDdrNum < pDdrNum ? "?" : cDdrNum > pDdrNum ? "?" : "-",
            CCAR:              cCarNum !== null ? cCarNum + "%" : "N/A",
            PCAR:              pCarNum !== null ? pCarNum + "%" : "N/A",
            Arrow_Carryover:   (cCarNum === null || pCarNum === null) ? "-" : cCarNum < pCarNum ? "?" : cCarNum > pCarNum ? "?" : "-",
            CREGPCT:           cRegPct + "%",
            PREGPCT:           pRegPct + "%",
            CREGDAYS:          cRegDays,
            CTOTDAYS:          cTotDays,
            WORK_CLASSIFICATION_TABLE: workClassificationTableMd,
            WORK_EPIC_TABLE: epicWorkTableMd,
            HYGIENE_SECTION:   hygieneSectionMd,
            TR_CASES_CREATED:  trCur.casesCreated,
            TR_PCASES_CREATED: trPrev ? trPrev.casesCreated : "N/A",
            Arrow_TRCasesCreated: !trPrev ? "-" : trCur.casesCreated > trPrev.casesCreated ? "?" : trCur.casesCreated < trPrev.casesCreated ? "?" : "-",
            TR_RUNS_CREATED:   trCur.runsCreated,
            TR_PRUNS_CREATED:  trPrev ? trPrev.runsCreated : "N/A",
            Arrow_TRRunsCreated: !trPrev ? "-" : trCur.runsCreated > trPrev.runsCreated ? "?" : trCur.runsCreated < trPrev.runsCreated ? "?" : "-",
            TR_PLANS_CREATED:  trCur.plansCreated,
            TR_PPLANS_CREATED: trPrev ? trPrev.plansCreated : "N/A",
            Arrow_TRPlansCreated: !trPrev ? "-" : trCur.plansCreated > trPrev.plansCreated ? "?" : trCur.plansCreated < trPrev.plansCreated ? "?" : "-",
            TR_TOTAL_CASES:    trCur.automation.totalCases,
            TR_AUTO_COUNT:     trCur.automation.automated,
            TR_AUTO_PCT:       trCur.automation.automationPct,
            TR_AUTO_INPROG:    trCur.automation.inProgress,
            TR_MANUAL_COUNT:   trCur.automation.manualOnly,
            TR_MANUAL_PCT:     trCur.automation.manualPct,
            TR_AUTO_BY_TYPE:   Object.keys(trCur.automation.byType).length > 0
              ? Object.entries(trCur.automation.byType).map(([k, v]) => `${k}: ${v}`).join(", ")
              : "—",
          },
        });

        // Remove **Parent:** line if project.parent is not set.
        if (!project.parent) {
          content = content.replace(/^\*\*Parent:\*\*.*$(\r?\n)?/m, "");
        }
        // Inject **Board:** line after **Product:** for dashboard consumption.
        content = content.replace(
          /^(\*\*Product:\*\*.*)$/m,
          `$1\n**Board:** ${boardTypeLabel}`,
        );
        // Normalise legacy **Period:** to **Sprint name:** so output is consistent.
        content = content.replace(/^\*\*Period:\*\* *(.*)$/m, "**Sprint name:** $1");

        // Replace placeholder member row with actual per-member rows + team total (section 2.1).
        content = content.replace(
          /\|\s*DevName\s*\|\s*SPCompleted\s*\|\s*TicketsClosed\s*\|\s*TicketsTrend\s*\|[^\n]*/,
          memberSection,
        );

        // Build per-member rows for section 2.2 AI adoption & impact (exclude Unassigned).
        // Rating 1-4: base from SP, then boost if member in Cursor leaderboard
        // or project has good AI adoption in Cursor.
        const aiMemberNames = [...curMembers.keys()].filter((name) => !/unassigned/i.test(name || ""));
        const spValues = aiMemberNames.map((name) => curMembers.get(name).sp);
        const minSp = spValues.length ? Math.min(...spValues) : 0;
        const maxSp = spValues.length ? Math.max(...spValues) : 0;
        const spRange = maxSp - minSp;
        const projectNameForCursor = project.name || "";
        const aiRows = aiMemberNames
          .sort((a, b) => curMembers.get(b).sp - curMembers.get(a).sp)
          .map((name) => {
            const sp = curMembers.get(name).sp;
            const clampedRating = computeAiAdoptionRating(name, sp, minSp, spRange, cursorData, projectNameForCursor);
            const inLeaderboard = cursorData && memberMatchesCursorLeaderboard(name, cursorData);
            const repoMatch = cursorData && projectMatchesCursorRepo(projectNameForCursor, cursorData);
            let notes = "Still Onboarding";
            if (inLeaderboard && repoMatch.match) notes = "Cursor leaderboard; strong AI adoption in project";
            else if (inLeaderboard) notes = "Cursor leaderboard";
            else if (repoMatch.match && (repoMatch.codeCommittedByAiPct || 0) >= 40) notes = "High AI adoption in project";
            return `| ${shortDisplayName(name)} | ${clampedRating} | - | ${notes} |`;
          })
          .join("\n");

        content = content.replace(
          /\|\s*DevName\s*\|\s*AILevel\s*\|\s*ChangeVSLastWeek\s*\|\s*Notes\s*\|[^\n]*/,
          aiRows,
        );

        // Build per-member rows for section 2.3 Github Metrics (same member order as 2.2).
        const ghMemberNames = [...curMembers.keys()].filter((name) => !/unassigned/i.test(name || ""));
        /**
         * resolve a JIRA display name to a GitHub login.
         *
         * Priority order:
         *   1. Manual `github-users.json` override (deterministic).
         *   2. `output/resource-directory.json` per-user `githubLogin`.
         *   3. Fuzzy match against live org member logins (first-name hard gate).
         *   4. Derived `firstname-lastname-VeloSync` fallback, ONLY if that login
         *      actually exists in the org member list. Otherwise we return
         *      null so the metrics cell stays "—" rather than issuing a
         *      query that could accidentally hit a bot/service account or a
         *      real (wrong) user.
         *
         * Bot/service accounts (`isBotLogin`) are never returned, even if
         * they fuzzy-match.
         */
        const resolveGitHubLogin = (displayName) =>
          resolveJiraDisplayNameToGithubLogin(displayName, {
            githubUserMap,
            rdGithubByDisplay,
            orgMemberLogins,
            orgMemberLoginsLower,
            unresolvedSet: unresolvedGhNames,
          });

        let githubRows = "";
        if (ghMemberNames.length > 0 && githubToken && githubOrg && sprint.startDate && sprint.endDate) {
          const sortedGhMembers = ghMemberNames.sort((a, b) => curMembers.get(b).sp - curMembers.get(a).sp);
          const rows = [];
          for (const name of sortedGhMembers) {
            const login = resolveGitHubLogin(name);
            let reposList = "—";
            let prCount = "—";
            let commitsCount = "—";
            let additions = "—";
            let deletions = "—";
            let note = "";
            if (login) {
              const metrics = await getGitHubMetricsForUser(login, githubOrg, sprint.startDate, sprint.endDate, githubToken);
              const repos = metrics.repos || [];
              reposList = repos.length === 0 ? "—" : (repos.length <= 3 ? repos.join(", ") : `${repos.slice(0, 2).join(", ")} +${repos.length - 2} more`);
              prCount = metrics.prCount;
              commitsCount = metrics.commitsCount;
              additions = metrics.additions;
              deletions = metrics.deletions;
              if (metrics.note) note = metrics.note;
            } else {
              // Keep zeros (rather than dashes) so the dashboard can still
              // show the person in the leaderboard; the note makes it
              // clear why metrics are empty.
              prCount = 0;
              commitsCount = 0;
              additions = 0;
              deletions = 0;
              note = "Unresolved GitHub login — set githubLogin in output/resource-directory.json or add jira-md-export/github-users.json";
            }
            rows.push(`| ${shortDisplayName(name)} | ${reposList} | ${prCount} | ${commitsCount} | ${additions} | ${deletions} | ${note} |`);
          }
          githubRows = rows.join("\n");
        } else {
          const fallbackRows = [...curMembers.keys()]
            .filter((name) => !/unassigned/i.test(name || ""))
            .sort((a, b) => curMembers.get(b).sp - curMembers.get(a).sp)
            .map((name) => `| ${shortDisplayName(name)} | — | — | — | — | — | ${(!githubToken || !githubOrg) ? "GITHUB_TOKEN/ORG not set" : "—"} |`)
            .join("\n");
          githubRows = fallbackRows || "| — | — | — | — | — | — | — |";
        }

        content = content.replace(
          /\|\s*DevName\s*\|\s*ReposList\s*\|\s*PRCount\s*\|\s*CommitsCount\s*\|\s*Additions\s*\|\s*Deletions\s*\|\s*Notes\s*\|[^\n]*/,
          githubRows,
        );

        // Build per-QA-assignee rows for section 2.4 QA Output.
        const qaMembers = new Map();
        for (const it of issues) {
          if (!it.qaAssignee || !it.isDone) continue;
          const qaName = it.qaAssignee;
          if (!qaMembers.has(qaName)) qaMembers.set(qaName, { qp: 0, ct: 0 });
          const m = qaMembers.get(qaName);
          m.qp += it.qaPoints || 0;
          m.ct++;
        }
        const qaRows = qaMembers.size === 0
          ? "| — | 0 | 0 | No QA data |"
          : [...qaMembers.entries()]
              .sort((a, b) => b[1].qp - a[1].qp)
              .map(([name, v]) => `| ${shortDisplayName(name)} | ${v.qp} | ${v.ct} | |`)
              .join("\n");
        const qaTotalRow = qaMembers.size > 0
          ? `| **QA total** | **${cqasp}** | **${[...qaMembers.values()].reduce((s, v) => s + v.ct, 0)}** | |`
          : "";
        const qaSection = qaRows + (qaTotalRow ? "\n" + qaTotalRow : "");
        content = content.replace(
          /\|\s*QAName\s*\|\s*QASPCompleted\s*\|\s*QATicketsClosed\s*\|[^\n]*/,
          qaSection,
        );

        // Build per-member rows for section 2.5 Confluence Activity.
        if (confluenceAvailable && confluenceAuth && sprint.startDate && sprint.endDate) {
          const confMemberNames = [...curMembers.keys()].filter((name) => !/unassigned/i.test(name || ""));
          const accountIdMap = new Map();
          for (const it of issues) {
            if (it.assignee && it.assigneeAccountId && !accountIdMap.has(it.assignee)) {
              accountIdMap.set(it.assignee, it.assigneeAccountId);
            }
          }

          const confRows = [];
          const sortedConfMembers = confMemberNames.sort((a, b) => curMembers.get(b).sp - curMembers.get(a).sp);
          for (const name of sortedConfMembers) {
            const acctId = accountIdMap.get(name);
            if (!acctId) {
              confRows.push(`| ${shortDisplayName(name)} | — | — | — | No Atlassian accountId |`);
              continue;
            }
            try {
              const activity = await getConfluenceActivityForUser(jiraDomain, confluenceAuth, acctId, sprint.startDate, sprint.endDate);
              const spacesStr = activity.spaces.length > 0
                ? (activity.spaces.length <= 2 ? activity.spaces.join(", ") : `${activity.spaces.slice(0, 2).join(", ")} +${activity.spaces.length - 2}`)
                : "—";
              confRows.push(`| ${shortDisplayName(name)} | ${activity.created} | ${activity.edited} | ${spacesStr} | |`);
            } catch (e) {
              confRows.push(`| ${shortDisplayName(name)} | — | — | — | Error: ${e.message?.slice(0, 30) || "unknown"} |`);
            }
          }
          const confluenceRowStr = confRows.length > 0 ? confRows.join("\n") : "| — | 0 | 0 | — | No data |";
          content = content.replace(
            /\|\s*DevName\s*\|\s*ConfCreated\s*\|\s*ConfEdited\s*\|\s*ConfSpaces\s*\|[^\n]*/,
            confluenceRowStr,
          );
        } else {
          content = content.replace(
            /\|\s*DevName\s*\|\s*ConfCreated\s*\|\s*ConfEdited\s*\|\s*ConfSpaces\s*\|[^\n]*/,
            "| — | — | — | — | Confluence not available |",
          );
        }

        // Build per-QA rows for section 2.7 TestRail QA by Individual (authorship metrics).
        if (trCur.byPerson.length > 0) {
          const trQaRows = trCur.byPerson
            .map((p) => `| ${shortDisplayName(p.name)} | ${p.casesCreated} | ${p.runsCreated} | ${p.plansCreated} | |`)
            .join("\n");
          const trQaTotal = `| **Total** | **${trCur.casesCreated}** | **${trCur.runsCreated}** | **${trCur.plansCreated}** | |`;
          const trQaSection = trQaRows + "\n" + trQaTotal;
          content = content.replace(
            /\|\s*TRQAName\s*\|\s*TRCasesCreated\s*\|\s*TRRunsCreated\s*\|\s*TRPlansCreated\s*\|\s*TRNotes\s*\|[^\n]*/,
            trQaSection,
          );
        } else {
          content = content.replace(
            /\|\s*TRQAName\s*\|\s*TRCasesCreated\s*\|\s*TRRunsCreated\s*\|\s*TRPlansCreated\s*\|\s*TRNotes\s*\|[^\n]*/,
            "| — | 0 | 0 | 0 | No TestRail data |",
          );
        }

        // Replace the single blocker placeholder row with one row per blocker ticket.
        const blockerIssues = issues.filter((it) => it.isBlocker);
        const blockerRows = blockerIssues.length === 0
          ? "| No blockers | — | — | — |"
          : blockerIssues
              .map((it) => `| ${it.key} | ${it.priority} | ${shortDisplayName(it.assignee)} | ${it.summary} |`)
              .join("\n");
        content = content.replace(
          /\|\s*BlockerTicket\s*\|\s*SeverityOfTicket\s*\|\s*AssignedTo\s*\|\s*Monitor\s*\|[^\n]*/,
          blockerRows,
        );

        await fs.promises.writeFile(outPath, content, "utf8");
        console.log(`Wrote sprint file [${i + 1}/${orderedSprints.length}]:`, outPath);

        // Delta mode: when a sprint just transitioned active?closed, remove
        // the stale [ACTIVE] snapshot so only the authoritative closed file
        // remains.
        if (action.staleToDelete) {
          try {
            await fs.promises.unlink(action.staleToDelete);
            console.log(`[Delta] Removed stale active snapshot: ${action.staleToDelete}`);
          } catch (unlinkErr) {
            if (unlinkErr.code !== "ENOENT") {
              console.warn(`[Delta] Could not remove stale file ${action.staleToDelete}:`, unlinkErr.message);
            }
          }
        }
      } catch (e) {
        console.warn(`Failed to write output file for sprint "${orderedSprints[i]?.name}":`, e.message || e);
      }
    }
  }

  // -- Print unresolved GitHub logins so the operator can fix the directory --
  if (unresolvedGhNames.size > 0) {
    console.warn("\n========================================");
    console.warn(`  Unresolved GitHub logins: ${unresolvedGhNames.size}`);
    console.warn("  Set githubLogin on each person in output/resource-directory.json, or add");
    console.warn("  jira-md-export/github-users.json entries (see github-users.README.md).");
    console.warn("========================================");
    const sorted = [...unresolvedGhNames].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    for (const name of sorted) {
      console.warn(`  - ${name}`);
    }
    console.warn("========================================\n");
  }

  // -- Write files.json listing all .md files in the output folder --
  try {
    await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
    const allFiles = await fs.promises.readdir(OUTPUT_DIR);
    const mdFiles = allFiles.filter((f) => f.endsWith(".md"));
    const filesJsonPath = path.join(OUTPUT_DIR, "files.json");
    const filesPayload = { files: mdFiles, lastSync: new Date().toISOString() };
    await fs.promises.writeFile(filesJsonPath, JSON.stringify(filesPayload, null, 2), "utf8");
    console.log(`Wrote files.json with ${mdFiles.length} entry(ies) and lastSync:`, filesJsonPath);
  } catch (e) {
    console.warn("Failed to write files.json:", e.message || e);
  }

  // Stage dwell data (aggregated across all projects and sprints).
  try {
    if (stageDwellAccumulator.size > 0) {
      const avgDwellByStage = [];
      for (const [, val] of stageDwellAccumulator.entries()) {
        if (val.count > 0) {
          avgDwellByStage.push({
            stage: val.display,
            avgDays: parseFloat((val.totalDays / val.count).toFixed(2)),
            count: val.count,
            position: val.minPosition,
          });
        }
      }
      avgDwellByStage.sort((a, b) => a.position - b.position);
      await fs.promises.writeFile(
        path.join(OUTPUT_DIR, "stagedwelldata.json"),
        JSON.stringify({ avgDwellByStage, totalTickets: stageDwellTotalIssueCount, ticketsWithDwellData: stageDwellTicketCount, lastSync: new Date().toISOString() }, null, 2),
        "utf8",
      );
      console.log(`Wrote stagedwelldata.json — ${avgDwellByStage.length} stage(s), ${stageDwellTicketCount} with dwell data out of ${stageDwellTotalIssueCount} total ticket(s).`);
    } else {
      console.log("Stage dwell: no data collected (no changelogs with start-stage transitions found).");
    }
  } catch (e) {
    console.warn("Failed to write stagedwelldata.json:", e.message || e);
  }

  console.log("\n===== Done =====\n");
}

// Auto-run when this file is the process entrypoint.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  run();
}
