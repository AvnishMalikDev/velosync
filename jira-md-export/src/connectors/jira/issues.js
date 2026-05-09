/**
 * JIRA issue fetching + normalisation.
 *
 *   - `fetchSprintIssuesViaSearchApi`  modern enhanced JQL endpoint, returns
 *                                      every field (incl. non-navigable
 *                                      custom fields), with embedded
 *                                      changelog so we don't N+1 fetch it.
 *   - `fetchSprintIssuesViaAgileApi`   legacy Agile sprint-issue endpoint
 *                                      used as fallback; cheaper but may
 *                                      omit custom fields.
 *   - `processRawIssues`               flatten Jira's verbose response into
 *                                      our internal Issue model (story
 *                                      points, cycle markers, stage dwells,
 *                                      classification flags, …).
 *   - `getSprintIssues`                helper that combines fetch + process
 *                                      with the right fallback chain.
 *
 * Exported as a connector module so the orchestrator only deals with our
 * normalised Issue shape, never raw JIRA payloads.
 */

import { jiraGet, jiraUrl, jiraDomain } from "./client.js";
import { jiraHeaders } from "../../core/jira-auth.js";
import { extractWorkClassification } from "./fields.js";
import { getStageSets } from "../../domain/stages.js";
import { extractEpicLabel } from "../../domain/epics.js";

/** Reject bogus numeric custom fields (rank IDs, etc.) mistaken for story points. Override via `JIRA_STORY_POINTS_MAX_VALUE`. */
const DEFAULT_JIRA_STORY_POINTS_MAX_PER_ISSUE = 500;

/**
 * Coerce a JIRA custom-field value to a finite number, accepting plain
 * numbers, numeric strings, and `{ value: ... }` / `{ name: ... }` objects.
 * Returns null for anything else.
 */
function coerceNumericJiraValue(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && String(v).trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  if (v && typeof v === "object") {
    if (typeof v.value === "number" && Number.isFinite(v.value)) return v.value;
    if (typeof v.value === "string" && String(v.value).trim() !== "" && !Number.isNaN(Number(v.value))) return Number(v.value);
    if (typeof v.name === "string" && String(v.name).trim() !== "" && !Number.isNaN(Number(v.name))) return Number(v.name);
  }
  return null;
}

/**
 * Story point inference for issues without the standard SP fields.
 *
 * Only accepts numeric `customfield_*` values within `[0, maxPerIssue]`. When
 * multiple custom fields qualify we pick the smallest positive — the typical
 * Story Points value, avoiding stray zeros and "rank ID"-shaped numbers
 * (1234567890123). Set `JIRA_STORY_POINTS_FIELD_ID` to force a specific id.
 */
function inferStoryPointsFromCustomFields(f, explicitFieldId, maxPerIssue) {
  if (explicitFieldId && f[explicitFieldId] != null) {
    const n = coerceNumericJiraValue(f[explicitFieldId]);
    if (n != null && n >= 0 && n <= maxPerIssue) return n;
  }
  const candidates = [];
  for (const k of Object.keys(f)) {
    if (!k.startsWith("customfield_")) continue;
    const n = coerceNumericJiraValue(f[k]);
    if (n == null || !Number.isFinite(n) || n < 0 || n > maxPerIssue) continue;
    candidates.push(n);
  }
  if (candidates.length === 0) return 0;
  const positives = candidates.filter((x) => x > 0);
  if (positives.length > 0) return Math.min(...positives);
  return 0;
}

/**
 * Load sprint issues via the modern enhanced JQL search (`fields=*all`).
 *
 * The legacy `/rest/api/3/search` was retired (410). The agile sprint-issue
 * endpoint sometimes drops non-navigable custom fields (Work Classification),
 * so this is the preferred source. Pages are 50 deep (vs the API max of 100)
 * because each row carries its full changelog (`expand=changelog`) and
 * larger pages occasionally cause JIRA cloud to silently auto-shrink the
 * batch.
 */
export async function fetchSprintIssuesViaSearchApi(sprintId) {
  const issues = [];
  const maxResults = 50;
  const jql = `sprint = ${sprintId} AND assignee is not EMPTY`;
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
      throw new Error(`${response.status} ${errBody.slice(0, 300)}`);
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
 * Fallback: classic Agile sprint-issue API. Faster but may omit some custom
 * fields, so it's only used when the enhanced JQL endpoint errors out.
 */
export async function fetchSprintIssuesViaAgileApi(sprintId) {
  const response = await jiraGet(jiraUrl(`/rest/agile/1.0/sprint/${sprintId}/issue?maxResults=1000`));
  if (!response.ok) {
    throw new Error(`Sprint issues fetch failed: ${response.status}`);
  }
  const data = await response.json();
  return data.issues || [];
}

/**
 * Flatten raw JIRA issues into the normalised shape every downstream metric
 * consumes. Shared between the Sprint and Kanban paths so cycle-time / SP /
 * QA / classification logic stays consistent.
 *
 * Only assigned issues are kept — un-assigned tickets do not contribute to
 * any per-person rollup the dashboard renders.
 *
 * @param {Array<object>} rawIssues
 * @param {object|null} project
 * @param {string[]|null} workClassificationFieldIds
 * @param {string|null} actualSpFieldId
 * @param {string|null} qaPointsFieldId
 * @param {string|null} qaAssigneeFieldId
 */
export async function processRawIssues(
  rawIssues,
  project = null,
  workClassificationFieldIds = null,
  actualSpFieldId = null,
  qaPointsFieldId = null,
  qaAssigneeFieldId = null,
) {
  const { startStages, cycleEndStages, doneStages } = getStageSets(project || {});

  const assignedIssues = rawIssues.filter((iss) => {
    const f = iss.fields || {};
    return !!f.assignee;
  });

  return await Promise.all(assignedIssues.map(async (iss) => {
    const f = iss.fields || {};
    const assignee = f.assignee
      ? (f.assignee.displayName || f.assignee.emailAddress || f.assignee.accountId)
      : "Unassigned";
    const assigneeAccountId = f.assignee?.accountId || null;

    // Robust story point extraction.
    let storyPoints = 0;
    if (typeof f.storyPoints === "number") storyPoints = f.storyPoints;
    else if (typeof f.customfield_10002 === "number") storyPoints = f.customfield_10002;
    else {
      const maxSpRaw = Number(process.env.JIRA_STORY_POINTS_MAX_VALUE);
      const maxPerIssue =
        Number.isFinite(maxSpRaw) && maxSpRaw > 0 ? maxSpRaw : DEFAULT_JIRA_STORY_POINTS_MAX_PER_ISSUE;
      const explicitSpField = (process.env.JIRA_STORY_POINTS_FIELD_ID || "").trim();
      storyPoints = inferStoryPointsFromCustomFields(f, explicitSpField || null, maxPerIssue);
    }

    let actualStoryPoints = 0;
    if (actualSpFieldId && f[actualSpFieldId] != null) {
      const raw = f[actualSpFieldId];
      if (typeof raw === "number") actualStoryPoints = raw;
      else if (typeof raw === "string" && !isNaN(Number(raw))) actualStoryPoints = Number(raw);
      else if (raw && typeof raw === "object") {
        if (typeof raw.value === "number") actualStoryPoints = raw.value;
        else if (typeof raw.value === "string" && !isNaN(Number(raw.value))) actualStoryPoints = Number(raw.value);
      }
    }

    let qaPoints = 0;
    if (qaPointsFieldId && f[qaPointsFieldId] != null) {
      const raw = f[qaPointsFieldId];
      if (typeof raw === "number") qaPoints = raw;
      else if (typeof raw === "string" && !isNaN(Number(raw))) qaPoints = Number(raw);
      else if (raw && typeof raw === "object") {
        if (typeof raw.value === "number") qaPoints = raw.value;
        else if (typeof raw.value === "string" && !isNaN(Number(raw.value))) qaPoints = Number(raw.value);
      }
    }

    let qaAssignee = null;
    if (qaAssigneeFieldId && f[qaAssigneeFieldId] != null) {
      const raw = f[qaAssigneeFieldId];
      if (typeof raw === "string") qaAssignee = raw.trim() || null;
      else if (raw && typeof raw === "object") {
        qaAssignee = (raw.displayName || raw.emailAddress || raw.name || raw.accountId || "").toString().trim() || null;
      }
    }

    // Done = JIRA "Done" category OR current status name matches doneStages
    // (projects.json endStage UNION DEFAULT_END_STAGES — i.e. include
    // downstream/terminal statuses so a ticket past Ready for Staging still
    // counts as complete for SP totals).
    let isDone = false;
    if (f.status) {
      const scKey = (f.status.statusCategory?.key != null)
        ? String(f.status.statusCategory.key).trim().toLowerCase()
        : "";
      const sName = (f.status.name != null)
        ? String(f.status.name).trim().toLowerCase()
        : "";
      if (scKey === "done" || (sName !== "" && doneStages.has(sName))) isDone = true;
    }

    // Cycle: start = first transition to any project startStage; end = first
    // transition to any project cycleEndStage (STRICTLY from projects.json —
    // see getStageSets comment).
    let cycleStart = null;
    let cycleEnd = null;
    let stageDwells = {};
    try {
      // Use the changelog already embedded in the bulk search response
      // (`expand=changelog`). Fall back to a per-issue fetch only when the
      // bulk response didn't include it.
      let rawHistories = iss.changelog?.histories ?? null;
      if (!rawHistories) {
        const chRes = await fetch(`https://${jiraDomain}/rest/api/3/issue/${iss.id}?expand=changelog`, {
          headers: jiraHeaders,
        });
        if (chRes.ok) {
          const chData = await chRes.json();
          rawHistories = chData.changelog?.histories ?? null;
        }
      }
      if (rawHistories) {
        const histories = Array.isArray(rawHistories)
          ? rawHistories.slice().sort((a, b) => new Date(a.created) - new Date(b.created))
          : [];
        // Fallback: if the very first status transition's `fromString` is a
        // startStage, the issue was CREATED at that stage (no changelog
        // entry for entering it). Use issue creation date as cycleStart so
        // cycle time is not lost.
        const firstStatusItem = histories
          .flatMap((h) => (h.items || []).map((it) => ({ ...it, created: h.created })))
          .find((it) => String(it.field ?? "").trim().toLowerCase() === "status");
        if (firstStatusItem && !cycleStart) {
          const fromVal = String(firstStatusItem.fromString ?? firstStatusItem.from ?? "").trim().toLowerCase();
          if (fromVal && startStages.has(fromVal)) {
            cycleStart = iss.fields?.created ?? null;
          }
        }

        for (const h of histories) {
          for (const item of (h.items || [])) {
            const fieldKey = String(item.field ?? "").trim().toLowerCase();
            if (fieldKey !== "status") continue;
            // JIRA: `toString` = human-readable status name; fallback to `to`.
            const rawTo = item.toString ?? item.to ?? "";
            const toVal = String(rawTo).trim().toLowerCase();
            if (!toVal) continue;
            if (!cycleStart && startStages.has(toVal)) {
              cycleStart = h.created ?? null;
            }
            // End only after start so cycle duration is never anchored to a
            // pre-start end transition. Use cycleEndStages (STRICT,
            // projects.json only) so the cycle is measured exactly to the
            // configured end stage and not silently extended via default
            // downstream statuses.
            if (cycleStart && !cycleEnd && cycleEndStages.has(toVal)) {
              cycleEnd = h.created ?? null;
            }
          }
        }

        // Stage dwell: time spent at each stage from LAST start-stage entry
        // to done. Using the LAST entry (not first) ensures tickets that
        // bounced back to pre-dev stages (e.g. rejected ? Engineering Review
        // ? Ready for Dev again) don't pollute the chart with backward-
        // regression stages.
        const localEffCycleEnd = f.resolutiondate || cycleEnd;
        const sdTimeline = [];
        // If issue was CREATED at a startStage (first fromString is a
        // startStage), inject it as the synthetic first entry so dwell time
        // from creation is captured.
        if (firstStatusItem) {
          const fromName = String(firstStatusItem.fromString ?? firstStatusItem.from ?? "").trim();
          const fromSl = fromName.toLowerCase();
          if (fromName && startStages.has(fromSl) && iss.fields?.created) {
            sdTimeline.push({ status: fromName, sl: fromSl, ts: new Date(iss.fields.created).getTime() });
          }
        }
        for (const h of histories) {
          for (const item of (h.items || [])) {
            if (String(item.field ?? "").trim().toLowerCase() !== "status") continue;
            const toName = String(item.toString ?? item.to ?? "").trim();
            if (toName) sdTimeline.push({ status: toName, sl: toName.toLowerCase(), ts: new Date(h.created).getTime() });
          }
        }
        // Find the LAST transition into any start stage — anchors to the
        // ticket's final run.
        let sdi = -1;
        for (let ti = 0; ti < sdTimeline.length; ti++) {
          if (startStages.has(sdTimeline[ti].sl)) sdi = ti;
        }
        if (sdi >= 0) {
          // Truly terminal stages — ticket lifecycle ends here, don't record
          // dwell. Intermediate delivery stages (ready for staging, staging,
          // ready for release, etc.) are NOT terminal; tickets still move
          // through them and we want their dwell times.
          const terminalStages = new Set([
            "closed", "canceled", "cancelled", "done", "released", "deployed",
            "complete", "completed", "resolved", "accepted", "delivered",
            "won't fix", "wontfix", "rejected", "obsolete", "duplicate",
          ]);
          let pos = 0;
          for (let ti = sdi; ti < sdTimeline.length; ti++) {
            const curr = sdTimeline[ti];
            if (terminalStages.has(curr.sl)) break;
            const nextTs = ti + 1 < sdTimeline.length ? sdTimeline[ti + 1].ts : null;
            const exitTs = nextTs || (localEffCycleEnd ? new Date(localEffCycleEnd).getTime() : null);
            if (exitTs && exitTs > curr.ts) {
              const days = (exitTs - curr.ts) / (1000 * 60 * 60 * 24);
              if (days > 0 && days < 365) {
                if (!stageDwells[curr.sl]) stageDwells[curr.sl] = { display: curr.status, days, count: 1, position: pos };
                else { stageDwells[curr.sl].days += days; stageDwells[curr.sl].count++; }
              }
            }
            pos++;
          }
        }
      }
    } catch { /* cycleStart/cycleEnd/stageDwells stay null/empty */ }

    // Effective cycle end: PREFER the first transition into the configured
    // endStage so projects.json is honoured exactly. Fall back to
    // resolutiondate only when the ticket never passed through the endStage
    // (e.g. workflow that jumps straight from In Dev ? Closed).
    //
    // The previous priority (resolutiondate || cycleEnd) silently extended
    // every cycle to the JIRA "Done" timestamp, inflating cycle time by all
    // post-staging time (Staging, Ready for Release, Closed, etc.).
    const effectiveCycleEnd = cycleEnd || f.resolutiondate || null;

    const workClassification = extractWorkClassification(f, workClassificationFieldIds);

    // Detect Work Classification = "1. Regulatory" via labels or any custom field.
    const isRegulatory = (() => {
      if (Array.isArray(f.labels) && f.labels.some((l) => /^1\.\s*regulatory/i.test(String(l)))) return true;
      for (const k of Object.keys(f)) {
        if (!k.startsWith("customfield_")) continue;
        const v = f[k];
        if (!v) continue;
        if (typeof v === "string" && /^1\.\s*regulatory/i.test(v)) return true;
        if (typeof v === "object") {
          if (typeof v.value === "string" && /^1\.\s*regulatory/i.test(v.value)) return true;
          if (Array.isArray(v) && v.some((item) => item && /^1\.\s*regulatory/i.test(String(item.value || "")))) return true;
        }
      }
      return false;
    })();

    return {
      key: iss.key,
      summary: f.summary ? String(f.summary).replace(/\|/g, "-") : "N/A",
      assignee,
      assigneeAccountId,
      storyPoints,
      actualStoryPoints,
      qaPoints,
      qaAssignee,
      isDone,
      priority: f.priority ? (f.priority.name || "N/A") : "N/A",
      isBug: !!(f.issuetype && String(f.issuetype.name || "").toLowerCase() === "bug"),
      // Blocker = priority "Blocker", or issue type "Impediment", or
      // flagged/impediment label, or a flagged/impediment custom field.
      isBlocker: !!(
        (f.priority && String(f.priority.name || "").toLowerCase() === "blocker") ||
        (f.issuetype && String(f.issuetype.name || "").toLowerCase() === "impediment") ||
        (Array.isArray(f.labels) && f.labels.some((l) => ["blocker", "blocked", "impediment"].includes(String(l).toLowerCase()))) ||
        (f.flagged === true) ||
        (f.customfield_10021 && Array.isArray(f.customfield_10021) && f.customfield_10021.some((v) => String(v.value || "").toLowerCase() === "impediment"))
      ),
      isRegulatory,
      workClassification,
      epicLabel: extractEpicLabel(f),
      created: f.created || null,
      resolutionDate: f.resolutiondate || null,
      cycleStart,
      effectiveCycleEnd,
      stageDwells,
    };
  }));
}

/**
 * Pull issues for a sprint and normalise them. Tries the modern enhanced JQL
 * endpoint first; falls back to the Agile API on failure (with a warning so
 * the operator knows custom fields might be missing).
 */
export async function getSprintIssues(sprintId, project = null, workClassificationFieldIds = null, actualSpFieldId = null, qaPointsFieldId = null, qaAssigneeFieldId = null) {
  try {
    let issues = [];
    try {
      issues = await fetchSprintIssuesViaSearchApi(sprintId);
    } catch (searchErr) {
      console.warn(
        `  Sprint ${sprintId}: /rest/api/3/search/jql (fields=*all) failed: ${searchErr.message}. Using agile sprint issue API (custom fields may be missing).`,
      );
      issues = await fetchSprintIssuesViaAgileApi(sprintId);
    }
    return await processRawIssues(issues, project, workClassificationFieldIds, actualSpFieldId, qaPointsFieldId, qaAssigneeFieldId);
  } catch (err) {
    console.error(`Error fetching sprint issues ${sprintId}:`, err.message);
    return [];
  }
}
