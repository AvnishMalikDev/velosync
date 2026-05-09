/* global fetch, localStorage, document, window */
(function () {
  const KEY = 'dashboard-theme';
  const link = document.getElementById('dashboardThemeCss');

  function applyTheme(dark) {
    localStorage.setItem(KEY, dark ? 'dark' : 'light');
    document.documentElement.classList.toggle('theme-light', !dark);
    document.documentElement.classList.toggle('dark', dark);
    if (link) link.setAttribute('href', dark ? '../css/dashboard-dark.css' : '../css/dashboard-light.css');
    const sun = document.getElementById('dashboardThemeIconSun');
    const moon = document.getElementById('dashboardThemeIconMoon');
    const btn = document.getElementById('dashboardThemeToggle');
    if (sun && moon) {
      sun.classList.toggle('hidden', !dark);
      moon.classList.toggle('hidden', dark);
    }
    if (btn) {
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
      btn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
    }
  }

  document.getElementById('dashboardThemeToggle')?.addEventListener('click', () => {
    applyTheme(!document.documentElement.classList.contains('dark'));
  });
  if (document.documentElement.classList.contains('dark')) {
    const sun = document.getElementById('dashboardThemeIconSun');
    const moon = document.getElementById('dashboardThemeIconMoon');
    if (sun) sun.classList.remove('hidden');
    if (moon) moon.classList.add('hidden');
  }

  let authType = 'local';
  let currentRole = 'viewer';
  let lastAuthCfg = { authMode: 'local', localLoginAvailable: true, microsoftLoginAvailable: false };

  function showToast(msg, isErr) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove(
      'hidden',
      'bg-emerald-50',
      'text-emerald-900',
      'border-emerald-200',
      'bg-red-50',
      'text-red-900',
      'border-red-200',
      'dark:bg-emerald-900/90',
      'dark:text-white',
      'dark:border-emerald-700',
      'dark:bg-red-900/90',
      'dark:border-red-700'
    );
    if (isErr) {
      el.classList.add('bg-red-50', 'text-red-900', 'border-red-200', 'dark:bg-red-900/90', 'dark:text-white', 'dark:border-red-700', 'border');
    } else {
      el.classList.add('bg-emerald-50', 'text-emerald-900', 'border-emerald-200', 'dark:bg-emerald-900/90', 'dark:text-white', 'dark:border-emerald-700', 'border');
    }
    el.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.add('hidden'), 4000);
  }

  const ADMIN_NAV_ACTIVE = [
    'bg-gradient-to-r',
    'from-indigo-600',
    'to-violet-600',
    'text-white',
    'shadow-md',
    'shadow-indigo-500/30',
    'ring-1',
    'ring-white/30',
    'dark:from-indigo-500',
    'dark:to-violet-600',
    'dark:shadow-indigo-950/60',
    'dark:ring-white/15',
  ];
  const ADMIN_NAV_INACTIVE = [
    'text-slate-600',
    'hover:bg-white/55',
    'dark:text-slate-400',
    'dark:hover:bg-white/[0.08]',
    'lg:hover:translate-x-0.5',
  ];

  function setSection(id) {
    document.querySelectorAll('[data-section-panel]').forEach((p) => {
      p.classList.toggle('hidden', p.getAttribute('data-section-panel') !== id);
    });
    document.querySelectorAll('[data-section-nav]').forEach((b) => {
      const on = b.getAttribute('data-section-nav') === id;
      ADMIN_NAV_ACTIVE.forEach((c) => b.classList.toggle(c, on));
      ADMIN_NAV_INACTIVE.forEach((c) => b.classList.toggle(c, !on));
    });
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('section', id);
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (_) {}
  }

  document.querySelectorAll('[data-section-nav]').forEach((b) => {
    ADMIN_NAV_INACTIVE.forEach((c) => b.classList.add(c));
    b.addEventListener('click', () => setSection(b.getAttribute('data-section-nav')));
  });

  async function api(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = typeof j.error === 'string' ? j.error : (j.error && j.error.message) || j.message || r.statusText;
      throw new Error(msg);
    }
    return j;
  }

  async function init() {
    let me;
    try {
      me = await api('GET', '/api/me');
    } catch {
      window.location.href = '/login';
      return;
    }
    currentRole = me.role;
    authType = me.authType || 'local';
    if (currentRole !== 'admin') {
      window.location.href = '/';
      return;
    }

    document.getElementById('localPasswordCard')?.classList.toggle('hidden', authType !== 'local');

    await loadEnv();
    await loadConnectors();
    await loadProjects();
    await loadRbac();
    await loadDataSyncJob();
    await loadBranding();
    await loadDashboardScoring();
    await applySetupRouting();

    document.getElementById('saveEnvBtn')?.addEventListener('click', savePlatformEnv);
    document.getElementById('saveJiraSetupBtn')?.addEventListener('click', saveJiraSetup);
    document.getElementById('testJiraBtn')?.addEventListener('click', testJiraOnly);
    document.getElementById('saveConnectorsBtn')?.addEventListener('click', saveConnectors);
    document.getElementById('saveConnectorCredsBtn')?.addEventListener('click', saveConnectorCreds);
    document.getElementById('testConnectorsBtn')?.addEventListener('click', testConnectors);
    document.getElementById('uploadSslBtn')?.addEventListener('click', uploadSsl);
    ['conn_confluence', 'conn_github', 'conn_copilot', 'conn_cursor', 'conn_testrail', 'conn_openrouter'].forEach((cid) => {
      document.getElementById(cid)?.addEventListener('change', syncConnectorCredPanels);
    });

    document.getElementById('saveProjectsBtn')?.addEventListener('click', saveProjects);
    document.getElementById('addProjectBtn')?.addEventListener('click', addProjectRow);
    document.getElementById('saveRbacBtn')?.addEventListener('click', saveRbac);
    document.getElementById('changePwBtn')?.addEventListener('click', changePassword);

    document.getElementById('addLocalUserBtn')?.addEventListener('click', addLocalUser);
    document.getElementById('saveBrandingBtn')?.addEventListener('click', saveBranding);
    ['brandSiteTitle', 'brandLogoUrl', 'brandFaviconUrl'].forEach((id) => {
      document.getElementById(id)?.addEventListener('input', refreshBrandingPreview);
    });
    document.getElementById('uploadFaviconBtn')?.addEventListener('click', () => uploadBrandingFile('favicon'));
    document.getElementById('uploadLogoBtn')?.addEventListener('click', () => uploadBrandingFile('logo'));
    document.getElementById('brandFaviconFile')?.addEventListener('change', (e) => {
      setBrandingFilePreviewFromPick('favicon', e.target.files && e.target.files[0] ? e.target.files[0] : null);
    });
    document.getElementById('brandLogoFile')?.addEventListener('change', (e) => {
      setBrandingFilePreviewFromPick('logo', e.target.files && e.target.files[0] ? e.target.files[0] : null);
    });
    document.getElementById('saveDataSyncJobBtn')?.addEventListener('click', saveDataSyncJob);
    document.getElementById('restartDataSyncJobBtn')?.addEventListener('click', restartDataSyncJobNow);
    document.getElementById('saveDashboardScoringBtn')?.addEventListener('click', saveDashboardScoring);
    document.getElementById('reloadDashboardScoringBtn')?.addEventListener('click', loadDashboardScoring);

    ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_SECRET'].forEach((aid) => {
      document.getElementById('env_' + aid)?.addEventListener('input', syncAuthModeFieldWhenEntraTyped);
    });

    document.getElementById('setupWizardOpenBtn')?.addEventListener('click', openSetupWizard);
    document.getElementById('wizardCloseBtn')?.addEventListener('click', closeSetupWizard);
    document.getElementById('wizardBackdrop')?.addEventListener('click', closeSetupWizard);
    document.getElementById('wizardEditSectionBtn')?.addEventListener('click', wizardOpenCurrentSection);
    document.getElementById('wizardPrevBtn')?.addEventListener('click', () => {
      if (wizardStepIndex <= 0) return;
      wizardStepIndex -= 1;
      renderWizardStep();
    });
    document.getElementById('wizardNextBtn')?.addEventListener('click', async () => {
      const steps = wizardStepDefinitions();
      if (wizardStepIndex >= steps.length - 1) {
        closeSetupWizard();
        return;
      }
      wizardStepIndex += 1;
      if (wizardStepIndex === 3) await refreshWizardSetupHealth();
      renderWizardStep();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const ov = document.getElementById('setupWizardOverlay');
      if (ov && !ov.classList.contains('hidden')) closeSetupWizard();
    });

    if (new URLSearchParams(window.location.search).get('wizard') === '1') {
      setTimeout(() => openSetupWizard(), 200);
    }
  }

  const jiraSetupIds = ['JIRA_DOMAIN', 'JIRA_EMAIL', 'JIRA_TOKEN'];
  const jiraOptionalFieldEnvIds = [
    'JIRA_WORK_CLASSIFICATION_FIELD_ID',
    'JIRA_ACTUAL_STORY_POINTS_FIELD_ID',
    'JIRA_QA_POINTS_FIELD_ID',
    'JIRA_QA_ASSIGNEE_FIELD_ID',
  ];
  /** Keep in sync with Product/lib/admin-routes.js DEFAULT_PM2_WEB_PROCESS_NAME */
  const DEFAULT_PM2_WEB_PROCESS_NAME = 'velosync-web';
  const platformEnvIds = [
    'AUTH_MODE',
    'ALLOW_LOCAL_LOGIN',
    'PUBLIC_BASE_URL',
    'REDIRECT_URI',
    'POST_LOGOUT_REDIRECT_URI',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_TENANT_ID',
    'SESSION_SECRET',
    'PORT',
    'USE_HTTPS',
    'SSL_KEY_PATH',
    'SSL_CERT_PATH',
    'PM2_WEB_PROCESS_NAME',
    'ALLOW_INSECURE_TLS',
  ];
  const connectorCredIds = [
    'GITHUB_TOKEN',
    'ORG',
    'ENT',
    'CURSOR_TOKEN',
    'TESTRAIL_DOMAIN',
    'TESTRAIL_EMAIL',
    'TESTRAIL_API_KEY',
    'OPENROUTER_API_KEY',
  ];
  const envInputIds = [
    ...new Set([...jiraSetupIds, ...jiraOptionalFieldEnvIds, ...platformEnvIds, ...connectorCredIds]),
  ];

  /** Inputs that use type=password when masked; switch to text when revealing secrets. */
  const envPasswordFieldIds = [
    'JIRA_TOKEN',
    'GITHUB_TOKEN',
    'CURSOR_TOKEN',
    'TESTRAIL_API_KEY',
    'OPENROUTER_API_KEY',
    'AZURE_CLIENT_SECRET',
    'SESSION_SECRET',
  ];

  let connectorsPayload = null;

  /** Mirrors Product/lib/auth-local.js azureEnvLooksValid placeholder checks (admin UI only). */
  function isAzurePlaceholderToken(s) {
    const t = String(s || '').trim();
    if (!t) return true;
    return /^your-/i.test(t) || /^placeholder/i.test(t) || /^xxx/i.test(t);
  }

  /**
   * True when Entra env from GET /api/admin/config/keys looks complete enough to use Microsoft SSO.
   * Secret may be masked as { set: true }.
   */
  function azureEnvKeysSufficient(keys) {
    if (!keys || typeof keys !== 'object') return false;
    const id = keys.AZURE_CLIENT_ID;
    const tenant = keys.AZURE_TENANT_ID;
    if (isAzurePlaceholderToken(id) || isAzurePlaceholderToken(tenant)) return false;
    const sec = keys.AZURE_CLIENT_SECRET;
    if (sec && typeof sec === 'object' && 'set' in sec) {
      if (!sec.set) return false;
    } else if (isAzurePlaceholderToken(sec)) {
      return false;
    }
    return true;
  }

  /** Same checks using current form fields (for live updates while typing). */
  function azureDomEntraComplete() {
    const id = document.getElementById('env_AZURE_CLIENT_ID')?.value?.trim() || '';
    const tenant = document.getElementById('env_AZURE_TENANT_ID')?.value?.trim() || '';
    const secEl = document.getElementById('env_AZURE_CLIENT_SECRET');
    const secVal = secEl?.value?.trim() || '';
    const secretSaved = String(secEl?.placeholder || '').toLowerCase().includes('saved');
    if (isAzurePlaceholderToken(id) || isAzurePlaceholderToken(tenant)) return false;
    if (!secVal && !secretSaved) return false;
    if (secVal && isAzurePlaceholderToken(secVal)) return false;
    return true;
  }

  /**
   * When Entra fields are complete, show AUTH_MODE=azure so users see that Microsoft SSO is the active mode.
   * Otherwise default to local. User can still set ALLOW_LOCAL_LOGIN=1 for both sign-in options.
   */
  function applyAuthModeFromEntraCompleteness(keys) {
    const el = document.getElementById('env_AUTH_MODE');
    if (!el) return;
    if (azureEnvKeysSufficient(keys)) {
      el.value = 'azure';
      const allowEl = document.getElementById('env_ALLOW_LOCAL_LOGIN');
      if (allowEl && String(allowEl.value || '').trim() === '') {
        allowEl.value = '1';
      }
    } else {
      const raw = String(keys.AUTH_MODE || '').trim().toLowerCase();
      if (raw === 'azure' || raw === 'local') {
        el.value = raw;
      } else {
        el.value = 'local';
      }
    }
  }

  function syncAuthModeFieldWhenEntraTyped() {
    const modeEl = document.getElementById('env_AUTH_MODE');
    if (!modeEl) return;
    if (!azureDomEntraComplete()) return;
    const cur = String(modeEl.value || '').trim().toLowerCase();
    if (cur === '' || cur === 'local') modeEl.value = 'azure';
    const allowEl = document.getElementById('env_ALLOW_LOCAL_LOGIN');
    if (allowEl && String(allowEl.value || '').trim() === '') {
      allowEl.value = '1';
    }
  }

  function applyEnvKeyToInput(id, keys) {
    const el = document.getElementById('env_' + id);
    if (!el) return;
    const v = keys[id];
    if (v && typeof v === 'object' && 'set' in v) {
      el.placeholder = v.set
        ? '•••••••• (saved — leave blank to keep)'
        : 'Not set';
      el.value = '';
    } else {
      el.value = v != null ? String(v) : '';
      if (el.type === 'password') el.placeholder = '';
    }
    if (id === 'PM2_WEB_PROCESS_NAME' && !String(el.value || '').trim()) {
      el.value = DEFAULT_PM2_WEB_PROCESS_NAME;
    }
    if (id === 'AUTH_MODE') {
      el.value = String(el.value || '').trim();
    }
  }

  function setEnvSecretInputsPlaintext(plain) {
    envPasswordFieldIds.forEach((id) => {
      const el = document.getElementById('env_' + id);
      if (el) el.type = plain ? 'text' : 'password';
    });
  }

  async function loadEnv() {
    const data = await api('GET', '/api/admin/config/env');
    const keys = data.keys || {};
    envInputIds.forEach((id) => applyEnvKeyToInput(id, keys));
    applyAuthModeFromEntraCompleteness(keys);
    setEnvSecretInputsPlaintext(false);
  }

  function showAdminRestartHint() {
    const el = document.getElementById('adminRestartHint');
    if (!el) return;
    el.classList.remove('hidden');
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (_) {}
  }

  async function loadDataSyncJob() {
    const hint = document.getElementById('dsjPm2Hint');
    try {
      const d = await api('GET', '/api/admin/config/data-sync-job');
      const en = document.getElementById('dsjEnabled');
      if (en) en.checked = !!d.enabled;
      const pn = document.getElementById('dsjProcessName');
      if (pn) pn.value = d.pm2ProcessName != null ? String(d.pm2ProcessName) : '';
      const cr = document.getElementById('dsjCron');
      if (cr) cr.value = d.cronExpression != null ? String(d.cronExpression) : '';
      if (hint) {
        hint.textContent = d.pm2OnPath
          ? `PM2 on PATH (${d.pm2Version || 'ok'}).`
          : 'PM2 not detected on PATH — install with npm i -g pm2 (optional). You can still save settings.';
      }
    } catch (e) {
      if (hint) hint.textContent = e.message || 'Could not load data sync job settings.';
    }
  }

  async function saveDataSyncJob() {
    try {
      const body = {
        enabled: !!document.getElementById('dsjEnabled')?.checked,
        pm2ProcessName: document.getElementById('dsjProcessName')?.value?.trim() || undefined,
        cronExpression: document.getElementById('dsjCron')?.value?.trim() || undefined,
      };
      const j = await api('PUT', '/api/admin/config/data-sync-job', body);
      if (j.pm2 && j.pm2.ok === false) {
        showToast(j.pm2.message || 'Config saved but PM2 apply failed.', true);
      } else {
        showToast(j.pm2?.message || 'Data sync job saved and PM2 updated.');
      }
      await loadDataSyncJob();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  async function restartDataSyncJobNow() {
    try {
      const j = await api('POST', '/api/admin/data-sync-job/restart', {});
      showToast(j.message || 'Done', !j.ok);
    } catch (e) {
      showToast(e.message, true);
    }
  }

  function collectEnvPatchFromIds(ids) {
    const patch = {};
    ids.forEach((id) => {
      const el = document.getElementById('env_' + id);
      if (!el) return;
      const raw = el.value.trim();
      if (raw !== '') patch[id] = raw;
    });
    return patch;
  }

  async function patchEnvFromIds(ids) {
    const patch = collectEnvPatchFromIds(ids);
    await api('PATCH', '/api/admin/config/env', patch);
  }

  async function savePlatformEnv() {
    try {
      const patch = collectEnvPatchFromIds(platformEnvIds);
      if (Object.keys(patch).length === 0) {
        showToast('Nothing to save — fill at least one platform field.', true);
        return;
      }
      await api('PATCH', '/api/admin/config/env', patch);
      showToast('Platform settings saved to .env');
      showAdminRestartHint();
      await loadEnv();
      await syncOnboardingBannersFromServer();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  async function syncOnboardingBannersFromServer() {
    let needsJira = true;
    let needsPlatform = false;
    let platformReasons = [];
    try {
      const st = await api('GET', '/api/admin/setup-status');
      needsJira = !!st.needsJiraSetup;
      needsPlatform = !!st.needsPlatformSetup;
      platformReasons = Array.isArray(st.platformSetupReasons) ? st.platformSetupReasons : [];
    } catch (_) {
      needsPlatform = true;
      platformReasons = ['Could not verify platform status from the server.'];
    }
    const bp = document.getElementById('onboardingBannerPlatform');
    const bj = document.getElementById('onboardingBannerJira');
    const ul = document.getElementById('platformSetupReasonsList');
    if (bp) {
      bp.classList.toggle('hidden', !needsPlatform);
      if (ul) {
        ul.innerHTML = platformReasons.length
          ? platformReasons.map((r) => `<li class="ml-4 list-disc">${escapeAttr(r)}</li>`).join('')
          : '<li class="ml-4 list-disc">Complete session secret, auth mode, and SSO URLs under Platform.</li>';
      }
    }
    if (bj) bj.classList.toggle('hidden', !needsJira || needsPlatform);
  }

  async function saveJiraSetup() {
    try {
      await patchEnvFromIds([...jiraSetupIds, ...jiraOptionalFieldEnvIds]);
      showToast('Jira settings saved');
      showAdminRestartHint();
      await loadEnv();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  async function saveConnectorCreds() {
    try {
      await patchEnvFromIds(connectorCredIds);
      showToast('Connector credentials saved');
      showAdminRestartHint();
      await loadEnv();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  function syncConnectorCredPanels() {
    const gh = document.getElementById('conn_github')?.checked;
    const cop = document.getElementById('conn_copilot')?.checked;
    const cur = document.getElementById('conn_cursor')?.checked;
    const tr = document.getElementById('conn_testrail')?.checked;
    const or = document.getElementById('conn_openrouter')?.checked;
    document.querySelector('[data-cred-panel="github"]')?.classList.toggle('hidden', !gh && !cop);
    document.querySelector('[data-cred-panel="copilot"]')?.classList.toggle('hidden', !cop);
    document.querySelector('[data-cred-panel="cursor"]')?.classList.toggle('hidden', !cur);
    document.querySelector('[data-cred-panel="testrail"]')?.classList.toggle('hidden', !tr);
    document.querySelector('[data-cred-panel="openrouter"]')?.classList.toggle('hidden', !or);
  }

  async function loadConnectors() {
    connectorsPayload = await api('GET', '/api/admin/config/connectors');
    const c = connectorsPayload.connectors || {};
    ['confluence', 'github', 'copilot', 'cursor', 'testrail', 'openrouter'].forEach((k) => {
      const el = document.getElementById('conn_' + k);
      if (el) el.checked = !!(c[k] && c[k].enabled);
    });
    syncConnectorCredPanels();
  }

  async function saveConnectors() {
    const connectors = { jira: { enabled: true } };
    ['confluence', 'github', 'copilot', 'cursor', 'testrail', 'openrouter'].forEach((k) => {
      const el = document.getElementById('conn_' + k);
      connectors[k] = { enabled: !!(el && el.checked) };
    });
    try {
      connectorsPayload = await api('PUT', '/api/admin/config/connectors', {
        version: connectorsPayload?.version || 1,
        connectors,
      });
      showToast('Connector toggles saved');
      await loadConnectors();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  async function testJiraOnly() {
    const out = document.getElementById('jiraTestOut');
    if (out) {
      out.classList.remove('hidden');
      out.textContent = 'Running…';
    }
    try {
      const data = await api('POST', '/api/admin/config/env/test', {});
      const line = (data.results || []).filter((r) => r.service === 'jira');
      const jiraLine = line[0];
      let text = line.map((r) => `${r.service}: ${r.ok ? 'OK' : 'FAIL'} — ${r.message}`).join('\n') || 'No Jira result';
      if (jiraLine && !jiraLine.ok) {
        text +=
          '\n\nIf you just saved new credentials, restart the server (see the green notice after saving) and try again.';
      }
      if (out) out.textContent = text;
    } catch (e) {
      if (out) out.textContent = e.message;
    }
  }

  async function testConnectors() {
    const out = document.getElementById('connectorTestResults');
    if (!out) return;
    out.textContent = 'Running…';
    try {
      const data = await api('POST', '/api/admin/config/env/test', {});
      const lines = (data.results || []).map(
        (r) => `${r.service}: ${r.ok ? 'OK' : 'FAIL'} — ${r.message}`,
      );
      let text = lines.join('\n');
      if ((data.results || []).some((r) => !r.ok)) {
        text +=
          '\n\nIf a connector fails after you saved new credentials, restart the server (see the green notice after saving) and test again.';
      }
      out.textContent = text;
    } catch (e) {
      out.textContent = e.message;
    }
  }

  async function uploadSsl() {
    const certInp = document.getElementById('sslCertFile');
    const keyInp = document.getElementById('sslKeyFile');
    const c = certInp?.files?.[0];
    const k = keyInp?.files?.[0];
    if (!c || !k) {
      showToast('Choose both certificate and key files', true);
      return;
    }
    const fd = new FormData();
    fd.append('cert', c);
    fd.append('key', k);
    try {
      const r = await fetch('/api/admin/config/ssl/upload', {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      showToast(j.message || 'SSL uploaded');
      showAdminRestartHint();
      certInp.value = '';
      keyInp.value = '';
      await loadEnv();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  async function applySetupRouting() {
    let needsJira = true;
    let needsPlatform = false;
    try {
      const st = await api('GET', '/api/admin/setup-status');
      needsJira = !!st.needsJiraSetup;
      needsPlatform = !!st.needsPlatformSetup;
      const platformReasons = Array.isArray(st.platformSetupReasons) ? st.platformSetupReasons : [];
      const bp = document.getElementById('onboardingBannerPlatform');
      const bj = document.getElementById('onboardingBannerJira');
      const ul = document.getElementById('platformSetupReasonsList');
      if (bp) {
        bp.classList.toggle('hidden', !needsPlatform);
        if (ul) {
          ul.innerHTML = platformReasons.length
            ? platformReasons.map((r) => `<li class="ml-4 list-disc">${escapeAttr(r)}</li>`).join('')
            : '<li class="ml-4 list-disc">Complete session secret, auth mode, and SSO URLs under Platform.</li>';
        }
      }
      if (bj) bj.classList.toggle('hidden', !needsJira || needsPlatform);
    } catch (_) {
      needsPlatform = true;
      document.getElementById('onboardingBannerPlatform')?.classList.remove('hidden');
      document.getElementById('onboardingBannerJira')?.classList.add('hidden');
      const ul = document.getElementById('platformSetupReasonsList');
      if (ul) {
        ul.innerHTML =
          '<li class="ml-4 list-disc">Could not verify platform status from the server.</li>';
      }
    }
    const params = new URLSearchParams(window.location.search);
    const sec = params.get('section');
    if (sec && document.querySelector('[data-section-panel="' + sec + '"]')) {
      setSection(sec);
    } else if (needsPlatform) {
      setSection('general');
    } else if (needsJira) {
      setSection('setup');
    } else {
      setSection('branding');
    }
  }

  let projectsData = { projects: [] };
  /** @type {Set<number>} */
  let projectsExpanded = new Set();

  async function loadProjects() {
    projectsData = await api('GET', '/api/admin/config/projects');
    const len = (projectsData.projects || []).length;
    projectsExpanded = new Set([...projectsExpanded].filter((i) => i >= 0 && i < len));
    renderProjects();
  }

  const projectRowTestIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4" aria-hidden="true"><path d="M9.348 14.651a3.75 3.75 0 010-5.303m5.304 0a3.75 3.75 0 010 5.303m-7.425 2.122a6.75 6.75 0 010-9.546m9.546 0a6.75 6.75 0 010 9.546M5.106 18.894c-3.808-3.807-3.808-9.98 0-13.788m13.788 0c3.808 3.807 3.808 9.98 0 13.788"/></svg>`;
  const projectRowDeleteIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4" aria-hidden="true"><path d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>`;

  const PROJECT_DETAIL_COLSPAN = 7;

  function toggleProjectExpanded(idx) {
    if (projectsExpanded.has(idx)) projectsExpanded.delete(idx);
    else projectsExpanded.add(idx);
    const trDet = document.querySelector(`#projectsBody tr[data-project-detail="${idx}"]`);
    const btn = document.querySelector(`#projectsBody button[data-expand="${idx}"]`);
    const on = projectsExpanded.has(idx);
    if (trDet) trDet.classList.toggle('hidden', !on);
    if (btn) {
      btn.setAttribute('aria-expanded', on ? 'true' : 'false');
      const svg = btn.querySelector('svg');
      if (svg) svg.classList.toggle('rotate-90', on);
    }
  }

  function renderProjects() {
    const tbody = document.getElementById('projectsBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    (projectsData.projects || []).forEach((p, idx) => {
      const trIds = Array.isArray(p.testRailProjectIds) ? p.testRailProjectIds.join(', ') : '';
      const sprintCountVal =
        p.sprintCount != null && p.sprintCount !== '' ? Number(p.sprintCount) : 3;
      const fullOw = p.overwriteexistingdatafiles !== false;
      const expanded = projectsExpanded.has(idx);
      const chevron = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;

      const trSum = document.createElement('tr');
      trSum.setAttribute('data-project-summary', String(idx));
      trSum.className =
        'border-b border-slate-200 dark:border-white/5 cursor-pointer hover:bg-slate-50/90 dark:hover:bg-white/[0.04] transition-colors';
      trSum.innerHTML = `
        <td class="p-2 align-middle">
          <button type="button" data-expand="${idx}" class="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900/80 dark:text-slate-300 dark:hover:bg-slate-800" aria-expanded="${expanded ? 'true' : 'false'}" aria-label="Toggle details for row ${idx + 1}">${chevron}</button>
        </td>
        <td class="p-2 align-middle"><input data-f="active" data-i="${idx}" type="checkbox" class="rounded border-slate-400 text-cyan-600 bg-white dark:border-slate-600 dark:bg-slate-900" ${p.active !== false ? 'checked' : ''}></td>
        <td class="p-2 align-middle"><input data-f="key" data-i="${idx}" class="w-full min-w-0 rounded border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-900 dark:bg-slate-900/80 dark:border-slate-700 dark:text-slate-100" value="${escapeAttr(p.key || '')}"></td>
        <td class="p-2 align-middle min-w-0"><input data-f="name" data-i="${idx}" class="w-full min-w-0 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:bg-slate-900/80 dark:border-slate-700 dark:text-slate-100" value="${escapeAttr(p.name || '')}"></td>
        <td class="p-2 align-middle"><input data-f="boardId" data-i="${idx}" type="number" class="w-full min-w-0 rounded border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-900 dark:bg-slate-900/80 dark:border-slate-700 dark:text-slate-100" value="${p.boardId != null ? p.boardId : ''}"></td>
        <td class="p-2 align-middle"><input data-f="type" data-i="${idx}" class="w-full min-w-0 rounded border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-900 dark:bg-slate-900/80 dark:border-slate-700 dark:text-slate-100" value="${escapeAttr(p.type || '')}"></td>
        <td class="p-2 align-middle"><div class="flex items-center justify-center gap-0.5">
          <button type="button" data-test="${idx}" class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-sky-600 hover:bg-sky-50 hover:border-sky-400 dark:border-slate-600 dark:bg-slate-900/80 dark:text-sky-400 dark:hover:bg-sky-950/50 dark:hover:border-sky-500/60" title="Test Jira board" aria-label="Test Jira board">${projectRowTestIcon}</button>
          <button type="button" data-del="${idx}" class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 hover:bg-red-50 hover:border-red-300 hover:text-red-600 dark:border-slate-600 dark:bg-slate-900/80 dark:text-slate-400 dark:hover:bg-red-950/40 dark:hover:border-red-500/50 dark:hover:text-red-400" title="Remove row" aria-label="Remove project row">${projectRowDeleteIcon}</button>
        </div></td>`;

      const trDet = document.createElement('tr');
      trDet.setAttribute('data-project-detail', String(idx));
      trDet.className = 'border-b border-slate-200 dark:border-white/5' + (expanded ? '' : ' hidden');
      trDet.innerHTML = `
        <td colspan="${PROJECT_DETAIL_COLSPAN}" class="p-0 align-top bg-slate-50/90 dark:bg-slate-950/40">
          <div class="p-4 border-t border-slate-200/80 dark:border-white/10">
            <p class="text-[10px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">Project details</p>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              <div class="min-w-0 sm:col-span-1">
                <label class="block text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-0.5" title="Parent / epic grouping">Parent</label>
                <input data-f="parent" data-i="${idx}" class="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:bg-slate-900/80 dark:border-slate-700 dark:text-slate-100" value="${escapeAttr(p.parent || '')}">
              </div>
              <div class="min-w-0 sm:col-span-1">
                <label class="block text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-0.5">Manager</label>
                <input data-f="manager" data-i="${idx}" class="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:bg-slate-900/80 dark:border-slate-700 dark:text-slate-100" value="${escapeAttr(p.manager || '')}">
              </div>
              <div class="min-w-0 sm:col-span-1">
                <label class="block text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-0.5" title="Start stage(s), comma-separated">Start stage(s)</label>
                <input data-f="startStage" data-i="${idx}" class="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:bg-slate-900/80 dark:border-slate-700 dark:text-slate-100" value="${escapeAttr(p.startStage != null ? String(p.startStage) : '')}" placeholder="Ready for Dev">
              </div>
              <div class="min-w-0 sm:col-span-1">
                <label class="block text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-0.5" title="End stage(s), comma-separated">End stage(s)</label>
                <input data-f="endStage" data-i="${idx}" class="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:bg-slate-900/80 dark:border-slate-700 dark:text-slate-100" value="${escapeAttr(p.endStage != null ? String(p.endStage) : '')}" placeholder="Ready for Staging">
              </div>
              <div class="min-w-0 sm:col-span-1">
                <label class="block text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-0.5" title="Sprint name must contain">Must have (sprint)</label>
                <input data-f="mustHave" data-i="${idx}" class="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:bg-slate-900/80 dark:border-slate-700 dark:text-slate-100" value="${escapeAttr(p.mustHave != null ? String(p.mustHave) : '')}">
              </div>
              <div class="min-w-0 sm:col-span-1">
                <label class="block text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-0.5" title="Sprint name must not contain">Exclude (sprint)</label>
                <input data-f="excludeWords" data-i="${idx}" class="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:bg-slate-900/80 dark:border-slate-700 dark:text-slate-100" value="${escapeAttr(p.excludeWords != null ? String(p.excludeWords) : '')}" placeholder="comma-separated">
              </div>
              <div class="min-w-0 sm:col-span-1">
                <label class="block text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-0.5" title="How many recent sprints (or Kanban windows) to export for this board">Sprints to export</label>
                <input data-f="sprintCount" data-i="${idx}" type="number" min="1" max="99" class="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:bg-slate-900/80 dark:border-slate-700 dark:text-slate-100" value="${Number.isFinite(sprintCountVal) && sprintCountVal >= 1 ? sprintCountVal : 3}">
              </div>
              <div class="min-w-0 sm:col-span-1">
                <label class="block text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-0.5" title="TestRail project IDs">TestRail project IDs</label>
                <input data-f="testRailProjectIds" data-i="${idx}" class="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-mono text-slate-900 dark:bg-slate-900/80 dark:border-slate-700 dark:text-slate-100" value="${escapeAttr(trIds)}">
              </div>
              <div class="min-w-0 sm:col-span-1">
                <label class="block text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-0.5" title="Jira work classification custom field">WC field ID</label>
                <input data-f="workClassificationFieldId" data-i="${idx}" class="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-mono text-slate-900 dark:bg-slate-900/80 dark:border-slate-700 dark:text-slate-100" value="${escapeAttr(p.workClassificationFieldId != null ? String(p.workClassificationFieldId) : '')}" placeholder="customfield_…">
              </div>
              <div class="min-w-0 sm:col-span-2 flex flex-wrap items-center gap-2 pt-1">
                <input data-f="fullOverwrite" data-i="${idx}" id="proj_fullow_${idx}" type="checkbox" class="rounded border-slate-400 text-cyan-600 bg-white dark:border-slate-600 dark:bg-slate-900" ${fullOw ? 'checked' : ''}>
                <label for="proj_fullow_${idx}" class="text-xs text-slate-700 dark:text-slate-300 cursor-pointer" title="When checked, always overwrite sprint output files (legacy). When off, delta export skips unchanged files.">Full overwrite sprint files (legacy delta off)</label>
              </div>
            </div>
          </div>
        </td>`;

      tbody.appendChild(trSum);
      tbody.appendChild(trDet);
    });
    tbody.querySelectorAll('[data-f]').forEach((inp) => {
      inp.addEventListener('change', onProjectFieldChange);
      inp.addEventListener('input', onProjectFieldChange);
    });
    tbody.querySelectorAll('[data-test]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        testProject(Number(b.getAttribute('data-test')));
      });
    });
    tbody.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteProject(Number(b.getAttribute('data-del')));
      });
    });
    tbody.querySelectorAll('button[data-expand]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleProjectExpanded(Number(b.getAttribute('data-expand')));
      });
    });
    tbody.querySelectorAll('tr[data-project-summary]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('input, button, textarea, select, a, label')) return;
        toggleProjectExpanded(Number(tr.getAttribute('data-project-summary')));
      });
    });
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  /** -- Setup wizard (guided onboarding) -- */
  let wizardStepIndex = 0;
  let wizardNeedsJira = true;
  let wizardNeedsPlatform = true;

  async function refreshWizardSetupHealth() {
    try {
      const st = await api('GET', '/api/admin/setup-status');
      wizardNeedsJira = !!st.needsJiraSetup;
      wizardNeedsPlatform = !!st.needsPlatformSetup;
    } catch {
      wizardNeedsJira = true;
      wizardNeedsPlatform = true;
    }
  }

  function getEnvTrim(id) {
    const el = document.getElementById('env_' + id);
    return el ? String(el.value || '').trim() : '';
  }

  function connectorOn(id) {
    return !!document.getElementById(id)?.checked;
  }

  function buildWizardWelcomeHtml() {
    const ms = lastAuthCfg || {};
    const azureOn = !!ms.microsoftLoginAvailable;
    const localOn = !!ms.localLoginAvailable;
    const projs = projectsData.projects || [];
    const activeProjs = projs.filter((p) => p.active !== false);
    const connBits = [];
    if (connectorOn('conn_confluence')) connBits.push('Confluence');
    if (connectorOn('conn_github')) connBits.push('GitHub');
    if (connectorOn('conn_copilot')) connBits.push('Copilot');
    if (connectorOn('conn_cursor')) connBits.push('Cursor');
    if (connectorOn('conn_testrail')) connBits.push('TestRail');
    if (connectorOn('conn_openrouter')) connBits.push('OpenRouter');
    const jiraDomain = getEnvTrim('JIRA_DOMAIN');
    const brandTitle = document.getElementById('brandSiteTitle')?.value?.trim() || '';

    function row(ok, label, detail) {
      const dot = ok
        ? 'bg-emerald-500 shadow-emerald-500/50'
        : 'bg-amber-500 shadow-amber-500/50';
      return `<div class="flex gap-3 rounded-xl border border-slate-200/90 bg-white/80 p-3 dark:border-white/10 dark:bg-slate-950/40">
        <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot} shadow" aria-hidden="true"></span>
        <div class="min-w-0"><p class="text-xs font-bold text-slate-900 dark:text-slate-100">${label}</p><p class="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5">${detail}</p></div>
      </div>`;
    }

    const authDetail =
      azureOn && localOn
        ? 'Microsoft and username/password are both available — handy for migrations or break-glass.'
        : azureOn
          ? 'Microsoft sign-in is configured.'
          : localOn
            ? 'Local username/password is configured.'
            : 'Open Platform — set session secret; add <code class="text-[10px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">AUTH_MODE=azure</code> and Entra only if you want Microsoft SSO.';

    return `<div class="space-y-3">
      <p class="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">Snapshot of <strong class="text-slate-800 dark:text-slate-200">this server</strong> from the fields already loaded. Nothing is saved here — use <strong>Next</strong> to tour each area.</p>
      <div class="space-y-2">
        ${row(!wizardNeedsPlatform, 'Platform &amp; session', wizardNeedsPlatform ? 'Session secret, auth mode, or SSO URLs need attention — start under Platform &amp; SSO.' : 'Saved .env passes platform checks.')}
        ${row(!wizardNeedsJira, 'Jira connection', wizardNeedsJira ? 'Site URL or token still needs attention — we cover that soon.' : 'Jira responded OK with saved credentials.')}
        ${row(azureOn || localOn, 'Authentication', authDetail)}
        ${row(!!jiraDomain, 'Jira site', jiraDomain ? escapeAttr(jiraDomain) : 'Not set yet — add it under Setup (Jira).')}
        ${row(activeProjs.length > 0, 'Project portfolio', activeProjs.length ? `${activeProjs.length} active project(s) in the table.` : 'Add at least one board under Projects.')}
        ${row(connBits.length > 0, 'Connectors', connBits.length ? `${connBits.join(', ')} enabled.` : 'Optional — enable when you are ready.')}
        ${row(!!brandTitle, 'Branding', brandTitle ? `Title: “${escapeAttr(brandTitle)}”.` : 'Optional — set title &amp; logo under Logo, icon &amp; title.')}
      </div>
      <p class="text-[11px] text-slate-500 dark:text-slate-500 italic">Reopen wizard anytime from the sidebar to train a teammate or verify a deployment.</p>
    </div>`;
  }

  function buildWizardIdentityHtml() {
    const mode = getEnvTrim('AUTH_MODE') || '—';
    const allowLocal = getEnvTrim('ALLOW_LOCAL_LOGIN');
    const pub = getEnvTrim('PUBLIC_BASE_URL');
    const redir = getEnvTrim('REDIRECT_URI');
    const ms = lastAuthCfg || {};
    const both = !!ms.microsoftLoginAvailable && !!ms.localLoginAvailable;
    return `<div class="space-y-4">
      <p class="text-xs leading-relaxed text-slate-600 dark:text-slate-400">Default is <strong class="text-slate-800 dark:text-slate-200">username &amp; password</strong> (<code class="text-[10px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">AUTH_MODE=local</code> or leave unset). For <strong class="text-slate-800 dark:text-slate-200">Microsoft Entra</strong>, fill Client ID, Tenant, and Secret under Platform—the form sets <code class="text-[10px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">AUTH_MODE</code> to <code class="text-[10px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">azure</code> automatically (${both ? 'you currently have both sign-in options enabled.' : 'add app registration + redirect URIs, then save and restart the Node process on the host (e.g. PM2).'})</p>
      <ul class="list-disc pl-4 space-y-1 text-[11px] text-slate-600 dark:text-slate-400">
        <li><code class="text-[10px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">AUTH_MODE=local</code> (default) — built-in login; manage users in <strong>Manage users</strong>.</li>
        <li><code class="text-[10px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">AUTH_MODE=azure</code> — Microsoft SSO (shown automatically when Entra credentials are complete).</li>
        <li><code class="text-[10px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">ALLOW_LOCAL_LOGIN=1</code> — with Azure, also show username/password (break-glass).</li>
      </ul>
      <div class="rounded-xl border border-indigo-200/80 bg-indigo-50/60 p-3 text-[11px] dark:border-indigo-500/30 dark:bg-indigo-950/35">
        <p class="font-black uppercase tracking-wider text-indigo-800 dark:text-indigo-200 text-[10px] mb-2">Values in your form right now</p>
        <dl class="grid gap-1.5 sm:grid-cols-2">
          <div><dt class="text-slate-500 dark:text-slate-500 font-bold">AUTH_MODE</dt><dd class="font-mono text-slate-900 dark:text-slate-100">${escapeAttr(mode)}</dd></div>
          <div><dt class="text-slate-500 dark:text-slate-500 font-bold">ALLOW_LOCAL_LOGIN</dt><dd class="font-mono text-slate-900 dark:text-slate-100">${escapeAttr(allowLocal || '—')}</dd></div>
          <div class="sm:col-span-2"><dt class="text-slate-500 dark:text-slate-500 font-bold">PUBLIC_BASE_URL</dt><dd class="font-mono break-all text-slate-900 dark:text-slate-100">${escapeAttr(pub || '—')}</dd></div>
          <div class="sm:col-span-2"><dt class="text-slate-500 dark:text-slate-500 font-bold">REDIRECT_URI</dt><dd class="font-mono break-all text-slate-900 dark:text-slate-100">${escapeAttr(redir || '—')}</dd></div>
        </dl>
      </div>
      <p class="text-[11px] text-amber-800 dark:text-amber-200/90">Changing auth mode or Azure secrets requires restarting the Node process on the server (for example <code class="text-[10px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">pm2 restart all</code>).</p>
    </div>`;
  }

  function buildWizardBrandHtml() {
    const t = document.getElementById('brandSiteTitle')?.value?.trim() || '';
    const tag = document.getElementById('brandHeaderTagline')?.value?.trim() || '';
    const logo = document.getElementById('brandLogoUrl')?.value?.trim() || '';
    return `<div class="space-y-3">
      <p class="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">Match login and dashboards to your org: title, tagline, favicon, and logo appear across the product.</p>
      <div class="rounded-xl border border-emerald-200/80 bg-emerald-50/50 p-3 dark:border-emerald-500/25 dark:bg-emerald-950/30">
        <p class="text-[10px] font-black uppercase tracking-wider text-emerald-800 dark:text-emerald-300 mb-2">Draft in the form</p>
        <ul class="text-[11px] space-y-1 text-slate-700 dark:text-slate-300">
          <li><strong>Site title:</strong> ${t ? escapeAttr(t) : '<span class="italic text-slate-500">not set</span>'}</li>
          <li><strong>Tagline:</strong> ${tag ? escapeAttr(tag) : '<span class="italic text-slate-500">not set</span>'}</li>
          <li><strong>Logo URL:</strong> ${logo ? escapeAttr(logo) : '<span class="italic text-slate-500">default</span>'}</li>
        </ul>
      </div>
    </div>`;
  }

  function buildWizardJiraHtml() {
    const d = getEnvTrim('JIRA_DOMAIN');
    const e = getEnvTrim('JIRA_EMAIL');
    const tokEl = document.getElementById('env_JIRA_TOKEN');
    const tokHint = tokEl && tokEl.placeholder && tokEl.placeholder.includes('saved');
    return `<div class="space-y-3">
      ${wizardNeedsJira ? '<div class="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-950 dark:border-amber-500/50 dark:bg-amber-950/40 dark:text-amber-100"><strong>Next action:</strong> Finish Jira URL, email, and API token, then <strong>Test Jira</strong>.</div>' : '<div class="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-950 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-100">Jira test passed with current saved settings.</div>'}
      <p class="text-xs text-slate-600 dark:text-slate-400">Dashboards consume sprint markdown from the export job; it reads the same <code class="text-[10px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">Product/.env</code> as the server. <strong class="text-slate-700 dark:text-slate-300">Sprints to export</strong> is set per project under Projects.</p>
      <dl class="rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-[11px] dark:border-white/10 dark:bg-slate-950/50 grid gap-2">
        <div><dt class="font-bold text-slate-500">JIRA_DOMAIN</dt><dd class="font-mono">${escapeAttr(d || '—')}</dd></div>
        <div><dt class="font-bold text-slate-500">JIRA_EMAIL</dt><dd class="font-mono">${escapeAttr(e || '—')}</dd></div>
        <div><dt class="font-bold text-slate-500">API token</dt><dd>${tokHint ? '<span class="text-emerald-700 dark:text-emerald-400">Saved on disk (masked in field)</span>' : tokEl && tokEl.value ? '<span class="text-slate-600">Visible in form</span>' : '<span class="text-amber-700 dark:text-amber-300">Not shown in the field until you type a new value</span>'}</dd></div>
      </dl>
    </div>`;
  }

  function buildWizardConnectorsHtml() {
    const map = [
      ['conn_confluence', 'Confluence', 'Same Jira token'],
      ['conn_github', 'GitHub', 'TOKEN + ORG'],
      ['conn_copilot', 'GitHub Copilot', 'Needs ENT slug'],
      ['conn_cursor', 'Cursor', 'Analytics token'],
      ['conn_testrail', 'TestRail', 'Domain + API key'],
      ['conn_openrouter', 'OpenRouter', 'LLM features'],
    ];
    const rows = map
      .map(([id, name, note]) => {
        const on = connectorOn(id);
        return `<li class="flex flex-wrap gap-x-2 gap-y-0.5 justify-between border-b border-slate-100 pb-1.5 dark:border-white/5"><span><span class="font-bold ${on ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-400'}">${on ? '?' : '?'}</span> ${name}</span><span class="text-slate-500 text-[10px]">${note}</span></li>`;
      })
      .join('');
    return `<div class="space-y-3">
      <p class="text-xs text-slate-600 dark:text-slate-400">Enable only integrations you license. The export script skips anything turned off.</p>
      <ul class="rounded-xl border border-slate-200 bg-white/90 p-3 dark:border-white/10 dark:bg-slate-950/40 space-y-1.5 text-[11px] list-none">${rows}</ul>
      <p class="text-[11px] text-slate-500">Save toggles, add credentials, run <strong>Test enabled connectors</strong>.</p>
    </div>`;
  }

  function buildWizardProjectsHtml() {
    const projs = projectsData.projects || [];
    const active = projs.filter((p) => p.active !== false);
    const lines = active.slice(0, 4).map((p) => {
      const sc = p.sprintCount != null && p.sprintCount !== '' ? p.sprintCount : 3;
      return `<li class="font-mono text-[11px]">${escapeAttr(p.key || '')} — ${escapeAttr(p.name || '')} <span class="text-slate-500">(${escapeAttr(String(sc))} sprint(s))</span></li>`;
    });
    return `<div class="space-y-3">
      <p class="text-xs text-slate-600 dark:text-slate-400">Each row is a Jira project / board. Board ID, stage names, and <strong class="text-slate-700 dark:text-slate-300">sprints to export</strong> (in row details) must match how you run the export.</p>
      <p class="text-[11px] font-bold text-slate-700 dark:text-slate-300">${active.length} active project(s) · ${projs.length} total row(s)</p>
      ${lines.length ? `<ul class="list-disc pl-4 space-y-0.5">${lines.join('')}${active.length > 4 ? '<li class="text-slate-500 italic">…</li>' : ''}</ul>` : '<p class="text-[11px] italic text-amber-700 dark:text-amber-400">No projects yet — add a row in the table.</p>'}
    </div>`;
  }

  function buildWizardScoringHtml() {
    const hint = document.getElementById('scoringFileHint')?.textContent?.trim() || 'dashboard-scoring.template.json';
    return `<div class="space-y-3">
      <p class="text-xs text-slate-600 dark:text-slate-400">Adjust health-matrix pillars and Dev/QA weights when stakeholders care about different signals. Defaults are production-ready.</p>
      <p class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-mono text-slate-600 dark:border-white/10 dark:bg-slate-950/50 dark:text-slate-400 break-words">${escapeAttr(hint)}</p>
    </div>`;
  }

  function buildWizardSecurityHtml() {
    const https = document.getElementById('env_USE_HTTPS_display')?.value?.trim() || '';
    const cert = document.getElementById('env_SSL_CERT_PATH_display')?.value?.trim() || '';
    return `<div class="space-y-3">
      <p class="text-xs text-slate-600 dark:text-slate-400">Upload a certificate chain + private key for Node TLS, or terminate SSL upstream and keep HTTP locally.</p>
      <dl class="text-[11px] space-y-1">
        <div><dt class="font-bold text-slate-500">USE_HTTPS</dt><dd class="font-mono">${escapeAttr(https || '—')}</dd></div>
        <div><dt class="font-bold text-slate-500">Certificate path</dt><dd class="font-mono break-all">${escapeAttr(cert || '—')}</dd></div>
      </dl>
    </div>`;
  }

  function buildWizardFinishHtml() {
    const dsj = document.getElementById('dsjEnabled')?.checked;
    const ms = lastAuthCfg || {};
    return `<div class="space-y-3">
      <p class="text-xs text-slate-600 dark:text-slate-400 leading-relaxed"><strong>Wrap up.</strong> Control who is admin and how often data refreshes.</p>
      <div class="grid gap-2">
        <div class="rounded-xl border border-slate-200 bg-white/90 p-3 dark:border-white/10 dark:bg-slate-950/40">
          <p class="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1">Manage users</p>
          <p class="text-[11px] text-slate-600 dark:text-slate-400">Microsoft: allow-list display names for admin. Local: create accounts &amp; roles. ${ms.microsoftLoginAvailable && ms.localLoginAvailable ? 'Both paths are enabled.' : ms.microsoftLoginAvailable ? 'SSO only right now.' : ms.localLoginAvailable ? 'Local accounts only.' : 'Configure Platform &amp; SSO first.'}</p>
        </div>
        <div class="rounded-xl border border-slate-200 bg-white/90 p-3 dark:border-white/10 dark:bg-slate-950/40">
          <p class="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1">Data sync job</p>
          <p class="text-[11px] text-slate-600 dark:text-slate-400">${dsj ? 'PM2 scheduled sync is <strong class="text-emerald-700 dark:text-emerald-400">on</strong>.' : 'Optional PM2 + cron keeps exports fresh without manual runs.'}</p>
        </div>
      </div>
      <p class="text-[11px] text-indigo-700 dark:text-indigo-300 font-semibold">That is the full tour — use <strong>Wizard mode</strong> anytime from the sidebar.</p>
    </div>`;
  }

  function wizardStepDefinitions() {
    return [
      { title: 'Setup wizard', subtitle: 'From sign-in to live dashboards', section: null, editLabel: '', body: buildWizardWelcomeHtml },
      { title: 'Sign-in & identity', subtitle: 'Microsoft SSO, local login, or both', section: 'general', editLabel: 'Open Platform & SSO', body: buildWizardIdentityHtml },
      { title: 'Brand & first impression', subtitle: 'Title, tagline, favicon, logo', section: 'branding', editLabel: 'Open branding', body: buildWizardBrandHtml },
      { title: 'Jira (required)', subtitle: 'Site, credentials, optional field IDs', section: 'setup', editLabel: 'Open Jira setup', body: buildWizardJiraHtml },
      { title: 'Integrations', subtitle: 'GitHub, Confluence, Cursor, TestRail…', section: 'connectors', editLabel: 'Open connectors', body: buildWizardConnectorsHtml },
      { title: 'Projects & boards', subtitle: 'Portfolio for the export job', section: 'projects', editLabel: 'Open projects', body: buildWizardProjectsHtml },
      { title: 'Scoring & health', subtitle: 'Matrix and leaderboard weights', section: 'scoring', editLabel: 'Open scoring', body: buildWizardScoringHtml },
      { title: 'HTTPS / SSL', subtitle: 'Production certificates', section: 'security', editLabel: 'Open SSL', body: buildWizardSecurityHtml },
      { title: 'People & automation', subtitle: 'RBAC, users, scheduled sync', section: 'users', editLabel: 'Open users', body: buildWizardFinishHtml },
    ];
  }

  function renderWizardStep() {
    const steps = wizardStepDefinitions();
    const step = steps[wizardStepIndex];
    if (!step) return;
    const tEl = document.getElementById('wizardTitle');
    const sEl = document.getElementById('wizardSubtitle');
    const bEl = document.getElementById('wizardBody');
    const pEl = document.getElementById('wizardProgress');
    const prevB = document.getElementById('wizardPrevBtn');
    const nextB = document.getElementById('wizardNextBtn');
    const editB = document.getElementById('wizardEditSectionBtn');
    if (tEl) tEl.textContent = step.title;
    if (sEl) sEl.textContent = step.subtitle;
    if (bEl) bEl.innerHTML = step.body();
    const total = steps.length;
    const pct = Math.round(((wizardStepIndex + 1) / total) * 100);
    if (pEl) {
      pEl.innerHTML = `<div class="flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400"><span>Step ${wizardStepIndex + 1} of ${total}</span><span>${pct}%</span></div><div class="mt-1.5 h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden"><div class="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-300" style="width:${pct}%"></div></div>`;
    }
    if (prevB) prevB.disabled = wizardStepIndex <= 0;
    if (nextB) nextB.textContent = wizardStepIndex >= total - 1 ? 'Done' : 'Next';
    if (editB) {
      if (step.section) {
        editB.classList.remove('hidden');
        editB.textContent = step.editLabel || 'Open settings panel';
      } else {
        editB.classList.add('hidden');
      }
    }
  }

  async function openSetupWizard() {
    wizardStepIndex = 0;
    const ov = document.getElementById('setupWizardOverlay');
    if (ov) ov.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    const bEl = document.getElementById('wizardBody');
    if (bEl) bEl.innerHTML = '<p class="text-xs text-slate-500 italic py-4 text-center">Loading snapshot…</p>';
    await refreshWizardSetupHealth();
    renderWizardStep();
  }

  function closeSetupWizard() {
    const ov = document.getElementById('setupWizardOverlay');
    if (ov) ov.classList.add('hidden');
    document.body.style.overflow = '';
  }

  function wizardOpenCurrentSection() {
    const steps = wizardStepDefinitions();
    const step = steps[wizardStepIndex];
    if (!step || !step.section) return;
    closeSetupWizard();
    setSection(step.section);
  }

  function onProjectFieldChange(ev) {
    const el = ev.target;
    const idx = Number(el.getAttribute('data-i'));
    const f = el.getAttribute('data-f');
    if (!projectsData.projects[idx]) return;
    if (f === 'active') projectsData.projects[idx].active = el.checked;
    else if (f === 'boardId') projectsData.projects[idx].boardId = el.value === '' ? null : Number(el.value);
    else if (f === 'sprintCount') {
      const n = parseInt(String(el.value || '').trim(), 10);
      projectsData.projects[idx].sprintCount = Number.isFinite(n) && n >= 1 ? Math.min(n, 99) : 3;
    } else if (f === 'fullOverwrite') projectsData.projects[idx].overwriteexistingdatafiles = el.checked === true;
    else if (f === 'testRailProjectIds') {
      projectsData.projects[idx].testRailProjectIds = String(el.value || '')
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number(s))
        .filter((n) => !Number.isNaN(n));
    } else projectsData.projects[idx][f] = el.value;
  }

  function addProjectRow() {
    const newIdx = projectsData.projects.length;
    projectsData.projects.push({
      active: true,
      key: '',
      name: '',
      boardId: null,
      parent: '',
      excludeWords: '',
      mustHave: '',
      manager: '',
      type: 'kanban',
      startStage: 'Ready for Dev',
      endStage: 'Ready for Staging',
      sprintCount: 3,
      testRailProjectIds: [],
      workClassificationFieldId: '',
      overwriteexistingdatafiles: false,
    });
    projectsExpanded.add(newIdx);
    renderProjects();
  }

  function deleteProject(idx) {
    projectsData.projects.splice(idx, 1);
    const next = new Set();
    projectsExpanded.forEach((i) => {
      if (i < idx) next.add(i);
      else if (i > idx) next.add(i - 1);
    });
    projectsExpanded = next;
    renderProjects();
  }

  async function testProject(idx) {
    const p = projectsData.projects[idx];
    if (!p) return;
    try {
      const r = await api('POST', '/api/admin/config/projects/test', { key: p.key, boardId: p.boardId });
      showToast(r.message || (r.ok ? 'OK' : 'Failed'), !r.ok);
    } catch (e) {
      showToast(e.message, true);
    }
  }

  async function saveProjects() {
    try {
      await api('PUT', '/api/admin/config/projects', projectsData);
      showToast('Projects saved');
      await loadProjects();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  let rbacData = null;

  function renderLocalUsersTable() {
    const tbody = document.getElementById('localUsersBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    (rbacData.localUsers || []).forEach((u) => {
          const tr = document.createElement('tr');
          tr.className = 'border-b border-slate-200 dark:border-white/5';
          tr.innerHTML = `
            <td class="p-2 text-sm text-slate-800 dark:text-slate-200">${escapeAttr(u.username)}</td>
            <td class="p-2"><select data-lu="${escapeAttr(u.username)}" class="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100">
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
              <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>viewer</option>
            </select></td>
            <td class="p-2"><input data-dn="${escapeAttr(u.username)}" class="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:bg-slate-900/80 dark:border-slate-700 dark:text-slate-100" value="${escapeAttr(u.displayName || '')}"></td>
            <td class="p-2 space-x-2">
              <button type="button" data-rp="${escapeAttr(u.username)}" class="text-amber-800 hover:underline dark:text-amber-400 text-xs font-bold uppercase">Reset PW</button>
              <button type="button" data-du="${escapeAttr(u.username)}" class="text-red-600 hover:underline dark:text-red-400 text-xs font-bold uppercase">Delete</button>
            </td>`;
          tbody.appendChild(tr);
        });
        tbody.querySelectorAll('select[data-lu]').forEach((sel) => {
          sel.addEventListener('change', async () => {
            try {
              await api('PATCH', '/api/admin/local-users/' + encodeURIComponent(sel.getAttribute('data-lu')), {
                role: sel.value,
              });
              showToast('Role updated');
              await loadRbac();
            } catch (e) {
              showToast(e.message, true);
            }
          });
        });
        tbody.querySelectorAll('input[data-dn]').forEach((inp) => {
          inp.addEventListener('blur', async () => {
            try {
              await api('PATCH', '/api/admin/local-users/' + encodeURIComponent(inp.getAttribute('data-dn')), {
                displayName: inp.value,
              });
              showToast('Display name saved');
            } catch (e) {
              showToast(e.message, true);
            }
          });
        });
        tbody.querySelectorAll('[data-rp]').forEach((b) => {
          b.addEventListener('click', async () => {
            const pw = window.prompt('New password (min 4 chars):');
            if (!pw || pw.length < 4) return;
            try {
              await api('POST', '/api/admin/local-users/' + encodeURIComponent(b.getAttribute('data-rp')) + '/reset-password', {
                newPassword: pw,
              });
              showToast('Password reset');
              await loadRbac();
            } catch (e) {
              showToast(e.message, true);
            }
          });
        });
        tbody.querySelectorAll('[data-du]').forEach((b) => {
          b.addEventListener('click', async () => {
            if (!window.confirm('Delete user ' + b.getAttribute('data-du') + '?')) return;
            try {
              await api('DELETE', '/api/admin/local-users/' + encodeURIComponent(b.getAttribute('data-du')));
              showToast('User deleted');
              await loadRbac();
            } catch (e) {
              showToast(e.message, true);
            }
          });
        });
  }

  async function loadRbac() {
    lastAuthCfg = await fetch('/api/auth/config', { credentials: 'same-origin' }).then((r) => r.json());
    rbacData = await api('GET', '/api/admin/config/rbac');
    const azurePanel = document.getElementById('rbacAzurePanel');
    const localPanel = document.getElementById('rbacLocalPanel');
    const showAzure = !!lastAuthCfg.microsoftLoginAvailable;
    const showLocal = !!lastAuthCfg.localLoginAvailable;
    azurePanel?.classList.toggle('hidden', !showAzure);
    localPanel?.classList.toggle('hidden', !showLocal);
    const summaryEl = document.getElementById('usersAuthSummaryBody');
    if (summaryEl) {
      const lines = [];
      if (showAzure) {
        lines.push(
          '<strong>Microsoft sign-in is on.</strong> The block below maps display names to <strong>admin</strong> (everyone else uses the default role in <code class="text-[11px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">rbac.json</code>). If <code class="text-[11px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">roles.admin</code> is empty or the file is missing, Microsoft users stay <strong>viewers</strong> until you add names and save.'
        );
      } else {
        lines.push(
          '<strong>Microsoft sign-in is off</strong> (local-only auth, or Azure is not configured). The Microsoft admin list is hidden.'
        );
      }
      if (showLocal) {
        lines.push(
          '<strong>Username/password is on.</strong> Use <strong>Local accounts</strong> to add users; data is stored in <code class="text-[11px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">rbac.json</code>. If that file did not exist and local sign-in is allowed, the server creates it on startup with user <code class="text-[11px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">admin</code> / <code class="text-[11px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">admin</code> when there are no local users yet.'
        );
      } else {
        lines.push('<strong>Username/password is off</strong> for this deployment (no local panel).');
      }
      if (showAzure && showLocal) {
        lines.push('Both methods can be enabled at once; the same <code class="text-[11px] font-mono bg-slate-100 px-1 rounded dark:bg-slate-800">rbac.json</code> holds Microsoft admin names and local password accounts.');
      }
      summaryEl.innerHTML = lines.join(' ');
    }
    if (showAzure) {
      const ta = document.getElementById('rbacAdminNames');
      if (ta && rbacData.roles && rbacData.roles.admin) {
        ta.value = rbacData.roles.admin.join('\n');
      }
    }
    if (showLocal) renderLocalUsersTable();
  }

  async function saveRbac() {
    if (!lastAuthCfg.microsoftLoginAvailable) return;
    const lines = document.getElementById('rbacAdminNames')?.value.split('\n').map((s) => s.trim()).filter(Boolean) || [];
    try {
      await api('PUT', '/api/admin/config/rbac', {
        version: rbacData.version || 1,
        defaultRole: rbacData.defaultRole || 'viewer',
        roles: { admin: lines },
      });
      showToast('RBAC saved');
      await loadRbac();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  async function addLocalUser() {
    const username = document.getElementById('newLocalUsername')?.value.trim();
    const password = document.getElementById('newLocalPassword')?.value || '';
    const role = document.getElementById('newLocalRole')?.value || 'viewer';
    const displayName = document.getElementById('newLocalDisplay')?.value.trim() || username;
    if (!username || password.length < 4) {
      showToast('Username and password (4+ chars) required', true);
      return;
    }
    try {
      await api('POST', '/api/admin/local-users', { username, password, role, displayName });
      showToast('User created');
      document.getElementById('newLocalUsername').value = '';
      document.getElementById('newLocalPassword').value = '';
      await loadRbac();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  let brandingFaviconBlobUrl = null;
  let brandingLogoBlobUrl = null;

  function revokeBrandingBlobUrl(kind) {
    if (kind === 'favicon' && brandingFaviconBlobUrl) {
      URL.revokeObjectURL(brandingFaviconBlobUrl);
      brandingFaviconBlobUrl = null;
    }
    if (kind === 'logo' && brandingLogoBlobUrl) {
      URL.revokeObjectURL(brandingLogoBlobUrl);
      brandingLogoBlobUrl = null;
    }
  }

  function resetBrandingFilePreview(kind) {
    revokeBrandingBlobUrl(kind);
    const isFav = kind === 'favicon';
    const img = document.getElementById(isFav ? 'brandFaviconFilePreviewImg' : 'brandLogoFilePreviewImg');
    const ph = document.getElementById(isFav ? 'brandFaviconFilePreviewPlaceholder' : 'brandLogoFilePreviewPlaceholder');
    if (img) {
      img.classList.add('hidden');
      img.removeAttribute('src');
    }
    if (ph) {
      ph.classList.remove('hidden');
      ph.textContent = 'Choose a file';
    }
  }

  function setBrandingFilePreviewFromPick(kind, file) {
    const isFav = kind === 'favicon';
    const img = document.getElementById(isFav ? 'brandFaviconFilePreviewImg' : 'brandLogoFilePreviewImg');
    const ph = document.getElementById(isFav ? 'brandFaviconFilePreviewPlaceholder' : 'brandLogoFilePreviewPlaceholder');
    revokeBrandingBlobUrl(kind);
    if (!img || !ph) return;
    if (!file) {
      img.classList.add('hidden');
      ph.classList.remove('hidden');
      ph.textContent = 'Choose a file';
      img.removeAttribute('src');
      return;
    }
    const url = URL.createObjectURL(file);
    if (isFav) brandingFaviconBlobUrl = url;
    else brandingLogoBlobUrl = url;
    img.onerror = function () {
      img.classList.add('hidden');
      ph.classList.remove('hidden');
      ph.textContent = 'Preview failed';
    };
    img.src = url;
    img.classList.remove('hidden');
    ph.classList.add('hidden');
  }

  function refreshBrandingPreview() {
    const titleEl = document.getElementById('brandSiteTitle');
    const logoEl = document.getElementById('brandLogoUrl');
    const favEl = document.getElementById('brandFaviconUrl');
    const pt = document.getElementById('brandPreviewTitle');
    const pl = document.getElementById('brandPreviewLogo');
    const pf = document.getElementById('brandPreviewFavicon');
    const title = (titleEl && titleEl.value.trim()) || '—';
    const logo = (logoEl && logoEl.value.trim()) || '/logo.svg';
    const fav = favEl && favEl.value.trim();
    if (pt) pt.textContent = title;
    if (pl) {
      pl.onerror = function () {
        pl.onerror = null;
        pl.src = '/logo.svg';
      };
      pl.src = logo;
    }
    if (pf) {
      if (fav) {
        pf.classList.remove('hidden');
        pf.onerror = function () {
          pf.classList.add('hidden');
        };
        pf.src = fav;
      } else {
        pf.classList.add('hidden');
        pf.removeAttribute('src');
      }
    }

    const favUrlImg = document.getElementById('brandFaviconUrlPreviewImg');
    const favUrlPh = document.getElementById('brandFaviconUrlPreviewPlaceholder');
    if (favUrlImg && favUrlPh) {
      if (!fav) {
        favUrlImg.classList.add('hidden');
        favUrlPh.classList.remove('hidden');
        favUrlPh.textContent = 'No URL yet';
        favUrlImg.removeAttribute('src');
      } else {
        favUrlPh.classList.add('hidden');
        favUrlImg.classList.remove('hidden');
        favUrlImg.onerror = function () {
          favUrlImg.classList.add('hidden');
          favUrlPh.classList.remove('hidden');
          favUrlPh.textContent = 'Could not load';
        };
        favUrlImg.src = fav;
      }
    }

    const logoUrlImg = document.getElementById('brandLogoUrlPreviewImg');
    const logoUrlPh = document.getElementById('brandLogoUrlPreviewPlaceholder');
    const logoForSection = (logoEl && logoEl.value.trim()) || '/logo.svg';
    if (logoUrlImg && logoUrlPh) {
      logoUrlPh.classList.add('hidden');
      logoUrlImg.classList.remove('hidden');
      logoUrlImg.onerror = function () {
        logoUrlImg.classList.add('hidden');
        logoUrlPh.classList.remove('hidden');
        logoUrlPh.textContent = 'Could not load';
      };
      logoUrlImg.src = logoForSection;
    }
  }

  async function loadBranding() {
    try {
      const b = await api('GET', '/api/admin/config/branding');
      const st = document.getElementById('brandSiteTitle');
      const ht = document.getElementById('brandHeaderTagline');
      const fv = document.getElementById('brandFaviconUrl');
      const lu = document.getElementById('brandLogoUrl');
      if (st) st.value = b.siteTitle || '';
      if (ht) ht.value = b.headerTagline || '';
      if (fv) fv.value = b.faviconUrl || '';
      if (lu) lu.value = b.logoUrl || '';
      refreshBrandingPreview();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  async function saveBranding() {
    try {
      await api('PUT', '/api/admin/config/branding', {
        siteTitle: document.getElementById('brandSiteTitle')?.value ?? '',
        headerTagline: document.getElementById('brandHeaderTagline')?.value ?? '',
        faviconUrl: document.getElementById('brandFaviconUrl')?.value ?? '',
        logoUrl: document.getElementById('brandLogoUrl')?.value ?? '',
      });
      showToast('Logo, icon & title saved');
      refreshBrandingPreview();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  async function uploadBrandingFile(kind) {
    const id = kind === 'favicon' ? 'brandFaviconFile' : 'brandLogoFile';
    const inp = document.getElementById(id);
    const file = inp?.files?.[0];
    if (!file) {
      showToast('Choose a file first', true);
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch('/api/admin/config/branding/upload?kind=' + encodeURIComponent(kind), {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      if (j.config) {
        const fv = document.getElementById('brandFaviconUrl');
        const lu = document.getElementById('brandLogoUrl');
        if (fv) fv.value = j.config.faviconUrl || '';
        if (lu) lu.value = j.config.logoUrl || '';
      }
      showToast(kind + ' uploaded');
      inp.value = '';
      resetBrandingFilePreview(kind);
      refreshBrandingPreview();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  /** @type {object|null} */
  let scoringDraft = null;

  /** Fallbacks when API payload omits weights (must match dashboard-scoring.template.json). */
  const SCORING_QA_WEIGHT_DEFAULTS = {
    VOLUME: 0.4,
    COVERAGE: 0.3,
    AUTHORSHIP: 0.1,
    CONSISTENCY: 0.05,
    COMPLEXITY: 0.1,
    DOCS: 0.05,
  };

  function scoringWeightOrDefault(map, key, def) {
    const x = Number(map && map[key]);
    return Number.isFinite(x) ? x : def;
  }

  function scoringSetPath(obj, path, val) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const p = parts[i];
      if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = val;
  }

  function scoringSliderHtml(label, hint, path, value, min, max, step, scale, sumGroup) {
    let n = Number(value);
    if (!Number.isFinite(n)) n = 0;
    const display =
      scale === 'pct01' || scale === 'cent'
        ? `${Math.round(n * 100)}%`
        : scale === 'int'
          ? String(Math.round(n))
          : String(n.toFixed(2));
    const v =
      scale === 'pct01'
        ? Math.round(n * 100)
        : scale === 'cent'
          ? Math.round(n * 100)
          : n;
    const id = `sc_${path.replace(/\./g, '_')}`;
    const sumAttr = sumGroup ? ` data-scoring-sum-group="${sumGroup}"` : '';
    return `
      <div class="score-admin-slider group">
        <div class="flex justify-between gap-3 items-baseline mb-1.5">
          <div class="min-w-0">
            <label class="text-[11px] font-bold text-slate-800 dark:text-slate-200" for="${id}">${label}</label>
            ${hint ? `<p class="text-[10px] text-slate-500 dark:text-slate-500 mt-0.5 leading-snug">${hint}</p>` : ''}
          </div>
          <span class="shrink-0 text-xs font-black tabular-nums text-indigo-600 dark:text-indigo-300 tracking-tight" data-scoring-readout="${path}">${display}</span>
        </div>
        <input type="range" id="${id}" class="admin-beautiful-range w-full" data-scoring-path="${path}" data-scoring-scale="${scale}"${sumAttr}
          min="${min}" max="${max}" step="${step}" value="${v}">
      </div>`;
  }

  function scoringSection(title, blurb, innerHtml, sectionOpts) {
    const opts = sectionOpts || {};
    const head = opts.weightTotalGroup
      ? `<div class="flex flex-wrap items-start justify-between gap-3 mb-2">
          <h3 class="text-[10px] font-black uppercase tracking-[0.2em] text-slate-700 dark:text-slate-300 flex-1 min-w-[10rem]">${title}</h3>
          <div class="shrink-0 text-right rounded-lg border border-slate-200/90 bg-white/80 px-3 py-2 dark:border-white/10 dark:bg-slate-900/40">
            <p class="text-[9px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400">S weights</p>
            <p class="text-base font-black tabular-nums leading-tight tracking-tight text-slate-800 dark:text-slate-100 transition-colors" data-scoring-section-total="${opts.weightTotalGroup}" title="Sum of sliders in this section (target 100%)">—</p>
          </div>
        </div>`
      : `<h3 class="text-[10px] font-black uppercase tracking-[0.2em] text-slate-700 dark:text-slate-300 mb-1">${title}</h3>`;
    return `
      <section class="rounded-xl border border-slate-200/90 bg-slate-50/80 p-4 dark:border-white/10 dark:bg-slate-950/40">
        ${head}
        ${blurb ? `<p class="text-[11px] text-slate-600 dark:text-slate-500 mb-4">${blurb}</p>` : ''}
        <div class="space-y-4">${innerHtml}</div>
      </section>`;
  }

  function updateScoringWeightTotals(mount) {
    if (!mount) return;
    const sums = Object.create(null);
    mount.querySelectorAll('input[data-scoring-sum-group]').forEach((inp) => {
      const g = inp.getAttribute('data-scoring-sum-group');
      if (!g) return;
      const scale = inp.getAttribute('data-scoring-scale');
      let raw = Number(inp.value);
      if (!Number.isFinite(raw)) raw = 0;
      let frac = raw;
      if (scale === 'pct01' || scale === 'cent') frac = raw / 100;
      sums[g] = (sums[g] || 0) + frac;
    });
    mount.querySelectorAll('[data-scoring-section-total]').forEach((el) => {
      const g = el.getAttribute('data-scoring-section-total');
      const sum = sums[g] || 0;
      const pct = Math.round(sum * 100);
      el.textContent = `${pct}%`;
      el.classList.remove(
        'text-emerald-600',
        'dark:text-emerald-400',
        'text-amber-600',
        'dark:text-amber-400',
        'text-rose-600',
        'dark:text-rose-400',
        'text-slate-800',
        'dark:text-slate-100',
      );
      if (pct === 100) {
        el.classList.add('text-emerald-600', 'dark:text-emerald-400');
      } else if (pct >= 98 && pct <= 102) {
        el.classList.add('text-amber-600', 'dark:text-amber-400');
      } else if (pct < 85 || pct > 115) {
        el.classList.add('text-rose-600', 'dark:text-rose-400');
      } else {
        el.classList.add('text-slate-800', 'dark:text-slate-100');
      }
    });
  }

  function renderDashboardScoringForm() {
    const mount = document.getElementById('scoringFormMount');
    if (!mount || !scoringDraft) return;
    function sliderSliderInt(label, path, val) {
      return scoringSliderHtml(label, '', path, val, 0, 100, 1, 'int');
    }
    /** Integer 0–10 for Dev/Qa display tier cutoffs (scores are /10). */
    function sliderSlider010(label, path, val) {
      const v = Math.min(10, Math.max(0, Math.round(Number(val)) || 0));
      return scoringSliderHtml(label, '', path, v, 0, 10, 1, 'int');
    }
    const hm = scoringDraft.healthMatrix || {};
    const hw = hm.weights || {};
    const hb = hm.benchmarks || {};
    const dm = scoringDraft.devData || {};
    const dw = dm.weights || {};
    const dmt = dm.displayTiers || {};
    const qa = scoringDraft.qaData || {};
    const qw = qa.weights || {};
    const qmt = qa.displayTiers || {};
    const qdb = qa.bands || {};

    const healthWeights = scoringSection(
      'Health matrix — pillar weights',
      'Relative importance when combining delivery, flow, stability, quality, risk, and AI adoption. Available dimensions are renormalized automatically.',
      [
        ['Delivery (completion %)', 'healthMatrix.weights.DELIVERY_WEIGHT', hw.DELIVERY_WEIGHT],
        ['Flow (cycle time)', 'healthMatrix.weights.FLOW_WEIGHT', hw.FLOW_WEIGHT],
        ['Stability (carry-over)', 'healthMatrix.weights.STABILITY_WEIGHT', hw.STABILITY_WEIGHT],
        ['Quality (bug fix rate)', 'healthMatrix.weights.QUALITY_WEIGHT', hw.QUALITY_WEIGHT],
        ['Risk (blockers)', 'healthMatrix.weights.RISK_WEIGHT', hw.RISK_WEIGHT],
        ['AI adoption', 'healthMatrix.weights.AI_ADOPTION_WEIGHT', hw.AI_ADOPTION_WEIGHT],
      ]
        .map(([label, path, val]) => scoringSliderHtml(label, '', path, val, 0, 100, 1, 'pct01', 'healthPillars'))
        .join(''),
      { weightTotalGroup: 'healthPillars' },
    );

    const healthBands = scoringSection(
      'Health matrix — score bands (0–100 ? dot color / Stellar…Breach)',
      'Each pillar and the overall rating use these thresholds on a 0–100 sub-score. Keep Elite &gt; Strong &gt; Stable &gt; At risk.',
      [
        ['Elite (Stellar) =', 'healthMatrix.benchmarks.COMPOSITE_ELITE', hb.COMPOSITE_ELITE],
        ['Strong (Surge) =', 'healthMatrix.benchmarks.COMPOSITE_STRONG', hb.COMPOSITE_STRONG],
        ['Stable (Cruise) =', 'healthMatrix.benchmarks.COMPOSITE_STABLE', hb.COMPOSITE_STABLE],
        ['At risk (Friction) =', 'healthMatrix.benchmarks.COMPOSITE_AT_RISK', hb.COMPOSITE_AT_RISK],
      ]
        .map(([label, path, val]) => sliderSliderInt(label, path, val))
        .join(''),
    );

    const devMainSliders = [
      ['Combined dev-tools max', 'devData.combinedToolsMaxWeight', dm.combinedToolsMaxWeight, 0, 50, 1, 'cent'],
      ['Story points (delivery)', 'devData.weights.DELIVERY', dw.DELIVERY],
      ['GitHub impact', 'devData.weights.GITHUB_IMPACT', dw.GITHUB_IMPACT],
      ['GitHub quality', 'devData.weights.GITHUB_QUALITY', dw.GITHUB_QUALITY],
      ['Consistency', 'devData.weights.CONSISTENCY', dw.CONSISTENCY],
      ['Impact breadth', 'devData.weights.IMPACT_BREADTH', dw.IMPACT_BREADTH],
      ['Confluence docs', 'devData.weights.CONFLUENCE_DOCS', dw.CONFLUENCE_DOCS],
      ['Cursor leaderboard', 'devData.weights.CURSOR_LEADERBOARD', dw.CURSOR_LEADERBOARD],
      ['Copilot individual', 'devData.weights.COPILOT_INDIVIDUAL', dw.COPILOT_INDIVIDUAL],
      ['AI tools adoption', 'devData.weights.AI_TOOLS_ADOPTION', dw.AI_TOOLS_ADOPTION],
    ]
      .map((row, i) => {
        if (i === 0) {
          return scoringSliderHtml(row[0], 'Cap for Cursor + Copilot + AI adoption (displayed as %)', row[1], row[2], row[3], row[4], row[5], row[6]);
        }
        return scoringSliderHtml(row[0], '', row[1], row[2], 0, 100, 1, 'pct01', 'devresourceWeights');
      })
      .join('');
    const devMainTiers =
      '<div class="mt-6 pt-4 border-t border-slate-200/80 dark:border-white/10">' +
      '<p class="text-[10px] font-black uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-3">Dev score colors (0–10, main + project detail)</p>' +
      '<div class="space-y-4">' +
      [
        ['Good (green) =', 'devData.displayTiers.goodMin', dmt.goodMin],
        ['Mid (amber) =', 'devData.displayTiers.midMin', dmt.midMin],
        ['Low (neutral) =', 'devData.displayTiers.lowMin', dmt.lowMin],
      ]
        .map(([label, path, val]) => sliderSlider010(label, path, val))
        .join('') +
      '</div></div>';
    const devMain = scoringSection(
      'Dev data',
      'Single resource score (0–10) for the main dashboard and project detail. Cursor + Copilot + AI adoption share a combined cap.',
      devMainSliders + devMainTiers,
      { weightTotalGroup: 'devresourceWeights' },
    );

    const qaBlock = scoringSection(
      'QA data',
      'QA score is always 0–10. Weights drive the number; the next row tints the **main dashboard** score column; band thresholds drive **project detail** rank badges (Stellar / Surge / Cruise) using score × 10 on a 0–100 scale.',
      [
        ['Volume (QA story pts)', 'qaData.weights.VOLUME', scoringWeightOrDefault(qw, 'VOLUME', SCORING_QA_WEIGHT_DEFAULTS.VOLUME)],
        ['Coverage (tickets)', 'qaData.weights.COVERAGE', scoringWeightOrDefault(qw, 'COVERAGE', SCORING_QA_WEIGHT_DEFAULTS.COVERAGE)],
        ['Authorship (TestRail)', 'qaData.weights.AUTHORSHIP', scoringWeightOrDefault(qw, 'AUTHORSHIP', SCORING_QA_WEIGHT_DEFAULTS.AUTHORSHIP)],
        ['Consistency (projects)', 'qaData.weights.CONSISTENCY', scoringWeightOrDefault(qw, 'CONSISTENCY', SCORING_QA_WEIGHT_DEFAULTS.CONSISTENCY)],
        ['Complexity (pts/ticket)', 'qaData.weights.COMPLEXITY', scoringWeightOrDefault(qw, 'COMPLEXITY', SCORING_QA_WEIGHT_DEFAULTS.COMPLEXITY)],
        ['Docs (Confluence)', 'qaData.weights.DOCS', scoringWeightOrDefault(qw, 'DOCS', SCORING_QA_WEIGHT_DEFAULTS.DOCS)],
      ]
        .map(([label, path, val]) => scoringSliderHtml(label, '', path, val, 0, 100, 1, 'pct01', 'qaWeights'))
        .join('') +
        '<div class="mt-4 pt-4 border-t border-slate-200/80 dark:border-white/10 space-y-4">' +
        '<p class="text-[10px] font-black uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-2">Main QA leaderboard — score column colors (0–10)</p>' +
        '<p class="text-[10px] text-slate-500 dark:text-slate-500 mb-3 leading-snug">If someone&rsquo;s QA score is <strong>= Good</strong>, the score is green; if <strong>= Mid</strong> (but below Good), amber; otherwise neutral. Same scale as the score (not the Stellar/Surge bands below).</p>' +
        [
          ['Good (green) — minimum score', 'qaData.displayTiers.goodMin', qmt.goodMin],
          ['Mid (amber) — minimum score', 'qaData.displayTiers.midMin', qmt.midMin],
        ]
          .map(([label, path, val]) => sliderSlider010(label, path, val))
          .join('') +
        '</div>' +
        '<div class="mt-4 pt-4 border-t border-slate-200/80 dark:border-white/10 space-y-4">' +
        '<p class="text-[10px] font-black uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-2">Band thresholds (0–100 scale; compare to score × 10)</p>' +
        [
          ['Stellar (green) =', 'qaData.bands.stellarMin', qdb.stellarMin],
          ['Surge (blue) =', 'qaData.bands.surgeMin', qdb.surgeMin],
          ['Cruise (amber) =', 'qaData.bands.cruiseMin', qdb.cruiseMin],
        ]
          .map(([label, path, val]) => sliderSliderInt(label, path, val))
          .join('') +
        '</div>',
      { weightTotalGroup: 'qaWeights' },
    );

    mount.innerHTML = healthWeights + healthBands + devMain + qaBlock;

    mount.querySelectorAll('[data-scoring-path]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const path = inp.getAttribute('data-scoring-path');
        const scale = inp.getAttribute('data-scoring-scale');
        const ro = mount.querySelector(`[data-scoring-readout="${path}"]`);
        if (ro) {
          let n = Number(inp.value);
          if (scale === 'pct01') ro.textContent = `${Math.round(n)}%`;
          else if (scale === 'cent') ro.textContent = `${Math.round(n)}%`;
          else ro.textContent = String(Math.round(n));
        }
        updateScoringWeightTotals(mount);
      });
    });
    updateScoringWeightTotals(mount);
  }

  function collectScoringFromForm() {
    const mount = document.getElementById('scoringFormMount');
    if (!mount || !scoringDraft) return null;
    const out = JSON.parse(JSON.stringify(scoringDraft));
    mount.querySelectorAll('[data-scoring-path]').forEach((inp) => {
      const path = inp.getAttribute('data-scoring-path');
      const scale = inp.getAttribute('data-scoring-scale');
      let v = Number(inp.value);
      if (scale === 'pct01') v = Math.min(1, Math.max(0, v / 100));
      else if (scale === 'cent') v = Math.min(0.5, Math.max(0, v / 100));
      else if (scale === 'int') v = Math.round(v);
      if (!Number.isFinite(v)) return;
      scoringSetPath(out, path, v);
    });
    return out;
  }

  async function loadDashboardScoring() {
    const hint = document.getElementById('scoringFileHint');
    try {
      const r = await api('GET', '/api/admin/config/dashboard-scoring');
      scoringDraft = r.config;
      if (hint) {
        const tpl = r.templatePath || 'jira-md-export/Template/dashboard-scoring.template.json';
        const live = r.livePath || 'jira-md-export/dashboard-scoring.json';
        hint.textContent = r.liveOverrideActive
          ? `Canonical: ${tpl} · active overrides: ${live}`
          : `Canonical: ${tpl} (Admin save updates this file). Optional overrides file ${live} is empty.`;
      }
      renderDashboardScoringForm();
    } catch (e) {
      if (hint) hint.textContent = e.message || 'Failed to load';
      showToast(e.message || 'Scoring load failed', true);
    }
  }

  async function saveDashboardScoring() {
    const body = collectScoringFromForm();
    if (!body) {
      showToast('Nothing to save', true);
      return;
    }
    try {
      await api('PUT', '/api/admin/config/dashboard-scoring', body);
      showToast('Scoring config saved to dashboard-scoring.template.json. Reload the dashboard or project page to apply.');
      await loadDashboardScoring();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  async function changePassword() {
    const cur = document.getElementById('pwCurrent')?.value || '';
    const next = document.getElementById('pwNew')?.value || '';
    if (next.length < 8) {
      showToast('New password min 8 characters', true);
      return;
    }
    try {
      await api('POST', '/api/auth/change-password', { currentPassword: cur, newPassword: next });
      showToast('Password changed');
      document.getElementById('pwCurrent').value = '';
      document.getElementById('pwNew').value = '';
    } catch (e) {
      showToast(e.message, true);
    }
  }

  init().catch((e) => showToast(e.message, true));
})();
