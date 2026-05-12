# Jira MD Export

Generates markdown sprint reports from Jira, GitHub, Copilot, Cursor, Confluence, and TestRail data. These reports power the Dynamic Dashboard.

## Codebase layout

The package is now modular — every external system has its own folder.

```
jira-md-export/
├─ index.js                       # Entrypoint shim (PM2 / run.bat / cron)
├─ projects.json                  # Project list + per-project config
├─ github-users.json              # Optional Jira name → GitHub login overrides
├─ Template/                      # Markdown template + Excel populate scripts
└─ src/
   ├─ orchestrator.js             # Top-level run pipeline (composition only)
   ├─ core/                       # Shared infra
   │  ├─ env.js                   # Loads Product/.env (canonical) + jira-md-export/.env (legacy)
   │  ├─ paths.js                 # ROOT_DIR / OUTPUT_DIR / PROJECTS_JSON …
   │  ├─ jira-auth.js             # JIRA Basic-auth + headers
   │  └─ http.js                  # Tiny shared fetch helpers
   ├─ connectors/                 # One folder per external system
   │  ├─ jira/                    # client, fields, boards, sprints, issues, kanban, resource-directory
   │  ├─ confluence/              # Pages activity per user
   │  ├─ github/                  # Repo metrics + login resolution
   │  ├─ copilot/                 # Enterprise + user-level Copilot reports
   │  ├─ cursor/                  # Leaderboard, daily usage, AI edits
   │  └─ testrail/                # request, metrics, user-sync, user-fetch
   ├─ domain/                     # Pure helpers (no I/O) — easy to test
   │  ├─ stages.js                # start / end / done stage sets
   │  ├─ format.js                # date / display-name formatters
   │  ├─ template.js              # Token + meta substitution
   │  ├─ delta-export.js          # decideSprintAction + ACTIVE marker
   │  ├─ epics.js, work-classification.js, hygiene.js, ai-adoption.js
   └─ debug/                      # Standalone diagnostic CLIs
      ├─ token-check.js           # Cross-system credential + identity probe
      └─ issue-work-classification.js
```

`index.js` is a thin wrapper that loads env and delegates to `src/orchestrator.js`. Existing PM2 manifests and `run.bat` keep working unchanged.

## How to run (generate new MD files)

### Option 1: Double-click (Windows)
Double-click **`run.bat`** in this folder. It will run the export and keep the window open when done.

### Option 2: Command Prompt or PowerShell
From this folder (`jira-md-export`):

```bat
node index.js
```

Or from the parent folder, **in PowerShell use semicolon** (not `&&`):

```powershell
cd "jira-md-export"; node index.js
```

### Option 3: npm
From this folder:

```bat
npm start
```

## Convenience npm scripts

| Script | What it does |
|---|---|
| `npm start` | Full export (`node index.js`) |
| `npm run copilot` | Refresh just `output/copilotdata.json` |
| `npm run cursor` | Refresh just `output/cursordata.json` |
| `npm run confluence` | Smoke-test Confluence connectivity |
| `npm run sync:testrail-users` | Map TestRail user IDs onto `resource-directory.json` |
| `npm run fetch:testrail-users` | Refresh `output/testrail-users.json` cache |
| `npm run debug:tokens -- --user "First Last"` | Cross-system token + identity diagnostic |
| `npm run debug:work-classification ABC-123` | Inspect Work Classification fields on one issue |

## Requirements

- Node.js installed
- `.env` in this folder with the credentials below

### `.env` variables

| Variable | Required | Description |
|---|---|---|
| `JIRA_EMAIL` | Yes | Jira account email |
| `JIRA_TOKEN` | Yes | Jira API token |
| `JIRA_DOMAIN` | Yes | e.g. `yourorg.atlassian.net` |
| `SPRINT_COUNT` | No | Number of recent sprints to export (default 3) |
| `GITHUB_TOKEN` | No | GitHub PAT (repo read + search scope, SSO authorized). Enables section 2.3 GitHub Metrics |
| `ORG` | No | GitHub org name (needed for GitHub + Copilot) |
| `ENT` | No | GitHub enterprise slug (for Copilot billing API) |
| `CURSOR_TOKEN` | No | Cursor API token for AI adoption metrics |
| `TESTRAIL_DOMAIN` | No | TestRail instance, e.g. `yourorg.testrail.io` |
| `TESTRAIL_EMAIL` | No | TestRail account email |
| `TESTRAIL_API_KEY` | No | TestRail API key (generate from My Settings > API Keys) |

### Other config files

- **`projects.json`** — Maps Jira board IDs to project names, managers, and optional `testRailProjectIds` for TestRail integration.
- **`github-users.json`** — Optional per-name override mapping Jira display names to GitHub logins (highest precedence).
- **`output/resource-directory.json`** — Jira user directory cache; per-user **`githubLogin`** is used for GitHub metrics. Missing values are **auto-filled** at the start of each `index.js` run (fuzzy + derived against the GitHub org); manual edits are optional and preserved on Jira refresh by email (like `testRailUserId`).
- **`Template/Template.md`** — Markdown template with placeholder tokens for all data sections.

### Delta mode (`overwriteexistingdatafiles`)

Per-project flag in `projects.json` that controls how sprint MD files are written on re-runs.

| Value | Behavior |
|---|---|
| `true` (or missing) | Legacy: every sprint file is regenerated every run. |
| `false` | Delta mode: only the **active** sprint file is refreshed each run; already-written closed sprint files are skipped (their data cannot change). |

In delta mode the active sprint carries an ` [ACTIVE]` marker in its file name, e.g. `EHR IDC-PAL - PI 26.3.1 [ACTIVE].md`. When a sprint transitions from active to closed, the next run:
1. Re-exports the sprint with fresh data to the plain name (e.g. `EHR IDC-PAL - PI 26.3.1.md`) — the active-time snapshot is not trusted because tickets often move during the final hours.
2. Deletes the now-stale `[ACTIVE]` variant.
3. Creates a new `<new sprint> [ACTIVE].md` for the freshly-started sprint.

All older closed files are left untouched. On a typical daily run with 8 active projects, this skips ~8 closed-sprint write cycles — saving most of the GitHub, Confluence and TestRail per-user API calls.

## Data sources & sections in exported reports

| Section | Source | What it captures |
|---|---|---|
| 1. Sprint Summary | Jira | Completion %, story points, bugs, cycle time, carry-over |
| 2.1 Individual Output | Jira | Per-person story points and tickets |
| 2.2 AI Adoption | Copilot + Cursor | AI tool usage per developer |
| 2.3 GitHub Metrics | GitHub | PRs, commits, reviews per contributor |
| 2.4 QA Individual | Jira | QA assignee points and ticket counts |
| 2.5 Confluence Activity | Confluence | Pages created/edited per person |
| 2.6 TestRail Execution | TestRail | Test runs, pass/fail/blocked counts, pass rate, automation coverage |
| 2.7 TestRail QA by Individual | TestRail | Per-QA test assignments, passed, failed, blocked, pass rate |
| 3. Anomalies | Jira | Sprint anomalies and flags |

## Dashboard integration

The dashboard uses exported reports to compute:

- **Project Health Rating** (1-5 stars) — weighted composite of 6 pillars:
  - Delivery 45%, Quality 20%, Flow 10%, Stability 10%, AI Adoption 10%, Risk 5%
- **QA Leaderboard** — composite QA Score from Jira QA data + TestRail test execution
- **Integration Status Icons** — header indicators glow when data is present (JIRA, GitHub, Copilot, Cursor, Confluence, TestRail)

## Output

Output is written to the **root project's** `output` folder (i.e. `Dynamic Dashboard/output/`), not inside jira-md-export. The dashboard loads data from `./output/`.
