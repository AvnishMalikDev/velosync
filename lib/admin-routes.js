/**
 * Admin configuration API (requireAdmin on all routes).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const multer = require('multer');
const authLocal = require('./auth-local');
const envPaths = require('./env-paths');
const brandingLib = require('./branding');
const connectorsConfig = require('./connectors-config');
const dataSyncJob = require('./data-sync-job');
const dashboardScoring = require('./dashboard-scoring');

const ENV_KEY_ORDER = [
  'AUTH_MODE',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID',
  'PUBLIC_BASE_URL',
  'REDIRECT_URI',
  'POST_LOGOUT_REDIRECT_URI',
  'SESSION_SECRET',
  'PORT',
  'USE_HTTPS',
  'SSL_KEY_PATH',
  'SSL_CERT_PATH',
  'OPENROUTER_API_KEY',
  'ALLOW_INSECURE_TLS',
  'JIRA_EMAIL',
  'JIRA_TOKEN',
  'JIRA_DOMAIN',
  'GITHUB_TOKEN',
  'ORG',
  'ENT',
  'CURSOR_TOKEN',
  'TESTRAIL_DOMAIN',
  'TESTRAIL_EMAIL',
  'TESTRAIL_API_KEY',
  'JIRA_WORK_CLASSIFICATION_FIELD_ID',
  'JIRA_ACTUAL_STORY_POINTS_FIELD_ID',
  'JIRA_QA_POINTS_FIELD_ID',
  'JIRA_QA_ASSIGNEE_FIELD_ID',
  'ALLOW_LOCAL_LOGIN',
  /** Optional: PM2 process name for docs / tooling (e.g. velosync-web). */
  'PM2_WEB_PROCESS_NAME',
];

/** Default PM2 app name for the web server (browser restart + docs). */
const DEFAULT_PM2_WEB_PROCESS_NAME = 'velosync-web';

function isSecretEnvKey(key) {
  const k = String(key || '').toUpperCase();
  if (k.includes('TOKEN')) return true;
  if (k.includes('SECRET')) return true;
  if (k.includes('PASSWORD')) return true;
  if (k.endsWith('_KEY')) return true;
  return false;
}

/** Path for API/UI: relative to Product install (portable), forward slashes. */
function pathRelativeToProduct(productRoot, absolutePath) {
  const rel = path.relative(productRoot, absolutePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return path.basename(path.dirname(absolutePath)) + '/' + path.basename(absolutePath);
  }
  return rel.split(path.sep).join('/');
}

function escapeEnvValue(val) {
  if (val == null) return '';
  const s = String(val);
  if (s === '') return '';
  if (/[\r\n#"']/.test(s) || /^\s/.test(s) || /\s$/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
  }
  return s;
}

function parseEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    return require('dotenv').parse(raw);
  } catch (e) {
    console.error('[admin env] parse failed:', e.message);
    return {};
  }
}

/** Merge file env for Admin read/write: legacy jira-md-export/.env then Product/.env (Product wins). */
function parseEnvMergedForAdmin(productRoot) {
  const jira = parseEnvFile(envPaths.getJiraExportEnvPath(productRoot));
  const product = parseEnvFile(envPaths.getCanonicalEnvPath(productRoot));
  return { ...jira, ...product };
}

/** Effective env for connectivity checks: shell, then jira-md-export/.env, then Product/.env (Product wins). */
function getMergedEnvForAdmin(productRoot) {
  const canonicalPath = envPaths.getCanonicalEnvPath(productRoot);
  const legacyPath = envPaths.getJiraExportEnvPath(productRoot);
  const canonical = parseEnvFile(canonicalPath);
  const legacy = fs.existsSync(legacyPath) && legacyPath !== canonicalPath ? parseEnvFile(legacyPath) : {};
  return { ...process.env, ...legacy, ...canonical };
}

function sessionSecretConfiguredInFile(fileEnv) {
  const secret = String(fileEnv.SESSION_SECRET || '').trim();
  if (secret.length < 16) return false;
  // Reject obvious template/placeholder values shipped with the repo.
  const looksLikePlaceholder =
    /^your-/i.test(secret) ||
    /^placeholder/i.test(secret) ||
    /^change-me/i.test(secret) ||
    secret === 'change-me-in-production' ||
    secret === 'your-session-secret-change-in-production';
  return !looksLikePlaceholder;
}

/**
 * Incomplete Platform & SSO (session, Azure, public URLs). Uses the same env merge as runtime
 * (process.env + optional jira-md-export/.env + Product/.env) so PM2/host-injected secrets count.
 */
function evaluatePlatformSetup(fileEnv) {
  const reasons = [];
  const authMode =
    String(fileEnv.AUTH_MODE || '').trim().toLowerCase() === 'azure' ? 'azure' : 'local';
  const sessionOk = sessionSecretConfiguredInFile(fileEnv);
  if (!sessionOk) {
    reasons.push('Set SESSION_SECRET (16+ characters; not the placeholder change-me-in-production).');
  }
  const pub = String(fileEnv.PUBLIC_BASE_URL || '').trim();
  const redir = String(fileEnv.REDIRECT_URI || '').trim();
  // Mirror server.js runtime: when REDIRECT_URI is blank, it is derived from PUBLIC_BASE_URL
  // (PUBLIC_BASE_URL + /auth/callback). Treat URLs as OK whenever PUBLIC_BASE_URL is set.
  const urlsOk = !!pub || !!redir;
  let needsPlatformSetup = !sessionOk;

  if (authMode === 'azure') {
    if (!authLocal.isAzureEntraConfiguredFromEnv(fileEnv)) {
      needsPlatformSetup = true;
      reasons.push('Add Azure AD app values: AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET.');
    }
    if (!urlsOk) {
      needsPlatformSetup = true;
      reasons.push('Set PUBLIC_BASE_URL (REDIRECT_URI is derived from it when blank — must match the Entra app registration).');
    }
  } else if (!urlsOk) {
    reasons.push('Recommended: set PUBLIC_BASE_URL for consistent links and future SSO.');
  }

  const dedup = [...new Set(reasons)];
  return { needsPlatformSetup, platformSetupReasons: dedup, authMode, sessionOk, urlsOk };
}

/** Hostname only for Jira Cloud/Data Center API base URL (strip scheme, path, port). */
function normalizeJiraHost(domain) {
  if (domain == null) return '';
  let s = String(domain).trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '');
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.substring(0, slash);
  s = s.replace(/:\d+$/, '').trim();
  return s;
}

function tlsHintSuffix(merged) {
  if (allowInsecureTlsFromMerged(merged)) return '';
  return ' If this is a corporate TLS/proxy issue, set ALLOW_INSECURE_TLS=1 in .env and restart.';
}

function allowInsecureTlsFromMerged(merged) {
  const v = merged && merged.ALLOW_INSECURE_TLS;
  return v === '1' || String(v || '').toLowerCase() === 'true';
}

function writeEnvFile(envPath, merged) {
  const lines = [];
  const used = new Set();
  for (const key of ENV_KEY_ORDER) {
    if (Object.prototype.hasOwnProperty.call(merged, key) && merged[key] != null && merged[key] !== '') {
      lines.push(`${key}=${escapeEnvValue(merged[key])}`);
      used.add(key);
    }
  }
  for (const key of Object.keys(merged).sort()) {
    if (used.has(key)) continue;
    if (merged[key] == null || merged[key] === '') continue;
    lines.push(`${key}=${escapeEnvValue(merged[key])}`);
  }
  const dir = path.dirname(envPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.env.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf8');
  fs.renameSync(tmp, envPath);
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.json.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function httpsGetJson(urlStr, headers = {}, agent) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers,
    };
    if (agent) opts.agent = agent;
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (_) {
          data = { raw: text };
        }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function httpsGetInsecure(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers,
      agent: insecureAgent,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function assertValidSslPemBuffers(keyBuf, certBuf) {
  const keyStr = keyBuf.toString('utf8');
  const certStr = certBuf.toString('utf8');
  const hasKey =
    keyStr.includes('-----BEGIN PRIVATE KEY-----') ||
    keyStr.includes('-----BEGIN RSA PRIVATE KEY-----') ||
    keyStr.includes('-----BEGIN EC PRIVATE KEY-----');
  const hasCert = certStr.includes('-----BEGIN CERTIFICATE-----');
  if (!hasKey) throw new Error('Key file is not a PEM private key');
  if (!hasCert) throw new Error('Certificate must be PEM X.509 (-----BEGIN CERTIFICATE-----)');
}

function registerAdminRoutes(app, { productRoot, RBAC_PATH, requireAdmin, loadJiraCredsFromFile }) {
  const sslUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(productRoot, 'ssl');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        cb(null, file.fieldname === 'key' ? 'server.key' : 'server.crt');
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  const brandingUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const { uploads } = brandingLib.brandingPaths(productRoot);
        fs.mkdirSync(uploads, { recursive: true });
        cb(null, uploads);
      },
      filename: (req, file, cb) => {
        const ext0 = path.extname(file.originalname || '').toLowerCase();
        const allowed = ['.ico', '.png', '.webp', '.svg', '.jpg', '.jpeg', '.gif'];
        const ext = allowed.includes(ext0) ? ext0 : '.bin';
        const kind = req.query.kind === 'favicon' ? 'favicon' : 'logo';
        cb(null, `${kind}-${Date.now()}${ext}`);
      },
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
  });

  const envPath = envPaths.getCanonicalEnvPath(productRoot);
  const projectsPath = path.join(productRoot, 'jira-md-export', 'projects.json');
  const projectsTemplatePath = path.join(productRoot, 'jira-md-export', 'Template', 'projects.template.json');

  function afterExportDepsChanged(reason) {
    try {
      const r = dataSyncJob.restartDataSyncJob(productRoot, reason);
      if (!r.ok && !r.skipped) {
        console.warn('[data-sync-job]', r.message);
      }
    } catch (e) {
      console.warn('[data-sync-job]', e.message);
    }
  }

  app.get('/api/admin/config/data-sync-job', requireAdmin, (req, res) => {
    try {
      const cfg = dataSyncJob.readConfig(productRoot);
      const v = dataSyncJob.runPm2(['-v']);
      res.json({
        ...cfg,
        pm2OnPath: v.ok,
        pm2Version: v.ok ? v.stdout : null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/config/data-sync-job', requireAdmin, (req, res) => {
    try {
      const next = dataSyncJob.writeConfig(productRoot, req.body || {});
      const pm2Result = dataSyncJob.applyPm2Schedule(productRoot);
      res.json({ config: next, pm2: pm2Result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/admin/data-sync-job/restart', requireAdmin, (req, res) => {
    const r = dataSyncJob.restartDataSyncJob(productRoot, 'manual');
    res.json(r);
  });

  app.get('/api/admin/setup-status', requireAdmin, async (req, res) => {
    try {
      connectorsConfig.reconcileConnectorsWithEnvIfAllOptionalDisabled(productRoot);
    } catch (_) {}
    const merged = getMergedEnvForAdmin(productRoot);
    const platform = evaluatePlatformSetup(merged);
    const jiraHost = normalizeJiraHost(merged.JIRA_DOMAIN);
    const jiraConfigured = !!(merged.JIRA_EMAIL && merged.JIRA_TOKEN && jiraHost);
    let jiraOk = false;
    if (jiraConfigured) {
      try {
        const auth = Buffer.from(`${merged.JIRA_EMAIL}:${merged.JIRA_TOKEN}`).toString('base64');
        const tlsAgent = allowInsecureTlsFromMerged(merged) ? insecureAgent : undefined;
        const r = await httpsGetJson(
          `https://${jiraHost}/rest/api/3/myself`,
          { Authorization: `Basic ${auth}`, Accept: 'application/json' },
          tlsAgent,
        );
        jiraOk = r.status >= 200 && r.status < 300;
      } catch (_) {
        jiraOk = false;
      }
    }
    // Mandatory (per product requirement): JIRA credentials + OpenRouter API key.
    // All other connectors (GitHub, Copilot, Cursor, Confluence, TestRail, …) are optional
    // and must NOT gate the dashboard. Probe failures are surfaced (jiraOk) but do not
    // force a redirect — transient network/TLS issues shouldn't bounce the operator.
    const openRouterKey = String(merged.OPENROUTER_API_KEY || '').trim();
    const openRouterPlaceholder = /^(your-|sk-or-xxx|placeholder|change-me)/i.test(openRouterKey);
    const openRouterConfigured = !!openRouterKey && !openRouterPlaceholder;
    const connectorsFileExists = fs.existsSync(connectorsConfig.connectorsFilePath(productRoot));
    const pm2Web = String(merged.PM2_WEB_PROCESS_NAME || DEFAULT_PM2_WEB_PROCESS_NAME).trim();
    res.json({
      jiraOk,
      jiraConfigured,
      needsJiraSetup: !jiraConfigured,
      openRouterConfigured,
      needsOpenRouterSetup: !openRouterConfigured,
      needsPlatformSetup: platform.needsPlatformSetup,
      platformSetupReasons: platform.platformSetupReasons,
      platformAuthMode: platform.authMode,
      pm2OnPath: dataSyncJob.pm2Available(),
      pm2WebProcessConfigured: !!pm2Web,
      connectorsFileExists,
      connectors: connectorsConfig.readConnectors(productRoot).connectors,
    });
  });

  /**
   * Restart this Node web process via PM2 (requires app to be started under PM2 with the same name).
   * Fire-and-forget: the connection may drop before the JSON body arrives.
   */
  app.post('/api/admin/server/restart', requireAdmin, (req, res) => {
    const merged = getMergedEnvForAdmin(productRoot);
    const raw = String(merged.PM2_WEB_PROCESS_NAME || DEFAULT_PM2_WEB_PROCESS_NAME).trim();
    const name = raw.replace(/[^a-zA-Z0-9-_]/g, '');
    if (!name) {
      return res.status(400).json({
        ok: false,
        error:
          'PM2_WEB_PROCESS_NAME must be a non-empty name (default is velosync-web). Save platform .env if you changed it.',
      });
    }
    if (raw !== name) {
      return res.status(400).json({
        ok: false,
        error: 'PM2_WEB_PROCESS_NAME may only contain letters, numbers, hyphens, and underscores.',
      });
    }
    if (!dataSyncJob.pm2Available()) {
      return res.status(400).json({
        ok: false,
        error:
          'PM2 is not available on PATH. Install: npm i -g pm2. Start the dashboard with PM2 so restarts work (e.g. pm2 start server.js --name velosync-web).',
      });
    }
    try {
      const opts = {
        detached: true,
        stdio: 'ignore',
        cwd: productRoot,
        shell: false,
      };
      const child = spawn(dataSyncJob.pm2Executable(), ['restart', name], opts);
      child.unref();
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Failed to spawn pm2' });
    }
    res.json({
      ok: true,
      message:
        'PM2 restart issued. This page may stop responding — wait a few seconds and refresh. If the site does not return, run pm2 logs on the server.',
    });
  });

  app.get('/api/admin/config/connectors', requireAdmin, (req, res) => {
    try {
      connectorsConfig.reconcileConnectorsWithEnvIfAllOptionalDisabled(productRoot);
      res.json(connectorsConfig.readConnectors(productRoot));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/config/connectors', requireAdmin, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const next = connectorsConfig.writeConnectors(productRoot, {
        version: body.version,
        connectors: body.connectors,
      });
      res.json(next);
      afterExportDepsChanged('connectors updated');
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post(
    '/api/admin/config/ssl/upload',
    requireAdmin,
    sslUpload.fields([
      { name: 'cert', maxCount: 1 },
      { name: 'key', maxCount: 1 },
    ]),
    (req, res) => {
      const certF = req.files && req.files.cert && req.files.cert[0];
      const keyF = req.files && req.files.key && req.files.key[0];
      if (!certF || !keyF) {
        return res.status(400).json({ error: 'Upload both cert and key (multipart fields: cert, key)' });
      }
      try {
        const keyBuf = fs.readFileSync(keyF.path);
        const certBuf = fs.readFileSync(certF.path);
        assertValidSslPemBuffers(keyBuf, certBuf);
      } catch (e) {
        return res.status(400).json({ error: e.message || 'Invalid PEM' });
      }
      const merged = parseEnvMergedForAdmin(productRoot);
      merged.USE_HTTPS = '1';
      merged.SSL_KEY_PATH = 'ssl/server.key';
      merged.SSL_CERT_PATH = 'ssl/server.crt';
      try {
        writeEnvFile(envPath, merged);
        res.json({
          ok: true,
          message:
            'SSL certificate and key saved; .env updated (USE_HTTPS=1). Restart the Node process to serve HTTPS.',
        });
        afterExportDepsChanged('ssl env updated');
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  app.get('/api/admin/config/env', requireAdmin, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const revealSecrets =
      req.query.revealSecrets === '1' || String(req.query.revealSecrets || '').toLowerCase() === 'true';
    const merged = parseEnvMergedForAdmin(productRoot);
    const out = {};
    for (const key of ENV_KEY_ORDER) {
      if (!Object.prototype.hasOwnProperty.call(merged, key)) {
        out[key] = isSecretEnvKey(key) ? (revealSecrets ? '' : { set: false }) : '';
        continue;
      }
      const v = merged[key];
      if (isSecretEnvKey(key)) {
        if (revealSecrets) {
          out[key] = v != null ? String(v) : '';
        } else {
          out[key] = { set: Boolean(v && String(v).trim() !== '') };
        }
      } else {
        out[key] = v != null ? String(v) : '';
      }
    }
    res.json({
      keys: out,
      envPath: pathRelativeToProduct(productRoot, envPath),
    });
  });

  app.patch('/api/admin/config/env', requireAdmin, (req, res) => {
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    const merged = parseEnvMergedForAdmin(productRoot);
    for (const [k, v] of Object.entries(patch)) {
      if (!/^[A-Z0-9_]+$/.test(k)) continue;
      if (v === null || v === undefined || v === '') {
        delete merged[k];
        continue;
      }
      if (typeof v === 'object' && v !== null && Object.prototype.hasOwnProperty.call(v, 'value')) {
        merged[k] = String(v.value);
      } else {
        merged[k] = String(v);
      }
    }
    try {
      writeEnvFile(envPath, merged);
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true });
      afterExportDepsChanged('env updated');
    } catch (e) {
      console.error('[admin env]', e);
      res.status(500).json({ error: e.message || 'Write failed' });
    }
  });

  app.post('/api/admin/config/env/test', requireAdmin, async (req, res) => {
    try {
      connectorsConfig.reconcileConnectorsWithEnvIfAllOptionalDisabled(productRoot);
    } catch (_) {}
    const merged = getMergedEnvForAdmin(productRoot);
    const results = [];
    const flags = connectorsConfig.readConnectors(productRoot).connectors || {};
    const on = (name) => !!(flags[name] && flags[name].enabled === true);

    const jiraEmail = merged.JIRA_EMAIL;
    const jiraToken = merged.JIRA_TOKEN;
    const jiraHost = normalizeJiraHost(merged.JIRA_DOMAIN);
    const tlsAgent = allowInsecureTlsFromMerged(merged) ? insecureAgent : undefined;
    if (jiraEmail && jiraToken && jiraHost) {
      try {
        const auth = Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');
        const r = await httpsGetJson(
          `https://${jiraHost}/rest/api/3/myself`,
          { Authorization: `Basic ${auth}`, Accept: 'application/json' },
          tlsAgent,
        );
        const display = r.status >= 200 && r.status < 300 ? r.data && r.data.displayName : null;
        results.push({
          service: 'jira',
          ok: r.status >= 200 && r.status < 300,
          message:
            r.status >= 200 && r.status < 300 ? `Connected as ${display || 'ok'}` : `HTTP ${r.status}`,
        });
      } catch (e) {
        results.push({ service: 'jira', ok: false, message: e.message });
      }
    } else {
      results.push({ service: 'jira', ok: false, message: 'JIRA_EMAIL, JIRA_TOKEN, or JIRA_DOMAIN missing' });
    }

    if (on('confluence') && jiraEmail && jiraToken && jiraHost) {
      try {
        const auth = Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');
        const r = await httpsGetJson(
          `https://${jiraHost}/wiki/rest/api/user/current`,
          { Authorization: `Basic ${auth}`, Accept: 'application/json' },
          tlsAgent,
        );
        results.push({
          service: 'confluence',
          ok: r.status >= 200 && r.status < 300,
          message:
            r.status >= 200 && r.status < 300
              ? 'Confluence API reachable with Jira token'
              : `HTTP ${r.status} (may lack Confluence license/access)`,
        });
      } catch (e) {
        results.push({ service: 'confluence', ok: false, message: e.message });
      }
    } else if (!on('confluence')) {
      results.push({ service: 'confluence', ok: true, message: 'Skipped (disabled under Connectors)' });
    } else {
      results.push({ service: 'confluence', ok: false, message: 'Configure Jira first (same token is used for Confluence)' });
    }

    const gh = merged.GITHUB_TOKEN;
    const org = merged.ORG;
    if (!on('github')) {
      results.push({ service: 'github', ok: true, message: 'Skipped (disabled under Connectors)' });
    } else if (gh) {
      try {
        const headers = {
          Authorization: `Bearer ${gh}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        };
        const u = await fetch('https://api.github.com/user', { headers });
        const uj = u.ok ? await u.json() : {};
        let msg = u.ok ? `GitHub: ${uj.login || 'ok'}` : `HTTP ${u.status}`;
        if (org && u.ok) {
          const o = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}`, { headers });
          msg += o.ok ? ` · org ${org}` : ` · org check ${o.status}`;
        }
        results.push({ service: 'github', ok: u.ok, message: msg });
      } catch (e) {
        results.push({ service: 'github', ok: false, message: e.message });
      }
    } else {
      results.push({ service: 'github', ok: false, message: 'GITHUB_TOKEN not set' });
    }

    const ent = merged.ENT;
    if (!on('copilot')) {
      results.push({ service: 'copilot', ok: true, message: 'Skipped (disabled under Connectors)' });
    } else if (gh && ent) {
      try {
        const url = `https://api.github.com/enterprises/${encodeURIComponent(ent)}/copilot/metrics/reports/enterprise-28-day/latest`;
        const r = await fetch(url, {
          headers: {
            Authorization: `Bearer ${gh}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        results.push({
          service: 'copilot',
          ok: r.ok || r.status === 404,
          message: r.ok
            ? 'Copilot enterprise report reachable'
            : r.status === 404
              ? `HTTP 404 — check ENT slug or Copilot metrics availability (${r.status})`
              : `HTTP ${r.status}`,
        });
      } catch (e) {
        results.push({ service: 'copilot', ok: false, message: e.message });
      }
    } else {
      results.push({ service: 'copilot', ok: false, message: 'GITHUB_TOKEN and ENT required for Copilot' });
    }

    const cursorTok = merged.CURSOR_TOKEN;
    if (!on('cursor')) {
      results.push({ service: 'cursor', ok: true, message: 'Skipped (disabled under Connectors)' });
    } else if (cursorTok && !String(cursorTok).startsWith('your-')) {
      try {
        const enc = Buffer.from(`${cursorTok}:`).toString('base64');
        const r = await httpsGetInsecure('https://api.cursor.com/analytics/team/leaderboard?startDate=30d&endDate=now', {
          Authorization: `Basic ${enc}`,
          Accept: 'application/json',
        });
        results.push({
          service: 'cursor',
          ok: r.status >= 200 && r.status < 300,
          message: r.status >= 200 && r.status < 300 ? 'Cursor API reachable' : `HTTP ${r.status}`,
        });
      } catch (e) {
        results.push({ service: 'cursor', ok: false, message: e.message });
      }
    } else {
      results.push({ service: 'cursor', ok: false, message: 'CURSOR_TOKEN not set' });
    }

    const orKey = merged.OPENROUTER_API_KEY;
    if (!on('openrouter')) {
      results.push({ service: 'openrouter', ok: true, message: 'Skipped (disabled under Connectors)' });
    } else if (orKey && !String(orKey).startsWith('your-')) {
      try {
        const r = await httpsGetJson(
          'https://openrouter.ai/api/v1/models',
          {
            Authorization: `Bearer ${orKey.trim()}`,
          },
          tlsAgent,
        );
        results.push({
          service: 'openrouter',
          ok: r.status >= 200 && r.status < 300,
          message: r.status >= 200 && r.status < 300 ? 'API reachable' : `HTTP ${r.status}`,
        });
      } catch (e) {
        const msg = e.message || String(e);
        const tlsish = /certificate|TLS|SSL|UNABLE_TO_GET_ISSUER/i.test(msg);
        results.push({
          service: 'openrouter',
          ok: false,
          message: tlsish ? `${msg}${tlsHintSuffix(merged)}` : msg,
        });
      }
    } else {
      results.push({ service: 'openrouter', ok: false, message: 'OPENROUTER_API_KEY not set' });
    }

    const trD = merged.TESTRAIL_DOMAIN;
    const trE = merged.TESTRAIL_EMAIL;
    const trK = merged.TESTRAIL_API_KEY;
    if (!on('testrail')) {
      results.push({ service: 'testrail', ok: true, message: 'Skipped (disabled under Connectors)' });
    } else if (trD && trE && trK) {
      try {
        const auth = Buffer.from(`${trE}:${trK}`).toString('base64');
        const host = normalizeJiraHost(trD);
        if (!host) {
          results.push({ service: 'testrail', ok: false, message: 'TESTRAIL_DOMAIN is empty or invalid' });
        } else {
          const url = `https://${host}/index.php?/api/v2/get_projects`;
          const r = await httpsGetJson(
            url,
            { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
            tlsAgent,
          );
          results.push({
            service: 'testrail',
            ok: r.status >= 200 && r.status < 300,
            message:
              r.status >= 200 && r.status < 300 ? 'TestRail API ok' : `HTTP ${r.status}`,
          });
        }
      } catch (e) {
        const msg = e.message || String(e);
        const tlsish = /certificate|TLS|SSL|UNABLE_TO_GET_ISSUER/i.test(msg);
        results.push({
          service: 'testrail',
          ok: false,
          message: tlsish ? `${msg}${tlsHintSuffix(merged)}` : msg,
        });
      }
    } else {
      results.push({ service: 'testrail', ok: false, message: 'TestRail env incomplete' });
    }

    res.json({ results });
  });

  function ensureProjectsFile() {
    if (fs.existsSync(projectsPath)) return;
    let template = { projects: [] };
    if (fs.existsSync(projectsTemplatePath)) {
      try {
        template = JSON.parse(fs.readFileSync(projectsTemplatePath, 'utf8'));
      } catch (_) {
        template = { projects: [] };
      }
    }
    atomicWriteJson(projectsPath, template);
  }

  app.get('/api/admin/config/projects', requireAdmin, (req, res) => {
    try {
      ensureProjectsFile();
      const data = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/config/projects', requireAdmin, (req, res) => {
    const body = req.body;
    if (!body || !Array.isArray(body.projects)) {
      return res.status(400).json({ error: 'Body must include projects array' });
    }
    for (const p of body.projects) {
      if (!p || typeof p.key !== 'string' || !p.key.trim()) {
        return res.status(400).json({ error: 'Each project needs a key' });
      }
    }
    try {
      atomicWriteJson(projectsPath, body);
      res.json({ ok: true });
      afterExportDepsChanged('projects.json updated');
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/config/projects/test', requireAdmin, async (req, res) => {
    const creds = loadJiraCredsFromFile();
    if (!creds || !creds.email || !creds.token || !creds.domain) {
      return res.status(503).json({ ok: false, message: 'JIRA credentials not configured' });
    }
    const boardId = req.body?.boardId;
    const projectKey = String(req.body?.key || '').trim().toUpperCase();
    if (boardId == null || !projectKey) {
      return res.status(400).json({ ok: false, message: 'key and boardId required' });
    }
    const auth = Buffer.from(`${creds.email}:${creds.token}`).toString('base64');
    try {
      const boardUrl = `https://${creds.domain}/rest/agile/1.0/board/${encodeURIComponent(boardId)}`;
      const br = await fetch(boardUrl, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      });
      if (!br.ok) {
        const t = await br.text();
        return res.json({ ok: false, message: `Board HTTP ${br.status}: ${t.slice(0, 200)}` });
      }
      const pjUrl = `https://${creds.domain}/rest/api/3/project/${encodeURIComponent(projectKey)}`;
      const pr = await fetch(pjUrl, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      });
      res.json({
        ok: pr.ok,
        message: pr.ok ? `Board ${boardId} and project ${projectKey} reachable` : `Project HTTP ${pr.status}`,
      });
    } catch (e) {
      res.json({ ok: false, message: e.message });
    }
  });

  app.get('/api/admin/config/rbac', requireAdmin, (req, res) => {
    const rbac = authLocal.readRbacJson(RBAC_PATH) || {
      version: 1,
      defaultRole: 'viewer',
      roles: { admin: [] },
      localUsers: [],
    };
    if (!Array.isArray(rbac.localUsers)) rbac.localUsers = [];
    res.json(authLocal.sanitizeRbacForResponse(rbac));
  });

  app.put('/api/admin/config/rbac', requireAdmin, (req, res) => {
    if (authLocal.getAuthMode() === 'local') {
      return res.status(400).json({
        error: 'In AUTH_MODE=local, use /api/admin/local-users to manage accounts; roles.admin is synced from admins.',
      });
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || !Array.isArray(body.roles?.admin)) {
      return res.status(400).json({ error: 'Invalid body: need roles.admin array' });
    }
    const admins = body.roles.admin.map((s) => String(s).trim()).filter(Boolean);
    if (admins.length === 0) {
      return res.status(400).json({ error: 'At least one admin name required' });
    }
    const prev = authLocal.readRbacJson(RBAC_PATH) || {};
    const next = {
      version: Number(body.version) || prev.version || 1,
      defaultRole: String(body.defaultRole || prev.defaultRole || 'viewer'),
      roles: { admin: admins },
    };
    if (Array.isArray(prev.localUsers)) next.localUsers = prev.localUsers;
    try {
      authLocal.writeRbacAtomic(RBAC_PATH, next);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/admin/config/branding', requireAdmin, (req, res) => {
    res.json(brandingLib.readBrandingConfig(productRoot));
  });

  app.get('/api/admin/config/dashboard-scoring', requireAdmin, (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const liveAbs = dashboardScoring.livePath(productRoot);
      res.json({
        config: dashboardScoring.readDashboardScoring(productRoot),
        templatePath: dashboardScoring.pathRelativeToProduct(productRoot, dashboardScoring.templatePath(productRoot)),
        livePath: dashboardScoring.pathRelativeToProduct(productRoot, liveAbs),
        liveExists: fs.existsSync(liveAbs),
        liveOverrideActive: dashboardScoring.liveOverridesActive(productRoot),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/config/dashboard-scoring', requireAdmin, (req, res) => {
    try {
      const next = dashboardScoring.writeDashboardScoring(productRoot, req.body || {});
      res.json({ ok: true, config: next });
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  });

  app.put('/api/admin/config/branding', requireAdmin, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const cur = brandingLib.readBrandingConfig(productRoot);
    const next = {
      siteTitle: body.siteTitle != null ? String(body.siteTitle) : cur.siteTitle,
      headerTagline: body.headerTagline != null ? String(body.headerTagline) : cur.headerTagline,
      faviconUrl: body.faviconUrl != null ? String(body.faviconUrl).trim() : cur.faviconUrl,
      logoUrl: body.logoUrl != null ? String(body.logoUrl).trim() : cur.logoUrl,
    };
    try {
      brandingLib.writeBrandingConfig(productRoot, next);
      res.json(next);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/config/branding/upload', requireAdmin, brandingUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file field required' });
    const kind = req.query.kind === 'favicon' ? 'favicon' : 'logo';
    const url = brandingLib.uploadPublicUrl(req.file.filename);
    if (!url) return res.status(500).json({ error: 'Invalid file' });
    const cur = brandingLib.readBrandingConfig(productRoot);
    if (kind === 'favicon') cur.faviconUrl = url;
    else cur.logoUrl = url;
    brandingLib.writeBrandingConfig(productRoot, cur);
    res.json({ ok: true, kind, url, config: cur });
  });

  app.post('/api/admin/local-users', requireAdmin, (req, res) => {
    if (!authLocal.allowLocalSignIn()) {
      return res.status(400).json({ error: 'Local user API requires local sign-in to be allowed' });
    }
    const { username, password, role, displayName } = req.body || {};
    const u = authLocal.normalizeUsername(username);
    if (!u || !password || String(password).length < 4) {
      return res.status(400).json({ error: 'username and password (min 4 chars) required' });
    }
    const r = role === 'admin' ? 'admin' : 'viewer';
    const rbac = authLocal.readRbacJson(RBAC_PATH) || { version: 2, defaultRole: 'viewer', roles: { admin: [] }, localUsers: [] };
    if (!Array.isArray(rbac.localUsers)) rbac.localUsers = [];
    if (authLocal.findLocalUser(rbac, u)) {
      return res.status(409).json({ error: 'User already exists' });
    }
    rbac.localUsers.push({
      username: u,
      passwordHash: authLocal.hashPassword(String(password)),
      role: r,
      displayName: String(displayName || u),
    });
    rbac.roles = rbac.roles || {};
    rbac.roles.admin = Array.isArray(rbac.roles.admin) ? rbac.roles.admin : [];
    if (r === 'admin' && !rbac.roles.admin.includes(u)) rbac.roles.admin.push(u);
    rbac.version = Math.max(Number(rbac.version) || 1, 2);
    try {
      authLocal.writeRbacAtomic(RBAC_PATH, rbac);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/admin/local-users/:username', requireAdmin, (req, res) => {
    if (!authLocal.allowLocalSignIn()) {
      return res.status(400).json({ error: 'Local user API requires AUTH_MODE=local or ALLOW_LOCAL_LOGIN=1' });
    }
    const target = authLocal.normalizeUsername(req.params.username);
    const rbac = authLocal.readRbacJson(RBAC_PATH);
    if (!rbac || !Array.isArray(rbac.localUsers)) return res.status(404).json({ error: 'Not found' });
    const user = authLocal.findLocalUser(rbac, target);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { role, displayName } = req.body || {};
    if (role === 'admin' || role === 'viewer') {
      if (role === 'viewer' && user.role === 'admin') {
        const otherAdmins = rbac.localUsers.filter(
          (x) => x !== user && x.role === 'admin'
        ).length;
        if (otherAdmins === 0) {
          return res.status(400).json({ error: 'Cannot remove last admin' });
        }
      }
      user.role = role;
      rbac.roles = rbac.roles || {};
      rbac.roles.admin = Array.isArray(rbac.roles.admin) ? rbac.roles.admin : [];
      if (role === 'admin' && !rbac.roles.admin.includes(user.username)) rbac.roles.admin.push(user.username);
      if (role === 'viewer') {
        rbac.roles.admin = rbac.roles.admin.filter(
          (x) => authLocal.normalizeUsername(x) !== authLocal.normalizeUsername(user.username)
        );
      }
    }
    if (displayName != null) user.displayName = String(displayName);
    try {
      authLocal.writeRbacAtomic(RBAC_PATH, rbac);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/admin/local-users/:username', requireAdmin, (req, res) => {
    if (!authLocal.allowLocalSignIn()) {
      return res.status(400).json({ error: 'Local user API requires AUTH_MODE=local or ALLOW_LOCAL_LOGIN=1' });
    }
    const target = authLocal.normalizeUsername(req.params.username);
    const sessionUser = authLocal.normalizeUsername(req.session.userProfile?.username);
    if (target === sessionUser) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const rbac = authLocal.readRbacJson(RBAC_PATH);
    if (!rbac || !Array.isArray(rbac.localUsers)) return res.status(404).json({ error: 'Not found' });
    const idx = rbac.localUsers.findIndex((x) => authLocal.normalizeUsername(x.username) === target);
    if (idx < 0) return res.status(404).json({ error: 'User not found' });
    const removed = rbac.localUsers[idx];
    if (removed.role === 'admin' && authLocal.countLocalAdmins(rbac) <= 1) {
      return res.status(400).json({ error: 'Cannot delete last admin' });
    }
    rbac.localUsers.splice(idx, 1);
    rbac.roles = rbac.roles || {};
    rbac.roles.admin = (rbac.roles.admin || []).filter((x) => authLocal.normalizeUsername(x) !== target);
    try {
      authLocal.writeRbacAtomic(RBAC_PATH, rbac);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/local-users/:username/reset-password', requireAdmin, (req, res) => {
    if (!authLocal.allowLocalSignIn()) {
      return res.status(400).json({ error: 'Local user API requires AUTH_MODE=local or ALLOW_LOCAL_LOGIN=1' });
    }
    const target = authLocal.normalizeUsername(req.params.username);
    const newPassword = req.body?.newPassword;
    if (!newPassword || String(newPassword).length < 4) {
      return res.status(400).json({ error: 'newPassword min 4 chars' });
    }
    const rbac = authLocal.readRbacJson(RBAC_PATH);
    const user = rbac && authLocal.findLocalUser(rbac, target);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.passwordHash = authLocal.hashPassword(String(newPassword));
    try {
      authLocal.writeRbacAtomic(RBAC_PATH, rbac);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerAdminRoutes, ENV_KEY_ORDER };
