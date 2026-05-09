/**
 * Cursor-driven AI adoption rating + name/repo similarity matching.
 *
 *   - `memberMatchesCursorLeaderboard(name, cursorData)`
 *   - `projectMatchesCursorRepo(projectName, cursorData)`
 *   - `computeAiAdoptionRating(memberName, sp, minSp, spRange, cursorData, projectName)`
 *     — clamped 1-4 rating combining SP-bucket base + Cursor leaderboard
 *     hit + project-level AI adoption signal.
 *
 * Match logic mirrors what the dashboard's `script.js` does so the MD-side
 * "Cursor leaderboard" annotations stay in sync with the live UI.
 */

/** Only the first N leaderboard rows are considered when matching a person (same as the dashboard). */
const CURSOR_LEADERBOARD_MATCH_LIMIT = 25;

/** Min token length for email local-part heuristics — single-letter last names like `M` must not match every `m` in email. */
const CURSOR_NAME_LOCAL_MIN_FIRST = 2;
const CURSOR_NAME_LOCAL_MIN_LAST = 2;

function normalizeForMatch(s) {
  if (s == null || typeof s !== "string") return "";
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s.-]/g, "")
    .replace(/\s+/g, "");
}

/** True if two strings are similar (containment after normalisation, or shared significant tokens). */
function similarEnough(a, b, minLen = 2) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (na.length < minLen || nb.length < minLen) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = na.replace(/-/g, "").split(/(?=[a-z0-9])/).filter(Boolean);
  const tb = nb.replace(/-/g, "").split(/(?=[a-z0-9])/).filter(Boolean);
  const overlap = ta.filter((t) => t.length >= 2 && tb.some((u) => u.includes(t) || t.includes(u))).length;
  return overlap >= Math.min(2, ta.length, tb.length);
}

/**
 * Leaderboard rows used for matching — handles every leaderboard shape
 * Cursor returns (top10Users aggregate, root array, `tab_leaderboard.data`,
 * `agent_leaderboard.data`).
 */
function getCursorLeaderboardRowsForMatch(cursorData) {
  const limit = CURSOR_LEADERBOARD_MATCH_LIMIT;
  const fromAgg = cursorData && cursorData.top10Users;
  if (Array.isArray(fromAgg) && fromAgg.length > 0) {
    return fromAgg.slice(0, limit);
  }
  const lb = cursorData && cursorData.leaderboard;
  if (!lb) return [];
  if (Array.isArray(lb)) {
    const sorted = [...lb].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
    return sorted.slice(0, limit).map((u) => ({
      ...u,
      name: u.name || u.display_name || u.displayName,
    }));
  }
  if (typeof lb === "object" && Array.isArray(lb.data) && !lb.tab_leaderboard) {
    const sorted = [...lb.data].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
    return sorted.slice(0, limit).map((u) => ({
      ...u,
      name: u.name || u.display_name || u.displayName,
    }));
  }
  const tabData = lb.tab_leaderboard && Array.isArray(lb.tab_leaderboard.data) ? lb.tab_leaderboard.data : [];
  const agentData = lb.agent_leaderboard && Array.isArray(lb.agent_leaderboard.data) ? lb.agent_leaderboard.data : [];
  const pick = tabData.length ? tabData : agentData;
  if (pick.length === 0) return [];
  const sorted = [...pick].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
  return sorted.slice(0, limit).map((u) => ({
    ...u,
    email: u.email,
    user: u.user || u.email,
    name: u.name || u.display_name || u.displayName || "",
  }));
}

/** Check if a JIRA member name matches any Cursor leaderboard user (email or display name). */
export function memberMatchesCursorLeaderboard(memberName, cursorData) {
  if (!cursorData) return false;
  const list = getCursorLeaderboardRowsForMatch(cursorData);
  if (list.length === 0) return false;
  const nameNorm = normalizeForMatch(memberName);
  const firstFromName = (memberName || "").split(/\s+/)[0]?.toLowerCase() || "";
  const lastFromName = (memberName || "").split(/\s+/).slice(1).join(" ").toLowerCase().replace(/\W/g, "") || "";
  for (const u of list) {
    const email = (u.email || u.user || "").toLowerCase();
    const displayName = (u.name || u.display_name || u.displayName || "").toLowerCase();
    if (similarEnough(memberName, email) || similarEnough(memberName, displayName)) return true;
    const localPart = (email.split("@")[0] || "").replace(/\./g, "");
    const nameNormNoSpace = nameNorm.replace(/\s/g, "");
    if (localPart && (nameNormNoSpace.includes(localPart) || localPart.includes(nameNormNoSpace))) return true;
    if (localPart && firstFromName.length >= CURSOR_NAME_LOCAL_MIN_FIRST && (localPart.includes(firstFromName) || firstFromName.includes(localPart))) return true;
    if (lastFromName.length >= CURSOR_NAME_LOCAL_MIN_LAST && localPart && localPart.includes(lastFromName)) return true;
  }
  return false;
}

/** Word tokens from a string (split on spaces / hyphens / underscores / dots). */
function wordTokens(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[\s\-_.]+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length >= 2);
}

/** True when a project name and a repo / projectName share enough word-level similarity. */
function projectRepoSimilar(projectName, repoOrProjectStr) {
  if (similarEnough(projectName, repoOrProjectStr)) return true;
  const a = wordTokens(projectName);
  const b = wordTokens(repoOrProjectStr);
  if (a.length === 0 || b.length === 0) return false;
  const overlap = a.filter((t) => b.some((u) => t.includes(u) || u.includes(t) || similarEnough(t, u))).length;
  return overlap >= Math.min(2, a.length, b.length) || (a.length === 1 && b.some((u) => u.includes(a[0]) || a[0].includes(u)));
}

/**
 * Find the best-matching repo in Cursor's `aiEditsByRepository` for a
 * project. Returns either `{ match: true, codeCommittedByAiPct,
 * aiLinesCommitted, totalLinesCommitted }` or `{ match: false }`.
 */
export function projectMatchesCursorRepo(projectName, cursorData) {
  if (!cursorData || !projectName) return { match: false };
  const repos = cursorData.aiEditsByRepository || [];
  if (!Array.isArray(repos) || repos.length === 0) return { match: false };
  for (const r of repos) {
    const proj = (r.projectName || r.repository || "").trim();
    const fullRepo = (r.repository || "").trim();
    if (projectRepoSimilar(projectName, proj) || projectRepoSimilar(projectName, fullRepo)) {
      return {
        match: true,
        codeCommittedByAiPct: r.codeCommittedByAiPct ?? 0,
        aiLinesCommitted: r.aiLinesCommitted ?? 0,
        totalLinesCommitted: r.totalLinesCommitted ?? 0,
      };
    }
  }
  return { match: false };
}

/**
 * Compute an AI adoption rating in `[1, 4]` from:
 *   1. SP-relative base bucket (linear interpolation across the team's SP range).
 *   2. Cursor leaderboard hit → floor of 2.
 *   3. Project-level Cursor adoption (`codeCommittedByAiPct`):
 *        ≥ 60% → +1 (cap 4)
 *        ≥ 40% → floor 3
 *        ≥ 20% → floor 2
 *
 * Conservative on purpose — we'd rather under-rate than over-rate.
 */
export function computeAiAdoptionRating(memberName, sp, minSp, spRange, cursorData, projectName) {
  let rating = spRange === 0 ? 2 : 1 + Math.round(((sp - minSp) / spRange) * 3);
  rating = Math.max(1, Math.min(4, rating));

  const inLeaderboard = memberMatchesCursorLeaderboard(memberName, cursorData);
  const repoMatch = projectMatchesCursorRepo(projectName, cursorData);

  if (inLeaderboard) rating = Math.max(rating, 2);
  if (repoMatch.match) {
    const pct = repoMatch.codeCommittedByAiPct || 0;
    if (pct >= 60) rating = Math.min(4, rating + 1);
    else if (pct >= 40) rating = Math.max(rating, 3);
    else if (pct >= 20) rating = Math.max(rating, 2);
  }

  return Math.max(1, Math.min(4, rating));
}
