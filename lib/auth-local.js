/**
 * Local auth helpers: bcrypt, rbac bootstrap, safe reads for admin API.
 */
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const BCRYPT_ROUNDS = 10;
const DEFAULT_LOCAL_BOOTSTRAP_USER = 'admin';
const DEFAULT_LOCAL_BOOTSTRAP_PASS = 'admin';

/** @returns {'local' | 'azure'} Default is local (username/password). Set AUTH_MODE=azure for Microsoft Entra SSO. */
function getAuthMode() {
  const m = String(process.env.AUTH_MODE || '').trim().toLowerCase();
  return m === 'azure' ? 'azure' : 'local';
}

function azureEnvLooksValid(env) {
  const id = String(env.AZURE_CLIENT_ID || '').trim();
  const secret = String(env.AZURE_CLIENT_SECRET || '').trim();
  const tenant = String(env.AZURE_TENANT_ID || '').trim();
  if (!id || !secret || !tenant) return false;
  const bad = (s) => /^your-/i.test(s) || /^placeholder/i.test(s) || /^xxx/i.test(s);
  if (bad(id) || bad(secret) || bad(tenant)) return false;
  return true;
}

/** True when Azure AD env looks usable (non-empty, not template placeholders). */
function isAzureEntraConfigured() {
  return azureEnvLooksValid(process.env);
}

/** Same checks as {@link isAzureEntraConfigured} for a plain key/value env object (e.g. file-only merge). */
function isAzureEntraConfiguredFromEnv(env) {
  if (!env || typeof env !== 'object') return false;
  return azureEnvLooksValid(env);
}

function truthyEnv(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/** Local username/password login (and optional bootstrap) when AUTH_MODE=local or ALLOW_LOCAL_LOGIN=1 */
function allowLocalLogin() {
  return getAuthMode() === 'local' || truthyEnv(process.env.ALLOW_LOCAL_LOGIN);
}

/**
 * Local sign-in is allowed: normal local mode / ALLOW_LOCAL_LOGIN, or Azure mode while Entra is not
 * configured yet (bootstrap / avoid a dead-end login page).
 */
function allowLocalSignIn() {
  return allowLocalLogin() || (getAuthMode() === 'azure' && !isAzureEntraConfigured());
}

function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase();
}

function readRbacJson(rbacPath) {
  try {
    if (!fs.existsSync(rbacPath)) return null;
    const raw = fs.readFileSync(rbacPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (e) {
    console.error('[RBAC] read failed:', e.message);
    return null;
  }
}

function writeRbacAtomic(rbacPath, data) {
  const dir = path.dirname(rbacPath);
  const tmp = path.join(dir, `.rbac.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, rbacPath);
}

/**
 * First-time local auth: ensure localUsers exists with at least one admin.
 */
function bootstrapLocalRbacIfNeeded(rbacPath) {
  if (!allowLocalSignIn()) return;
  let rbac = readRbacJson(rbacPath);
  if (!rbac) {
    rbac = {
      version: 2,
      defaultRole: 'viewer',
      roles: { admin: [] },
      localUsers: [],
    };
  }
  if (!Array.isArray(rbac.localUsers)) rbac.localUsers = [];
  if (rbac.localUsers.length > 0) return;

  const hash = bcrypt.hashSync(DEFAULT_LOCAL_BOOTSTRAP_PASS, BCRYPT_ROUNDS);
  rbac.version = Math.max(Number(rbac.version) || 1, 2);
  rbac.localUsers.push({
    username: DEFAULT_LOCAL_BOOTSTRAP_USER,
    passwordHash: hash,
    role: 'admin',
    displayName: 'Administrator',
  });
  rbac.roles = rbac.roles && typeof rbac.roles === 'object' ? rbac.roles : {};
  const admins = Array.isArray(rbac.roles.admin) ? [...rbac.roles.admin] : [];
  if (!admins.includes(DEFAULT_LOCAL_BOOTSTRAP_USER)) admins.push(DEFAULT_LOCAL_BOOTSTRAP_USER);
  rbac.roles.admin = admins;

  writeRbacAtomic(rbacPath, rbac);
  console.warn(
    '[auth] Local login: created bootstrap user (username: admin, password: admin). Change password immediately in production.'
  );
}

function findLocalUser(rbac, username) {
  const u = normalizeUsername(username);
  if (!u || !rbac || !Array.isArray(rbac.localUsers)) return null;
  return rbac.localUsers.find((x) => normalizeUsername(x.username) === u) || null;
}

function verifyLocalPassword(userRecord, plain) {
  if (!userRecord || !userRecord.passwordHash || !plain) return false;
  return bcrypt.compareSync(plain, userRecord.passwordHash);
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
}

/** Admin API: never expose passwordHash. */
function sanitizeRbacForResponse(rbac) {
  if (!rbac || typeof rbac !== 'object') return rbac;
  const copy = JSON.parse(JSON.stringify(rbac));
  if (Array.isArray(copy.localUsers)) {
    copy.localUsers = copy.localUsers.map((u) => ({
      username: u.username,
      role: u.role || 'viewer',
      displayName: u.displayName || '',
      passwordSet: Boolean(u.passwordHash),
    }));
  }
  return copy;
}

function countLocalAdmins(rbac) {
  if (!rbac || !Array.isArray(rbac.localUsers)) return 0;
  return rbac.localUsers.filter((u) => u.role === 'admin').length;
}

module.exports = {
  getAuthMode,
  isAzureEntraConfigured,
  isAzureEntraConfiguredFromEnv,
  allowLocalLogin,
  allowLocalSignIn,
  DEFAULT_LOCAL_BOOTSTRAP_USER,
  DEFAULT_LOCAL_BOOTSTRAP_PASS,
  normalizeUsername,
  readRbacJson,
  writeRbacAtomic,
  bootstrapLocalRbacIfNeeded,
  findLocalUser,
  verifyLocalPassword,
  hashPassword,
  sanitizeRbacForResponse,
  countLocalAdmins,
  BCRYPT_ROUNDS,
};
