/**
 * Centralised JIRA / Confluence credentials.
 *
 * Reads `JIRA_EMAIL`, `JIRA_TOKEN`, `JIRA_DOMAIN` from `process.env` once and
 * exposes:
 *
 *   - `jiraDomain`   the Atlassian host (e.g. `yourorg.atlassian.net`)
 *   - `jiraAuth`     the pre-encoded `Basic <base64(email:token)>` string
 *   - `jiraHeaders`  ready-to-use `Authorization` + `Accept` headers
 *   - `assertJiraCreds()`  hard fail-fast helper for entrypoint scripts
 *
 * Confluence uses the same token, so its connector imports `jiraAuth` directly.
 */

const email = process.env.JIRA_EMAIL || "";
const apiToken = process.env.JIRA_TOKEN || "";
const domain = process.env.JIRA_DOMAIN || "";

export const jiraEmail = email;
export const jiraApiToken = apiToken;
export const jiraDomain = domain;

export const jiraAuth =
  email && apiToken
    ? Buffer.from(`${email}:${apiToken}`).toString("base64")
    : "";

export const jiraHeaders = {
  Authorization: `Basic ${jiraAuth}`,
  Accept: "application/json",
};

/**
 * Throw if any of the three required JIRA env vars are missing — used by CLI
 * entrypoints to fail loudly instead of silently producing 401s downstream.
 */
export function assertJiraCreds() {
  const missing = [];
  if (!email) missing.push("JIRA_EMAIL");
  if (!apiToken) missing.push("JIRA_TOKEN");
  if (!domain) missing.push("JIRA_DOMAIN");
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

/** Build the same Basic auth header for an arbitrary email/token pair (e.g. tests). */
export function buildBasicAuth(emailArg, tokenArg) {
  return Buffer.from(`${emailArg}:${tokenArg}`).toString("base64");
}
