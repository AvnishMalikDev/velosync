/**
 * Canonical env: Product/.env (dashboard, admin, PM2, HTTPS — one file operators edit).
 * jira-md-export/.env is legacy; still merged at process startup when both exist (Product wins on conflicts).
 */
const path = require('path');
const fs = require('fs');

function getProductEnvPath(productRoot) {
  return path.join(productRoot, '.env');
}

function getJiraExportEnvPath(productRoot) {
  return path.join(productRoot, 'jira-md-export', '.env');
}

/** Admin UI and HTTPS upload read/write this path. */
function getCanonicalEnvPath(productRoot) {
  return getProductEnvPath(productRoot);
}

/** Prefer Product/.env; else legacy jira-md-export/.env for reads. */
function resolveEnvFilePathForRead(productRoot) {
  const product = getProductEnvPath(productRoot);
  if (fs.existsSync(product)) return product;
  const legacy = getJiraExportEnvPath(productRoot);
  if (fs.existsSync(legacy)) return legacy;
  return product;
}

module.exports = {
  getProductEnvPath,
  getJiraExportEnvPath,
  getCanonicalEnvPath,
  resolveEnvFilePathForRead,
};
