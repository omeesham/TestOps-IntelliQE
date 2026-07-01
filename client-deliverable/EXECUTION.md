# Execution & Configuration Guide

A TypeScript Playwright end-to-end test framework built on a **layered Page
Object Model**. The package is self-contained, environment-agnostic, and
contains no credentials.

The framework lives in `src/` (human-readable TypeScript). Its architecture
(`tests/`, `flows/`, `pages/`, `components/`, `selectors/`, `api/`, `fixtures/`,
`utils/`, `config/`) and conventions are documented in `src/README.md`.

## 1. Prerequisites

- Node.js **18 or newer** (`node -v`)
- ~500 MB disk space for Playwright browsers
- Network access to the application under test (`BASE_URL`)

## 2. Install

```bash
cd client-deliverable/src
npm ci
npm run install:browsers      # downloads Chromium, Firefox, WebKit (one-time)
```

## 3. Configure

Copy the template and fill in your environment:

```bash
cp .env.example .env
```

| Variable         | Required | Default                 | Purpose                                                     |
|------------------|----------|-------------------------|-------------------------------------------------------------|
| `ENV`            | ❌       | `dev`                   | Target env (`dev`/`qa`/`uat`/`prod`); selects `*_`-prefixed overrides |
| `BASE_URL`       | ✅       | `http://localhost:3000` | Base URL of the application under test                      |
| `API_BASE_URL`   | ❌       | _(empty)_               | Base URL for the API layer (setup + backend validation)     |
| `USERNAME`       | ❌       | _(empty)_               | Test user — from env/secret manager only, never source      |
| `PASSWORD`       | ❌       | _(empty)_               | Test password — from env/secret manager only                |
| `HEADLESS`       | ❌       | `true`                  | Run browsers without a UI                                   |
| `WORKERS`        | ❌       | auto (CPU cores)        | Parallel workers; unset/`0` = auto-detect, or set a number to cap |
| `TIMEOUT`        | ❌       | `30000`                 | Per-test timeout (ms)                                       |
| `EXPECT_TIMEOUT` | ❌       | `10000`                 | Web-first assertion timeout (ms)                            |
| `RETRIES`        | ❌       | `0` local / `2` CI      | Retry transient failures; set explicitly to override        |
| `LOG_LEVEL`      | ❌       | `info`                  | `error`/`warn`/`info`/`debug`                               |
| `CI`             | ❌       | `false`                 | Enables retries and blocks `.only` when `true`              |

Per-environment overrides use an `ENV`-prefixed name, e.g. `QA_BASE_URL`,
`UAT_USERNAME`. **Never commit your `.env` file** — it is ignored by `.gitignore`.

## 4. Run

```bash
npm test                 # all browsers, headless
npm run test:headed      # watch the browser as it runs
npm run test:ui          # interactive Playwright UI
npm run test:chromium    # only Chromium
npm run test:firefox     # only Firefox
npm run test:webkit      # only WebKit
npm run test:smoke       # @smoke suite (fast gate)
npm run test:regression  # @regression suite
npm run test:api         # @api suite
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run report           # open the HTML report from the last run
```

Reports are written to `./reports/`:
- `reports/html/` — browsable HTML report
- `reports/junit.xml` — JUnit XML (for CI integrations and health metrics)
- `reports/allure-results/` — raw Allure results → `npm run allure:generate && npm run allure:open`

Trace, screenshot, and video are captured on failure (and on first retry) so any
failure is debuggable from artifacts without a local re-run.

## 5. CI/CD

A ready-to-adapt GitHub Actions pipeline ships at `src/.github/workflows/e2e.yml`:
a **quality gate** (`typecheck` + `lint`) runs first, then **sharded parallel
tests**, then a job that **merges Allure results into one HTML report**. Failing
tests fail the build (non-zero exit). Move the workflow to your repository root
and wire `BASE_URL` / credentials from your secret manager.

Equivalent pipelines for other systems ship in `src/ci/`:
- `src/ci/Jenkinsfile` (Jenkins)
- `src/ci/azure-pipelines.yml` (Azure DevOps)

The minimal portable sequence (adapts to GitLab CI, CircleCI, etc.):

```bash
npm ci
npm run typecheck && npm run lint
npx playwright install --with-deps
CI=true ENV=qa BASE_URL="$BASE_URL" npm test     # (inject secrets from the CI vault)
```

Contribution governance ships alongside: `src/.github/CODEOWNERS`,
`src/.github/pull_request_template.md`, and `src/CONTRIBUTING.md`.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `Executable doesn't exist at ...` | Run `npm run install:browsers` |
| Tests hang on navigation | Check `BASE_URL` and network connectivity |
| Timeouts in CI | Raise `TIMEOUT` (e.g. `60000`) or lower `WORKERS` |
| `Error: browserType.launch` on Linux | `npx playwright install --with-deps` |
| Need a specific browser only | `npm run test:chromium` or add `--project=firefox` |
| `allure: command not found` | Use `npm run allure:generate` / `allure:open` (bundled `allure-commandline`) |

## 7. Extending (layered Page Object Model)

Add coverage by working down the layers (see `src/README.md` for a worked
example):

1. **Selectors** → add locator keys to `src/selectors/<feature>.selectors.ts`
   (accessibility-first descriptors), re-exported from `selectors/index.ts`.
2. **Page Object / Component** → create `src/pages/<feature>.page.ts` (and any
   `src/components/*.component.ts`) extending `BasePage`/`BaseComponent`; build
   `readonly` locators from the registry, add intent-named methods. Export from
   the barrels.
3. **Flow** → add `src/flows/<feature>.flow.ts` for any reusable multi-step
   business journey.
4. **Fixture** → register the new objects in `src/fixtures/index.ts`.
5. **Spec** → add `src/tests/<feature>/*.spec.ts` with a suite tag
   (`@smoke`/`@regression`/`@api`); call flow/page methods only — never `page.*`
   or a raw locator in the test body.

Typed test data goes in `src/data/*.data.ts`; non-sensitive JSON fixtures live in
`src/data/*.json` and load via `loadData()` from `utils/test-data.ts`. Generate
unique, disposable data with `utils/data-factory.ts` to keep tests independent
and idempotent.
