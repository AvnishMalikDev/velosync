import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "jira-md-export", ".env") });

const AUTH = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_TOKEN}`).toString("base64");
const BASE = `https://${process.env.JIRA_DOMAIN}`;

// Test 1: new POST API
const r1 = await fetch(`${BASE}/rest/api/3/search/jql`, {
  method: "POST",
  headers: { Authorization: `Basic ${AUTH}`, "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ jql: 'project = "RP" ORDER BY created DESC', maxResults: 1, fields: ["summary", "status"] }),
});
console.log("POST /rest/api/3/search/jql →", r1.status);
const b1 = await r1.text();
console.log(b1.slice(0, 600));

// Test 2: old GET API (to confirm it's really gone)
const encoded = encodeURIComponent('project = "RP" ORDER BY created DESC');
const r2 = await fetch(`${BASE}/rest/api/3/search?jql=${encoded}&maxResults=1&fields=summary,status`, {
  headers: { Authorization: `Basic ${AUTH}`, Accept: "application/json" },
});
console.log("\nGET /rest/api/3/search →", r2.status);
const b2 = await r2.text();
console.log(b2.slice(0, 300));
