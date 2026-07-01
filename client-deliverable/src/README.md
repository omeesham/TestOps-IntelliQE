# QE Playwright Test Framework — Source Build

A production-grade, TypeScript Playwright framework built on a **layered Page
Object Model**. Environment-agnostic, parallel-safe, no hardcoded credentials,
no external framework dependencies.

## Prerequisites

- Node.js 18 or newer
- Internet access for the one-time browser install

## Install

```bash
npm ci
npm run install:browsers
cp .env.example .env
# edit .env — set ENV and BASE_URL (and API_BASE_URL / credentials if needed)
```

## Run

```bash
npm test                 # all browsers, headless
npm run test:headed      # headed
npm run test:ui          # interactive UI mode
npm run test:chromium    # chromium only
npm run test:firefox     # firefox only
npm run test:webkit      # webkit only
npm run test:smoke       # @smoke suite (fast gate)
npm run test:regression  # @regression suite
npm run test:api         # @api suite
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run report           # open last HTML report
npm run allure:generate && npm run allure:open   # Allure report
```

## Layered architecture

A clear separation of concerns, so the suite stays navigable into the hundreds
of specs:

```
tests  →  flows (business layer)  →  pages + components  →  selectors / api / utils / config
(what)    (reusable journeys)        (how to interact)       (locators, requests, helpers, settings)
```

```
src/
├── tests/        # WHAT is verified — scenarios only, grouped by feature/domain
│   ├── smoke/    #   @smoke   — fast gate
│   ├── auth/     #   @regression — login (incl. data-driven)
│   └── api/      #   @api     — backend checks
├── flows/        # Business-action layer — reusable multi-step journeys (AuthFlow)
├── pages/        # Page Objects — one *.page.ts per screen, all extend BasePage
├── components/   # Component Objects — reusable UI widgets scoped to a root (NavBar)
├── selectors/    # Central selector registry (one partition per module)
├── api/          # Typed API client (+ ApiCleanup) — data setup + backend validation
├── fixtures/     # Custom fixtures — inject page objects/components/flows/api + teardown
├── utils/        # Helpers — logger, data-factory, JSON test-data loader
├── data/         # Test data — typed *.data.ts + JSON fixtures (no secrets)
├── config/       # env.ts (externalized settings) + playwright.config.ts
├── ci/           # Jenkins + Azure DevOps pipeline examples
└── types.ts      # shared cross-layer types (e.g. Credentials)
```

Governance lives at the package root: `.github/workflows/e2e.yml` (CI),
`.github/CODEOWNERS`, `.github/pull_request_template.md`, and `CONTRIBUTING.md`.

**Tests never touch raw selectors or `page.*` directly.** Setup/teardown lives in
fixtures, not repeated `beforeEach` chains.

## How the rules are applied

| Principle | Where |
|---|---|
| Design pattern (POM + Component Object Model) | `pages/`, `components/`, `selectors/` |
| Layered separation / business layer | `tests/` → `flows/` → `pages/`+`components/` |
| SRP & DRY | page objects = one screen; flows = reusable journeys; shared `utils/` + `BasePage` |
| Clean code & type safety | small intent-named methods, TypeScript throughout, `npm run lint` |
| Externalized config & environments | `config/env.ts` reads `.env`; `ENV` selects dev/qa/uat/prod |
| Data-driven testing | data in `data/` (typed `*.data.ts` + JSON via `loadData`); green example `tests/smoke/reachability.data-driven.spec.ts` |
| Stable locators | accessibility-first `SelectorDescriptor` (role/label/placeholder/text/testId) |
| Synchronization | web-first auto-retrying `expect`; **never** `waitForTimeout` |
| Independent & idempotent | per-test isolated context; unique data via `utils/data-factory.ts` |
| Parallel & cross-browser | `fullyParallel`, `WORKERS` (auto-detect when unset), chromium/firefox/webkit projects + per-browser scripts |
| Reporting | HTML + JUnit + Allure; trace/screenshot/video on failure; Allure HTML merged in CI |
| Logging | `utils/logger.ts` (LOG_LEVEL-gated + validated); used in flows/api/pages |
| Retry / flaky management | retries in CI only; quarantine, don't blanket-hide (see `CONTRIBUTING.md`) |
| CI/CD | `.github/workflows/e2e.yml` (quality gate → sharded tests → merged Allure); `ci/` Jenkins + Azure examples |
| API + UI validation | `api/` client + `tests/api/` + combined example `tests/auth/login-with-api-setup.spec.ts` |
| Test data management | unique data via `utils/data-factory.ts`; auto-cleanup via the `apiCleanup` fixture |
| Test pyramid | API-tier setup/validation pushed below E2E (see "Coverage strategy" below) |
| Governance | ESLint rules, `CONTRIBUTING.md`, `CODEOWNERS`, PR template; CI gates lint + typecheck |
| Security | secrets only via env / secret manager — never in source |

## The Page Object Model convention

1. **Specs are scenarios.** A `*.spec.ts` reads like a user story; it calls flow
   and page-object methods only — never a `Locator` or `page.*` directly.
2. **Page Objects own a screen.** Each extends `BasePage`, declares locators once
   as `readonly` fields (resolved from the registry), and exposes intent-named
   methods.
3. **Components own a widget.** Reusable UI sections extend `BaseComponent`,
   scoped to a root locator, and are composed by pages.
4. **Flows own a journey.** Multi-step business operations live in `flows/` so
   specs don't repeat setup.
5. **Selectors live in one place** — accessibility-first descriptors in
   `selectors/*.selectors.ts`.
6. **Fixtures wire it together** — specs destructure ready-built objects.
7. **Assertions are web-first** — auto-waiting/retrying matchers; no fixed sleeps.

### Add a feature

1. Add locator keys to a `selectors/<feature>.selectors.ts` partition.
2. Create `pages/<feature>.page.ts` (and any `components/`), export from the barrels.
3. Add a `flows/<feature>.flow.ts` if there's a reusable journey.
4. Register fixtures in `fixtures/index.ts`.
5. Add `tests/<feature>/*.spec.ts` with a suite tag (`@smoke` / `@regression`),
   calling methods only.

### Two spec styles

Both follow the rules above and run side by side:

- **Shared-framework specs** import page objects/flows via the fixtures
  (`tests/auth/login.spec.ts`).
- **Self-contained specs** declare their Page Object class(es) inline and import
  only `@playwright/test` — useful when a spec must run in isolation without the
  shared framework on the path.

## Coverage strategy (test pyramid)

Push logic down the pyramid; reserve the browser for genuine user journeys. Use
suite tags to make the tier explicit:

| Tier | Tag | Browser? | Use for |
|---|---|---|---|
| API / contract | `@api` | no | backend behavior, fast feedback (`tests/api/`) |
| Integration | `@integration` | yes | API-seeded setup + a focused UI check (`tests/auth/login-with-api-setup.spec.ts`) |
| E2E | `@smoke` / `@regression` | yes | end-to-end user journeys |

Prefer the API layer (`api/`) to create preconditions and the `apiCleanup`
fixture to remove them, so the slow E2E tier stays small and stable.

## Test data lifecycle

1. **Generate** unique, disposable data with `utils/data-factory.ts`
   (`makeUser()`), so re-runs never collide.
2. **Seed** it through the API (`api.post(...)`) — faster and more reliable than
   driving the UI for setup.
3. **Use** it in the test.
4. **Clean up** automatically: register the resource with `apiCleanup.track(...)`
   and the fixture deletes it at teardown — no environment pollution.

`tests/auth/login-with-api-setup.spec.ts` shows the full lifecycle.

## Running the examples

Out of the box, the **smoke** suite runs green against any reachable `BASE_URL`
(`tests/smoke/` — including the data-driven `reachability` spec). The
app-specific examples (`login`, `login.data-driven`, `navbar`, `api/health`,
`login-with-api-setup`) ship **`.skip`-ped as templates**: they assume your app's
login screen / API. Point `selectors/`, `BASE_URL`, and `API_BASE_URL` at your
application and remove `.skip` to activate them. This is intentional — a generic
deliverable cannot assert app-specific UI until it's wired to a real target.

## Governance & health

Treat tests as production code: code-reviewed, linted, type-safe. The CI quality
gate runs `typecheck` + `lint` before tests; `CODEOWNERS`, the PR template, and
`CONTRIBUTING.md` define the review process. Track suite health — pass rate, mean
execution time, flake rate — from the JUnit/Allure output, and quarantine flaky
tests explicitly rather than blanket-retrying.

See `../EXECUTION.md` at the package root for the full execution guide.
