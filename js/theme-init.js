/**
 * theme-init.js — runs in <head> before any paint to pick the saved theme.
 *
 * Reads localStorage["dashboard-theme"] (default: "light") and:
 *   1. Toggles `theme-light` / `dark` classes on <html>.
 *   2. If a <link id="dashboardThemeCss"> is present, rewrites its href to
 *      the matching dashboard-dark.css / dashboard-light.css file.
 *
 * Must be loaded as a parser-blocking <script src="..."> so the body never
 * paints with the wrong theme. Keep this file dependency-free and tiny.
 */
(function () {
    try {
        var KEY = 'dashboard-theme';
        var t = localStorage.getItem(KEY);
        if (t !== 'dark' && t !== 'light') {
            t = 'light';
            localStorage.setItem(KEY, t);
        }
        var dark = t === 'dark';
        var root = document.documentElement;
        root.classList.toggle('theme-light', !dark);
        root.classList.toggle('dark', dark);

        var link = document.getElementById('dashboardThemeCss');
        if (link) {
            var href = link.getAttribute('href') || '';
            var target = dark
                ? href.replace(/dashboard-light\.css(\?.*)?$/, 'dashboard-dark.css$1')
                : href.replace(/dashboard-dark\.css(\?.*)?$/,  'dashboard-light.css$1');
            if (target && target !== href) {
                link.setAttribute('href', target);
            }
        }
    } catch (e) {
        /* non-fatal: theme just falls back to whatever the markup already has */
    }
})();
