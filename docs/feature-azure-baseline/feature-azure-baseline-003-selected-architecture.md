# JBSIntelliQE — Selected Azure Deployment Plan (Plan B, Unified Container Variant)

> **Status:** ✅ Selected architecture. This is what we are building.
> **Parent reference:** [feature-azure-baseline-002-plans-considered.md](feature-azure-baseline-002-plans-considered.md) (baseline reference with all three plans + cross-cutting decisions)
> **Last updated:** 2026-05-27
>
> **Selected by:** Owner decision on 2026-05-27. Choice = Plan B (Container Apps Unified Platform) with one customization: **frontend and backend run in a single container**; database remains a separate managed service.

---

## Table of Contents

1. [The Decision in One Page](#1-the-decision-in-one-page)
2. [Architecture Diagram](#2-architecture-diagram)
3. [The "Unified Container" Decision — Options Analysis](#3-the-unified-container-decision--options-analysis)
4. [Component-by-Component Decisions](#4-component-by-component-decisions)
5. [Code & Repository Changes Required](#5-code--repository-changes-required)
6. [SSE + Multi-Replica Design Note (Important)](#6-sse--multi-replica-design-note-important)
7. [Cross-Cutting Decisions Inherited from Baseline](#7-cross-cutting-decisions-inherited-from-baseline)
8. [Implementation Phase Plan](#8-implementation-phase-plan)
9. [HIPAA Compliance Checklist](#9-hipaa-compliance-checklist)
10. [Risks & Mitigations](#10-risks--mitigations)
11. [Open Questions](#11-open-questions-to-resolve-before-build)

---

## 1. The Decision in One Page

| Layer | Choice | Why |
|---|---|---|
| **Frontend + Backend** | **Single container** on Azure Container Apps | Owner preference. Simpler deploys, no CORS, single ingress, same-origin auth cookies. |
| **Worker** | Separate **Azure Container Apps Job** (event-driven, KEDA on Service Bus) | Different scaling profile; scale-to-zero saves cost; Playwright workload has different resource shape. |
| **Database** | **Azure Database for PostgreSQL Flexible Server** (HA, zone-redundant) | Managed PostgreSQL; HIPAA-eligible; PITR; private endpoint. |
| **Edge** | **Azure Front Door Premium + WAF + DDoS Std** | Global CDN for static assets; WAF; Private Link origin to Container Apps. |
| **Egress** | **Azure Firewall** in hub VNet | Centralized egress logging for HIPAA audit. |
| **Networking** | **Hub-spoke VNet** topology | Plan B baseline. Hub = Firewall + Bastion. Spoke = app + private endpoints. |
| **Secrets** | **Azure Key Vault** (Private Endpoint, Managed Identity) | Replaces XOR-in-DB in `utils/crypto.ts`. |
| **Identity (end users)** | **Microsoft Entra External ID** | Replaces the current `intelliqe-demo-token` scheme. MFA + HIPAA-eligible. |
| **Identity (workloads)** | **User-Assigned Managed Identity** per workload | No secrets in env vars for Azure-native auth. |
| **LLM** | **Azure AI Foundry — Claude** (prod) / direct Anthropic API (dev only) | Keeps PHI inside Microsoft BAA boundary in prod. |
| **Queue** | **Azure Service Bus** Standard | Replaces 5s worker polling with event-driven. |
| **Email** | **Azure Communication Services Email** | HIPAA-eligible; managed SMTP. |
| **Object storage** | **Azure Blob (GRS)** with versioning | Execution artifacts, screenshots, immutable audit archive. |
| **Observability** | **Application Insights + Log Analytics** | Native, HIPAA-eligible, 6-year audit retention via Blob archive. |
| **CI/CD** | **GitHub Actions + OIDC** to Azure | No long-lived secrets. |
| **IaC** | **Bicep** (per-env stacks: dev / staging / prod) | Azure-native, lowest friction for new-to-Azure team. |

---

## 2. Architecture Diagram

```
                          Internet users
                                │
                                ▼
                ┌──────────────────────────────────┐
                │  Azure Front Door Premium        │   WAF · DDoS Std · global edge
                │  ─ /api/*  → no cache, SSE-safe  │   TLS 1.2+ · custom domain
                │  ─ /assets/*, /, /static/*       │   ↓ Private Link origin
                │     → CDN cache                  │
                └──────────────┬───────────────────┘
                               │ (Private Link)
                               ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │                Spoke VNet (prod-app-vnet)                           │
   │                                                                     │
   │   ┌─────────────────────────────────────────────┐                   │
   │   │  Azure Container Apps Environment           │                   │
   │   │                                             │                   │
   │   │  ┌───────────────────────────────────────┐  │                   │
   │   │  │  intelliqe-app  (UNIFIED CONTAINER)   │  │                   │
   │   │  │  ─ Express serves React SPA at /      │  │                   │
   │   │  │  ─ Express serves API at /api/*       │  │                   │
   │   │  │  ─ SSE at /api/events/*               │  │                   │
   │   │  │  ─ Port 3001 (HTTP/2)                 │  │                   │
   │   │  │  ─ Session affinity = ON              │  │                   │
   │   │  │  ─ min 2 replicas, max 10             │  │                   │
   │   │  │  ─ Managed Identity → KV, PG, SB, ACR │  │                   │
   │   │  └───────────────────────────────────────┘  │                   │
   │   │                                             │                   │
   │   │  ┌───────────────────────────────────────┐  │                   │
   │   │  │  intelliqe-worker  (Container Apps    │  │                   │
   │   │  │  Job, event-driven)                   │  │                   │
   │   │  │  ─ KEDA scaler: Service Bus depth     │  │                   │
   │   │  │  ─ Includes Chromium for Playwright   │  │                   │
   │   │  │  ─ Scales 0 → N on demand             │  │                   │
   │   │  │  ─ Managed Identity                   │  │                   │
   │   │  └───────────────────────────────────────┘  │                   │
   │   └────────────────────┬────────────────────────┘                   │
   │                        │                                            │
   │   ┌────────────────────▼────────────────────┐                       │
   │   │  Private Endpoints subnet              │                        │
   │   │                                         │                       │
   │   │  ──► Azure DB for PostgreSQL Flex      │                        │
   │   │       (D4ds_v5, HA zone-redundant)     │                        │
   │   │  ──► Azure Key Vault                   │                        │
   │   │  ──► Azure Service Bus (jobs queue)    │                        │
   │   │  ──► Azure Blob Storage (artifacts)    │                        │
   │   │  ──► Azure AI Foundry (Claude)         │                        │
   │   │  ──► Azure Container Registry          │                        │
   │   └─────────────────────────────────────────┘                       │
   └─────────────────────────────────────────────────────────────────────┘
                              │ VNet peering
                              ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │   Hub VNet (prod-hub-vnet)                                          │
   │   ─ Azure Firewall (egress filtering, logged)                       │
   │   ─ Azure Bastion (operator access, no VPN required)                │
   └─────────────────────────────────────────────────────────────────────┘
```

Key things to read from the diagram:

1. There is **exactly one customer-facing application container** (`intelliqe-app`). It serves both the React SPA and the API.
2. The **worker is a separate Container Apps Job** — not part of the unified container — because its scaling and resource shape (Playwright + Chromium + Claude calls) differ entirely from the request-serving tier.
3. Every data service is reached **only via Private Endpoint**. Nothing inside the spoke VNet ever talks to a public IP for Azure-managed services.
4. **Front Door is the only public ingress.** Container Apps ingress is private (Private Link).

---

## 3. The "Unified Container" Decision — Options Analysis

This is the customization that distinguishes this plan from the baseline Plan B. We considered three packaging options.

### 3.1 Option U1 — Single container serving SPA + API ✅ **SELECTED**

**Shape:** Multi-stage Dockerfile. Stage 1 runs `vite build` to produce `frontend/dist`. Stage 2 builds the backend TypeScript. Final stage copies the backend's `dist/` + the frontend's `dist/` (into a `public/` folder) into a slim Node 20 runtime image. Express serves `/api/*` via existing routes and falls back to `index.html` for any other path (standard SPA routing).

| Pros | Cons |
|---|---|
| ✅ One image, one deploy unit, one ingress endpoint | ❌ Frontend + backend redeploy together (cannot ship a frontend-only patch without rebuilding backend) |
| ✅ Same origin → no CORS configuration, no preflight overhead | ❌ Slightly larger container image (~50–100 MB extra for static assets) |
| ✅ Same-origin cookies → simpler auth session handling | ❌ Static assets served by Node instead of a CDN edge — partially mitigated by Front Door caching `/assets/*` |
| ✅ Removes Azure Static Web Apps from the bill of materials | ❌ Frontend and backend share the same scaling decisions |
| ✅ Local dev parity easier (one `docker run` reproduces prod shape) | |
| ✅ One TLS cert, one custom domain config | |
| ✅ Removes the need for the Vite dev proxy in production parity testing | |

**Why we accept the cons:**
- The frontend-only-patch concern is real but minor for IntelliQE — the team is small and frontend/backend changes are usually coupled to features anyway.
- The CDN concern is mitigated entirely by Front Door Premium caching `/assets/*`, `/static/*`, and any hashed-filename bundles at the edge. The Express server only handles cache misses.
- Coupled scaling isn't a problem because the bottleneck is always the API/SSE tier, not the static serving.

### 3.2 Option U2 — Static Web Apps + Container Apps backend (original Plan B)

| Pros | Cons |
|---|---|
| ✅ True CDN for frontend (SWA's built-in edge) | ❌ Two deploy pipelines |
| ✅ Frontend deploys independently | ❌ CORS configuration needed |
| ✅ Per-PR preview environments via SWA | ❌ Two custom domains / one with path routing |
| | ❌ More moving parts |

**Why rejected:** Owner preference for the simpler topology. The CDN benefit is replicated by Front Door in front of the unified container.

### 3.3 Option U3 — Frontend + Backend + Worker all in one container

| Pros | Cons |
|---|---|
| ✅ One image to rule them all | ❌ Mixes request-serving and long-running batch workloads in one process tree |
| | ❌ Cannot scale-to-zero for the worker |
| | ❌ Playwright/Chromium memory profile (~2 GB/run) destabilizes the API tier |
| | ❌ Worker crashes take down the API |
| | ❌ Forces backend replicas to all carry Chromium binaries (bloat) |

**Why rejected:** Operational and reliability hazard. The worker MUST stay in its own runtime.

---

## 4. Component-by-Component Decisions

This section lists only what differs from, or is more specific than, the baseline Plan B in [feature-azure-baseline-002-plans-considered.md](feature-azure-baseline-002-plans-considered.md). Everything else (HIPAA posture, secret management, networking baseline, observability stack, CI/CD, IaC choice, backup/DR) is **inherited unchanged** from the baseline.

### 4.1 Compute — `intelliqe-app` Container App

| Setting | Value | Why |
|---|---|---|
| Image source | Azure Container Registry (ACR) | Private registry inside our subscription, Private Endpoint, geo-replicated for DR. |
| Ingress | External, target port 3001 | Front Door connects via Private Link to Container Apps ingress. |
| Transport | HTTP/2 | Required for clean SSE behavior and modern client efficiency. |
| Session affinity (sticky cookie) | **ENABLED** | SSE clients must hit the same replica that registered them — see §6. |
| Min replicas | 2 | HA + survives a replica restart without dropping all SSE clients. Cannot use 0 because SSE clients would be evicted. |
| Max replicas | 10 | Headroom; tuned later from real load. |
| Scale rule | HTTP concurrency, 50 concurrent requests per replica | Empirically tuned per replica vCPU. |
| CPU / memory per replica | 1 vCPU / 2 GiB (start) | Adequate for Express + serving static. Easy to vertical-scale. |
| Health probe — liveness | `GET /api/health` every 30 s | Endpoint already exists. |
| Health probe — readiness | `GET /api/health/ready` every 10 s | Add a new endpoint that returns 200 only after DB connection + KV access succeed. |
| Health probe — startup | `GET /api/health` every 5 s, 60 s timeout | Allow time for `db.ts` table init at boot. |
| Managed Identity | User-Assigned, scoped to: KV (Secrets Get), PG (AAD login), Service Bus (Send), Blob (Read/Write), AI Foundry (Inference), ACR (Pull) | No secrets in env. |
| Env vars | Non-sensitive only (NODE_ENV, log level, region). Sensitive values come from Key Vault references at runtime. | HIPAA. |
| Revisions | Multiple revisions, traffic-split for canary (10% → 50% → 100%) | Native to Container Apps. |

### 4.2 Compute — `intelliqe-worker` Container Apps Job

| Setting | Value | Why |
|---|---|---|
| Job type | Event-triggered | Scales on Service Bus queue depth. |
| Scaler | KEDA Azure Service Bus scaler | Native to Container Apps. |
| Min executions | 0 | Scale-to-zero — pay only when work exists. |
| Max executions | 20 concurrent | Concurrency cap to avoid stampeding Claude rate limits. |
| Per-job CPU / memory | 2 vCPU / 4 GiB | Chromium + Node + a few in-flight Claude calls. |
| Job timeout | 30 minutes | Longest pipeline expected to run. |
| Image | Same Dockerfile? **No, separate image** | The worker image includes Playwright + Chromium browsers (~400 MB). Keeping it separate keeps the app image lean. |
| Managed Identity | User-Assigned, scoped to: KV (Get), PG, SB (Receive + DeadLetter), Blob (Read/Write), AI Foundry, ACR | Same posture as app. |
| Retry policy | Service Bus default + DLQ after 5 attempts | Poison-message safety. |

### 4.3 Networking specifics

- **Container Apps Environment** is deployed in `Workload Profiles` mode (required for VNet integration with custom subnets + Private Link ingress).
- **Subnets in the spoke VNet:**
  - `snet-app` (/23) — Container Apps environment infrastructure subnet.
  - `snet-pe` (/27) — Private Endpoints (PG, KV, SB, Blob, ACR, AI Foundry).
  - `snet-mgmt` (/28) — operator access via Bastion.
- **NSGs** on each subnet (default-deny inbound from internet; allow only Front Door's service tag inbound to `snet-app` ingress).
- **DNS:** Private DNS zones for each Private Endpoint, linked to the spoke VNet. Operator devboxes resolve via Bastion-routed DNS.

### 4.4 Front Door routing rules

| Path pattern | Behavior |
|---|---|
| `/api/events/*` (SSE) | No cache. `responseTimeoutInSeconds = 240`. WAF in detection mode for SSE (some WAF rules false-positive on long streams). |
| `/api/*` (non-SSE API) | No cache. Standard WAF prevention mode. |
| `/assets/*`, `/static/*`, `*.js`, `*.css`, `*.woff2` (hashed assets) | Cache at edge for 1 year. Hashed filenames mean no manual invalidation. |
| `/`, `/index.html`, `/login`, `/dashboard`, ... (SPA routes) | Cache `index.html` for 5 minutes. Cache-Control overridden on origin. |

### 4.5 Container Registry

| Setting | Value |
|---|---|
| SKU | **Premium** |
| Geo-replication | Primary region + paired region |
| Private Endpoint | Yes |
| Public access | Disabled |
| Image scanning | Defender for Containers — scan on push + at rest |
| Retention policy | Keep last 30 tags + tags matching `prod-*` indefinitely |

---

## 5. Code & Repository Changes Required

This is what the engineering team must build to land this architecture. Items marked 🔧 are code changes; items marked 🏗️ are infrastructure-as-code changes; items marked 🔐 are security-critical and must land before any HIPAA cutover.

### 5.1 🔧 Backend serves the frontend

In `backend/src/index.ts`, after all `/api/*` routes are mounted and **before** any 404 handler:

```ts
import path from 'path';

// Serve built SPA. In the container, the frontend dist is at /app/public.
const staticPath = process.env.STATIC_DIR ?? path.join(__dirname, '../public');

app.use(express.static(staticPath, {
  maxAge: '1y',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, max-age=0');
    }
  },
}));

// SPA fallback — anything not /api/* serves index.html
app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(staticPath, 'index.html'));
});
```

**Important:** the fallback regex `^\/(?!api).*` must not catch `/api/*` paths. Verify with tests.

### 5.2 🔧 Dockerfile (new, at repo root)

Multi-stage build:

```dockerfile
# Stage 1 — build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /work/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2 — build backend
FROM node:20-alpine AS backend-build
WORKDIR /work/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build
RUN npm prune --omit=dev

# Stage 3 — runtime
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=backend-build /work/backend/dist ./dist
COPY --from=backend-build /work/backend/node_modules ./node_modules
COPY --from=backend-build /work/backend/package.json ./
COPY --from=frontend-build /work/frontend/dist ./public
EXPOSE 3001
USER node
CMD ["node", "dist/index.js"]
```

A second Dockerfile for the worker (with Playwright base image) — `Dockerfile.worker`.

### 5.3 🔐 Remove `utils/crypto.ts` XOR encryption

Replace with Azure Key Vault references. Provide a one-shot migration script that walks all rows with `__ENC__` values, decrypts via the current XOR, writes each value to Key Vault as `tenant-{id}-{field}`, and rewrites the DB column to `@KeyVault:tenant-{id}-{field}`. Application code resolves the reference on read using `@azure/keyvault-secrets` + the workload Managed Identity.

### 5.4 🔧 Replace worker polling with Service Bus

- `backend/src/worker/` polling loop replaced with `@azure/service-bus` message receiver.
- Backend `/api/pipeline-worker/next-task` endpoint becomes Service Bus `enqueue`.
- Worker heartbeat → Service Bus session keepalive or Container Apps Job built-in heartbeat (no app change needed).

### 5.5 🔐 Replace `intelliqe-demo-token-{ts}:{user}` with Entra External ID

- Add `@azure/msal-node` (backend) + `@azure/msal-react` (frontend).
- Backend validates JWT from Entra External ID instead of looking up DB rows by string token.
- `auth.middleware.ts` rewritten to validate JWT, extract tenant claim, attach `req.tenantId` and `req.userId`.
- Migration: existing user records keyed by username remain; we link them by email claim during first Entra login.

### 5.6 🔧 LLM provider abstraction

- `backend/src/agents/claude-runner.ts` reads `LLM_PROVIDER` env (`anthropic` | `azure-ai-foundry`).
- Dev / staging: `anthropic` (direct API, synthetic data only).
- Prod: `azure-ai-foundry` (Managed Identity auth).
- Prompts, tool-use logic, and agent definitions in `.github/agents/` are unchanged.

### 5.7 🏗️ Bicep IaC

Create `/infra` directory:

```
/infra
  /modules
    container-app-environment.bicep
    container-app-unified.bicep      # the intelliqe-app
    container-app-job-worker.bicep   # the intelliqe-worker
    postgres-flex.bicep
    key-vault.bicep
    front-door.bicep
    service-bus.bicep
    storage-account.bicep
    container-registry.bicep
    hub-vnet.bicep
    spoke-vnet.bicep
    azure-firewall.bicep
    private-endpoint.bicep           # generic
    log-analytics.bicep
    app-insights.bicep
    entra-external-id.bicep
  /envs
    /dev/main.bicep
    /staging/main.bicep
    /prod/main.bicep
  /policy
    hipaa-deny-public-access.bicep
    require-private-endpoint.bicep
    require-encryption-at-rest.bicep
    /assignments
```

Use **Azure Verified Modules (AVM)** wherever possible — they encode Microsoft-blessed defaults.

### 5.8 🏗️ CI/CD workflows

`.github/workflows/`:
- `ci.yml` — PR build: lint, type-check, tests, container build (smoke), trivy scan.
- `cd-dev.yml` — on merge to `main`: build, push to ACR, deploy dev revision.
- `cd-staging.yml` — on tag `v*-staging`: promote dev image to staging.
- `cd-prod.yml` — on tag `v*-prod`: promote staging image to prod with **manual approval gate** (GitHub Environment + Entra group reviewers).

OIDC federation to Azure — no stored secrets.

---

## 6. SSE + Multi-Replica Design Note (Important)

This deserves its own section because it's the only architectural trap in the unified-container design.

**The problem:** The current backend uses `services/sse-manager.ts` to hold open SSE connections in memory. A pipeline-run callback from the worker reaches `/api/pipeline-callback`, which then looks up the in-memory map and pushes an event to the connected SSE client.

When the backend runs as 2+ replicas behind a load balancer, the worker's callback may land on a different replica than the one holding the SSE connection. The client receives nothing.

**Three solutions, ordered by complexity:**

### 6.1 Solution S1 — Session affinity (sticky cookie) ✅ **SELECTED for v1**

Container Apps ingress supports session affinity via an `affinity` cookie. The client's SSE connection sticks to the same replica it first hit. The worker's callback is made by the worker → backend over HTTP, and we **route worker callbacks through Service Bus** instead of HTTP, then have each replica subscribe to a Service Bus topic filtered by its own replica ID.

Actually that's getting complex. The simpler v1: the worker reports completion back via Service Bus. Each backend replica subscribes to the topic with a **session filter** matched to the pipeline-run ID. The replica that owns the SSE connection for that pipeline-run also owns the session.

| Pros | Cons |
|---|---|
| ✅ Minimal new infrastructure beyond what Plan B already has | ❌ Replica restart drops SSE clients (they reconnect — acceptable) |
| ✅ Native to Container Apps | ❌ Subtle session-affinity bugs are possible; need integration tests |

### 6.2 Solution S2 — Azure Web PubSub (fan-out)

Backend replicas register SSE clients with Web PubSub. Worker publishes to Web PubSub, which fans the event out to whichever connection holds the client.

| Pros | Cons |
|---|---|
| ✅ Replica-independent; replicas can come and go | ❌ Extra managed service in the path |
| ✅ Scales to tens of thousands of concurrent connections | ❌ Code change to use Web PubSub SDK on both sides |
| ✅ HIPAA-eligible | ❌ More moving parts to audit |

**Verdict:** Future state. Adopt when SSE client count exceeds ~5000 concurrent or replica churn is frequent.

### 6.3 Solution S3 — Drop SSE, use WebSockets via Web PubSub

| Pros | Cons |
|---|---|
| ✅ Most scalable | ❌ Largest code change (client + server) |
| | ❌ Loses HTTP/2 multiplexing advantage of SSE |

**Verdict:** Not now. Revisit only if S1 + S2 prove insufficient.

---

## 7. Cross-Cutting Decisions Inherited from Baseline

These are unchanged from [feature-azure-baseline-002-plans-considered.md §3](feature-azure-baseline-002-plans-considered.md#3-cross-cutting-design-decisions-apply-to-all-plans):

- 3 subscriptions: `intelliqe-dev`, `intelliqe-staging`, `intelliqe-prod`
- Microsoft BAA covering all chosen services
- Entra ID + PIM + Conditional Access for operators
- Managed Identity for all workload-to-Azure auth
- Key Vault Standard with Private Endpoint
- Azure AI Foundry (Claude) for production LLM calls
- Hub-spoke VNet, all data services behind Private Endpoints, no public IPs on data
- Front Door Premium + WAF + DDoS Std
- Application Insights + Log Analytics, 6-year audit archive in immutable Blob
- GitHub Actions + OIDC
- Bicep IaC
- Quarterly DR drills

If any of these need to change, update the baseline doc first, then this doc inherits.

---

## 8. Implementation Phase Plan

### Phase 0 — Azure tenancy & guardrails (Week 1)

| Task | Owner | Output |
|---|---|---|
| Create Azure tenant (if not present) + 3 subscriptions | Owner / IT | Subscription IDs documented |
| Sign Microsoft BAA covering prod subscription | Owner | BAA acknowledgement letter filed |
| Enable Defender for Cloud + HIPAA HITRUST blueprint | Platform | Compliance dashboard baseline captured |
| Stand up Entra Privileged Identity Management for prod owners | Platform | PIM roles configured, break-glass account provisioned |
| Apply baseline Azure Policy — deny public IPs on data tier, require encryption, allowed regions | Platform | Policy assignments visible in subscription |

### Phase 1 — Infrastructure (Weeks 2–3)

| Task | Owner | Output |
|---|---|---|
| `/infra/modules` Bicep modules (AVM-based) | Platform | Reviewed PR |
| `/infra/envs/dev/main.bicep` deploys end-to-end empty stack | Platform | Dev environment alive (no app yet) |
| Front Door + WAF + custom domain + TLS cert | Platform | `dev.intelliqe.example.com` resolves |
| ACR with geo-replication | Platform | Push test image succeeds |
| Hub-spoke VNet + Firewall + Bastion | Platform | Operator can SSH a test VM via Bastion |

### Phase 2 — Code changes for cloud readiness (Weeks 2–4, parallel to Phase 1)

| Task | Owner | Output |
|---|---|---|
| Unified Dockerfile + Express SPA serving | App | `docker run` locally serves both SPA + API on port 3001 |
| Worker Dockerfile with Playwright base | App | Worker container runs a sample pipeline |
| Replace `utils/crypto.ts` with Key Vault references | App | All `__ENC__` values migrated; XOR code deleted |
| Replace worker polling with Service Bus | App | Local Service Bus emulator integration tests pass |
| Replace custom token with Entra External ID | App | Login flow uses MSAL; legacy token code deleted |
| LLM provider abstraction (`anthropic` | `azure-ai-foundry`) | App | Both providers run an end-to-end pipeline in dev |
| Add `/api/health/ready` readiness probe | App | Returns 200 only when DB + KV reachable |
| Session affinity SSE design implemented + tested | App | Replica-restart drops connection; client reconnects within 5s |

### Phase 3 — Dev environment cutover (Week 5)

| Task | Output |
|---|---|
| GitHub Actions OIDC pipeline | PR build → dev deploy works end-to-end |
| First end-to-end pipeline run on dev | Pipeline completes, observable in App Insights |
| Synthetic-data smoke test of all 6 agents | Pass |

### Phase 4 — Staging (Weeks 6–7)

| Task | Output |
|---|---|
| `/infra/envs/staging/main.bicep` deployed | Staging alive |
| Penetration test against staging | Report; findings addressed |
| Load test (50 concurrent pipelines, 200 concurrent users) | Capacity validated |
| DR drill — failover PG, verify RTO | Documented runbook output |

### Phase 5 — Prod cutover (Weeks 8–9)

| Task | Output |
|---|---|
| `/infra/envs/prod/main.bicep` deployed | Prod alive (no traffic) |
| HIPAA pre-flight review (internal) | Sign-off |
| External HIPAA assessor walkthrough | Letter of attestation |
| Customer-1 onboarded with prod credentials | Live |
| 30-day post-go-live monitoring window | Incident-free or remediated |

**Total elapsed:** ~9 weeks (Plan B baseline was 2–3; the larger figure here includes the HIPAA and code-readiness work, much of which is one-time and would be needed under any plan).

---

## 9. HIPAA Compliance Checklist

(Same as Plan A/B baseline. Reproduced here for the auditor.)

- [ ] Microsoft BAA signed and filed
- [ ] All services in Azure HIPAA-eligible list (verified, dated screenshot)
- [ ] Encryption at rest verified on PG, KV, Blob, Service Bus, ACR
- [ ] TLS 1.2+ enforced on Front Door, Container Apps ingress, PG, KV
- [ ] Private Endpoints on PG, KV, Blob, Service Bus, AI Foundry, ACR
- [ ] No public IPs on any data service (Azure Policy enforced)
- [ ] `utils/crypto.ts` XOR removed; Key Vault references migrated
- [ ] Custom token scheme removed; Entra External ID active
- [ ] Operator access through Entra + PIM + Conditional Access + MFA
- [ ] Diagnostic logs to Log Analytics, 6-year archive in immutable Blob
- [ ] Defender for Cloud + HIPAA HITRUST blueprint applied
- [ ] Resource locks on prod resource groups
- [ ] DR drill runbook + quarterly cadence
- [ ] Penetration test report on file
- [ ] Incident-response plan documented (PHI breach notification SLAs)
- [ ] Workforce HIPAA training records retained

---

## 10. Risks & Mitigations

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| SSE breaks under multi-replica without affinity | High | Medium | Solution S1 (session affinity) in §6, with integration tests in CI gating prod deploys |
| Container image size grows large with frontend + backend + transitive deps | Low | High | Multi-stage Dockerfile + `npm prune --omit=dev`; CI gate on image size > 500 MB |
| Claude version drift between Anthropic direct (dev) and Azure AI Foundry (prod) | Medium | Medium | Compatibility tests against both providers in CI for each Claude release we adopt |
| Entra External ID rollout breaks existing user logins | High | Low | Phased migration: link by email on first login; 30-day overlap with old auth during cutover; rehearsed rollback |
| HIPAA scope creep — engineers add a non-BAA-eligible service | Medium | Medium | Azure Policy denial of non-allowlisted resource types in prod subscription |
| Worker exhausts Claude rate limits during a backlog burst | Medium | Medium | Service Bus + Container Apps Jobs max-concurrency cap; Claude API rate-limit-aware backoff in `claude-runner.ts` |
| Frontend deploy needs to ship hotfix faster than backend allows | Low | Low | Hashed-asset Front Door cache invalidation flow documented; emergency-path skip-staging deploy procedure |
| Front Door WAF false-positives block legitimate SSE traffic | Medium | Medium | WAF in **Detection mode** for first 30 days post go-live; tune rules from logs before switching to Prevention |
| PostgreSQL connection storms on replica scale-out | Medium | Medium | PgBouncer sidecar (or Flex Server's built-in connection pooling) in front of PG; tune `max_connections` |
| `db.ts` auto-creates tables on boot — could fight migrations | Medium | High | Replace boot-time table creation with explicit migration tool (e.g. `node-pg-migrate`); fail-fast if schema drift detected |

---

## 11. Open Questions (To Resolve Before Build)

1. **Azure region.** First customer geography? Default candidate: `Central India` primary + `South India` paired for geo-redundant backup. Final answer drives PG region, Front Door origin location, AI Foundry model availability.
2. **Anthropic Claude versions on Azure AI Foundry.** Confirm the specific models used in `claude-runner.ts` (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`) are available on Azure AI Foundry in the chosen region. If lagging, we may need to keep dev on direct Anthropic + accept a model-version lag in prod.
3. **PHI in test inputs.** Will customer-uploaded requirements / test data actually contain PHI, or is it always synthetic? If synthetic only with policy enforcement, HIPAA scope shrinks materially.
4. **Custom domain.** What's the production hostname? Wildcard cert vs SAN cert? Cert ownership (Front Door-managed vs imported)?
5. **Pipeline-run concurrency target.** Expected peak concurrent pipelines? Drives `intelliqe-worker` max-executions cap and PG sizing.
6. **Worker image — Playwright browsers.** Just Chromium, or also Firefox + WebKit? Each adds ~150 MB to the image.
7. **Email volume.** Azure Communication Services Email has tier-based send limits — sizing depends on test-run notification volume.
8. **Customer-tenant data isolation expectation.** Any enterprise contract clauses requiring dedicated databases per tenant? Affects PG strategy.
9. **Session-affinity cookie domain.** Front Door + Container Apps cookie scoping needs to be tested end-to-end before relying on it for SSE.
10. **Bring-your-own-IdP.** Any enterprise customer expecting SAML/OIDC federation into their corporate Entra/Okta? Entra External ID supports this but it must be planned per-tenant.
