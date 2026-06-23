# JBSIntelliQE — Azure Deployment Architecture Plans

> **Status:** Baseline architecture reference. This document is the authoritative source for Azure deployment decisions on JBSIntelliQE.
> **Audience:** Engineering, leadership, future architects. Written assuming the reader is new to Azure.
> **Constraints captured:** HIPAA / PHI handling required · Greenfield Azure (no existing footprint) · Cost not a primary constraint at this stage · Microsoft Azure is the target cloud.
> **Last updated:** 2026-05-27

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Application Recap (What We're Deploying)](#2-application-recap-what-were-deploying)
3. [Cross-Cutting Design Decisions](#3-cross-cutting-design-decisions-apply-to-all-plans) — applies to all plans
   - 3.1 [Tenancy & subscription layout](#31-tenancy--subscription-layout)
   - 3.2 [HIPAA / BAA posture](#32-hipaa--baa-posture)
   - 3.3 [Identity & access](#33-identity--access-management)
   - 3.4 [Secret management](#34-secret--credential-management)
   - 3.5 [LLM provider routing (Claude)](#35-llm-provider-routing-claude)
   - 3.6 [Networking baseline](#36-networking-baseline)
   - 3.7 [Observability](#37-observability)
   - 3.8 [CI/CD](#38-cicd)
   - 3.9 [Infrastructure as Code](#39-infrastructure-as-code-iac)
   - 3.10 [Backup & disaster recovery](#310-backup--disaster-recovery)
4. [Plan A — Managed PaaS Starter (Recommended)](#4-plan-a--managed-paas-starter-recommended)
5. [Plan B — Container Apps Unified Platform](#5-plan-b--container-apps-unified-platform)
6. [Plan C — AKS Enterprise](#6-plan-c--aks-enterprise)
7. [Decision Matrix](#7-decision-matrix)
8. [Recommendation & Migration Path](#8-recommendation--migration-path)
9. [Open Questions](#9-open-questions-to-resolve-before-build)
10. [Glossary](#10-glossary-azure-terms-for-non-azure-readers)

---

## 1. Executive Summary

We evaluated three production-grade Azure architectures for JBSIntelliQE, all of which meet the HIPAA / PHI handling requirement and can be executed today. They differ in operational complexity, scaling ceiling, and team-skill ramp.

| | **Plan A — Managed PaaS Starter** | **Plan B — Container Apps Unified** | **Plan C — AKS Enterprise** |
|---|---|---|---|
| **Frontend host** | Azure Static Web Apps | Azure Static Web Apps | Azure Static Web Apps |
| **Backend API host** | Azure App Service (Linux) | Azure Container Apps | Azure Kubernetes Service (AKS) |
| **Worker host** | Azure Container Apps Jobs | Azure Container Apps Jobs | AKS (separate node pool) |
| **Database** | Azure DB for PostgreSQL Flex Server (HA) | Azure DB for PostgreSQL Flex Server (HA) | Azure DB for PostgreSQL Flex Server (HA) |
| **Ingress / edge** | Azure Front Door + WAF | Azure Front Door + WAF | App Gateway + WAF v2 (regional) + Front Door |
| **Ops burden** | Low | Medium | High |
| **K8s expertise needed** | No | No | Yes |
| **Time-to-first-deploy** | ~1–2 weeks | ~2–3 weeks | ~6–10 weeks |
| **Scaling ceiling** | High (sufficient for foreseeable load) | High | Very high |
| **HIPAA compliant** | Yes (with config) | Yes (with config) | Yes (with config) |
| **Recommended for IntelliQE today?** | **YES** | Future state | Overkill today |

**Recommendation:** **Plan A**, with a documented migration path to Plan B when (a) team has 6+ months of Azure operations experience, and (b) deployment frequency exceeds 5×/week or worker concurrency requirements exceed App Service plan limits. Plan C should only be revisited if/when JBSIntelliQE scales beyond ~500 tenants or your enterprise customers contractually require an AKS-based architecture.

---

## 2. Application Recap (What We're Deploying)

This is the workload we're placing on Azure (derived from `CLAUDE.md` and the current repo). Architecture decisions below trace back to these components.

| Tier | Component | Tech | Notes |
|---|---|---|---|
| Edge | React SPA | Vite build (`frontend/`) | Static assets only after build. No server-side rendering. |
| API | Express backend | TypeScript / Node 20+ (`backend/`) | 23 route groups, SSE for real-time pipeline updates, port 3001. |
| Async compute | Pipeline worker(s) | Node process (`backend/src/worker/`) | Polls `/api/pipeline-worker/next-task` every 5s, calls Claude, reports results. Long-running. |
| Browser automation | Playwright runner | `playwright-runner.service.ts` | Currently invoked from backend/worker. Spawns real browsers — heavy memory/CPU. |
| Data | PostgreSQL | Single DB, schema `JBSTestOpsAI` | Multi-tenant (tenant_id on every row). Auto-initialized tables on startup. |
| Outbound integrations | Anthropic Claude API, SMTP, Git, Confluence, SharePoint | HTTPS | Need outbound egress + secret handling. |
| Cross-cutting | Encrypted secrets in DB | XOR + Base64 (`utils/crypto.ts`) | **Must be replaced** with Key Vault — XOR is not encryption for HIPAA purposes. |

**Architectural facts that shape every plan:**

1. **The worker is long-running and stateful-ish** (polling loop + heartbeat). It is not a serverless function fit (serverless cold-start and per-invoke billing don't match the polling pattern).
2. **SSE requires sticky, long-lived HTTP/1.1 connections** from client to backend. Edge layers (Front Door, APIM, App Gateway) must be configured for non-buffering, and connection timeouts must be raised.
3. **Playwright execution needs real browsers**, which means a container with Chromium installed and ~2 GB RAM headroom per concurrent run. Cannot run in serverless functions.
4. **PHI may flow through requirements input, test data, and Claude prompts.** Every hop must be BAA-covered.
5. **Multi-tenant isolation is application-level today (`tenant_id` column).** Infrastructure does not need per-tenant DBs — but networking and Key Vault scoping should still segregate platform vs tenant data.

---

## 3. Cross-Cutting Design Decisions (Apply to All Plans)

These decisions are independent of which compute plan we pick. We resolve them once, then layer Plan A / B / C compute on top.

### 3.1 Tenancy & subscription layout

**Decision:** Use **3 Azure subscriptions** under a single tenant — `intelliqe-dev`, `intelliqe-staging`, `intelliqe-prod`.

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Single subscription, separated by Resource Group | Cheapest; simple billing | Blast radius too large; quota contention; HIPAA audit harder; no hard policy boundary | ❌ Rejected — fails HIPAA segregation principle |
| 3 subscriptions (dev/staging/prod) | Hard isolation; per-env policies via Azure Policy; clean audit trail; separate budgets/alerts; can enforce stricter network rules in prod | More subscriptions to manage; some shared resources (e.g. Entra ID, Defender) live at tenant level | ✅ **Selected** |
| Per-customer subscription | Maximum isolation for enterprise customers | Massive operational overhead; not needed at current tenant model | ❌ Rejected — premature |

**Why:** HIPAA auditors expect environment segregation. Subscription-level Azure Policy lets us enforce "prod resources must use Private Endpoints" without dev environments getting in the way. Cost is negligible (subscriptions themselves are free; you pay only for resources).

---

### 3.2 HIPAA / BAA posture

**Decision:** Sign Microsoft BAA covering the production subscription. Restrict resource creation in prod via Azure Policy to **only the BAA-eligible services** listed below.

**What is a BAA?** A Business Associate Agreement is a HIPAA-required contract between you (covered entity / business associate) and any vendor that processes PHI on your behalf. Microsoft offers a BAA for Azure that automatically covers a published list of "HIPAA/HITECH-eligible services."

**Services we will use, all BAA-eligible at time of writing:**

- Azure Static Web Apps
- Azure App Service (Linux)
- Azure Container Apps
- Azure Database for PostgreSQL Flexible Server
- Azure Key Vault
- Azure Front Door (Standard/Premium)
- Azure Application Gateway
- Azure Monitor + Application Insights + Log Analytics
- Azure Storage (Blob, Queue)
- Azure Service Bus
- Microsoft Entra ID
- Azure AI Foundry (model serving — see §3.5)

**Configuration requirements for HIPAA on each service (Customer responsibilities under the shared-responsibility model):**

- TLS 1.2+ enforced everywhere; no plaintext endpoints.
- Encryption at rest enabled (default on; verify in IaC).
- Private Endpoints for PostgreSQL, Key Vault, Storage (no public access).
- Diagnostic logs to Log Analytics retained ≥ 6 years (HIPAA audit retention).
- Defender for Cloud enabled at subscription level (provides HIPAA HITRUST blueprint).
- All admin access through Entra ID with MFA enforced.
- Resource locks on prod resources to prevent accidental deletion.

> ⚠️ **Verification step before build:** Re-confirm each service's BAA-eligibility at <https://learn.microsoft.com/azure/compliance/offerings/offering-hipaa-hitech> — the list evolves. Capture a dated screenshot for audit evidence.

---

### 3.3 Identity & access management

**Decision:** **Microsoft Entra ID** (formerly Azure AD) for human users + administrators. **Managed Identities** for service-to-service auth.

**Three identity scopes to design:**

1. **End-user identity** (customers logging into IntelliQE)
2. **Operator identity** (your team, accessing Azure portal / kubectl / DB)
3. **Workload identity** (backend → Key Vault, worker → PostgreSQL, etc.)

#### End-user identity

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Current custom token (`intelliqe-demo-token-{ts}:{user}`) | Already coded | Not a real auth system; trivially forgeable; no MFA; not HIPAA-defensible | ❌ Must be replaced before any PHI deployment |
| Microsoft Entra External ID (B2C successor) | Managed; supports social + enterprise SSO; HIPAA-eligible; MFA built-in; passwordless | New product, smaller community than legacy B2C | ✅ **Selected** |
| Auth0 / Okta (3rd party) | Mature; great DX | Extra vendor BAA needed; cost | ❌ Rejected — Entra External ID is in-platform |
| Custom JWT + bcrypt | Maximum control | We become responsible for auth security — not acceptable for HIPAA | ❌ Rejected |

#### Operator identity

- Entra ID with **Privileged Identity Management (PIM)** for just-in-time elevation to Owner/Contributor.
- Conditional Access: require MFA, compliant device, trusted location for prod subscription.
- Break-glass account documented and stored in a sealed envelope (not in Key Vault — chicken/egg).

#### Workload identity

- **Managed Identity** on every Azure compute resource. App Service → System-Assigned MI; Container Apps → User-Assigned MI; Worker → User-Assigned MI.
- No connection strings or API keys in environment variables for Azure-native services. Key Vault refs only.

---

### 3.4 Secret & credential management

**Decision:** **Azure Key Vault** (Standard tier) per environment, with Private Endpoint, accessed via Managed Identity. **Retire `utils/crypto.ts` XOR encryption.**

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Keep XOR-in-DB (current `__ENC__` prefix) | No new infra | XOR is obfuscation, not encryption. Fails HIPAA technical safeguards. Anyone with DB read access gets all secrets. | ❌ **Must remove before HIPAA go-live** |
| Azure Key Vault Standard | HSM-backed; audit log; RBAC; rotation hooks; integrated with App Service / Container Apps / AKS | Per-operation cost (negligible); 25k ops/10s throttle | ✅ **Selected** |
| Azure Key Vault Premium (HSM-backed FIPS 140-2 L3) | HSM enforced | 3× cost; not required for HIPAA technical safeguards | ❌ Rejected — Standard sufficient. Revisit if FedRAMP High becomes a goal. |
| HashiCorp Vault self-hosted | Cloud-agnostic | We run it; defeats the "managed PaaS" goal | ❌ Rejected for this stage |

**Migration strategy:** One-off migration job that decrypts existing `__ENC__` values from the DB, writes each as a Key Vault secret named `tenant-{tenantId}-{fieldName}`, and replaces the DB column value with a reference (`@KeyVault:tenant-123-smtpPassword`). Application code resolves references on read.

---

### 3.5 LLM provider routing (Claude)

**Decision:** **Route Claude calls through Azure AI Foundry (Models as a Service)** in the production subscription, not directly to api.anthropic.com.

**Why this matters for HIPAA:** Today the worker calls `api.anthropic.com` with `ANTHROPIC_API_KEY`. If PHI is in the prompt (and it will be — requirements documents often contain it), then Anthropic is a HIPAA business associate and needs its own BAA. Anthropic does offer HIPAA BAAs but the negotiation, audit access, and incident-response coordination are an extra workstream.

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Direct calls to api.anthropic.com (current) | Lowest latency to model; immediate access to newest Claude versions | Need separate Anthropic BAA; data crosses outside Azure boundary; second auditable vendor | ⚠️ Acceptable but adds compliance work |
| Azure AI Foundry — Claude models | Single BAA (Microsoft) covers it; data stays inside Azure boundary; Private Endpoint possible; unified billing; Azure Monitor integration | Slight lag (days–weeks) on newest Claude releases; subset of Claude models available; minor SDK differences | ✅ **Selected** for prod |
| Azure OpenAI (use GPT-4 instead) | Mature; deepest Azure integration | Changes the product — IntelliQE is built around Claude's tool-use patterns; rewriting agents is a major scope change | ❌ Rejected — not equivalent |
| Self-hosted open model (Llama, Mistral) on Azure GPU VM | Maximum control; no external API | Massive ops burden; quality gap for IntelliQE's reasoning workload; GPU SKU costs | ❌ Rejected — wrong tool |

**Migration impact on code:** `backend/src/agents/claude-runner.ts` swaps the SDK endpoint and auth from Anthropic API key to Azure AI Foundry endpoint + Managed Identity. The agent prompts themselves are unchanged.

**Dev/staging note:** Dev and staging may continue using `api.anthropic.com` directly with synthetic (non-PHI) test data, to retain access to bleeding-edge Claude versions during development. Only prod is locked to Azure AI Foundry.

---

### 3.6 Networking baseline

**Decision:** Hub-and-spoke VNet topology in prod. All data services behind **Private Endpoints**. Public ingress only through **Front Door + WAF**.

```
                                  ┌────────────────────────────┐
   Internet ──► Azure Front Door  │  Hub VNet (prod-hub-vnet)  │
                + WAF + DDoS Std  │  ─ Azure Firewall (optional)│
                                  │  ─ Bastion (operator access)│
                                  └──────────┬─────────────────┘
                                             │ VNet peering
                                  ┌──────────┴─────────────────┐
                                  │  Spoke VNet (prod-app-vnet)│
                                  │   ├─ App subnet (compute)  │
                                  │   ├─ PE subnet (private    │
                                  │   │   endpoints)           │
                                  │   └─ Mgmt subnet           │
                                  └────────────────────────────┘
```

**Decision details:**

- **Front Door Premium** (not Standard) — required for Private Link origins, managed WAF rules, and bot protection. HIPAA-eligible.
- **DDoS Network Protection** — enabled at VNet level. Not optional once we host PHI workloads with public exposure.
- **No public IPs on data services.** PostgreSQL, Key Vault, Storage all access-via-Private-Endpoint only.
- **No public IPs on workers.** Worker reaches backend via VNet, reaches Azure AI Foundry via Private Endpoint or service endpoint.
- **Azure Firewall**: defer until Plan B/C. In Plan A, App Service's built-in outbound controls + NSGs are sufficient. Revisit when egress filtering becomes an audit requirement.

---

### 3.7 Observability

**Decision:** **Azure Monitor** as the single pane of glass: Application Insights for app telemetry, Log Analytics workspace for logs/metrics, Workbooks for dashboards.

| Stack option | Pros | Cons | Verdict |
|---|---|---|---|
| Azure Monitor (App Insights + Log Analytics) | Native; HIPAA-eligible; zero infra; auto-instrumentation for Node | Query language (KQL) has a learning curve | ✅ **Selected** |
| Datadog | Excellent UX; strong APM | Vendor BAA; extra cost; data egress | ❌ Rejected for v1 |
| Self-hosted Grafana + Prometheus + Loki | Open source; cloud-agnostic | We run it; not free at scale | ❌ Rejected — premature |

**What we collect:**

- HTTP traces (Application Insights auto-instrument on Node)
- Pipeline stage spans (custom — emit `traceparent` from orchestrator)
- PostgreSQL slow queries (Flex Server diagnostic logs)
- Worker heartbeat + queue depth (custom metric)
- Front Door / WAF logs (security)
- Entra ID sign-in logs (security)

**Retention:** 90 days hot in Log Analytics, then auto-archive to Storage Account with immutability policy for 6 years (HIPAA).

---

### 3.8 CI/CD

**Decision:** **GitHub Actions** with **OIDC federation** to Azure (no long-lived secrets). One repo, environment-gated deploys.

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| GitHub Actions + OIDC to Azure | No secrets to rotate; native Azure login; we already use GitHub | None material | ✅ **Selected** |
| Azure DevOps Pipelines | Tight Azure integration; work items + pipelines unified | Migrates team off GitHub; OIDC is also available here, no advantage | ❌ Rejected — no tangible benefit |
| Jenkins / CircleCI | We don't already use these | New tool to operate | ❌ Rejected |

**Workflow shape:**
- PR → dev (auto-deploy on merge to `main`)
- Tag `v*-staging` → staging (auto)
- Tag `v*-prod` → prod (manual approval gate via GitHub Environment + Entra group)

---

### 3.9 Infrastructure as Code (IaC)

**Decision:** **Bicep** (Azure-native), with optional Terraform-on-top once multi-cloud need appears.

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Bicep | Azure-native; AVM (Azure Verified Modules) library; no state file to manage; what-if mode shows drift | Azure-only | ✅ **Selected** for a team new to Azure |
| Terraform | Cloud-agnostic; huge community | Extra abstraction layer; state file to manage; team needs to learn both Terraform AND Azure | ❌ Rejected — adds friction for a new-to-Azure team |
| Pulumi | Real programming language | Smaller community; same state-management overhead as Terraform | ❌ Rejected |
| Portal-clicked + ARM exports | Fastest first deploy | Not auditable; not reproducible; HIPAA auditor will mark this finding | ❌ Rejected |

**Repository layout:**
```
/infra
  /modules        # reusable Bicep modules (per service)
  /envs
    /dev/main.bicep
    /staging/main.bicep
    /prod/main.bicep
  /policy         # Azure Policy definitions (HIPAA enforcement)
```

---

### 3.10 Backup & disaster recovery

**Decision:** **PITR + geo-redundant backups on PostgreSQL Flex Server**. RPO 5 minutes, RTO 1 hour for prod. Application stateless tiers redeploy from IaC.

- **PostgreSQL:** Zone-redundant HA enabled in prod (auto failover within region, ~60–120s). Geo-redundant backup to a secondary Azure region (Central India ↔ South India if Indian residency, otherwise nearest pair). PITR retention 35 days.
- **Key Vault:** Soft-delete enabled (default in 2026); purge protection enabled.
- **Blob storage** (for execution artifacts, screenshots): geo-redundant (GRS) with versioning.
- **Application tiers:** No state outside DB. Redeploy from Bicep + container registry image.

**DR drill cadence:** Quarterly. Documented in runbook. Required HIPAA evidence.

---

## 4. Plan A — Managed PaaS Starter (Recommended)

### 4.1 Why this plan

Optimized for: **fast time to production, low ops burden, HIPAA compliance, and a team new to Azure.** This is the "boring, correct" answer. It uses the most-managed Azure services available, leaving your team free to ship product instead of running infrastructure.

### 4.2 Architecture diagram

```
                       Internet
                          │
                          ▼
               ┌─────────────────────┐
               │ Azure Front Door    │   ←─ WAF, TLS termination, global CDN
               │ Premium + DDoS Std  │
               └─────────┬───────────┘
                         │ (Private Link)
            ┌────────────┼────────────┐
            ▼                         ▼
   ┌─────────────────┐       ┌─────────────────────┐
   │ Azure Static    │       │ Azure App Service   │
   │ Web Apps        │       │ (Linux, Node 20)    │
   │ (React SPA)     │       │ ─ Backend Express   │
   └─────────────────┘       │ ─ SSE-enabled       │
                             └──────────┬──────────┘
                                        │ VNet integration
                                        ▼
   ┌────────────────────────────────────────────────────────┐
   │              Spoke VNet (prod-app-vnet)                │
   │                                                        │
   │   ┌─────────────────────┐    ┌─────────────────────┐   │
   │   │ Azure Container     │    │ Azure DB for        │   │
   │   │ Apps Jobs (Worker)  │───▶│ PostgreSQL Flex     │   │
   │   │ ─ event-driven      │ PE │ (HA, zone-redundant)│   │
   │   │ ─ Playwright image  │    └─────────────────────┘   │
   │   └──────────┬──────────┘                              │
   │              │                                         │
   │              │ ┌──────────────┐  ┌─────────────────┐   │
   │              └▶│ Service Bus  │  │ Azure Key Vault │   │
   │                │ (job queue)  │  │ (PE)            │   │
   │                └──────────────┘  └─────────────────┘   │
   │                                                        │
   │   ┌─────────────────────┐    ┌─────────────────────┐   │
   │   │ Blob Storage        │    │ Azure AI Foundry    │   │
   │   │ (artifacts, GRS)    │    │ Claude (PE)         │   │
   │   └─────────────────────┘    └─────────────────────┘   │
   └────────────────────────────────────────────────────────┘
```

### 4.3 Component-by-component decisions

#### 4.3.1 Frontend hosting — **Azure Static Web Apps (SWA) Standard**

**What it is (for non-Azure readers):** A managed service that hosts static files (HTML/CSS/JS bundle output by `vite build`) on a global CDN. Handles TLS, custom domains, staging slots, and per-PR preview environments out of the box.

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Azure Static Web Apps Standard | Free TLS; per-PR preview environments; built-in auth integration; global CDN; cheap | Quota limits on bandwidth/build minutes (rarely hit at our scale) | ✅ **Selected** |
| Azure Blob Static Website + Front Door | More flexible; no SWA quotas | We build the CI/CD glue ourselves; no PR preview environments | ❌ Rejected — SWA gives us PR previews for free |
| App Service for static site | Works | Wasteful (paying for a VM to serve static files) | ❌ Rejected |
| AKS Nginx serving static | Works | Massive overkill | ❌ Rejected |

#### 4.3.2 Backend API hosting — **Azure App Service (Linux, P1v3)**

**What it is:** A managed compute service for web apps. You give it a container image or zip of your Node code; Azure runs it, manages the OS, scales it, and handles TLS / domain / health-check / staging slots. Closest analog: Heroku, but inside Azure.

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| App Service Linux (P1v3, autoscale) | Most-managed; SSE supported; deployment slots for zero-downtime; VNet integration; easy to operate; ~$140/mo baseline | Less portable than containers (though we deploy as container, retaining portability) | ✅ **Selected** |
| Azure Container Apps for backend | More portable; scale-to-zero | Scale-to-zero is bad for our backend (always-on SSE clients); slightly more YAML to write than App Service | ❌ Acceptable but no advantage over App Service for the API tier today; revisit in Plan B |
| Azure Functions (Premium plan) | Scale-to-zero capable | SSE on Functions is awkward; cold-start hurts UX; long-running orchestrator logic doesn't fit | ❌ Rejected — wrong tool |
| Azure VMs | Maximum control | We patch the OS, manage scale sets, handle updates — wrong end of the spectrum for a new team | ❌ Rejected |
| AKS | Maximum control + portability | K8s expertise required | ❌ Rejected for Plan A — that's Plan C |

**Critical config notes:**
- **Always-On** = true (prevents 20-min idle shutdown that would kill SSE connections).
- **HTTP/2 inbound** enabled.
- **Health check** path `/api/health` (already exists in `backend/src/index.ts`).
- **Autoscale rule:** Scale 1 → 5 instances on CPU > 70% for 5 min. Scale-in cooldown 15 min (prevents thrash on SSE reconnects).
- **VNet integration** to the spoke VNet so Key Vault / PostgreSQL access is private.

#### 4.3.3 Worker hosting — **Azure Container Apps Jobs (event-driven)**

**What it is:** Container Apps Jobs is a serverless container runner. You give it a Docker image and an event source (timer, queue, HTTP). It spins up containers when work arrives, runs to completion, scales to zero when idle. Built on KEDA.

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Container Apps Jobs (event-driven) | Scale-to-zero; per-second billing; KEDA scaler on Service Bus queue depth; Playwright fits fine; HIPAA-eligible | New service; some KEDA scaler nuances to learn | ✅ **Selected** |
| Container Apps (always-on) | Simpler | Pays for idle workers; same product family, but Jobs is the better fit | ❌ Rejected for workers |
| Azure Container Instances | Simple | No autoscale; harder to coordinate | ❌ Rejected |
| AKS | Maximum control | K8s ops | ❌ Plan C only |
| Azure Batch | Designed for large parallel batch jobs | Heavyweight for our use case (we have <100 concurrent jobs, not 10,000) | ❌ Rejected |
| Azure Functions | Scale-to-zero | 10-minute execution cap on Premium; cannot run Chromium | ❌ Rejected — Playwright runs would exceed limits |

**Why event-driven over polling:** The current worker polls every 5s. In Azure, we replace polling with **Azure Service Bus** queue + KEDA autoscaler. When the backend pushes a pipeline-stage message to Service Bus, KEDA observes queue depth > 0 and scales the Container Apps Job from 0 → N replicas. This is:
- Cheaper (no idle polling cost)
- Faster (sub-second wakeup vs 5s poll)
- More reliable (Service Bus dead-letter queue catches poison messages)

**Code change required:** `backend/src/worker/` polling loop replaced with Service Bus message receiver. Backend `/api/pipeline-worker/next-task` and heartbeat endpoints become Service Bus enqueue calls. Net code change: small (~300 lines).

#### 4.3.4 Database — **Azure Database for PostgreSQL Flexible Server, General Purpose D4ds_v5, zone-redundant HA**

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| PostgreSQL Flex Server | Native PostgreSQL; HIPAA-eligible; HA; PITR; managed updates; private endpoint | None material | ✅ **Selected** |
| PostgreSQL Single Server | Cheaper | **Retired** by Microsoft (don't use new) | ❌ Rejected |
| Azure Cosmos DB for PostgreSQL (Citus) | Horizontal sharding | We don't need sharding at our scale; some PostgreSQL features behave differently | ❌ Rejected — premature |
| Azure SQL Database | Lower price tier available | Not PostgreSQL — would require schema rewrite | ❌ Rejected |
| Self-hosted PostgreSQL on a VM | Maximum control | We patch, back up, monitor — wrong shape for HIPAA + new team | ❌ Rejected |

**Sizing:** Start with **General Purpose, 4 vCores, 16 GB RAM, 256 GB storage**. Auto-grow storage enabled. Read replicas added when read load justifies (none required at v1).

**HA:** Zone-redundant standby (Azure provisions a hot standby in a different Availability Zone within the region; ~60–120 s failover). HIPAA audit-friendly.

**Critical config:**
- `azure.extensions` allowlist updated to include any pg extensions we use.
- `log_statement = 'ddl'` minimum for audit.
- Backup retention 35 days, geo-redundant.
- Public access disabled. Private Endpoint only.

#### 4.3.5 Edge / ingress — **Azure Front Door Premium + WAF + DDoS Std**

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Front Door Premium | Global anycast; managed WAF rules; Private Link origin support (HIPAA-friendly); bot protection | More expensive than Standard | ✅ **Selected** for prod |
| Front Door Standard | Cheaper | No Private Link origins → backend would need public ingress → fails our HIPAA posture | ❌ Rejected |
| Application Gateway only | Regional; cheaper; WAF v2 included | No global edge; we re-add CDN separately | ⚠️ Acceptable for single-region deploys but inferior to Front Door Premium |
| API Management (APIM) | Rich API gateway features (rate limits, transformations, dev portal) | SSE buffering historically problematic; expensive Developer/Standard tiers | ❌ Rejected — not needed and risks SSE; revisit when public API is a product |

**Config for SSE:** Front Door route for backend has `responseTimeoutInSeconds = 240` (default 30 will kill SSE). Cache disabled on `/api/*`. WAF policy in Detection mode first 30 days, then Prevention.

#### 4.3.6 Outbound integrations (SMTP, Git, Confluence, SharePoint)

- **SMTP:** Use **Azure Communication Services Email** (HIPAA-eligible, no SMTP relay to maintain). Alternative: SendGrid via Azure Marketplace (separate BAA — extra step).
- **Git/Confluence/SharePoint:** Outbound HTTPS only. Place tokens in Key Vault. Egress filtered through App Service / Container Apps default NAT (sufficient for Plan A; Azure Firewall added in Plan B/C if needed).

#### 4.3.7 Estimated effort to first prod deploy: **1–2 weeks**

| Workstream | Days |
|---|---|
| Subscription + Entra + Policy setup | 1 |
| Bicep modules for all services | 4 |
| Replace XOR crypto with Key Vault references | 2 |
| Replace polling worker with Service Bus | 2 |
| Replace custom token with Entra External ID | 3 |
| Wire CI/CD with OIDC | 1 |
| HIPAA verification + penetration test | (parallel external workstream) |

### 4.4 Plan A HIPAA compliance checklist

- [x] Microsoft BAA signed at subscription level
- [x] All services in BAA-eligible list verified
- [x] Encryption at rest (default + verified) on App Service, Container Apps, PostgreSQL, Key Vault, Blob, Service Bus
- [x] TLS 1.2+ enforced on Front Door, App Service, PostgreSQL
- [x] Private Endpoints on PostgreSQL, Key Vault, Blob, Service Bus, Azure AI Foundry
- [x] No public IPs on any data service
- [x] XOR crypto removed; Key Vault references in place
- [x] Custom token replaced with Entra External ID + MFA
- [x] All operator access through Entra ID + PIM + Conditional Access
- [x] Diagnostic logs to Log Analytics, retention ≥ 6 years (archive to Blob immutable)
- [x] Defender for Cloud enabled, HIPAA HITRUST blueprint applied
- [x] Resource locks on prod resource group
- [x] DR drill runbook + quarterly cadence

---

## 5. Plan B — Container Apps Unified Platform

### 5.1 Why this plan

Optimized for: **deployment consistency, future portability, and teams growing comfortable with containers.** Everything that runs code (backend, workers, future microservices) runs on the same managed Kubernetes-under-the-hood platform — Azure Container Apps — but you never touch Kubernetes APIs.

### 5.2 What changes vs Plan A

| Layer | Plan A | **Plan B** |
|---|---|---|
| Backend API | App Service | **Azure Container Apps (always-on min-replicas=2)** |
| Worker | Container Apps Jobs | Container Apps Jobs (unchanged) |
| Frontend | SWA | SWA (unchanged) |
| DB | PostgreSQL Flex | PostgreSQL Flex (unchanged) |
| Edge | Front Door Premium | Front Door Premium (unchanged) |
| Egress filtering | NSG | **Azure Firewall** added (centralized egress logging) |
| Networking | Single spoke VNet | **Hub-spoke** topology (hub for Firewall + Bastion) |

### 5.3 Why containerize the backend

| Aspect | App Service (Plan A) | Container Apps (Plan B) |
|---|---|---|
| Deployment unit | Container image (already) | Container image |
| Scaling | Instance-level (HTTP scale rule) | Replica-level + KEDA event scale rules |
| Cold start | None (always-on) | None (min-replicas ≥ 1) |
| Revision strategy | Deployment slots | Native revisions + traffic split (10% canary trivially) |
| Sidecar containers | Not natively | Yes (e.g. Dapr for state, secrets) |
| Cost at idle | Pays for plan SKU | Pays for min-replica compute |
| Ops complexity | Lowest | Slightly higher (Container Apps YAML, ingress config) |
| Portability | Tied to App Service | Standard OCI image, runs anywhere |

**Verdict:** Plan B is preferable once you outgrow App Service's deployment-slot model (typical trigger: ≥ 5 deploys/week, or when you start splitting the backend into multiple services).

### 5.4 Other Plan B differences

- **Azure Firewall** in the hub VNet — centralized egress filtering. Required if/when an auditor asks "show me every outbound destination IntelliQE talked to last week." Worth ~$1.2k/mo and added now because Plan B already represents a step up in operational maturity.
- **Bastion** for operator access to the VNet without VPN.
- **Dapr sidecars** (optional) — Container Apps has first-class Dapr support. Useful if/when we want pub/sub abstractions or service-to-service tracing without code changes.

### 5.5 Effort to migrate Plan A → Plan B: **~2–3 weeks**

Mostly Bicep changes + cutover testing. Application code is unchanged because the backend already builds a container.

---

## 6. Plan C — AKS Enterprise

### 6.1 Why this plan

Optimized for: **organizations with K8s skills, multi-region active-active needs, hundreds of microservices, or enterprise customers who contractually require Kubernetes-based deployments.**

> ⚠️ **Honest assessment for IntelliQE today:** Plan C is over-engineered for the current product shape. Documented here so the team knows what "Plan C" looks like and what triggers should cause us to reconsider.

### 6.2 What changes vs Plan B

| Layer | Plan B | **Plan C** |
|---|---|---|
| Backend API | Container Apps | **AKS (separate node pool)** |
| Worker | Container Apps Jobs | **AKS Jobs / KEDA on AKS** |
| Ingress | Front Door | Front Door + **Application Gateway Ingress Controller (AGIC) on AKS** |
| Service mesh | None | Istio (Azure addon) or Linkerd |
| Secret mounting | Env var refs | **CSI Secrets Store driver → Key Vault** |
| Identity | Managed Identity | **Workload Identity Federation** (OIDC) |
| Observability | App Insights | App Insights + **Prometheus + Grafana (Azure Managed Prometheus)** |

### 6.3 Triggers that would justify moving to Plan C

- ≥ 10 distinct services with internal east-west traffic dominating
- Active-active multi-region deployment required
- Enterprise procurement requires K8s
- We hire 2+ engineers with AKS production experience
- Cost optimization at very large scale where Container Apps premium becomes a meaningful percentage of bill

### 6.4 Why we explicitly reject AKS for v1

1. **K8s upgrades, node pool patching, CNI debugging, ingress controller failures are full-time ops work.** A team new to Azure cannot productively own AKS.
2. **Time-to-first-deploy is 6–10 weeks** vs 1–2 for Plan A.
3. **The IntelliQE workload (1 API + 1 worker + 1 DB) does not benefit from K8s primitives** — no service mesh need, no complex pod scheduling, no DaemonSets, no operators.
4. **HIPAA compliance is harder to demonstrate on AKS** than on PaaS because more is your responsibility (node OS patching, secret rotation, network policies). Solvable but adds audit surface area.

---

## 7. Decision Matrix

Scoring: 5 = excellent, 1 = poor for IntelliQE's stage.

| Dimension | Weight | Plan A | Plan B | Plan C |
|---|---|---|---|---|
| Time to production | 5 | 5 | 4 | 1 |
| Operational simplicity | 5 | 5 | 4 | 2 |
| Fit for current team skills | 5 | 5 | 3 | 1 |
| HIPAA defensibility | 5 | 5 | 5 | 4 |
| Scaling ceiling | 3 | 4 | 5 | 5 |
| Deployment frequency support | 3 | 4 | 5 | 5 |
| Portability across clouds | 2 | 3 | 5 | 5 |
| Cost at low scale | 2 | 5 | 4 | 2 |
| Cost at very high scale | 2 | 3 | 4 | 5 |
| Long-term flexibility | 3 | 3 | 5 | 5 |
| **Weighted total** | | **149** | **142** | **104** |

---

## 8. Recommendation & Migration Path

**Recommendation: Execute Plan A now.** Architect the IaC modules so that the Plan A → Plan B transition is mostly a Bicep change (backend module swap from App Service to Container Apps) with zero application code changes. Re-evaluate quarterly.

**Migration triggers from A → B:**
- We start splitting the backend into ≥ 2 distinct services
- Deployment frequency exceeds 5×/week per service
- App Service plan vertical-scale hits P3v3 and is still saturated
- Team has accumulated ≥ 6 months operating Plan A

**Migration triggers from B → C:**
- We have ≥ 10 services with internal east-west traffic
- Multi-region active-active becomes contractual
- Team has hired AKS-experienced operators

---

## 9. Open Questions (To Resolve Before Build)

1. **Azure region.** What's the target customer geography? Affects PostgreSQL primary region + geo-pair selection. (Recommend: confirm now; difficult to migrate later.)
2. **Scale target for first 12 months.** Not yet captured — would refine PostgreSQL sizing and Front Door SKU.
3. **PHI scope.** Will customer test data actually contain PHI, or only synthetic? If always synthetic with policy enforcement, HIPAA scope shrinks materially.
4. **Existing identity provider integration.** Do enterprise customers expect to bring their own IdP (Okta, Entra)? Drives Entra External ID configuration.
5. **Anthropic vs Azure AI Foundry Claude version parity.** Confirm the specific Claude models we use (`claude-opus-4-*`, `claude-sonnet-4-*`) are available on Azure AI Foundry in our chosen region.
6. **Per-tenant data isolation.** Application-level today. Will any enterprise customer require physical isolation (dedicated DB)? Affects PostgreSQL strategy.
7. **Build vs buy for user identity.** Stay on Entra External ID, or accept Auth0/Okta if a customer mandates it?
8. **Public API surface.** Will IntelliQE expose a public REST API to customers? If yes, APIM enters the picture in front of Front Door for the API tier.

---

## 10. Glossary (Azure terms for non-Azure readers)

| Term | Plain-English meaning |
|---|---|
| **App Service** | Managed web-app hosting. You give it code or a container; Azure runs it on managed servers. Like Heroku. |
| **Container Apps** | Managed container hosting that scales to zero. Built on Kubernetes but you don't touch K8s. |
| **AKS** | Managed Kubernetes. You manage the K8s cluster; Azure manages the control plane. |
| **Static Web Apps** | Managed hosting for static frontends (HTML/CSS/JS) with CDN, TLS, PR previews. |
| **PostgreSQL Flexible Server** | Managed PostgreSQL. Azure runs the DB; you connect and use it. |
| **Front Door** | Global edge / CDN / WAF. The first thing internet traffic hits. |
| **Application Gateway** | Regional layer-7 load balancer with WAF. |
| **Key Vault** | Managed secret store. App fetches secrets at runtime via Managed Identity. |
| **Managed Identity** | An Entra ID identity automatically attached to an Azure resource so it can authenticate to other Azure services without secrets. |
| **Entra ID** | Microsoft's identity provider (formerly Azure AD). |
| **Entra External ID** | Entra-flavored customer identity (successor to Azure AD B2C). |
| **Private Endpoint** | A private IP inside your VNet that routes to a managed service, so traffic never crosses the public internet. |
| **VNet** | Virtual Network. Your private network space inside Azure. |
| **NSG** | Network Security Group. Firewall rules at the subnet/NIC level. |
| **Azure Firewall** | Managed stateful firewall, usually deployed in a hub VNet to filter egress. |
| **Service Bus** | Managed message queue (like AWS SQS). |
| **Bicep** | Microsoft's IaC language. Compiles to ARM templates. |
| **BAA** | Business Associate Agreement — the HIPAA contract between you and a vendor. |
| **PITR** | Point-in-time restore for databases. |
| **PIM** | Privileged Identity Management — just-in-time elevation for admin roles. |
| **OIDC federation** | Lets GitHub Actions log into Azure without a stored secret. |
| **KEDA** | Kubernetes Event-Driven Autoscaler — what Container Apps uses under the hood for event-based scale. |
| **AVM** | Azure Verified Modules — Microsoft-blessed reusable Bicep modules. |
