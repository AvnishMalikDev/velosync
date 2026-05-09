/**
 * Regenerates css/dashboard-light.css from css/dashboard-dark.css + Tailwind utility bridge.
 * The light file is loaded alone (no html.theme-light selector wrapping).
 * Run from Product/: node build-light-style.mjs
 */
import fs from 'fs';

let css = fs.readFileSync('css/dashboard-dark.css', 'utf8');

const rawReplacements = [
  ['background: rgba(5, 7, 10, 0.97)', 'background: rgba(248, 250, 252, 0.97)'],
  ['background: #0d1117', 'background: #ffffff'],
  ['border: 1px solid rgba(51, 65, 85, 0.5)', 'border: 1px solid rgba(148, 163, 184, 0.45)'],
  ['0 32px 80px rgba(0,0,0,0.7)', '0 32px 80px rgba(15, 23, 42, 0.12)'],
  ['body { \n    background-color: #05070a; \n    color: #e2e8f0;', 'body { \n    background-color: #f1f5f9; \n    color: #0f172a;'],
  ['/* ── Global Dark Scrollbar ── */', '/* ── Global light Scrollbar ── */'],
  ['::-webkit-scrollbar-thumb { background: #1e293b;', '::-webkit-scrollbar-thumb { background: #cbd5e1;'],
  ['::-webkit-scrollbar-thumb:hover { background: #334155;', '::-webkit-scrollbar-thumb:hover { background: #94a3b8;'],
  ['scrollbar-color: #1e293b transparent', 'scrollbar-color: #94a3b8 transparent'],
  ['background: #1e293b', 'background: #e2e8f0'],
  ['background: rgba(15, 23, 42, 0.5)', 'background: rgba(248, 250, 252, 0.92)'],
  ['border: 1px solid rgba(51, 65, 85, 0.3)', 'border: 1px solid rgba(148, 163, 184, 0.35)'],
  ['background: rgba(15, 23, 42, 0.6)', 'background: rgba(241, 245, 249, 0.95)'],
  ['border: 1px solid rgba(255, 255, 255, 0.08)', 'border: 1px solid rgba(15, 23, 42, 0.08)'],
  ['background: rgba(15, 23, 42, 0.85)', 'background: rgba(255, 255, 255, 0.92)'],
  ['background: rgba(30, 41, 59, 0.95)', 'background: rgba(248, 250, 252, 0.98)'],
  ['0 4px 20px rgba(0, 0, 0, 0.4)', '0 4px 20px rgba(15, 23, 42, 0.08)'],
  ['border-top: 1px solid rgba(255, 255, 255, 0.04)', 'border-top: 1px solid rgba(15, 23, 42, 0.06)'],
  ['rgba(15, 23, 42, 0.72)', 'rgba(255, 255, 255, 0.88)'],
  ['rgba(15, 23, 42, 0.45)', 'rgba(248, 250, 252, 0.75)'],
  ['rgba(2, 6, 23, 0.55)', 'rgba(241, 245, 249, 0.9)'],
  ['rgba(2, 6, 23, 0.35)', 'rgba(226, 232, 240, 0.85)'],
  ['border-color: rgba(255, 255, 255, 0.12)', 'border-color: rgba(15, 23, 42, 0.1)'],
  ['border-color: rgba(255, 255, 255, 0.1)', 'border-color: rgba(15, 23, 42, 0.08)'],
  ['background: rgba(22, 30, 45, 0.45)', 'background: rgba(255, 255, 255, 0.78)'],
  ['0 8px 32px 0 rgba(0, 0, 0, 0.3)', '0 8px 32px 0 rgba(15, 23, 42, 0.08)'],
  ['background: rgba(30, 41, 59, 0.6)', 'background: rgba(255, 255, 255, 0.92)'],
  ['0 12px 40px 0 rgba(0, 0, 0, 0.45)', '0 12px 40px 0 rgba(15, 23, 42, 0.1)'],
  ['border-color: rgba(255, 255, 255, 0.15)', 'border-color: rgba(15, 23, 42, 0.12)'],
  ['border: 1px solid rgba(255, 255, 255, 0.05)', 'border: 1px solid rgba(15, 23, 42, 0.06)'],
  ['box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2)', 'box-shadow: 0 4px 12px rgba(15, 23, 42, 0.06)'],
  ['box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4)', 'box-shadow: 0 8px 20px rgba(15, 23, 42, 0.08)'],
  ['border-color: rgba(255, 255, 255, 0.2)', 'border-color: rgba(15, 23, 42, 0.14)'],
  ['background: rgba(15,23,42,0.6)', 'background: rgba(241, 245, 249, 0.95)'],
  ['background: rgba(15,23,42,0.55)', 'background: rgba(248, 250, 252, 0.92)'],
  ['border: 1.5px solid rgba(255,255,255,0.07)', 'border: 1.5px solid rgba(15, 23, 42, 0.08)'],
  ['background: rgba(30,41,59,0.7)', 'background: rgba(241, 245, 249, 0.98)'],
  ['border-color: rgba(255,255,255,0.15)', 'border-color: rgba(15, 23, 42, 0.1)'],
  ['box-shadow: 0 8px 20px rgba(0,0,0,0.3)', 'box-shadow: 0 8px 20px rgba(15, 23, 42, 0.07)'],
  ['background: rgba(15,23,42,0.5)', 'background: rgba(248, 250, 252, 0.9)'],
  ['border: 1px solid rgba(255,255,255,0.06)', 'border: 1px solid rgba(15, 23, 42, 0.06)'],
  ['border-top: 1px solid rgba(255,255,255,0.05)', 'border-top: 1px solid rgba(15, 23, 42, 0.06)'],
  ['background: rgba(0,0,0,0.15)', 'background: rgba(241, 245, 249, 0.65)'],
  ['background: rgba(10,15,28,0.4)', 'background: rgba(248, 250, 252, 0.85)'],
  ['border-bottom: 1px solid rgba(255,255,255,0.04)', 'border-bottom: 1px solid rgba(15, 23, 42, 0.05)'],
  ['border-right: 1px solid rgba(255,255,255,0.04)', 'border-right: 1px solid rgba(15, 23, 42, 0.05)'],
  ['    background: #0f172a;', '    background: #ffffff;'],
  ['    border: 1px solid #1e293b;', '    border: 1px solid #e2e8f0;'],
  ['.filter-dropdown::-webkit-scrollbar-thumb { background: #334155;', '.filter-dropdown::-webkit-scrollbar-thumb { background: #cbd5e1;'],
  ['background: rgba(0, 0, 0, 0.72)', 'background: rgba(15, 23, 42, 0.35)'],
  ['background: rgba(0, 0, 0, 0.65)', 'background: rgba(15, 23, 42, 0.25)'],
  ['filter: invert(1) sepia(1) saturate(5) hue-rotate(350deg)', 'filter: none'],
  ['background: rgba(15, 23, 42, 0.4)', 'background: rgba(255, 255, 255, 0.75)'],
  ['box-shadow: 0 6px 16px -6px rgba(0, 0, 0, 0.5)', 'box-shadow: 0 6px 16px -6px rgba(15, 23, 42, 0.1)'],
  ['background: rgba(30, 41, 59, 0.8)', 'background: rgba(255, 255, 255, 0.95)'],
  ['box-shadow: inset 0 0 16px rgba(0, 0, 0, 0.2)', 'box-shadow: inset 0 0 16px rgba(15, 23, 42, 0.04)'],
  ['.qa-data-sort:hover { color: #fff;', '.qa-data-sort:hover { color: #0f172a;'],
  ['background: rgba(15, 23, 42, 0.95)', 'background: rgba(255, 255, 255, 0.96)'],
  ['background: rgba(255, 255, 255, 0.055)', 'background: rgba(15, 23, 42, 0.04)'],
  ['box-shadow: inset 3px 0 12px -4px rgba(99, 102, 241, 0.2), 0 1px 0 rgba(255, 255, 255, 0.02)', 'box-shadow: inset 3px 0 12px -4px rgba(99, 102, 241, 0.12), 0 1px 0 rgba(15, 23, 42, 0.04)'],
  ['background: linear-gradient(135deg, rgba(10, 15, 35, 0.98) 0%, rgba(15, 20, 45, 0.97) 100%)', 'background: linear-gradient(135deg, rgba(255, 255, 255, 0.98) 0%, rgba(248, 250, 252, 0.98) 100%)'],
  ['border: 1px solid rgba(100, 116, 139, 0.35)', 'border: 1px solid rgba(148, 163, 184, 0.45)'],
  ['0 20px 60px rgba(0, 0, 0, 0.7)', '0 20px 60px rgba(15, 23, 42, 0.12)'],
  ['0 8px 24px rgba(0, 0, 0, 0.4)', '0 8px 24px rgba(15, 23, 42, 0.08)'],
  ['inset 0 1px 0 rgba(255, 255, 255, 0.06)', 'inset 0 1px 0 rgba(255, 255, 255, 0.85)'],
  ['background: rgba(10, 15, 35, 0.98)', 'background: rgba(255, 255, 255, 0.98)'],
  ['border-left: 1px solid rgba(100, 116, 139, 0.35)', 'border-left: 1px solid rgba(148, 163, 184, 0.45)'],
  ['border-top: 1px solid rgba(100, 116, 139, 0.35)', 'border-top: 1px solid rgba(148, 163, 184, 0.45)'],
  ['border-bottom: 1px solid rgba(255, 255, 255, 0.06)', 'border-bottom: 1px solid rgba(15, 23, 42, 0.06)'],
  ['border: 1px solid rgba(255, 255, 255, 0.1)', 'border: 1px solid rgba(148, 163, 184, 0.35)'],
  ['box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5)', 'box-shadow: 0 16px 48px rgba(15, 23, 42, 0.1)'],
  ['0 0 0 1px rgba(255, 255, 255, 0.04)', '0 0 0 1px rgba(15, 23, 42, 0.04)'],
  ['.pill-unselected { background: #111827; color: #64748b;', '.pill-unselected { background: #f1f5f9; color: #64748b;'],
];

for (const [a, b] of rawReplacements) {
  const n = css.split(a).length - 1;
  if (n === 0) console.warn('Pattern not found:', a.slice(0, 72));
  css = css.split(a).join(b);
}

css = css.replace(
  /\.filter-dropdown option \{ background: #e2e8f0; color: #e2e8f0;/,
  '.filter-dropdown option { background: #f1f5f9; color: #0f172a;'
);
css = css.replace(
  /(\.filter-dropdown \{[^}]*color: )#94a3b8;/,
  '$1#475569;'
);
css = css.replace(
  /(#childPillsContainer \{[^}]*)(border-top: 1px solid rgba\(255,255,255,0\.04\);)/,
  '$1border-top: 1px solid rgba(15, 23, 42, 0.05);'
);

/** Text / borders that should flip for light (remaining slate text) */
css = css.replace(/\.integ-dim \{\s*color: #334155;/, '.integ-dim {\n    color: #94a3b8;');
css = css.replace(/\.dashboard-footer span \{\s*font-size: 9px;/, '.dashboard-footer span {\n    font-size: 9px;');
css = css.replace(/\.dashboard-footer span \{[^}]*color: #334155;/, (m) => m.replace('color: #334155', 'color: #64748b'));
css = css.replace(
  /\.loader-subtitle \{[^}]*color: #64748b;/,
  (m) => m.replace('color: #64748b', 'color: #475569')
);
css = css.replace(/\.back-to-top-btn \{[^}]*color: #94a3b8;/, (m) => m.replace('color: #94a3b8', 'color: #64748b'));
css = css.replace(/\.back-to-top-btn:hover \{[^}]*color: #e2e8f0;/, (m) => m.replace('color: #e2e8f0', 'color: #0f172a'));
css = css.replace(/\.pillar-th:hover \{ color: #e2e8f0;/, '.pillar-th:hover { color: #0f172a;');
css = css.replace(/\.pillar-th:hover svg \{ color: #94a3b8;/, '.pillar-th:hover svg { color: #64748b;');
css = css.replace(/\.pillar-popover-header \.pp-title \{[^}]*color: #f1f5f9;/, (m) =>
  m.replace('color: #f1f5f9', 'color: #0f172a')
);
css = css.replace(/\.admin-tools-label \{[^}]*color: #e2e8f0;/, (m) => m.replace('color: #e2e8f0', 'color: #0f172a'));

css = css.replace(
  /\.rating-pill \.count \{[^}]*color: #ffffff;/,
  `.rating-pill .count {
    font-size: 1.15rem;
    font-weight: 900;
    color: #0f172a;`
);

css = css.replace(/\.pill:hover \{[^}]*color: #e2e8f0;/, (m) => m.replace('color: #e2e8f0', 'color: #0f172a'));
css = css.replace(/\.group-btn:hover \{[^}]*color: #e2e8f0;/, (m) => m.replace('color: #e2e8f0', 'color: #0f172a'));
css = css.replace(/\.project-card \.card-name \{[^}]*color: #e2e8f0;/, (m) => m.replace('color: #e2e8f0', 'color: #0f172a'));

/** Muted UI on white — bump contrast (WCAG-friendly) */
css = css.replace(
  `    border: 1px solid rgba(15, 23, 42, 0.06);
    color: #94a3b8;

    /* Transition for Smooth Zoom */
    transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.06);`,
  `    border: 1px solid rgba(15, 23, 42, 0.06);
    color: #475569;

    /* Transition for Smooth Zoom */
    transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.06);`
);
css = css.replace(/#parentPills \.VeloSync-global-btn \{[^}]*color: #94a3b8;/, (m) => m.replace('color: #94a3b8', 'color: #475569'));
css = css.replace(/\.group-btn \{[^}]*color: #94a3b8;/, (m) => m.replace('color: #94a3b8', 'color: #475569'));

// Portfolio pill names in the cloned-from-dark block: remap to dark ink so
// the early rule doesn't fight the final rule appended below.
css = css.replace(/(#parentPills \.portfolio-pill-name \{\s*color: )#94a3b8/, '$1#0f172a');
css = css.replace(/(#parentPills \[data-pill-selected="true"\] \.portfolio-pill-name \{\s*color: )#dbeafe/, '$1#172554');

css = css.replace(/\.rating-pill \.label \{[^}]*color: #64748b;/, (m) => m.replace('color: #64748b', 'color: #475569'));

/** Pillar popover: dark ink for status labels on light glass */
css = css.replace(/\.pp-label-elite\s*\{\s*color:\s*#6ee7b7;\s*\}/, '.pp-label-elite   { color: #047857; }');
css = css.replace(/\.pp-label-strong\s*\{\s*color:\s*#93c5fd;\s*\}/, '.pp-label-strong  { color: #1d4ed8; }');
css = css.replace(/\.pp-label-stable\s*\{\s*color:\s*#fde68a;\s*\}/, '.pp-label-stable  { color: #a16207; }');
css = css.replace(/\.pp-label-risk\s*\{\s*color:\s*#fdba74;\s*\}/, '.pp-label-risk    { color: #c2410c; }');
css = css.replace(/\.pp-label-critical\s*\{\s*color:\s*#fca5a5;\s*\}/, '.pp-label-critical{ color: #b91c1c; }');
css = css.replace(/\.pp-range-elite\s*\{\s*color:\s*#34d399;\s*\}/, '.pp-range-elite   { color: #047857; }');
css = css.replace(/\.pp-range-strong\s*\{\s*color:\s*#60a5fa;\s*\}/, '.pp-range-strong  { color: #1d4ed8; }');
css = css.replace(/\.pp-range-stable\s*\{\s*color:\s*#fbbf24;\s*\}/, '.pp-range-stable  { color: #b45309; }');
css = css.replace(/\.pp-range-risk\s*\{\s*color:\s*#fb923c;\s*\}/, '.pp-range-risk    { color: #c2410c; }');
css = css.replace(/\.pp-range-critical\s*\{\s*color:\s*#f87171;\s*\}/, '.pp-range-critical{ color: #b91c1c; }');

function twSelector(util) {
  const gh = 'group-hover:';
  if (util.startsWith(gh)) {
    const rest = util.slice(gh.length).replace(/\//g, '\\/');
    return `.group:hover .group-hover\\:${rest}`;
  }
  const segs = util.split(':');
  const base = segs.pop();
  const vars = segs;
  const escapedBase = base.replace(/\//g, '\\/');
  const classPart = vars.map((v) => `${v}\\:`).join('') + escapedBase;
  let pseudo = '';
  if (vars.includes('hover')) pseudo += ':hover';
  if (vars.includes('focus')) pseudo += ':focus';
  if (vars.includes('active')) pseudo += ':active';
  return `.${classPart}${pseudo}`;
}

function declFor(util) {
  if (util === 'text-white' || util === 'hover:text-white') {
    return `color: #0f172a !important;`;
  }
  if (util.startsWith('text-slate-')) {
    const m = util.match(/text-slate-(\d+)/);
    const n = m ? +m[1] : 400;
    const map = {
      200: '#0f172a',
      300: '#1e293b',
      400: '#334155',
      500: '#475569',
      600: '#475569',
      700: '#0f172a',
    };
    return `color: ${map[n] || '#334155'} !important;`;
  }
  if (util === 'placeholder-slate-600') return `color: #64748b !important;`;

  if (util === 'bg-slate-950' || util.startsWith('bg-slate-950/')) {
    if (util.includes('/80')) return `background-color: rgb(255 255 255 / 0.92) !important;`;
    if (util.includes('/40')) return `background-color: rgb(248 250 252 / 0.9) !important;`;
    return `background-color: #ffffff !important;`;
  }
  if (util.startsWith('bg-slate-900')) {
    const op = util.match(/\/(\d+)/);
    const a = op ? +op[1] / 100 : 1;
    return `background-color: rgb(248 250 252 / ${a}) !important;`;
  }
  if (util.startsWith('bg-slate-800')) {
    const op = util.match(/\/(\d+)/);
    const a = op ? +op[1] / 100 : 1;
    return `background-color: rgb(241 245 249 / ${a}) !important;`;
  }
  if (util === 'bg-slate-700') return `background-color: rgb(226 232 240) !important;`;

  if (util.startsWith('border-slate-')) {
    const op = util.match(/\/(\d+)/);
    if (op) {
      const a = +op[1] / 100;
      return `border-color: rgb(148 163 184 / ${a}) !important;`;
    }
    const m = util.match(/border-slate-(\d+)/);
    const n = m ? +m[1] : 700;
    const map = { 600: '#cbd5e1', 700: '#e2e8f0', 800: '#e2e8f0' };
    return `border-color: ${map[n] || '#e2e8f0'} !important;`;
  }

  if (util.startsWith('text-blue-')) {
    if (util.includes('100')) return `color: rgb(30 64 175 / 0.88) !important;`;
    if (util.includes('200')) return `color: #1d4ed8 !important;`;
    if (util.includes('400')) return `color: #2563eb !important;`;
    if (util.includes('500')) return `color: #1d4ed8 !important;`;
    return `color: #2563eb !important;`;
  }
  if (util.startsWith('hover:text-blue-')) {
    if (util.includes('300')) return `color: #1e40af !important;`;
    return `color: #1d4ed8 !important;`;
  }

  if (util.startsWith('text-teal-')) {
    if (util.includes('100')) return `color: rgb(15 118 110 / 0.9) !important;`;
    if (util.includes('200')) return `color: #0f766e !important;`;
    if (util.includes('400')) return `color: #0d9488 !important;`;
    if (util.includes('500')) return `color: #0f766e !important;`;
    return `color: #0d9488 !important;`;
  }
  if (util.startsWith('text-cyan-')) {
    if (util.includes('100')) return `color: rgb(14 116 144 / 0.9) !important;`;
    return `color: #0e7490 !important;`;
  }
  if (util.startsWith('text-purple-')) {
    if (util.includes('100')) return `color: rgb(88 28 135 / 0.9) !important;`;
    if (util.includes('200')) return `color: #6b21a8 !important;`;
    return `color: #7c3aed !important;`;
  }
  if (util.startsWith('text-amber-')) {
    if (util.includes('300')) return `color: #b45309 !important;`;
    if (util.includes('400')) return `color: #d97706 !important;`;
    if (util.includes('500')) return `color: #b45309 !important;`;
    return `color: #d97706 !important;`;
  }
  if (util.startsWith('text-emerald-400')) return `color: #059669 !important;`;
  if (util.startsWith('text-orange-400')) return `color: #ea580c !important;`;
  if (util.startsWith('text-red-400')) return `color: #dc2626 !important;`;
  if (util.startsWith('text-rose-400')) return `color: #e11d48 !important;`;
  if (util.startsWith('text-violet-')) {
    if (util.includes('500/50')) return `color: rgb(109 40 217 / 0.65) !important;`;
    return `color: #6d28d9 !important;`;
  }

  if (util.startsWith('hover:bg-slate-')) return `background-color: rgb(226 232 240) !important;`;
  if (util === 'hover:bg-blue-500') return `background-color: #3b82f6 !important;`;
  if (util === 'hover:bg-violet-500') return `background-color: #7c3aed !important;`;
  if (util === 'hover:text-slate-300') return `color: #334155 !important;`;

  if (util.startsWith('bg-blue-')) {
    if (util.includes('950')) return `background-color: rgb(219 234 254 / 0.85) !important;`;
    if (util.includes('600')) return `background-color: #2563eb !important;`;
    if (util.includes('500/30')) return `background-color: rgb(59 130 246 / 0.18) !important;`;
    if (util.includes('500/15')) return `background-color: rgb(59 130 246 / 0.1) !important;`;
    if (util.includes('500') && !util.includes('/')) return `background-color: #3b82f6 !important;`;
  }

  if (util.startsWith('bg-violet-')) {
    if (util.includes('950/5')) return `background-color: rgb(139 92 246 / 0.06) !important;`;
    if (util.includes('600')) return `background-color: #7c3aed !important;`;
    if (util.includes('500/20')) return `background-color: rgb(139 92 246 / 0.12) !important;`;
    if (util.includes('500/10')) return `background-color: rgb(139 92 246 / 0.08) !important;`;
  }

  if (util.startsWith('bg-amber-950/40')) return `background-color: rgb(254 243 199 / 0.65) !important;`;

  if (util.startsWith('border-blue-900/30')) return `border-color: rgb(191 219 254 / 0.7) !important;`;
  if (util.startsWith('hover:border-blue-500/50')) return `border-color: rgb(59 130 246 / 0.45) !important;`;
  if (util.startsWith('focus:border-blue-500/60')) return `border-color: rgb(59 130 246 / 0.5) !important;`;
  if (util.startsWith('focus:ring-blue-500/60')) {
    return `--tw-ring-color: rgb(59 130 246 / 0.35) !important;`;
  }
  if (util.startsWith('focus:ring-violet-500')) {
    return `--tw-ring-color: rgb(139 92 246 / 0.35) !important;`;
  }

  if (util.startsWith('border-l-blue-500') && !util.includes('/')) return `border-left-color: #3b82f6 !important;`;
  if (util.startsWith('border-l-cyan-500') && !util.includes('/')) return `border-left-color: #0891b2 !important;`;
  if (util.startsWith('border-l-purple-500')) return `border-left-color: #9333ea !important;`;
  if (util.startsWith('border-l-teal-500/50')) return `border-left-color: rgb(20 184 166 / 0.55) !important;`;
  if (util.startsWith('border-l-teal-500') && !util.includes('/')) return `border-left-color: #14b8a6 !important;`;
  if (util.startsWith('border-l-violet-500')) return `border-left-color: #7c3aed !important;`;
  if (util.startsWith('border-l-amber-500/50')) return `border-left-color: rgb(245 158 11 / 0.55) !important;`;
  if (util.startsWith('border-t-violet-500')) return `border-top-color: #7c3aed !important;`;
  if (util.startsWith('border-violet-500/30')) return `border-color: rgb(139 92 246 / 0.25) !important;`;
  if (util.startsWith('border-amber-700/50')) return `border-color: rgb(180 83 9 / 0.35) !important;`;

  if (util.startsWith('from-slate-900/70')) {
    return `--tw-gradient-from: rgb(248 250 252 / 0.98) var(--tw-gradient-from-position) !important; --tw-gradient-to: rgb(248 250 252 / 0) var(--tw-gradient-to-position) !important;`;
  }
  if (util.startsWith('via-slate-900/55')) {
    return `--tw-gradient-via: rgb(241 245 249 / 0.9) var(--tw-gradient-via-position) !important;`;
  }
  if (util.startsWith('via-slate-900/30')) {
    return `--tw-gradient-via: rgb(241 245 249 / 0.55) var(--tw-gradient-via-position) !important;`;
  }
  if (util.startsWith('from-amber-950/35')) {
    return `--tw-gradient-from: rgb(254 252 232 / 0.95) var(--tw-gradient-from-position) !important;`;
  }
  if (util.startsWith('from-cyan-950/40')) {
    return `--tw-gradient-from: rgb(236 254 255 / 0.92) var(--tw-gradient-from-position) !important;`;
  }
  if (util.startsWith('from-emerald-400')) {
    return `--tw-gradient-from: #34d399 var(--tw-gradient-from-position) !important;`;
  }
  if (util.startsWith('from-amber-400')) {
    return `--tw-gradient-from: #fbbf24 var(--tw-gradient-from-position) !important;`;
  }
  if (util.startsWith('from-cyan-400')) {
    return `--tw-gradient-from: #22d3ee var(--tw-gradient-from-position) !important;`;
  }
  if (util.startsWith('from-violet-400')) {
    return `--tw-gradient-from: #a78bfa var(--tw-gradient-from-position) !important;`;
  }
  if (util.startsWith('to-blue-950/40')) {
    return `--tw-gradient-to: rgb(219 234 254 / 0.5) var(--tw-gradient-to-position) !important;`;
  }
  if (util.startsWith('to-cyan-950/40')) {
    return `--tw-gradient-to: rgb(207 250 254 / 0.5) var(--tw-gradient-to-position) !important;`;
  }
  if (util.startsWith('to-emerald-950/35')) {
    return `--tw-gradient-to: rgb(209 250 229 / 0.45) var(--tw-gradient-to-position) !important;`;
  }
  if (util.startsWith('to-purple-950/40')) {
    return `--tw-gradient-to: rgb(237 233 254 / 0.5) var(--tw-gradient-to-position) !important;`;
  }
  if (util.startsWith('to-teal-950/40')) {
    return `--tw-gradient-to: rgb(204 251 241 / 0.5) var(--tw-gradient-to-position) !important;`;
  }
  if (util.startsWith('to-violet-950/40')) {
    return `--tw-gradient-to: rgb(237 233 254 / 0.5) var(--tw-gradient-to-position) !important;`;
  }
  if (util.startsWith('to-teal-400')) return `--tw-gradient-to: #2dd4bf var(--tw-gradient-to-position) !important;`;
  if (util.startsWith('to-teal-500')) return `--tw-gradient-to: #14b8a6 var(--tw-gradient-to-position) !important;`;
  if (util.startsWith('to-fuchsia-500')) return `--tw-gradient-to: #d946ef var(--tw-gradient-to-position) !important;`;
  if (util.startsWith('to-orange-500')) return `--tw-gradient-to: #f97316 var(--tw-gradient-to-position) !important;`;

  if (util.startsWith('group-hover:text-teal-300')) return `color: #0f766e !important;`;

  return `outline-color: #cbd5e1 !important;`;
}

const html = fs.readFileSync('index.html', 'utf8');
const twSet = new Set();
const cre = /class="([^"]*)"/g;
let mm;
const colorRe =
  /(?:^|[\s:])(text|bg|border|from|to|via|ring|outline|placeholder|shadow|divide)-(?:[\w.\[/%-]+)/;
const hasColor =
  /-(slate|gray|zinc|neutral|stone|blue|emerald|purple|teal|red|amber|orange|cyan|indigo|white|black|green|yellow|rose|sky|violet|fuchsia|lime)-/;
while ((mm = cre.exec(html))) {
  for (const c of mm[1].split(/\s+/).filter(Boolean)) {
    if (colorRe.test(c) && hasColor.test(c) && !/translate/.test(c)) twSet.add(c);
    if (c === 'text-white' || c === 'hover:text-white') twSet.add(c);
  }
}

let bridge = '\n\n/* ═══ Tailwind CDN utility remaps (light theme file only) ═══ */\n';
for (const util of [...twSet].sort()) {
  bridge += `${twSelector(util)} { ${declFor(util)} }\n`;
}

const inlinePanelPatch = `

/* Inline dark glass panels (index.html style=) */
[style*="rgba(15,10,40,0.92)"] {
    background: linear-gradient(135deg, rgba(248, 250, 252, 0.98) 0%, rgba(241, 245, 249, 0.94) 40%, rgba(248, 250, 252, 0.98) 100%) !important;
}
[style*="rgba(10,10,30,0.92)"] {
    background: linear-gradient(135deg, rgba(250, 245, 255, 0.97) 0%, rgba(241, 245, 249, 0.95) 45%, rgba(250, 245, 255, 0.97) 100%) !important;
}
#metricsOverlay[style*="rgba(2,6,23"] {
    background: rgba(241, 245, 249, 0.88) !important;
}
#masterDownloadOverlay[style*="rgba(2,6,23"] {
    background: rgba(241, 245, 249, 0.88) !important;
}

/* Contrast: white text only on true brand / icon chips (Tailwind text-white → ink elsewhere) */
.bg-violet-600.text-white,
.bg-blue-600.text-white,
.bg-blue-500.text-white,
a.bg-blue-600.text-white,
button.bg-violet-600.text-white {
    color: #ffffff !important;
}
div[style*="linear-gradient(135deg, #7c3aed"] svg,
div[style*="linear-gradient(135deg,#7c3aed"] svg {
    color: #ffffff !important;
}
`;

const lightHeader = `/**
 * VeloSync main dashboard — LIGHT theme (default).
 * This file is loaded alone when \`dashboard-theme\` is light. Do not load together with dashboard-dark.css.
 * Regenerated in part by build-light-style.mjs (manual edits may follow).
 */

`;

/* Appended after dark→light transform so it wins over any accidental replacements */
const lightOnlyExtras = `

/* Theme toggle (main dashboard header) — light sheet only */
#dashboardThemeToggle {
    border: 1px solid rgba(148, 163, 184, 0.55);
    background: #ffffff;
    color: #b45309;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
}
#dashboardThemeToggle:hover {
    background: #f8fafc;
    border-color: rgba(100, 116, 139, 0.65);
    color: #92400e;
}
`;

/**
 * Dev / QA leaderboard tables: the `.dev-leaderboard-table-wrap` ruleset in
 * dashboard-dark.css is a custom class (not a Tailwind utility), so the dark→light
 * token substitutions above don't touch it and the dark navy surfaces bleed into
 * the light sheet. Override the whole block here with a proper light surface
 * (white chip, slate header, readable ink). Loaded only in the light theme file.
 */
const leaderboardLightPatch = `

/* ═══ Dev / QA Leaderboard — light surfaces ═══ */
.dev-leaderboard-table-wrap {
    background: rgba(255, 255, 255, 0.92) !important;
    border: 1px solid rgba(148, 163, 184, 0.35) !important;
    box-shadow:
        0 1px 2px rgba(15, 23, 42, 0.05),
        0 8px 28px rgba(15, 23, 42, 0.08) !important;
}
.dev-leaderboard-table-wrap .github-metrics-table thead tr,
.dev-leaderboard-table-wrap table thead tr {
    background: rgba(241, 245, 249, 0.95) !important;
    border-bottom: 1px solid rgba(148, 163, 184, 0.28) !important;
}
.dev-leaderboard-table-wrap .github-metrics-table thead th,
.dev-leaderboard-table-wrap table thead th {
    color: #475569 !important;
}
.dev-leaderboard-table-wrap tbody {
    color: #334155 !important;
}
.github-metrics-table .gh-leader-name,
.dev-leaderboard-table-wrap .gh-leader-name {
    color: #0f172a !important;
    font-weight: 700;
}
.github-metrics-table .gh-leader-repos,
.dev-leaderboard-table-wrap .gh-leader-repos {
    color: #64748b !important;
}
.github-metrics-table .gh-leader-row,
.dev-leaderboard-table-wrap .gh-leader-row {
    border-color: rgba(148, 163, 184, 0.22) !important;
}
.github-metrics-table .gh-leader-row--even,
.dev-leaderboard-table-wrap .gh-leader-row--even {
    background: rgba(255, 255, 255, 0.70) !important;
}
.github-metrics-table .gh-leader-row--odd,
.dev-leaderboard-table-wrap .gh-leader-row--odd {
    background: rgba(241, 245, 249, 0.82) !important;
}
.github-metrics-table .gh-leader-row:hover,
.dev-leaderboard-table-wrap .gh-leader-row:hover {
    background: rgba(59, 130, 246, 0.10) !important;
}
.gh-score-track {
    background: rgba(226, 232, 240, 0.9) !important;
    box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.06) !important;
}
.dev-leaderboard-table-wrap th.dev-data-sort:hover,
.dev-leaderboard-table-wrap th.qa-data-sort:hover {
    color: #0f172a !important;
}

/* The leaderboard section shell (\`#githubDataDashboard\` / \`#qaDataDashboard\`)
   uses bg-slate-900/30 which our bridge already re-tints, but its inline
   \`border-slate-700/50\` and \`border-white/5\` don't map — force a clean
   light divider so the section doesn't read as a dark plate. */
#githubDataDashboard,
#qaDataDashboard {
    background: rgba(255, 255, 255, 0.72) !important;
    border-color: rgba(148, 163, 184, 0.35) !important;
}
#githubDataDashboard > .border-b,
#qaDataDashboard > .border-b {
    border-color: rgba(148, 163, 184, 0.30) !important;
}

/* ─── Dark-theme ink leaking into the light sheet ────────────────────────
   Several custom rulesets (".geo-work-chart-*", ".lb-header-*", portfolio
   pill names) hard-code slate-100..slate-400 text colors. Those are fine on
   dark surfaces but vanish on white. Force dark ink in the light theme so
   every header/blurb/pill reads clearly. */

/* Leaderboard descriptive paragraph + QA detail subtitle */
.lb-header-blurb,
.lb-qa-detail-subtitle {
    color: #334155 !important;
}
.lb-header-blurb strong,
.lb-qa-detail-subtitle strong {
    color: #0f172a !important;
}

/* Work Categorization / Geo distribution header strip */
.geo-work-chart-header h3 {
    color: #0f172a !important;
    text-shadow: none !important;
}
.geo-work-chart-header p,
.geo-work-chart-blurb {
    color: #334155 !important;
}
.geo-work-chart-header strong,
.geo-work-chart-blurb strong {
    color: #0f172a !important;
}
.geo-work-chart-header code {
    color: #0f172a !important;
    background: rgba(226, 232, 240, 0.8) !important;
    padding: 0 4px;
    border-radius: 4px;
}

/* Portfolio pill names (strip above the dashboard).
   Unselected pill background ≈ white → slate-950 ink for max contrast.
   Selected pill background is a pale blue gradient → blue-950 ink so the
   name stays crisp and legible (was #ffffff previously, which was invisible). */
#parentPills .portfolio-pill-name {
    color: #0f172a !important;
}
#parentPills [data-pill-selected="true"] .portfolio-pill-name {
    color: #172554 !important;
}

/* Main dashboard graph cards — on light, the subtle slate→blue frosted gradient
   stacked on top of .card reads as a grey "frame" around the bright inner
   .main-chart-plot. Flatten the outer surface to solid white so the two
   surfaces merge visually (keeps the colored left border intact). */
#mainarea .card.graph-card {
    background-image: none !important;
    background-color: #ffffff !important;
    box-shadow:
        0 1px 2px rgba(15, 23, 42, 0.04),
        0 8px 28px rgba(15, 23, 42, 0.06) !important;
}
#mainarea .card.graph-card:hover {
    background-color: #ffffff !important;
    box-shadow:
        0 2px 4px rgba(15, 23, 42, 0.05),
        0 14px 38px rgba(15, 23, 42, 0.10) !important;
}
/* Chart card titles — lighten the ink from blue-700 to slate-700 so the header
   no longer competes with the chart contents; keep the color hint via the
   left border on the card. */
#mainarea .card.graph-card h3 {
    color: #1e293b !important;
}
#mainarea .card.graph-card h3 > span {
    color: #64748b !important;
    font-weight: 600 !important;
}
`;

/**
 * Connector-branded chips, pills, tabs, and header accents use inline style="" with
 * dark-mode-optimized colors (teal-300/amber-400/indigo-300). In the light theme those
 * hex values evaporate against the page. We re-tint them to WCAG-readable ink while
 * keeping the brand hue. Selectors match the hex/background substrings directly so
 * they cover both static HTML and the inline-style mutations script.js performs when
 * switching AI tool tabs. `!important` is required to beat the inline style attribute.
 */
const connectorChipsPatch = `

/* ═══ Connector-branded chips & tabs (light theme contrast fix) ═══ */

/* Copilot brand ink — teal-300 #5eead4 → teal-700 #0f766e */
[style*="#5eead4"] { color: #0f766e !important; }
/* Cursor brand ink — amber-400 #fbbf24 → amber-700 #b45309 */
[style*="#fbbf24"] { color: #b45309 !important; }
/* Indigo label ink — indigo-300 #a5b4fc → indigo-800 #3730a3 */
[style*="#a5b4fc"] { color: #3730a3 !important; }

/* Translucent brand backgrounds — darken borders so pills read as chips, not ghosts.
   The substring match catches both "0.2" and "0.20" spellings. */
[style*="rgba(20,184,166,0.2)"],
[style*="rgba(20,184,166,0.15)"],
[style*="rgba(20,184,166,0.12)"] {
    background: rgba(13, 148, 136, 0.10) !important;
    border-color: rgba(15, 118, 110, 0.45) !important;
}
[style*="rgba(245,158,11,0.2)"],
[style*="rgba(245,158,11,0.15)"],
[style*="rgba(245,158,11,0.12)"] {
    background: rgba(217, 119, 6, 0.10) !important;
    border-color: rgba(180, 83, 9, 0.45) !important;
}
[style*="rgba(99,102,241,0.15)"],
[style*="rgba(99,102,241,0.2)"] {
    background: rgba(99, 102, 241, 0.10) !important;
    border-color: rgba(67, 56, 202, 0.40) !important;
}

/* Inactive AI tool tab — on dark its faint white tint disappears on a white page.
   Give it a visible slate chip that hover-elevates to ink. */
.ai-tool-tab[style*="rgba(255,255,255,0.03)"],
.ai-tool-tab[data-tool-tab]:not(.active) {
    background: rgba(15, 23, 42, 0.04) !important;
    border-color: rgba(148, 163, 184, 0.45) !important;
    color: #475569 !important;
}
.ai-tool-tab[data-tool-tab]:not(.active):hover {
    background: rgba(15, 23, 42, 0.07) !important;
    color: #0f172a !important;
}

/* Small brand labels in dashboard cards ("Copilot"/"Cursor" uppercase micro-labels).
   .text-teal-500 inline-tagged is too pale against a light card surface. */
.text-teal-500 { color: #0f766e !important; }
`;

fs.writeFileSync(
  'css/dashboard-light.css',
  lightHeader + css + bridge + inlinePanelPatch + lightOnlyExtras + leaderboardLightPatch + connectorChipsPatch
);
console.log('Wrote css/dashboard-light.css, tailwind utility overrides:', twSet.size);
