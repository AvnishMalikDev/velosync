/**
 * Epic-level rollup helpers.
 *
 *   - `extractEpicLabel(fields)` best-effort epic label for an issue: parent
 *     epic, Epic Link, or the issue itself if it's an Epic.
 *   - `aggregateEpicWorkBySprint` sprint-window opened/closed counts grouped
 *     by epic.
 *   - `formatEpicWorkMarkdownTable` render the aggregate as the markdown
 *     section that replaces `WORK_EPIC_TABLE` in the template.
 */

/**
 * Best-effort epic label for team-level reporting.
 *
 * Priority:
 *   1. The issue itself when its `issuetype` is "Epic" (return its summary).
 *   2. `parent.fields.summary` / `parent.summary` when the parent is an
 *      Epic / Initiative.
 *   3. The first `customfield_*` whose value is a `{ key, summary }`
 *      object — Jira stores Epic Link in different IDs across instances.
 *   4. null when none of the above resolves.
 */
export function extractEpicLabel(fields) {
  if (!fields || typeof fields !== "object") return null;
  const itName = (fields.issuetype && String(fields.issuetype.name || "").trim().toLowerCase()) || "";
  if (itName === "epic") {
    const s = (fields.summary || "").toString().trim();
    return s || null;
  }
  const p = fields.parent;
  if (p && typeof p === "object") {
    const pType = (p.fields?.issuetype?.name || p.issuetype?.name || "").toString().trim().toLowerCase();
    const summary = (p.fields?.summary || p.summary || "").toString().trim();
    const key = (p.key || "").toString().trim();
    if (pType === "epic" || pType === "initiative") {
      if (summary) return summary;
      if (key) return key;
    }
  }
  for (const k of Object.keys(fields)) {
    if (!k.startsWith("customfield_")) continue;
    const v = fields[k];
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const ky = (v.key || "").toString().trim();
    if (!/^([A-Z][A-Z0-9]+)-\d+$/i.test(ky)) continue;
    const s = (v.summary || v.fields?.summary || "").toString().trim();
    if (s || ky) return s || ky;
  }
  return null;
}

/**
 * Same date / assignment semantics as work-classification rollup, but
 * grouped by epic. Returns `{ opened, closed }` Maps keyed by epic label.
 */
export function aggregateEpicWorkBySprint(issues, sprintStartDate, sprintEndDate) {
  const opened = new Map();
  const closed = new Map();
  const sprintStart = sprintStartDate ? new Date(sprintStartDate) : null;
  const sprintEnd = sprintEndDate ? new Date(sprintEndDate) : null;

  for (const it of issues) {
    const epic = it.epicLabel ? String(it.epicLabel).trim() : "No epic";
    const label = epic || "No epic";
    if (it.isDone) {
      closed.set(label, (closed.get(label) || 0) + 1);
    }
    const bugCreated = it.created ? new Date(it.created) : null;
    const createdInSprint =
      !sprintStart || !bugCreated
        ? true
        : bugCreated >= sprintStart && (!sprintEnd || bugCreated <= sprintEnd);
    if (createdInSprint) {
      opened.set(label, (opened.get(label) || 0) + 1);
    }
  }
  return { opened, closed };
}

/**
 * Render the epic-mix markdown table — header row + sorted body rows
 * (by total activity desc, "No epic" pinned to the bottom).
 */
export function formatEpicWorkMarkdownTable(openedMap, closedMap) {
  const labels = new Set([...openedMap.keys(), ...closedMap.keys()]);
  const rows = [...labels].map((k) => ({
    k,
    o: openedMap.get(k) || 0,
    c: closedMap.get(k) || 0,
    t: (openedMap.get(k) || 0) + (closedMap.get(k) || 0),
  }));
  rows.sort((a, b) => {
    const ua = /^no epic$/i.test(a.k);
    const ub = /^no epic$/i.test(b.k);
    if (ua && !ub) return 1;
    if (!ua && ub) return -1;
    if (b.t !== a.t) return b.t - a.t;
    return a.k.localeCompare(b.k, undefined, { sensitivity: "base" });
  });
  const lines = [
    "| Epic | Opened (this sprint) | Closed (Done) |",
    "|------|----------------------|----------------|",
  ];
  if (rows.length === 0) {
    lines.push("| — | 0 | 0 |");
  } else {
    for (const r of rows) {
      lines.push(`| ${String(r.k).replace(/\|/g, "\\|")} | ${r.o} | ${r.c} |`);
    }
  }
  lines.push("");
  lines.push(
    "*Closed* = Done items linked to that epic (via parent or Epic Link). *Opened* = same sprint-window rule as Work classification. Dashboard may chart the **top 5** epics plus **Other epics**.",
  );
  return lines.join("\n");
}
