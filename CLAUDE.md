# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

### Backend (Express + TypeScript, port 3001)
```bash
cd backend
npm run dev          # Dev server with hot reload (tsx watch)
npm run build        # Compile TypeScript to dist/
npm run start        # Run compiled output (node dist/index.js)
npm run worker:start # Start pipeline worker process
```

### Frontend (React + Vite, port 5173)
```bash
cd frontend
npm run dev      # Dev server with HMR
npm run build    # TypeScript check + Vite production build
npm run lint     # ESLint
npm run preview  # Preview production build
```

### Prerequisites
- Azure SQL Database (Basic 5 DTU in prod). Local dev uses SQL Server in Docker (`docker-compose.yml`) on localhost:1433 — database `JBSTestOpsAI`, schema `JBSTestOpsAI`. Set `DB_BOOTSTRAP=true` locally to auto-create the database.
- Backend must be running before frontend (frontend proxies `/api` → `http://localhost:3001`)
- **AI auth:** the Anthropic API key is configured in the app UI (**System Configuration → LLM Configuration**) and stored AES-encrypted in `client_configurations` (row `llm-<provider>-<env>`). `services/llm-config.service.ts` resolves + decrypts it and hydrates `process.env.ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` at startup, on config save, and as a generate-route preflight; the pipeline then calls the Anthropic API directly via the official SDK. Setting `ANTHROPIC_API_KEY` in `backend/.env` is an optional override (e.g. CI). The legacy `claude` **CLI fallback is disabled** (commented out in `claude-runner.ts`, 2026-06-27) — it expired periodically and caused the recurring "AI engine not connected" failure.
- Worker requires env vars: `ANTHROPIC_API_KEY`, `WORKER_SECRET`, `BACKEND_URL`

## Architecture Overview

**JBSIntelliQE** is a multi-tenant AI-powered QA automation platform that uses Claude agents to generate, execute, and self-heal test cases.

### System Layers

```
Frontend (React SPA) → Backend (Express API, port 3001) → Azure SQL Database (JBSTestOpsAI schema)
                                    ↕
                          Worker Process(es)
                                    ↓
                          Anthropic Claude API
```

### Backend (`backend/src/`)

- **`index.ts`** — Express app entry. Mounts 23 route groups, auth middleware, SSE callback.
- **`db.ts`** — Azure SQL / SQL Server pool (`mssql`). Exposes a pg-compatible `pool.query(text, $1-params) → { rows, rowCount }` **shim** (`translateSql()`/`mapRow()`) so call-sites keep Postgres-style SQL; the shim translates `$n`→`@pn`, `RETURNING`→`OUTPUT`, `LIMIT`→`OFFSET/FETCH`, `now()`→`SYSUTCDATETIME()`, `ILIKE`→`LIKE`, strips `::casts`, JSON-marshals object/array params, and parses JSON columns + dates on read. Dialect-heavy SQL (MERGE, FOR JSON, JSON_MODIFY, skip-locked dequeue) is written directly in T-SQL. Idempotent schema init (never drops objects — data survives redeploys). Schema: `"JBSTestOpsAI"`.
- **`agents/`** — AI pipeline stages executed sequentially:
  1. `requirementAgent.ts` → parse requirements via Claude
  2. `plannerAgent.ts` → create test strategy
  3. `generatorAgent.ts` → generate test cases (maxTokens: 16384)
  4. `scriptAgent.ts` → generate Playwright scripts
  5. `executionAgent.ts` → mark tests ready / execute
  6. `auditAgent.ts` → quality review
  - `pipeline.ts` — orchestrates the full pipeline with healing loop
  - `state.ts` — `TestOpsState` interface shared across agents
  - `claude-runner.ts` — `runClaudePrompt` (async) runs a prompt through the **Anthropic API via the official `@anthropic-ai/sdk`** (API-key only; the `claude` CLI path is commented out/disabled). `runClaudeJson<T>` wraps it with parse-failure retries so a flaky/truncated reply doesn't sink a run. All agents `await` these. Also exposes `isClaudeCliAuthenticated` (now simply: an `ANTHROPIC_API_KEY` is present in the env, hydrated from LLM Configuration) and `parseJsonFromResponse`.
- **`orchestrator/`** — Advanced pipeline management:
  - `orchestrator.ts` — loads pipeline definition, processes stage completion, routes next stage
  - `dependency-engine.ts` — page readiness checks, cascade planning
  - `types.ts` — `StageDefinition`, `PipelineDefinition`, `SSEEvent` interfaces
  - Convergence guards: budget caps, max iterations, same-findings detection
- **`worker/`** — Separate Node.js process that polls `/api/pipeline-worker/next-task`, executes Claude SDK calls, reports results
- **`services/`** — services including:
  - `sse-manager.ts` — Server-Sent Events for real-time pipeline progress
  - `playwright-runner.service.ts` — test execution
  - `email.service.ts` — SMTP test-run notifications
- **`middleware/`** — `auth.middleware.ts` (Bearer token → DB user lookup, attaches tenantId/role); `worker-auth.middleware.ts` (x-worker-secret header)
- **`utils/crypto.ts`** — XOR+Base64 encryption for credentials (prefix `__ENC__`). Sensitive keys list defined here.

### Frontend (`frontend/src/`)

- **`App.tsx`** — Route definitions. Public: `/`, `/login`. Protected routes wrapped in `Layout` with `AuthProvider`.
- **`services/api.ts`** — Centralized axios client with Bearer token interceptor. All backend API calls (~150 functions).
- **`components/layout/`** — `Layout.tsx` (sidebar+header+outlet), `Sidebar.tsx` (role-based nav from server config), `Header.tsx`
- **`pages/`** — 20+ pages: ChatPage (main wizard flow), DashboardPage, ReportsPage, SystemConfigurationPage, etc.
- **`types/index.ts`** — Core interfaces: TestCase, TestConfiguration, ExecutionResult, AgentInfo, etc.
- **`utils/tts.ts`** — Tessa voice assistant (Web Speech API)
- Path alias: `@` → `frontend/src/`

### Multi-Tenancy

Every DB query filters by `tenant_id`. Auth middleware attaches tenant context from the users table. Platform tenants (isPlatform=true) have elevated access.

### Pipeline Configuration

`backend/config/pipeline-definition.json` defines stages, models, budgets, convergence guards. Per-tenant overrides stored in `qa_pipeline_definitions` table.

### Agent Definitions

`.github/agents/` contains 6 agent markdown files (playwright-requirements, playwright-test-planner, playwright-test-generator, playwright-test-healer, playwright-pipeline-audit, playwright-framework-maintainer) loaded by the orchestrator at runtime.

### Test Automation — Page Object Model (POM) convention

Every Playwright spec the platform produces, and the framework shipped to clients,
follow one POM convention. There are two physical forms of the **same** rules
(specs are scenarios; Page Objects own the UI with `readonly` locators + intent
methods; accessibility-first locators; web-first assertions; no `page.waitForTimeout`):

- **Generated specs (platform output)** are **self-contained single-file POM** —
  each `.spec.ts` declares its Page Object class(es) inline and imports only
  `@playwright/test`. This is mandatory because `services/playwright-runner.service.ts`
  executes each spec in isolation (no sibling framework files are written), so a
  spec importing `../pages/...` would fail to load.
  - Single source of truth: **`backend/src/agents/pom-spec-prompt.ts`**
    (`buildPomSpecPrompt` + `pomFallbackSpec`). Both generators import it:
    `agents/scriptAgent.ts` (pipeline "scripting" stage) and
    `routes/automation-scripts.routes.ts` (wizard "Generate Scripts"). The healer
    (`agents/healing-prompt.ts`) preserves the POM structure on fix.
  - **POM + live-crawl integration:** when only a URL is supplied, `exploreAgent.ts`
    crawls the live app (headless Chromium) and produces a UI map (`state.exploredApp`).
    `scriptAgent.ts` condenses that map (`renderUiMap`) into `PomPromptContext.uiMap`,
    so generated Page Objects build locators from REAL observed elements instead of
    guessing — the two features reinforce each other rather than conflict. Both run
    in `runPipeline` (`execute.routes.ts`); the wizard path (`generate.routes.ts` →
    `runGenerationOnly`) crawls into test cases, which the Generate-Scripts route then
    turns into POM specs.
- **Client-deliverable framework** (`client-deliverable/src/`) is the **shared**
  form of the same convention: `pages/` (extend `BasePage`), central `selectors/`
  registry, `fixtures/` injecting page objects, `tests/` specs with zero raw
  `page.*`. Documented in `client-deliverable/src/README.md`.

When changing how specs are generated, edit `pom-spec-prompt.ts` (not the two
call sites) so the generators cannot drift.

### Auto-healer (heal engine)

Both heal paths — `services/healing.service.ts` (wizard "Auto-Heal", DB-backed)
and `agents/healingAgent.ts` (in-pipeline) — run ONE shared engine,
**`agents/heal-engine.ts`** (`healSpecs`). Edit the engine, not the call sites.

Guarantees (the reason a healed test can be trusted):
- **Iterative + feedback** — up to `HEAL_MAX_ATTEMPTS` rounds (clamped 1–5); each
  failed attempt's real re-run error + the attempt history is fed back so the
  model fixes the root cause, not the same wrong guess. Re-runs are batched per
  round (one Playwright run for all still-failing specs).
- **Anti-cheat guard** (`agents/heal-guard.ts`, pure/testable) — statically rejects
  any fix that passes by WEAKENING the test (dropped/loosened assertions,
  `expect.soft` replacing hard, `test.skip`/`only`, trivially-true or match-all
  assertions, removed `.not.*` guards, `if(false)` dead branches, empty
  swallowing `catch`). Compared against the ORIGINAL spec.
- **Verify-before-persist** — a candidate is "healed" only after `verifySpecsByKey`
  (`services/playwright-runner.service.ts`) re-runs it in a throwaway workspace
  and it cleanly passes (a `flaky` pass is NOT trusted). Only verified, non-weakening
  fixes are written back; nothing else is ever persisted.
- **Convergence + quarantine** — repeated/exhausted fixes are quarantined for human
  review, never blanket-retried or silently passed. Bounded AI concurrency
  (`HEAL_CONCURRENCY`, default 4). Per-attempt telemetry for heal-rate/flake metrics.

### Key Patterns

- **Token format**: `intelliqe-demo-token-{timestamp}:{username}` (not JWT)
- **Real-time updates**: SSE from backend to frontend per pipeline run
- **Worker polling**: Workers poll every 5s, heartbeat every 30s
- **Credential storage**: Fields matching sensitive key names are XOR-encrypted at rest with `__ENC__` prefix
- **Database dates**: The `db.ts` shim converts `Date` values to ISO strings on read (not Date objects)
- **Frontend state**: sessionStorage for auth (`intelliqe_token`, `intelliqe_user`), localStorage for preferences
