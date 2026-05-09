/**
 * Chart.js palette for Explore / resource Insights (and any page using class "theme-light" on <html>).
 * Improves tick, legend, and grid contrast on dark cards; ready for light UI when theme-light is added.
 */
(function (w) {
    function isLight() {
        try {
            return w.document && w.document.documentElement.classList.contains('theme-light');
        } catch (e) {
            return false;
        }
    }

    function palette() {
        if (isLight()) {
            return {
                tick: '#334155',
                tickStrong: '#1e293b',
                legend: '#334155',
                doughnutBorder: '#e2e8f0',
                grid: 'rgba(15, 23, 42, 0.12)',
                gridFaint: 'rgba(15, 23, 42, 0.08)',
                axisBorder: 'rgba(100, 116, 139, 0.35)',
                defaultsColor: '#475569',
                defaultsBorder: 'rgba(15, 23, 42, 0.1)',
            };
        }
        return {
            tick: '#e2e8f0',
            tickStrong: '#f8fafc',
            legend: '#e2e8f0',
            doughnutBorder: 'rgba(15, 23, 42, 0.45)',
            grid: 'rgba(148, 163, 184, 0.22)',
            gridFaint: 'rgba(148, 163, 184, 0.12)',
            axisBorder: 'rgba(148, 163, 184, 0.3)',
            defaultsColor: '#94a3b8',
            defaultsBorder: 'rgba(255, 255, 255, 0.08)',
        };
    }

    function tooltipTheme() {
        if (isLight()) {
            return {
                backgroundColor: 'rgba(255, 255, 255, 0.97)',
                titleColor: '#0f172a',
                bodyColor: '#334155',
                borderColor: 'rgba(148, 163, 184, 0.35)',
            };
        }
        return {
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            titleColor: '#f1f5f9',
            bodyColor: '#cbd5e1',
            borderColor: 'rgba(255, 255, 255, 0.12)',
        };
    }

    function pointOutline() {
        return isLight() ? '#ffffff' : '#0f172a';
    }

    function applyChartJsDefaults(Chart) {
        if (!Chart || !Chart.defaults) return;
        const p = palette();
        const tt = tooltipTheme();
        Chart.defaults.color = p.defaultsColor;
        Chart.defaults.borderColor = p.defaultsBorder;
        Chart.defaults.font.family = "'Inter', sans-serif";
        Chart.defaults.plugins.legend.labels.boxWidth = 12;
        Chart.defaults.plugins.legend.labels.padding = 14;
        Chart.defaults.plugins.legend.labels.color = p.legend;
        const tip = Chart.defaults.plugins.tooltip;
        if (tip) {
            Object.assign(tip, tt, {
                borderWidth: 1,
                titleFont: { weight: 'bold', size: 11 },
                bodyFont: { size: 11 },
                padding: 10,
                cornerRadius: 8,
            });
        }
    }

    w.SatelliteChartTheme = {
        isLight,
        palette,
        tooltipTheme,
        pointOutline,
        applyChartJsDefaults,
    };
})(typeof window !== 'undefined' ? window : globalThis);
