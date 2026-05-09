/**
 * Display formatting helpers.
 *
 *   - `formatDataAt` "2:30 PM, 3rd Feb 2026" — used in the **DataAt** /
 *     "Last sync" header line of every sprint MD file.
 *   - `shortDisplayName` "First L" — table-friendly name that disambiguates
 *     people who share a first name without bloating the column.
 *   - `eventInSprintWindow`, `bugresolvedInSprint` shared date predicates so
 *     "bugs opened" and "bugs closed" use the same window rules.
 */

/** Format a Date as `2:30 PM, 3rd Feb 2026` for the **DataAt** header line. */
export function formatDataAt(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const hours = d.getHours();
  const mins = d.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 || 12;
  const timeStr = `${h12}:${String(mins).padStart(2, "0")} ${ampm}`;
  const day = d.getDate();
  const ord = (n) => {
    const v = n % 100;
    if (v >= 11 && v <= 13) return "th";
    const r = n % 10;
    return r === 1 ? "st" : r === 2 ? "nd" : r === 3 ? "rd" : "th";
  };
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dateStr = `${day}${ord(day)} ${months[d.getMonth()]} ${d.getFullYear()}`;
  return `${timeStr}, ${dateStr}`;
}

/**
 * Short label for markdown tables: `First L` where `L` is the first letter
 * of the last name (uppercase). Avoids merging distinct people who share a
 * first name. Single-word names and "Unassigned" are passed through.
 *
 * Strips trailing parenthetical contractor markers (`(c)`, `(contractor)`)
 * before deriving the initial — `Ramraj Illale (c)` becomes `Ramraj I`,
 * not `Ramraj C`.
 */
export function shortDisplayName(full) {
  const s = String(full || "").trim();
  if (!s) return "";
  if (/^unassigned$/i.test(s)) return s;
  const cleaned = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const lastToken = parts[parts.length - 1];
  const letter = lastToken.replace(/[^a-zA-Z\u00C0-\u024F]/g, "").charAt(0);
  return letter ? `${first} ${letter.toUpperCase()}` : first;
}

/**
 * Whether a JIRA timestamp falls in `[sprintStart, sprintEnd]` (same rules
 * as "bugs opened"). Inclusive end when `sprintEnd` is set so last-day
 * resolutions match last-day creates.
 */
export function eventInSprintWindow(ts, sprintStart, sprintEnd) {
  if (!ts) return false;
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return false;
  if (!sprintStart) return true;
  if (t < sprintStart) return false;
  if (!sprintEnd) return true;
  return t <= sprintEnd;
}

/**
 * Bugs closed this sprint: Bug type + Done + resolution time in the sprint
 * window when present (pairs with "bugs opened"). When resolution is
 * missing, falls back to counting Done bugs so JIRA configs without
 * resolution still get counts.
 */
export function bugresolvedInSprint(it, sprintStart, sprintEnd) {
  if (!it.isBug || !it.isDone) return false;
  const rd = it.resolutionDate ? new Date(it.resolutionDate) : null;
  if (rd && !Number.isNaN(rd.getTime())) {
    return eventInSprintWindow(it.resolutionDate, sprintStart, sprintEnd);
  }
  return true;
}
