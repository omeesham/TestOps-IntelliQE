# JBSIntelliQE — Platform Test Plan

> **Expert-level, readable test plan.** Cases are grouped into 3 depth tiers so the document
> stays skimmable while covering **positive, negative, and edge** scenarios end to end.

| | |
|---|---|
| **System under test** | JBSIntelliQE — multi-tenant, AI-powered QA automation platform |
| **Components** | Frontend (React/Vite, :5173) · Backend (Express/TS, :3001) · Worker process · Azure SQL / Docker SQL · Anthropic Claude API |
| **Plan version** | 1.0 |
| **Author** | QA |
| **Status** | Draft for review |

---

## 1. Overview

### 1.1 Purpose
Verify that JBSIntelliQE lets a tenant user log in, turn requirements into test cases through the
AI pipeline, manage/execute those cases, and view results — while honoring multi-tenancy and
credential security. This is the **manual** test plan (the source of truth for what "correct"
means); generated Playwright specs are a separate artifact.

### 1.2 How to read this plan — the 3 expertise tiers
Each module's cases are grouped so you can pick a depth appropriate to your run:

| Tier | Name | What it covers | Typical priority | When to run |
|------|------|----------------|------------------|-------------|
| **L1** | Smoke / Basic | Core happy path — "does it work at all" | P0 | Every build |
| **L2** | Functional | Positive variations + main negative / error paths | P1–P2 | Per PR / nightly |
| **L3** | Edge & Security | Boundary, concurrency, auth-denied, injection, a11y | P1–P3 | Release / regression |

**Type** values reuse the platform vocabulary (`backend/src/agents/state.ts:96`):
`positive · negative · edge · e2e · api · data · smoke · security · accessibility · performance`.
**Priority:** `P0` (blocks release) → `P3` (nice-to-have).

### 1.3 References
- `CLAUDE.md` — architecture & key patterns
- `backend/src/agents/` — AI pipeline stages (`requirement → planner → generator → script → execution → audit`)
- `backend/src/middleware/auth.middleware.ts` — token auth + tenant context
- `frontend/src/pages/ChatPage.tsx` — generation wizard
- `backend/src/routes/generate.routes.ts`, `test-cases.routes.ts` — generation & case APIs
- `backend/src/utils/crypto.ts` — credential encryption (`__ENC__` prefix)

---

## 2. Scope

### 2.1 In scope (modules)
1. Authentication & Session
2. Test Generation Wizard
3. AI Pipeline & Orchestration
4. Test Case Management
5. Execution & Reports
6. Multi-Tenancy & Security
7. System Configuration

### 2.2 Out of scope
- Any code change (no new "expertise level" feature — the tiers above are a *documentation*
  device, not a product feature).
- Authoring/maintaining the generated Playwright spec files.
- Full load/performance benchmarking (only representative perf cases are included).
- Third-party reliability of JIRA / Confluence / SharePoint / SMTP themselves (we test
  IntelliQE's handling of their responses, not their uptime).

---

## 3. Test strategy

- **Risk-based & tiered.** Always run L1 (smoke) first; escalate to L2/L3 by risk. Auth, the AI
  pipeline, and tenant isolation are the highest-risk areas → deepest L3 coverage.
- **Concrete data only.** Every case uses realistic values (e.g. `alice@example.com`,
  `Test@1234`), never placeholders.
- **Each step has its own expected result** so a failure pinpoints the exact step.
- **Two AI-auth modes must both be tested:** `ANTHROPIC_API_KEY` set (preferred path) and unset
  with an expired `claude` CLI (the recurring "AI engine not connected" failure).

### 3.1 Entry criteria (objectively verifiable)
- Backend reachable at `http://localhost:3001/` and frontend at `http://localhost:5173/`.
- Database initialized (schema `JBSTestOpsAI`); at least one tenant + demo user seeded.
- `ANTHROPIC_API_KEY` configured in `backend/.env` for the happy-path pipeline runs.
- A second tenant + user available for isolation tests.

### 3.2 Exit criteria
- 100% of L1 (P0) cases pass.
- ≥ 95% of L2 cases pass; **zero** open P0/P1 defects.
- All L3 security cases (tenant isolation, credential encryption, auth) pass.

### 3.3 Suspension criteria
- Login broken (no case can run), or the AI pipeline cannot start in either auth mode.

---

## 4. Environment matrix

| Dimension | Values |
|-----------|--------|
| Browsers | Chrome (latest), Edge (latest), Firefox (latest), Safari 17+ |
| Viewports | Desktop 1920×1080, Laptop 1366×768, Mobile 375×667 |
| Backend | Express @ :3001 |
| Frontend | Vite @ :5173 (proxies `/api` → :3001) |
| Database | Azure SQL (Basic 5 DTU, prod) · SQL Server in Docker @ localhost:1433 (local) |
| AI auth | (a) `ANTHROPIC_API_KEY` set · (b) key unset + `claude` CLI logged in · (c) key unset + CLI expired |
| Network | Normal · Slow 3G · Offline / SSE drop |

---

## 5. Test cases by module

> Step shorthand: `Action → Expected` per step. IDs are stable; add new cases with the next number.

### 5.1 Authentication & Session

| ID | Tier | Type | Priority | Title | Preconditions | Steps (Action → Expected) | Expected Result |
|----|------|------|----------|-------|---------------|---------------------------|-----------------|
| TC-AUTH-001 | L1 | positive | P0 | Login with valid credentials | Demo user `alice` exists | 1. Open `/login` → form shows Username, Password, Sign In  2. Enter `alice` / `Test@1234` → no inline error  3. Click Sign In → redirect to dashboard | Authenticated; token `intelliqe-demo-token-{ts}:alice` saved in sessionStorage; sidebar shows role-based nav |
| TC-AUTH-002 | L1 | positive | P0 | Session persists on refresh | Logged in as `alice` | 1. On dashboard, press F5 → page reloads  2. Observe app | Still authenticated; no redirect to `/login` |
| TC-AUTH-003 | L1 | positive | P0 | Logout clears session | Logged in | 1. Click user menu → Logout → redirect to `/login`  2. Press browser Back | Token removed from sessionStorage; protected page not shown; stays on `/login` |
| TC-AUTH-004 | L2 | negative | P1 | Login with wrong password | Demo user exists | 1. Open `/login`  2. Enter `alice` / `wrong` → Sign In | Clear "invalid credentials" error; no token stored; stays on `/login` |
| TC-AUTH-005 | L2 | negative | P1 | Login with unknown user | — | 1. Enter `ghost` / `Test@1234` → Sign In | Generic auth-failed error (no "user not found" enumeration); no token |
| TC-AUTH-006 | L2 | negative | P2 | Empty username / password | — | 1. Leave fields blank → Sign In | Field validation prompts; request not sent |
| TC-AUTH-007 | L2 | positive | P2 | Direct nav to protected route while logged in | Logged in | 1. Navigate to `/reports` directly | Reports page renders (no redirect) |
| TC-AUTH-008 | L2 | negative | P0 | Protected route while logged out | Logged out | 1. Navigate to `/dashboard` directly | Redirected to `/login`; no protected data flashes |
| TC-AUTH-009 | L3 | edge | P1 | Whitespace / case in username | User `alice` | 1. Enter `  Alice  ` / valid pass → Sign In | Handled per policy (trim/case rule) consistently; result documented, no 500 |
| TC-AUTH-010 | L3 | security | P0 | Malformed token rejected | — | 1. Set sessionStorage token to `garbage`  2. Call a protected API | 401; UI redirects to `/login`; no tenant data returned |
| TC-AUTH-011 | L3 | security | P0 | Token without `:username` part | — | 1. Set token `intelliqe-demo-token-123` (no user)  2. Hit protected API | 401; no DB user lookup match; access denied |
| TC-AUTH-012 | L3 | security | P1 | Token for deleted/disabled user | User later disabled | 1. Use a previously valid token for a now-disabled user  2. Hit API | 401/403; session no longer valid |
| TC-AUTH-013 | L3 | negative | P2 | SQL/script in username field | — | 1. Enter `alice'--` / `<script>alert(1)</script>` → Sign In | Input rejected/escaped; no injection, no script execution, no 500 |
| TC-AUTH-014 | L3 | edge | P2 | Concurrent logins, then logout one | Logged in two tabs | 1. Logout in Tab A  2. Act in Tab B | Tab B's next protected call behaves per session policy (documented); no data leak |
| TC-AUTH-015 | L3 | accessibility | P2 | Login form keyboard + labels | — | 1. Tab through fields  2. Submit via Enter  3. Run a11y check | All controls reachable, labeled; error announced to screen reader |

**Edge checklist:** blank, very long username, trailing spaces, unicode, repeated failed attempts, token tampering, back-button after logout.

---

### 5.2 Test Generation Wizard (ChatPage)

| ID | Tier | Type | Priority | Title | Preconditions | Steps (Action → Expected) | Expected Result |
|----|------|------|----------|-------|---------------|---------------------------|-----------------|
| TC-GEN-001 | L1 | positive | P0 | Wizard loads with source options | Logged in | 1. Open Chat/Generate page | Welcome step shows "Web Application" / "API Automation"; then sources: JIRA, Confluence, SharePoint, Upload, Paste Text, Explore App |
| TC-GEN-002 | L1 | positive | P0 | Generate from pasted requirements | On wizard | 1. Pick Paste Text  2. Paste a 1-feature spec  3. Generate | Pipeline runs all stages; results grid shows ≥1 case per feature with title/steps/expected |
| TC-GEN-003 | L1 | positive | P1 | Column selection reflected in grid | Results step reachable | 1. At column-select, toggle off "Preconditions"  2. Continue | Grid hides that column; data intact |
| TC-GEN-004 | L2 | positive | P1 | Generate from uploaded file | Have a `.txt`/`.md`/`.docx` spec | 1. Pick Upload  2. Choose file  3. Generate | File parsed; cases generated; filename shown in run context |
| TC-GEN-005 | L2 | positive | P2 | Edit a generated case before save | Results shown | 1. Edit a title and a step inline  2. Save | Edits persist into the saved case; no other rows affected |
| TC-GEN-006 | L2 | negative | P1 | Empty requirements | Paste Text selected | 1. Leave text empty  2. Generate | Friendly validation error; pipeline does **not** run; nothing saved |
| TC-GEN-007 | L2 | negative | P1 | Whitespace-only requirements | Paste Text | 1. Paste only spaces/newlines  2. Generate | Treated as empty → validation error; no run |
| TC-GEN-008 | L2 | negative | P2 | Unsupported file type | Upload | 1. Upload `.exe`/`.zip`  2. Generate | Rejected with clear message; no run |
| TC-GEN-009 | L2 | negative | P2 | Source picked but no content selected | JIRA/Confluence | 1. Pick JIRA  2. Continue without choosing a story | Prompted to select content; cannot proceed |
| TC-GEN-010 | L3 | edge | P1 | `maxTestCases` = 1 | API/dev access to set param | 1. Generate with `maxTestCases:1` | Exactly ≤1 case; no crash; coverage note reflects the cap |
| TC-GEN-011 | L3 | edge | P2 | `maxTestCases` = 0 | — | 1. Generate with `maxTestCases:0` | Handled gracefully (0 or default applied per spec); no infinite loop, no 500 |
| TC-GEN-012 | L3 | edge | P2 | `maxTestCases` very large, tiny spec | — | 1. Generate with `maxTestCases:1000`, 1-line spec | Output capped sanely; no duplicate/garbage cases; completes without timeout |
| TC-GEN-013 | L3 | edge | P2 | Huge requirements input | — | 1. Paste a very large (e.g. 100 KB) spec  2. Generate | Either processed or rejected with size message; no hang, no partial corrupt save |
| TC-GEN-014 | L3 | edge | P1 | Special chars / non-ASCII in spec | — | 1. Paste spec with emoji, RTL text, `</div>`, quotes  2. Generate | Cases generated; characters preserved; no broken JSON, no injection in grid |
| TC-GEN-015 | L3 | negative | P1 | Double-click Generate (duplicate submit) | — | 1. Click Generate twice quickly | Single run starts; button disabled/guarded; no duplicate run or double-charge of tokens |
| TC-GEN-016 | L3 | edge | P2 | Navigate away mid-generation | Run in progress | 1. Start generation  2. Switch page / refresh | App recovers; run state consistent (resumes or fails cleanly, documented) |
| TC-GEN-017 | L3 | accessibility | P2 | Wizard keyboard navigation | — | 1. Drive the whole wizard via keyboard only | Every step operable; focus order logical; SSE progress announced |

**Edge checklist:** empty/whitespace, oversized input, unsupported file, special chars, duplicate submit, mid-run navigation, `maxTestCases` boundaries (0/1/12/large).

---

### 5.3 AI Pipeline & Orchestration

| ID | Tier | Type | Priority | Title | Preconditions | Steps (Action → Expected) | Expected Result |
|----|------|------|----------|-------|---------------|---------------------------|-----------------|
| TC-PIPE-001 | L1 | positive | P0 | Full pipeline happy path | `ANTHROPIC_API_KEY` set | 1. Generate from a valid 2-feature spec  2. Watch SSE progress | Stages run in order (requirement → planner → generator → script → execution → audit); each emits progress; results produced |
| TC-PIPE-002 | L1 | positive | P0 | SSE progress updates live | Run started | 1. Observe progress panel during run | Stage transitions stream in near-real-time; final state = completed |
| TC-PIPE-003 | L2 | positive | P1 | Coverage rules honored | Valid multi-feature spec | 1. Generate  2. Inspect case types | Each feature has ≥1 positive, negative(s), and edge case; auth-denied cases present where personas differ |
| TC-PIPE-004 | L2 | positive | P2 | Planner counts vs generated | Valid spec | 1. Generate  2. Compare plan's soft targets to grid | Generated set is consistent with plan (within mandatory-minimum rules) |
| TC-PIPE-005 | L3 | negative | P0 | AI auth fallback — key unset, CLI expired | `ANTHROPIC_API_KEY` unset; `claude` CLI logged out | 1. Generate | Clear **"AI engine not connected"** surfaced to user; run marked **failed** (not silently hung); no partial garbage saved |
| TC-PIPE-006 | L3 | positive | P1 | AI auth — CLI fallback works | Key unset; CLI logged in | 1. Generate | Pipeline runs via CLI fallback; results produced |
| TC-PIPE-007 | L3 | negative | P1 | Anthropic API error mid-run | Force API 429/500 (mock/throttle) | 1. Generate during forced API error | Stage retries per policy then fails gracefully with a readable error; run status accurate |
| TC-PIPE-008 | L3 | edge | P1 | Healing loop converges | Spec that triggers healing | 1. Generate; let healing run | Loop stops at convergence (same-findings detected); does not loop forever |
| TC-PIPE-009 | L3 | edge | P0 | Budget cap guard | Low budget configured | 1. Generate a large spec | Run stops at budget cap with a clear "budget reached" status; no runaway token spend |
| TC-PIPE-010 | L3 | edge | P1 | Max-iterations guard | Spec that keeps finding issues | 1. Generate | Stops at max iterations; partial-but-valid output returned with status note |
| TC-PIPE-011 | L3 | negative | P2 | Claude returns malformed JSON | Force non-JSON response | 1. Generate | `parseJsonFromResponse` handles it; stage fails cleanly or repairs; no crash |
| TC-PIPE-012 | L3 | edge | P2 | SSE connection drops mid-run | Run in progress | 1. Kill the SSE stream (offline)  2. Reconnect | UI reflects last-known state then recovers; no duplicate stage events on reconnect |
| TC-PIPE-013 | L3 | edge | P2 | Worker picks up task | Worker process running | 1. Trigger a worker task  2. Observe polling/heartbeat | Worker dequeues (skip-locked), executes, reports result; heartbeat seen ~30s |
| TC-PIPE-014 | L3 | negative | P1 | Worker with bad/missing secret | Worker started w/o `WORKER_SECRET` | 1. Worker calls `/api/pipeline-worker/next-task` | Rejected (worker-auth middleware); no task leaked |

**Edge checklist:** both AI-auth modes, API throttle/error, malformed JSON, healing convergence, budget/iteration caps, SSE drop, worker auth, concurrent runs.

---

### 5.4 Test Case Management

| ID | Tier | Type | Priority | Title | Preconditions | Steps (Action → Expected) | Expected Result |
|----|------|------|----------|-------|---------------|---------------------------|-----------------|
| TC-TCM-001 | L1 | positive | P0 | Save generated cases | Cases generated | 1. Click Save on results | Cases persisted under the current run/tenant; success confirmation; visible on reload |
| TC-TCM-002 | L1 | positive | P1 | View saved cases | Cases saved | 1. Open the run's cases | All fields render: title, steps, expected, type, priority, tags |
| TC-TCM-003 | L2 | positive | P1 | Edit and re-save a case | Case saved | 1. Change priority P2→P0; edit a step  2. Save | Update persists; `updated_at` changes; other cases untouched |
| TC-TCM-004 | L2 | positive | P2 | Tag normalization | Saving with mixed-case tags | 1. Save case with tags `positive, Ui, smoke` | Tags normalized to vocab `POSITIVE/UI/SMOKE`; deduped |
| TC-TCM-005 | L2 | positive | P2 | Title falls back to scenario | Case has `scenario` but blank `title` | 1. Save | `title` populated from `scenario` (back-compat) |
| TC-TCM-006 | L2 | negative | P1 | Save with missing required fields | — | 1. Save a case with empty title & scenario | Rejected with validation error; nothing persisted |
| TC-TCM-007 | L3 | edge | P2 | Invalid `type` value | — | 1. Save case with `type:"banana"` | Rejected or coerced to a valid type per rules; never stored as-is invalid |
| TC-TCM-008 | L3 | edge | P2 | Invalid `priority` value | — | 1. Save with `priority:"P9"` | Rejected/normalized to allowed P0–P3 |
| TC-TCM-009 | L3 | edge | P2 | Very long title / many steps | — | 1. Save title at/over column limit; 50 steps | Stored within limits or rejected cleanly; no truncation corruption, no 500 |
| TC-TCM-010 | L3 | negative | P2 | XSS in case fields | — | 1. Save title `<img src=x onerror=alert(1)>`  2. View case | Rendered as text (escaped); no script execution |
| TC-TCM-011 | L3 | edge | P3 | Export to CSV/TestRail/JIRA | Cases saved | 1. Export | Priority mapping correct (P0→Critical/Highest etc.); all rows present; valid file |
| TC-TCM-012 | L3 | edge | P2 | Concurrent edit of same case | Two sessions, one case | 1. Edit in A and B  2. Save both | Last-write or conflict handled per policy; no silent data loss undocumented |

**Edge checklist:** missing required fields, invalid enums, oversize text, XSS, duplicate save, concurrent edit, tag vocab.

---

### 5.5 Execution & Reports

| ID | Tier | Type | Priority | Title | Preconditions | Steps (Action → Expected) | Expected Result |
|----|------|------|----------|-------|---------------|---------------------------|-----------------|
| TC-EXEC-001 | L1 | positive | P0 | Execute an automated test | A spec is ready | 1. Run the test via Playwright runner | Test executes; pass/fail captured; status updates to executed/passed/failed |
| TC-EXEC-002 | L1 | positive | P1 | Report shows results | A run completed | 1. Open Reports | Pass/fail counts, per-case status, timestamps render correctly |
| TC-EXEC-003 | L2 | positive | P2 | Allure results generated | Run completed | 1. Check `allure-results` for the run | Result files written under the run id |
| TC-EXEC-004 | L2 | positive | P2 | Email notification on run | SMTP configured | 1. Complete a run | Notification email sent to configured recipients with summary |
| TC-EXEC-005 | L2 | negative | P1 | Failing test reported as failed | A deliberately broken spec | 1. Execute | Status = failed; error/trace captured; report shows the failure reason |
| TC-EXEC-006 | L3 | negative | P1 | SMTP unavailable | SMTP down/misconfigured | 1. Complete a run | Run still completes & is recorded; email failure logged, not fatal; user informed |
| TC-EXEC-007 | L3 | edge | P2 | Execution timeout | A hanging test | 1. Execute | Runner times out per config; marked failed with timeout reason; resources released |
| TC-EXEC-008 | L3 | edge | P2 | Empty report (no runs) | New tenant, no runs | 1. Open Reports | Friendly empty state; no errors/blank crash |
| TC-EXEC-009 | L3 | performance | P3 | Many cases in one run | Run with 200+ cases | 1. Execute & open report | Report loads within acceptable time; pagination/virtualization holds up |
| TC-EXEC-010 | L3 | edge | P2 | Concurrent runs isolated | Two runs at once | 1. Start run A and B | Results not cross-contaminated; each report shows only its own cases |

**Edge checklist:** failed test, SMTP down, timeout, empty state, large result set, concurrent runs.

---

### 5.6 Multi-Tenancy & Security

| ID | Tier | Type | Priority | Title | Preconditions | Steps (Action → Expected) | Expected Result |
|----|------|------|----------|-------|---------------|---------------------------|-----------------|
| TC-SEC-001 | L1 | security | P0 | Tenant sees only own data | Tenants A & B each have runs | 1. Log in as A  2. List runs/cases | Only Tenant A's records returned |
| TC-SEC-002 | L2 | security | P0 | Cross-tenant read by ID | A logged in; know a B run id | 1. As A, request B's run id directly | 403 or empty result; **no** B data returned |
| TC-SEC-003 | L2 | security | P0 | Cross-tenant edit/delete by ID | A logged in; B case id known | 1. As A, PATCH/DELETE B's case | Rejected; B's data unchanged |
| TC-SEC-004 | L2 | security | P1 | Platform tenant elevation | Platform tenant (`isPlatform=true`) | 1. Log in as platform admin  2. Access cross-tenant admin views | Elevated access works as designed; scoped per role |
| TC-SEC-005 | L2 | security | P1 | Non-platform cannot elevate | Regular tenant | 1. Attempt a platform-only action | Denied (403) |
| TC-SEC-006 | L3 | security | P0 | Credentials encrypted at rest | Save a config with a secret field | 1. Save a sensitive field (e.g. password/API key)  2. Inspect DB row | Stored value carries `__ENC__` prefix (XOR+Base64); plaintext never persisted |
| TC-SEC-007 | L3 | security | P0 | Secrets not returned in plaintext | Encrypted field saved | 1. GET the config via API | Sensitive field masked/omitted/encrypted; never plaintext to client |
| TC-SEC-008 | L3 | security | P1 | Worker secret required | — | 1. Call worker endpoint without `x-worker-secret`  2. Then with wrong value | Both rejected; only correct secret authorizes |
| TC-SEC-009 | L3 | security | P1 | Role-based nav enforced | Low-privilege user | 1. Log in  2. Try to reach an admin-only route directly | Hidden in sidebar **and** blocked server-side (not just UI) |
| TC-SEC-010 | L3 | security | P2 | Injection in tenant-filtered query | — | 1. Send crafted id/params (e.g. `1 OR 1=1`) to a list endpoint | Parameterized query (`$n` shim) prevents injection; no extra rows |
| TC-SEC-011 | L3 | security | P2 | Audit/log of denied access | — | 1. Trigger a cross-tenant attempt | Attempt logged with actor/tenant; no sensitive data in logs |

**Edge checklist:** cross-tenant read/write by id, platform vs non-platform, encryption at rest + in transit, worker secret, server-side authz, injection, logging.

---

### 5.7 System Configuration

| ID | Tier | Type | Priority | Title | Preconditions | Steps (Action → Expected) | Expected Result |
|----|------|------|----------|-------|---------------|---------------------------|-----------------|
| TC-CFG-001 | L1 | positive | P1 | Load system configuration | Logged in (admin) | 1. Open System Configuration | Current settings load without error |
| TC-CFG-002 | L2 | positive | P1 | Save a setting | On config page | 1. Change a non-secret setting  2. Save  3. Reload | Value persists across reload |
| TC-CFG-003 | L2 | positive | P2 | Per-tenant pipeline override | Tenant override allowed | 1. Set a pipeline-definition override  2. Run pipeline | Override (stages/budget/guards) takes effect for that tenant only |
| TC-CFG-004 | L2 | negative | P2 | Invalid setting value | — | 1. Enter an out-of-range / wrong-type value  2. Save | Validation error; previous value retained |
| TC-CFG-005 | L3 | edge | P2 | Malformed pipeline-definition JSON | — | 1. Provide invalid override JSON | Rejected with clear error; falls back to default definition; no crash |
| TC-CFG-006 | L3 | security | P1 | Secret config field encrypted | — | 1. Save a credential-type setting  2. Inspect DB | `__ENC__` prefix present; see TC-SEC-006/007 |
| TC-CFG-007 | L3 | edge | P3 | Concurrent config save | Two admins | 1. Save different values simultaneously | Last-write or conflict handled; no corrupt config |

**Edge checklist:** invalid value, malformed JSON override, secret encryption, concurrent save, default fallback.

---

## 6. Traceability (case → module → code)

| Module | Case ID range | Primary code references |
|--------|---------------|-------------------------|
| Authentication & Session | TC-AUTH-001…015 | `frontend/src/pages/LoginPage` · `backend/src/middleware/auth.middleware.ts` |
| Test Generation Wizard | TC-GEN-001…017 | `frontend/src/pages/ChatPage.tsx` · `backend/src/routes/generate.routes.ts` |
| AI Pipeline & Orchestration | TC-PIPE-001…014 | `backend/src/agents/pipeline.ts` · `agents/*Agent.ts` · `claude-runner.ts` · `orchestrator/` · `worker/` · `services/sse-manager.ts` |
| Test Case Management | TC-TCM-001…012 | `backend/src/routes/test-cases.routes.ts` · `agents/state.ts` |
| Execution & Reports | TC-EXEC-001…010 | `services/playwright-runner.service.ts` · `services/email.service.ts` · `allure-results/` |
| Multi-Tenancy & Security | TC-SEC-001…011 | `middleware/auth.middleware.ts` · `middleware/worker-auth.middleware.ts` · `utils/crypto.ts` · `db.ts` |
| System Configuration | TC-CFG-001…007 | System Configuration page · `qa_pipeline_definitions` · `config/pipeline-definition.json` |

---

## 7. Risk register & assumptions

| Risk | Likelihood | Impact | Mitigation (covered by) |
|------|-----------|--------|--------------------------|
| AI engine disconnects (CLI login expiry) | High | High | TC-PIPE-005/006 — enforce `ANTHROPIC_API_KEY` path; verify clear failure message |
| Cross-tenant data leak | Medium | Critical | TC-SEC-001…003, 010 |
| Credentials exposed in plaintext | Low | Critical | TC-SEC-006/007, TC-CFG-006 |
| Runaway token spend | Medium | High | TC-PIPE-009/010 (budget & iteration guards) |
| Malformed AI output breaks pipeline | Medium | Medium | TC-PIPE-011 |

**Assumptions:**
- "Expertise level" is a documentation/organization device (the L1/L2/L3 tiers), **not** a product
  feature — confirmed against the codebase (no such concept exists).
- Demo auth uses the `intelliqe-demo-token-{ts}:{username}` format (not JWT).
- Two tenants and a low-privilege user are available for isolation/authz cases.

---

*Generated as a manual test plan. Test `type`/`priority`/`tag` values intentionally match the
platform vocabulary so these cases can later be imported into IntelliQE if desired. Ask to also
emit a CSV for TestRail/JIRA import.*
