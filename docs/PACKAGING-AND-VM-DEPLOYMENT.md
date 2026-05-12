# Packaging & VM deployment — architecture notes

**Status:** Future reference (not implemented). Captures a senior technical review from 2026-04-19: bundling VeloSync as a Windows `.exe` / appliance install.

## What we are shipping

- **Dashboard server:** Node + Express under `Product/` (CommonJS `server.js`, static HTML/JS, sessions, optional Azure SSO, admin APIs).
- **Export pipeline:** Separate package `Product/jira-md-export/` — **ESM**, **own `node_modules`**, shares the canonical env file **`Product/.env`** with the dashboard (legacy `jira-md-export/.env` is merged at startup when both exist; Product wins on conflicts).
- **Mutable runtime data:** `Product/.env`, `rbac.json`, `data/connectors.json`, `branding/uploads/`, `ssl/`, `jira-md-export/projects.json`, `jira-md-export/output/`, etc.

The main server file does not appear to spawn the export pipeline automatically; VMs typically need a **scheduled task**, **service**, or future **API-triggered job** for exports.

## Single `.exe` options (pkg / nexe)

**Feasible** for the **server only** with explicit asset lists and path discipline.

**Friction:**

- `express.static` / `sendFile` need every static asset declared (or an external install dir).
- **Two Node graphs** (Product + jira-md-export) complicate one binary; often: pkg the server + ship exporter as sibling folder with `node`, or merge deps (workspaces).
- **Writable data** must not rely on `Program Files`; use e.g. `%ProgramData%\VeloSync` or `VELOSYNC_HOME` / `DATA_ROOT`.
- Dependencies: **`bcryptjs`** is JS-only (good). Avoid native `bcrypt` without prebuilds.

## Recommended default for “any VM”

**Installer (MSI/NSIS/Inno) + pinned Node LTS + Windows Service + optional Task Scheduler** for `jira-md-export`, rather than a monolithic exe—less surprise, easier updates.

**Docker** on the VM is a strong alternative if containers are allowed.

## Design follow-ups (when we pick this up)

1. **Introduce `DATA_ROOT` / `VELOSYNC_HOME`** — resolve `.env`, rbac, connectors, uploads, ssl, projects.json, output under one writable root; keep code read-only under install dir.
2. **Unify or document deps** — `npm ci` in both `Product` and `jira-md-export`, or **npm workspaces** / pnpm monorepo to kill duplicate `dotenv` majors.
3. **Service + export orchestration** — NSSM/winsw/`node-windows` for `node server.js`; scheduled task or in-app job for exports.
4. **Hardening doc** — bootstrap `admin`/`admin`, `.env` secrets, `rejectUnauthorized: false` in some exporter paths (corporate MITM), HTTPS restart after SSL upload.
5. **Release engineering** — `engines` in package.json, smoke test, optional code signing for installer.

## Bottom line

Treat VeloSync as an **internal web appliance**: Node server + file-backed config + optional SSO + separate export tool. Turning that into **one self-contained `.exe`** is a **packaging project** (paths, assets, dual package, writable data), not a small tweak. Lowest risk path: **installer + Node + data directory + service**.
