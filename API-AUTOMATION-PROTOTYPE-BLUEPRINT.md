# API Automation — Prototype Blueprint (Simplified Rebuild)

> **Status:** Spec / blueprint. No code yet.
> **Date:** 2026-11-10
> **Goal:** Define a clean, minimal re-implementation of the *core idea* behind
> JBSIntelliQE's API automation — stripped of the 114-service production sprawl —
> that validates the concept end to end and can be built in days, not months.

---

## 1. Why this exists

The production platform ships **114 `api-*` services and 60+ routes** (fuzzing,
OWASP, load, chaos, drift, contract brokers, SCIM, SSO, governance, …). That
breadth is valuable but it buries the one idea that makes the whole thing work.

This prototype answers a single question:

> *Can an AI reliably turn "here is an API endpoint" into a running, asserting,
> self-contained test suite — without the AI ever writing code that might not
> compile?*

Everything else in the production system is an elaboration on that loop. If the
core loop is sound in 1,500 lines, the concept is proven. This document is the
spec for those 1,500 lines.

---

## 2. The irreducible core (the one invariant)

Extracted from `backend/src/agents/apiGeneratorAgent.ts` and
`backend/src/services/api-flow.service.ts`, the entire platform rests on **one
design invariant**:

> **The LLM designs test _intent_ as typed JSON. Deterministic code renders that
> JSON into runnable test specs and executes it. The model never authors code.**

Why this matters, and why the rebuild must keep it:

| If the LLM writes… | Risk |
|---|---|
| Playwright/pytest **code** | Hallucinated APIs, syntax errors, specs that don't compile, prompt-injection into the test runner |
| **Typed JSON** (request + a closed set of assertion kinds) | Schema-validatable, deterministically renderable, always compiles, auditable, re-runnable without a second model call |

Concretely, the model returns objects like this (the real `ApiCheck` set):

```json
{
  "title": "Verify GET /posts/1 returns 200 with the expected post schema",
  "category": "positive",
  "request": { "method": "GET", "url": "https://api.example.com/posts/1", "includeAuth": true },
  "checks": [
    { "kind": "status", "equals": 200 },
    { "kind": "header", "name": "content-type", "contains": "application/json" },
    { "kind": "jsonProperty", "path": "id", "type": "number" }
  ]
}
```

A deterministic renderer turns that into a real, compiling test. The model's
"creativity" is bounded to *which scenarios to test and what to assert* — never
to *how to express it in a programming language*.

**This single property is the thing the prototype exists to demonstrate.**

---

## 3. Scope

### In scope (the core loop)

1. **Define** one endpoint (method, URL, headers, auth, body, expected status/response).
2. **Generate** a focused suite of test *cases* as typed JSON via one LLM call.
3. **Render** each case deterministically into a runnable spec.
4. **Execute** the specs against the live endpoint (no browser).
5. **Report** per-case pass/fail with the actual values observed.
6. **(Stretch) Chain** 2–4 endpoints into one multi-step flow (create → read → delete)
   with value extraction between steps.

### Explicitly OUT of scope (deliberately cut from production)

- Multi-tenancy, auth middleware, RBAC, the Azure SQL pg-shim
- The worker/queue architecture and SSE streaming
- Import connectors beyond **one** (cURL *or* a pasted endpoint form)
- Everything in the 110 other `api-*` services: fuzzing, OWASP, load, chaos,
  drift, contract brokers, mocks, synthetics, governance, SCIM/SSO, Jira/Azure
  sync, dashboards, scheduling, healing-at-scale
- Self-healing (keep a **stub** seam for it; don't build it)
- Persistence beyond a single local JSON/SQLite file (or in-memory)

> The cut list is the point: the prototype proves the loop, not the platform.

---

## 4. Minimal architecture

```
┌─────────────┐     ApiSpec      ┌──────────────┐   NormalizedCase[]   ┌──────────────┐
│  Define UI  │ ───────────────▶ │  Generator   │ ───(typed JSON)────▶ │   Renderer   │
│ (1 form)    │                  │  (1 LLM call)│                      │(deterministic)│
└─────────────┘                  └──────────────┘                      └──────┬───────┘
                                                                              │ spec files
                                                                              ▼
┌─────────────┐    RunResult[]   ┌──────────────┐                      ┌──────────────┐
│  Report UI  │ ◀─────────────── │   Executor   │ ◀────────────────────│  Spec files  │
│ (1 table)   │                  │ (HTTP runner)│                      │  on disk     │
└─────────────┘                  └──────────────┘                      └──────────────┘
```

Four modules, one data contract flowing left to right:

| Module | Responsibility | Lines (est.) | Derived from |
|---|---|---|---|
| **Generator** | Prompt the LLM; parse + normalize to `NormalizedCase[]` | ~250 | `apiGeneratorAgent.ts` (prompt + `normalizeCase`) |
| **Renderer** | `NormalizedCase` → runnable spec (string) | ~200 | `apiGeneratorAgent.ts` (`renderSpec`/`checkLines`) |
| **Executor** | Issue HTTP, evaluate checks, collect results | ~250 | `api-flow.service.ts` (`runChecks`/`execSteps`) |
| **Thin API + UI** | 3 endpoints, 2 screens | ~400 | `api-automation.routes.ts` (a sliver) |

**Build decision — skip the Playwright round-trip for the prototype.** Production
renders to Playwright `.spec.ts` files and shells out to the Playwright runner.
That's robust but heavy. For the prototype, **the Renderer emits the same typed
checks the Executor evaluates directly in-process** (reuse the `runChecks` engine
from `api-flow.service.ts`). This keeps the invariant (model → typed JSON →
deterministic execution) while removing the compile-and-shell-out step. Keep the
`NormalizedCase` shape identical to production so a later swap to real spec-file
rendering is a renderer-only change.

---

## 5. Data model (4 types — copy these verbatim from production)

The prototype reuses the exact production shapes so the concept transfers 1:1.
Source: `backend/src/agents/state.ts`.

```ts
// What the user defines — the ground truth the generator designs against.
interface ApiSpec {
  method: string;
  url: string;
  baseUrl?: string;
  headers?: { key: string; value: string }[];
  auth?: { type: 'none' | 'bearer' | 'basic' | 'apikey'; value?: string; headerName?: string };
  body?: string;
  expectedStatus?: number;
  expectedResponse?: string;
  coverage?: 'essential' | 'standard' | 'exhaustive';   // bounds suite size
}

// The CLOSED set of assertions. The model may ONLY emit these kinds.
// A closed set is what makes deterministic rendering + execution possible.
interface ApiCheck {
  kind: 'status' | 'ok' | 'notOk' | 'jsonProperty' | 'jsonArrayNotEmpty'
      | 'header' | 'bodyContains' | 'responseTimeUnderMs';
  equals?: number; oneOf?: number[]; lessThan?: number;
  path?: string; exists?: boolean; value?: unknown;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
  name?: string; contains?: string; text?: string; ms?: number;
}

// One generated, validated test case after normalization.
interface NormalizedCase {
  id: string; title: string; category: 'positive'|'negative'|'auth'|'schema'|'edge';
  method: string; url: string; headers: Record<string,string>; body?: string;
  checks: ApiCheck[];
  steps?: FlowStep[];   // present only for a multi-step flow case (stretch goal)
}

// One result row after execution.
interface RunResult {
  id: string; title: string; ok: boolean; status?: number; durationMs: number;
  checks: { label: string; pass: boolean; actual?: string }[];
  error?: string;
}
```

That's the whole contract. Four types carry the entire loop.

---

## 6. The pipeline, step by step

### 6.1 Define
A single form collects an `ApiSpec`. Derive `baseUrl` from `url` server-side.
One quality-of-life importer is allowed: **paste a cURL command → `ApiSpec`**
(trivial parser) *or* just the raw form. No OpenAPI/Postman in the prototype.

### 6.2 Generate (the one LLM call)
Port the `buildApiPrompt` structure from production, trimmed:

- **Role:** "Senior API Test Engineer. Return STRUCTURED JSON only — you do NOT
  write code."
- **Input:** the `ApiSpec` fields, rendered as a readable block.
- **A scenario matrix** gated by `coverage` depth (`essential` 4–6 cases,
  `standard` 10–16, `exhaustive` 16–28). Keep four rows minimum:
  **Contract** (happy path + schema), **Negative** (unknown resource, malformed
  input), **Boundary** (id/pagination edges), **Auth** (only when auth is set).
- **Output:** a JSON array of raw cases using *only* the `ApiCheck` kinds above.
- **Rules that matter:** absolute URLs only; every case independently runnable;
  specific sentence-form titles; never emit real secrets (reference auth via
  `includeAuth`, the renderer injects it); strict JSON.

Then **normalize** (port `normalizeCase`): resolve URL, merge headers, inject or
strip auth per `includeAuth`, attach body for write methods, guarantee at least
one assertion, assign an id. Reject any case whose URL isn't absolute. Parsing
must be defensive — salvage a JSON array even when the model wraps it in prose
(port `extractCases`).

### 6.3 Render (deterministic)
Map each `ApiCheck` kind to its execution. In production this emits Playwright
`expect(...)` lines; in the prototype the Renderer is the identity-ish pass that
hands `NormalizedCase.checks` straight to the Executor's check engine. Keep the
function signature `render(case): ExecutableCase` so the Playwright path can be
dropped in later without touching Generator or Executor.

### 6.4 Execute
Port the `runChecks` engine from `api-flow.service.ts`:
- Issue the HTTP request (native `fetch`), time it, capture status/headers/body.
- Parse JSON once; evaluate each check against status / parsed body / headers /
  elapsed time; record `{ label, pass, actual }` per check.
- A case passes when the transport succeeded **and** every check passed. When a
  case carries an explicit `status` check, that check owns the status verdict
  (so a negative case asserting 404 is a pass, not a failure).
- **Safety:** refuse write methods (POST/PUT/PATCH/DELETE) unless the user
  explicitly ticks "allow writes against this environment" (port the
  `allowWrites` guard). Per-request timeout. Mask credential headers in output.

### 6.5 Report
One table: case id, title, category, status, duration, per-check pass/fail with
the actual value observed. A run summary line (passed/failed/total, slowest).

### 6.6 (Stretch) Flow chaining
Port the minimal slice of the flow engine: a `FlowStep[]` where a step can
`extract` a value from its response (`{ userId: "id" }`) and later steps
`substitute` `{{userId}}` into url/headers/body. This demonstrates stateful
create → read → delete journeys. Cap at ~4 steps. Skip loops/branches/retry/
datasets/suites — those are production elaborations.

---

## 7. Tech stack & layout

Keep it boring and single-process.

```
api-automation-prototype/
├── package.json
├── src/
│   ├── types.ts          # the 4 types from §5
│   ├── llm.ts            # one Anthropic Messages API call + JSON salvage
│   ├── generator.ts      # buildPrompt + extractCases + normalizeCase
│   ├── renderer.ts       # NormalizedCase -> ExecutableCase (thin for now)
│   ├── executor.ts       # fetch + runChecks + write-guard
│   ├── server.ts         # 3 endpoints (Express or Hono)
│   └── flow.ts           # (stretch) extract/substitute + runFlow
├── web/
│   └── index.html        # 2 screens: Define form, Report table (vanilla or 1 React file)
└── .env.example          # ANTHROPIC_API_KEY
```

- **Runtime:** Node 20+, TypeScript, `tsx` for dev.
- **LLM:** Anthropic Messages API directly (`@anthropic-ai/sdk`), latest model
  (`claude-opus-5-5` or `claude-sonnet-5-5`), `max_tokens: 8192`. One call per
  generate. *(Confirm current model ids via the `claude-api` skill before wiring.)*
- **HTTP:** native `fetch`. **No** Playwright in the prototype.
- **Persistence:** none required; hold the last run in memory. (A single SQLite
  file is the max if runs must survive a restart.)
- **No** auth, no tenancy, no DB shim, no worker.

---

## 8. API surface (3 endpoints — down from 60+)

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/generate` | `ApiSpec` | `NormalizedCase[]` (designed, not yet run) |
| `POST` | `/api/run` | `{ cases: NormalizedCase[], allowWrites?: boolean }` | `RunResult[]` + summary |
| `POST` | `/api/curl` | `{ curl: string }` | `ApiSpec` (convenience importer) |

Generate and run are **separate calls** (as in production) so the user can
review/trim the designed suite before anything hits the network.

---

## 9. Build milestones

| # | Milestone | Proves | Done when |
|---|---|---|---|
| **M0** | Types + LLM call returns valid JSON for one spec | The model can be constrained to typed JSON | `/api/generate` returns ≥1 valid `NormalizedCase` for `GET https://jsonplaceholder.typicode.com/posts/1` |
| **M1** | Executor runs a hand-written case against a live endpoint | Deterministic execution of typed checks | A `status=200` + `jsonProperty id` case passes against the live API |
| **M2** | Full loop: generate → run → report | **The core concept** | One click: define endpoint → see a 10-case suite run with per-check actuals |
| **M3** | Negative/auth cases behave correctly | The matrix produces *meaningful* coverage, not just happy paths | A 404 negative case and a no-auth 401 case both pass (assert the failure) |
| **M4** (stretch) | 3-step create→read→delete flow with `{{var}}` chaining | Stateful journeys | A flow creates a resource, reads it by the returned id, deletes it, confirms 404 |

M2 is the demo. M0–M3 is the prototype. M4 is the "and it scales to journeys"
proof.

---

## 10. Definition of done (prototype)

Per the repo's standard, the prototype is "done" only when:

1. **Core loop runs end to end** against a real public API
   (`jsonplaceholder.typicode.com` or `httpbin.org`) — generate, execute, report —
   shown with real output (a screenshot or terminal transcript of a run).
2. **The invariant holds:** every executed assertion traces to a typed
   `ApiCheck` the model emitted; the model emits **zero lines of code**. Grep the
   prototype: there is no model-authored source anywhere in the run path.
3. **Specs always "compile":** the normalizer rejects malformed/non-absolute
   cases before execution; a garbage model response degrades to "0 valid cases",
   never to a crash.
4. **Write safety:** write-method cases do not execute without an explicit opt-in.
5. **Typecheck clean:** `tsc --build` passes.
6. **It reads as the core of the real thing:** the 4 types match production, so
   the path from prototype → the real `apiGeneratorAgent` is "add layers, add
   persistence, add the Playwright renderer," not "rewrite."

---

## 11. How this maps back to production

The prototype is a faithful 1,500-line core of the real system. The growth path
to the production platform is purely **additive**, which is the whole value of
starting from the right core:

| Prototype | Grows into (production) |
|---|---|
| 1 endpoint form + cURL | The import layer: OpenAPI, Postman, HAR, Jira, GraphQL, MCP, connectors |
| 4 scenario rows | The full gated matrix + per-layer toggles + risk weighting |
| In-process check engine | Deterministic **Playwright `request` spec** rendering + service objects (POM) |
| One run, in memory | Multi-tenant persistence, scheduling, SSE progress, worker queue |
| Stub heal seam | `apiHealingAgent` self-healing loop |
| — | The 110 other services (fuzz, OWASP, load, chaos, drift, contracts, governance…) |

Nothing in the prototype has to be thrown away to get there — which is the test
of whether the core was chosen correctly.

---

*Source of truth for the distillation: `backend/src/agents/apiGeneratorAgent.ts`,
`backend/src/agents/state.ts`, `backend/src/services/api-flow.service.ts`,
`backend/src/routes/api-automation.routes.ts`.*
