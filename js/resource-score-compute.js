/**
 * Shared Dev Data resource score (0–10): same formula for main dashboard and project detail.
 * Adapters supply name-matching and Cursor row sourcing (exclusions differ per page).
 */
(function (global) {
  function percentileRank(value, arr) {
    if (!arr || arr.length === 0) return 0;
    const less = arr.filter((x) => Number(x) < Number(value)).length;
    return arr.length === 1 ? 0.5 : less / Math.max(1, arr.length - 1);
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, Number(v) || 0));
  }

  function safeLogNorm(value, cap) {
    const v = Math.max(0, Number(value) || 0);
    const c = Math.max(1, Number(cap) || 1);
    return clamp01(Math.log1p(v) / Math.log1p(c));
  }

  function stdDev(nums) {
    const arr = (nums || []).map(Number).filter(Number.isFinite);
    if (arr.length <= 1) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  }

  function countReposFromSummary(reposText) {
    if (!reposText || reposText === '—') return 0;
    const txt = String(reposText);
    const listed = txt.split(',').map((s) => s.trim()).filter(Boolean).length;
    const more = txt.match(/\+(\d+)\s+more/i);
    return listed + (more ? Number(more[1]) || 0 : 0);
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
    let totalAccepted = 0;
    let totalSuggested = 0;
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
        total_chats: totalChats,
      },
      copilot_ide_code_completions: {
        total_code_lines_accepted: totalAccepted,
        total_code_lines_suggested: totalSuggested,
        languages,
      },
    };
  }

  function getCopilotAggregateForLastNDays(rows, days) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    let filtered = rows.filter((r) => {
      const d = r.day || r.date;
      return d && String(d).slice(0, 10) >= cutoffStr;
    });
    if (filtered.length === 0) filtered = rows;
    const agg = {
      day: null,
      copilot_chat: { total_active_users: 0, total_engaged_users: 0, total_chats: 0 },
      copilot_ide_code_completions: { total_code_lines_accepted: 0, total_code_lines_suggested: 0, languages: [] },
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
    agg.copilot_ide_code_completions.languages = Object.entries(langMap).map(([name, total_code_lines_accepted]) => ({
      name,
      total_code_lines_accepted,
    }));
    agg.periodLabel = days === 30 ? 'Last 30 days' : `Last ${days} days`;
    return agg;
  }

  function computeCopilotOrgSignal(copilotData) {
    if (!copilotData) return 0.5;
    const rows = Array.isArray(copilotData)
      ? copilotData
      : copilotData.enterprise && Array.isArray(copilotData.enterprise)
        ? copilotData.enterprise
        : [];
    if (!rows.length) return 0.5;
    const isApiShape = rows.length > 0 && rows[0].date && (rows[0].copilot_ide_chat != null || rows[0].copilot_ide_code_completions != null);
    const normalized = isApiShape
      ? rows.map(normalizeCopilotApiRow).filter(Boolean)
      : rows.map((r) => ({
          day: r.day || r.date,
          copilot_chat: r.copilot_chat || {},
          copilot_ide_code_completions: r.copilot_ide_code_completions || {},
        }));
    if (!normalized.length) return 0.5;
    const agg = getCopilotAggregateForLastNDays(normalized, 30);
    if (!agg) return 0.5;
    const chat = agg.copilot_chat || {};
    const code = agg.copilot_ide_code_completions || {};
    const active = Number(chat.total_active_users) || 0;
    const engaged = Number(chat.total_engaged_users) || 0;
    const accepted = Number(code.total_code_lines_accepted) || 0;
    const suggested = Number(code.total_code_lines_suggested) || 0;
    const engagement = active > 0 ? clamp01(engaged / active) : 0.5;
    const acceptance = suggested > 0 ? clamp01(accepted / suggested) : 0.5;
    return clamp01(0.6 * engagement + 0.4 * acceptance);
  }

  function getCursorLeaderboardSignal(memberName, cursorData, getRows, similarEnough) {
    if (!cursorData || !memberName) return { found: false, score: 0, rank: null };
    const list = getRows(cursorData);
    if (!list.length) return { found: false, score: 0, rank: null };
    const row = list.find((u) => {
      const dn = u.display_name || u.name || '';
      const em = u.email || '';
      const emailName = em.includes('@') ? em.split('@')[0].replace(/[._-]/g, ' ') : '';
      return similarEnough(memberName, dn) || similarEnough(memberName, emailName);
    });
    if (!row) return { found: false, score: 0, rank: null };
    const linesAccepted = Number(row.total_lines_accepted ?? row.lines_added) || 0;
    const accepts = Number(row.total_accepts ?? row.agent_requests ?? 0) || 0;
    const ratioRaw = Number(row.line_acceptance_ratio ?? row.accept_ratio ?? row.acceptance_rate);
    const qualityScore = clamp01(Number.isFinite(ratioRaw) ? ratioRaw : 0);
    const volumeScore = clamp01(0.75 * safeLogNorm(linesAccepted, 6000) + 0.25 * safeLogNorm(accepts, 1200));
    const rank = Number(row.rank);
    const rankScore = Number.isFinite(rank) ? clamp01(1 - (rank - 1) / Math.max(1, list.length - 1)) : 0.5;
    const score = clamp01(0.45 * volumeScore + 0.35 * qualityScore + 0.2 * rankScore);
    return { found: true, score, rank };
  }

  function getCopilotUserSignal(memberName, copilotUsers, similarEnough) {
    if (!copilotUsers || !Array.isArray(copilotUsers) || !copilotUsers.length || !memberName) {
      return { found: false, score: 0, rank: null };
    }
    const row = copilotUsers.find((u) => {
      const login = (u.user_login || '').toLowerCase();
      const loginSpaced = login.replace(/[._-]/g, ' ');
      return similarEnough(memberName, login) || similarEnough(memberName, loginSpaced);
    });
    if (!row) return { found: false, score: 0, rank: null };
    const linesAccepted = Number(row.lines_accepted) || 0;
    const codeAccepts = Number(row.code_accepts) || 0;
    const ratioRaw = Number(row.acceptance_rate);
    const qualityScore = clamp01(Number.isFinite(ratioRaw) ? ratioRaw : 0);
    const volumeScore = clamp01(0.75 * safeLogNorm(linesAccepted, 6000) + 0.25 * safeLogNorm(codeAccepts, 800));
    const featureCount = (row.used_chat ? 1 : 0) + (row.used_agent ? 1 : 0) + (row.used_cli ? 1 : 0) + 1;
    const breadthScore = clamp01(featureCount / 4);
    const rank = copilotUsers.indexOf(row) + 1;
    const rankScore = clamp01(1 - (rank - 1) / Math.max(1, copilotUsers.length - 1));
    const score = clamp01(0.4 * volumeScore + 0.25 * qualityScore + 0.15 * breadthScore + 0.2 * rankScore);
    return { found: true, score, rank };
  }

  /**
   * @param {object} adapters - { similarEnough(a,b), getCursorLeaderboardRowsForMatch(cursorData) }
   */
  function compute(inds, ghRows, cursorData, copilotData, copilotUserLeaderboard, weights, combinedMax, adapters) {
    const sim = adapters && adapters.similarEnough;
    const getRows = adapters && adapters.getCursorLeaderboardRowsForMatch;
    if (typeof sim !== 'function' || typeof getRows !== 'function') return [];

    const w = weights || {};
    const devCombinedWeight =
      (Number(w.CURSOR_LEADERBOARD) || 0) + (Number(w.COPILOT_INDIVIDUAL) || 0) + (Number(w.AI_TOOLS_ADOPTION) || 0);
    const cap = Number(combinedMax);
    const combinedCap = Number.isFinite(cap) ? Math.min(0.5, Math.max(0, cap)) : 0.24;
    const devCombinedCapped = Math.min(combinedCap, devCombinedWeight);
    const devScale = devCombinedWeight > 0 ? devCombinedCapped / devCombinedWeight : 0;

    const resources = Object.keys(inds || {}).filter((name) => inds[name].pts != null || (inds[name].ai && inds[name].ai.length));
    if (resources.length === 0) return [];

    const ghByName = new Map();
    (ghRows || []).forEach((r) => {
      ghByName.set((r.name || '').trim(), r);
    });

    const copilotOrgSignal = computeCopilotOrgSignal(copilotData);
    const allPts = resources.map((n) => Number(inds[n].pts) || 0);
    const rows = resources.map((name) => {
      const rec = inds[name];
      const pts = Number(rec.pts) || 0;
      const gh = ghByName.get(name) || null;
      const commits = gh ? Number(gh.commits) || 0 : 0;
      const prs = gh ? Number(gh.prs) || 0 : 0;
      const additions = gh ? Number(gh.additions) || 0 : 0;
      const deletions = gh ? Number(gh.deletions) || 0 : 0;
      const lines = additions + deletions;
      const ghActivity = commits * 1.8 + prs * 1.2 + Math.log1p(lines);
      const reviewRatio = commits > 0 ? prs / commits : prs > 0 ? 1 : 0;
      const reviewRatioScore = clamp01(reviewRatio / 0.6);
      const churnPerCommit = commits > 0 ? lines / commits : 0;
      const churnScore = commits > 0 ? clamp01(1 - Math.abs(churnPerCommit - 260) / 260) : 0;
      const ghQuality = clamp01(0.6 * reviewRatioScore + 0.4 * churnScore);
      const repoCount = countReposFromSummary(gh ? gh.repos : '');
      const avgAi = rec.ai && rec.ai.length ? rec.ai.reduce((a, b) => a + (Number(b) || 0), 0) / rec.ai.length : 0;
      const aiStd = stdDev(rec.ai || []);
      const sprintPresence = Number(rec.sprintPresence) || 0;
      const projectCount = rec.projects ? rec.projects.size : 0;
      const cursorSignal = getCursorLeaderboardSignal(name, cursorData, getRows, sim);
      const copilotSignal = getCopilotUserSignal(name, copilotUserLeaderboard, sim);
      const confluencePages = Number(rec.confluencePages) || 0;
      return {
        name,
        pts,
        ghActivity,
        ghQuality,
        avgAi,
        aiStd,
        sprintPresence,
        projectCount,
        repoCount,
        cursorSignal,
        copilotSignal,
        commits,
        prs,
        additions,
        deletions,
        reviewRatio,
        churnPerCommit,
        confluencePages,
      };
    });

    const allGh = rows.map((r) => r.ghActivity);
    const allGhQuality = rows.map((r) => r.ghQuality);
    const allPresence = rows.map((r) => r.sprintPresence);
    const allProjectCounts = rows.map((r) => r.projectCount);
    const allRepoCounts = rows.map((r) => r.repoCount);
    const allConfluencePages = rows.map((r) => r.confluencePages);
    const maxPresence = Math.max(1, ...allPresence);
    const scored = rows.map((r) => {
      const normSP = clamp01(percentileRank(r.pts, allPts));
      const normGitHubImpact = clamp01(percentileRank(r.ghActivity, allGh));
      const normGitHubQuality = clamp01(percentileRank(r.ghQuality, allGhQuality));
      const sprintPresenceRatio = clamp01(r.sprintPresence / maxPresence);
      const aiStability = clamp01(1 - r.aiStd / 1.5);
      const normConsistency = clamp01(0.65 * sprintPresenceRatio + 0.35 * aiStability);
      const normProjectBreadth = clamp01(percentileRank(r.projectCount, allProjectCounts));
      const normRepoBreadth = clamp01(percentileRank(r.repoCount, allRepoCounts));
      const normImpactBreadth = clamp01(0.55 * normRepoBreadth + 0.45 * normProjectBreadth);
      const normAI = clamp01((r.avgAi - 1) / 3);
      const normAiTools = clamp01(normAI * (0.7 + 0.3 * copilotOrgSignal));
      const normCursor = clamp01(r.cursorSignal.score);
      const normCopilot = clamp01(r.copilotSignal.score);
      const normConfluence = clamp01(percentileRank(r.confluencePages, allConfluencePages));
      const raw =
        (Number(w.DELIVERY) || 0) * normSP +
        (Number(w.GITHUB_IMPACT) || 0) * normGitHubImpact +
        (Number(w.GITHUB_QUALITY) || 0) * normGitHubQuality +
        (Number(w.CONSISTENCY) || 0) * normConsistency +
        (Number(w.IMPACT_BREADTH) || 0) * normImpactBreadth +
        (Number(w.CONFLUENCE_DOCS) || 0) * normConfluence +
        ((Number(w.CURSOR_LEADERBOARD) || 0) * devScale) * normCursor +
        ((Number(w.COPILOT_INDIVIDUAL) || 0) * devScale) * normCopilot +
        ((Number(w.AI_TOOLS_ADOPTION) || 0) * devScale) * normAiTools;
      const score = Math.round(raw * 10);
      const contribDelivery = (Number(w.DELIVERY) || 0) * normSP * 10;
      const contribGitHubImpact = (Number(w.GITHUB_IMPACT) || 0) * normGitHubImpact * 10;
      const contribGitHubQuality = (Number(w.GITHUB_QUALITY) || 0) * normGitHubQuality * 10;
      const contribConsistency = (Number(w.CONSISTENCY) || 0) * normConsistency * 10;
      const contribImpactBreadth = (Number(w.IMPACT_BREADTH) || 0) * normImpactBreadth * 10;
      const contribConfluence = (Number(w.CONFLUENCE_DOCS) || 0) * normConfluence * 10;
      const contribCursor = ((Number(w.CURSOR_LEADERBOARD) || 0) * devScale) * normCursor * 10;
      const contribCopilot = ((Number(w.COPILOT_INDIVIDUAL) || 0) * devScale) * normCopilot * 10;
      const contribAI = ((Number(w.AI_TOOLS_ADOPTION) || 0) * devScale) * normAiTools * 10;
      const raw10 = raw * 10;
      return {
        name: r.name,
        score: Math.max(0, Math.min(10, score)),
        breakdown: {
          weights: { ...w },
          weightsEffective: {
            DELIVERY: Number(w.DELIVERY) || 0,
            GITHUB_IMPACT: Number(w.GITHUB_IMPACT) || 0,
            GITHUB_QUALITY: Number(w.GITHUB_QUALITY) || 0,
            CONSISTENCY: Number(w.CONSISTENCY) || 0,
            IMPACT_BREADTH: Number(w.IMPACT_BREADTH) || 0,
            CONFLUENCE_DOCS: Number(w.CONFLUENCE_DOCS) || 0,
            CURSOR_LEADERBOARD: (Number(w.CURSOR_LEADERBOARD) || 0) * devScale,
            COPILOT_INDIVIDUAL: (Number(w.COPILOT_INDIVIDUAL) || 0) * devScale,
            AI_TOOLS_ADOPTION: (Number(w.AI_TOOLS_ADOPTION) || 0) * devScale,
            DEV_TOOLS_COMBINED: devCombinedCapped,
          },
          normDelivery: normSP,
          normGitHubImpact,
          normGitHubQuality,
          normConsistency,
          normImpactBreadth,
          normConfluence,
          normCursor,
          normCopilot,
          normAiTools,
          contribDelivery,
          contribGitHubImpact,
          contribGitHubQuality,
          contribConsistency,
          contribImpactBreadth,
          contribConfluence,
          contribCursor,
          contribCopilot,
          contribAI,
          raw10,
          actuals: {
            storyPoints: r.pts,
            githubCommits: r.commits,
            githubPrs: r.prs,
            githubAdditions: r.additions,
            githubDeletions: r.deletions,
            ghActivityIndex: r.ghActivity,
            githubReviewRatio: r.reviewRatio,
            githubChurnPerCommit: r.churnPerCommit,
            sprintPresence: r.sprintPresence,
            projectCount: r.projectCount,
            repoCount: r.repoCount,
            avgAiRating: r.avgAi,
            aiStability,
            copilotOrgSignal,
            cursorOnLeaderboard: r.cursorSignal.found,
            cursorLeaderboardScore: r.cursorSignal.score,
            cursorLeaderboardRank: r.cursorSignal.rank,
            copilotOnLeaderboard: r.copilotSignal.found,
            copilotLeaderboardScore: r.copilotSignal.score,
            copilotLeaderboardRank: r.copilotSignal.rank,
            confluencePages: r.confluencePages,
          },
        },
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  global.VelosyncresourceScore = { compute };
})(typeof window !== 'undefined' ? window : this);
