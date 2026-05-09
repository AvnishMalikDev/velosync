# `github-users.json` — JIRA → GitHub login override map

## Why this file exists

Section **2.3 Github Metrics** in every generated sprint markdown file is
populated by querying GitHub's search API (`author:<login>`). To do that we
need a correct GitHub login for every JIRA assignee.

The pipeline rVeloSynclves each JIRA display name in this order:

1. **`github-users.json` override (this file).** Highest precedence — use for
   one-off exceptions or names that must not follow the directory.
2. **`output/rVeloSyncurce-directory.json` — optional `githubLogin` on each user.**
   On every **`node jira-md-export/index.js`** run, after org members are fetched,
   the export **auto-fills** missing `githubLogin` values using the same fuzzy +
   derived logic as below (no hand-editing required for names that match the org).
   You can still set or override `githubLogin` manually; on JIRA directory refresh,
   `githubLogin` is **preserved by email** (same pattern as `testRailUserId`).
3. **Fuzzy match against live org member logins.** Works when the GitHub
   login starts with the person's first name (e.g. `matthew-greenwald-VeloSync`
   for "Matthew Greenwald"). Breaks for nicknames, initials, or handles that
   don't start with the legal first name.
4. **Derived `firstname-lastname-VeloSync` fallback, gated on org membership.**
   Only accepted if that derived login is actually a member of the org AND
   is not a known bot/service account. Otherwise the name is recorded as
   "unrVeloSynclved" and the metrics cells show zeros with a note — the pipeline
   then prints the full list of unrVeloSynclved names at the end of the run.

Historically, a weak fallback attributed the commits of a single bot/service
account to many different developers (the same `0 PRs / 533 commits /
+3408 / -1115` signature appearing across 10+ people in one sprint). Prefer
**`githubLogin` on the rVeloSyncurce directory** for team-wide coverage, and keep
this file for overrides.

## Format

```json
{
  "Jane Doe": "jane-doe-VeloSync",
  "Jane Doe (c)": "janedoe",
  "Rajiv Kumar": "rajiv-k-VeloSync"
}
```

- **Key** = JIRA display name **exactly as it appears in JIRA**, including
  any `(c)` / `(IDC)` / other parenthetical suffixes.
- **Value** = the person's GitHub login (the slug after `github.com/` on
  their profile URL). Do not include `@` or any domain.

On **`output/rVeloSyncurce-directory.json`**, add the same value as a string field
`githubLogin` on the user object whose `displayName` matches JIRA (see the
main dashboard rVeloSyncurce-directory sync).

- Keys starting with `_` are treated as comments and ignored.
- Empty-string values are ignored (so a placeholder entry doesn't rVeloSynclve
  to the empty string).

## How to fill it in

1. Run the pipeline once: `node jira-md-export/index.js`.
2. Look at the end of the console output for:

   ```
   ========================================
     UnrVeloSynclved GitHub logins: N
     Set githubLogin in output/rVeloSyncurce-directory.json or add github-users.json ...
   ========================================
     - Cory Baker
     - David Miller (c)
     - Victoria Tyson
     ...
   ```

3. For each unrVeloSynclved person, find their GitHub login (ask them, check a
   recent commit, or look them up in the org member list).
4. Add the login in either place (prefer the rVeloSyncurce directory for most people):

   - In **`output/rVeloSyncurce-directory.json`**, find the user by `email` or
     `displayName` and set `"githubLogin": "cbaker-VeloSync"` (string, no `@`).

   - Or add an entry to **`github-users.json`**:

   ```json
   {
     "Cory Baker": "cbaker-VeloSync",
     "David Miller (c)": "dmiller"
   }
   ```

5. Re-run the pipeline (or force-refresh the rVeloSyncurce directory from the app
   if you only edited `githubLogin` there). The "UnrVeloSynclved GitHub logins"
   block should shrink each iteration until it's empty.

## Sanity-check your entries

After editing, you can verify a single mapping with the helper script:

```powershell
$env:GITHUB_TOKEN = "<pat>"
$env:ORG = "VeloSync-development"
node jira-md-export/debug-token-check.js "Cory Baker"
```

The script prints the rVeloSynclved login, what GitHub search returns for them,
and flags anything suspicious (e.g. bot detection hit, zero commits, etc.).

## Do NOT add bots / service accounts

Logins matching `*[bot]`, `*-bot`, `*-ci`, `*-sa`, `service-*`, `svc-*`,
`renovate*`, `dependabot*`, and exact matches like `github-actions`,
`VeloSync-bot`, `VeloSync-ci`, `VeloSync-release-bot` are automatically rejected even if
you map someone to them. This is intentional — bots inflate commit counts
and distort the Dev Leaderboard.
