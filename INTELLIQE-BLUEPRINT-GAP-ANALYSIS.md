# IntelliQE — Blueprint Gap Analysis

**Shipped codebase vs. [`INTELLIQE-PRODUCT-BLUEPRINT.md`](INTELLIQE-PRODUCT-BLUEPRINT.md)**

> Date: 2026-11-10
> Scope: `backend/src/`, `frontend/src/`, `backend/config/`, `.github/agents/`
> Method: static inventory of agents, orchestrator, routes, services, pages and nav, cross-referenced against the 16-section blueprint.

---

## Executive summary

The product is **strongly aligned with the blueprint and in most areas exceeds it.** The core vision `Import → Understand → Generate → Execute → Heal → Report` is fully implemented end to end, **13 of 15 modules are present**, and the platform ships major capabilities the blueprint never specified (Web Lab, OWASP/security testing, SCIM/SSO, service virtualization, multi-protocol, FinOps governance, status pages).

The divergences fall into three buckets:

1. **Deliberate engineering choices** (stack): Express instead of NestJS, Azure SQL instead of PostgreSQL, worker-polling instead of BullMQ/Redis — all documented in `CLAUDE.md`. These do not break blueprint intent.
2. **True feature gaps**: Jenkins connector, commercial billing, Projects/Teams concept, standalone RCA screen.
3. **Reliability debt in orchestration**: three of four convergence guards declared but not enforced; `artifact-validator` is a stub.

| Dimension | Verdict |
|---|---|
| Core flow / orchestration | ✅ Fully aligned (two engines), exceeds doc |
| Modules (15) | ✅ 13 present, 2 partial |
| AI agents (12) | ✅ Present (mix of agents + services) |
| Tech stack | 🟡 Deliberate divergences |
| UI information architecture | 🟡 Reorganized flat; a few screens absent |
| Overall product scope | ✅ **Exceeds blueprint** |

---

## 1. Orchestration flow — ✅ Aligned

The blueprint's agentic workflow is real, implemented as **two coexisting engines** (neither uses LangGraph — the blueprint permitted "LangGraph *or* custom state-machine"; custom was chosen):

| Engine | Pattern | Location |
|---|---|---|
| In-process pipeline | Hand-coded **sequential** agent chain: explore → requirement → [audit ‖ planner] → generator → script → execution → heal → re-execute | `backend/src/agents/pipeline.ts`, `state.ts` |
| Worker / DB pipeline | Config-driven **finite state machine** with SSE, per-tenant definitions, approval gates | `backend/src/orchestrator/`, `backend/src/worker/`, `backend/config/pipeline-definition.json` |

**Matches** the blueprint's critical principle: *AI plans/generates, a deterministic engine executes in isolated workers.*

### ⚠️ Gap 1 — Convergence guards declared but not enforced

`backend/config/pipeline-definition.json` declares four convergence guards; only one is wired in code.

| Guard | Declared | Enforced in `orchestrator.ts` |
|---|---|---|
| `maxIterations` (limit 3) | ✅ | ✅ |
| `budgetCap` / `budgetPerRunUsd` | ✅ | ❌ (cost tracked, no cut-off) |
| `sameFindings` | ✅ | ❌ |
| `notDecreasing` | ✅ | ❌ |

Additionally, `backend/src/orchestrator/artifact-validator.ts` → `validateUpstreamArtifacts()` is a **stub that always returns `{ valid: true }`**.

**Blueprint reference:** §4 ("require approval for destructive operations"), §10 ("validate generated tests before execution"), §12 (budget/convergence as acceptance rails).
**Impact:** the `generation.fail → healing`, `audit.fail → healing`, `healing.fail → healing` loop is only bounded by iteration count, not by cost or by "no progress" detection. A run can burn budget making no improvement until it hits the iteration cap.
**Recommendation:** enforce `budgetCap` and `sameFindings`/`notDecreasing` in `processStageCompletion`; replace the artifact-validator stub with real upstream-artifact checks.

---

## 2. The 15 modules

| # | Module | Status | Evidence |
|---|---|---|---|
| 1 | User Management | ✅ Present | login/signup (bcrypt, JWT, MFA/TOTP, SSO), `routes/user-management.routes.ts`, `services/api-access.service.ts` (RBAC) |
| 2 | Workspace (projects/teams) | 🟡 Partial | tenant = workspace; projects via API grouping (`public/api-automation-public.routes.ts`); **no distinct team entity** |
| 3 | API Import | ✅ Exceeds | Postman/Swagger/Excel **+ Bruno/HAR/WSDL/PDF/Word/GraphQL/curl/MCP** (`services/api-import.service.ts`) |
| 4 | API Catalogue | ✅ Present | `services/api-intelligence.service.ts`, `api-contract.service.ts`, `api-drift.service.ts` |
| 5 | Environment Manager | ✅ Present | `routes/api-automation.routes.ts` env CRUD, `services/api-env-readiness.service.ts` |
| 6 | Authentication Manager | ✅ Present | `services/api-oauth.service.ts` (OAuth2/OIDC grants), `utils/api-http.ts` (Basic/Bearer/API-key), Vault/AWS/Azure/GCP secrets |
| 7 | AI Test Designer | ✅ Present | `services/api-nl-author.service.ts`, `api-chat-test.service.ts`, `routes/chat.routes.ts` |
| 8 | Test Case Generator | ✅ Present | `agents/generatorAgent.ts`, `apiGeneratorAgent.ts`, `services/api-fuzz.service.ts` (boundary/fuzz) |
| 9 | AI Agent Manager | ✅ Present | `backend/src/agents/` (10 agents), `orchestrator/`, `routes/agent-performance.routes.ts` |
| 10 | API Execution Engine | ✅ Present | `services/playwright-runner.service.ts`, `agents/executionAgent.ts`, `services/api-exec-queue.service.ts` |
| 11 | Failure Analysis | ✅ Present | `orchestrator/failure-classifier.ts`, `services/api-failure-clusters.service.ts`, `api-diagnose.service.ts` |
| 12 | Self-Healing | ✅ Present | `agents/healingAgent.ts`, `apiHealingAgent.ts`, `services/api-maintenance.service.ts` (human-approved changesets) |
| 13 | Test Reporting | ✅ Present | `routes/reports.routes.ts`, `allure.routes.ts`, `services/api-dashboard.service.ts` |
| 14 | Integrations | 🟡 Partial | Jira ✅ Azure DevOps ✅ GitHub ✅ **Jenkins ❌** |
| 15 | Enterprise Administration | 🟡 Partial | audit/security/SCIM/SSO strong; **commercial billing absent** |

### ⚠️ Gap 2 — Jenkins has no dedicated connector

**Blueprint reference:** §1, §3 (Module 14), §5, §9 — Jenkins listed everywhere alongside Jira/ADO/GitHub.
**Actual:** no Jenkins provider or service. CI integration is generic — a token-based trigger (`routes/api-ci-public.routes.ts`) and JUnit output (`utils/junit.ts`) that *any* CI (including Jenkins calling the REST API) can consume. GitHub Actions, GitLab CI, Azure Pipelines, CircleCI appear in `components/api-studio/CiCdConnectors.tsx`; Jenkins is not named.
**Impact:** Jenkins shops can integrate via the generic path but there is no first-class Jenkins experience (no pipeline snippet, no named connector card).
**Recommendation:** add a Jenkins connector card + a documented `Jenkinsfile` snippet using the existing CI-token endpoint. Low effort — the backend path already exists.

### ⚠️ Gap 3 — No commercial billing / subscription

**Blueprint reference:** §3 (Module 15), §11 (entire commercial model — plans, metered execution, quotas).
**Actual:** no Stripe/invoice/subscription/seat logic. Closest is `services/api-finops.service.ts` (AI-cost **metering** with a budget-cap verdict) and `middleware/license-expiry.middleware.ts` (a trial/license cutoff). That's cost telemetry + a kill switch, not customer billing.
**Impact:** the platform cannot yet be sold self-serve per the §11 pricing tiers (Starter/Professional/Business) — there is no way to enforce plan quotas, meter billable executions, or manage subscriptions.
**Recommendation:** treat as a dedicated commercialization epic (payment provider, plan/quota enforcement on execution + AI credits, subscription lifecycle). The FinOps metering is a usable foundation for metered billing.

### ⚠️ Gap 4 — No Projects/Teams concept

**Blueprint reference:** §3 (Module 2), §5 (Workspace → Projects, Team Management).
**Actual:** the **tenant** is the only workspace boundary. "Projects" exist only as API-grouping in the public REST surface; there is no project entity in the UI and no team entity distinct from tenant + user roles.
**Impact:** multiple teams/projects inside one customer org cannot be cleanly separated.
**Recommendation:** decide whether tenant-per-team is sufficient for launch, or introduce a first-class Project entity (sits between tenant and test assets).

---

## 3. The 12 AI agents

Blueprint §4 names 12 specialist agents. All are functionally present; some are implemented as **services** rather than named agents.

| Blueprint agent | Implemented as |
|---|---|
| Requirement | ✅ `agents/requirementAgent.ts` |
| API Discovery | 🟡 service `services/api-intelligence.service.ts` |
| Collection Import | 🟡 service `services/api-import.service.ts` |
| Authentication | 🟡 inline helpers `utils/api-http.ts`, `services/api-oauth.service.ts` |
| Test Planning | ✅ `agents/plannerAgent.ts` |
| Test Generation | ✅ `agents/generatorAgent.ts` + `apiGeneratorAgent.ts` |
| Test Data | 🟡 embedded in generator (`TestDataPayload`/`TestDataset` in `state.ts`) |
| Execution | ✅ `agents/executionAgent.ts` |
| Failure Analysis | 🟡 `orchestrator/failure-classifier.ts` |
| Self-Healing | ✅ `agents/healingAgent.ts` + `apiHealingAgent.ts` |
| Reporting | 🟡 service layer (`allure-report.service.ts`, `api-dashboard.service.ts`) |
| Integration | 🟡 service layer (`jira-sync`, `azure-sync`, `git/*`) |

Plus a **standalone maintenance agent** (`.github/agents/playwright-framework-maintainer.agent.md`) not in the blueprint, and 6 worker-path agent `.md` files.

**Verdict:** architecturally this is "agents + services," not "12 agents." Functionally complete; no action required unless you want every role surfaced as a first-class configurable agent in the UI (see UI note below).

---

## 4. Tech stack — deliberate divergences

| Blueprint (§6) | Shipped | Note |
|---|---|---|
| Node + **NestJS** | **Express 5** | Divergence (documented) |
| **PostgreSQL** | **Azure SQL / SQL Server** + pg-compat shim (`db.ts`) | Divergence (documented) |
| **BullMQ** background jobs | Worker **polling** (5s, 30s heartbeat) | Divergence |
| **Redis** cache | none | Not present |
| Playwright `APIRequestContext` | Playwright 1.48 | ✅ Match |
| LangGraph *or* custom orchestration | Custom (both engines) | ✅ Match (allowed option) |
| S3-compatible storage | AWS S3 / Azure Blob / GCS (optional deps) | ✅ Match |
| Cloud secrets / Vault | AWS/Azure/GCP secret managers (optional deps) | ✅ Match |
| OAuth 2.0 / OIDC | Present | ✅ Match |

These are intentional and recorded in `CLAUDE.md`. The only genuine infra absence is **Redis/BullMQ**, replaced by DB-backed worker polling — acceptable at current scale, worth revisiting for high-concurrency execution.

---

## 5. UI information architecture — 🟡 reorganized

**Blueprint §5** specifies an 8-section grouped nav tree (~40 screens). **Shipped UI** is a **flat 9-item sidebar** (`frontend/src/components/layout/Sidebar.tsx`); most "screens" live as **tabs and ~100+ modal tools inside the `ApiStudio` workspace** (`/automation`) plus the `ChatPage` wizard (`/chat`, the default landing).

Everything substantive is present — it's reorganized, not missing. Specifics:

### ⚠️ Gap 5 — Genuinely absent UI screens
- **Projects** (ties to Gap 4)
- **Subscription & Billing** (ties to Gap 3)
- **Standalone Root Cause Analysis** — the blueprint lists RCA as its own Intelligence screen; actual has only adjacent tools (`FailureClusters.tsx`, `FixWorkflow.tsx`, `TestIntel.tsx`, `ImpactAnalysis.tsx`), no named RCA surface.

### Housekeeping (not blueprint gaps, but worth cleaning)
- **Orphaned / unwired pages:** `frontend/src/pages/AutomationScriptsPage.tsx`, `LandingPage.tsx` (not routed in `App.tsx`); `backend/src/routes/automation-scripts.routes.ts` (not mounted in `index.ts`).
- **Hidden by flags:** `AgentPerformancePage.tsx`, `FeatureTogglesPage.tsx` (in `HIDDEN_PATHS`, `SHOW_HIDDEN_PAGES=false`).

**Recommendation:** this is a product-design decision, not a bug. If enterprise buyers expect the blueprint's grouped IA, consider grouping the sidebar into Workspace / API / AI / Execution / Intelligence / Reports / Integrations / Admin sections. Otherwise, document the flat-IA-by-design choice. Separately: delete or wire the orphaned files.

---

## 6. Where the product EXCEEDS the blueprint

These shipped capabilities are **not in the blueprint** and are competitive assets:

- **Web Lab** — accessibility (axe), visual regression (pixelmatch), responsive device preview, Core Web Vitals (`WebLabPage.tsx`, `routes/web-tools.routes.ts`).
- **Security testing** — OWASP API Top 10 compliance, security scans, access-control testing (`api-owasp.service.ts`, `api-security.service.ts`, `SecurityScan.tsx`).
- **Service virtualization & mocking** — hosted mock server, stateful virtualization, contract-validating proxy, WireMock/Prism, Pact broker (`/mock`, `/vs`, `/proxy`, `api-virtual-public.routes.ts`).
- **Enterprise identity** — SCIM 2.0 provisioning, OIDC/SAML SSO (`/scim/v2`, `/api/auth/sso`).
- **Multi-protocol** — gRPC, Kafka (optional deps), GraphQL introspection + no-errors checks.
- **Governance** — FinOps cost metering/chargeback, audit evidence export, status/SLO pages, MCP endpoint.
- **Requirements program** — BRD/FRD lifecycle dashboard, traceability matrix, Confluence/SharePoint sources (`RequirementsManagementPage.tsx`).
- **~100+ capability tools** in the ApiStudio Tools gallery.

---

## 7. Prioritized gap backlog

| Priority | Gap | Effort | Why |
|---|---|---|---|
| **P0** | Enforce `budgetCap` + `sameFindings`/`notDecreasing` guards; replace `artifact-validator` stub | S–M | Orchestration reliability & cost safety (blueprint §10/§12 acceptance rails) |
| **P1** | Jenkins connector + `Jenkinsfile` snippet | S | Backend CI path already exists; closes Module 14 |
| **P1** | Projects/Teams decision (tenant-per-team vs. new entity) | M | Blocks multi-team enterprise orgs |
| **P1** | Standalone RCA screen | S–M | Named blueprint screen; tools already exist to surface |
| **P2** | Commercial billing / subscription / quota enforcement | L | Required for §11 self-serve SaaS model |
| **P3** | Group the sidebar IA (or document flat-by-design) | S | Enterprise expectation alignment |
| **P3** | Delete/wire orphaned pages + unmounted route | XS | Codebase hygiene |

---

*Generated from a static inventory of the IntelliQE codebase against INTELLIQE-PRODUCT-BLUEPRINT.md. Verdicts reflect code presence, not runtime verification.*
