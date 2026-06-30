# Execution & Configuration Guide

This package is a Playwright end-to-end suite in a standard **Page Object Model**
(POM) layout — human-readable TypeScript. Self-contained, environment-agnostic,
and contains no credentials or proprietary framework internals.

```
playwright.config.ts          # testDir ./tests
src/pages/                     # page objects (extend base.page.ts)
src/fixtures/ src/utils/ src/data/ src/types/
tests/<module>/<name>.spec.ts  # specs drive scenarios through page objects
```

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

## 4. Configure

Copy the template and fill in your environment:

```bash
cp .env.example .env
```

| Variable   | Required | Default                 | Purpose                                           |
|------------|----------|-------------------------|---------------------------------------------------|
| `BASE_URL` | ✅       | `http://localhost:3000` | Base URL of the application under test           |
| `HEADLESS` | ❌       | `true`                  | Run browsers without a UI                         |
| `WORKERS`  | ❌       | `4`                     | Parallel worker processes                         |
| `TIMEOUT`  | ❌       | `30000`                 | Per-test timeout in milliseconds                  |
| `CI`       | ❌       | `false`                 | Enables retries and blocks `.only` when `true`    |

**Never commit your `.env` file** — it is ignored by `.gitignore`.

## 5. Run

```bash
npm test              # all browsers, headless
npm run test:headed   # watch the browser as it runs
npm run test:ui       # interactive Playwright UI
npm run test:chromium # only Chromium
npm run report        # open the HTML report from the last run
```

Reports are written to `./reports/`:
- `reports/html/`  — browsable HTML report
- `reports/junit.xml` — JUnit XML (for CI integrations)

## 6. CI example (generic)

```yaml
# Works on any CI that runs Node on Linux.
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 20
  - run: npm ci
    working-directory: client-deliverable/src
  - run: npx playwright install --with-deps
    working-directory: client-deliverable/src
  - run: CI=true BASE_URL=${{ secrets.BASE_URL }} npm test
    working-directory: client-deliverable/src
  - uses: actions/upload-artifact@v4
    if: always()
    with:
      name: playwright-report
      path: client-deliverable/src/reports
```

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `Executable doesn't exist at ...` | Run `npm run install:browsers` |
| Tests hang on `page.goto` | Check `BASE_URL` and network connectivity |
| Timeouts in CI | Raise `TIMEOUT` (e.g. `60000`) or lower `WORKERS` |
| `Error: browserType.launch` on Linux | `npx playwright install --with-deps` |
| Need a specific browser only | Use `npm run test:chromium` or add `--project=firefox` |

## 8. Extending

Add page objects under `src/pages/<module>/<name>.page.ts` (extend
`src/pages/base.page.ts`) and specs under `tests/<module>/<name>.spec.ts` that
import and drive those page objects. Keep selectors in the page objects, not the
specs. Non-sensitive fixtures live in `src/data/*.json`, loaded via `loadData()`
from `src/utils/test-data.ts`.
