/**
 * Fetch /api/branding and apply site title, favicon, logo, header tagline.
 * Expects optional elements: link[rel="icon"], [data-brand-logo], #brandLoaderTitle,
 * #brandHeaderTitle (main dashboard H1 = site title), #brandHeaderTagline (optional subtitle)
 * Optional: <html data-brand-title-suffix="Explore"> → document title becomes "{siteTitle} — {suffix}"
 */
(function () {
  function apply(b) {
    if (!b || typeof b !== 'object') return;
    if (b.siteTitle) {
      if (document.body.classList.contains('login-page')) {
        document.title = 'Sign in — ' + b.siteTitle;
        var bt = document.getElementById('loginBrandTitle');
        if (bt) bt.textContent = b.siteTitle;
      } else if (document.body.id === 'adminSettingsPage') {
        document.title = 'Admin — ' + b.siteTitle;
      } else if (document.getElementById('brandLoaderTitle')) {
        document.title = b.siteTitle;
        var lt = document.getElementById('brandLoaderTitle');
        if (lt) lt.textContent = b.siteTitle;
      } else {
        var suffix = document.documentElement.getAttribute('data-brand-title-suffix');
        if (suffix) document.title = b.siteTitle + ' — ' + suffix;
        else document.title = b.siteTitle;
      }
    }
    if (b.faviconUrl) {
      document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]').forEach(function (icon) {
        icon.setAttribute('href', b.faviconUrl);
      });
    }
    var defaultLogo = '/logo.svg';
    document.querySelectorAll('[data-brand-logo]').forEach(function (img) {
      var fallback = img.getAttribute('data-default-logo') || defaultLogo;
      img.onerror = function () {
        img.onerror = null;
        if (img.src.indexOf(fallback) === -1) img.src = fallback;
      };
      if (b.logoUrl) img.src = b.logoUrl;
      else img.src = fallback;
      if (b.siteTitle) img.alt = b.siteTitle;
    });
    var mainTitle = document.getElementById('brandHeaderTitle');
    if (mainTitle && b.siteTitle) mainTitle.textContent = b.siteTitle;
    var tag = document.getElementById('brandHeaderTagline');
    if (tag) {
      var sub = b.headerTagline != null ? String(b.headerTagline).trim() : '';
      if (sub) {
        tag.textContent = sub;
        tag.classList.remove('hidden');
      } else {
        tag.textContent = '';
        tag.classList.add('hidden');
      }
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    fetch('/api/branding', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(apply)
      .catch(function () {});
  });
})();
