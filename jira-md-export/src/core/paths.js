/**
 * Centralised filesystem paths.
 *
 * All other modules import `OUTPUT_DIR` from here instead of computing
 * `path.join(__dirname, '..', 'output')` locally — that approach silently
 * broke when modules moved deeper into `src/connectors/<system>/`.
 *
 * Layout:
 *   <jira-md-export>/                   ROOT_DIR
 *   <jira-md-export>/src/...
 *   <jira-md-export>/../output/         OUTPUT_DIR  (Product/output/)
 *   <jira-md-export>/projects.json      PROJECTS_JSON
 *   <jira-md-export>/Template/          TEMPLATE_DIR
 */

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the jira-md-export root (the folder that owns package.json). */
export const ROOT_DIR = path.resolve(__dirname, "..", "..");

/** Parent of jira-md-export — i.e. the Product folder. Output JSON / MD files live here. */
export const PRODUCT_DIR = path.resolve(ROOT_DIR, "..");

/** Where the dashboard reads MD + JSON files from. */
export const OUTPUT_DIR = path.join(PRODUCT_DIR, "output");

/** Project list. */
export const PROJECTS_JSON = path.join(ROOT_DIR, "projects.json");

/** Manual JIRA-displayName ? GitHub-login override file. */
export const GITHUB_USERS_JSON = path.join(ROOT_DIR, "github-users.json");

/** Template folder containing the markdown template. */
export const TEMPLATE_DIR = path.join(ROOT_DIR, "Template");

/** TestRail user ID cache. */
export const TESTRAIL_USERS_JSON = path.join(OUTPUT_DIR, "testrail-users.json");

/** JIRA / TestRail / GitHub combined user directory (cached for 7 days). */
export const resource_DIRECTORY_JSON = path.join(OUTPUT_DIR, "resource-directory.json");
