/**
 * One-off diagnostic: fetch a JIRA issue and dump its Work Classification —
 * field-discovery output, raw per-field values, and the extractor result.
 *
 * Useful when an issue ends up "Uncategorized" in a sprint MD: this lets you
 * see exactly which custom-field IDs were tried and what JIRA returned for
 * each.
 *
 * Usage:
 *   node src/debug/issue-work-classification.js [ISSUE-KEY]
 */

import "../core/env.js";
import { jiraGet, jiraUrl } from "../connectors/jira/client.js";
import { assertJiraCreds, jiraDomain } from "../core/jira-auth.js";
import {
  resolveWorkClassificationFieldIds,
  extractWorkClassification,
} from "../connectors/jira/fields.js";

const issueKey = (process.argv[2] || "EOS-3608").trim().toUpperCase();

async function main() {
  assertJiraCreds();

  const fieldIds = await resolveWorkClassificationFieldIds(null);

  console.log("Issue:", issueKey);
  console.log("JIRA domain:", jiraDomain);
  console.log("Work Classification field id(s) to try:", fieldIds.length ? fieldIds.join(", ") : "(none)");

  const url = jiraUrl(`/rest/api/3/issue/${issueKey}?fields=*all`);
  const res = await jiraGet(url);
  const text = await res.text();
  if (!res.ok) {
    console.error("GET issue failed:", res.status, text.slice(0, 500));
    process.exit(1);
  }
  const data = JSON.parse(text);
  const fields = data.fields || {};

  console.log("\n--- Per-field raw values (first non-empty wins in export) ---");
  for (const id of fieldIds) {
    const raw = fields[id];
    console.log(`  ${id}:`, raw === undefined ? "(missing key)" : JSON.stringify(raw));
  }

  console.log("\n--- extractWorkClassification() result (same as export) ---");
  console.log(extractWorkClassification(fields, fieldIds));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
