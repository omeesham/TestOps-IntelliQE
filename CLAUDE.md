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

### Key Patterns

- **Token format**: `intelliqe-demo-token-{timestamp}:{username}` (not JWT)
- **Real-time updates**: SSE from backend to frontend per pipeline run
- **Worker polling**: Workers poll every 5s, heartbeat every 30s
- **Credential storage**: Fields matching sensitive key names are XOR-encrypted at rest with `__ENC__` prefix
- **Database dates**: The `db.ts` shim converts `Date` values to ISO strings on read (not Date objects)
- **Frontend state**: sessionStorage for auth (`intelliqe_token`, `intelliqe_user`), localStorage for preferences
