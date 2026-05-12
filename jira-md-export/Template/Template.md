**Product:** iOS 
**Parent:** EHR 
**Manager:** Nandkishor
**Sprint name:** Sprint E1 PI 26.1.2  
**Review date:** 2026-02-04 
**Status:** Closed 
**DataAt:** 2:30 PM, 3rd Feb 2026

---

## 1. Team-level metrics (week over week / sprint over sprint)

### 1.1 Output & delivery

| Metric | This week/sprint | Previous week/sprint | Trend | Notes |
|------|------------------|----------------------|-------|------|
| Story points completed | CSP | PSP | Arrow_StoryPoints | General Trend |
| Dev story points completed | CDEVSP | PDEVSP | Arrow_DevPoints | Dev effort (total − QA) |
| QA story points completed | CQASP | PQASP | Arrow_QAPoints | QA effort |
| Actual story points completed | CASP | PASP | Arrow_ActualStoryPoints | Actual effort |
| Stories / tickets closed | CCT | PCT | Arrow_Tickets | General Trend |
| Sprint completion rate (%) | CSCR | PSCR | Arrow_SprintCompletion | Sprint Completion |
| Carry-over rate (%) | CCAR | PCAR | Arrow_Carryover | Work not completed |
| Deployments / releases | 1 | 1 | ↑ |  1 planned |

**Work classification (tickets opened vs closed in this sprint)**  
*Opened* = created during the sprint window; *closed* = any assigned work item in **Done** (stories, tasks, bugs, and other types — same scope as **Stories / tickets closed** / CCT). JIRA **Work Classification**; if empty → **Uncategorized**.  
This is **not** the same as **Bugs closed** in section 1.2, which counts **only** issues of type **Bug**.

WORK_CLASSIFICATION_TABLE

**Epic focus (team-level)**  
*Epic* = JIRA **parent** when it is an Epic (or Initiative), else **Epic Link** when present. Issues of type **Epic** use their own summary. Everything else is **No epic**. *Opened* / *closed* use the **same definitions** as Work classification above.

WORK_EPIC_TABLE

---

### 1.2 Quality & health

| Metric | This week/sprint | Previous | Trend | Notes |
|------|------------------|----------|-------|------|
| Bugs opened | CBO | PBO | Arrow_BugsOpened | Opened Bugs |
| Bugs closed | CBC | PBC | Arrow_BugsClosed | Closed Bugs |
| Bug fix rate (%) | CBFR | PBFR | Arrow_BugFixRate | CBC / CBO x 100 |
| Defect density (bugs/SP) | CDDR | PDDR | Arrow_DefectDensity | Bugs opened / SP completed |
| Cycle time | CCYT days | PCYT days | Arrow_CycleTime | Current Cycle Time |
| Regulatory & compliance (% of cycle time) | CREGPCT | PREGPCT | - | Work Classification: 1. Regulatory ; regDays=CREGDAYS ; totDays=CTOTDAYS |
| Blockers / escalations | CB | PB | Arrow_Blockers | Blockers |

---

### 1.3 Context (outside team control)

- [x] Stories/tickets available: Yes  
- [ ] Capacity: All Team available 
- [ ] Blockers: External API latency (resolved mid-week)  
- **Notes:**  
  Stable sprint with minor dependency risk early in the week.

---

## 2. Individual-level metrics (week over week)

### 2.1 Output by individual

| Name | Story points (completed) | Tickets closed | vs last week | Context |
|------|--------------------------|----------------|--------------|--------|
| DevName | SPCompleted | TicketsClosed | TicketsTrend | Supporting team |

> *Note: Story points are directional indicators, not performance scores.*

---

### 2.2 AI adoption & impact

| Name | AI usage level (1–5) | Change vs last week | Notes |
|------|----------------------|---------------------|------|
| DevName | AILevel | ChangeVSLastWeek | Notes |


> *AI usage reflects enablement, not performance evaluation.*

---

### 2.3 Github Metrics

| Name | Repositories | PRs | Commits | Lines (+) | Lines (−) | Notes |
|------|--------------|-----|--------|-----------|-----------|-------|
| DevName | ReposList | PRCount | CommitsCount | Additions | Deletions | Notes |


> *GitHub metrics for this sprint window; used for productivity context (code changes, PR activity).*

---

### 2.4 QA Output by individual

| Name | QA points (completed) | QA tickets | Notes |
|------|----------------------|------------|-------|
| QAName | QASPCompleted | QATicketsClosed | QA testing effort |


> *QA points reflect testing effort from the JIRA "QA Points" field, grouped by QA Assignee.*

---

### 2.5 Confluence Activity

| Name | Pages Created | Pages Edited | Spaces | Notes |
|------|--------------|-------------|--------|-------|
| DevName | ConfCreated | ConfEdited | ConfSpaces | Docs contribution |


> *Confluence pages created or edited during the sprint window; uses the same Atlassian account as JIRA.*

---

### 2.6 TestRail: Test Cases

| Metric | This Sprint | Previous | Trend | Notes |
|------|-------------|----------|-------|-------|
| Test cases created | TR_CASES_CREATED | TR_PCASES_CREATED | Arrow_TRCasesCreated | New cases authored in sprint |
| Test runs created | TR_RUNS_CREATED | TR_PRUNS_CREATED | Arrow_TRRunsCreated | Runs set up by named QA |
| Test plans created | TR_PLANS_CREATED | TR_PPLANS_CREATED | Arrow_TRPlansCreated | Plans set up by named QA |

**Automation coverage (snapshot):**

| Metric | Value |
|------|-------|
| Total test cases | TR_TOTAL_CASES |
| Automated | TR_AUTO_COUNT (TR_AUTO_PCT) |
| Automation in progress | TR_AUTO_INPROG |
| Manual only | TR_MANUAL_COUNT (TR_MANUAL_PCT) |
| By type | TR_AUTO_BY_TYPE |


> *Test cases created is counted by created_on date in the sprint window. Automation coverage is a project-wide snapshot.*

---

### 2.7 TestRail QA by Individual

| Name | Cases Created | Runs Created | Plans Created | Notes |
|------|--------------|-------------|--------------|-------|
| TRQAName | TRCasesCreated | TRRunsCreated | TRPlansCreated | TRNotes |


> *All three metrics use created_by in TestRail — authorship only, not execution. Excludes generic test accounts.*

---

## 3. Anomalies & follow-up

| What | Severity | Owner | Issue |
|-----|----------|-------|-----------|
| BlockerTicket | SeverityOfTicket | AssignedTo | Monitor |


---

## 4. JIRA Hygiene

HYGIENE_SECTION
