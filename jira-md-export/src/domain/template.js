/**
 * Template rendering helpers for the sprint markdown.
 *
 *   - `applyTemplate(template, { meta, tokens })` replace `**Field:**` lines
 *     with values from `meta`, then replace word-boundary placeholder tokens
 *     (e.g. `CSP`, `WORK_CLASSIFICATION_TABLE`) from `tokens`.
 */

/**
 * Apply meta + token substitutions to a template string.
 *
 * `meta` keys correspond to header lines (e.g. `Product`, `Manager`,
 * `Sprint name`) — the matching `**Field:**` line is replaced wholesale.
 * `tokens` are word-boundary substitutions for placeholders like `CSP`,
 * `WORK_CLASSIFICATION_TABLE`, etc.
 *
 * @param {string} template
 * @param {{meta?: Record<string, string|number>, tokens?: Record<string, string|number>}} [vars]
 */
export function applyTemplate(template, { meta = {}, tokens = {} } = {}) {
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let content = template;

  // Replace **Field:** lines uniformly.
  for (const [field, value] of Object.entries(meta)) {
    content = content.replace(
      new RegExp(`^\\*\\*${escRe(field)}:\\*\\*.*$`, "m"),
      `**${field}:** ${value}`,
    );
  }

  // Replace word-boundary placeholder tokens.
  for (const [token, value] of Object.entries(tokens)) {
    content = content.replace(new RegExp(`\\b${escRe(token)}\\b`, "g"), String(value));
  }

  return content;
}
