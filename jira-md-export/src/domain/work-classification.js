/**
 * Work-classification aggregation + markdown rendering.
 *
 * Counts issues by their Work Classification value, split into:
 *   - opened: issues created within the sprint window (`created` between
 *     start and end). When sprint dates are missing, all issues count.
 *   - closed: issues currently in Done. NOT scoped to bugs — stories,
 *     tasks, etc. all count (the dashboard's "Bugs closed" metric uses a
 *     stricter Bug-only counter elsewhere).
 *
 * Extraction (`extractWorkClassification`, `extractWorkClassificationSingleValue`)
 * lives in the JIRA connector (`src/connectors/jira/fields.js`) since it is
 * tightly coupled to JIRA's custom-field shape.
 */

/**
 * Sprint-window opened / closed counts grouped by Work Classification.
 *
 * `closed` covers all Done issues (any type). `opened` is sprint-window
 * scoped using the issue's `created` timestamp; when sprint dates are absent
 * we include everything so the table is at least populated.
 */
export function aggregateWorkClassificationBySprint(issues, sprintStartDate, sprintEndDate) {
  const opened = new Map();
  const closed = new Map();
  const sprintStart = sprintStartDate ? new Date(sprintStartDate) : null;
  const sprintEnd = sprintEndDate ? new Date(sprintEndDate) : null;

  for (const it of issues) {
    const wc = it.workClassification || "Uncategorized";
    if (it.isDone) {
      closed.set(wc, (closed.get(wc) || 0) + 1);
    }
    const bugCreated = it.created ? new Date(it.created) : null;
    const createdInSprint =
      !sprintStart || !bugCreated
        ? true
        : bugCreated >= sprintStart && (!sprintEnd || bugCreated <= sprintEnd);
    if (createdInSprint) {
      opened.set(wc, (opened.get(wc) || 0) + 1);
    }
  }
  return { opened, closed };
}

/**
 * Markdown table body for the Work-classification section. Header row is
 * included; "Uncategorized" is pinned to the bottom so the eye lands on
 * meaningful classifications first.
 */
export function formatWorkClassificationMarkdownTable(openedMap, closedMap) {
  const allKeys = new Set([...openedMap.keys(), ...closedMap.keys()]);
  const sorted = [...allKeys].sort((a, b) => {
    if (a === "Uncategorized") return 1;
    if (b === "Uncategorized") return -1;
    return a.localeCompare(b);
  });
  const lines = [
    "| Work Classification | Opened (this sprint) | Closed (all types in Done) |",
    "|------|----------------------|----------------------|",
  ];
  if (sorted.length === 0) {
    lines.push("| — | 0 | 0 |");
  } else {
    for (const k of sorted) {
      lines.push(`| ${k.replace(/\|/g, "\\|")} | ${openedMap.get(k) || 0} | ${closedMap.get(k) || 0} |`);
    }
  }
  lines.push("");
  lines.push(
    "*Closed* = count of Done items by classification (stories, tasks, bugs, etc.). *Bugs closed* in Quality counts only **Bug** issues.",
  );
  return lines.join("\n");
}
