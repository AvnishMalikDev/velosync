/**
 * jira-md-export entrypoint.
 *
 * Thin wrapper kept at the package root so external callers (PM2, run.bat,
 * `Product/lib/data-sync-job.js`, MAINTENERS.md docs) still work without
 * needing to know about the `src/` layout.
 *
 * All real logic lives in `src/orchestrator.js`; modular code is organised
 * under `src/connectors/<system>/` (one folder per integration) and
 * `src/domain/` (pure helpers — no I/O).
 */

import "./src/core/env.js";
import { run } from "./src/orchestrator.js";

run()
  .then(() => {
    // Explicit exit: undici's global fetch agent (Node 18+) keeps idle
    // keep-alive sockets pooled, which would otherwise hang the process
    // for several seconds after the orchestrator returns. PM2 / cron want
    // a fast clean exit.
    process.exit(0);
  })
  .catch((err) => {
    console.error("[jira-md-export] Fatal:", err.message || err);
    process.exit(1);
  });
