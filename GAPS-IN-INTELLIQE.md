# Gaps in IntelliQE — MVP2 API tickets (IQE-037, 040, 041, 043–056)

Audit date: 2026-11-16. Every acceptance criterion in the supplied tickets was checked against the **actual code** (file:line evidence). This document lists **only the items that are missing or partial** — everything not listed here was verified as implemented.

## How to read this

| Mark | Meaning |
|------|---------|
| ❌ | **Missing** — the capability does not exist / is not reachable. |
| ⚠️ | **Partial** — the capability exists but is incomplete, not wired up, or not surfaced. |
| 🔧 | **Process / QA** — not a code defect; it's a sign-off, a measurement, or an external artifact the tickets require ("QA-tested and signed off", "≥90% run without fixes", "runs in under 15 minutes", the "120-pattern workbook"). |

## The two architectural themes behind most gaps

1. **Two test engines, unevenly capable.** There is a **deterministic Flow engine** (`backend/src/services/api-flow.service.ts` `runChecks()`, authored in **FlowBuilder / Integration Tests**) that has every rich check kind — XML-path, SOAP fault, WSDL-structure, GraphQL-errors, HTML not-contains, cookies, retries, schema — and captures the **full request+response** per step. And there is the **AI scenario generator** (`backend/src/agents/apiGeneratorAgent.ts` → Playwright/Allure, shown in Runs/Reports) whose check set is **JSON-only** (status / jsonProperty / header / bodyContains / responseTimeUnderMs). **The rich checks exist only in the Flow engine and are neither emitted by the AI generator nor auto-seeded from imports**, so for XML/HTML/SOAP/GraphQL they only run end-to-end when a user hand-authors them in FlowBuilder. This single fact drives ~9 of the ⚠️ items below.

2. **The "120 Real Industry API Testing Patterns" workbook harness does not exist.** No workbook, pattern-runner, or "Verified Sources" harness is anywhere in the repo (`grep` for `120.*pattern|workbook|real industry|verified sources` → nothing). Every ticket criterion of the form *"workbook patterns #… run and pass against the reference APIs"* (043.1 #117; 043.3–043.10 last criterion) is therefore **not runnable** — classified 🔧 (needs the workbook + a runner built, or the criterion dropped).

---

## 1. Imports (IQE-047 – IQE-052)

Deterministic parsers are strong. Gaps cluster around **not reporting what was skipped** and a few missing entry points.

- **IQE-047.1 #3 — ⚠️ Invalid OpenAPI/Swagger message is generic.** A broken spec falls through to the LLM reader and, failing that, throws a generic *"not a machine-readable API description"* — it does not name the structural/parse problem. No dedicated OpenAPI validator in the import path. `backend/src/services/api-import.service.ts:2132`
- **IQE-048.1 #5 — ⚠️ Postman pre-request/test scripts are dropped silently.** They are correctly not executed, but are **not listed as "skipped (with reason)"** in the import summary (no `event`/`prerequest` handling in the parser). `api-import.service.ts` (Postman parser ~892-1080)
- **IQE-049.1 #4 — ❌ Bruno scripts/tests/assert blocks ignored silently.** Captured by `brunoBlocks` but never recorded as skipped anywhere. `api-import.service.ts:1379+`
- **IQE-049.1 #5 — ⚠️ Bruno import summary is a notice string**, not the structured `imported / skipped / failed` item tally that Postman produces.
- **IQE-050.1 #5 — ⚠️ Un-importable cURL options silently dropped.** Only no-URL commands are warned; `-b/--cookie`, `-o`, `-A`, `-e`, `--max-time` are consumed without being enumerated in the summary. `api-import.service.ts:1561-1618`
- **IQE-051.1 #4 — ❌ No HAR domain chooser.** `parseHar` imports every qualifying entry at once; there is no "choose which domains to import before endpoints are created" step in the UI or route. `api-import.service.ts:1180-1206`
- **IQE-052.1 #1 — ⚠️ GraphQL SDL upload has no deterministic parser.** SDL works only through the LLM reader (LLM-key dependent); introspection-by-URL is fully deterministic. `api-import.service.ts:2134-2136`
- **IQE-052.1 #2 — ⚠️ GraphQL types not catalogued.** Only operations (Query + Mutation fields) become catalogue entries; types are read for sampling but not surfaced. `api-import.service.ts:1902-1929`

---

## 2. Testing engine — REST / XML / HTML / GraphQL / SOAP (IQE-044, 045, 046)

Every capability **exists**; the recurring shortfall is theme #1 (rich checks are Flow-engine-only, not generated/auto-seeded). **IQE-046.1 (WSDL import) is fully implemented — no gaps.**

- **IQE-044.1 #6 — ⚠️ Full request/response inline only on the Flow path.** FlowBuilder shows full `request{method,url,headers,body}` + response headers/body; the **AI-scenario Runs view shows only error + endpoint + Allure link** — full headers/body are not inline there. `api-flow.service.ts:1096-1102` vs `frontend/.../views/RunsView.tsx:391-397`
- **IQE-044.1 #7 — ⚠️ Per-check passed/failed breakdown inline only on the Flow path.** Runs view is per-case; per-check detail lives in Allure.
- **IQE-044.2 #3 — ⚠️ AI generator never emits XML-path assertions.** XML-specific positive/negative/boundary checks are Flow-authored / manual only.
- **IQE-044.3 #3 — ⚠️ Generator emits `bodyContains` but not `bodyNotContains`.** HTML "does-not-contain" negatives are Flow-only.
- **IQE-045.1 #1 — ⚠️ GraphQL ops generated with inline arg samples and empty `variables:{}`** — no true `$variable` parameterization. `api-import.service.ts:1917`
- **IQE-045.1 #4 — ⚠️ Malformed-query 4xx handled only indirectly** (status check + graphql-errors check); no dedicated malformed-query path at run time.
- *(045.1 note) — ⚠️ the graphql no-errors check is not auto-seeded for generated GraphQL scenarios* (Flow/manual only).
- **IQE-046.2 #2 — ⚠️ WSDL-schema validation is structural-presence only and not auto-applied.** `xmlSchema` checks element-present + required-children and names the first missing element, but is **not full XSD type validation**; worse, the WSDL-derived contract `ep.soap{responseElement,responseRequired}` is attached at import (`wsdl-import.service.ts:507-512`) but **consumed nowhere** — so nothing applies it automatically. `api-flow.service.ts:612-618`
- **IQE-046.2 #3 — ⚠️ SOAP fault check not auto-seeded.** `soapFault` (code+message, SOAP 1.1/1.2) exists but the user must add it by hand in FlowBuilder. `api-flow.service.ts:599-611`
- **IQE-046.2 #4 — ⚠️ No auto-generation of SOAP cases into the main AI scenario run.** SOAP runs in the same suite/report engine as REST (true), but only when hand-authored.

---

## 3. API patterns (IQE-043.3 – IQE-043.10)

Functional coverage is strong. Besides the workbook harness (🔧, see theme #2), the real gaps are:

- **IQE-043.4 #4 — ⚠️ No true binary/stream handling.** Response body is always read as truncated text; gzip/deflate auto-decodes, and size is only checkable via a `Content-Length` header check — there's no dedicated binary type+size assertion. `backend/src/utils/api-http.ts:147,164`
- **IQE-043.6 #2 — ⚠️ Missing/null extracted value fails unclearly.** An empty extraction silently substitutes `''`, producing a broken request rather than a clear "extraction failed" step error (author must add a `jsonPathExists` guard). `api-flow.service.ts:1068-1070`
- **IQE-043.8 #1 — ⚠️ Timeout message is the raw AbortSignal text** ("operation was aborted"), not a custom "timed out after N ms". Elapsed time is recorded and shown correctly. `api-http.ts:154,165-167`
- **IQE-043.9 #2 — ⚠️ No dedicated check/add/delete cookie UI.** Cookies work via the auto per-host jar + manual `Cookie` header + header checks only. `api-flow.service.ts:41-81`
- **IQE-043.10 #1 — ⚠️ No first-class / auto correlation-ID.** Achievable only by manually adding `X-Correlation-ID: {{$uuid}}`, shown in the generic request echo — not auto-generated or labelled. `api-flow.service.ts:369,1096-1101`
- **IQE-043.3/.4/.5/.6/.7/.8/.9/.10 (last criterion) — 🔧 workbook patterns not runnable** (no harness; theme #2).

---

## 4. Generator / Healer / Guided flow / Studio core (IQE-040, 041, 037, 043.1, 043.2)

This cluster has the **highest-value functional gaps**.

### Generator (040)
- **IQE-040.1 #1 — ⚠️ No JS/TS language setting.** The renderer always emits TypeScript `.spec.ts`; default-TS is met but JS output is not producible. `apiGeneratorAgent.ts:1438`
- **IQE-040.1 #6 — ⚠️ "Existing generator, no new agent" is debatable.** API generation is a **new dedicated module** (`apiGeneratorAgent.ts`, separate from the browser `generatorAgent.ts`), though no new `.github/agents/*.md` persona was added.
- **IQE-040.2 #3 — ⚠️ enum limits not explicitly named** in the boundary matrix (min/max/length off-by-one are present). `apiGeneratorAgent.ts:240`
- **IQE-040.3 #1 — ⚠️ Wrong-role token case absent** from the generator prompt (missing/invalid/expired are present). `apiGeneratorAgent.ts:250-255`
- **IQE-040.3 #2 — ❌ Cross-user / IDOR case is not generated** per resource-ID endpoint. BOLA/BFLA lives only in a separate opt-in tool (`api-authz.service.ts`, `api-authz-deep.service.ts`), not in generated per-endpoint suites.
- **IQE-040.1 #5 / 040.2 #7 — 🔧** "≥90% run without manual fixes" is not measured or gated anywhere in code.

### Healer (041)
- **IQE-041.1 #6 — ⚠️ Suggestions are on-demand, not auto-attached to every failed test** in the standard run report. They come from `POST /api-automation/diagnose`, the `/heal` batch, and bug reports; `utils/run-report.ts` has no diagnose/suggestion wiring. (All other 041.1 criteria ✅, including the fixed "Please check all the API details and revalidate." note.)

### Guided flow (037)
- **IQE-037.1 #2 — ⚠️ Live per-step progress is in the run shell (StageRail), not the guide.**
- **IQE-037.1 #3 — ⚠️ Per-step error + next-action not surfaced by the guide** (run log only).
- **IQE-037.1 #4 — ❌ Forward progress is not gated.** Stepper dots and tabs are free navigation; there is no "move to next step only when current succeeded". `GettingStartedGuide.tsx:156-158`
- **IQE-037.1 #6 — ⚠️ Leave-and-return loses work across sessions.** Working catalogue/scenarios persist to **sessionStorage only** (survives refresh, lost after logout/new login). Runs/reports persist server-side. `hooks/useCatalog.ts:48,110`
- **IQE-037.2 — ❌ No built-in sample API shipped** (needed for the "run on the sample API" criterion; jsonplaceholder exists only in a separate prototype dir). The rest of 037.2 is 🔧 process (new-user timing, real-customer-API run, defect sign-off).

### Studio core (043.1 / 043.2)
- **IQE-043.1 #5 — 🔧** workbook pattern #117 — no harness (theme #2). (CRUD env, `{{var}}` resolution, env switch, secret masking all ✅.)
- **IQE-043.2 #1 — ⚠️ "Scripts" is not a distinct area.** Six tabs (overview/endpoints/scenarios/runs/report/environments/tools) + Import modal; generated scripts live inside runs/report, so the ticket's seven-area list isn't literally met.
- **IQE-043.2 #2 — ⚠️ Catalogue + scenarios persist to sessionStorage only** — not kept across logout/login (same root cause as 037.1 #6).
- **IQE-043.2 #3 — ⚠️ No "analyst" role; RBAC fails open on lookup error.** Roles are admin / qa_lead / qa_engineer / viewer — the ticket's "analyst" is absent — and a permission-lookup error fails open. `api-access.service.ts:46-51,378`
- **IQE-043.2 #4 — ❌ MVP3 tools are visible in MVP2.** Autopilot, Spec Diff (breaking-change gate), MCP server, Traffic capture, and CI pipeline are all imported and shown in the tools gallery; no feature gate hides them. `ApiToolsLauncher.tsx`

---

## 5. Code push (IQE-053 – IQE-056)

One shared `POST /api/git/publish` route drives all four providers and is **script-type-agnostic — both Web and API scripts push on every provider** (no provider is missing either). The **secret scan (IQE-053.2) is fully wired for all four** providers from a single pre-publish call. Gaps:

- **IQE-053.1 #2 — ⚠️ GitHub PR is not automatic by default.** GitHub's default path is a **direct commit to the default branch with no PR**; a PR is raised only when `mode:'pr'` or an explicit branch is passed. The other three providers always branch + PR/MR. `backend/src/routes/git.routes.ts:191-203`
- **IQE-054.1 #5 — ⚠️ GitLab self-managed detection is name-based.** Works only if the host string contains "gitlab"; an arbitrarily-named self-managed host (e.g. `git.company.com`) is rejected as "Unsupported git host". Nested groups are fine. `backend/src/services/git/git.types.ts:170`
- **IQE-055.1 #5 — ❌ Bitbucket Server / Data Center not supported.** Only Bitbucket Cloud: `api.bitbucket.org` is hardcoded and the host check rejects self-hosted. `backend/src/services/git/bitbucket.provider.ts:20`
- **Cross-cutting (all "PR/MR link stored with the run") — ⚠️ storage is conditional.** `push_info` is written only when a `testRunId` is supplied, and best-effort; a push not tied to a run shows the link but doesn't store it. `git.routes.ts:351-369`

---

## Priority view (what's worth doing, roughly in order)

**P1 — real functional holes**
- 040.3 #2 ❌ IDOR/cross-user case generation (also a market differentiator called out in the ticket).
- 043.2 #4 ❌ gate/hide the MVP3 tools in MVP2.
- 051.1 #4 ❌ HAR domain chooser.
- 055.1 #5 ❌ Bitbucket Server/DC (or confirm Cloud-only is acceptable per Omeesha).
- 037.1 #6 / 043.2 #2 ⚠️ persist working catalogue/scenarios server-side so work survives logout.
- 043.2 #3 ⚠️ add the "analyst" role (and fix RBAC fail-open).
- 053.1 #2 ⚠️ make GitHub default to a PR like the other providers.

**P2 — "exists but not auto-wired" (theme #1): emit/auto-seed the rich checks**
- Auto-seed XML-path (044.2 #3), HTML not-contains (044.3 #3), SOAP fault + WSDL-structure (046.2 #2/#3/#4), GraphQL no-errors (045 note) into generated scenarios, and surface full req/resp + per-check pass/fail on the Runs view (044.1 #6/#7).

**P3 — polish**
- Skipped-item reporting (048.1 #5, 049.1 #4/#5, 050.1 #5), import messages (047.1 #3), GraphQL types + deterministic SDL (052.1 #1/#2), timeout message (043.8 #1), extraction-failure clarity (043.6 #2), cookie UI (043.9 #2), correlation-ID (043.10 #1), binary handling (043.4 #4), enum boundary (040.2 #3), wrong-role token (040.3 #1), JS output option (040.1 #1), 041.1 #6 auto-attach suggestions, 037.1 #2/#3 guide progress/errors.

**🔧 Not code — decide or build separately**
- The "120-pattern workbook" harness (043.1 #5, 043.3–043.10 last criterion): build a workbook + runner, or drop the criterion.
- "≥90% run without fixes" (040.1 #5, 040.2 #7), "under 15 minutes / sign-off" (037.2), and every "QA-tested and signed off in a client-like environment" line: QA process, not code — except 037.2's **built-in sample API** (❌) which is a code deliverable.
