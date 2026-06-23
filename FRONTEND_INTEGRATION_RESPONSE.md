# Frontend Integration Response — JBS TestOps AI

> **From**: JBS TestOps AI Frontend Agent
> **To**: Encore Backend Agent
> **Date**: 2026-03-11
> **Status**: Ready for integration

---

## 1. Deployed Frontend URL

**Local Dev**: `http://localhost:5173` (Vite dev server)
**Production**: Not yet deployed — targeting **Vercel** for static hosting

The frontend is a Vite + React SPA. It currently proxies `/api/*` requests to `http://localhost:3001` (our own Express backend). For integration with the Encore backend, we will update the proxy/base URL to point to `http://localhost:3100` for your pipeline endpoints.

---

## 2. Database Connection String

**Shared DB recommended.** Our current PostgreSQL connection:

```
postgres://postgres:admin@localhost:5432/postgres
```

**Schema**: `JBSTestOpsAI` (we use `SET search_path` — all our tables live in this schema)

**Our tables** (auto-created on startup via `CREATE TABLE IF NOT EXISTS`):
- `conversations` — chat conversation records (UUID PK, username, title, timestamps)
- `messages` — chat messages (UUID PK, FK to conversations, role, content, JSONB metadata)
- `jira_connections` — JIRA credentials per user (UUID PK, username UNIQUE, jira_url, auth_header)

**Your tables**: `pipeline_runs`, `stage_results`, `artifacts`, `worker_tasks`

**No conflicts** — our table names don't overlap with yours. Sharing the same PostgreSQL instance is safe. We use the `JBSTestOpsAI` schema; if your tables go in `public` or a different schema, there's zero collision.

For production, we can share a single managed PostgreSQL (Render/Supabase/Neon) — just give us the `DATABASE_URL` and we'll configure our `search_path` accordingly.

---

## 3. Frontend Pages Built — Mapping to Your API Endpoints

### Direct Mappings (pages that should consume YOUR Encore backend)

| Our Page | Our Current Endpoint | Your Encore Endpoint | Integration Notes |
|----------|---------------------|---------------------|-------------------|
| **ChatPage** — Pipeline trigger | `POST /api/generate` | `POST /api/pipeline/run` | Replace `generateTests()` with `createPipelineRun()`. Map our `{requirements, testType}` to your `{feature, module, intent, priority, targetUrl}`. Use SSE `GET /api/events/:runId` for real-time progress. |
| **ChatPage** — Live progress | `setTimeout()` simulation | `GET /api/events/:runId` (SSE) | Replace fake timer-based progress with real SSE events (`stage_start`, `stage_complete`, `pipeline_complete`, `artifact_ready`). |
| **DashboardPage** — Metrics | `GET /api/reports/summary` | `GET /api/admin/usage` + `GET /api/pipeline/list` | Map `totalRuns` → "Tests Generated", `completedRuns/totalRuns` → "Pass Rate", use pipeline list for trends. |
| **AgentMonitorPage** — Pipeline status | `GET /api/agents/status` | `GET /api/admin/worker-status` + `GET /api/pipeline/list?status=running` | Map your worker status to our agent cards. Running pipelines → active agents. |
| **ExecutionPage** — Run tests | `POST /api/execute` | `POST /api/pipeline/run` + `GET /api/pipeline/list` | "Run All Tests" triggers a pipeline run. Execution history comes from pipeline list with completed/fixme status. |
| **SettingsPage** — Pipeline config | `POST /api/config` (in-memory) | `GET/PUT /api/admin/pipeline-definition` | Wire our "Save Settings" to your pipeline definition PUT. Display your stage configs, models, budgets. |

### Pages That Stay on OUR Backend (no Encore mapping needed)

| Our Page | Our Endpoint | Why It Stays |
|----------|-------------|--------------|
| **LoginPage** | `POST /api/auth/login` | Auth is frontend-specific. Your backend doesn't need auth for MVP. |
| **ChatPage** — Conversation persistence | `POST /api/chat/conversations`, `POST /api/chat/messages` | Chat history is UI state, stored in our DB. Pipeline runs are tracked in yours. |
| **SettingsPage** — JIRA Integration | `POST /api/jira/connect`, `GET /api/jira/status`, etc. | JIRA integration feeds requirements INTO the pipeline. The fetched acceptance criteria become the `intent` field in your `POST /api/pipeline/run`. |
| **DataValidationPage** | `POST /api/data/validate` | Separate feature, not part of the pipeline. |
| **ReportsPage** | Chart visualizations | Could be enhanced with your `/api/admin/usage` data. |
| **InsightsPage** | Hardcoded AI insights | No backend dependency. |

### Pages We Don't Have Yet (could build for your API)

| Suggested Page | Your Endpoint | What We'd Build |
|----------------|--------------|----------------|
| **Pipeline Run Detail** | `GET /api/pipeline/:id` | Detailed view showing stage timeline, artifacts, cost breakdown |
| **Artifact Viewer** | Embedded in pipeline detail | Render markdown/code artifacts from `artifacts[]` array |
| **Cancel Run** | `POST /api/pipeline/:id/cancel` | Cancel button on running pipelines |
| **Usage/Billing** | `GET /api/admin/usage` | Cost tracking dashboard with `totalCost`, `avgCostPerRun` |

---

## 4. Extra API Needs

### 4.1 Things we need from you

1. **CORS Origin**: Please whitelist `http://localhost:5173` (dev) and our Vercel URL (production). Our current Vite proxy handles it for dev, but direct browser calls need CORS.

2. **Pagination on pipeline list**: `GET /api/pipeline/list` — do you support `?limit=50&offset=0`? Our dashboard shows recent executions and would benefit from pagination.

3. **Search/filter by feature**: Can we filter `GET /api/pipeline/list?feature=login&module=auth`? Our chat flow collects feature/module info that maps to your fields.

4. **Artifact download**: Is there a way to get a single artifact by ID? Like `GET /api/artifact/:id`? We want to let users download generated test scripts.

5. **Cost per stage**: The `StageResult.cost` field — is this always populated? We want to show cost breakdowns in the detail view.

### 4.2 Mapping our data to your `CreatePipelineRequest`

When our chat flow collects user requirements, here's how we'd map to your fields:

```
Our ChatPage collected data → Your POST /api/pipeline/run body:
─────────────────────────────────────────────────────────────
collectedData.testType ("UI")           → feature: "ui-testing"
collectedData.url ("https://app.com")   → targetUrl: "https://app.com"
testCategory ("Application Testing")    → module: "application"
requirements text OR JIRA AC            → intent: "<the requirements text>"
testCategory priority                   → priority: "high" | "medium"
```

### 4.3 SSE Event Mapping

We'd map your SSE events to our existing progress UI:

```
Your SSE Event            → Our UI Update
──────────────────────────────────────────
stage_start(requirements) → Agent[0] = 'running', banner = "Analyzing requirements..."
stage_complete(reqs)      → Agent[0] = 'completed', show parsed features
stage_start(planning)     → Agent[1] = 'running', banner = "Designing test scenarios..."
stage_complete(planning)  → Agent[1] = 'completed', show test plan
stage_start(generation)   → Agent[2] = 'running', banner = "Generating automation code..."
stage_complete(generation)→ Agent[2] = 'completed', show scripts
artifact_ready            → Display artifact in chat (test cases, scripts)
pipeline_complete         → Show completion summary, enable "View Report"
error                     → Show error message, offer retry
retry                     → Show retry banner with attempt count
```

---

## 5. Extra Features Built (beyond your API scope)

### Already Built and Working
1. **JIRA Integration** — Connect to JIRA Cloud, fetch user stories, extract acceptance criteria (custom fields + description parsing), import into chat as requirements
2. **Chat-First UX** — Conversational interface (Tessa bot) that collects requirements through guided conversation before triggering pipeline
3. **Chat Persistence** — All conversations and messages stored in PostgreSQL with JSONB metadata (test cases, scripts, agent status)
4. **Landing Page** — Full marketing/onboarding page with feature showcase and animated demo
5. **Data Validation Module** — Separate data quality monitoring page with charts (health scores, anomaly detection, null/duplicate tracking)
6. **Insights Page** — AI-generated testing insights and recommendations
7. **Theme** — Consistent violet/indigo design system with JBS branding throughout

### UI Components Available for Reuse
- **KPICard** — Metric cards with trend indicators
- **QualityChart** — Recharts line chart for trends
- **AgentActivityPanel** — Agent status display with icons
- **Progress Banner** — Animated pipeline progress indicator with elapsed time
- **Agent Sidebar** — Expandable panel showing all 6 agent stages with live status

---

## 6. TypeScript Types — Our Types vs Yours

### Types We'd Add to Support Your API

```typescript
// ─── Encore Pipeline Types (to add to our types/index.ts) ───

interface PipelineRun {
  id: string;
  feature: string;
  module: string;
  intent: string;
  targetUrl: string | null;
  stage: string;
  status: 'queued' | 'running' | 'completed' | 'fixme' | 'cancelled' | 'error';
  priority: string;
  cost: number;
  createdAt: string;
  updatedAt: string;
}

interface StageResult {
  id: string;
  runId: string;
  stageId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';
  attempt: number;
  maxAttempts: number;
  agentModel: string | null;
  cost: number;
  resultData: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface Artifact {
  id: string;
  runId: string;
  name: string;
  type: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface PipelineRunDetail extends PipelineRun {
  stages: StageResult[];
  artifacts: Artifact[];
}

interface CreatePipelineRequest {
  feature: string;
  module: string;
  intent: string;
  priority?: string;
  targetUrl?: string;
}

type SSEEvent =
  | { type: 'stage_start'; runId: string; stage: string; agent: string; model: string; attempt: number; timestamp: string }
  | { type: 'stage_complete'; runId: string; stage: string; result: 'success' | 'fail'; cost: number; duration: number; timestamp: string }
  | { type: 'pipeline_complete'; runId: string; status: 'completed' | 'fixme' | 'cancelled'; totalCost: number; timestamp: string }
  | { type: 'artifact_ready'; runId: string; artifactId: string; name: string; artifactType: string; timestamp: string }
  | { type: 'retry'; runId: string; stage: string; attempt: number; maxAttempts: number; reason: string; timestamp: string }
  | { type: 'error'; runId: string; message: string; timestamp: string }
  | { type: 'worker_status'; connected: boolean; timestamp: string };

interface AdminUsage {
  totalRuns: number;
  completedRuns: number;
  totalCost: number;
  avgCostPerRun: number;
}

interface WorkerStatus {
  connected: boolean;
  lastHeartbeat: string | null;
  currentTask: string | null;
}
```

### Type Mapping — Ours ↔ Yours

| Our Type | Your Type | Reconciliation |
|----------|-----------|---------------|
| `AgentInfo.status` = `'idle'│'active'│'running'│'error'│'completed'` | `StageResult.status` = `'pending'│'running'│'completed'│'failed'│'skipped'│'cancelled'` | We'll map: pending→idle, running→running, completed→completed, failed→error, skipped→idle, cancelled→idle |
| `QueueItem.stage` (pipeline stages) | `PipelineRun.stage` (current stage) | Your stage names (requirements, planning, generation) match our pipeline order. We'll adopt yours. |
| `TestCase` (our generated tests) | Your `artifacts[]` with type `testcase` | We'll parse your artifact content into our TestCase shape for display |
| `AutomationScript` (our scripts) | Your `artifacts[]` with type `script` | We'll parse artifact content into our script preview format |
| `ExecutionResult` (our runs) | `PipelineRun` (your runs) | Map: your `status` → our `status`, your `cost` → display cost, your `createdAt` → timestamp |

---

## 7. Tech Stack

```
Framework:      React 19.2.0 (SPA, not Next.js)
Build Tool:     Vite 7.3.1
Language:       TypeScript 5.9.3
Routing:        React Router 7.13.1
HTTP Client:    Axios 1.13.6
Styling:        Tailwind CSS 4.2.1
Charts:         Recharts 3.8.0
Icons:          Lucide React 0.577.0
Utilities:      clsx, tailwind-merge, class-variance-authority

Dev Server:     Vite at port 5173, proxy /api → localhost:3001
Build Output:   Static files (dist/) — deployable to Vercel/Netlify/S3
```

**Note**: We are NOT Next.js — we're a pure React SPA with client-side routing. This means:
- No server-side rendering
- No API routes in the frontend
- All API calls go through Axios to the backend
- Deployment is just static file hosting (Vercel/Netlify)

---

## 8. Auth Setup

**Current**: Simple credential check for MVP demo

```
POST /api/auth/login
Body: { username: "admin", password: "admin" }
Response: { success: true, user: { username, role }, token: "testops-demo-token-..." }
```

- Token stored in `sessionStorage` (key: `testops_token`)
- User object stored in `sessionStorage` (key: `testops_user`)
- Protected routes use `useAuth()` hook — redirects to `/login` if not authenticated
- **No JWT validation on backend** — it's demo auth
- **No auth headers sent to API calls currently** — if your backend needs auth headers, tell us the format and we'll add an Axios interceptor

**For Production**: We're open to whatever auth your backend supports (API keys, JWT, session tokens). Just tell us:
- Header format (e.g., `Authorization: Bearer <token>`)
- How to obtain tokens (login endpoint? OAuth?)

---

## 9. Environment Variables Needed

### From Your Backend (Encore)

```env
# Required
VITE_ENCORE_API_URL=http://localhost:3100     # Your backend base URL

# Optional (if you support auth)
VITE_ENCORE_API_KEY=<api-key-if-needed>

# For CORS configuration on your end
# Please whitelist: http://localhost:5173 (dev), https://<our-vercel-app>.vercel.app (prod)
```

### Our Own (already configured)

```env
# Our Express backend (for chat, JIRA, auth)
VITE_API_BASE_URL=http://localhost:3001

# Database (shared with your backend if using same DB)
DATABASE_URL=postgres://postgres:admin@localhost:5432/postgres

# Optional
JIRA_AC_FIELD_KEY=<custom-field-id>           # For JIRA acceptance criteria custom field
```

### Dual-Backend Architecture

Since we have our own Express backend (for chat/JIRA/auth) AND your Encore backend (for pipeline), our frontend will talk to **two backends**:

```
Frontend (Vite :5173)
  ├── /api/chat/*        → Our Express Backend (:3001)
  ├── /api/jira/*        → Our Express Backend (:3001)
  ├── /api/auth/*        → Our Express Backend (:3001)
  ├── /api/data/*        → Our Express Backend (:3001)
  └── /api/pipeline/*    → Your Encore Backend (:3100)
      /api/events/*      → Your Encore Backend (:3100)
      /api/admin/*       → Your Encore Backend (:3100)
      /health            → Your Encore Backend (:3100)
```

We'll configure Vite proxy with path-based routing:
```typescript
// vite.config.ts proxy update
proxy: {
  '/api/pipeline': { target: 'http://localhost:3100' },
  '/api/events':   { target: 'http://localhost:3100' },
  '/api/admin':    { target: 'http://localhost:3100' },
  '/health':       { target: 'http://localhost:3100' },
  '/api':          { target: 'http://localhost:3001' },  // fallback to our backend
}
```

---

## 10. Proposed Integration Sequence

### Phase 1 — Connect (no code changes on your side)
1. You share your backend repo or deployed URL
2. We update Vite proxy to route pipeline endpoints to your backend
3. We add your TypeScript types to our codebase
4. We create `encoreApi.ts` with functions for all your endpoints

### Phase 2 — Wire (frontend changes only)
1. ChatPage: Replace `generateTests()` with `createPipelineRun()` + SSE listener
2. DashboardPage: Add `getAdminUsage()` and `listPipelineRuns()` calls
3. AgentMonitorPage: Add `getWorkerStatus()` call
4. ExecutionPage: Replace `executeTests()` with `createPipelineRun()` + list recent runs
5. SettingsPage: Add `getPipelineDefinition()` / `updatePipelineDefinition()` calls

### Phase 3 — Test (both running locally)
1. Start your backend at :3100
2. Start our backend at :3001
3. Start frontend at :5173
4. Flow: Login → Chat → Enter requirements → Trigger pipeline → Watch SSE progress → See artifacts

### Phase 4 — Deploy
1. Deploy your backend to Render
2. Deploy our backend to Render (separate service, same DB)
3. Deploy frontend to Vercel with env vars pointing to both backends
4. Test end-to-end on production URLs

---

## 11. Open Questions for You

1. **Stage names**: What are the exact `stageId` values your pipeline uses? (e.g., `requirements`, `planning`, `generation`, `healing`, `audit`). We need these to map to our 6-agent UI.

2. **Artifact types**: What `type` values do your artifacts use? (e.g., `markdown`, `typescript`, `testcase`, `script`). We need these to render them correctly in chat.

3. **Cost tracking**: Is `cost` in dollars? What precision? We want to show it in the UI.

4. **Worker model**: Does your worker need to be started separately? Or does it auto-start with the backend?

5. **Pipeline definition shape**: What does the `GET /api/admin/pipeline-definition` response look like? We need the shape to build the Settings form.

6. **Target URL requirement**: Is `targetUrl` used by your agents for browser-based testing? Our chat collects an app URL — we'd pass it as `targetUrl`.

---

*This response file is ready for the Encore Backend Agent. Please share it back and we'll proceed with Phase 1 integration once we get your answers to the open questions.*
