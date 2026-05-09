/**
 * Compact Copilot / Cursor / GitHub context for OpenRouter prompts.
 * Shared by index (org AI) and project-detail AI. No DOM dependencies.
 */
(function (global) {
    const CURSOR_LEADERBOARD_MATCH_LIMIT = 25;
    const TOP_N = { LANG: 8, PIE: 6, GITHUB_ROWS: 14, REPOS: 120 };

    function normalizeForMatch(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    }
    function similarEnough(a, b, minLen) {
        const na = normalizeForMatch(a);
        const nb = normalizeForMatch(b);
        if (na.length < (minLen || 2) || nb.length < (minLen || 2)) return na === nb;
        return na.includes(nb) || nb.includes(na);
    }
    function wordTokens(s) {
        return String(s || '').toLowerCase().split(/[\s\-_.]+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(w => w.length >= 2);
    }
    function projectRepoSimilar(projectName, repoOrProjectStr) {
        if (similarEnough(projectName, repoOrProjectStr)) return true;
        const a = wordTokens(projectName);
        const b = wordTokens(repoOrProjectStr);
        if (a.length === 0 || b.length === 0) return false;
        const overlap = a.filter(t => b.some(u => t.includes(u) || u.includes(t) || similarEnough(t, u))).length;
        return overlap >= Math.min(2, a.length, b.length) || (a.length === 1 && b.some(u => u.includes(a[0]) || a[0].includes(u)));
    }
    function projectMatchesCursorRepo(projectName, cursorData) {
        if (!cursorData || !projectName) return { match: false };
        const repos = cursorData.aiEditsByRepository || [];
        if (!Array.isArray(repos) || repos.length === 0) return { match: false };
        for (const r of repos) {
            const proj = (r.projectName || r.repository || '').trim();
            const fullRepo = (r.repository || '').trim();
            if (projectRepoSimilar(projectName, proj) || projectRepoSimilar(projectName, fullRepo)) {
                return { match: true, codeCommittedByAiPct: r.codeCommittedByAiPct ?? 0, repository: fullRepo || proj };
            }
        }
        return { match: false };
    }
    function getCursorLeaderboardRowsForMatch(cursorData) {
        const limit = CURSOR_LEADERBOARD_MATCH_LIMIT;
        const fromAgg = cursorData && cursorData.top10Users;
        if (Array.isArray(fromAgg) && fromAgg.length > 0) {
            return fromAgg.slice(0, limit);
        }
        const lb = cursorData && cursorData.leaderboard;
        if (!lb) return [];
        if (Array.isArray(lb)) {
            const sorted = [...lb].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
            return sorted.slice(0, limit).map((u) => ({
                ...u,
                name: u.name || u.display_name || u.displayName,
            }));
        }
        if (typeof lb === 'object' && Array.isArray(lb.data) && !lb.tab_leaderboard) {
            const sorted = [...lb.data].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
            return sorted.slice(0, limit).map((u) => ({
                ...u,
                name: u.name || u.display_name || u.displayName,
            }));
        }
        const tabData = lb.tab_leaderboard && Array.isArray(lb.tab_leaderboard.data) ? lb.tab_leaderboard.data : [];
        const agentData = lb.agent_leaderboard && Array.isArray(lb.agent_leaderboard.data) ? lb.agent_leaderboard.data : [];
        const pick = tabData.length ? tabData : agentData;
        if (pick.length === 0) return [];
        const sorted = [...pick].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
        return sorted.slice(0, limit).map((u) => ({
            ...u,
            email: u.email,
            user: u.user || u.email,
            name: u.name || u.display_name || u.displayName || '',
        }));
    }
    function memberMatchesCursorLeaderboard(memberName, cursorData) {
        if (!cursorData || !memberName) return false;
        const list = getCursorLeaderboardRowsForMatch(cursorData);
        const emailLocal = String(memberName).toLowerCase().split('@')[0].replace(/[^a-z0-9]/g, '');
        const parts = String(memberName).trim().split(/\s+/).filter(Boolean);
        const firstFromName = (parts[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const lastFromName = (parts.length > 1 ? parts[parts.length - 1] : '').toLowerCase().replace(/[^a-z0-9]/g, '');
        for (const row of list) {
            const raw = row.name || row.display_name || row.displayName || row.email || row.user || '';
            const localPart = String(raw).toLowerCase().split('@')[0].replace(/[^a-z0-9]/g, '');
            if (emailLocal && localPart && (localPart === emailLocal || emailLocal.includes(localPart) || localPart.includes(emailLocal))) return true;
            if (similarEnough(memberName, raw, 3)) return true;
            if (localPart && firstFromName.length >= 2 && (localPart.includes(firstFromName) || firstFromName.includes(localPart))) return true;
            if (lastFromName.length >= 2 && localPart && localPart.includes(lastFromName)) return true;
        }
        return false;
    }

    function memberMatchesCopilotLeaderboard(memberName, copilotRaw) {
        if (!copilotRaw || !memberName) return false;
        const users = copilotRaw.userLeaderboard || (Array.isArray(copilotRaw) ? null : null);
        if (!Array.isArray(users) || users.length === 0) return false;
        const nameNorm = normalizeForMatch(memberName);
        const parts = nameNorm.split(/\s+/).filter(Boolean);
        const firstFromName = parts[0] || '';
        const lastFromName = parts.length > 1 ? parts[parts.length - 1] : '';
        for (const u of users) {
            const login = (u.user_login || '').toLowerCase();
            const loginSpaced = login.replace(/[._-]/g, ' ');
            if (similarEnough(memberName, login) || similarEnough(memberName, loginSpaced)) return true;
            const localPart = login.replace(/[._-]/g, '');
            const nameNoSpace = nameNorm.replace(/\s/g, '');
            if (localPart && (nameNoSpace.includes(localPart) || localPart.includes(nameNoSpace))) return true;
            if (localPart && firstFromName.length >= 2 && (localPart.includes(firstFromName) || firstFromName.includes(localPart))) return true;
            if (lastFromName.length >= 2 && localPart && localPart.includes(lastFromName)) return true;
        }
        return false;
    }

    /**
     * Compute per-person AI adoption rating 1–4 using both Cursor + Copilot data.
     * Shared between main dashboard and project-detail page.
     * @param {string} memberName - Developer display name
     * @param {number} sp - Story points for this person
     * @param {Array} individuals - All team members [{name, pts, ...}]
     * @param {string} projectName - Project name for repo matching
     * @param {object|null} cursorData - Cursor data (cursordata.json)
     * @param {object|null} copilotData - Copilot data (copilotdata.json, with userLeaderboard)
     * @returns {number|null} Rating 1–4 or null if no data
     */
    function computePersonAiAdoptionRating(memberName, sp, individuals, projectName, cursorData, copilotData) {
        if (!cursorData && !copilotData) return null;
        const list = individuals || [];
        const spValues = list.map(function(i) { return Number(i && i.pts) || 0; });
        var minSp = spValues.length ? Math.min.apply(null, spValues) : 0;
        var maxSp = spValues.length ? Math.max.apply(null, spValues) : 0;
        var spRange = maxSp - minSp;
        var rating = spRange === 0 ? 2 : 1 + Math.round(((Number(sp) || 0) - minSp) / spRange * 3);
        rating = Math.max(1, Math.min(4, rating));
        var onCursor = memberMatchesCursorLeaderboard(memberName, cursorData);
        var onCopilot = memberMatchesCopilotLeaderboard(memberName, copilotData);
        if (onCursor) rating = Math.max(rating, 2);
        if (onCopilot) rating = Math.max(rating, 2);
        var repoMatch = cursorData ? projectMatchesCursorRepo(projectName, cursorData) : { match: false };
        if (repoMatch.match) {
            var pct = repoMatch.codeCommittedByAiPct || 0;
            if (pct >= 60) rating = Math.min(4, rating + 1);
            else if (pct >= 40) rating = Math.max(rating, 3);
            else if (pct >= 20) rating = Math.max(rating, 2);
        }
        if (onCursor && onCopilot) rating = Math.max(rating, 3);
        return Math.max(1, Math.min(4, rating));
    }

    function normalizeCopilotApiRow(row) {
        if (!row || typeof row !== 'object') return null;
        const day = row.day || row.date;
        if (!day) return null;
        const chat = row.copilot_chat;
        if (chat && (chat.total_active_users != null || chat.total_chats != null) && row.copilot_ide_code_completions) {
            return { day, copilot_chat: chat, copilot_ide_code_completions: row.copilot_ide_code_completions };
        }
        let totalChats = 0;
        const ideChat = row.copilot_ide_chat;
        if (ideChat && Array.isArray(ideChat.editors)) {
            for (const ed of ideChat.editors) {
                if (ed.models) for (const m of ed.models) totalChats += Number(m.total_chats) || 0;
            }
        }
        const dotcomChat = row.copilot_dotcom_chat;
        if (dotcomChat && Array.isArray(dotcomChat.models)) {
            for (const m of dotcomChat.models) totalChats += Number(m.total_chats) || 0;
        }
        let totalAccepted = 0, totalSuggested = 0;
        const langMap = {};
        const code = row.copilot_ide_code_completions;
        if (code && Array.isArray(code.editors)) {
            for (const ed of code.editors) {
                if (!ed.models) continue;
                for (const m of ed.models) {
                    if (!Array.isArray(m.languages)) continue;
                    for (const lang of m.languages) {
                        const name = (lang.name || '').trim() || 'Other';
                        const acc = Number(lang.total_code_lines_accepted) || 0;
                        const sug = Number(lang.total_code_lines_suggested) || 0;
                        totalAccepted += acc;
                        totalSuggested += sug;
                        langMap[name] = (langMap[name] || 0) + acc;
                    }
                }
            }
        }
        const languages = Object.entries(langMap).map(([name, total_code_lines_accepted]) => ({ name, total_code_lines_accepted }));
        return {
            day,
            copilot_chat: {
                total_active_users: row.total_active_users,
                total_engaged_users: row.total_engaged_users,
                total_chats: totalChats
            },
            copilot_ide_code_completions: {
                total_code_lines_accepted: totalAccepted,
                total_code_lines_suggested: totalSuggested,
                languages
            }
        };
    }

    function getCopilotAggregateForLastNDays(rows, days) {
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const now = new Date();
        const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        let filtered = rows.filter(r => {
            const d = r.day || r.date;
            return d && String(d).slice(0, 10) >= cutoffStr;
        });
        if (filtered.length === 0) filtered = rows;
        const agg = {
            copilot_chat: { total_active_users: 0, total_engaged_users: 0, total_chats: 0 },
            copilot_ide_code_completions: { total_code_lines_accepted: 0, total_code_lines_suggested: 0, languages: [] }
        };
        const langMap = {};
        for (const r of filtered) {
            const c = r.copilot_chat || {};
            const code = r.copilot_ide_code_completions || {};
            agg.copilot_chat.total_chats += Number(c.total_chats) || 0;
            const active = Number(c.total_active_users);
            const engaged = Number(c.total_engaged_users);
            if (Number.isFinite(active)) agg.copilot_chat.total_active_users = Math.max(agg.copilot_chat.total_active_users, active);
            if (Number.isFinite(engaged)) agg.copilot_chat.total_engaged_users = Math.max(agg.copilot_chat.total_engaged_users, engaged);
            agg.copilot_ide_code_completions.total_code_lines_accepted += Number(code.total_code_lines_accepted) || 0;
            agg.copilot_ide_code_completions.total_code_lines_suggested += Number(code.total_code_lines_suggested) || 0;
            for (const l of code.languages || []) {
                const name = (l.name || '').trim() || 'Other';
                langMap[name] = (langMap[name] || 0) + (Number(l.total_code_lines_accepted) || 0);
            }
        }
        agg.copilot_ide_code_completions.languages = Object.entries(langMap).map(([name, total_code_lines_accepted]) => ({ name, total_code_lines_accepted }));
        return agg;
    }

    function topPieEntries(obj, n) {
        if (!obj || typeof obj !== 'object') return [];
        const entries = Object.entries(obj).filter(([, v]) => Number(v) > 0)
            .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));
        return entries.slice(0, n).map(([label, pct]) => ({ label, pct_rounded: Math.round(Number(pct) * 10) / 10 }));
    }

    function truncateStr(s, max) {
        const t = String(s || '');
        if (t.length <= max) return t;
        return t.slice(0, max - 1) + '…';
    }

    function getCopilotOrgSnapshot(copilotRaw) {
        if (copilotRaw == null) return null;
        let source = copilotRaw;
        if (!Array.isArray(source) && source.enterprise && Array.isArray(source.enterprise)) {
            source = source.enterprise;
        }
        let arr = Array.isArray(source) ? source : [source];
        if (arr.length === 0) return null;
        const isApiShape = arr[0].date && (arr[0].copilot_ide_chat != null || arr[0].copilot_ide_code_completions != null);
        const normalized = isApiShape
            ? arr.map(normalizeCopilotApiRow).filter(Boolean)
            : arr.map(r => ({ day: r.day || r.date, copilot_chat: r.copilot_chat || {}, copilot_ide_code_completions: r.copilot_ide_code_completions || {} }));
        if (normalized.length === 0) return null;
        const agg = getCopilotAggregateForLastNDays(normalized, 30);
        if (!agg) return null;
        const chat = agg.copilot_chat || {};
        const code = agg.copilot_ide_code_completions || {};
        const langs = code.languages || [];
        const totalLang = langs.reduce((s, l) => s + (Number(l.total_code_lines_accepted) || 0), 0);
        const topLangs = [...langs]
            .sort((a, b) => (Number(b.total_code_lines_accepted) || 0) - (Number(a.total_code_lines_accepted) || 0))
            .slice(0, TOP_N.LANG)
            .map(l => ({
                language: l.name,
                pct_of_accepted_lines: totalLang > 0 ? Math.round((Number(l.total_code_lines_accepted) / totalLang) * 1000) / 10 : 0
            }));
        const accept = Number(code.total_code_lines_accepted) || 0;
        const suggest = Number(code.total_code_lines_suggested) || 0;
        return {
            source: 'github_copilot_metrics_api',
            window: 'last_30_days',
            active_users_peak: chat.total_active_users || null,
            engaged_users_peak: chat.total_engaged_users || null,
            total_chats: chat.total_chats || 0,
            lines_accepted: accept,
            lines_suggested: suggest,
            acceptance_rate_approx: suggest > 0 ? Math.round((accept / suggest) * 1000) / 10 : null,
            top_languages_by_accepted_lines: topLangs
        };
    }

    function buildCursorOrgSnapshot(cursorData) {
        if (!cursorData || cursorData.error) return null;
        const sum = cursorData.summary || {};
        const repos = Array.isArray(cursorData.aiEditsByRepository) ? cursorData.aiEditsByRepository : [];
        const topRepos = [...repos]
            .sort((a, b) => (Number(b.codeCommittedByAiPct) || 0) - (Number(a.codeCommittedByAiPct) || 0))
            .slice(0, 8)
            .map(r => ({
                project_or_repo: truncateStr(r.projectName || r.repository || '—', 48),
                code_committed_by_ai_pct: r.codeCommittedByAiPct != null ? r.codeCommittedByAiPct : null,
                ai_lines: r.aiLinesCommitted != null ? r.aiLinesCommitted : null
            }));
        return {
            source: 'cursor_api',
            period: cursorData.period || '30d',
            last_sync: cursorData.lastSync || null,
            daily_usage_totals: {
                active_users: sum.totalActiveUsers != null ? sum.totalActiveUsers : null,
                engaged_users: sum.totalEngagedUsers != null ? sum.totalEngagedUsers : null,
                total_requests: sum.totalRequests != null ? sum.totalRequests : null,
                lines_accepted: sum.linesAccepted != null ? sum.linesAccepted : null,
                lines_suggested: sum.linesSuggested != null ? sum.linesSuggested : null
            },
            model_share_top: topPieEntries(cursorData.modelShare, TOP_N.PIE),
            language_ext_share_top: topPieEntries(cursorData.languageShare, TOP_N.PIE),
            intent_top: topPieEntries(cursorData.intentDistribution, TOP_N.PIE),
            categories_top: topPieEntries(cursorData.categories, TOP_N.PIE),
            repos_highest_ai_pct: topRepos
        };
    }

    function buildCursorProjectSignals(projectName, cursorData, teamMemberNames) {
        if (!cursorData) return null;
        const names = Array.isArray(teamMemberNames) ? teamMemberNames.filter(Boolean) : [];
        const repo = projectMatchesCursorRepo(projectName, cursorData);
        const onLb = names.filter(n => memberMatchesCursorLeaderboard(n, cursorData));
        return {
            project_repo_match: repo.match,
            matched_repo_hint: repo.repository ? truncateStr(repo.repository, TOP_N.REPOS) : null,
            repo_ai_code_committed_pct: repo.match ? repo.codeCommittedByAiPct : null,
            team_members_on_org_cursor_leaderboard: onLb.slice(0, 12),
            team_on_leaderboard_count: onLb.length,
            leaderboard_match_scope: 'top_' + CURSOR_LEADERBOARD_MATCH_LIMIT
        };
    }

    function compactGithubMetrics(rows, maxRows) {
        if (!Array.isArray(rows) || rows.length === 0) return [];
        const sorted = [...rows].sort((a, b) => (Number(b.commits) || 0) - (Number(a.commits) || 0));
        return sorted.slice(0, maxRows || TOP_N.GITHUB_ROWS).map(r => ({
            name: r.name,
            repos: truncateStr(r.repos || '—', TOP_N.REPOS),
            prs: Number(r.prs) || 0,
            commits: Number(r.commits) || 0,
            additions: Number(r.additions) || 0,
            deletions: Number(r.deletions) || 0,
            notes: r.notes && String(r.notes).trim() ? truncateStr(r.notes, 160) : ''
        }));
    }

    function aggregateGithubTeamTotals(rows) {
        if (!Array.isArray(rows) || rows.length === 0) return null;
        let prs = 0, commits = 0, add = 0, del = 0;
        for (const r of rows) {
            prs += Number(r.prs) || 0;
            commits += Number(r.commits) || 0;
            add += Number(r.additions) || 0;
            del += Number(r.deletions) || 0;
        }
        return { contributors_in_table: rows.length, prs, commits, lines_added: add, lines_removed: del };
    }

    async function fetchDevToolsJson() {
        const out = { copilot: null, cursor: null };
        try {
            const r = await fetch('./output/copilotdata.json');
            if (r.ok) out.copilot = await r.json();
        } catch (e) { /* ignore */ }
        try {
            const r = await fetch('./output/cursordata.json');
            if (r.ok) out.cursor = await r.json();
        } catch (e) { /* ignore */ }
        return out;
    }

    function getCopilotUserLeaderboardSnapshot(copilotRaw) {
        if (!copilotRaw) return null;
        const users = copilotRaw.userLeaderboard || (Array.isArray(copilotRaw) ? null : null);
        if (!Array.isArray(users) || users.length === 0) return null;
        return users.slice(0, 15).map(u => ({
            user: u.user_login,
            lines_accepted: u.lines_accepted || 0,
            acceptance_rate: u.acceptance_rate != null ? Math.round(u.acceptance_rate * 100) + '%' : null,
            active_days: u.active_days || 0,
            features: [u.used_chat ? 'chat' : null, u.used_agent ? 'agent' : null, u.used_cli ? 'cli' : null].filter(Boolean).join(', ') || 'completions',
        }));
    }

    global.AiDevToolsContext = {
        getCopilotOrgSnapshot,
        getCopilotUserLeaderboardSnapshot,
        buildCursorOrgSnapshot,
        buildCursorProjectSignals,
        compactGithubMetrics,
        aggregateGithubTeamTotals,
        fetchDevToolsJson,
        projectMatchesCursorRepo,
        memberMatchesCursorLeaderboard,
        memberMatchesCopilotLeaderboard,
        computePersonAiAdoptionRating,
        getCursorLeaderboardRowsForMatch,
        similarEnough,
        CURSOR_LEADERBOARD_MATCH_LIMIT
    };
})(typeof window !== 'undefined' ? window : this);
