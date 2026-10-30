# Jira · Azure DevOps · BRD · FRD — Integration Architecture Assessment & Implementation Plan

**Date:** 2026-10-30
**Scope:** Extend the existing JBSIntelliQE API Automation framework (do **not** replace it) with Jira, Azure DevOps, BRD and FRD integration, requirement traceability, defect automation and a dashboard.
**Operating rule:** additive by default; work module by module; typecheck + verify after each module; report honestly what is and isn't verified.

---

## 1. Architecture assessment (what you already have)

**Stack:** React + Vite frontend (`frontend/`), Express + TypeScript backend (`backend/`, port 3001), Azure SQL / SQL Server via the `db.ts` pg-compatible shim (schema `JBSTestOpsAI`, idempotent init — never drops data), multi-tenant (every query filters `tenant_id`), Claude agents + worker for the AI pipeline. Credentials XOR/AES-encrypted at rest.

**The pipeline you're extending:** Import (12 methods) → Understand → Scenarios (review gate) → Automate → Execute (Playwright/HTTP) → Heal → Report.

### Reuse inventory — most of this spec already exists

| Spec area | Status | Where it lives |
|---|---|---|
| Jira connect (URL/email/token), encrypted creds, fetch stories, fetch acceptance criteria, create bug, status | **Exists** | `backend/src/services/jira.service.ts`, `routes/jira.routes.ts`, `api.ts` (`connectJira`, `getJiraStories`, `getJiraStoryDetails`, …) |
| Azure DevOps connect (org URL + PAT), fetch work items/stories/test cases, create bug | **Exists** | `backend/src/services/azure-devops.service.ts`, `routes/azure-devops.routes.ts` |
| Secure credential storage (encrypted, per-tenant, `client_configurations`) | **Exists** | `configurations.service.ts`, `utils/crypto.ts` |
| Document extraction (PDF / DOCX / XLSX → text) | **Exists** | `backend/src/services/document-parser.service.ts` (`parseDocument`) |
| AI requirement → test plan / scenarios | **Exists** | `api-story-gen.service.ts`, `api-story-source.service.ts`, `StoryGen.tsx` |
| Requirement traceability matrix | **Exists** | `backend/src/services/api-traceability.service.ts` |
| API automation engine (all HTTP verbs, auth/authz, schema, negative, boundary, pagination, rate-limit, retry, webhooks, OpenAPI, 40+ integration checks) | **Exists** | pipeline + `ApiToolsLauncher.tsx` tools, integration-tests feature |
| Reporting (run reports, JUnit, Allure, Markdown, exports) | **Exists (partial for the new dashboard)** | `reports.routes.ts`, run report UI |
| Import grid (declarative cards + per-method forms) | **Exists** | `importMethods.ts`, `views/ImportView.tsx`, `api.ts` import* |
| Connector services (TM: TestRail/Xray/Zephyr/qTest; CI/CD; apitest) | **Exists** | `api-tm-connectors.service.ts`, `api-cicd-connectors.service.ts`, `api-apitest-connectors.service.ts` |

### Genuine gaps (what this program actually needs to build)

1. **Import-by-method cards for Jira, Azure, BRD, FRD** — pull/upload a source and extract endpoints into the catalogue. *(Original request.)*
2. **Structured BRD extraction** — business requirements with IDs (BR-001…), objectives, rules, workflows, dependencies, positive/negative scenarios.
3. **Structured FRD extraction** — functional requirements with IDs (FR-001…), endpoint/method/params/headers/body/auth/response/validations/errors → functional test scenarios.
4. **Expanded Jira fetch** — projects, epics, tasks, subtasks, bugs (today: mainly stories/issues).
5. **Expanded Azure fetch** — organizations/projects enumeration, test plans/suites, work-item relationships (today: stories/work-items/test-cases).
6. **Defect automation on failure** — call the existing `createBug` from the run pipeline when a test fails; dedupe; update existing defects; attach reports; status sync. *(Not wired today.)*
7. **Scheduled synchronization** — manual exists ad hoc; scheduled sync + sync history is new.
8. **End-to-end traceability chain** BRD → FRD → Jira/Azure → scenario → case → execution → defect, with coverage %, orphan detection (extend the existing matrix).
9. **Unified integration dashboard** — the counts/percentages/filters/export matrix in the spec.
10. **New DB tables** for the entities that don't exist yet (below), via the idempotent `db.ts` init pattern.

---

## 2. Database — additive tables only

Reuse the `db.ts` idempotent init (no drops, multi-tenant). Reuse existing: `client_configurations` (Jira/Azure creds — do **not** duplicate as JiraConnections/AzureConnections), existing test-case/run/report tables, existing traceability store. New tables (prefixed, tenant-scoped):

- `brd_documents`, `business_requirements` (BR-xxx)
- `frd_documents`, `functional_requirements` (FR-xxx)
- `requirement_traceability` (if the current matrix store doesn't already cover the full chain — verify first, extend not duplicate)
- `integration_sync_history`
- `defect_links` (maps a failed test/run → Jira/Azure defect id, for dedupe + status sync)

Jira/Azure issues and API test cases are **already** modeled or fetched live — we link to them, not re-store them, unless caching is needed for the dashboard.

---

## 3. Phased, module-by-module plan (build → typecheck → verify → report → next)

Each module is additive and independently shippable. Verification gate after each: `backend` `npm run build` + `frontend` `tsc -b` clean, plus a real run (live where possible).

- **Module 1 — Import sources (the original ask).** Four new Import-by-method cards: Jira, Azure (reuse existing connections), BRD, FRD (document upload → existing parser → AI-read → endpoints into catalogue). Plus the "generate requirements brief" bridge to the Story tool. *Mostly additive; smallest risk; verifiable now with a doc + a live Jira/Azure item.*
- **Module 2 — BRD module.** Upload → structured business requirements (BR-IDs, objectives, rules, workflows, dependencies, pos/neg scenarios); BRD management view.
- **Module 3 — FRD module.** Upload → functional requirements (FR-IDs, endpoint/method/params/headers/body/auth/responses/validations/errors) → generate functional test scenarios into the pipeline.
- **Module 4 — Jira integration completion.** Projects/epics/tasks/subtasks/bugs fetch; requirement→test-case mapping; defect auto-create on failure + update + dedupe + attach report + status sync; manual + scheduled sync + sync history.
- **Module 5 — Azure integration completion.** Orgs/projects; test plans/suites; relationships; push results; defect auto-create; status sync; manual + scheduled sync.
- **Module 6 — Traceability.** Full BRD→FRD→Jira/Azure→scenario→case→execution→defect matrix; coverage %, orphan detection (extend `api-traceability.service.ts`).
- **Module 7 — Dashboard & reporting.** Counts, coverage/automation/success %, filters (Jira/Azure project, BRD/FRD doc, endpoint, status), export Excel/PDF/CSV.
- **Module 8 — Security & RBAC hardening.** Confirm masking, RBAC on integration config, audit logs, graceful token-expiry handling across the new modules (most primitives already exist).
- **Module 9 — Navigation surfacing.** Expose the modules the spec lists (BRD, FRD, Traceability, Integration Settings, etc.) as nav/tabs — reusing the existing shell, not a second app.

DB changes land **inside** the module that needs them (not a big-bang migration), via the idempotent init.

---

## 4. What cannot be verified without you

The spec requires testing Jira/Azure **with real credentials**. I don't have those. I will:
- Build and typecheck every path, and verify everything testable locally (document extraction, endpoint generation, the pipeline against public APIs like jsonplaceholder).
- Clearly mark **live Jira/Azure connectivity, real defect creation, and status sync as UNVERIFIED** until you connect real accounts under System Configuration (or give me test-instance creds).

No integration will be reported "successful" on mocked responses.

---

## 5. No-break guarantees

- Additive files/routes/cards; the only shared-file edits are small (a new import-input case, union members). No changes to `db.ts` core shim, auth middleware, the orchestrator, or the tenant filter beyond additive table init.
- Existing import methods, pipeline, and tools stay untouched.
- Each module ends green on typecheck and a real run before the next begins.

---

## 6. Current working tree (uncommitted, from this session, unrelated to this program)

Already built and verified this session, not yet committed: merged "Automating" stage tab, deterministic API validation gate, import method/format mismatch guard, import form auto-scroll. These don't conflict with the plan.

---

## Recommended start: **Module 1** (the four import cards) — highest value, lowest risk, verifiable immediately.
