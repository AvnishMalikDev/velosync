/**
 * Parse sprint markdown content into a structured data object.
 * Used by the main dashboard when loading .md files or files.json.
 */
(function (global) {
    function parseMD(text) {
        const dateMatch = text.match(/Review date:.*?(\d{4}-\d{2}-\d{2})/i);
        const reviewDate = dateMatch ? dateMatch[1].trim() : null;
        const status = text.match(/\*\*Status:\*\*\s*(.*)/i)?.[1]?.trim() || 'Closed';
        const completionMatch = text.match(/Sprint completion rate \(%\)\s*\|\s*(\d+)%\s*\|\s*(\d+)%/i);

        /** Prefer row-based parse so "Bugs opened" in notes column cannot steal the match. */
        function parseBugRowsFromQualityTable(src) {
            let bugsOpened = null;
            let bugsClosed = null;
            const lines = src.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line.startsWith('|')) continue;
                const cols = line.split('|').map(function (c) { return c.trim(); });
                if (cols.length < 4) continue;
                const metric = (cols[1] || '').toLowerCase();
                if (metric === 'bugs opened') {
                    const v = parseInt(String(cols[2] || '').replace(/[^\d-]/g, ''), 10);
                    bugsOpened = Number.isFinite(v) ? v : 0;
                } else if (metric === 'bugs closed') {
                    const v0 = parseInt(String(cols[2] || '').replace(/[^\d-]/g, ''), 10);
                    bugsClosed = Number.isFinite(v0) ? v0 : 0;
                }
            }
            return {
                bugsOpened: bugsOpened != null ? bugsOpened : 0,
                bugsClosed: bugsClosed != null ? bugsClosed : 0,
            };
        }
        const bugRows = parseBugRowsFromQualityTable(text);

        /** Rows from §1.1 Work classification table (JIRA); used for Work Categorization chart. */
        function parseWorkClassificationTable(src) {
            const out = [];
            const lines = src.split('\n');
            let i = 0;
            while (i < lines.length) {
                const line = lines[i].trim();
                if (line.includes('| Work Classification |') && /Opened/i.test(line) && /Closed/i.test(line)) {
                    i++;
                    if (i < lines.length && /^\|[\s|:-]+\|/.test(lines[i])) i++;
                    while (i < lines.length) {
                        const L = lines[i].trim();
                        if (!L.startsWith('|')) break;
                        if (/^\|[\s|:-]+\|/.test(L)) {
                            i++;
                            continue;
                        }
                        const cols = L.split('|').map(function (c) { return c.trim(); });
                        const cat = cols[1];
                        if (!cat || /^work classification$/i.test(cat)) {
                            i++;
                            continue;
                        }
                        const op = parseInt(String(cols[2] || '').replace(/[^\d-]/g, ''), 10);
                        const cl = parseInt(String(cols[3] || '').replace(/[^\d-]/g, ''), 10);
                        out.push({
                            category: cat,
                            opened: Number.isFinite(op) ? op : 0,
                            closed: Number.isFinite(cl) ? cl : 0,
                        });
                        i++;
                    }
                    break;
                }
                i++;
            }
            return out;
        }

        /** Rows from §1.1 Epic table (after Work classification); same opened/closed semantics. */
        function parseEpicWorkTable(src) {
            const out = [];
            const lines = src.split('\n');
            let i = 0;
            while (i < lines.length) {
                const line = lines[i].trim();
                if (line.includes('| Epic |') && /Opened/i.test(line) && /Closed/i.test(line)) {
                    i++;
                    if (i < lines.length && /^\|[\s|:-]+\|/.test(lines[i])) i++;
                    while (i < lines.length) {
                        const L = lines[i].trim();
                        if (!L.startsWith('|')) break;
                        if (/^\|[\s|:-]+\|/.test(L)) {
                            i++;
                            continue;
                        }
                        const cols = L.split('|').map(function (c) { return c.trim(); });
                        const cat = cols[1];
                        if (!cat || /^epic$/i.test(cat)) {
                            i++;
                            continue;
                        }
                        const op = parseInt(String(cols[2] || '').replace(/[^\d-]/g, ''), 10);
                        const cl = parseInt(String(cols[3] || '').replace(/[^\d-]/g, ''), 10);
                        out.push({
                            category: cat,
                            opened: Number.isFinite(op) ? op : 0,
                            closed: Number.isFinite(cl) ? cl : 0,
                        });
                        i++;
                    }
                    break;
                }
                i++;
            }
            return out;
        }

        /** Parse JIRA Hygiene section into a structured object. */
        function parseHygieneSection(src) {
            const scoreMatch = src.match(/\*\*Hygiene Score:\*\*\s*(\d+)\/100/i);
            const score = scoreMatch ? parseInt(scoreMatch[1], 10) : null;
            if (score === null) return null;

            const totalMatch = src.match(/(\d+)\s+ticket\(s\)\s+analysed/i);
            const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;

            const metrics = [];
            const lines = src.split('\n');
            let inTable = false;
            for (const line of lines) {
                if (!inTable) {
                    if (line.includes('| Hygiene Check |')) { inTable = true; }
                    continue;
                }
                if (/^\|[\s|:-]+\|/.test(line.trim())) continue;
                if (!line.trim().startsWith('|')) { inTable = false; continue; }
                const cols = line.split('|').map(c => c.trim());
                if (cols.length < 5) continue;
                const label = cols[1];
                if (!label || /^hygiene check$/i.test(label)) continue;
                const count = parseInt(String(cols[2] || '').replace(/[^\d]/g, ''), 10);
                const rateStr = String(cols[3] || '').replace('%', '').trim();
                const rate = parseFloat(rateStr) / 100;
                const statusEmoji = cols[4] || '';
                const sample = cols[5] || '—';
                metrics.push({
                    label,
                    count: Number.isFinite(count) ? count : 0,
                    rate: Number.isFinite(rate) ? rate : 0,
                    statusEmoji,
                    sample,
                });
            }
            return { score, total, metrics };
        }

        function parseTestRailExecution(src) {
            var m = src.match(/Test cases created\s*\|\s*(\d+)/i) || src.match(/Test runs created\s*\|\s*(\d+)/i);
            if (!m) return null;
            var pn = function (pat) { var r = src.match(pat); return r ? parseInt(r[1], 10) || 0 : 0; };
            var pp = function (pat) { var r = src.match(pat); return r ? r[1].trim() : 'N/A'; };
            return {
                casesCreated: pn(/Test cases created\s*\|\s*(\d+)/i),
                runsCreated: pn(/Test runs created\s*\|\s*(\d+)/i),
                plansCreated: pn(/Test plans created\s*\|\s*(\d+)/i),
                totalCases: pn(/Total test cases\s*\|\s*(\d+)/i),
                automated: pn(/Automated\s*\|\s*(\d+)/i),
                automationPct: pp(/Automated\s*\|\s*\d+\s*\(([\d]+%|N\/A)\)/i),
                manualOnly: pn(/Manual only\s*\|\s*(\d+)/i),
            };
        }

        const data = {
            reviewDate,
            status,
            points: parseInt(text.match(/Story points completed\s*\|\s*(\d+)/)?.[1] || 0),
            devPoints: parseInt(text.match(/Dev story points completed\s*\|\s*(-?\d+)/)?.[1] || 0),
            qaPoints: parseInt(text.match(/QA story points completed\s*\|\s*(\d+)/)?.[1] || 0),
            actualPoints: parseInt(text.match(/Actual story points completed\s*\|\s*(\d+)/)?.[1] || 0),
            tickets: parseInt(text.match(/Stories \/ tickets closed\s*\|\s*(\d+)/)?.[1] || 0),
            bugsOpened: bugRows.bugsOpened,
            bugsClosed: bugRows.bugsClosed,
            cycleTime: parseFloat(text.match(/Cycle time\s*\|\s*([\d.]+)/i)?.[1] || 0),
            blockers: parseInt(text.match(/Blockers \/ escalations\s*\|\s*(\d+)/)?.[1] || 0),
            completion: parseInt(completionMatch ? completionMatch[1] : 0),
            lastCompletion: parseInt(completionMatch ? completionMatch[2] : 0),
            carryOver: parseInt(text.match(/Carry-over rate.*?\|\s*(\d+)/i)?.[1] || 0),
            prevCarryOver: parseInt(text.match(/Carry-over rate.*?\|\s*\d+%?\s*\|\s*(\d+)/i)?.[1] || 0),
            regulatoryPct: parseInt(text.match(/Regulatory.*?compliance.*?\|\s*(\d+)%?/i)?.[1] || 0),
            regulatoryDays: parseFloat(text.match(/regDays=([\d.]+)/i)?.[1] || 0),
            totalCycleDays: parseFloat(text.match(/totDays=([\d.]+)/i)?.[1] || 0),
            anomalies: [],
            individuals: [],
            qaIndividuals: [],
            confluenceActivity: [],
            githubMetrics: [],
            workClassification: parseWorkClassificationTable(text),
            epicWork: parseEpicWorkTable(text),
            hygiene: parseHygieneSection(text),
            testRailExecution: parseTestRailExecution(text),
            testRailQA: [],
        };

        const lines = text.split('\n');
        let inInd = false, inAI = false, inGithub = false, inQA = false, inConfluence = false, inTestRailQA = false, inAnom = false;

        lines.forEach(line => {
            if (line.includes('2.1 Output')) inInd = true;
            if (line.includes('## 2.2')) inInd = false;
            if (inInd && line.includes('|') && !line.includes('Name') && !line.includes('---')) {
                const cols = line.split('|').map(c => c.trim());
                if (cols[1] && !cols[1].toLowerCase().includes('total')) data.individuals.push({ name: cols[1], pts: parseInt(cols[2]) || 0 });
            }
            if (line.includes('2.2 AI adoption')) inAI = true;
            if (line.includes('### 2.3 Github')) inAI = false;
            if (inAI && line.includes('|') && !line.includes('Name') && !line.includes('---')) {
                const cols = line.split('|').map(c => c.trim());
                const ind = data.individuals.find(i => i.name === cols[1]);
                if (ind) ind.ai = parseInt(cols[2]) || 0;
            }
            if (line.includes('### 2.3 Github')) inGithub = true;
            if (/### 2\.4|## 3\./.test(line)) inGithub = false;
            if (inGithub && line.includes('|') && !line.includes('Name') && !line.includes('Repositories') && !line.includes('---')) {
                const cols = line.split('|').map(c => c.trim());
                if (cols[1] && !String(cols[1]).toLowerCase().includes('team total')) {
                    const parseNum = (v) => { const n = parseInt(String(v || '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
                    data.githubMetrics.push({
                        name: cols[1] || '—',
                        repos: cols[2] || '—',
                        prs: parseNum(cols[3]),
                        commits: parseNum(cols[4]),
                        additions: parseNum(cols[5]),
                        deletions: parseNum(cols[6]),
                        notes: cols[7] || '',
                    });
                }
            }
            if (line.includes('2.4 QA Output')) inQA = true;
            if (/### 2\.5|## 3\./.test(line)) inQA = false;
            if (inQA && line.includes('|') && !line.includes('Name') && !line.includes('---')) {
                const cols = line.split('|').map(c => c.trim());
                if (cols[1] && !cols[1].toLowerCase().includes('total') && cols[1] !== '—') {
                    data.qaIndividuals.push({
                        name: cols[1],
                        qaPts: parseInt(cols[2]) || 0,
                        qaTickets: parseInt(cols[3]) || 0,
                    });
                }
            }
            if (line.includes('2.5 Confluence')) inConfluence = true;
            if (/### 2\.6|## 3\./.test(line)) inConfluence = false;
            if (inConfluence && line.includes('|') && !line.includes('Name') && !line.includes('Pages Created') && !line.includes('---')) {
                const cols = line.split('|').map(c => c.trim());
                if (cols[1] && !cols[1].toLowerCase().includes('total') && cols[1] !== '—') {
                    const parseNum = (v) => { const n = parseInt(String(v || '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
                    data.confluenceActivity.push({
                        name: cols[1],
                        pagesCreated: parseNum(cols[2]),
                        pagesEdited: parseNum(cols[3]),
                        spaces: cols[4] || '—',
                    });
                }
            }
            if (line.includes('2.7 TestRail QA')) inTestRailQA = true;
            if (/## 3\.|### 2\.8/.test(line)) inTestRailQA = false;
            if (inTestRailQA && line.includes('|') && !line.includes('Name') && !line.includes('Cases Created') && !line.includes('---')) {
                var cols = line.split('|').map(function (c) { return c.trim(); });
                if (cols[1] && !cols[1].toLowerCase().includes('total') && cols[1] !== '—') {
                    var pn = function (v) { var n = parseInt(String(v || '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
                    data.testRailQA.push({
                        name: cols[1],
                        casesCreated: pn(cols[2]),
                        runsCreated: pn(cols[3]),
                        plansCreated: pn(cols[4]),
                    });
                }
            }
            if (/## \d+\.\s*Anomalies/i.test(line)) inAnom = true;
            if (inAnom && /## \d+\./.test(line) && !/Anomalies/i.test(line)) inAnom = false;
            if (inAnom && line.includes('|') && !line.includes('What') && !line.includes('---')) {
                const cols = line.split('|').map(c => c.trim());
                if (cols[1] && cols[1].length > 2) {
                    data.anomalies.push({
                        what: cols[1], severity: cols[2], owner: cols[3], issue: cols[4] || '—',
                    });
                }
            }
        });
        return data;
    }

    global.parseMD = parseMD;
})(typeof window !== 'undefined' ? window : this);
