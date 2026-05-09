# VeloSync Guide

> **Product & Technology Team Insights Dashboard** · Installation reference and definitions for every metric shown on the main dashboard and project detail page.

> **Live configuration:** When this guide is opened from the dashboard (served by the Product app), the **Current scoring configuration** panel at the top of the overlay shows the exact **health matrix**, **Dev Data**, and **QA Data** weights and thresholds loaded from the server (`dashboard-scoring.template.json`, with optional `dashboard-scoring.json` overrides). The sections below explain **how** each metric is computed; numeric **weights** and **star-band cutoffs** may differ from older defaults—use the live panel as the source of truth when it is visible.

---

## Table of Contents

**Setup**

- [Installation & Deployment](#installation--deployment)
  - [Prerequisites](#prerequisites)
  - [1. Extract the zip](#1-extract-the-zip)
  - [2. Install Node.js](#2-install-nodejs)
  - [3. Configure the `.env` file](#3-configure-the-env-file)
  - [4. Install dependencies](#4-install-dependencies)
  - [5. Install PM2 + Windows startup](#5-install-pm2--windows-startup)
  - [6. Start both processes](#6-start-both-processes)
  - [7. Open the Windows firewall](#7-open-the-windows-firewall)
  - [Useful PM2 commands](#useful-pm2-commands)
  - [Updating VeloSync](#updating-velosync)
  - [Troubleshooting](#troubleshooting)
- [Admin Setup (First-Run Configuration)](#admin-setup-first-run-configuration)
  - [Accessing the admin panel](#accessing-the-admin-panel)
  - [Setup Wizard (guided onboarding)](#setup-wizard-guided-onboarding)
  - [Platform & SSO](#platform--sso)
  - [Logo, icon & title (Branding)](#logo-icon--title-branding)
  - [Setup (Jira)](#setup-jira)
  - [Connectors (GitHub, Copilot, Cursor, TestRail, Confluence)](#connectors-github-copilot-cursor-testrail-confluence)
  - [HTTPS / SSL](#https--ssl)
  - [Projects](#projects)
  - [Configure Weights (Scoring)](#configure-weights-scoring)
  - [Manage Users (RBAC)](#manage-users-rbac)
  - [Data Sync Job](#data-sync-job)
  - [After making changes — when to restart](#after-making-changes--when-to-restart)

**Metrics Reference**

1. [Main Dashboard Metrics](#main-dashboard-metrics)
   - [Story Points (Completed)](#story-points-completed)
   - [Sprint Completion %](#sprint-completion-)
   - [Review Cycle](#review-cycle)
   - [Throughput](#throughput)
   - [Defect Density](#defect-density)
   - [Bug Fix Rate](#bug-fix-rate)
2. [Project Health Star Rating](#project-health-star-rating)
   - [Delivery Score](#delivery-score)
   - [Flow Score](#flow-score)
   - [Stability Score](#stability-score)
   - [Quality Score](#quality-score)
   - [Risk Score](#risk-score)
   - [AI Adoption Score](#ai-adoption-score)
   - [Composite Score & Health Bands](#composite-score--health-bands)
3. [Team Health Matrix](#team-health-matrix)
4. [Stage Dwell](#stage-dwell)
5. [Dev Score (0–10)](#dev-score-010)
   - [Delivery (Story Points)](#delivery-story-points)
   - [GitHub Impact](#github-impact)
   - [GitHub Quality](#github-quality)
   - [Consistency](#consistency)
   - [Impact Breadth](#impact-breadth)
   - [Confluence Docs Activity](#confluence-docs-activity)
   - [Cursor Leaderboard Signal](#cursor-leaderboard-signal)
   - [Copilot Individual Signal](#copilot-individual-signal)
   - [AI Tools Adoption](#ai-tools-adoption)
6. [Work Categorization](#work-categorization)
7. [JIRA Hygiene](#jira-hygiene)
   - [Hygiene Score](#hygiene-score)
   - [Unestimated Tickets](#unestimated-tickets)
   - [No Work Classification](#no-work-classification)
   - [Mid-Sprint Additions (Scope Creep)](#mid-sprint-additions-scope-creep)
   - [Missing Priority](#missing-priority)
   - [UnrVeloSynclved Blockers](#unrVeloSynclved-blockers)
   - [Carry-over](#carry-over-hygiene)
8. [Copilot Usage](#copilot-usage)
9. [Cursor Usage](#cursor-usage)
10. [Project Detail Page Metrics](#project-detail-page-metrics)
   - [Regulatory & Compliance %](#regulatory--compliance-)
   - [Velocity & Success Trend](#velocity--success-trend)
   - [Developer Insights Chart](#developer-insights-chart)
   - [Bug Throughput](#bug-throughput)
   - [Cycle Time Trend](#cycle-time-trend)
   - [Bug Fix Rate vs Carry-over Trend](#bug-fix-rate-vs-carry-over-trend)
   - [Sprint History Table](#sprint-history-table)

---

## Installation & Deployment

Complete instructions to deploy VeloSync from the shipped zip onto a Windows Server. The same steps work on Windows 10/11, macOS and Linux — only the PowerShell-specific commands (firewall, `pm2-windows-startup`) need to be skipped/translated.

VeloSync ships as a single `Product/` folder that contains **two Node.js apps**:

| App | Path | Role | Port / Schedule |
|---|---|---|---|
| `velosync-web` | `Product/server.js` | Dashboard + API | HTTP on **`localhost:3000`** |
| `velosync-sync` | `Product/jira-md-export/index.js` | Jira / GitHub / Copilot / Cursor / Confluence / TestRail data sync | **Cron: every day at 12:00 AM** |

Both are managed by **PM2**, and both read the **same** `Product/.env` file (canonical). The repo ships with an `ecosystem.config.cjs` that wires them up in one command.

### Prerequisites

- Windows Server 2022 / Windows 10+ (macOS / Linux also supported)
- **Node.js 20.x LTS** or newer — https://nodejs.org/en/download
- PowerShell run **as Administrator** for the firewall and PM2 startup steps
- Port **3000** free on the host (dashboard binds here)
- Outbound **HTTPS (443)** access to Jira, GitHub, OpenRouter, Cursor, Confluence and TestRail

> **Windows Server only:** If IIS or the *World Wide Web Publishing Service* is running and you plan to host on port 80 later, stop and disable it first:
> ```powershell
> Stop-Service W3SVC -Force
> Set-Service W3SVC -StartupType Disabled
> ```

### 1. Extract the zip

Extract `VeloSync.zip` to a stable path, e.g. `C:\VeloSync`. You should see:

```
C:\VeloSync\Product\
  ├─ server.js              ← main dashboard (port 3000)
  ├─ ecosystem.config.cjs   ← PM2 manifest (both apps)
  ├─ package.json
  ├─ .env.example           ← copy to .env and fill in
  ├─ jira-md-export\        ← nightly data sync
  │   ├─ index.js
  │   └─ package.json
  ├─ output\                ← generated sprint markdown (written by sync)
  └─ data\ / rbac.json / ssl\ / ...
```

### 2. Install Node.js

Download and run the **Windows Installer (.msi)** for **Node.js 20 LTS** from https://nodejs.org/en/download. Accept all defaults — this also installs `npm` and adds both to `PATH`.

Verify in a new PowerShell window:

```powershell
node -v   # should print v20.x.x (or newer)
npm -v
```

### 3. Configure the `.env` file

The zip ships with `.env.example` containing **placeholders only** (no real secrets). Copy it to `.env` and fill in the real values:

```powershell
cd C:\VeloSync\Product
copy .env.example .env
notepad .env
```

At minimum, set the following:

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | Long random string (≥ 32 chars) used to sign cookies |
| `JIRA_EMAIL`, `JIRA_TOKEN`, `JIRA_DOMAIN` | Required — powers the sprint export |
| `OPENROUTER_API_KEY` | AI summaries on the dashboard |
| `GITHUB_TOKEN`, `ORG`, `ENT` | GitHub metrics + Copilot enterprise data |
| `CURSOR_TOKEN` | Cursor usage / leaderboard data |
| `TESTRAIL_DOMAIN`, `TESTRAIL_EMAIL`, `TESTRAIL_API_KEY` | TestRail integration (optional) |
| `AUTH_MODE` | `local` (default, `rbac.json` users) or `azure` (Entra ID SSO) |
| `PORT` | Defaults to `3000` — leave as-is unless you need to change it |

> `Product/.env` is the **canonical** env file. Both `server.js` and `jira-md-export/` read from it (see `jira-md-export/load-env.js`). You do **not** need a second `.env` inside `jira-md-export/`.

### 4. Install dependencies

From an Administrator PowerShell in the `Product` folder:

```powershell
cd C:\VeloSync\Product
npm install

cd jira-md-export
npm install
cd ..
```

### 5. Install PM2 + Windows startup

Install PM2 globally and register it as a Windows service so processes survive reboots:

```powershell
npm install -g pm2
npm install -g pm2-windows-startup
pm2-startup install
```

> On macOS / Linux, replace the last two lines with `pm2 startup` and follow the printed instructions.

### 6. Start both processes

`ecosystem.config.cjs` (shipped in `Product/`) already wires up both apps:

- `velosync-web` → `server.js`, long-running, auto-restart, listening on **port 3000**
- `velosync-sync` → `jira-md-export/index.js`, `autorestart: false`, triggered by `cron_restart: "0 0 * * *"` (every day at **12:00 AM** local time)

Start everything with one command:

```powershell
cd C:\VeloSync\Product
pm2 start ecosystem.config.cjs
pm2 save          # persist current process list for reboot
pm2 list          # verify both apps are "online"
```

Open the dashboard in a browser: **http://localhost:3000**

Run the sync **once immediately** (so you don't have to wait until midnight for the first data set):

```powershell
cd C:\VeloSync\Product\jira-md-export
node index.js
cd ..
```

Output markdown files land in `Product/output/` and the dashboard picks them up automatically on refresh.

### 7. Open the Windows firewall

If the dashboard needs to be reachable from other machines on the network:

```powershell
New-NetFirewallRule -DisplayName "VeloSync-3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

### Useful PM2 commands

| Command | What it does |
|---|---|
| `pm2 list` | Show status of both apps |
| `pm2 logs velosync-web` | Tail web server logs |
| `pm2 logs velosync-sync` | Tail sync-job logs (last run) |
| `pm2 restart all` | Restart both apps |
| `pm2 restart velosync-web` | Restart only the web app (after changing `.env` or code) |
| `pm2 restart velosync-sync` | Force an immediate sync run (bypasses cron schedule) |
| `pm2 stop all` / `pm2 delete all` | Stop / remove all apps from PM2 |
| `pm2 save` | Persist the current process list for reboot |
| `pm2 monit` | Live metrics dashboard (CPU / memory / logs) |
| `pm2 flush` | Clear log files |

### Updating VeloSync

When a new zip is shipped:

1. `pm2 stop all`
2. Replace the `Product` folder with the new contents, but **preserve**:
   - `Product/.env`
   - `Product/output/`
   - `Product/data/`
   - `Product/rbac.json`
   - `Product/ssl/` (if using HTTPS)
3. Reinstall dependencies in case they changed:
   ```powershell
   cd C:\VeloSync\Product
   npm install
   cd jira-md-export
   npm install
   cd ..
   ```
4. `pm2 restart all` and then `pm2 save`.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE :3000` on start | Another process has port 3000. Find it: `netstat -ano \| findstr :3000`, stop it, then `pm2 restart velosync-web`. |
| Dashboard loads but shows no data | Run the sync once manually: `cd jira-md-export; node index.js`. Check `pm2 logs velosync-sync` for errors, and confirm `Product/.env` has valid `JIRA_*` tokens. |
| `unable to get local issuer certificate` on corporate network | Set `ALLOW_INSECURE_TLS=1` in `.env`, then `pm2 restart all`. |
| Sync never runs automatically | Confirm `pm2 list` shows `velosync-sync` with status `stopped` (expected between runs) and `pm2 describe velosync-sync` shows `cron_restart: 0 0 * * *`. Cron fires only when PM2 is running — make sure `pm2-windows-startup` is installed and `pm2 save` was executed. |
| Processes disappear after reboot | Re-run: `pm2-startup install` (Windows) or `pm2 startup` (macOS/Linux), then `pm2 save`. |
| Changed `.env` but values didn't take effect | `pm2 restart all --update-env`. |

---

## Admin Setup (First-Run Configuration)

Once VeloSync is running under PM2, most day-to-day configuration is done through the **Admin** UI rather than by hand-editing `.env`. The admin page writes to `Product/.env`, `Product/rbac.json`, `Product/jira-md-export/projects.json`, `Product/branding/*`, `Product/ssl/*` and `Product/jira-md-export/dashboard-scoring.json` as appropriate.

### Accessing the admin panel

1. Open the dashboard: **http://localhost:3000**
2. Sign in:
   - **Local auth (`AUTH_MODE=local`, default):** Use the bootstrap admin account shipped in `rbac.json` — username **`admin`**, password **`admin`**. **Change this password immediately** (Admin → Platform → *Change your password*).
   - **Azure SSO (`AUTH_MODE=azure`):** Sign in with your Entra ID account. Your display name must be listed under `roles.admin` in `rbac.json` to see the admin link.
3. Click the **Admin** link in the top-right (only visible to admins) — this opens `/admin/settings`.

The left-hand navigation lists every panel. Each panel saves independently via its own **Save** button.

### Setup Wizard (guided onboarding)

The large indigo **Setup wizard** button at the top of the left nav opens a step-by-step overlay that walks a brand-new installation through the minimum required configuration. Use it on first run — it will refuse to finish until each required section is saved. You can re-open it any time.

Each wizard step has an **Open settings panel** shortcut that jumps to the underlying admin section for advanced editing.

### Platform & SSO

**Panel:** *Platform* · **File written:** `Product/.env`

Configure the authentication mode and core URLs:

| Field | Maps to | Notes |
|---|---|---|
| Auth mode | `AUTH_MODE` | `local` (username/password from `rbac.json`) or `azure` (Entra ID SSO) |
| Allow local login alongside Azure | `ALLOW_LOCAL_LOGIN` | Useful for fallback admin access when SSO is misconfigured |
| Azure Client ID / Secret / Tenant | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` | Required when `AUTH_MODE=azure` |
| Public base URL | `PUBLIC_BASE_URL` | Must exactly match the reply URL registered in your Azure app |
| Redirect / post-logout URI | `REDIRECT_URI`, `POST_LOGOUT_REDIRECT_URI` | Leave blank to auto-derive from `PUBLIC_BASE_URL` |
| Session secret | `SESSION_SECRET` | Long random string; rotate if exposed |
| OpenRouter API key | `OPENROUTER_API_KEY` | Powers the AI summaries on the dashboard |
| Allow insecure TLS | `ALLOW_INSECURE_TLS` | Set to `1` behind a corporate MITM proxy |

**Change your password** (local auth only): the *Change your password* card updates the bcrypt hash for the currently logged-in user in `rbac.json`. Current password must be verified first.

> Saving the Platform panel writes to `.env`. A green banner will prompt you to **restart the web process** (`pm2 restart velosync-web`) before some changes take effect.

### Logo, icon & title (Branding)

**Panel:** *Logo, icon & title* · **Files written:** `Product/branding/*`, `Product/.env` (title/tagline only)

| Field | Purpose |
|---|---|
| Site title | Browser tab title + header text |
| Header tagline | Small subtitle under the main heading |
| Favicon URL / upload | `/favicon.ico` by default; upload any `.ico`/`.png`/`.svg`/`.webp` |
| Logo URL / upload | `/logo.svg` by default; upload any `.png`/`.svg`/`.webp` |

A live preview card at the top shows the rendered header before you save. Uploaded files are stored under `Product/branding/` and are served from the root path.

### Setup (Jira)

**Panel:** *Setup (Jira)* · **File written:** `Product/.env`

The minimum required to make the dashboard show any data.

| Field | Maps to | Where to get it |
|---|---|---|
| Jira email | `JIRA_EMAIL` | Your Atlassian account email |
| Jira API token | `JIRA_TOKEN` | https://id.atlassian.com/manage-profile/security/api-tokens |
| Jira domain | `JIRA_DOMAIN` | e.g. `VeloSyncsolutions.atlassian.net` |

Click **Test Jira** to hit `/rest/api/3/myself` and confirm the credentials work. The response is shown in the inline console. Click **Save Jira settings** to persist to `.env`.

> After a successful Jira save, the *Projects* panel becomes unlocked — you can't add projects without a working Jira connection.

### Connectors (GitHub, Copilot, Cursor, TestRail, Confluence)

**Panel:** *Connectors* · **File written:** `Product/.env`

Each connector is **optional** and has its own toggle. Disabled connectors are skipped during the nightly sync.

| Connector | Env vars | Provides |
|---|---|---|
| GitHub | `GITHUB_TOKEN`, `ORG` | PRs, commits, reviews per contributor (section 2.3) |
| Copilot | `ENT` (+ `GITHUB_TOKEN`) | Org-level + user-level Copilot metrics (section 2.2 + Copilot Usage) |
| Cursor | `CURSOR_TOKEN` | Cursor leaderboard + AI edits by repo |
| Confluence | Shares Jira credentials | Pages created / edited per person (section 2.5) |
| TestRail | `TESTRAIL_DOMAIN`, `TESTRAIL_EMAIL`, `TESTRAIL_API_KEY` | Test execution + per-QA stats (sections 2.6, 2.7) |

Workflow:

1. Toggle on the connectors you want to use → **Save connector toggles**.
2. Fill in the credentials that just unlocked → **Save connector credentials**.
3. Click **Test enabled connectors** — the inline log shows pass/fail per connector.
4. Once green, trigger a sync: *Data Sync Job* → **Run now**, or wait for the nightly cron.

### HTTPS / SSL

**Panel:** *HTTPS / SSL* · **Files written:** `Product/ssl/server.key`, `Product/ssl/server.crt`, `Product/.env`

Upload a PEM certificate and matching key. On save, the admin route writes both to `Product/ssl/` and updates `.env`:

```
USE_HTTPS=1
SSL_KEY_PATH=ssl/server.key
SSL_CERT_PATH=ssl/server.crt
```

For a quick self-signed cert during local testing, run `npm run gen-cert` (calls `gen-cert.js`) to produce `cert.pem` / `key.pem` in the Product folder, then point `SSL_KEY_PATH` / `SSL_CERT_PATH` at those files.

> Restart the web process after enabling HTTPS: `pm2 restart velosync-web`. Don't forget to update `PUBLIC_BASE_URL` (e.g. to `https://…`) and open the new port in the firewall.

### Projects

**Panel:** *Projects* · **File written:** `Product/jira-md-export/projects.json`

The table-based editor for the projects that will be exported. Each row maps one Jira board to a display name and sprint count:

| Column | Purpose |
|---|---|
| Project name | Display label on the dashboard |
| Jira board ID | Numeric `rapidView` ID from the board URL |
| Manager | Shown in tooltips and filters |
| Sprint count | How many recent sprints/Kanban windows to export |
| Overwrite existing data files | `true` = rewrite every sprint file each run; `false` = delta mode (only `[ACTIVE]` sprint is refreshed) — see README §*Delta mode* |
| Work Classification field ID | Per-project override for the custom field |
| TestRail project IDs | Comma-separated list (links the Jira project to TestRail test runs) |

Use **Add row** to append, then **Save**. The next sync will pick up the new list automatically.

### Configure Weights (Scoring)

**Panel:** *Configure weights* · **File written:** `Product/jira-md-export/dashboard-scoring.json` (overrides `dashboard-scoring.template.json`)

All numeric weights and thresholds used across the metrics catalogue can be tuned here:

- **Project Health composite** — pillar weights (Delivery / Flow / Stability / Quality / Risk / AI Adoption) and the star-band cutoffs.
- **Dev Score** — weights for Delivery, GitHub Impact/Quality, Consistency, Impact Breadth, Confluence, Cursor, Copilot, AI Tools Adoption.
- **Benchmarks** — Sprint Completion %, Review Cycle P25/P50/P75, Carry-over thresholds, Bug Fix Rate, Hygiene anomaly thresholds, AI Adoption base scores.

The live values loaded by the dashboard always appear in the *Current scoring configuration* panel at the top of this guide when it's viewed inside the product.

> **Deleting** `dashboard-scoring.json` reverts to the shipped defaults in `dashboard-scoring.template.json` without touching the UI.

### Manage Users (RBAC)

**Panel:** *Manage users* · **File written:** `Product/rbac.json`

Two sub-panels render based on the active auth mode:

**Azure mode** — edit the `roles.admin` list as one display name per line. Anyone whose Entra ID display name matches (case-insensitive) becomes an admin. Everyone else falls back to the default role (`viewer`).

**Local mode** — full CRUD over `localUsers`:

- **Add user:** username + initial password + role (viewer/admin) + display name. Password is bcrypt-hashed on save.
- **Delete:** remove an account (cannot delete yourself).
- **Reset password:** admin-initiated; forces the user to set a new one on next login (end-users change their own via Admin → Platform → *Change your password*).

> The bootstrap `admin` / `admin` account ships for first-run access only. Change its password or delete it once real users exist.

### Data Sync Job

**Panel:** *Data Sync Job* · **Process:** `velosync-sync` (runs `jira-md-export/index.js`)

This panel surfaces the state of the nightly cron job without leaving the browser:

- **Last run** — timestamp + exit status pulled from PM2 logs.
- **Next scheduled run** — derived from `cron_restart: "0 0 * * *"` in `ecosystem.config.cjs`.
- **Run now** — fires an immediate sync (equivalent to `pm2 restart velosync-sync` from the shell). Use this after adding a project, flipping a connector, or rotating tokens — don't wait for midnight.
- **Live log tail** — streams `pm2 logs velosync-sync` output into the panel.

### After making changes — when to restart

| Change | Restart needed |
|---|---|
| Branding (title, logo, favicon) | None — dashboard refresh picks it up |
| Scoring weights | None — dashboard refresh picks it up |
| Projects list | None — takes effect on next sync; click **Run now** for immediate |
| Connector toggles / credentials | None for the web app; next sync (or **Run now**) picks them up |
| RBAC / local users | None — checked on next request |
| Platform / SSO / HTTPS / session secret | **`pm2 restart velosync-web`** (an in-app banner will prompt you) |
| `.env` edits made outside the UI | **`pm2 restart all --update-env`** |

---

## Main Dashboard Metrics

These six bar-chart metrics are shown per project for the **latest closed sprint** (or the active sprint when the toggle is on).

---

### Story Points (Completed)

**What it is:** The total number of Jira story points delivered and accepted in the sprint.

**Source:** `points` field from the sprint markdown export (section **2.1 Output** of the sprint MD template).

**Formula:** Raw integer value — no transformation applied.

**Interpretation:** Higher is generally better, but must be read alongside Sprint Completion % to distinguish large-scope sprints from over-commitment.

---

### Sprint Completion %

**What it is:** The percentage of planned story points that were actually completed by the end of the sprint.

**Source:** `completion` field from the sprint markdown (section 2.1).

**Formula:**
```
Sprint Completion % = (Story Points Completed / Story Points Planned) × 100
```

**Benchmarks (Scrum / SAFe aligned):**

| Band | Threshold |
|------|-----------|
| Stellar | ≥ 90% |
| Surge | ≥ 80% |
| Cruise | ≥ 70% |
| Friction | ≥ 50% |
| Breach | < 50% |

---

### Review Cycle

**What it is:** The average number of days a ticket spends moving from **"Dev In Progress"** to **"Ready for Staging"** (i.e., development throughput time, excluding test/release phases).

**Source:** `cycleTime` field from the sprint markdown.

**Formula:** Average across all in-scope tickets for the sprint, expressed in calendar days (decimals included).

**Interpretation:** Lower is better. A short cycle time indicates efficient development flow with fewer delays or re-work loops.

**Benchmarks:**

| Band | Threshold | Basis |
|------|-----------|-------|
| Stellar | ≤ 12 days | P25 of actual delivery data (Apr 2026, 732 tickets) |
| Surge | ≤ 21 days | P50 / median |
| Friction | ≤ 52 days | P75 |
| Poor | > 52 days | Above P75 |

---

### Throughput

**What it is:** The total number of stories and tickets (work items) closed and accepted during the sprint, independent of story point size.

**Source:** `tickets` field from the sprint markdown export (`Stories / tickets closed` row in section 1.1 Output & Delivery).

**Formula:** Raw integer count — no transformation applied.

**Interpretation:** Higher is generally better. Throughput captures raw delivery velocity and complements Sprint Completion % by counting *how many items shipped* rather than *what fraction of the plan was done*. The two metrics tell different stories:

- High completion % + low throughput → team is reliable but may be under-committing.
- Low completion % + high throughput → team is delivering a lot but consistently over-committing.

> **Note:** Carry-over Rate (the inverse of Sprint Completion %) is no longer shown as a standalone bar chart but continues to feed the **Stability Score** dimension of the Project Health Star Rating.

---

### Defect Density

**What it is:** The number of bugs opened relative to the story points delivered — a quality-per-unit-of-output measure.

**Source:** `bugsOpened` and `points` from the sprint markdown.

**Formula:**
```
Defect Density = Bugs Opened / Story Points Completed
```
_(rounded to 2 decimal places; shown as 0 when no story points were completed)_

**Interpretation:** Lower is better. A value of 0 means no bugs were raised; a value of 1.0 means one bug per story point delivered.

---

### Bug Fix Rate

**What it is:** The percentage of bugs that were closed (rVeloSynclved) relative to the number of bugs opened in the sprint.

**Source:** `bugsOpened` and `bugsClosed` from the sprint markdown.

**Formula:**
```
Bug Fix Rate % = (Bugs Closed / Bugs Opened) × 100
```
_(shown as 0 when no bugs were opened; treated as 100 for quality scoring when bugsOpened = 0)_

**Benchmarks:**

| Band | Threshold |
|------|-----------|
| Good | ≥ 80% |
| Concerning | < 50% |

---

## Project Health Star Rating

Each project receives a **1–5 band health rating** (Breach → Stellar) computed as a **weighted composite of six dimensions** aligned with industry Scrum/SAFe practices.

### Overall Formula

```
Composite Score (0–100) =
    (Delivery Score × 45%)
  + (Flow Score    × 10%)
  + (Stability Score × 10%)
  + (Quality Score × 20%)
  + (Risk Score    ×  5%)
  + (AI Adoption   × 10%)
```

Each dimension score is independently normalised to **0–100** before weighting.

---

### Delivery Score

**Weight:** 45% — the single largest factor (predictability / commitment reliability).

**Formula:** `min(100, max(0, Sprint Completion %))` — directly maps completion percentage to a 0–100 score.

---

### Flow Score

**Weight:** 10% — measures development speed and throughput.

**Formula:** Linear interpolation between elite and poor cycle-time thresholds:

```
If cycleTime ≤ 12 days  → Flow Score = 100
If cycleTime ≥ 52 days  → Flow Score = 0
Otherwise → 100 − (100 × (cycleTime − 12) / (52 − 12))
```

> Thresholds are data-driven: P25 = 12d (Stellar), P75 = 52d (Poor) — derived from 732 completed tickets across 7 projects, Apr 2026.

---

### Stability Score

**Weight:** 10% — measures planning accuracy and sprint stability.

**Formula:** Linear interpolation between good and poor carry-over thresholds:

```
If carryOver ≤ 10%  → Stability Score = 100
If carryOver ≥ 30%  → Stability Score = 0
Otherwise → 100 − (100 × (carryOver − 10) / (30 − 10))
```

---

### Quality Score

**Weight:** 20% — measures defect rVeloSynclution effectiveness.

**Formula:** `min(100, max(0, Bug Fix Rate %))`

_(If no bugs were opened, Bug Fix Rate defaults to 100, giving a full Quality Score.)_

---

### Risk Score

**Weight:** 5% — measures impediment/blocker exposure.

**Source:** `blockers` count from the sprint markdown.

**Formula:**

| Blockers | Risk Score |
|----------|------------|
| 0 | 100 |
| 1 | 60 |
| 2+ | 0 |

---

### AI Adoption Score

**Weight:** 10% — measures the project team's uptake of AI-assisted development tools (Cursor and GitHub Copilot).

**Formula:** Computed from two signals via `computeProjectAiAdoptionScore`:

1. **Repository match** — The project name is fuzzy-matched against Cursor's AI Edits by Repository data. The neutral baseline of 50 is adjusted based on the repo's "Code Committed by AI %":

| AI Code % | Base Score |
|-----------|------------|
| ≥ 60% | 62 |
| ≥ 40% | 56 |
| ≥ 20% | 52 |
| < 20% | 48 |
| No repo match | 50 (unchanged) |

2. **Leaderboard boost (Cursor + Copilot)** — For each team member found on *either* the Cursor top-25 leaderboard or the Copilot user-level top-25 leaderboard, a boost of **+5 points** is added (capped at +20). Members appearing on both leaderboards are counted once.

The final score is clamped to 0–100, giving an effective range of **48–82**. If neither Cursor nor Copilot data is available, or the project name is not provided, the AI Adoption Score defaults to a **neutral 50** (no penalty, no bonus).

---

### Composite Score & Health Bands

| Stars | Label | Composite Score |
|-------|-------|-----------------|
| ⭐⭐⭐⭐⭐ | Stellar | ≥ 85 |
| ⭐⭐⭐⭐ | Surge | ≥ 70 |
| ⭐⭐⭐ | Cruise | ≥ 55 |
| ⭐⭐ | Friction | ≥ 40 |
| ⭐ | Breach | < 40 |

> Strong AI tool adoption (Cursor + Copilot combined) can lift a project's composite score, potentially moving it into a higher rating band.

---

## Team Health Matrix

**What it shows:** A dot-grid heatmap showing every project's pillar-level scores at a glance. Each row is a project; each column is one of the six health dimensions (Delivery, Flow, Stability, Quality, Risk, AI Adoption) plus a final **Composite** column. Dots are colour-coded from red (1 / Breach) to green (5 / Stellar) using the same band thresholds as the Project Health Star Rating.

**Purpose:** Enables side-by-side comparison of where each team is strong or weak across dimensions, making systemic patterns (e.g., all teams struggling with Flow) immediately visible.

---

## Stage Dwell

**What it shows:** A horizontal bar chart displaying the **average number of days** tickets spend in each JIRA workflow stage (e.g., Open, Dev In Progress, Code Review, Ready for Staging, QA In Progress, Done).

**Source:** Computed from JIRA issue changelogs during the `jira-md-export` sync. For each ticket in the last completed sprint, every status transition is tracked and the dwell time (in calendar days) between consecutive transitions is recorded per stage. Results are aggregated across all projects and written to `output/stagedwelldata.json`.

**Formula:**
```
Avg Dwell (days) = Sum of dwell-days in stage across all tickets / Count of tickets that passed through that stage
```

**Interpretation:** Stages with high average dwell time are bottlenecks. Comparing dwell times across stages highlights where work gets stuck — e.g., a long Code Review dwell suggests reviewer capacity constraints, while a long QA dwell may indicate test environment issues.

**Display:** Bars are sorted by workflow position (earliest stage first). The ticket count label shows how many tickets contributed dwell data out of the total tickets in scope.

---

## Dev Score (0–10)

Each developer/rVeloSyncurce is assigned a composite **Dev Score from 0–10**, combining delivery output, GitHub activity, consistency, breadth of involvement, Cursor leaderboard presence, Copilot individual usage, and AI tool adoption. Scores update with the current filter.

### Overall Formula

```
Raw Score (0–1) =
    Delivery             × 0.18
  + GitHub Impact        × 0.22
  + GitHub Quality       × 0.12
  + Consistency          × 0.11
  + Impact Breadth       × 0.08
  + Confluence Docs      × 0.05
  + Cursor Leaderboard   × 0.08  (scaled by dev-tools cap)
  + Copilot Individual   × 0.08  (scaled by dev-tools cap)
  + AI Tools Adoption    × 0.08  (scaled by dev-tools cap)

Dev Score = round(Raw Score × 10)   [clamped 0–10]
```

**Weight split:** Core engineering signals (Delivery + GitHub + Consistency + Breadth + Docs) = **76%**. Dev tools (Cursor + Copilot + AI adoption) = **24%** combined cap.

All individual dimension scores are **percentile-ranked** across the currently visible population before weighting, so the score reflects relative performance within the filtered group.

---

### Delivery (Story Points)

**What it measures:** A developer's story point output relative to peers.

**Formula:** `percentileRank(individual story points, all visible developers' story points)` — normalised to 0–1.

---

### GitHub Impact

**What it measures:** Raw GitHub activity volume (commits, PRs, lines changed).

**Activity Index Formula:**
```
GitHub Activity Index = (commits × 1.8) + (prs × 1.2) + log(1 + lines_changed)
```
Then percentile-ranked across the group.

---

### GitHub Quality

**What it measures:** Code review discipline and healthy churn patterns.

**Sub-components:**

| Sub-metric | Formula |
|------------|---------|
| Review Ratio Score | `clamp(prs / commits / 0.6, 0, 1)` — higher PR-to-commit ratio = better review culture |
| Churn Score | `clamp(1 − |linesPerCommit − 260| / 260, 0, 1)` — ideal commit size ~260 lines changed |
| GitHub Quality | `(0.6 × reviewRatioScore) + (0.4 × churnScore)` |

Then percentile-ranked.

---

### Consistency

**What it measures:** How reliably a developer contributes across sprints and maintains stable AI ratings.

**Formula:**
```
Sprint Presence Ratio = sprintCount / maxSprintCount (across group)
AI Stability          = clamp(1 − (stdDev(ai ratings) / 1.5), 0, 1)
Consistency Score     = (0.65 × sprintPresenceRatio) + (0.35 × aiStability)
```

---

### Impact Breadth

**What it measures:** How broadly a developer contributes across projects and repositories.

**Formula:**
```
Repo Breadth    = percentileRank(repoCount, all repoCounts)
Project Breadth = percentileRank(projectCount, all projectCounts)
Impact Breadth  = (0.55 × repoBreadth) + (0.45 × projectBreadth)
```

---

### Confluence Docs Activity

**What it measures:** A developer's contribution to team documentation via Confluence — pages created and edited during sprint windows.

**Weight:** 5% — rewards developers who actively maintain and grow the team's knowledge base.

**Source:** Sprint markdown section **2.5 Confluence Activity**, parsed per developer. Each person's `pagesCreated + pagesEdited` are summed across all selected sprints/projects.

**Formula:**
```
confluencePages = sum of (pagesCreated + pagesEdited) across all filtered sprints
normConfluence  = percentileRank(confluencePages, all developers' confluencePages)
```

**Interpretation:** Developers who consistently document architecture, processes, or design decisions earn a higher Confluence score relative to peers. A developer with 0 pages still receives a baseline percentile rank (not penalised beyond ranking below active documenters).

**Display:** Shown as a "Docs" column in the Dev Leaderboard table and QA Board, and appears in the score breakdown tooltip. On the RVeloSyncurce Insights page, the Sprint Performance table includes a per-sprint Docs column.

---

### Cursor Leaderboard Signal

**What it measures:** Whether the developer appears on the Cursor top-25 leaderboard and how highly they rank.

**Source:** Cursor API data synced via `jira-md-export/connectors/cursor.js`.

**Signal:** Fuzzy name-matched against the leaderboard. If matched, the signal score combines:

| Sub-signal | Weight | Description |
|------------|--------|-------------|
| Volume | 45% | Log-normalised lines accepted + total accepts |
| Quality | 35% | Line acceptance ratio (0–1) |
| Rank | 20% | Position in leaderboard (rank 1 = 1.0, last = 0.0) |

If not found on the leaderboard, score = 0.

---

### Copilot Individual Signal

**What it measures:** Whether the developer appears on the GitHub Copilot user-level leaderboard (top 25 by lines accepted) and how actively they use Copilot features.

**Source:** GitHub Copilot enterprise user-level 28-day report, synced via `jira-md-export/connectors/copilot.js` (endpoint: `enterprises/{ent}/copilot/metrics/reports/users-28-day/latest`).

**Matching:** The developer's display name is fuzzy-matched against `user_login` from the Copilot report. GitHub logins typically follow the `firstname.lastname` convention.

**Signal formula:**

| Sub-signal | Weight | Description |
|------------|--------|-------------|
| Volume | 40% | Log-normalised lines accepted + code acceptance count |
| Quality | 25% | Acceptance rate (accepted lines / suggested lines) |
| Feature breadth | 15% | Number of features used: completions, chat, agent, CLI (0–1 scaled to 4) |
| Rank | 20% | Position in leaderboard (rank 1 = 1.0, last = 0.0) |

If not found on the leaderboard, score = 0.

**Copilot leaderboard table columns:**

| Column | Definition |
|--------|-----------|
| **User** | GitHub login |
| **Lines accepted** | Total lines of AI-suggested code accepted (28-day sum) |
| **Lines suggested** | Total lines of code suggested by Copilot |
| **Acceptance** | Accepted ÷ suggested (ratio) |
| **Active days** | Number of days with at least one Copilot interaction |
| **Features** | Badges for features used: Completions, Chat, Agent, CLI |

---

### AI Tools Adoption

**What it measures:** A developer's average AI adoption rating from sprint data, amplified by org-level Copilot signal. When Cursor and/or Copilot user-level data is loaded, the per-sprint AI rating (1–4) is dynamically recomputed using `computePersonAiAdoptionRating()`, which factors in Cursor leaderboard presence, Copilot user leaderboard presence, and project repository AI code percentages — meaning the AI adoption line on both the main **Dev Data chart** and the project-detail **Developer Insights chart** reflects combined tool usage.

**Formula:**
```
Average AI Rating  = mean of per-sprint AI scores (scale 1–4; dynamically enriched by Cursor + Copilot leaderboard when data loaded)
Normalised AI      = clamp((avgAiRating − 1) / 3, 0, 1)
Copilot Org Signal = 0.6 × (engagedUsers / activeUsers) + 0.4 × (acceptedLines / suggestedLines)
AI Tools Score     = clamp(normAI × (0.7 + 0.3 × copilotOrgSignal), 0, 1)
```

> **Note:** The combined weight of Cursor Leaderboard + Copilot Individual + AI Tools Adoption is capped at **24%** (reduced from 25% to accommodate the 5% Confluence Docs signal) to avoid over-weighting tool-specific data when only some tools' data is available.

---

## Work Categorization

**What it shows:** The share of each **JIRA Work Classification** category for the loaded sprint.

**Source:** The Work Classification table in the sprint markdown. Each ticket is tagged with a category (e.g., *1. Regulatory*, *2. Feature*, *3. Technical Debt*).

**Formula:** Each bar represents 100%; segments are the **% of items closed** in Done status for each category. If no items are closed, the % of opened items is used instead.

---

## JIRA Hygiene

The **JIRA Hygiene** panel surfaces process-adherence issues within a sprint — tickets that have not been set up or maintained correctly. Poor hygiene leads to inaccurate boards, unreliable reporting, and harder sprint planning. The panel appears on the main dashboard between Stage Dwell and AI/Dev Tools.

**Data source:** Computed automatically by `jira-md-export/index.js` during each JIRA export. Hygiene metrics are written to section **4. JIRA Hygiene** in each sprint markdown file and parsed back by the dashboard on load. No additional JIRA API calls are required — all fields are already fetched as part of the standard sprint issue pull.

---

### Hygiene Score

**What it is:** A single 0–100 score representing how well a project's sprint tickets conform to JIRA hygiene best practices. Higher is better.

**Formula:**
```
penalty = (unestimatedRate × 0.20)
        + (unclassifiedRate × 0.15)
        + (midSprintAddedRate × 0.20)
        + (missingPriorityRate × 0.15)
        + (unrVeloSynclvedBlockerRate × 0.10)
        + (carryOverRate × 0.20)

Hygiene Score = max(0, round(100 − penalty × 100))
```

Each `rate` is the fraction of tickets in the sprint that violate the given dimension (violating tickets ÷ total tickets).

**Thresholds:**

| Band | Score | Indicator |
|------|-------|-----------|
| Good | ≥ 80 | 🟢 |
| Watch | 60–79 | 🟡 |
| Action needed | < 60 | 🔴 |

**Display:** Each project gets a colour-coded score card. The breakdown table lists all projects as rows and each hygiene dimension as a column, with count, rate %, status emoji, and a hover tooltip showing up to 3 sample ticket keys.

---

### Unestimated Tickets

**Weight in score:** 20%

**What it flags:** Tickets that are **not yet done** and have **0 story points** assigned.

**Why it matters:** Unestimated tickets make sprint velocity and completion % unreliable. They indicate that backlog refinement was skipped or incomplete before the sprint started.

**Anomaly thresholds:**

| Rate | Status |
|------|--------|
| ≤ 15% | 🟢 OK |
| 16–30% | 🟡 Watch |
| > 30% | 🔴 Action needed |

**JIRA field:** `story_points` (or `customfield_10002`) = 0 AND `status.statusCategory.key` ≠ `done`.

---

### No Work Classification

**Weight in score:** 15%

**What it flags:** Tickets where the **Work Classification** custom field is empty or unset (shown as `Uncategorized`).

**Why it matters:** Work Classification drives the Work Categorization chart and regulatory compliance tracking. Uncategorized tickets distort work-mix reporting and can under-count regulatory obligations.

**Anomaly thresholds:**

| Rate | Status |
|------|--------|
| ≤ 20% | 🟢 OK |
| 21–40% | 🟡 Watch |
| > 40% | 🔴 Action needed |

**JIRA field:** Custom field discovered via `GET /rest/api/3/field` (field name contains "Work Classification").

---

### Mid-Sprint Additions (Scope Creep)

**Weight in score:** 20%

**What it flags:** Tickets whose **created date** falls **after the sprint start date** — i.e., work that was added to the sprint after it began rather than being committed at planning.

**Why it matters:** Frequent mid-sprint additions destabilise sprint commitments, inflate carry-over, and indicate planning quality issues. Industry benchmarks (Harness SEI, SAFe) flag a creep-to-commit ratio consistently above 15–20% as a planning signal.

**Anomaly thresholds:**

| Rate | Status |
|------|--------|
| ≤ 10% | 🟢 OK |
| 11–20% | 🟡 Watch |
| > 20% | 🔴 Action needed |

**JIRA field:** `fields.created` compared against `sprint.startDate`.

---

### Missing Priority

**Weight in score:** 15%

**What it flags:** Tickets with **no priority set** (priority is blank, `N/A`, `None`, or `Undefined`).

**Why it matters:** Priority-less tickets cannot be triaged or ranked effectively during planning and daily standups. They indicate incomplete backlog hygiene and make it harder to identify what to pull into a sprint.

**Anomaly thresholds:**

| Rate | Status |
|------|--------|
| ≤ 15% | 🟢 OK |
| 16–30% | 🟡 Watch |
| > 30% | 🔴 Action needed |

**JIRA field:** `fields.priority.name`.

---

### UnrVeloSynclved Blockers

**Weight in score:** 10%

**What it flags:** Tickets marked as a **blocker** (priority = Blocker, issue type = Impediment, or flagged with a blocker/impediment label) that are **not in a Done status** at the time of export.

**Why it matters:** Active unrVeloSynclved blockers are the most direct risk signal in a sprint. Even a single unrVeloSynclved blocker is flagged as 🔴, since it represents work that is actively impeding progress and should be escalated.

**Threshold:** Any count > 0 = 🔴. Count = 0 = 🟢. (No proportional threshold — a blocker is a blocker regardless of total ticket count.)

**JIRA fields:** `fields.priority.name` = "Blocker" OR `fields.issuetype.name` = "Impediment" OR `fields.labels[]` contains "blocker"/"blocked"/"impediment" OR `fields.customfield_10021[].value` = "Impediment".

---

### Carry-over (Hygiene)

**Weight in score:** 20%

**What it flags:** Tickets that are **not in a Done status** at the time of export — i.e., work committed to the sprint but not delivered.

**Why it is included:** Carry-over is a direct indicator of planning accuracy and execution discipline. A consistently high carry-over rate means the team is either over-committing or not managing scope effectively during the sprint. Although it is also factored into the **Stability Score** of the Project Health Star Rating (which measures delivery predictability), its inclusion here specifically penalises the hygiene score when unfinished work accumulates — reinforcing that incomplete tickets represent a process gap, not just a delivery shortfall.

**Anomaly thresholds:**

| Rate | Status |
|------|--------|
| ≤ 20% | 🟢 OK |
| 21–40% | 🟡 Watch |
| > 40% | 🔴 Action needed |

---

## Copilot Usage

GitHub Copilot statistics, synced by `jira-md-export/connectors/copilot.js` (period: last 28 days).

### Org-level metrics (enterprise aggregate)

| Metric | Definition |
|--------|-----------|
| **Total Active Users** | Number of users who triggered at least one Copilot suggestion |
| **Total Engaged Users** | Number of users who accepted at least one suggestion |
| **Total Chats** | Number of Copilot Chat interactions |
| **Lines Suggested** | Total lines of code offered by Copilot |
| **Lines Accepted** | Total lines accepted into committed code |
| **Language share** | Pie chart of Copilot usage broken down by programming language |

### User-level leaderboard (top 25)

Individual user metrics from the GitHub Copilot enterprise user-level 28-day report (`users-28-day/latest` API endpoint). Each user's daily telemetry rows are aggregated across the 28-day window and ranked by lines accepted.

| Column | Definition |
|--------|-----------|
| **User** | GitHub login (`user_login`) |
| **Lines accepted** | Sum of `loc_added_sum` across all active days |
| **Lines suggested** | Sum of `loc_suggested_to_add_sum` |
| **Acceptance** | (accepted lines + deleted lines) ÷ (suggested to add + suggested to delete) |
| **Active days** | Count of distinct days with at least one Copilot interaction |
| **Features** | Badges for features observed: Completions (always), Chat, Agent, CLI (from `used_chat`, `used_agent`, `used_cli` flags) |

This data feeds the **Copilot Individual Signal** in the Dev Score and is also surfaced in the Copilot leaderboard table on the dashboard.

**Prerequisite:** The enterprise must have the **"Copilot usage metrics"** policy set to **Enabled everywhere**. If disabled, the user-level leaderboard will be empty (the enterprise aggregate still works).

---

## Cursor Usage

Org-level Cursor AI statistics, synced by `jira-md-export/connectors/cursor.js` (period: last 30 days).

| Metric | Definition |
|--------|-----------|
| **Total Active Users** | Users who opened Cursor at least once in the period |
| **Total Engaged Users** | Users who triggered at least one AI action |
| **Total Requests** | Total AI requests (chat + composer + agent + Cmd+K) |
| **Lines Suggested** | Lines of code offered by Cursor AI |
| **Lines Accepted** | Lines of AI-suggested code committed |
| **Model share** | Breakdown of requests by AI model used (e.g., Claude, GPT-4o) |
| **Language / extension share** | Breakdown by file type / language extension |
| **Intent distribution** | Request types: Chat vs Composer vs Agent vs Cmd+K |
| **AI Edits by Repository** | Per-repo: AI lines committed, total lines committed, and AI % |
| **Top 25 leaderboard** | Individual users ranked by Cursor engagement (lines added/deleted, acceptance rate, request counts) |

---

## Project Detail Page Metrics

Accessed by clicking a project card. Supports a **date-range slider** to filter the sprint history window.

---

### Regulatory & Compliance %

**What it is:** The proportion of total development cycle days spent on regulatory-tagged work across all selected sprints.

**Source:** `regulatoryDays` (`regDays=` tag in sprint MD) and `totalCycleDays` (`totDays=` tag).

**Formula:**
```
Regulatory % = (Sum of regulatoryDays across sprints) / (Sum of totalCycleDays across sprints) × 100
```
_(rounded to nearest integer)_

**Classification source:** Tickets tagged as **"Work Classification: 1. Regulatory"** in the JIRA sprint markdown.

---

### Velocity & Success Trend

**What it shows:** Sprint-by-sprint trend of **story points delivered** (bars, left axis) and **sprint completion %** (line, right axis) over the selected date range.

**Source:** `points` and `completion` per sprint from history.

---

### Developer Insights Chart

**What it shows:** Per-developer breakdown of **story points** (bars) and **AI adoption rating 1–4** (line) for the selected sprint range.

**AI Rating Scale (1–4):**

| Rating | Meaning |
|--------|---------|
| 1 | No AI tool usage observed |
| 2 | Occasional / exploratory usage, or present on Cursor OR Copilot leaderboard |
| 3 | Regular usage in workflow, or project repo has significant AI code, or present on BOTH Cursor and Copilot leaderboards |
| 4 | Heavy / advanced usage (e.g., agentic workflows), high AI code % in project repo |

**Source:** When Cursor and/or Copilot data is loaded, the rating is computed dynamically using `computePersonAiAdoptionRating()` — combining the sprint markdown AI score (section 2.2), Cursor leaderboard presence, Copilot user leaderboard presence, and project repository AI code percentage. When no dev-tools data is loaded, the raw value from the sprint markdown is used.

---

### Bug Throughput

**What it shows:** Sprint-by-sprint count of **bugs opened** vs **bugs closed**, plotted as grouped bars.

**Source:** `bugsOpened` and `bugsClosed` per sprint.

**Interpretation:** Consistently more bugs closed than opened indicates a healthy defect rVeloSynclution trend. Persistent "opened > closed" is a quality risk signal.

---

### Cycle Time Trend

**What it shows:** Average review cycle time (days) per sprint as a line chart, with benchmark reference lines.

**Source:** `cycleTime` per sprint.

**Reference lines:**
- Stellar threshold: 12 days (P25)
- Surge threshold: 21 days (P50 / median)

---

### Bug Fix Rate vs Carry-over Rate Trend

**What it shows:** Sprint-by-sprint trend of two key health metrics side by side (as lines, in %).

| Line | Formula |
|------|---------|
| Bug Fix Rate % | `(bugsClosed / bugsOpened) × 100` per sprint |
| Carry-over Rate % | `carryOver` per sprint |

**Interpretation:** Ideally Bug Fix Rate trends upward while Carry-over Rate trends downward over time.

---

### Sprint History Table

A raw tabular view of all sprints in the selected date range with the following columns:

| Column | Definition |
|--------|-----------|
| **Review Date** | Sprint end / review date |
| **Points** | Story points completed |
| **Success Rate** | Sprint completion % |
| **Bugs (C/O)** | Bugs closed / bugs opened |
| **Cycle Time** | Avg days from Dev In Progress → Ready for Staging |
| **Bug Fix Rate** | `(bugsClosed / bugsOpened) × 100` % |
| **Carry-over %** | Unfinished story points as % of planned |

---

*Last updated: April 2026 · Product & Technology Engineering · VeloSync IDC Pune*
