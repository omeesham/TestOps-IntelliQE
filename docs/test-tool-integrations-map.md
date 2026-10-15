# Test-tool integrations — real-time connection map

A per-tool map of the catalogue shown in **System Configuration → API integrations**
(`frontend/src/components/api-studio/views/IntegrationsView.tsx`), so we can pick
what to make genuinely "work in real time" and in what order.

Written against the current codebase — status is what *actually exists today*, not
the "Soon" badges on the grid (those are hard-coded and don't reflect the backend).

---

## First, the key distinction: "connect" means 3 different things

A tool only "works in real time" in the way that fits what it *is*. Lumping them
together is why the grid feels fake. There are three integration shapes:

| Type | What "connect" means | Needs | Tools that fit |
|---|---|---|---|
| **A — Live API connector** | Enter credentials → we call the vendor's REST API live → test, push results, pull data | Vendor account + API token; a backend client per vendor | SaaS test-management, device clouds, cloud-perf, CI servers |
| **B — Artifact import / export** | Exchange files/collections (their format ↔ ours) | A parser/serialiser per format (no live account needed) | API clients (Postman, Insomnia, Bruno, SoapUI, HAR…) |
| **C — Code generation** | Emit a runnable project in that framework's syntax | A codegen template per framework | Automation & perf frameworks (Selenium, Cypress, JMeter…) |

**Local frameworks (Selenium, Cypress, Appium, JMeter…) have no SaaS API to "connect" to.**
For those, "real time" = we generate a runnable project (Type C) and/or trigger it in CI
(Type A against the CI server), not a live handshake with the tool itself.

---

## Status legend

- 🟢 **Live** — real backend exists and works today
- 🟡 **Partial** — adjacent capability exists; needs surfacing or a small extension
- 🔴 **None** — directory entry only; needs a real build

---

## 1) Test Management  *(the section you asked about)*

Type A (live API connectors). Four of six already exist in
`backend/src/services/api-tm-connectors.service.ts` + `TmConnectors.tsx`
(connect → **test live** → **export run results** → **import test cases**).

| Tool | Status | Connection | What's needed to make it "work here" | Effort |
|---|---|---|---|---|
| **TestRail** | 🟢 Live | A | Just **surface it** on the grid: card "Connect" → opens the existing flow with vendor preset | XS (wiring) |
| **Xray** (Jira Cloud) | 🟢 Live | A | Same — surface on the grid | XS (wiring) |
| **Zephyr Scale** | 🟢 Live | A | Same — surface on the grid | XS (wiring) |
| **qTest** | 🟢 Live | A | Same — surface on the grid | XS (wiring) |
| **PractiTest** | 🔴 None | A | New vendor in the tm-connectors service: auth (API token + developer email/account), base URL, project; map our run → PractiTest instances/runs; pull cases. REST API is documented. | M |
| **Testmo** | 🔴 None | A | New vendor: API token, project; map run → Testmo automation run (it has a first-class "automation runs" API, so this is one of the cleaner ones); pull cases. | M |

**Fastest real win:** wire the 4 live ones into the grid (XS each). Then PractiTest +
Testmo are two self-contained M builds following the existing vendor pattern.

---

## 2) API Testing

Mostly **Type B** (artifact exchange). We already parse several of these formats on
import (`importMethods.ts` / `api-import.service.ts`): **Postman, Bruno, HAR, OpenAPI,
GraphQL, cURL, SDK source**. "Connect" here = import their collection and/or export ours
back.

| Tool | Status | Connection | What's needed | Effort |
|---|---|---|---|---|
| **Postman** | 🟡 Partial | B (+A) | Collection **import already works**. To "connect": surface it here, and optionally add live **Postman API** sync (workspaces/collections by API key) = Type A. | S (surface) / M (live API) |
| **SoapUI / ReadyAPI** | 🔴 None | B | Parser for SoapUI project XML (REST/SOAP). SOAP/WSDL intake is the bigger piece. | M |
| **Insomnia** | 🟡 Partial | B | Insomnia export ≈ importable; add an Insomnia-format parser (or document "export → import as HAR/OpenAPI"). | S–M |
| **Bruno** | 🟢 Live | B | `.bru` import **already supported**. Just surface it. | XS (wiring) |
| **Hoppscotch** | 🔴 None | B | Parser for Hoppscotch collection JSON. | S |
| **Karate** | 🔴 None | C | Codegen target: emit `.feature` files from our scenarios. | M |
| **REST Assured** | 🔴 None | C | Codegen target: Java + RestAssured test classes. | M |
| **Pact** | 🔴 None | C+A | Generate consumer pacts from our contracts; optionally publish to a **Pact Broker** (has a REST API). Note: a `PactBroker.tsx` tool shell already exists — check how far it goes. | M–L |

---

## 3) Test Automation

**Type C** (code generation) — these are local frameworks, no live handshake. Today only
**Playwright** and **k6** are generated (`FullCodeExport.tsx` + `api-codegen.service.ts`),
and Playwright is actually **executed** by `playwright-runner.service.ts`.

| Tool | Status | Connection | What's needed | Effort |
|---|---|---|---|---|
| **Playwright** | 🟢 Live | C (+exec) | Full-code export **and** real execution already exist. Surface on grid. | XS (wiring) |
| **Selenium** | 🔴 None | C | Codegen target: WebDriver (Java/Python/JS). | M |
| **Cypress** | 🔴 None | C | Codegen target: `cy.request()` specs + config. | M |
| **Katalon** | 🔴 None | C | Codegen/import for Katalon project format (heavier, proprietary). | L |
| **Appium** | 🔴 None | C | Codegen target; mobile automation — mostly out of scope for an API platform. | L |
| **Robot Framework** | 🔴 None | C | Codegen target: `.robot` suites with RequestsLibrary. Clean mapping. | M |
| **WebdriverIO** | 🔴 None | C | Codegen target: WDIO specs + config. | M |
| **TestCafe** | 🔴 None | C | Codegen target: TestCafe tests. | M |

---

## 4) Performance & Load  *(not in your screenshot, but on the grid)*

**k6** generated today. Others are either new codegen targets (Type C) or cloud APIs (Type A).

| Tool | Status | Connection | Effort |
|---|---|---|---|
| **k6** | 🟢 Live (C) | Export already exists; surface it | XS |
| **Apache JMeter** | 🔴 None | C — emit `.jmx` | M |
| **Gatling** | 🔴 None | C — Scala/Java simulation | M |
| **Locust** | 🔴 None | C — Python locustfile | S–M |
| **BlazeMeter** | 🔴 None | A — has a real cloud API (run + results) | M |
| **LoadRunner** | 🔴 None | C/A — enterprise, proprietary | L |

---

## 5) Cross-browser & Device Cloud

Type A (real vendor APIs). Some overlap with **Web Lab** (BrowserStack-parity capability
already exists in `web-*` services).

| Tool | Status | Connection | Effort |
|---|---|---|---|
| **BrowserStack** | 🟡 Partial | A — Web Lab covers parity; live BrowserStack API = new | M |
| **Sauce Labs** | 🔴 None | A — REST API (sessions, results) | M |
| **LambdaTest** | 🔴 None | A — REST API | M |
| **Perfecto** | 🔴 None | A — REST API | M |

---

## 6) CI/CD Pipelines

Type A (CI server APIs) and partly Type C (we emit workflow files). A GitHub Actions
workflow already ships with the Playwright export; `CiPipeline.tsx` and git routes exist.

| Tool | Status | Connection | Effort |
|---|---|---|---|
| **GitHub Actions** | 🟡 Partial | C (workflow emitted) + A (trigger via GitHub API) | S–M |
| **Jenkins** | 🔴 None | A — REST API to trigger/fetch builds | M |
| **GitLab CI** | 🔴 None | C (`.gitlab-ci.yml`) + A (API) | M |
| **Azure Pipelines** | 🔴 None | A — Azure DevOps API (JIRA/ADO already wired for requirements) | M |
| **CircleCI** | 🔴 None | A — REST API | M |

---

## Recommended rollout (fastest real value first)

1. **Phase 0 — surface what already works (hours, no new backend).**
   Turn the dead "Soon" cards into working **Connect** buttons for the 🟢 Live tools:
   TestRail, Xray, Zephyr, qTest (open the real tm-connectors flow, vendor preset),
   Bruno + Postman (import), Playwright + k6 (code export). Instantly makes the screen honest.

2. **Phase 1 — finish Test Management (your ask).**
   Build **PractiTest** and **Testmo** as new vendors in the tm-connectors pattern (M each).
   Testmo first — its automation-runs API maps most cleanly to our run model.

3. **Phase 2 — pick ONE lane to go deep**, based on your customers:
   - *Framework shops* → add Cypress / Selenium / Robot codegen (Type C).
   - *Enterprise QA* → add Jenkins or Azure Pipelines triggers (Type A).
   - *Contract-first* → finish Pact + Pact Broker.

4. **Live verification** needs a real account + API token per vendor (you said *not yet*).
   Each connector can be built and unit-tested against recorded fixtures now; the live
   green-check just needs one token when you're ready.

---

## "Make it simple to connect" — the UX pattern (once we build)

Same shape for every Type-A tool, so the grid feels uniform:

1. Card shows real status: **Not connected / Connected ✓ / Error** (not "Soon").
2. Click **Connect** → small form: base URL + the 1–2 credentials that tool needs.
3. **Test** button → live call → green check or a plain error reason.
4. Once connected, the card exposes its **features** inline: *Export last run*, *Import cases*,
   *Open in <tool>*. (This is exactly what `TmConnectors.tsx` already does for the 4 live ones —
   the pattern is proven; we're replicating it and surfacing it on the catalogue.)
