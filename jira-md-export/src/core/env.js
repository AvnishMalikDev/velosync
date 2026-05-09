/**
 * Canonical env loader.
 *
 * Loads from `Product/.env` (parent of jira-md-export) by default and merges
 * `jira-md-export/.env` underneath when both exist (Product wins). This keeps
 * a single source of truth for credentials shared with `server.js`.
 *
 * Side-effect import — must run before any module that reads `process.env.*`.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { ROOT_DIR, PRODUCT_DIR } from "./paths.js";

const jiraEnv = path.join(ROOT_DIR, ".env");
const productEnv = path.join(PRODUCT_DIR, ".env");
const hasJira = fs.existsSync(jiraEnv);
const hasProduct = fs.existsSync(productEnv);

let target = productEnv;
if (hasProduct && hasJira) {
  dotenv.config({ path: jiraEnv, override: false });
  dotenv.config({ path: productEnv, override: true });
  target = productEnv;
} else if (hasProduct) {
  dotenv.config({ path: productEnv });
  target = productEnv;
} else if (hasJira) {
  dotenv.config({ path: jiraEnv });
  target = jiraEnv;
} else {
  dotenv.config({ path: productEnv });
}

export const LOADED_ENV_PATH = target;
