/**
 * Express server. Default auth: local username/password (rbac.json).
 * Optional: AUTH_MODE=azure for Microsoft Entra ID SSO (authorization code + PKCE).
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const PRODUCT_ROOT = __dirname;
const PRODUCT_ENV_PATH = path.join(PRODUCT_ROOT, '.env');
const JIRA_EXPORT_ENV_PATH = path.join(PRODUCT_ROOT, 'jira-md-export', '.env');
let hadJiraEnv = fs.existsSync(JIRA_EXPORT_ENV_PATH);
let hadProductEnv = fs.existsSync(PRODUCT_ENV_PATH);

// Canonical: Product/.env. Migrate legacy jira-md-export-only installs once.
if (!hadProductEnv && hadJiraEnv) {
  try {
    fs.copyFileSync(JIRA_EXPORT_ENV_PATH, PRODUCT_ENV_PATH);
    console.log(
      '[env] Migrated jira-md-export/.env ? Product/.env (canonical). You may delete jira-md-export/.env after verifying exports.'
    );
    hadProductEnv = true;
  } catch (e) {
    console.warn('[env] Could not migrate to Product/.env:', e.message);
  }
}

// When both exist: legacy folder fills gaps, Product/.env wins (dashboard + ops single source of truth).
const jiraEnvExists = fs.existsSync(JIRA_EXPORT_ENV_PATH);
hadProductEnv = fs.existsSync(PRODUCT_ENV_PATH);
if (hadProductEnv && jiraEnvExists) {
  dotenv.config({ path: JIRA_EXPORT_ENV_PATH, override: false });
  dotenv.config({ path: PRODUCT_ENV_PATH, override: true });
} else if (hadProductEnv) {
  dotenv.config({ path: PRODUCT_ENV_PATH });
} else if (jiraEnvExists) {
  dotenv.config({ path: JIRA_EXPORT_ENV_PATH });
}

/**
 * Update specific keys in a .env file in place, preserving comments, blank lines, and
 * ordering of all other keys. Missing keys are appended at the end. Mirrors values into
 * process.env so the current boot uses them without a second restart.
 */
function applyEnvFileUpdates(targetEnvPath, updates) {
  if (!fs.existsSync(targetEnvPath) || !updates || !Object.keys(updates).length) return false;
  const raw = fs.readFileSync(targetEnvPath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const remaining = new Map(Object.entries(updates));
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && remaining.has(m[1])) {
      out.push(`${m[1]}=${remaining.get(m[1])}`);
      remaining.delete(m[1]);
    } else {
      out.push(line);
    }
  }
  if (remaining.size) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    for (const [k, v] of remaining) out.push(`${k}=${v}`);
    if (out[out.length - 1] !== '') out.push('');
  }
  fs.writeFileSync(targetEnvPath, out.join(eol), 'utf8');
  Object.assign(process.env, updates);
  return true;
}

function pickTargetEnvPath() {
  if (fs.existsSync(PRODUCT_ENV_PATH)) return PRODUCT_ENV_PATH;
  if (fs.existsSync(JIRA_EXPORT_ENV_PATH)) return JIRA_EXPORT_ENV_PATH;
  return PRODUCT_ENV_PATH;
}

function isPlaceholder(s) {
  return /^your-/i.test(s) || /^placeholder/i.test(s) || /^xxx/i.test(s) || /^change-me/i.test(s);
}

// First-run auto-promotion: when all three Entra fields are present and AUTH_MODE
// hasn't been explicitly set to "azure", promote to Azure SSO and enable
// ALLOW_LOCAL_LOGIN=1 (hybrid) so operators keep a local break-glass path.
(function autoPromoteAuthModeWhenEntraComplete() {
  try {
    const id = String(process.env.AZURE_CLIENT_ID || '').trim();
    const secret = String(process.env.AZURE_CLIENT_SECRET || '').trim();
    const tenant = String(process.env.AZURE_TENANT_ID || '').trim();
    const entraValid = id && secret && tenant && !isPlaceholder(id) && !isPlaceholder(secret) && !isPlaceholder(tenant);
    if (!entraValid) return;

    const currentMode = String(process.env.AUTH_MODE || '').trim().toLowerCase();
    const currentAllowLocalRaw = process.env.ALLOW_LOCAL_LOGIN;
    const currentAllowLocal = currentAllowLocalRaw === undefined ? '' : String(currentAllowLocalRaw).trim();

    const updates = {};
    if (currentMode !== 'azure') updates.AUTH_MODE = 'azure';
    if (currentAllowLocal === '') updates.ALLOW_LOCAL_LOGIN = '1';
    if (!Object.keys(updates).length) return;

    const target = pickTargetEnvPath();
    if (!applyEnvFileUpdates(target, updates)) return;

    const parts = [];
    if (updates.AUTH_MODE) parts.push('AUTH_MODE=azure');
    if (updates.ALLOW_LOCAL_LOGIN) parts.push('ALLOW_LOCAL_LOGIN=1');
    console.log(`[env] Entra credentials detected — set ${parts.join(', ')} in ${path.basename(path.dirname(target))}/.env (hybrid SSO + local break-glass).`);
  } catch (e) {
    console.warn('[env] Auto-promote to Azure SSO failed:', e.message);
  }
})();

// First-run session secret: when SESSION_SECRET is missing/short/a known placeholder,
// generate a cryptographically strong value and persist it. Cookies signed with a strong
// secret are required for a secure production deployment.
(function autoGenerateSessionSecret() {
  try {
    const cur = String(process.env.SESSION_SECRET || '').trim();
    const needs = cur.length < 32 || isPlaceholder(cur) || cur === 'your-session-secret-change-in-production';
    if (!needs) return;
    const generated = require('crypto').randomBytes(48).toString('base64url');
    const target = pickTargetEnvPath();
    if (!applyEnvFileUpdates(target, { SESSION_SECRET: generated })) return;
    console.log(`[env] SESSION_SECRET was missing or a placeholder — generated a strong value and wrote it to ${path.basename(path.dirname(target))}/.env.`);
  } catch (e) {
    console.warn('[env] Auto-generate SESSION_SECRET failed:', e.message);
  }
})();

const https = require('https');
const express = require('express');
const session = require('express-session');
const msal = require('@azure/msal-node');

const PORT = process.env.PORT || 3000;
const RBAC_PATH = path.join(__dirname, 'rbac.json');
const authLocal = require('./lib/auth-local');
const envPaths = require('./lib/env-paths');
const brandingLib = require('./lib/branding');
const dashboardScoringLib = require('./lib/dashboard-scoring');
const { registerAdminRoutes } = require('./lib/admin-routes');

function normalizeName(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDistance(a, b) {
  const s = normalizeName(a);
  const t = normalizeName(b);
  const m = s.length;
  const n = t.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function tokenOverlapScore(a, b) {
  const aTokens = new Set(normalizeName(a).split(' ').filter(Boolean));
  const bTokens = new Set(normalizeName(b).split(' ').filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;
  let overlap = 0;
  aTokens.forEach((tok) => {
    if (bTokens.has(tok)) overlap += 1;
  });
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function nameSimilarityScore(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  const lev = 1 - (levenshteinDistance(na, nb) / Math.max(1, maxLen));
  const overlap = tokenOverlapScore(na, nb);
  return (0.65 * lev) + (0.35 * overlap);
}

function readRbacConfig() {
  try {
    if (!fs.existsSync(RBAC_PATH)) return null;
    const raw = fs.readFileSync(RBAC_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    console.error('[RBAC] Failed to read rbac.json:', err.message);
    return null;
  }
}

function accountNameCandidates(account = {}) {
  const candidates = new Set();
  const accountName = String(account.name || '').trim();
  const username = String(account.username || '').trim();
  if (accountName) candidates.add(accountName);
  if (username) {
    candidates.add(username);
    const local = username.split('@')[0];
    if (local) candidates.add(local.replace(/[._-]+/g, ' '));
  }
  return [...candidates].filter(Boolean);
}

function resolveroleForAccount(account) {
  const rbac = readRbacConfig();
  const defaultRole = rbac?.defaultRole || 'viewer';
  const admins = Array.isArray(rbac?.roles?.admin) ? rbac.roles.admin : [];
  if (!admins.length) return { role: defaultRole, matchedAdmin: null, score: 0 };

  const candidates = accountNameCandidates(account);
  let best = { admin: null, score: 0, source: null };
  candidates.forEach((candidate) => {
    admins.forEach((adminName) => {
      const score = nameSimilarityScore(candidate, adminName);
      if (score > best.score) best = { admin: adminName, score, source: candidate };
    });
  });

  const matchThreshold = 0.86;
  if (best.score >= matchThreshold) {
    return { role: 'admin', matchedAdmin: best.admin, score: best.score, source: best.source };
  }
  return { role: defaultRole, matchedAdmin: null, score: best.score, source: best.source };
}

/** Admin vs viewer for both Azure sessions and local username/password sessions. */
function getEffectiveRole(req) {
  if (!req.session || !req.session.isAuthenticated) return null;
  if (req.session.authType === 'local' && req.session.userProfile) {
    return req.session.userProfile.role === 'admin' ? 'admin' : 'viewer';
  }
  if (req.session.account) {
    return resolveroleForAccount(req.session.account).role;
  }
  return null;
}

const useHttps =
  process.env.USE_HTTPS === '1' ||
  process.env.USE_HTTPS === 'true';

function resolvesslPath(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.join(__dirname, p);
}

const sslKeyPath = resolvesslPath(process.env.SSL_KEY_PATH || 'key.pem');
const sslCertPath = resolvesslPath(process.env.SSL_CERT_PATH || 'cert.pem');

function assertValidSslPem(keyBuf, certBuf, keyFile, certFile) {
  const keyStr = keyBuf.toString('utf8');
  const certStr = certBuf.toString('utf8');
  const hasKey =
    keyStr.includes('-----BEGIN PRIVATE KEY-----') ||
    keyStr.includes('-----BEGIN RSA PRIVATE KEY-----') ||
    keyStr.includes('-----BEGIN EC PRIVATE KEY-----');
  const hasCert = certStr.includes('-----BEGIN CERTIFICATE-----');
  if (!hasKey) {
    console.error(`[HTTPS] ${keyFile} does not look like a PEM private key (expected -----BEGIN ... PRIVATE KEY-----).`);
    process.exit(1);
  }
  if (!hasCert) {
    console.error(`[HTTPS] ${certFile} is not an X.509 certificate PEM.`);
    console.error('    It must start with -----BEGIN CERTIFICATE-----.');
    console.error('    A raw public key (-----BEGIN PUBLIC KEY-----) will not work with https.createServer().');
    console.error('    Regenerate with: node gen-cert.js');
    process.exit(1);
  }
}

let sslOptions = null;
if (useHttps) {
  try {
    const keyBuf = fs.readFileSync(sslKeyPath);
    const certBuf = fs.readFileSync(sslCertPath);
    assertValidSslPem(keyBuf, certBuf, sslKeyPath, sslCertPath);
    sslOptions = { key: keyBuf, cert: certBuf };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') {
      console.error(`[HTTPS] Could not read SSL_KEY_PATH / SSL_CERT_PATH (${sslKeyPath}, ${sslCertPath}):`, err.message);
      process.exit(1);
    }
    throw err;
  }
}

function normalizePublicBase(url) {
  if (!url || typeof url !== 'string') return null;
  const t = url.trim();
  return t ? t.replace(/\/$/, '') : null;
}

const publicBase = normalizePublicBase(process.env.PUBLIC_BASE_URL);

const REDIRECT_URI =
  process.env.REDIRECT_URI ||
  (publicBase ? `${publicBase}/auth/callback` : `http://localhost:${PORT}/auth/callback`);
const POST_LOGOUT_REDIRECT_URI =
  process.env.POST_LOGOUT_REDIRECT_URI || publicBase || `http://localhost:${PORT}`;

if (publicBase) {
  const isHttpsUrl = publicBase.startsWith('https://');
  if (isHttpsUrl && !useHttps) {
    console.warn('[config] PUBLIC_BASE_URL uses https:// but USE_HTTPS is not enabled — Azure redirects and cookies may not match.');
  }
  if (useHttps && !isHttpsUrl) {
    console.warn('[config] USE_HTTPS is enabled — set PUBLIC_BASE_URL to https://… (and port 443 in .env if applicable).');
  }
}

// Validate required env (warn only so app can start with dummy values)
const required = ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID'];
required.forEach((key) => {
  if (!process.env[key] || process.env[key].startsWith('your-')) {
    console.warn(`[SSO] Missing or placeholder env: ${key}. Set real values in .env for Azure AD login.`);
  }
});

const msalConfig = {
  auth: {
    clientId: process.env.AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
  },
};

const app = express();

app.set('trust proxy', 1);
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-me-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: useHttps, maxAge: 24 * 60 * 60 * 1000 },
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

brandingLib.ensureBrandingDirs(__dirname);
app.use('/branding', express.static(path.join(__dirname, 'branding', 'uploads')));
/** Connector brand icons (copied from WebSite/public/integrations; served relative to Product install). */
app.use('/integrations', express.static(path.join(__dirname, 'public', 'integrations')));

/**
 * Ensure redirect URI is consistent (no trailing slash)
 */
function getRedirectUri() {
  return REDIRECT_URI.replace(/\/$/, '');
}

/**
 * Login page (local username/password or link to Microsoft — see login.html)
 */
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/api/auth/config', (req, res) => {
  const authMode = authLocal.getAuthMode();
  const msReady = authLocal.isAzureEntraConfigured();
  const localOptIn = authLocal.allowLocalLogin();
  const microsoftLoginAvailable = authMode === 'azure' && msReady;
  // If Azure mode but Entra is not configured yet, still offer local login so the app is usable (bootstrap).
  const localLoginAvailable = localOptIn || (authMode === 'azure' && !msReady);
  const rbac = authLocal.readRbacJson(RBAC_PATH);
  const hasLocalUsers = !!(rbac && Array.isArray(rbac.localUsers) && rbac.localUsers.length > 0);
  /** Microsoft Entra is not ready yet; user should use starter local admin, then finish Platform in Admin. */
  const firstTimeSetupWalkthrough = authMode === 'azure' && !msReady && localLoginAvailable;
  res.json({
    authMode,
    localLoginAvailable,
    microsoftLoginAvailable,
    entraNotConfiguredYet: authMode === 'azure' && !msReady,
    firstTimeSetupWalkthrough,
    hasLocalUsers,
    starterAdminUsername: authLocal.DEFAULT_LOCAL_BOOTSTRAP_USER,
    starterAdminPassword: authLocal.DEFAULT_LOCAL_BOOTSTRAP_PASS,
  });
});

/** Public branding (title, favicon, logo URLs) for dashboard and login */
app.get('/api/branding', (req, res) => {
  res.json(brandingLib.readBrandingConfig(__dirname));
});

/** Scoring weights & health-matrix bands (main + project detail dashboards) */
app.get('/api/dashboard-scoring', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json(dashboardScoringLib.readDashboardScoring(PRODUCT_ROOT));
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load scoring config' });
  }
});

const VERSION_HISTORY_PATH = path.join(__dirname, '..', 'Version History.md');
/** Release notes (Markdown) — repo root; public and readable without auth */
app.get('/whats-new', (req, res) => {
  res.type('text/markdown; charset=utf-8');
  res.sendFile(VERSION_HISTORY_PATH, (err) => {
    if (err) {
      console.error('[whats-new]', err.message);
      if (!res.headersSent) {
        res.status(404).type('text/plain; charset=utf-8').send('Version history file not found.');
      }
    }
  });
});

/**
 * Start Azure AD authorization (PKCE). Used when AUTH_MODE=azure.
 */
app.get('/auth/azure', (req, res, next) => {
  if (authLocal.getAuthMode() !== 'azure') {
    return res.redirect('/login');
  }
  const redirectUri = getRedirectUri();
  const cryptoProvider = new msal.CryptoProvider();
  const state = cryptoProvider.base64Encode(JSON.stringify({ successRedirect: '/' }));

  Promise.resolve()
    .then(() => cryptoProvider.generatePkceCodes())
    .then(({ verifier, challenge }) => {
      req.session.pkceVerifier = verifier;
      req.session.authState = state;

      const authCodeUrlParams = {
        scopes: ['openid', 'profile', 'User.Read'],
        redirectUri,
        state,
        responseMode: msal.ResponseMode.QUERY,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      };

      const cca = new msal.ConfidentialClientApplication(msalConfig);
      return cca.getAuthCodeUrl(authCodeUrlParams);
    })
    .then((url) => {
      req.session.save((err) => {
        if (err) return next(err);
        res.redirect(url);
      });
    })
    .catch((err) => next(err));
});

/**
 * Local username/password login (AUTH_MODE=local)
 */
app.post('/auth/local/login', (req, res) => {
  if (!authLocal.allowLocalSignIn()) {
    return res.status(400).json({ error: 'Local login not enabled' });
  }
  const username = authLocal.normalizeUsername(req.body?.username);
  const password = req.body?.password;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  const rbac = authLocal.readRbacJson(RBAC_PATH);
  const user = authLocal.findLocalUser(rbac, username);
  if (!user || !authLocal.verifyLocalPassword(user, password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.regenerate((err) => {
    if (err) {
      console.error('[auth/local] session regenerate', err);
      return res.status(500).json({ error: 'Session error' });
    }
    req.session.isAuthenticated = true;
    req.session.authType = 'local';
    req.session.userProfile = {
      username: user.username,
      name: user.displayName || user.username,
      role: user.role === 'admin' ? 'admin' : 'viewer',
    };
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'Session error' });
      res.json({ ok: true, role: req.session.userProfile.role });
    });
  });
});

/**
 * Callback: exchange authorization code for tokens
 */
app.get('/auth/callback', (req, res, next) => {
  const { code, state } = req.query;
  const redirectUri = getRedirectUri();

  if (!code) {
    return next(new Error('Authorization code missing in callback'));
  }
  if (!req.session.pkceVerifier) {
    console.error('[SSO] Callback: no pkceVerifier in session. User may have hit callback before session was saved, or cookie was lost. Fix: ensure only one server instance; try Sign in again.');
    return res.redirect('/login?error=session_expired');
  }

  const authCodeRequest = {
    code,
    redirectUri,
    scopes: ['openid', 'profile', 'User.Read'],
    codeVerifier: req.session.pkceVerifier,
  };

  const cca = new msal.ConfidentialClientApplication(msalConfig);
  cca
    .acquireTokenByCode(authCodeRequest)
    .then((response) => {
      req.session.account = response.account;
      req.session.idToken = response.idToken;
      req.session.accessToken = response.accessToken;
      req.session.isAuthenticated = true;
      req.session.authType = 'azure';
      delete req.session.userProfile;
      delete req.session.pkceVerifier;
      delete req.session.authState;

      let successRedirect = '/';
      if (state) {
        try {
          const decoded = Buffer.from(state, 'base64').toString('utf8');
          const parsed = JSON.parse(decoded);
          if (parsed.successRedirect) successRedirect = parsed.successRedirect;
        } catch (_) {}
      }
      res.redirect(successRedirect);
    })
    .catch((err) => {
      const errCode = err.errorCode || err.errorNo;
      if (errCode === 'invalid_client' || err.errorNo === 700025) {
        console.error('[SSO] 700025: App is registered as PUBLIC client. In Azure Portal add platform "Web" and set redirect URI. See AZURE-APP-SETUP.md');
      } else if (errCode === 'invalid_grant' || err.errorNo === 501481) {
        console.error('[SSO] 501481: Code_verifier mismatch. Usually: session lost (try one server only, then Sign in again from /login).');
      } else {
        console.error('[SSO] Auth callback error:', err.errorMessage || err.message);
      }
      res.redirect('/login?error=auth_failed');
    });
});

/**
 * Logout: local clears session; Azure also hits Entra logout.
 */
app.get('/logout', (req, res) => {
  const wasLocal = req.session && req.session.authType === 'local';
  req.session.destroy(() => {
    if (wasLocal) {
      return res.redirect('/login');
    }
    const postLogoutRedirectUri = encodeURIComponent(POST_LOGOUT_REDIRECT_URI || '/');
    const logoutUri = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=${postLogoutRedirectUri}`;
    res.redirect(logoutUri);
  });
});

/**
 * Optional: API to check auth status (for frontend)
 */
app.get('/api/me', (req, res) => {
  if (!req.session.isAuthenticated) {
    return res.status(401).json({ authenticated: false });
  }
  if (req.session.authType === 'local' && req.session.userProfile) {
    return res.json({
      authenticated: true,
      authType: 'local',
      username: req.session.userProfile.username,
      name: req.session.userProfile.name,
      role: req.session.userProfile.role,
      roleMatch: { matchedAdmin: null, score: 1, source: 'local' },
    });
  }
  if (!req.session.account) {
    return res.status(401).json({ authenticated: false });
  }
  const roleInfo = resolveroleForAccount(req.session.account);
  res.json({
    authenticated: true,
    authType: 'azure',
    username: req.session.account.username,
    name: req.session.account.name,
    role: roleInfo.role,
    roleMatch: {
      matchedAdmin: roleInfo.matchedAdmin,
      score: Number((roleInfo.score || 0).toFixed(3)),
      source: roleInfo.source || null,
    },
  });
});

/**
 * Protect dashboard routes: redirect to /login if not authenticated
 */
function requireAuth(req, res, next) {
  if (req.session.isAuthenticated) return next();
  const loginUrl = '/login';
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Unauthorized', loginUrl });
  }
  res.redirect(loginUrl);
}

function requireAdmin(req, res, next) {
  if (!req.session.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const role = getEffectiveRole(req);
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return next();
}

/** Local users only: change own password. */
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  if (authLocal.getAuthMode() !== 'local' || req.session.authType !== 'local') {
    return res.status(400).json({ error: 'Password change only for local accounts' });
  }
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'currentPassword and newPassword (min 8 chars) required' });
  }
  const un = authLocal.normalizeUsername(req.session.userProfile?.username);
  const rbac = authLocal.readRbacJson(RBAC_PATH);
  const user = rbac && authLocal.findLocalUser(rbac, un);
  if (!user || !authLocal.verifyLocalPassword(user, currentPassword)) {
    return res.status(401).json({ error: 'Current password incorrect' });
  }
  user.passwordHash = authLocal.hashPassword(String(newPassword));
  try {
    authLocal.writeRbacAtomic(RBAC_PATH, rbac);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Save failed' });
  }
});

/**
 * OpenRouter proxy: key stays on server; frontend sends body, we add Authorization and forward.
 */
function sendApiError(res, status, message) {
  res.status(status).json({ error: { message } });
}

/** HTTPS request to OpenRouter (supports corporate proxy / relaxed TLS via ALLOW_INSECURE_TLS=1). */
function openRouterFetch(body, key, referer) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const allowInsecure = process.env.ALLOW_INSECURE_TLS === '1' || process.env.ALLOW_INSECURE_TLS === 'true';
    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key.trim()}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': referer || 'https://localhost',
        'X-Title': 'VeloSync Intelligence Dashboard',
        'Content-Length': Buffer.byteLength(payload, 'utf8'),
      },
      ...(allowInsecure && { agent: new https.Agent({ rejectUnauthorized: false }) }),
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (ch) => { data += ch; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          reject(new Error('Invalid JSON from OpenRouter'));
        }
      });
    });
    req.on('error', reject);
    req.write(payload, 'utf8');
    req.end();
  });
}

async function openRouterProxy(req, res) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key === 'your-openrouter-api-key-here') {
    return sendApiError(res, 503, 'OpenRouter API key not configured. Set OPENROUTER_API_KEY in .env.');
  }
  try {
    const referer = req.get('origin') || req.get('referer') || 'https://localhost';
    const { status, data } = await openRouterFetch(req.body, key, referer);
    if (status < 200 || status >= 300) {
      const msg = data?.error?.message || data?.error || data?.message || `OpenRouter returned ${status}`;
      console.error('[OpenRouter proxy]', status, msg, data);
      return sendApiError(res, status, msg);
    }
    res.status(status).json(data);
  } catch (err) {
    const cause = err.cause || err;
    const isTls = cause.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' || cause.message?.includes('certificate');
    if (isTls) {
      console.error('[OpenRouter proxy] TLS error (often corporate proxy). Set ALLOW_INSECURE_TLS=1 in .env and restart. Original:', cause.message || cause.code);
      sendApiError(res, 500, 'TLS error connecting to OpenRouter. If behind a corporate proxy, set ALLOW_INSECURE_TLS=1 in .env and restart.');
    } else {
      console.error('[OpenRouter proxy]', err);
      sendApiError(res, 500, err.message || 'Proxy error');
    }
  }
}

app.post('/api/ai/chat', requireAuth, openRouterProxy);

// -- OpenRouter models proxy: 24h cache, intersected with js/openrouter-allowlist.json.
// Powers js/model-picker.js + the chatbot widget. Independent of the chatbot module.
const OPENROUTER_ALLOWLIST_PATH = path.join(__dirname, 'js', 'openrouter-allowlist.json');
const OPENROUTER_MODELS_TTL_MS = 24 * 60 * 60 * 1000;
let openRouterModelsCache = null;

function fetchOpenRouterModelsRaw(key) {
  return new Promise((resolve, reject) => {
    const allowInsecure = process.env.ALLOW_INSECURE_TLS === '1' || process.env.ALLOW_INSECURE_TLS === 'true';
    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/models',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key.trim()}`,
        'HTTP-Referer': 'https://localhost',
        'X-Title': 'VeloSync Intelligence Dashboard',
      },
      ...(allowInsecure && { agent: new https.Agent({ rejectUnauthorized: false }) }),
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (ch) => { data += ch; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: data ? JSON.parse(data) : {} }); }
        catch (e) { reject(new Error('Invalid JSON from OpenRouter /models')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function readOpenRouterAllowlist() {
  try {
    const raw = fs.readFileSync(OPENROUTER_ALLOWLIST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

app.get('/api/openrouter/models', requireAuth, async (req, res) => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key === 'your-openrouter-api-key-here') {
    return res.status(503).json({ error: { message: 'OpenRouter API key not configured. Set OPENROUTER_API_KEY in .env.' } });
  }

  const force = req.query.force === '1';
  if (!force && openRouterModelsCache && (Date.now() - openRouterModelsCache.fetchedAt) < OPENROUTER_MODELS_TTL_MS) {
    return res.json({ items: openRouterModelsCache.items, cachedAt: openRouterModelsCache.fetchedAt, fromCache: true });
  }

  const allowlist = readOpenRouterAllowlist();
  if (!allowlist.length) {
    return res.status(500).json({ error: { message: 'js/openrouter-allowlist.json missing or empty' } });
  }

  try {
    const { status, data } = await fetchOpenRouterModelsRaw(key);
    if (status < 200 || status >= 300) {
      const msg = data?.error?.message || `OpenRouter /models returned ${status}`;
      if (openRouterModelsCache) {
        return res.json({ items: openRouterModelsCache.items, cachedAt: openRouterModelsCache.fetchedAt, fromCache: true, stale: true, error: msg });
      }
      return res.status(status).json({ error: { message: msg } });
    }

    const liveById = new Map((data.data || []).map(m => [m.id, m]));
    const wantTools = req.query.capability === 'tools';
    const items = allowlist
      .map(entry => {
        const live = liveById.get(entry.id);
        if (!live) return null;
        const supportsTools = Array.isArray(live.supported_parameters) && live.supported_parameters.includes('tools');
        if (wantTools && !supportsTools) return null;
        return {
          id: entry.id,
          name: entry.name,
          family: entry.family,
          default: !!entry.default,
          contextLength: live.context_length || null,
          pricing: live.pricing || null,
          supportsTools,
        };
      })
      .filter(Boolean);

    openRouterModelsCache = { fetchedAt: Date.now(), items };
    res.json({ items, cachedAt: openRouterModelsCache.fetchedAt, fromCache: false });
  } catch (err) {
    if (openRouterModelsCache) {
      return res.json({ items: openRouterModelsCache.items, cachedAt: openRouterModelsCache.fetchedAt, fromCache: true, stale: true, error: err.message });
    }
    res.status(500).json({ error: { message: err.message || 'Failed to fetch OpenRouter models' } });
  }
});

/**
 * JIRA Explore proxy — reads JIRA_* from Product/.env (canonical) or legacy jira-md-export/.env.
 */
function loadJiraCreds() {
  const envFile = envPaths.resolveEnvFilePathForRead(__dirname);
  try {
    const raw = fs.readFileSync(envFile, 'utf8');
    const parsed = require('dotenv').parse(raw);
    return { email: parsed.JIRA_EMAIL, token: parsed.JIRA_TOKEN, domain: parsed.JIRA_DOMAIN };
  } catch (err) {
    console.error('[JIRA Explore] Failed to load env from', envFile, err.message);
    return null;
  }
}

async function jiraApiFetch(domain, apiPath, auth) {
  const url = `https://${domain}${apiPath}`;
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) {}
  return { status: response.status, data };
}

app.post('/api/jira/explore', requireAuth, async (req, res) => {
  const creds = loadJiraCreds();
  if (!creds || !creds.email || !creds.token || !creds.domain) {
    return sendApiError(res, 503, 'JIRA credentials not configured (.env)');
  }
  const { boardUrl, days: rawDays } = req.body;
  if (!boardUrl) return sendApiError(res, 400, 'boardUrl is required');

  const urlMatch = boardUrl.match(/projects\/([A-Z0-9]+)\/boards\/(\d+)/i);
  if (!urlMatch) return sendApiError(res, 400, 'Invalid board URL. Expected: .../projects/KEY/boards/ID');

  const projectKey = urlMatch[1].toUpperCase();
  const boardId = urlMatch[2];
  const days = [30, 60, 90].includes(Number(rawDays)) ? Number(rawDays) : 30;
  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString('base64');

  // Stream newline-delimited JSON so frontend gets real-time progress
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function sendProgress(step, percent, detail) {
    if (!res.writableEnded) {
      res.write(JSON.stringify({ type: 'progress', step, percent, detail }) + '\n');
      if (typeof res.flush === 'function') res.flush();
    }
  }

  try {
    sendProgress('Connecting to JIRA...', 5, `Project: ${projectKey} · ${days}-day window`);

    // -- Step 1: fetch issues via v3 search/jql (nextPageToken pagination) --
    const jqlRaw = `project = ${projectKey} AND (updatedDate >= -${days}d OR created >= -${days}d) ORDER BY created DESC`;
    const fields = 'status,priority,assignee,reporter,created,updated,resolutiondate,issuetype,summary,statuscategorychangedate';
    let allIssues = [];
    let nextPageToken = null;
    const maxResults = 100;
    let page = 0;

    for (;;) {
      page++;
      sendProgress('Fetching issues...', Math.min(10 + page * 8, 40), `Page ${page} — ${allIssues.length} issues so far`);

      const params = new URLSearchParams();
      params.set('jql', jqlRaw);
      params.set('maxResults', String(maxResults));
      params.set('fields', fields);
      if (nextPageToken) params.set('nextPageToken', nextPageToken);

      const searchPath = `/rest/api/3/search/jql?${params.toString()}`;
      const result = await jiraApiFetch(creds.domain, searchPath, auth);
      if (result.status !== 200) {
        const msg = result.data?.errorMessages?.join(', ') || `JIRA returned ${result.status}`;
        res.write(JSON.stringify({ type: 'error', message: msg }) + '\n');
        return res.end();
      }
      const batch = result.data.issues || [];
      allIssues = allIssues.concat(batch);
      if (result.data.isLast === true || batch.length === 0 || !result.data.nextPageToken) break;
      nextPageToken = result.data.nextPageToken;
      if (allIssues.length > 5000) break;
    }

    sendProgress('Fetching changelogs...', 42, `${allIssues.length} issues found — loading history for cycle time`);

    // -- Step 2: fetch changelogs in parallel batches (concurrency = 5) --
    const CONCURRENCY = 5;
    let fetched = 0;
    for (let i = 0; i < allIssues.length; i += CONCURRENCY) {
      const slice = allIssues.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        slice.map(issue => {
          const clPath = `/rest/api/3/issue/${issue.id}?expand=changelog&fields=status`;
          return jiraApiFetch(creds.domain, clPath, auth).catch(() => null);
        })
      );
      results.forEach((r, idx) => {
        if (r && r.status === 200 && r.data?.changelog) {
          slice[idx].changelog = r.data.changelog;
        }
      });
      fetched += slice.length;
      const clPercent = 42 + Math.round((fetched / allIssues.length) * 53);
      sendProgress('Fetching changelogs...', clPercent, `${fetched} / ${allIssues.length} issues`);
    }

    sendProgress('Finalizing...', 98, 'Building response');
    res.write(JSON.stringify({ type: 'done', data: { projectKey, boardId, total: allIssues.length, issues: allIssues } }) + '\n');
    res.end();
  } catch (err) {
    console.error('[JIRA Explore]', err);
    res.write(JSON.stringify({ type: 'error', message: err.message || 'Failed to fetch JIRA data' }) + '\n');
    res.end();
  }
});

/**
 * resource Directory — cached JIRA user list for autocomplete.
 * Refreshes at most once per week; stored in output/resource-directory.json.
 */
const resource_DIR_PATH = path.join(__dirname, 'output', 'resource-directory.json');
const resource_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function readresourceDirectory() {
  try {
    if (!fs.existsSync(resource_DIR_PATH)) return null;
    const raw = fs.readFileSync(resource_DIR_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function isDirectoryCacheFresh(dir) {
  if (!dir || !dir.lastRefresh) return false;
  return (Date.now() - new Date(dir.lastRefresh).getTime()) < resource_DIR_MAX_AGE_MS;
}

app.get('/api/resource/directory', requireAuth, async (req, res) => {
  const cached = readresourceDirectory();
  const forceFresh = req.query.force === '1';

  // Non-force call: return cache instantly, or signal that a refresh is needed
  if (!forceFresh) {
    if (cached && isDirectoryCacheFresh(cached)) {
      return res.json({
        fromCache: true,
        needsRefresh: false,
        lastRefresh: cached.lastRefresh,
        count: (cached.users || []).length,
        users: cached.users || [],
      });
    }
    // Cache is missing or stale — return immediately so the client can show an overlay
    return res.json({
      fromCache: !!cached,
      needsRefresh: true,
      lastRefresh: cached?.lastRefresh || null,
      count: (cached?.users || []).length,
      users: cached?.users || [],
    });
  }

  // force=1  ?  actually fetch from JIRA and rebuild cache
  const creds = loadJiraCreds();
  if (!creds || !creds.email || !creds.token || !creds.domain) {
    if (cached) {
      return res.json({
        fromCache: true,
        needsRefresh: false,
        lastRefresh: cached.lastRefresh,
        count: (cached.users || []).length,
        users: cached.users || [],
        stale: true,
        error: 'JIRA credentials not configured — serving stale cache',
      });
    }
    return sendApiError(res, 503, 'JIRA credentials not configured and no cache exists');
  }

  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString('base64');
  let allUsers = [];

  /** Keep TestRail user IDs across Jira directory refreshes (see jira-md-export/helperScripts/sync-testrail-user-ids.mjs). */
  const existingTrByEmail = new Map();
  try {
    if (cached && Array.isArray(cached.users)) {
      for (const u of cached.users) {
        const e = (u.email || '').toLowerCase();
        if (e && u.testRailUserId != null && u.testRailUserId !== '') existingTrByEmail.set(e, u.testRailUserId);
      }
    }
  } catch (_) { /* ignore */ }

  try {
    // JIRA is the single source of truth for the resource directory.
    // Include all human accounts (exclude only 'app' bots/integrations).
    let startAt = 0;
    const maxResults = 200;

    for (;;) {
      const usersPath = `/rest/api/3/users/search?startAt=${startAt}&maxResults=${maxResults}`;
      const result = await jiraApiFetch(creds.domain, usersPath, auth);
      if (result.status !== 200) break;
      const batch = Array.isArray(result.data) ? result.data : [];
      if (batch.length === 0) break;

      batch.forEach(u => {
        if (u.accountType !== 'atlassian') return;
        if (u.active === false) return;
        if (!u.displayName) return;
        const email = (u.emailAddress || '').toLowerCase();
        const name = u.displayName.toLowerCase();
        if (email && !email.endsWith('@VeloSync.com')) return;
        if (!email && name.includes('@') && !name.includes('@VeloSync.com')) return;
        const row = {
          displayName: u.displayName,
          accountId: u.accountId || '',
          email: u.emailAddress || '',
          avatarUrl: u.avatarUrls?.['24x24'] || '',
        };
        if (email && existingTrByEmail.has(email)) row.testRailUserId = existingTrByEmail.get(email);
        allUsers.push(row);
      });

      startAt += batch.length;
      if (batch.length < maxResults) break;
      if (startAt > 10000) break;
    }

    allUsers.sort((a, b) => a.displayName.localeCompare(b.displayName));

    const dirData = {
      lastRefresh: new Date().toISOString(),
      users: allUsers,
    };

    try {
      fs.writeFileSync(resource_DIR_PATH, JSON.stringify(dirData, null, 2), 'utf8');
    } catch (writeErr) {
      console.error('[resource Directory] Failed to write cache:', writeErr.message);
    }

    res.json({
      fromCache: false,
      needsRefresh: false,
      lastRefresh: dirData.lastRefresh,
      count: allUsers.length,
      users: allUsers,
    });
  } catch (err) {
    console.error('[resource Directory]', err);
    if (cached) {
      return res.json({
        fromCache: true,
        needsRefresh: false,
        lastRefresh: cached.lastRefresh,
        count: (cached.users || []).length,
        users: cached.users || [],
        stale: true,
        error: 'Refresh failed — serving stale cache',
      });
    }
    sendApiError(res, 500, err.message || 'Failed to fetch user directory');
  }
});

/**
 * resource Insights — per-person metrics from JIRA, Cursor, and Sprint MD files.
 * Streams NDJSON progress like the Explore endpoint.
 */
app.post('/api/resource/insights', requireAuth, async (req, res) => {
  const creds = loadJiraCreds();
  if (!creds || !creds.email || !creds.token || !creds.domain) {
    return sendApiError(res, 503, 'JIRA credentials not configured (.env)');
  }

  const { name: rawName, days: rawDays } = req.body;
  if (!rawName || !String(rawName).trim()) return sendApiError(res, 400, 'name is required');

  const personName = String(rawName).trim();
  const days = [30, 60, 90].includes(Number(rawDays)) ? Number(rawDays) : 30;
  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString('base64');

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function sendProgress(step, percent, detail) {
    if (!res.writableEnded) {
      res.write(JSON.stringify({ type: 'progress', step, percent, detail }) + '\n');
      if (typeof res.flush === 'function') res.flush();
    }
  }

  try {
    // -- Step 1: Find JIRA user --
    sendProgress('Searching JIRA users\u2026', 5, `Looking up "${personName}"`);

    let jiraUser = null;
    const userSearchPath = `/rest/api/3/user/search?query=${encodeURIComponent(personName)}&maxResults=10`;
    const userResult = await jiraApiFetch(creds.domain, userSearchPath, auth);

    if (userResult.status === 200 && Array.isArray(userResult.data) && userResult.data.length > 0) {
      const searchLower = personName.toLowerCase();
      const candidates = userResult.data.filter(u => u.accountType === 'atlassian');
      jiraUser = candidates.find(u => (u.displayName || '').toLowerCase() === searchLower)
        || candidates.find(u => (u.displayName || '').toLowerCase().includes(searchLower))
        || candidates.find(u => {
          const score = nameSimilarityScore(personName, u.displayName || '');
          return score >= 0.6;
        })
        || (candidates.length > 0 ? candidates[0] : null);
    }

    if (!jiraUser) {
      const parts = personName.split(/\s+/);
      if (parts.length > 1) {
        for (const part of parts) {
          if (part.length < 2) continue;
          const retryPath = `/rest/api/3/user/search?query=${encodeURIComponent(part)}&maxResults=20`;
          const retryResult = await jiraApiFetch(creds.domain, retryPath, auth);
          if (retryResult.status === 200 && Array.isArray(retryResult.data)) {
            const atlassianUsers = retryResult.data.filter(u => u.accountType === 'atlassian');
            let bestMatch = null;
            let bestScore = 0;
            atlassianUsers.forEach(u => {
              const score = nameSimilarityScore(personName, u.displayName || '');
              if (score > bestScore) { bestScore = score; bestMatch = u; }
            });
            if (bestMatch && bestScore >= 0.5) { jiraUser = bestMatch; break; }
          }
        }
      }
    }

    sendProgress('Fetching assigned tickets\u2026', 12,
      jiraUser ? `Matched: ${jiraUser.displayName}` : 'No exact JIRA match — trying JQL');

    // -- Step 2: Fetch assigned issues --
    // Two separate queries for accuracy:
    //   A) Tickets resolved by this person in the window  ? correct throughput / velocity
    //   B) Tickets currently open (not Done)             ? correct workload snapshot
    // Using a single "updatedDate >= -Nd" query inflates counts with stale tickets
    // that merely received a comment or status change, giving completely wrong numbers.
    let allAssigned = [];
    if (jiraUser) {
      const fieldsParam = 'status,priority,assignee,reporter,created,updated,resolutiondate,statuscategorychangedate,issuetype,summary,story_points,customfield_10028,customfield_10016,customfield_10025';

      // Query A: resolved in the last N days
      const resolvedJql = `assignee = "${jiraUser.accountId}" AND resolved >= -${days}d ORDER BY resolved DESC`;
      let nextPageToken = null;
      sendProgress('Fetching resolved tickets\u2026', 13, `Looking up work completed in last ${days} days`);
      for (;;) {
        const params = new URLSearchParams();
        params.set('jql', resolvedJql);
        params.set('maxResults', '100');
        params.set('fields', fieldsParam);
        if (nextPageToken) params.set('nextPageToken', nextPageToken);
        const result = await jiraApiFetch(creds.domain, `/rest/api/3/search/jql?${params.toString()}`, auth);
        if (result.status !== 200) break;
        const batch = result.data.issues || [];
        allAssigned = allAssigned.concat(batch);
        if (result.data.isLast === true || batch.length === 0 || !result.data.nextPageToken) break;
        nextPageToken = result.data.nextPageToken;
        if (allAssigned.length > 1000) break;
      }

      // Query B: currently open (not Done) — no date filter, true current workload
      const openJql = `assignee = "${jiraUser.accountId}" AND statusCategory != Done ORDER BY updated DESC`;
      nextPageToken = null;
      sendProgress('Fetching open tickets\u2026', 22, `${allAssigned.length} resolved found \u2014 loading open workload`);
      for (;;) {
        const params = new URLSearchParams();
        params.set('jql', openJql);
        params.set('maxResults', '100');
        params.set('fields', fieldsParam);
        if (nextPageToken) params.set('nextPageToken', nextPageToken);
        const result = await jiraApiFetch(creds.domain, `/rest/api/3/search/jql?${params.toString()}`, auth);
        if (result.status !== 200) break;
        const batch = result.data.issues || [];
        // Avoid duplicates (a ticket resolved today might appear in both queries)
        const existingKeys = new Set(allAssigned.map(i => i.key));
        batch.forEach(i => { if (!existingKeys.has(i.key)) allAssigned.push(i); });
        if (result.data.isLast === true || batch.length === 0 || !result.data.nextPageToken) break;
        nextPageToken = result.data.nextPageToken;
        if (allAssigned.length > 2000) break;
      }
    }

    // -- Step 3: Fetch reported issues --
    sendProgress('Fetching reported tickets\u2026', 32, `${allAssigned.length} assigned found`);

    let allReported = [];
    if (jiraUser) {
      // Only tickets *created* in the window — not touched/updated stale ones
      const reportedJql = `reporter = "${jiraUser.accountId}" AND created >= -${days}d ORDER BY created DESC`;
      const fieldsParam = 'status,priority,assignee,reporter,created,updated,resolutiondate,issuetype,summary,statuscategorychangedate';
      let nextPageToken = null;
      let page = 0;

      for (;;) {
        page++;
        const params = new URLSearchParams();
        params.set('jql', reportedJql);
        params.set('maxResults', '100');
        params.set('fields', fieldsParam);
        if (nextPageToken) params.set('nextPageToken', nextPageToken);

        const searchPath = `/rest/api/3/search/jql?${params.toString()}`;
        const result = await jiraApiFetch(creds.domain, searchPath, auth);
        if (result.status !== 200) break;
        const batch = result.data.issues || [];
        allReported = allReported.concat(batch);
        if (result.data.isLast === true || batch.length === 0 || !result.data.nextPageToken) break;
        nextPageToken = result.data.nextPageToken;
        if (allReported.length > 1000) break;
      }
    }

    // -- Step 4: Fetch changelogs — only for resolved tickets (cycle time needs status history)
    // Fetching changelogs for open tickets wastes API calls and doesn't add any value.
    const resolvedOnly = allAssigned.filter(i => {
      const cat = i.fields?.status?.statusCategory?.key;
      const name = (i.fields?.status?.name || '').toLowerCase().trim();
      return cat === 'done' || name === 'done' || name === 'closed' || name === 'resolved'
        || /done|closed|rVeloSynclv|releas|complet|deploy|accept|stag|prod|deliver|verif/.test(name);
    });
    sendProgress('Fetching changelogs\u2026', 38, `${resolvedOnly.length} resolved tickets — loading cycle time history`);

    const CONCURRENCY = 5;
    let fetched = 0;
    for (let i = 0; i < resolvedOnly.length; i += CONCURRENCY) {
      const slice = resolvedOnly.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        slice.map(issue => {
          const clPath = `/rest/api/3/issue/${issue.id}?expand=changelog&fields=status`;
          return jiraApiFetch(creds.domain, clPath, auth).catch(() => null);
        })
      );
      results.forEach((r, idx) => {
        if (r && r.status === 200 && r.data?.changelog) {
          slice[idx].changelog = r.data.changelog;
        }
      });
      fetched += slice.length;
      const clPercent = 38 + Math.round((fetched / Math.max(1, resolvedOnly.length)) * 30);
      sendProgress('Fetching changelogs\u2026', Math.min(clPercent, 68), `${fetched} / ${resolvedOnly.length}`);
    }

    // -- Step 5: Load Cursor data --
    sendProgress('Loading Cursor data\u2026', 72, 'Matching AI tools metrics');

    let cursorMatch = null;
    try {
      const cursorRaw = fs.readFileSync(path.join(__dirname, 'output', 'cursordata.json'), 'utf8');
      const cursorData = JSON.parse(cursorRaw);

      // Handle all possible cursor data shapes (mirrors getCursorLeaderboardRowsForMatch in script.js)
      let leaderboard = [];
      if (Array.isArray(cursorData?.top10Users) && cursorData.top10Users.length > 0) {
        leaderboard = cursorData.top10Users;
      } else {
        const lb = cursorData?.leaderboard;
        if (Array.isArray(lb)) {
          leaderboard = lb;
        } else if (lb && Array.isArray(lb.data) && !lb.tab_leaderboard) {
          leaderboard = lb.data;
        } else if (lb) {
          const tabData = lb.tab_leaderboard && Array.isArray(lb.tab_leaderboard.data) ? lb.tab_leaderboard.data : [];
          const agentData = lb.agent_leaderboard && Array.isArray(lb.agent_leaderboard.data) ? lb.agent_leaderboard.data : [];
          leaderboard = tabData.length ? tabData : agentData;
        }
      }

      let bestScore = 0;
      leaderboard.forEach(u => {
        const dn = u.display_name || u.name || '';
        const em = (u.email || u.user || '').split('@')[0].replace(/[._-]/g, ' ');
        const score = Math.max(nameSimilarityScore(personName, dn), nameSimilarityScore(personName, em));
        if (score > bestScore) { bestScore = score; cursorMatch = u; }
      });

      if (bestScore < 0.45) cursorMatch = null;
    } catch (err) {
      console.error('[resource Insights] Cursor data load error:', err.message);
    }

    // -- Step 6: Parse Sprint MD files --
    sendProgress('Parsing sprint reports\u2026', 82, 'Extracting individual metrics');

    const sprintMetrics = parseSprintFilesForPerson(personName);

    // -- Step 7: Build response --
    sendProgress('Finalizing\u2026', 98, 'Building response');

    if (allAssigned.length === 0 && allReported.length === 0 && !cursorMatch && sprintMetrics.length === 0) {
      res.write(JSON.stringify({
        type: 'error',
        message: `No data found for "${personName}" in any source (JIRA, Cursor, Sprint reports). Try a different name or check spelling.`
      }) + '\n');
      return res.end();
    }

    // -- Load project stage consensus from projects.json (majority vote) --
    let projectStages = { startStage: 'Ready for Dev', endStage: 'Ready for Staging' };
    try {
      const projectsPath = path.join(__dirname, 'jira-md-export', 'projects.json');
      const projectsRaw = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
      const activeProjects = (projectsRaw.projects || []).filter(p => p.active !== false);
      const startCounts = {}, endCounts = {};
      for (const p of activeProjects) {
        const ss = (p.startStage || '').trim();
        const es = (p.endStage || '').trim();
        if (ss) startCounts[ss] = (startCounts[ss] || 0) + 1;
        if (es) endCounts[es] = (endCounts[es] || 0) + 1;
      }
      const topStart = Object.entries(startCounts).sort((a, b) => b[1] - a[1])[0];
      const topEnd = Object.entries(endCounts).sort((a, b) => b[1] - a[1])[0];
      if (topStart) projectStages.startStage = topStart[0];
      if (topEnd) projectStages.endStage = topEnd[0];
      console.log(`[resource Insights] Project stage consensus: startStage="${projectStages.startStage}" (${topStart?.[1] || 0}/${activeProjects.length}), endStage="${projectStages.endStage}" (${topEnd?.[1] || 0}/${activeProjects.length})`);
    } catch (err) {
      console.warn('[resource Insights] Could not load projects.json for stage consensus:', err.message);
    }

    const responseData = {
      person: {
        name: jiraUser?.displayName || personName,
        accountId: jiraUser?.accountId || null,
        email: jiraUser?.emailAddress || null,
        avatarUrl: jiraUser?.avatarUrls?.['48x48'] || null,
      },
      jira: {
        assigned: allAssigned,
        reported: allReported,
      },
      cursor: cursorMatch,
      sprints: sprintMetrics,
      days,
      projectStages,
    };

    res.write(JSON.stringify({ type: 'done', data: responseData }) + '\n');
    res.end();
  } catch (err) {
    console.error('[resource Insights]', err);
    if (!res.writableEnded) {
      res.write(JSON.stringify({ type: 'error', message: err.message || 'Failed to fetch resource data' }) + '\n');
      res.end();
    }
  }
});

/**
 * Parse Sprint MD files in /output for per-person individual metrics.
 * Extracts data from section 2.1 (Output) and 2.2 (AI adoption) tables.
 */
function parseSprintFilesForPerson(personName) {
  const outputDir = path.join(__dirname, 'output');
  let mdFiles;
  try {
    mdFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.md'));
  } catch (_) {
    return [];
  }

  const results = [];

  for (const file of mdFiles) {
    try {
      const content = fs.readFileSync(path.join(outputDir, file), 'utf8');

      const sprintNameMatch = content.match(/^\*\*Sprint name:\*\*\s*(.+)$/m);
      const productMatch = content.match(/^\*\*Product:\*\*\s*(.+)$/m);
      const managerMatch = content.match(/^\*\*Manager:\*\*\s*(.+)$/m);
      const statusMatch = content.match(/^\*\*Status:\*\*\s*(.+)$/m);
      const reviewDateMatch = content.match(/^\*\*Review date:\*\*\s*(.+)$/m);

      if (!sprintNameMatch) continue;

      const sprintName = sprintNameMatch[1].trim();
      const product = productMatch ? productMatch[1].trim() : '';
      const manager = managerMatch ? managerMatch[1].trim() : '';
      const status = statusMatch ? statusMatch[1].trim() : '';
      const reviewDate = reviewDateMatch ? reviewDateMatch[1].trim() : '';

      let individual = null;

      // Parse section 2.1: Output by individual
      const outputSection = content.match(/### 2\.1 Output by individual[\s\S]*?\|[\s\S]*?\|[-\s|]+\|([\s\S]*?)(?=\n\n|\n>|\n---|\n##|$)/);
      if (outputSection) {
        const tableRows = outputSection[1].split('\n').filter(l => l.trim().startsWith('|') && !l.includes('**Team total**'));
        // Pick the BEST-scoring row, not just the first one >= 0.45
        // (prevents e.g. "Nirav D" being matched instead of "Nirav R" for "Nirav Raval")
        let bestOutputScore = 0;
        let bestOutputCells = null;
        for (const row of tableRows) {
          const cells = row.split('|').map(c => c.trim()).filter(Boolean);
          if (cells.length < 3) continue;
          const rowName = cells[0].replace(/\*\*/g, '').trim();
          const score = nameSimilarityScore(personName, rowName);
          if (score > bestOutputScore) { bestOutputScore = score; bestOutputCells = cells; }
        }
        if (bestOutputScore >= 0.45 && bestOutputCells) {
          individual = individual || {};
          individual.storyPoints = parseInt(bestOutputCells[1]) || 0;
          individual.ticketsClosed = parseInt(bestOutputCells[2]) || 0;
          individual.trend = bestOutputCells[3] ? bestOutputCells[3].trim() : '';
          individual.context = bestOutputCells[4] ? bestOutputCells[4].trim() : '';
        }
      }

      // Parse section 2.2: AI adoption & impact
      const aiSection = content.match(/### 2\.2 AI adoption[\s\S]*?\|[\s\S]*?\|[-\s|]+\|([\s\S]*?)(?=\n\n|\n>|\n---|\n##|$)/);
      if (aiSection) {
        const tableRows = aiSection[1].split('\n').filter(l => l.trim().startsWith('|'));
        let bestAiScore = 0;
        let bestAiCells = null;
        for (const row of tableRows) {
          const cells = row.split('|').map(c => c.trim()).filter(Boolean);
          if (cells.length < 2) continue;
          const rowName = cells[0].replace(/\*\*/g, '').trim();
          const score = nameSimilarityScore(personName, rowName);
          if (score > bestAiScore) { bestAiScore = score; bestAiCells = cells; }
        }
        if (bestAiScore >= 0.45 && bestAiCells) {
          individual = individual || {};
          individual.aiUsageLevel = parseInt(bestAiCells[1]) || 0;
          individual.aiChange = bestAiCells[2] ? bestAiCells[2].trim() : '';
          individual.aiNotes = bestAiCells[3] ? bestAiCells[3].trim() : '';
        }
      }

      // Parse section 2.5: Confluence Activity
      const confSection = content.match(/### 2\.5 Confluence[\s\S]*?\|[\s\S]*?\|[-\s|]+\|([\s\S]*?)(?=\n\n|\n>|\n---|\n##|$)/);
      let confluence = null;
      if (confSection) {
        const tableRows = confSection[1].split('\n').filter(l => l.trim().startsWith('|'));
        let bestConfScore = 0;
        let bestConfCells = null;
        for (const row of tableRows) {
          const cells = row.split('|').map(c => c.trim()).filter(Boolean);
          if (cells.length < 3) continue;
          const rowName = cells[0].replace(/\*\*/g, '').trim();
          const score = nameSimilarityScore(personName, rowName);
          if (score > bestConfScore) { bestConfScore = score; bestConfCells = cells; }
        }
        if (bestConfScore >= 0.45 && bestConfCells) {
          confluence = {
            pagesCreated: parseInt(bestConfCells[1]) || 0,
            pagesEdited: parseInt(bestConfCells[2]) || 0,
            spaces: bestConfCells[3] ? bestConfCells[3].trim() : '—',
          };
        }
      }

      if (individual) {
        if (confluence) individual.confluence = confluence;
        results.push({
          sprintName,
          product,
          manager,
          status,
          reviewDate,
          individual,
        });
      }
    } catch (err) {
      console.error(`[Sprint Parse] Error reading ${file}:`, err.message);
    }
  }

  return results;
}

registerAdminRoutes(app, {
  productRoot: __dirname,
  RBAC_PATH,
  requireAdmin,
  loadJiraCredsFromFile: loadJiraCreds,
});

/**
 * Files required by /login (and other unauthenticated pages) must not sit behind requireAuth,
 * otherwise the browser follows a redirect and loads HTML as JS/CSS ? "Unexpected token '<'".
 */
const loginPublicStatic = express.static(path.join(__dirname), { index: false });
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = (req.path || '').split('?')[0];
  const isPublicAsset =
    p.startsWith('/js/') ||
    p.startsWith('/integrations/') ||
    [
      '/logo.svg',
      '/logo.png',
      '/favicon.ico',
      '/light-style.css',
      '/style.css',
      '/css/dashboard-light.css',
      '/css/dashboard-dark.css',
    ].includes(p);
  if (!isPublicAsset) return next();
  loginPublicStatic(req, res, next);
});

// -- Chatbot module (self-contained in chatbot/; remove this block + the chatbot folder to uninstall)
const chatbot = require('./chatbot/register');
chatbot.register(app, {
  requireAuth,
  requireAdmin,
  isAdmin: (account) => {
    if (!account) return false;
    return resolveroleForAccount(account).role === 'admin';
  },
  openRouterFetch,
});

// Serve static files (dashboard) – protected by SSO (auth routes above are not protected)
app.use(requireAuth);
app.use(express.static(path.join(__dirname), { index: 'index.html' }));

// Fallback for SPA-style routes
app.get('*', (req, res, next) => {
  if (
    req.path.startsWith('/api/') ||
    req.path.startsWith('/auth/') ||
    req.path === '/login' ||
    req.path === '/logout' ||
    req.path === '/whats-new'
  ) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'index.html'), (err) => (err ? next(err) : null));
});

app.use((err, req, res, next) => {
  if (err && (err.code === 'ECONNABORTED' || err.message === 'Request aborted')) {
    return;
  }
  console.error(err);
  if (!res.headersSent) {
    res.status(500).send(err.message || 'Server error');
  }
});

function startServer() {
  authLocal.bootstrapLocalRbacIfNeeded(RBAC_PATH);
  const defaultLocal = `${useHttps ? 'https' : 'http'}://localhost:${PORT}`;
  const displayBase = publicBase || defaultLocal;
  const scheme = useHttps ? 'HTTPS' : 'HTTP';
  console.log(`${scheme} server listening on port ${PORT} — public base URL: ${displayBase}`);
  console.log(`Auth mode: ${authLocal.getAuthMode()}`);
  if (authLocal.getAuthMode() === 'azure') {
    console.log(`Azure AD redirect URI for app registration: ${getRedirectUri()}`);
  }
}

if (useHttps && sslOptions) {
  https.createServer(sslOptions, app).listen(PORT, startServer);
} else {
  app.listen(PORT, startServer);
}
