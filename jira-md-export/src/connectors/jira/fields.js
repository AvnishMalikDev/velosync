/**
 * JIRA custom-field discovery.
 *
 * Many of our metrics depend on JIRA custom fields whose IDs are environment-
 * specific (Work Classification, Actual Story Points, QA Points, QA
 * Assignee). This module resolves each ID once per process via the
 * `/rest/api/3/field` endpoint and caches the result, with explicit overrides
 * supported per-project (in `projects.json`) or per-environment (env var).
 *
 * resolution priority for each field:
 *   1. `project.<fieldName>FieldId`     (projects.json override, comma-list ok)
 *   2. `process.env.JIRA_<NAME>_FIELD_ID`
 *   3. `/rest/api/3/field` discovery (cached on first call)
 *
 * Work Classification can resolve to multiple field IDs because JIRA allows
 * multiple custom fields with the same display name (per project context);
 * we try each in order until one yields a value on the issue.
 */

import { jiraGet, jiraUrl } from "./client.js";

/** Cached `/rest/api/3/field` response; shared across all discovery functions. */
let cachedFieldList;

/** Cached field-ids array for "Work Classification". `undefined` = not resolved, `[]` = none found. */
let cachedWorkClassificationFieldIds;

/** Cached field id for "Actual Story Points" custom field. `undefined` = not resolved, `null` = none found. */
let cachedActualStoryPointsFieldId;

/** Cached field id for "QA Points" custom field. */
let cachedQaPointsFieldId;

/** Cached field id for "QA Assignee" custom field. */
let cachedQaAssigneeFieldId;

/** Fetch and cache the `/rest/api/3/field` response. */
async function getFieldList() {
  if (cachedFieldList !== undefined) return cachedFieldList;
  try {
    const response = await jiraGet(jiraUrl("/rest/api/3/field"));
    if (!response.ok) {
      console.warn(`[Field Discovery] /rest/api/3/field returned HTTP ${response.status} — custom field auto-discovery will not work`);
      cachedFieldList = [];
      return [];
    }
    const fields = await response.json();
    cachedFieldList = Array.isArray(fields) ? fields : [];
    console.log(`[Field Discovery] Fetched ${cachedFieldList.length} JIRA fields`);
    return cachedFieldList;
  } catch (err) {
    console.warn(`[Field Discovery] /rest/api/3/field failed: ${err.message}`);
    cachedFieldList = [];
    return [];
  }
}

/**
 * Discover every custom-field id whose display name is exactly "Work
 * Classification" (case-insensitive). Falls back to a substring match, then
 * surfaces nearby "classif*" field names for diagnostics so an operator
 * can configure `JIRA_WORK_CLASSIFICATION_FIELD_ID` if no match is found.
 */
async function fetchWorkClassificationFieldIds() {
  try {
    const fields = await getFieldList();
    if (fields.length === 0) {
      console.warn("[Work Classification] Field list is empty — cannot auto-discover");
      return [];
    }
    const norm = (n) => String(n || "").trim().toLowerCase();
    const exact = fields.filter((f) => f && f.name && norm(f.name) === "work classification");
    if (exact.length > 0) {
      console.log(`[Work Classification] Found ${exact.length} exact match(es): ${exact.map((f) => f.id + " (" + f.name + ")").join(", ")}`);
      return exact.map((f) => f.id).filter(Boolean);
    }
    const loose = fields.filter((f) => f && f.name && norm(f.name).includes("work classification"));
    if (loose.length > 0) {
      console.log(`[Work Classification] Found ${loose.length} loose match(es): ${loose.map((f) => f.id + " (" + f.name + ")").join(", ")}`);
      return loose.map((f) => f.id).filter(Boolean);
    }
    const classifyLike = fields.filter((f) => f && f.name && /classif/i.test(f.name));
    if (classifyLike.length > 0) {
      console.log(`[Work Classification] No "Work Classification" found. Similar fields: ${classifyLike.slice(0, 10).map((f) => f.id + " (" + f.name + ")").join(", ")}`);
    } else {
      console.log('[Work Classification] No field matching "classification" found in JIRA field list');
    }
    return [];
  } catch (err) {
    console.warn(`[Work Classification] Discovery failed: ${err.message}`);
    return [];
  }
}

/** resolve Work Classification field IDs: project override ? env (comma-separated) ? API discovery. */
export async function resolveWorkClassificationFieldIds(project) {
  const fromProject = project?.workClassificationFieldId;
  if (fromProject != null && String(fromProject).trim() !== "") {
    return String(fromProject)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const fromEnv = process.env.JIRA_WORK_CLASSIFICATION_FIELD_ID;
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    return String(fromEnv)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (cachedWorkClassificationFieldIds !== undefined) return cachedWorkClassificationFieldIds;
  cachedWorkClassificationFieldIds = await fetchWorkClassificationFieldIds();
  return cachedWorkClassificationFieldIds;
}

/**
 * Generic single-field discoverer used by Actual SP / QA Points / QA Assignee.
 * Returns the first matching field id or null.
 */
async function fetchSingleFieldId(targetName, looseSubstring) {
  try {
    const fields = await getFieldList();
    if (fields.length === 0) return null;
    const norm = (n) => String(n || "").trim().toLowerCase();
    const exact = fields.find((f) => f && f.name && norm(f.name) === targetName);
    if (exact) return exact.id;
    const loose = fields.find((f) => f && f.name && norm(f.name).includes(looseSubstring));
    return loose ? loose.id : null;
  } catch {
    return null;
  }
}

/** resolve "Actual Story Points" field id: env override ? API discovery (cached). */
export async function resolveActualStoryPointsFieldId() {
  const fromEnv = process.env.JIRA_ACTUAL_STORY_POINTS_FIELD_ID;
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    return String(fromEnv).trim();
  }
  if (cachedActualStoryPointsFieldId !== undefined) return cachedActualStoryPointsFieldId;
  cachedActualStoryPointsFieldId = await fetchSingleFieldId("actual story points", "actual story point");
  return cachedActualStoryPointsFieldId;
}

/** resolve "QA Points" field id: env override ? API discovery (cached). */
export async function resolveQaPointsFieldId() {
  const fromEnv = process.env.JIRA_QA_POINTS_FIELD_ID;
  if (fromEnv != null && String(fromEnv).trim() !== "") return String(fromEnv).trim();
  if (cachedQaPointsFieldId !== undefined) return cachedQaPointsFieldId;
  cachedQaPointsFieldId = await fetchSingleFieldId("qa points", "qa point");
  return cachedQaPointsFieldId;
}

/** resolve "QA Assignee" field id: env override ? API discovery (cached). */
export async function resolveQaAssigneeFieldId() {
  const fromEnv = process.env.JIRA_QA_ASSIGNEE_FIELD_ID;
  if (fromEnv != null && String(fromEnv).trim() !== "") return String(fromEnv).trim();
  if (cachedQaAssigneeFieldId !== undefined) return cachedQaAssigneeFieldId;
  cachedQaAssigneeFieldId = await fetchSingleFieldId("qa assignee", "qa assignee");
  return cachedQaAssigneeFieldId;
}

/**
 * Human-readable value from a single JIRA field payload (option, multi-select,
 * cascading select, plain string, …). Returns "Uncategorized" for null/empty
 * inputs so the dashboard always has a label to bucket against.
 */
export function extractWorkClassificationSingleValue(v) {
  if (v == null || v === "") return "Uncategorized";
  if (typeof v === "string") {
    const t = v.trim();
    return t || "Uncategorized";
  }
  if (typeof v === "object") {
    if (Array.isArray(v)) {
      const parts = v
        .map((item) => {
          if (item == null) return "";
          if (typeof item === "string") return item;
          return item.value ?? item.name ?? item.displayName ?? "";
        })
        .map((s) => String(s).trim())
        .filter(Boolean);
      return parts.length ? parts.join(", ") : "Uncategorized";
    }
    if (v.child && typeof v.child === "object") {
      const parent = (v.value ?? v.name ?? "").toString().trim();
      const child = (v.child.value ?? v.child.name ?? "").toString().trim();
      const combined = [parent, child].filter(Boolean).join(" / ");
      if (combined) return combined;
    }
    const single = (v.value ?? v.name ?? v.displayName ?? "").toString().trim();
    return single || "Uncategorized";
  }
  return "Uncategorized";
}

/**
 * Human-readable Work Classification for an issue.
 *
 * Tries each candidate field id in order — JIRA can have multiple custom
 * fields with the same display name (per-project context), so the first one
 * that has a value wins. Falls back to the issue type name when no field is
 * configured / set.
 */
export function extractWorkClassification(fields, fieldKeys) {
  const keys = Array.isArray(fieldKeys) ? fieldKeys : fieldKeys ? [fieldKeys] : [];
  if (fields && keys.length > 0) {
    for (const fieldKey of keys) {
      if (!fieldKey) continue;
      const v = fields[fieldKey];
      if (v == null || v === "") continue;
      return extractWorkClassificationSingleValue(v);
    }
  }
  if (fields && fields.issuetype) {
    const typeName = (fields.issuetype.name || "").trim();
    if (typeName) return typeName;
  }
  return "Uncategorized";
}
