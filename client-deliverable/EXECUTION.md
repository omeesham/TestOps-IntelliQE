# Execution & Configuration Guide

This package contains Playwright end-to-end tests in two forms:

- `src/` — human-readable TypeScript source (for engineers who want to read, extend, or debug the tests)
- `dist/` — minified JavaScript distribution (for running the tests without a TypeScript toolchain)

Both are self-contained, environment-agnostic, and contain no credentials or proprietary framework internals.

## 1. Prerequisites

- Node.js **18 or newer** (`node -v`)
- ~500 MB disk space for Playwright browsers
- Network access to the application under test (`BASE_URL`)

## 2. Choose a build

| Build | When to use | Commands work from |
|---|---|---|
| `src/` | You want to read or modify tests | `client-deliverable/src/` |
| `dist/` | You just want to run tests quickly | `client-deliverable/dist/` |

The instructions below apply to both; only the working directory changes.

## 3. Install

```bash
cd client-deliverable/src     # or: cd client-deliverable/dist
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
    working-directory: client-deliverable/dist
  - run: npx playwright install --with-deps
    working-directory: client-deliverable/dist
  - run: CI=true BASE_URL=${{ secrets.BASE_URL }} npm test
    working-directory: client-deliverable/dist
  - uses: actions/upload-artifact@v4
    if: always()
    with:
      name: playwright-report
      path: client-deliverable/dist/reports
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

Add new tests under `src/tests/*.spec.ts`. Each file is a standard Playwright
test module — no framework-specific base classes required. Non-sensitive
fixtures can live in `src/data/*.json` and be loaded via `loadData()` from
`utils/test-data.ts`.
