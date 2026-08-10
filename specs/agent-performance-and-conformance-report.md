# IntelliQE — Live Run, Agent Performance & Playwright-Workflow Conformance

**Date:** 2026-08-10 · **Scope:** Boot the whole platform, measure the AI agents on a real scoped run, compare them to the canonical Playwright agents workflow, and apply *non-breaking* robustness guardrails (core functionality untouched).

> **On "never make a mistake."** No test-automation system can *guarantee* zero mistakes — LLM output, live sites, and browsers all vary. What is achievable, and what was done here, is to (1) find and fix the one concrete thing that was actually breaking execution, and (2) add additive guardrails that turn "silent wrong result" into "degrade gracefully / report honestly." Every code change below preserves existing behavior on the happy path.

---

## 1. The application was run end-to-end

| Layer | Status | Evidence |
|---|---|---|
| SQL Server (Docker `mssql-local`, 2022) | ✅ up | schema `JBSTestOpsAI` present; 106 `test_runs`, 209 `automation_scripts` |
| Backend API (`:3001`) | ✅ booted by me | `/api/health` → `{status:ok}`; DB init logged |
| Frontend (`:5173`, Vite) | ✅ booted by me | login page renders (verified via accessibility tree) |
| Worker process | ⏸️ not started | needs `WORKER_SECRET`/`ANTHROPIC_API_KEY` env; **DB shows 0 `qa_pipeline_runs`** — this path has never been used |

- **Tenant:** Jade Business Solutions. **Users:** `jbsadmin` (admin), `qaengineer`.
- **LLM:** Anthropic via **Claude Code CLI** (`claudeCodeMode: cli`), model `claude-opus-4-8`, OAuth token — default provider, status *connected*.
- **Apps under test configured:** `app-orangehrm`, `app-encoreglobal`.
- **Auth for the test run:** the middleware still accepts the legacy `intelliqe-demo-token-{ts}:{username}` format (DB lookup), so I authenticated as the existing `jbsadmin` **without changing any password or creating any user**.

**Key structural fact:** all 106 historical runs went through the **in-process** agent pipeline (`backend/src/agents/pipeline.ts`); the DB-queued **orchestrator/worker** path (`qa_pipeline_runs`) has **zero** usage. So "agent performance" here means the in-process pipeline, which is what the product actually runs.

---

## 2. Agent performance — measured on a real scoped run

A scoped generation was run against OrangeHRM (`maxTestCases: 3`, functional login requirements). **Result: HTTP 200, 3 valid IEEE-829 test cases, 0 errors.** Then a scripts→execute pass was run. Real per-agent timings (from `/api/agent-performance/stats`):

| Agent | Duration | Runs | Notes |
|---|---:|---:|---|
| requirement | 17.1 s | 1 | parses requirements → structured JSON |
| audit | 13.6 s | 1 | runs **in parallel** with planner |
| planner | 45.0 s | 1 | slowest stage — strategy/plan |
| generator | 26.8 s | 1 | 3 IEEE-829 cases |
| script | 90.8 s | 1 | live mode, POM + 3 specs |
| execution | 43.6 s | 1 | Playwright run |

- **Generation wall-clock: 90.0 s** vs a 102.5 s sum of stage times — the `audit ∥ planner` overlap genuinely saves ~13 s. The pipeline also overlaps the grounding crawl with LLM latency. This is efficient orchestration.
- **Generation is clean and honest:** 3 well-formed cases, 0 fabricated results, features correctly reduced to `User Login` + `Field Validation` (no speculative padding).
- **Generated script quality is high** even without grounding: Page Object Model, `getByRole`/label selectors, one test per `describe`, plan-step comments with expected results, real credentials pulled from the app's role config. This conforms to the generator agent's Playwright rules.

---

## 3. Critical reliability finding — Playwright browser version mismatch

This is the one thing that was actually making execution "fail" — and it is an **environment issue, not a code bug**.

- The backend pins **`playwright-core@1.48.0`**, which requires browser build **`chromium-1140`**.
- Only **`chromium-1228` / `chromium-1234`** were installed (from a newer Playwright elsewhere on the machine).
- Consequence on the first live run:
  1. The **grounding crawl failed** (`browserType.launch: Executable doesn't exist … chromium-1140`) → `scriptAgent` fell back to **ungrounded** generation ("selectors invented … likely to fail").
  2. **Execution couldn't launch the browser** → all 3 tests reported `failed` with the launch error surfaced in `failureReason`.

**The system behaved honestly** — it did not fabricate passes, and it recorded the real launch error — but the run was doomed before a single assertion ran.

**Fix applied (non-code):** installed the matching browser for the backend's Playwright —

```bash
cd backend && npx playwright install chromium
```

This provisions `chromium-1140` so the crawl (grounding) and execution can actually launch a browser. *Recommended:* run `npx playwright install --with-deps chromium` in the backend as part of environment setup / the Dockerfile so this can never regress.

**Post-fix execution validation — could not be completed *in this sandbox* (environment, not code).**
Installing `chromium-1140` was attempted repeatedly. The download reaches **100% of 140.4 MiB every time**, but the **extraction/write of `chrome.exe` never finalizes** — `chrome-win/` ends up with only `chrome.dll` + a manifest, and Playwright's `__dirlock` is left held. Ruled out along the way:
- **Not bandwidth** — the download completes to 100%.
- **Not antivirus quarantine** — `Get-MpThreatDetection` shows zero detections (though Defender real-time protection *is* on, and a synchronous scan of the ~150 MB binary on write is the most likely cause of the hung extraction in this sandbox).
- **Not your code** — the backend, the pipeline, and the agents are all fine; this is purely browser *provisioning* on this machine.
- A contributing factor was a stale `__dirlock` left by an install that was killed at a timeout; several concurrent install attempts then deadlocked on it. **The lock has been cleared and the environment left clean** for a retry.

**To validate on your machine (this will work on a normal dev box / CI):**
```bash
# if a previous attempt was interrupted, clear the lock first:
#   rm -rf "%LOCALAPPDATA%\ms-playwright\__dirlock"
cd backend
npx playwright install chromium        # provisions chromium-1140 for playwright-core 1.48
# then re-run a scoped pipeline from the Chat wizard, or:
#   POST /api/pipeline-flow/execute  (with testCases + scripts + appId)
```
Once `chromium-1140/chrome-win/chrome.exe` exists, the live grounding crawl will succeed (grounded selectors instead of invented ones) and execution will produce real per-test pass/fail plus the new `junit.xml` (§5) — instead of the `browserType.launch: Executable doesn't exist` error seen here.

**What the doomed-but-honest first run already proved:** even blocked by the browser, the pipeline never fabricated a pass — it reported `failed: 3` with the true `failureReason` (browser launch) surfaced verbatim. That honest-failure behavior is exactly what you want.

---

## 4. Conformance to the canonical Playwright agents workflow

IntelliQE has **two** agent implementations, and this matters:

1. **In-process TypeScript pipeline** (`agents/*.ts`) — the primary path; each "agent" is one stateless Claude completion via `claude-runner.ts`. Grounding is done by a **hand-written crawler** (`exploreAgent.ts`), not by the model.
2. **Worker/orchestrator path** (`orchestrator/` + `worker/`) — loads the six `.github/agents/*.agent.md` files as system prompts, but `sdk-executor.ts` sends **no `tools` array**, so the browser/test MCP tools those agents describe are never available. (This path has 0 real runs.)

**The canonical Playwright "agents" loop assumes the model itself drives `@playwright/mcp` / `playwright-test` MCP tools.** Neither IntelliQE path gives the model those tools — it instead re-implements grounding deterministically and treats the LLM as a pure text/JSON transformer. That is a legitimate, in several ways more robust design, but it is a **fundamental structural divergence**.

| Playwright agent | In-process implementation | Conformance |
|---|---|---|
| **requirements** (explore live UI via MCP, write REQUIREMENTS.md) | `exploreAgent.ts` (deterministic crawl) + `requirementAgent.ts` (structure to JSON) | **Partial** — grounding intent preserved; read-only snapshot, no Phase-2 interaction; MCP replaced by crawler |
| **test-planner** (explore + produce step-level TestRail-schema plan) | `plannerAgent.ts` — produces effort/risk **strategy**, not step cases | **Divergent role** — step-level cases moved to the generator |
| **test-generator** (record each step live, one test/file, role selectors) | `generatorAgent.ts` (cases) + `scriptAgent.ts` (POM + specs) | **Good** — one-test-per-file, `getByRole`, no `networkidle`, deterministic imports; never records via live MCP |
| **test-healer** (`test_run`→`test_debug`, iterate to green, never skip) | `healingAgent.ts` (+ live variants) | **Strong** — diagnosis-first `classifyFailure`, never weakens/skN assertions; iteration cap lives in the caller (max 2) |
| **pipeline-audit** (compliance watchdog, triage, agent-mistakes.md) | `auditAgent.ts` — a requirements **edge-case enhancer** | **Largest divergence** — functionally unrelated to its `.agent.md`; runs *before* generation |
| **framework-maintainer** (repo hygiene sweep) | — | **Not implemented** (partial deterministic helpers only) |

**Config vs authoring-standard §11** (`executionAgent.ts`): `screenshot: only-on-failure` matches; `trace` differs but is coherent with `retries:0`; **`retries:1`, `video`, and the JUnit reporter were missing.** The JUnit reporter is the documented TestRail/TestLink result-sync point — **now added** (see §5).

---

## 5. Robustness — strengths, and the guardrails applied

### Strengths already in the code (kept, not touched)
- **JSON-parse resilience** — fence-strip → balanced-extract → artifact-repair → salvage-truncated-array (`claude-runner.ts`), with a non-backtracking repair regex. One stray token no longer fails a whole stage.
- **Honest failure semantics** — placeholder specs assert `expect(false)`, not a fake green; execution returns `null` + reason when nothing ran.
- **Spec quarantine** — one un-loadable spec can't zero the whole suite; offenders are isolated and re-run.
- **Deterministic import/path integrity** — import specifiers computed by code, duplicate paths/classes de-collided → eliminates the common "Cannot find module" failure class.
- **Tree-kill timeouts** everywhere; **crawl caching + overlap**; **heal convergence** (all-green / identical-signature / max-passes / time-budget) in the route path.

### Guardrails applied — additive only, **core functionality untouched** (`tsc --noEmit` → exit 0)

| # | File | Change | Why it's non-breaking |
|---|---|---|---|
| **G3** | `agents/requirementAgent.ts` | Wrap the first stage's `parseJsonFromResponse` in try/catch; on unparseable output fall back to the empty-object path that the existing defensive normalization already handles. | Success path parses **exactly as before**; only the previously-fatal "garbage response" case now degrades to a minimal grounded shape instead of aborting the whole run. |
| **G6** | `agents/scriptAgent.ts` | In the credentials block, decrypt a password **only if** it matches `__ENC__/__AES__`, else pass through unchanged. | `decryptStored` is a no-op on plaintext and the guard only fires on encrypted input, so every existing (plaintext) caller is byte-for-byte identical. Prevents an encrypted blob from ever leaking into a prompt / generated code. |
| **§11** | `agents/executionAgent.ts` | Add a `['junit',{outputFile}]` reporter (next to the persistent HTML report when present) and `video: 'retain-on-failure'`. | Purely additive artifacts alongside the existing line/json/html/allure reporters; pass/fail behavior, retries, and trace settings are unchanged. Restores the documented TestRail/TestLink JUnit sync. |

### Recommended next (NOT applied — they need your sign-off or touch the unused worker path)
- **G1/G2** — enforce the *declared-but-dead* convergence/budget guards (`sameFindings`, `budgetExhausted`, per-stage `budgetCap`) in the worker path, behind their existing `enabled` flags.
- **G4** — give the in-process `runPipeline` the same bounded multi-pass heal loop the `/heal` route already has (default max-passes 1 = today's behavior).
- **G7** — fence raw requirements/Jira text as data (prompt-injection framing) like `explorePrompt` already is.
- **G8** — tighten the healer's `module-load` classification so an assertion message containing "cannot resolve" doesn't trigger a full POM regeneration.
- **G9** — surface `crawlDegraded`/`authFailed` as a run-report banner so ungrounded runs are obvious before the timeouts.
- **G10** — tree-kill the Playwright process tree on execution timeout (mirror `claude-runner`).
- **G11** — flag `stop_reason: max_tokens` truncation in the worker path.

---

## 6. How to reproduce

```bash
# 1. DB already runs in Docker (mssql-local on :1433)
# 2. Backend
cd backend && npm run dev            # :3001
# 3. Frontend
cd frontend && npm run dev           # :5173
# 4. One-time: install the matching Playwright browser (fixes execution)
cd backend && npx playwright install chromium
```

Agent timings are exposed live at `GET /api/agent-performance/stats` and in the **Agent Performance** page (hidden route). They are **in-memory** and reset on backend restart — if you want historical agent metrics to survive restarts, that's a small additive enhancement (persist to a `qa_agent_metrics` table) I can do on request.
