# JBS IntelliQE — Technical Specification

**Version:** 1.0
**Last updated:** 2026-05-12
**Audience:** Engineers, architects, deployment ops, AI assistants extending the platform.

> **Purpose.** This document is the single authoritative reference for the
> JBS IntelliQE codebase after the SaaS / HIPAA cleanup. It is written so
> a reader (or AI assistant) can answer ~90% of "what does this do / where
> does that live / how do I extend it" questions **without scanning the
> source tree**. When a section becomes stale, update it here first.

---

## Table of Contents

1.  [Executive Summary](#1-executive-summary)
2.  [System Architecture](#2-system-architecture)
3.  [AI Orchestration (JBS-Protected Intelligence)](#3-ai-orchestration-jbs-protected-intelligence)
4.  [Backend Reference](#4-backend-reference)
5.  [API Reference](#5-api-reference)
6.  [Database Schema](#6-database-schema)
7.  [Frontend Reference](#7-frontend-reference)
8.  [Security & HIPAA Compliance](#8-security--hipaa-compliance)
9.  [Deployment (Cloud-Agnostic)](#9-deployment-cloud-agnostic)
10. [Operational Runbook](#10-operational-runbook)
11. [Local Development](#11-local-development)
12. [Future Scope](#12-future-scope)
13. [Glossary](#13-glossary)

---

## 1. Executive Summary

### 1.1 What JBS IntelliQE is

JBS IntelliQE is a **multi-tenant SaaS platform** that uses a chain of Claude
agents to autonomously generate, execute, and self-heal browser-based test
automation. A user describes a feature in plain English in the chat wizard;
the platform produces:

- A structured set of test cases (positive / negative / edge / E2E)
- Playwright TypeScript spec files
- An execution report (Allure + custom summary) with screenshots and traces

Future scope: the same orchestration is being extended to **API automation**;
this is wired through the codebase as a first-class concept (see §12).

### 1.2 SaaS deployment model (per JBS HIPAA Enterprise Architecture)

> **Customer-Controlled Runtime + JBS-Protected Orchestration Intelligence.**

| Component                            | Customer owns                                   | JBS protects                                |
|--------------------------------------|-------------------------------------------------|---------------------------------------------|
| Runtime / hosting                    | App Service, ECS, Cloud Run, K8s, etc.          | —                                           |
| Database                             | PostgreSQL instance, schema, backups            | Schema definition                           |
| Test artifacts (screenshots, traces) | Their cloud storage (Azure Blob / S3 / GCS)     | —                                           |
| LLM credentials                      | Their own Claude API key (per-tenant)           | —                                           |
| Audit logs                           | Stored in customer's DB                         | Schema definition                           |
| Orchestration logic (agent prompts)  | —                                               | `.github/agents/*.md` (shippable as artifact via `AGENTS_DIR`) |
| Pipeline planner / convergence guards| —                                               | `backend/src/orchestrator/`                 |
| Self-healing algorithm               | —                                               | `playwright-test-healer.agent.md`           |

PHI / PII never leaves the customer's environment. The platform calls
Anthropic's API directly from the customer's worker process; intermediate
prompts are not stored centrally by JBS.

### 1.3 Core capabilities (kept)

- **Chat wizard** (`/chat`) — conversational flow from Jira/text →
  requirements → test cases → scripts → execution.
- **Generated Test Cases** (`/generated-tests`) — list, edit, export,
  delete test cases per run; trigger script generation.
- **Automation Scripts** (`/automation-scripts`) — view/edit Playwright
  spec files; trigger runs.
- **Reports** (`/reports`) — Allure reports + execution summaries.
- **Agent Monitor** (`/agents`, admin only) — queue and per-agent status.
- **User Management** (`/user-management`, admin only) — per-tenant users.
- **System Configuration** (`/system-configuration`, admin only) — integrations,
  storage providers, notifications, AI settings.

### 1.4 Removed (no longer in this codebase)

- KPI dashboards (`KpiDashboardPage`, `AnalyticsDashboardPage`)
- Data-validation CRUD (CSV validator, validation rules, Azure SQL
  multi-connection panel)
- Teams / Slack / PagerDuty notifications (email only retained)
- Databricks integration

### 1.5 Stack at a glance

| Layer        | Tech                                     |
|--------------|------------------------------------------|
| Frontend     | React 19, Vite 7, Tailwind 4, axios     |
| Backend API  | Node.js 20+, Express 5, TypeScript 5    |
| Worker       | Node.js 20+, `tsx`, Anthropic Messages API |
| Database     | PostgreSQL 14+ (schema `JBSTestOpsAI`)   |
| Storage      | Pluggable (Azure Blob / S3 / GCS / local)|
| Secrets      | Pluggable (env / Azure KV / AWS SM / GCP SM) |
| Auth         | JWT (HS256)                              |
| Crypto       | AES-256-GCM at rest, XOR+B64 in transit  |
| LLM          | Anthropic Claude (`haiku` / `sonnet` / `opus`) |

---

## 2. System Architecture

### 2.1 High-level component diagram

```
                             ┌────────────────────┐
                             │  Browser (React)   │
                             │  Vite SPA, JWT     │
                             └─────────┬──────────┘
                                       │  HTTPS, Bearer JWT
                                       ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  Backend API (Express, port 3001)                            │
   │                                                              │
   │   helmet → request-context → rate-limit → cors → JSON body  │
   │                                                              │
   │   /api/auth/*              ← public (JWT issuance)          │
   │   /api/*                   ← user JWT (internal admin/UI)   │
   │   /api/v1/public/*         ← user JWT + audit               │
   │   /api/pipeline-worker/*   ← x-worker-secret                │
   └────┬─────────────────┬────────────────────┬────────────────┘
        │                 │                    │
        │ SQL             │ SSE               │ x-worker-secret
        ▼                 ▼                    ▼
   ┌─────────┐      ┌─────────────┐    ┌──────────────────────┐
   │ Postgres│      │ EventSource │    │  Worker process(es)  │
   │ schema  │      │ (browser)   │    │  - polls /next-task   │
   │ JBS...  │      └─────────────┘    │  - calls Claude API   │
   └─────────┘                          │  - reports completion │
        ▲                               └──────────┬───────────┘
        │                                          │
        └──────── tenant-scoped credentials ───────┘
                                                   │
                                                   ▼
                                       ┌────────────────────┐
                                       │  Anthropic API     │
                                       │  Messages endpoint │
                                       └────────────────────┘

       Blob storage (artifacts)                 Secrets store
       ┌──────────────────────────┐    ┌───────────────────────────┐
       │  Azure Blob | S3 | GCS  │    │  Azure KV | AWS SM | GCP  │
       │  | local fs (dev only)  │    │  SM | env (dev fallback)  │
       └──────────────────────────┘    └───────────────────────────┘
```

### 2.2 Process model

The deployment unit is **two long-running Node.js processes** plus
**PostgreSQL** and a **blob store**:

1. **API server** — `node dist/index.js` (port 3001 by default).
   Stateless. Horizontally scalable. Behind a load balancer with sticky
   sessions for SSE streams (or use a sticky-friendly LB like Azure Front
   Door / AWS ALB).

2. **Worker** — `node dist/worker/index.js` (no listen port). Polls the
   API every `workerPollIntervalMs` (default 5s) for tasks, calls Claude,
   reports results. Scale by adding replicas — work is claimed via SQL
   `FOR UPDATE SKIP LOCKED`, so concurrent workers never collide.

3. **PostgreSQL** — the single source of truth. All state lives here.
   Schema is `"JBSTestOpsAI"` (search_path set on every connection).

4. **Blob storage** — artifacts (screenshots, traces, ZIPs of reports).
   Selected at boot via `STORAGE_PROVIDER` env var. Optional in dev.

### 2.3 Multi-tenancy

Every persistent record carries a `tenant_id` FK to `tenants(id)`.
Tenants come in two flavors:

- **Platform tenant** (`is_platform = true`) — `jbs`. Users in this
  tenant can view / impersonate other tenants for support purposes.
- **Customer tenants** — regular orgs. Users see only their own data.

Tenant isolation is enforced **at the query level** in every service:
all queries either include `WHERE tenant_id = $1` or join via a related
table that does.

Tenant-scoped data:
- `users`, `client_configurations`, `tenants.anthropic_api_key`
- `conversations`, `messages`, `jira_connections`
- `test_runs`, `test_cases`, `automation_scripts`
- `qa_pipeline_runs`, `qa_artifacts`, `qa_pages`, `qa_pipeline_definitions`
- `audit_log`

### 2.4 Request lifecycle (chat wizard → execution)

```
1. User opens /chat (Browser).
2. User types: "Write tests for the checkout flow on staging."
3. Frontend POST /api/chat/messages           (saves the user turn)
4. Frontend POST /api/generate                 (kicks off generation)
5. Backend orchestrator inserts a row into qa_pipeline_runs and
   one qa_worker_tasks row for the first stage ("requirements").
6. Worker polls /api/pipeline-worker/next-task (every 5s).
7. Worker receives the task + tenant's decrypted Anthropic API key.
8. Worker calls Anthropic Messages API with the requirements agent prompt.
9. Worker POST /api/pipeline-worker/complete-task with the JSON result.
10. Backend orchestrator inserts the next stage's task ("planning").
11. Steps 6–10 repeat for each stage: planning → generation →
    (optional script execution) → audit.
12. Frontend EventSource subscribed to /api/pipeline-events/:runId
    receives stage_start / agent_progress / stage_complete events
    and animates the chat UI accordingly.
13. On terminal stage, test cases are saved (test_runs + test_cases
    tables) and the user is offered review / export / script gen.
```

---

## 3. AI Orchestration (JBS-Protected Intelligence)

This section documents the part of the system the JBS HIPAA architecture
calls "JBS-protected orchestration intelligence." It is the heart of the
product.

### 3.1 Pipeline definition

`backend/config/pipeline-definition.json` declares every stage. Each
stage is a self-contained unit of work executed by one agent.

```json
{
  "defaults": {
    "model": "sonnet",
    "maxTurnsPerStage": 50,
    "budgetPerRunUsd": 2.00,
    "budgetPerStageUsd": 0.50,
    "workerPollIntervalMs": 5000,
    "workerHeartbeatIntervalMs": 30000,
    "agentRunner": "sdk"
  },
  "stages": [
    { "id": "requirements", "name": "Requirements", "agent": "requirements",
      "agentFile": ".github/agents/playwright-requirements.agent.md",
      "model": "haiku", "maxTurns": 30, "timeoutSeconds": 600,
      "budgetCap": 0.10, "retries": 1, "description": "Explore live UI..." },
    { "id": "planning",     "name": "Planning",     "agent": "planner",
      "agentFile": ".github/agents/playwright-test-planner.agent.md",
      "model": "sonnet", "maxTurns": 50, "timeoutSeconds": 900,
      "budgetCap": 0.50, "retries": 1, "description": "Create test plan..." },
    { "id": "generation",   "name": "Generation",   "agent": "generator",
      "agentFile": ".github/agents/playwright-test-generator.agent.md",
      "model": "sonnet", "maxTurns": 60, "timeoutSeconds": 1200,
      "budgetCap": 0.50, "retries": 1, "description": "Generate spec files..." },
    { "id": "healing",      "name": "Healing",      "agent": "healer",
      "agentFile": ".github/agents/playwright-test-healer.agent.md",
      "model": "sonnet", "maxTurns": 40, "timeoutSeconds": 900,
      "budgetCap": 0.50, "retries": 2, "description": "Self-heal failures..." },
    { "id": "audit",        "name": "Audit",        "agent": "auditor",
      "agentFile": ".github/agents/playwright-pipeline-audit.agent.md",
      "model": "haiku", "maxTurns": 30, "timeoutSeconds": 600,
      "budgetCap": 0.20, "retries": 1, "description": "Quality review..." }
  ]
}
```

A per-tenant override can be stored in `qa_pipeline_definitions.definition`
(JSONB). The orchestrator merges that over the base definition at
`loadPipelineDefinitionForClient(pool, tenantId)`.

### 3.2 The six agents

| Agent ID         | File                                             | Model  | Purpose                                                              |
|------------------|--------------------------------------------------|--------|----------------------------------------------------------------------|
| `requirements`   | `playwright-requirements.agent.md`               | haiku  | Explore the live UI via MCP browser tools, capture flow              |
| `planning`       | `playwright-test-planner.agent.md`               | sonnet | Produce test cases (positive/negative/edge/E2E) and a test plan      |
| `generation`     | `playwright-test-generator.agent.md`             | sonnet | Emit Playwright TypeScript spec files                                |
| `healing`        | `playwright-test-healer.agent.md`                | sonnet | Diagnose & fix a failed test (capped at 2 cycles)                    |
| `audit`          | `playwright-pipeline-audit.agent.md`             | haiku  | Quality review of artifacts                                          |
| `maintenance`    | `playwright-framework-maintainer.agent.md`       | sonnet | Repo hygiene (dead code, duplicate locators, missing exports)        |

Agent prompts live in `.github/agents/*.md` by default and are loaded by
`worker/index.ts → loadAgentFile()`. Override the directory via
`AGENTS_DIR` env var to ship the agents as a separate package (this is
how JBS protects orchestration IP — the customer environment runs the
binaries but does not necessarily own a copy of the prompts).

### 3.3 Orchestrator (`backend/src/orchestrator/`)

| File                    | Responsibility                                                      |
|-------------------------|---------------------------------------------------------------------|
| `orchestrator.ts`       | Stage dispatch, SSE emission, convergence guards, mode switching    |
| `types.ts`              | `StageDefinition`, `PipelineDefinition`, `PipelineRun`, `SSEEvent`  |
| `dependency-engine.ts`  | Page readiness, cascade plan (`requirements` → all children pages)  |
| `gate-runner.ts`        | Approval-required gates (pause for human review)                    |
| `failure-classifier.ts` | Categorize stage failures (timeout / budget / parse / API rate)     |
| `artifact-validator.ts` | Validate artifact JSON shape against stage's expected schema        |

**Convergence guards** (orchestrator.ts):

- **Budget cap** — `budgetPerRunUsd` total across stages; `budgetPerStageUsd`
  per single stage. Exceeding caps cancels the run with status `over_budget`.
- **Max retries** — per-stage `retries` value from pipeline-definition.
  Default is 1 (no retry).
- **Same-findings detection** — healing stage compares the new "fix proposal"
  against the previous one; if identical, healing aborts to avoid loops.
- **Max turns per stage** — `maxTurnsPerStage` caps the number of agent
  back-and-forth turns. Hard timeout from `timeoutSeconds`.

### 3.4 Worker (`backend/src/worker/`)

| File              | Responsibility                                                      |
|-------------------|---------------------------------------------------------------------|
| `index.ts`        | Polling loop, agent-file load, task execute, complete reporting     |
| `sdk-executor.ts` | Wraps Anthropic Messages API (`POST /v1/messages`) with timeout    |

Key behaviors:

- **Per-tenant API keys.** Each `/next-task` response carries `tenantApiKey`
  (the decrypted Anthropic key from `tenants.anthropic_api_key`). Worker
  uses that; falls back to `ANTHROPIC_API_KEY` env var if null.
- **`AGENTS_DIR`** — env var pointing at the agent prompt directory.
  Defaults to repo-root `.github/agents`. Worker re-roots paths like
  `.github/agents/foo.md` to `<AGENTS_DIR>/foo.md`.
- **Backoff & retry.** `completeTask` retries up to 3 times on network
  failure. After 3 failures, a CRITICAL log is emitted (task remains
  claimed but un-completed; a separate sweeper reclaims after timeout).

### 3.5 Stage-task lifecycle in DB

```
qa_pipeline_runs       row created  (status='queued')
       │
       ├─ qa_stage_results  row created for stage 1 (status='running')
       │      │
       │      └─ qa_worker_tasks row created (status='pending')
       │             │
       │             ↓ worker claims  (status='claimed', claimed_at=...)
       │             ↓ worker reports (status='completed', result=...)
       │
       ├─ qa_stage_results  updated  (status='success' or 'fail')
       │
       └─ if success → next stage row created → loop
          if fail   → if retries left → re-queue; else mark run failed
```

### 3.6 Healing loop

When a `generation` or `execution` stage produces failing spec runs, the
orchestrator queues a `healing` task that receives:
- The failing test case + spec source
- Console output + Playwright trace (excerpted)
- Previous healing attempts (for same-findings detection)

The healer agent emits a JSON patch + reasoning. The orchestrator applies
the patch by writing a new artifact version (`qa_artifacts.replaced_by`
points to the new row). Up to **2 healing cycles** by default; after that
the run is marked `needs_human_review`.

### 3.7 Server-Sent Events (SSE)

The frontend subscribes via `EventSource` to
`/api/pipeline-events/:runId`. Events broadcast from the orchestrator:

| Type                | When                              | Payload keys                                       |
|---------------------|-----------------------------------|----------------------------------------------------|
| `stage_start`       | A stage's worker task enqueued    | `runId, stage, agent, model, attempt, timestamp`   |
| `agent_progress`    | Worker `/progress` heartbeat      | `runId, stage, message, timestamp`                 |
| `stage_complete`    | Stage finished                    | `runId, stage, status, durationMs, costUsd`        |
| `run_complete`      | Final stage done                  | `runId, status, totalCostUsd`                      |
| `run_failed`        | Convergence guard or hard error   | `runId, reason, stage`                             |
| `worker_status`     | Heartbeat                         | `connected, timestamp` (sent on `__global__`)      |

Each event also carries `requestId` if available (propagated from the
original API request that triggered the run).

---

## 4. Backend Reference

### 4.1 Directory layout

```
backend/
├── config/
│   └── pipeline-definition.json     ← base stages, models, budgets
├── src/
│   ├── index.ts                     ← Express bootstrap, route mounts
│   ├── db.ts                        ← pg pool + idempotent initDb()
│   ├── agents/                      ← AI orchestration (JBS IP)
│   │   ├── pipeline.ts              ← old pipeline (kept for /api/generate)
│   │   ├── claude-runner.ts         ← Claude CLI runner (fallback)
│   │   ├── requirementAgent.ts
│   │   ├── plannerAgent.ts
│   │   ├── generatorAgent.ts
│   │   ├── scriptAgent.ts
│   │   ├── executionAgent.ts
│   │   ├── healingAgent.ts
│   │   ├── auditAgent.ts
│   │   └── state.ts
│   ├── orchestrator/                ← Modern pipeline orchestration
│   ├── worker/
│   │   ├── index.ts                 ← Worker entry point
│   │   └── sdk-executor.ts          ← Anthropic Messages API client
│   ├── routes/
│   │   ├── agents.routes.ts         ← /api/agents
│   │   ├── allure.routes.ts         ← /api/allure
│   │   ├── artifacts.routes.ts      ← /api/artifacts
│   │   ├── automation-scripts.routes.ts
│   │   ├── chat.routes.ts           ← /api/chat
│   │   ├── configurations.routes.ts ← /api/configurations
│   │   ├── execute.routes.ts        ← /api/execute
│   │   ├── generate.routes.ts       ← /api/generate
│   │   ├── jira.routes.ts           ← /api/jira
│   │   ├── pipeline.routes.ts       ← /api/pipeline
│   │   ├── pipeline-admin.routes.ts ← /api/pipeline-admin
│   │   ├── pipeline-events.routes.ts ← /api/pipeline-events (SSE)
│   │   ├── pipeline-pages.routes.ts ← /api/pipeline-pages
│   │   ├── pipeline-worker.routes.ts ← /api/pipeline-worker
│   │   ├── reports.routes.ts        ← /api/reports
│   │   ├── tenant-settings.routes.ts ← /api/tenant-settings
│   │   ├── test-cases.routes.ts     ← /api/test-cases
│   │   ├── user-management.routes.ts ← /api/users
│   │   └── public/
│   │       └── public-api.routes.ts ← /api/v1/public/*
│   ├── services/
│   │   ├── allure-report.service.ts
│   │   ├── artifact-report.service.ts
│   │   ├── chat.service.ts
│   │   ├── configurations.service.ts
│   │   ├── email.service.ts
│   │   ├── jira.service.ts
│   │   ├── notification-dispatcher.service.ts
│   │   ├── pipeline-queries.ts
│   │   ├── playwright-runner.service.ts
│   │   ├── sse-manager.ts
│   │   └── storage/
│   │       ├── index.ts             ← IBlobStorage + factory
│   │       ├── local.provider.ts
│   │       ├── azure-blob.provider.ts
│   │       ├── s3.provider.ts
│   │       └── gcs.provider.ts
│   ├── middleware/
│   │   ├── auth.middleware.ts       ← JWT + legacy token
│   │   ├── audit.middleware.ts      ← logs every public-API call
│   │   ├── request-context.middleware.ts ← stamps requestId
│   │   └── worker-auth.middleware.ts ← x-worker-secret
│   ├── utils/
│   │   ├── audit.ts                 ← logAudit() / logSystemAudit()
│   │   ├── crypto.ts                ← AES-256-GCM at rest + XOR transit
│   │   ├── jwt.ts                   ← signToken / verifyToken (HS256)
│   │   ├── logger.ts                ← structured JSON logger w/ PII mask
│   │   └── secrets.ts               ← getSecret() multi-cloud
│   └── models/
│       └── schemas.ts               ← zod schemas (Test config)
└── package.json
```

### 4.2 Service catalog

| Service                         | Owns                                                            |
|---------------------------------|-----------------------------------------------------------------|
| `chat.service`                  | Conversations & messages CRUD                                   |
| `configurations.service`        | client_configurations CRUD with category derivation             |
| `email.service`                 | SMTP send (tenant-scoped or env-var fallback)                   |
| `notification-dispatcher.service` | Routes test-run events to enabled channels (email only today) |
| `pipeline-queries`              | Low-level SQL on qa_* tables                                    |
| `playwright-runner.service`     | Subprocess launch of `npx playwright test`                      |
| `artifact-report.service`       | Summarize execution → ExecutionSummary JSON                     |
| `allure-report.service`         | Invoke `allure generate`, persist HTML                          |
| `jira.service`                  | Connect, fetch stories, fetch story details                     |
| `sse-manager`                   | Per-run Set<Response>, broadcast util                           |
| `storage/*`                     | Pluggable blob storage backends                                 |

### 4.3 Middleware

#### `requestContext`
Stamps every request with `req.requestId` (UUID, reused from
`X-Request-Id` header if present) and `req.startTime` (Date.now()).
Adds `X-Request-Id` to the response so callers can correlate logs.

#### `authMiddleware`
- Reads `Authorization: Bearer <jwt>` and verifies HS256 signature
  against `JWT_SECRET`.
- On success, populates `req.user` with `{username, userId, role,
  tenantId, tenantName, isPlatform, displayName}`.
- For one release cycle, still accepts legacy `intelliqe-demo-token-…`
  via DB lookup. Disable with `LEGACY_TOKEN_AUTH=false`.

#### `workerAuthMiddleware`
- Reads `x-worker-secret` header and compares to `WORKER_SECRET` env var.
- 401 on mismatch. No DB call.

#### `auditMutations`
- Mounted on `/api/v1/public`.
- On every mutating request (POST/PUT/PATCH/DELETE), writes a row to
  `audit_log` with: `tenant_id, user, request_id, action, resource_type,
  resource_id, status, durationMs, ip`.
- Set `AUDIT_INCLUDE_READS=true` to log GETs too (HIPAA-strict mode).

### 4.4 Utilities

#### `crypto.ts` — two layers

| Function                                  | Purpose                                                       |
|-------------------------------------------|---------------------------------------------------------------|
| `encryptField(v)` / `decryptField(v)`     | XOR+Base64 **transit** crypto, frontend-compatible. Prefix `__ENC__`. |
| `encryptAtRest(v)` / `decryptAtRest(v)`   | AES-256-GCM **at-rest** crypto. Prefix `__AES__`. Throws on tamper. |
| `decryptStored(v)`                        | Auto-detects `__ENC__` (legacy) vs `__AES__` and unwraps.     |
| `encryptConfigData(o)` / `decryptConfigData(o)` | Operate on whole config_data JSON objects.              |
| `maskConfigData(o)` / `maskSecret(s)`     | Replace sensitive values with `xxx•••yy`.                     |
| `sanitizeChatContent(s)`                  | Redact bearer tokens, SAS, GH PATs, AWS keys from chat text.  |

#### `jwt.ts`

```ts
signToken(payload: { sub, uid, role, tid, tn, pf }): string  // HS256, 24h
verifyToken(token): payload | throws
```

Reads `JWT_SECRET` env var. In dev, falls back to a deterministic value
with a warning. **Required in production.** Token TTL via `JWT_EXPIRES_IN`.

#### `secrets.ts`

```ts
getSecret(name, fallback?): Promise<string | undefined>
clearSecretCache(name?): void
```

Backend chosen by `SECRETS_PROVIDER` env var:
- `env` (default) — reads `process.env[name]`
- `azure-kv` — `DefaultAzureCredential` + `AZURE_KEY_VAULT_URL`
- `aws-sm` — standard AWS chain + `AWS_REGION`
- `gcp-sm` — Application Default Credentials + `GCP_PROJECT_ID`

#### `logger.ts`

Structured JSON logger. Every log line is one NDJSON record with `ts,
level, msg, …meta`. **PII / credentials masking is built in**: emails,
SSNs, card-shaped numbers, Bearer/Basic auth headers, and any key in
`MASKED_KEYS` (password, token, api_key, anthropic_api_key, etc.) are
replaced with `[REDACTED]` before writing.

#### `audit.ts`

```ts
logAudit(req, action, resourceType, resourceId?, details?): Promise<void>
logSystemAudit(tenantId, action, resourceType, resourceId?, details?): Promise<void>
```

Failures are swallowed — audit never breaks the main request flow.

---

## 5. API Reference

### 5.1 Auth

#### `POST /api/auth/login`
Public. Rate-limited (5 req/min per IP).

**Request:**
```json
{ "username": "jbsadmin", "password": "__ENC__<base64-xor>" }
```
(password is XOR-transit-encrypted by the frontend's
`encryptField` so it doesn't appear plaintext in DevTools.)

**Response:**
```json
{
  "success": true,
  "user": {
    "username": "jbsadmin",
    "role": "admin",
    "displayName": "JBS Admin",
    "tenantId": "uuid",
    "tenantName": "Jade Business Solutions",
    "isPlatform": true
  },
  "token": "<JWT, HS256, 24h>"
}
```

#### `POST /api/auth/signup`
Public. Rate-limited. Creates a user; optionally creates a new tenant.

```json
{
  "username": "newuser",
  "password": "__ENC__...",
  "fullName": "New User",
  "email": "new@example.com",
  "role": "qa_engineer",
  "tenantName": "Acme Corp"
}
```

### 5.2 Public business-capability API (HIPAA boundary)

Mount: `/api/v1/public`
Auth: user JWT
Middleware applied: `authMiddleware` + `auditMutations` (every mutation is
written to `audit_log` automatically).

All endpoints return:
```json
{
  "runId": "uuid",
  "status": "queued",
  "pollUrl": "/api/pipeline/<runId>",
  "eventsUrl": "/api/pipeline-events/<runId>",
  "requestId": "uuid"
}
```
HTTP 202 (Accepted) on success.

#### `POST /api/v1/public/requirements/analyze`
Start a run from scratch — requirements stage first.

```json
{ "feature": "...", "module": "...", "intent": "...", "targetUrl": "https://..." }
```

#### `POST /api/v1/public/tests/plan`
Start at the planner stage. Body adds `requirements: string[]`.

#### `POST /api/v1/public/scripts/generate`
Start at the generation stage. Body adds `testCases: object[]`.

#### `POST /api/v1/public/scripts/heal`
Start at the healing stage. Body:
```json
{
  "runId": "uuid?",
  "feature": "...",
  "module": "...",
  "failureContext": "stack trace / error output"
}
```

#### `POST /api/v1/public/results/evaluate`
Re-run the audit stage on an existing run.
```json
{ "runId": "uuid" }
```

### 5.3 Internal API (user JWT)

Endpoints are documented by route file. Conventions:
- All return JSON.
- All mutating endpoints decrypt `__ENC__` transit fields server-side.
- Sensitive fields in responses are masked (`maskConfigData`).

#### `GET /api/health`
Public. Liveness probe — `{ status: 'ok', timestamp, version }`.

#### Chat (`/api/chat`)
- `POST /conversations` — `{ username, title? }` → `{ id }`
- `POST /messages` — `{ conversationId, role, content, metadata? }`

#### Test cases (`/api/test-cases`)
- `POST /save` — Save a generated batch
- `GET /` — List runs (paginated, filterable)
- `GET /:runId` — Get a run + its cases
- `GET /facets` — `{ modules[], submodules[], tags[] }`
- `PUT /:runId/cases/:caseId` — Update one case
- `POST /:runId/cases` — Add a case
- `DELETE /:runId/cases/:caseId` — Delete a case
- `DELETE /:runId` — Delete the whole run
- `GET /:runId/export?format=...` — Export (csv/xlsx/json)
- `GET /:runId/test-data` — Get test data for a run
- `POST /:runId/test-data` — Save test data

#### Automation scripts (`/api/automation-scripts`)
- `GET /` — List (paginated)
- `GET /:id` — Get one
- `PUT /:id` — Update (code / file_name / status)
- `DELETE /:id` — Delete
- `POST /generate/:testRunId` — Generate scripts for all cases in a run
- `GET /by-run/:testRunId` — List scripts for a run

#### Reports (`/api/reports`)
- `GET /summary` — Cross-run summary
- `POST /allure/generate` (via `/api/allure`) — Build Allure HTML
- `GET /allure/status` — Build status

#### Artifacts (`/api/artifacts`)
- `GET /:runId/report` — Execution summary JSON
- `GET /:runId/download` — ZIP of all artifacts (binary)

#### Pipeline (`/api/pipeline`)
- `POST /run` — Create a pipeline run
- `GET /list?status=…` — List runs
- `GET /:id` — One run
- `POST /:id/cancel`
- `POST /:id/approve`
- `POST /:id/reject`
- `POST /:id/steer` — Inject a steering message
- `PATCH /:id/mode` — Switch execution mode

#### Pipeline events (`/api/pipeline-events`)
- `GET /:runId` — **SSE stream** (auth via `?token=` query param)
  Returns `text/event-stream`. See §3.7 for event payloads.

#### Pipeline pages (`/api/pipeline-pages`)
- `GET /` — List pages
- `POST /` — Create a page
- `GET /:id` — One page

#### Pipeline admin (`/api/pipeline-admin`)
- `GET /agent-types` — DB-backed agent type catalog
- `GET /pipeline-definition` — Effective definition for caller's tenant
- `GET /worker-status` — Live worker heartbeat
- `GET /usage` — Per-stage cost rollup

#### Configurations (`/api/configurations`)
- `GET /` — All integrations for tenant (sensitive fields masked)
- `GET /?category=…` — Filter
- `PUT /:integrationId` — Connect / update (sensitive fields are
  decrypted from transit, re-encrypted with AES-256-GCM for at-rest)
- `DELETE /:integrationId` — Disconnect
- `POST /:integrationId/test` — Smoke-test (e.g. send a test email)

#### Tenant settings (`/api/tenant-settings`)
- `GET /anthropic-key` → `{ configured: bool, masked?: string }`
- `PUT /anthropic-key` — `{ apiKey: "__ENC__..." }` (transit-encrypted).
  Backend validates `sk-…` shape, then encrypts at rest with AES-GCM
  and stores in `tenants.anthropic_api_key`.
- `DELETE /anthropic-key`

#### Users (`/api/users`)
Admin-only inside the tenant (platform admins can see/manage all).
- `GET /` — List users in tenant
- `GET /tenants` — List all tenants (platform only)
- `POST /` — Create user
- `PUT /:id` — Update user
- `DELETE /:id` — Delete user
- `PUT /:id/status` — Activate/deactivate
- `GET /menu-config` — Per-tenant allowed sidebar paths

#### Jira (`/api/jira`)
- `POST /connect` — Connect
- `GET /status` — Connection status
- `GET /stories` — List stories
- `GET /story/:issueKey` — Story details
- `DELETE /disconnect`

#### Generate / Execute (`/api/generate`, `/api/execute`)
Legacy synchronous test-generation endpoints used by the chat wizard
(pre-orchestrator). They call the agents in `backend/src/agents/pipeline.ts`
directly. Both return JSON synchronously (no polling). For new clients,
prefer the public `/api/v1/public/*` async surface.

### 5.4 Worker API (worker secret)

Mount: `/api/pipeline-worker`. Auth: `x-worker-secret` header.

- `GET /next-task` — Pull next pending task; response includes the
  tenant's decrypted Anthropic API key.
- `POST /complete-task` — `{ taskId, success, result, artifacts, cost }`
- `POST /progress` — `{ runId, stage, message }` → SSE relay
- `POST /heartbeat` — `{ workerId, currentTaskId? }`

### 5.5 Errors

All error responses share:
```json
{ "error": "machine_code or human message", "requestId": "uuid" }
```

In production, internal errors are flattened to
`{ error: "Internal server error" }` — stack traces never leak.

---

## 6. Database Schema

PostgreSQL 14+. Schema name **`"JBSTestOpsAI"`** (quoted; case-sensitive).
The pool sets `search_path` at connection time so unqualified names resolve.

`initDb()` (in `db.ts`) creates everything idempotently with
`CREATE TABLE IF NOT EXISTS`.

### 6.1 Identity & tenancy

#### `tenants`
| Column              | Type            | Notes                                   |
|---------------------|-----------------|-----------------------------------------|
| id                  | UUID PK         | `gen_random_uuid()`                     |
| name                | VARCHAR(200)    |                                         |
| slug                | VARCHAR(100)    | UNIQUE                                  |
| is_platform         | BOOLEAN         | `true` for JBS itself                   |
| **anthropic_api_key** | TEXT          | **AES-256-GCM ciphertext**, decrypted by worker |
| created_at / updated_at | TIMESTAMPTZ |                                         |

#### `users`
| Column        | Type         | Notes                                       |
|---------------|--------------|---------------------------------------------|
| id            | UUID PK      |                                             |
| tenant_id     | UUID FK      | → tenants(id)                               |
| username      | VARCHAR(100) | UNIQUE                                      |
| password_hash | VARCHAR(500) | bcrypt (`$2[aby]$…`)                        |
| email         | VARCHAR(300) |                                             |
| full_name     | VARCHAR(200) |                                             |
| role          | VARCHAR(50)  | CHECK in (`admin`, `qa_engineer`, `data_analyst`) |
| is_active     | BOOLEAN      | default true                                |

### 6.2 Tenant configuration & integrations

#### `client_configurations`
Stores per-tenant integration configs (Jira, GitHub, SMTP, S3, etc.).
Unique on `(tenant_id, integration_id)`.
- `category` is one of: `requirement-source` | `data-source` | `git-repo` |
  `notification` | `settings` | `application` | `integration`.
- `config_data` (JSONB) has sensitive fields stored as
  `__AES__<base64>` (legacy `__ENC__` entries auto-upgrade on first read).

### 6.3 Audit

#### `audit_log`
| Column         | Type        | Notes                                     |
|----------------|-------------|-------------------------------------------|
| id             | UUID PK     |                                           |
| tenant_id      | UUID FK     | → tenants                                 |
| user_id        | UUID        | optional                                  |
| username       | VARCHAR(100)| 'system' for worker-initiated entries     |
| **request_id** | UUID        | propagated from API middleware            |
| action         | VARCHAR(50) | create / update / delete / execute / approve / reject / login / logout / deploy / rotate_key |
| resource_type  | VARCHAR(50) | freeform (e.g. `tenant.anthropic_api_key`)|
| resource_id    | VARCHAR(200)|                                           |
| details        | JSONB       | path, method, status, durationMs          |
| ip_address     | VARCHAR(50) |                                           |
| created_at     | TIMESTAMPTZ |                                           |

Indexes: `(tenant_id, created_at DESC)`, `(request_id)`.

### 6.4 Chat

- **`conversations`** — `id, tenant_id, username, title, created_at, updated_at`
- **`messages`** — `id, conversation_id (FK→conversations CASCADE), role
  (user|assistant|system), content, metadata JSONB, created_at`

### 6.5 Jira

- **`jira_connections`** — `id, tenant_id, username UNIQUE, jira_url,
  auth_header (encrypted), display_name, created_at`. Also mirrored into
  `client_configurations` for unified UI.

### 6.6 Test runs & cases (chat wizard output)

- **`test_runs`** — `id, tenant_id, username, story_key, story_title,
  source, columns JSONB, module, submodule, created_at`
- **`test_cases`** — `id, test_run_id (CASCADE), tc_number, title, steps
  JSONB, expected, priority, type, feature, precondition, status,
  sort_order, module, submodule, tags TEXT[], created_at`

### 6.7 Automation scripts

- **`automation_scripts`** — UNIQUE `(test_run_id, test_case_id)`. Fields:
  `tenant_id, tc_number, file_name, language, framework, code, status,
  last_run_at, last_run_result, version, created_by`.

### 6.8 QA pipeline (orchestrator)

- **`qa_pipeline_runs`** — `id, tenant_id, feature, module, intent,
  target_url, stage, status, priority, cost NUMERIC, page_id,
  cascade_plan JSONB, batch_id, execution_mode_live`
- **`qa_stage_results`** — `id, run_id (CASCADE), stage_id, status,
  attempt, max_attempts, agent_model, cost, result_data JSONB,
  started_at, completed_at`
- **`qa_artifacts`** — `id, run_id (CASCADE), name, type, content TEXT,
  metadata JSONB, page_id, version, replaced_by, edited_by`
- **`qa_worker_tasks`** — `id, run_id (CASCADE), tenant_id, stage_id,
  status, agent_prompt, context JSONB, result JSONB, claimed_at,
  completed_at`. Claimed via SQL `FOR UPDATE SKIP LOCKED`.
- **`qa_agent_types`** — Catalog: `id, name, description, icon, category,
  default_model, agent_file, capabilities TEXT[]`. Seeded with the 5 core
  agents at boot.
- **`qa_pipeline_definitions`** — `id, tenant_id (UNIQUE NULLS NOT
  DISTINCT), definition JSONB, version, created_by, updated_at`. Per-tenant
  overrides of `pipeline-definition.json`.
- **`qa_pages`** — `id, tenant_id, module, page_slug, display_name,
  target_url, parent_page_id, depth, sort_order, metadata JSONB`.
  UNIQUE `(tenant_id, module, page_slug)`.
- **`qa_page_stage_status`** — `(page_id, stage_id)` UNIQUE. Tracks
  per-page progress for cascade plans.
- **`qa_client_setup`** — One-time per tenant: `home_url, auth_config,
  setup_config, setup_run_id, initiated_by`.

### 6.9 Test data (data-aware tests)

- **`test_datasets`** — `id, test_run_id (CASCADE), dataset_id, role,
  scenario, fields JSONB, layer (ui|api|both), source (static|database|mixed),
  source_config JSONB`
- **`test_field_data`** — `id, test_run_id, field_data_id, field_name,
  value, type (valid|invalid), data_type, validation_rule, source,
  source_detail`
- **`test_data_mapping`** — `id, test_run_id, test_case_id, dataset_id`

---

## 7. Frontend Reference

### 7.1 Directory layout

```
frontend/src/
├── App.tsx                ← Router + AuthProvider
├── main.tsx               ← Vite entry
├── components/
│   ├── layout/
│   │   ├── Layout.tsx     ← Sidebar + Header + <Outlet/> + persistent ChatPage
│   │   ├── Sidebar.tsx    ← Role + menu-config gated nav
│   │   └── Header.tsx
│   ├── system-config/     ← System Configuration tabs
│   │   ├── ConfigTabNav.tsx
│   │   ├── GeneralSettingsSection.tsx
│   │   ├── ApplicationSetupSection.tsx
│   │   ├── RequirementSourcesSection.tsx
│   │   ├── DataSourcesSection.tsx        ← storage providers
│   │   ├── GitRepositoriesSection.tsx
│   │   ├── NotificationsSection.tsx
│   │   ├── AISelfHealingSection.tsx
│   │   ├── VoiceAssistantSection.tsx
│   │   ├── IntegrationCard.tsx
│   │   ├── ConnectModal.tsx
│   │   └── integrationCatalog.ts
│   └── test-data/
│       ├── TestDataTab.tsx
│       └── ReportsTab.tsx
├── contexts/
│   └── AuthContext.tsx    ← user + isAuthenticated + login/logout
├── data/
│   └── mockData.ts        ← Sample queue for AgentMonitorPage
├── pages/
│   ├── LandingPage.tsx           ← /
│   ├── LoginPage.tsx             ← /login
│   ├── ChatPage.tsx              ← /chat (persistent)
│   ├── DashboardPage.tsx         ← /dashboard
│   ├── GeneratedTestCasesPage.tsx ← /generated-tests
│   ├── AutomationScriptsPage.tsx ← /automation-scripts
│   ├── ReportsPage.tsx           ← /reports
│   ├── AgentMonitorPage.tsx      ← /agents (admin)
│   ├── UserManagementPage.tsx    ← /user-management (admin)
│   └── SystemConfigurationPage.tsx ← /system-configuration (admin)
├── services/
│   └── api.ts             ← axios client + every API function
├── types/
│   └── index.ts           ← Shared cross-page types (AgentInfo, RunReport, ...)
└── utils/
    ├── crypto.ts          ← XOR transit encryption (mirrors backend)
    └── tts.ts             ← Tessa voice assistant
```

### 7.2 Routing

| Path                         | Component                  | Roles                |
|------------------------------|----------------------------|----------------------|
| `/`                          | LandingPage                | public               |
| `/login`                     | LoginPage                  | public               |
| `/chat`                      | (rendered in Layout)       | all                  |
| `/dashboard`                 | DashboardPage              | all                  |
| `/generated-tests`           | GeneratedTestCasesPage     | all                  |
| `/automation-scripts`        | AutomationScriptsPage      | all                  |
| `/reports`                   | ReportsPage                | all                  |
| `/agents`                    | AgentMonitorPage           | admin                |
| `/user-management`           | UserManagementPage         | admin                |
| `/system-configuration`      | SystemConfigurationPage    | admin                |
| `/configurations`, `/settings` | → /system-configuration (redirect) |              |
| `*`                          | → / (Navigate replace)     |                      |

`/chat` is **persistently mounted** in `Layout.tsx` so a running pipeline
isn't blown away when the user navigates elsewhere.

### 7.3 Auth flow

1. User submits login form → `loginUser(username, password)` in `api.ts`.
2. Password is XOR-encrypted (`encryptField`) before hitting the wire.
3. Backend issues JWT (HS256, 24h). Frontend stores it in
   `sessionStorage['intelliqe_token']`.
4. Every subsequent request: axios interceptor adds
   `Authorization: Bearer <jwt>`.
5. `AuthContext` exposes `{user, isAuthenticated, login, logout}` so
   pages can react.
6. Logout clears sessionStorage and forces redirect to `/login`.

### 7.4 Sidebar menu visibility

Two layers gate menu items:

1. **Role check** — each `navItems[].roles` lists which user roles see
   the item. `admin` sees admin-only items; `qa_engineer` doesn't.
2. **Per-tenant `menu-config`** — admins can store `allowedPaths` (array
   of paths) in `client_configurations` under `integration_id =
   'menu-config'`. If set, only listed paths are shown — useful for
   selling a stripped-down package to one customer.

### 7.5 API client

`services/api.ts` exports one async function per backend route. Naming:

- `loginUser`, `signupUser`
- `generateTests`, `executeTests`
- `saveTestCases`, `listTestRuns`, `getTestRun`, `updateTestCase`, …
- `listAutomationScripts`, `generateScriptsForRun`, …
- `getReportsSummary`, `generateAllureReport`, `getAllureReportStatus`
- `createChatConversation`, `saveChatMessage`
- `connectJira`, `getJiraStories`, `getJiraStoryDetails`, `disconnectJira`
- `getConfigurations`, `connectIntegration`, `disconnectIntegration`,
  `testNotificationIntegration`
- `getAgentStatus`, `createPipelineRun`, `listPipelineRuns`,
  `getPipelineRun`, `cancelPipelineRun`, `approvePipelineStage`,
  `rejectPipelineStage`, `steerPipeline`, `switchPipelineMode`
- `subscribeToPipelineEvents(runId, onEvent): EventSource`
- `getMenuConfig`, `listTenantUsers`, `listTenants`, `createTenantUser`,
  `updateTenantUser`, `deleteTenantUser`, `setTenantUserStatus`

Sensitive fields (passwords, API tokens, SAS, etc.) are
`encryptField`-wrapped before transmission.

### 7.6 Frontend transit crypto

`frontend/src/utils/crypto.ts`:
- `encryptField(s)` — XOR with `'iQE-s3cure-tr@nsit-2024!'`, Base64,
  prefix `__ENC__`.
- `encryptSensitiveFields(obj)` — applies `encryptField` to any value
  whose key is in `SENSITIVE_KEYS`.

Backend's `decryptField` and `decryptBody` undo this exactly.
The point is **defense in depth**, not real security — HTTPS is what
actually protects the wire.

---

## 8. Security & HIPAA Compliance

### 8.1 Identity & access

- **Authentication**: JWT (HS256). Secret from `JWT_SECRET` env var, ≥32
  chars. Tokens carry minimum claims: `sub` (username), `uid` (user UUID),
  `role`, `tid` (tenant), `tn` (tenant name), `pf` (is_platform).
  Default TTL 24h (`JWT_EXPIRES_IN`).
- **Authorization**: Role-based (`admin`, `qa_engineer`, `data_analyst`)
  plus tenant scope (queries filter by `tenant_id`). Admin-only routes
  check `req.user.role === 'admin'`. Platform admins (`tenants.is_platform
  = true`) can pass `?tenantId=…` to view other tenants' configs.
- **Tenant isolation enforcement points**:
  - Every route handler reads `req.user.tenantId` and filters queries.
  - `qa_worker_tasks.tenant_id` so workers can be tenant-pinned (optional
    `?tenant_id=` filter on `/next-task`).
  - SSE subscriptions keyed by `runId`, which has `tenant_id` so a user
    cannot subscribe to another tenant's runs (verified in route).

### 8.2 Credential encryption

| Data                         | At rest          | In transit (frontend → backend)        |
|------------------------------|------------------|----------------------------------------|
| User passwords               | bcrypt (cost 10) | XOR+B64 (`__ENC__`) over HTTPS         |
| Integration secrets          | AES-256-GCM (`__AES__`) | XOR+B64 (`__ENC__`) over HTTPS |
| Tenant's Anthropic API key   | AES-256-GCM      | XOR+B64 over HTTPS                     |
| Worker → API task results    | n/a              | Cleartext over TLS, `x-worker-secret` |
| Worker ← API tenant key      | n/a              | Cleartext over TLS, `x-worker-secret` |

**`ENCRYPTION_KEY` is required in production** (32 random bytes, Base64-
encoded). Provision via your cloud secret manager and inject as an env
var; do not commit to git.

### 8.3 Audit logging

Every state-changing request to `/api/v1/public/*` is auto-logged by
`auditMutations` middleware. Each entry includes:

- `tenant_id`, `user_id`, `username`
- `request_id` (propagated end-to-end via `X-Request-Id` header)
- HTTP method, path, status, durationMs
- `action` (create/update/delete/execute)
- `resource_type`, `resource_id`
- Client IP (`req.ip`, behind `trust proxy`)

Set `AUDIT_INCLUDE_READS=true` to log GETs too (HIPAA-strict).

For non-public endpoints, handlers call `logAudit(req, action, …)`
explicitly. Audit writes never block — failures swallowed with stderr log.

### 8.4 PII / PHI masking

The structured logger (`utils/logger.ts`) masks before writing:
- Email addresses → `***@***.tld`
- SSN-shaped strings → `***-**-****`
- Card-number-shaped strings → `**** **** **** 1234`
- `Bearer …` / `Basic …` header values → `[REDACTED]`
- `__ENC__…` / `__AES__…` ciphertext → `[REDACTED]`
- Any object key in `MASKED_KEYS` (password, token, secret, cookie,
  authorization, anthropic_api_key, ssn, dob, cvv) → `[REDACTED]`

Chat messages get an extra layer via `sanitizeChatContent()` before
persistence.

### 8.5 Transport security

- **HTTPS required.** In Azure App Service / AWS App Runner / Cloud Run,
  TLS is terminated at the platform.
- **`trust proxy = 1`** so `req.ip` returns the real client IP.
- **`helmet`** middleware sets HSTS, X-Content-Type-Options,
  X-Frame-Options, etc. CSP is enabled in production.
- **CORS** is locked down via `ALLOWED_ORIGINS` (comma-separated). `*`
  is the default in dev; never use it in production.

### 8.6 Rate limits

- **General**: 100 req/min per IP on `/api/*` (`RATE_LIMIT_GENERAL`)
- **Auth**: 5 req/min per IP on `/api/auth/login` + `/api/auth/signup`
  (`RATE_LIMIT_AUTH`)

Limits are per-process — for multi-instance deployments, share a Redis
backend via `express-rate-limit`'s store options if abuse is observed.

### 8.7 Input validation

All public-API routes validate the body with **zod**. Schemas live in
the route file. Invalid → 400 with `{ error: 'invalid_request', issues }`.

Internal routes are not yet 100% zod-covered — add as you touch them.

### 8.8 Secret rotation

- **Anthropic API key** (per tenant): `PUT /api/tenant-settings/anthropic-key`
  with the new key. Old plaintext is overwritten; old ciphertext can't be
  recovered. `audit_log` records `rotate_key` action.
- **`JWT_SECRET`**: rotate in your secret store, redeploy. All sessions
  invalidate (users must re-login).
- **`ENCRYPTION_KEY`**: **do NOT** rotate without a migration script that
  re-encrypts every `client_configurations.config_data` and
  `tenants.anthropic_api_key`. Plan for this carefully.
- **`WORKER_SECRET`**: rotate in your secret store + restart workers.

### 8.9 HIPAA compliance matrix

| HIPAA control                             | Implementation                                            |
|-------------------------------------------|-----------------------------------------------------------|
| Tenant isolation                          | `tenant_id` FK on every table; query-level filter         |
| Encryption at rest                        | AES-256-GCM for credentials; PG TDE for DB (deploy time)  |
| Encryption in transit                     | HTTPS terminated at platform; HSTS via helmet             |
| Audit trail                               | `audit_log` table + auto-middleware; structured JSON logs |
| Access control                            | JWT + role + tenant scope                                 |
| Least privilege                           | DB connection user has only schema access; KV gives role  |
|                                           | accounts least-privilege roles                            |
| PHI/PII de-identification in logs         | `logger.ts` masking + `sanitizeChatContent`               |
| Customer-owned LLM credentials            | `tenants.anthropic_api_key`                               |
| Human approval gates                      | Pipeline `approve-per-stage` mode + `gate-runner.ts`      |
| No hardcoded secrets                      | `utils/secrets.ts` reads from KV/SM/SM/env                |
| Incident response (req. for HITRUST)      | Append `audit_log` queries to your runbook                |

---

## 9. Deployment (Cloud-Agnostic)

### 9.1 Provider-neutral env vars

See `.env.example` for the complete list. Key configuration knobs:

| Env var              | Purpose                                              |
|----------------------|------------------------------------------------------|
| `NODE_ENV`           | `production` enables strict error responses, CSP     |
| `DATABASE_URL`       | Connection string for PostgreSQL                     |
| `JWT_SECRET`         | HS256 signing key (≥32 chars)                        |
| `ENCRYPTION_KEY`     | Base64 32-byte AES key                               |
| `WORKER_SECRET`      | Shared API↔worker secret                             |
| `STORAGE_PROVIDER`   | `azure-blob` \| `s3` \| `gcs` \| `local`             |
| `SECRETS_PROVIDER`   | `env` \| `azure-kv` \| `aws-sm` \| `gcp-sm`          |
| `ALLOWED_ORIGINS`    | Comma-separated CORS allow-list                      |
| `AGENTS_DIR`         | Where to load agent prompts from                     |
| `ANTHROPIC_API_KEY`  | Platform fallback (empty → tenants must BYO key)     |

### 9.2 Azure App Service

```
┌────────────────────────────────────────────────────────────────┐
│  Azure Front Door                                              │
└─────────────┬─────────────────────────────┬───────────────────┘
              │                             │
              ▼                             ▼
   ┌──────────────────────┐      ┌──────────────────────┐
   │  Static Web App      │      │  App Service (API)   │
   │  Vite production     │      │  Linux, Node 20      │
   │  build output        │      │  Plan: P1V3+         │
   └──────────────────────┘      └────┬─────────────────┘
                                      │
                                      ▼
                       ┌──────────────────────────────┐
                       │  Container App (Worker)      │
                       │  scale: 1–N replicas         │
                       └────┬─────────────────────────┘
                            │
                            ▼
            ┌───────────────────────────────────┐
            │  Postgres Flexible Server         │
            │  - SSL required                   │
            │  - Backup retained 35 days        │
            └───────────────────────────────────┘
            │
            ▼
            ┌───────────────────────────────────┐
            │  Storage Account (Blob)           │
            │  Container: intelliqe-artifacts   │
            └───────────────────────────────────┘
            │
            ▼
            ┌───────────────────────────────────┐
            │  Key Vault                        │
            │  Secrets: JWT_SECRET, ENCRYPTION_ │
            │  KEY, WORKER_SECRET, …            │
            │  Access: Managed Identity         │
            └───────────────────────────────────┘
```

**App Service env (the API)**:
```
NODE_ENV=production
DATABASE_URL=<from Key Vault reference>
JWT_SECRET=<KV>          ENCRYPTION_KEY=<KV>     WORKER_SECRET=<KV>
STORAGE_PROVIDER=azure-blob
AZURE_STORAGE_CONNECTION_STRING=<KV>
AZURE_STORAGE_CONTAINER=intelliqe-artifacts
SECRETS_PROVIDER=azure-kv
AZURE_KEY_VAULT_URL=https://<vault>.vault.azure.net/
ALLOWED_ORIGINS=https://app.intelliqe.example.com
PORT=8080
```

**Container App (worker)**:
```
BACKEND_URL=https://api.intelliqe.example.com
WORKER_SECRET=<KV ref>
ANTHROPIC_API_KEY=<KV>   # optional platform fallback
AGENTS_DIR=/app/agents
```

Build command (API): `cd backend && npm ci && npm run build && npm start`
Build command (worker): `cd backend && npm ci && npm run build && node dist/worker/index.js`

App Service "Identity" → System-assigned Managed Identity → grant
**"Key Vault Secrets User"** on the vault.

### 9.3 AWS (App Runner + RDS + S3)

```
                  ┌────────────────────────┐
                  │  CloudFront            │
                  └─────┬─────────────┬────┘
                        │             │
                        ▼             ▼
            ┌──────────────────┐   ┌──────────────────┐
            │  S3 (static SPA) │   │  App Runner (API)│
            └──────────────────┘   └────┬─────────────┘
                                        │
                                        ▼
                          ┌──────────────────────┐
                          │  ECS Fargate (Worker)│
                          └────┬─────────────────┘
                               │
                               ▼
                     ┌────────────────────────┐
                     │  RDS Postgres          │
                     └────────────────────────┘
                               │
                               ▼
                     ┌────────────────────────┐
                     │  S3 (artifacts)        │
                     └────────────────────────┘
                               │
                               ▼
                     ┌────────────────────────┐
                     │  Secrets Manager       │
                     └────────────────────────┘
```

**App Runner env**:
```
NODE_ENV=production
DATABASE_URL=postgres://...?sslmode=require
JWT_SECRET=  ENCRYPTION_KEY=  WORKER_SECRET=
STORAGE_PROVIDER=s3
AWS_S3_BUCKET=intelliqe-artifacts
AWS_REGION=us-east-1
SECRETS_PROVIDER=aws-sm
ALLOWED_ORIGINS=https://app.intelliqe.example.com
```

App Runner / ECS task role has `secretsmanager:GetSecretValue` on the
relevant secrets, plus `s3:PutObject/GetObject` on the bucket.

### 9.4 GCP (Cloud Run + Cloud SQL + GCS)

```
   Cloud CDN → Cloud Storage (static SPA)
   Cloud Run (API) ──► Cloud SQL (Postgres) over Cloud SQL Auth Proxy
   Cloud Run job (Worker, scheduled invoker)
   GCS bucket (artifacts)
   Secret Manager (secrets)
```

**Cloud Run env**:
```
NODE_ENV=production
DATABASE_URL=postgres://…@127.0.0.1:5432/postgres   # via Cloud SQL Auth Proxy
JWT_SECRET=  ENCRYPTION_KEY=  WORKER_SECRET=
STORAGE_PROVIDER=gcs
GCP_PROJECT_ID=my-project
GCP_STORAGE_BUCKET=intelliqe-artifacts
SECRETS_PROVIDER=gcp-sm
ALLOWED_ORIGINS=https://app.intelliqe.example.com
```

Service account: Cloud Run runtime SA with `roles/secretmanager.secretAccessor`
and `roles/storage.objectAdmin` (scoped to the bucket).

### 9.5 Docker Compose (on-prem / dev)

`docker-compose.yml` (sketch):

```yaml
version: '3.9'
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: postgres
      POSTGRES_PASSWORD: admin
    volumes: [pgdata:/var/lib/postgresql/data]

  api:
    build: ./backend
    command: node dist/index.js
    ports: ["3001:3001"]
    env_file: .env
    depends_on: [postgres]

  worker:
    build: ./backend
    command: node dist/worker/index.js
    env_file: .env
    depends_on: [api]

  web:
    build: ./frontend
    ports: ["80:80"]
    environment:
      VITE_API_BASE: http://api:3001
    depends_on: [api]

volumes:
  pgdata:
```

### 9.6 Database setup

Start the API normally — `initDb()` creates the schema from scratch on
first boot (idempotent: safe to re-run).

### 9.7 Worker scaling

Multiple workers can run safely in parallel — `claimNextTask` uses
`FOR UPDATE SKIP LOCKED` so tasks are claimed atomically.

Heuristic: 1 worker per ~5 concurrent test runs. Each worker holds at
most 1 task at a time. Memory: ~256 MB per worker.

---

## 10. Operational Runbook

### 10.1 New tenant onboarding

1. Platform admin POSTs `/api/users/tenants` (or runs SQL) to create the
   tenant row.
2. Create the first admin user via `/api/auth/signup` with the new tenant.
3. Admin logs in, opens **System Configuration** → integrations:
   - Connect Jira / Confluence / etc. (optional)
   - Connect storage provider for artifacts
   - Connect SMTP for notifications (optional)
4. Admin opens **System Configuration → AI Self-Healing** (TBD UI for
   tenant Anthropic key) — or POSTs `/api/tenant-settings/anthropic-key`
   directly with the customer's own Claude API key.
5. Admin runs the chat wizard once to verify end-to-end.

### 10.2 Tenant API key rotation

```http
PUT /api/tenant-settings/anthropic-key
Authorization: Bearer <admin-jwt>
{ "apiKey": "__ENC__<new-key-xor-base64>" }
```

The worker picks up the new key on the very next task — no restart needed.

### 10.3 Forced run cancellation

```http
POST /api/pipeline/<runId>/cancel
```

Status flips to `cancelled`. The worker, if mid-task, will complete its
current Claude call and then mark the next dispatch as canceled.

### 10.4 Backup & restore

PostgreSQL: nightly logical dumps + WAL archiving on the managed instance
of your choice. Recommended retention: ≥35 days for HIPAA.

Blob storage: enable soft-delete + versioning on the bucket / container.

Audit log: do NOT purge. Implement archival to cold storage on a
schedule if size becomes a concern.

### 10.5 Common alerts to wire

(via your APM / Cloud Monitor; not built into the platform):

- `audit_log` write failures > 0 → page on-call
- Worker heartbeat stale > 5 min while tasks pending → page on-call
- Claude 429 rate > 5/min → throttle
- DB connection failures > 0 → page
- `/api/health` returning non-200 → page

---

## 11. Local Development

### 11.1 Prerequisites

- Node.js 20+
- PostgreSQL 14+ running locally (`postgres` DB, `JBSTestOpsAI` schema
  auto-created)
- Anthropic API key (set as `ANTHROPIC_API_KEY` env var for dev)
- Claude Code CLI (`claude`) optional, for `claude-runner.ts` fallback

### 11.2 Bootstrap

```bash
git clone <repo>
cd JBSIntelliQE
cp .env.example backend/.env       # edit values
cd backend && npm install
cd ../frontend && npm install
```

### 11.3 Run

Three terminals:

```bash
# Terminal 1 — API
cd backend && npm run dev

# Terminal 2 — Worker (in another terminal)
cd backend && npm run worker:start

# Terminal 3 — Frontend
cd frontend && npm run dev
# → http://localhost:5173, proxies /api → http://localhost:3001
```

### 11.4 Seed users

`initDb()` seeds:
- `jbsadmin` / `Omeesha@19` (admin, JBS platform tenant)
- `qaengineer` / `Login@2026` (qa_engineer, JBS tenant)

### 11.5 Customizing the pipeline

Edit `backend/config/pipeline-definition.json`. Worker reloads on next
poll. For a per-tenant override, INSERT into `qa_pipeline_definitions`
with `tenant_id` = that tenant's id and a complete `definition` JSON.

---

## 12. Future Scope

### 12.1 API automation (Phase 2)

Same pipeline, different agents. Planned changes:

- New agent prompts: `api-test-planner.agent.md`,
  `api-test-generator.agent.md`, `api-test-healer.agent.md`.
- New pipeline definition variant keyed by `intent: 'api'`.
- New executor: replace the Playwright runner with an OpenAPI-driven
  test executor (likely **Pact** or a custom HTTP-assert runner).
- New artifacts: OpenAPI snippets, Postman collections, contract files.
- Reuse the entire orchestrator, audit, SSE, and worker infrastructure.

The `postman` integration in `integrationCatalog.ts` is already a
placeholder (`comingSoon: true`).

### 12.2 Mobile automation (Phase 3)

Would add an Appium runner; agent prompts would target iOS/Android selectors.

### 12.3 Partner-facing public API

The `/api/v1/public/*` surface today still requires a user JWT.
To open it to partner integrations:

1. Add a `tenant_api_tokens` table: `tenant_id, token_hash, label,
   scopes TEXT[], created_at, last_used_at, revoked_at`.
2. New middleware `requirePublicScope` accepts
   `Authorization: Bearer iqe_<token>` or `X-API-Key: <token>`.
3. Sales / admin UI to mint tokens.
4. Per-token rate limits.

The audit middleware already records the call; only the auth scheme changes.

### 12.4 Compaction & memory

The orchestrator currently re-feeds the full context to each stage.
Future: leverage Anthropic prompt caching for the agent system prompt
(static across stages) → ~70% cache hit rate, ~10x faster.

---

## 13. Glossary

- **Agent** — A Claude prompt + capability scope that performs one stage
  of the pipeline. Lives in `.github/agents/*.md`.
- **AGENTS_DIR** — Env var pointing at the agent prompt directory; lets
  customer environments load JBS-protected prompts from a separate
  artifact.
- **Artifact** — Any output of a stage: test cases JSON, Playwright
  spec, screenshot, trace, report. Stored in `qa_artifacts` (small) or
  blob storage (large).
- **Cascade plan** — Per-tenant graph of pages and their dependencies;
  used so a single `requirements` run can fan out across many pages.
- **Convergence guard** — A check that prevents the pipeline from
  spinning forever (budget cap, max retries, same-findings).
- **Healing** — Auto-fix of a failed test by feeding the failure context
  back to a healer agent.
- **JBS-protected intelligence** — The agent prompts and orchestrator
  logic — the IP that JBS sells.
- **PHI / PII** — Protected Health / Personally Identifiable Information.
  Must stay in the customer's environment per HIPAA.
- **Platform tenant** — The JBS tenant itself (`is_platform = true`);
  has cross-tenant visibility for support.
- **Run** — One end-to-end pipeline invocation. PK in
  `qa_pipeline_runs.id`. Streams events via SSE.
- **Stage** — One step in the pipeline (`requirements`, `planning`,
  `generation`, `healing`, `audit`). Each backed by one agent.
- **Tenant** — A customer organization. Top-level isolation boundary.
- **Worker** — A Node.js process that polls for tasks and runs the
  Claude calls. Separable from the API; horizontally scalable.

---

*End of specification. To extend: update this document first, then the
code — the doc is the contract.*
