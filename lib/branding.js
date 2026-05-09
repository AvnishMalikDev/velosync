/**
 * Site branding: title, favicon URL, logo URL. Config in branding/config.json;
 * uploaded files in branding/uploads/ (served at /branding/<filename>).
 */
const fs = require('fs');
const path = require('path');

function brandingPaths(productRoot) {
  const dir = path.join(productRoot, 'branding');
  const uploads = path.join(dir, 'uploads');
  const configPath = path.join(dir, 'config.json');
  return { dir, uploads, configPath };
}

function defaultBranding() {
  return {
    siteTitle: 'Product & Technology Team Insights',
    headerTagline: 'Product & Technology team insights',
    faviconUrl: '/favicon.ico',
    logoUrl: '/logo.svg',
  };
}

function ensureBrandingDirs(productRoot) {
  const { dir, uploads } = brandingPaths(productRoot);
  fs.mkdirSync(uploads, { recursive: true });
  return { dir, uploads };
}

function readBrandingConfig(productRoot) {
  const { configPath } = brandingPaths(productRoot);
  ensureBrandingDirs(productRoot);
  if (!fs.existsSync(configPath)) {
    const d = defaultBranding();
    writeBrandingConfig(productRoot, d);
    return d;
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultBranding();
    const merged = { ...defaultBranding(), ...parsed };
    // Repo ships logo.svg; legacy config pointed at missing logo.png
    if (merged.logoUrl === '/logo.png') merged.logoUrl = '/logo.svg';
    return merged;
  } catch {
    return defaultBranding();
  }
}

function writeBrandingConfig(productRoot, data) {
  const { configPath, uploads } = brandingPaths(productRoot);
  fs.mkdirSync(uploads, { recursive: true });
  const merged = { ...defaultBranding(), ...data };
  const tmp = path.join(path.dirname(configPath), `.branding.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, configPath);
  return merged;
}

/** Public URL for a file stored in branding/uploads */
function uploadPublicUrl(filename) {
  const base = String(filename || '').replace(/[/\\]/g, '');
  if (!base) return null;
  return `/branding/${encodeURIComponent(base)}`;
}

module.exports = {
  brandingPaths,
  defaultBranding,
  ensureBrandingDirs,
  readBrandingConfig,
  writeBrandingConfig,
  uploadPublicUrl,
};
