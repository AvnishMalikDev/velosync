/**
 * Optional integration toggles (microkernel-style). Jira is always required/enabled.
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const envPaths = require('./env-paths');

const CONNECTOR_KEYS = ['confluence', 'github', 'copilot', 'cursor', 'testrail', 'openrouter'];

function connectorsFilePath(productRoot) {
  return path.join(productRoot, 'data', 'connectors.json');
}

function defaultConnectors(allOptionalEnabled) {
  const c = { jira: { enabled: true } };
  for (const k of CONNECTOR_KEYS) {
    c[k] = { enabled: !!allOptionalEnabled };
  }
  return { version: 1, connectors: c };
}

function parseEnvFileForHints(productRoot) {
  const envFile = envPaths.resolveEnvFilePathForRead(productRoot);
  try {
    return dotenv.parse(fs.readFileSync(envFile, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Infer which optional connectors are credentialed in .env (canonical Product/.env).
 * Used to sync data/connectors.json when the file has every optional connector off (typical
 * after a template) but the deployment already has tokens configured.
 */
function connectorEnvHints(productRoot) {
  const e = parseEnvFileForHints(productRoot);
  const val = (k) => {
    const v = e[k];
    return v != null && String(v).trim() !== '';
  };
  const jiraReady = val('JIRA_EMAIL') && val('JIRA_TOKEN') && val('JIRA_DOMAIN');
  return {
    confluence: jiraReady,
    github: val('GITHUB_TOKEN') && val('ORG'),
    copilot: val('GITHUB_TOKEN') && val('ORG') && val('ENT'),
    cursor: val('CURSOR_TOKEN'),
    testrail: val('TESTRAIL_DOMAIN') && val('TESTRAIL_EMAIL') && val('TESTRAIL_API_KEY'),
    openrouter: val('OPENROUTER_API_KEY'),
  };
}

/**
 * If every optional connector is disabled in connectors.json but .env has credentials for some,
 * enable those connectors in the file so Admin UI, export pipeline, and tests stay aligned.
 */
function reconcileConnectorsWithEnvIfAllOptionalDisabled(productRoot) {
  const p = connectorsFilePath(productRoot);
  if (!fs.existsSync(p)) return false;
  const disk = readConnectors(productRoot);
  const optionalAllFalse = CONNECTOR_KEYS.every((k) => !disk.connectors[k].enabled);
  if (!optionalAllFalse) return false;
  const hints = connectorEnvHints(productRoot);
  const next = {
    version: disk.version || 1,
    connectors: { ...disk.connectors },
  };
  let any = false;
  for (const k of CONNECTOR_KEYS) {
    if (hints[k]) {
      next.connectors[k] = { enabled: true };
      any = true;
    }
  }
  if (!any) return false;
  writeConnectors(productRoot, next);
  console.warn(
    '[connectors-config] Enabled optional connector(s) in data/connectors.json based on .env credentials (file had all off). Turn off in Admin ? Connectors if undesired.'
  );
  return true;
}

function readConnectors(productRoot) {
  const p = connectorsFilePath(productRoot);
  if (!fs.existsSync(p)) {
    return defaultConnectors(true);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const base = defaultConnectors(false);
    const merged = { ...base, ...raw, connectors: { ...base.connectors, ...(raw.connectors || {}) } };
    merged.connectors.jira = { enabled: true };
    for (const k of CONNECTOR_KEYS) {
      if (!merged.connectors[k] || typeof merged.connectors[k] !== 'object') {
        merged.connectors[k] = { enabled: false };
      } else if (typeof merged.connectors[k].enabled !== 'boolean') {
        merged.connectors[k].enabled = false;
      }
    }
    merged.version = Number(merged.version) || 1;
    return merged;
  } catch (e) {
    console.warn('[connectors-config] read failed:', e.message);
    return defaultConnectors(true);
  }
}

function writeConnectors(productRoot, data) {
  const dir = path.dirname(connectorsFilePath(productRoot));
  fs.mkdirSync(dir, { recursive: true });
  const next = {
    version: Number(data.version) || 1,
    connectors: { ...(data.connectors || {}) },
  };
  next.connectors.jira = { enabled: true };
  for (const k of CONNECTOR_KEYS) {
    if (!next.connectors[k] || typeof next.connectors[k] !== 'object') {
      next.connectors[k] = { enabled: false };
    }
    next.connectors[k].enabled = !!next.connectors[k].enabled;
  }
  const tmp = path.join(dir, `.connectors.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, connectorsFilePath(productRoot));
  return next;
}

function isOptionalConnectorEnabled(productRoot, name) {
  const cfg = readConnectors(productRoot);
  const c = cfg.connectors[name];
  if (!c) return false;
  return !!c.enabled;
}

module.exports = {
  CONNECTOR_KEYS,
  connectorsFilePath,
  readConnectors,
  writeConnectors,
  isOptionalConnectorEnabled,
  defaultConnectors,
  connectorEnvHints,
  reconcileConnectorsWithEnvIfAllOptionalDisabled,
};
