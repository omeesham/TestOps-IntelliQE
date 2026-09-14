# QE Playwright Tests — Page Object Model

Human-readable TypeScript Playwright test suite in a standard Page Object Model layout. Environment-agnostic, no hardcoded credentials, no external framework dependencies.

## Prerequisites

- Node.js 18 or newer
- Internet access for the one-time browser install

## Install

```bash
npm ci
npm run install:browsers
cp .env.example .env
# edit .env and set BASE_URL
```

## Run

```bash
npm test                 # headless, all browsers
npm run test:headed      # headed
npm run test:ui          # interactive UI mode
npm run test:chromium    # chromium only
npm run report           # open last HTML report
```

## Layout (Page Object Model)

```
playwright.config.ts        # Playwright config (testDir ./tests)
package.json  tsconfig.json  .env.example
src/
├── pages/                  # page objects (UI tests)
│   ├── base.page.ts        # BasePage every page object extends
│   ├── <module>/           # e.g. auth/login.page.ts
│   └── components/         # shared mixins/components
├── api/                    # service objects (API tests)
│   ├── base.api.ts         # BaseApi every service object extends
│   └── <module>/           # e.g. users/users.api.ts
├── fixtures/               # pages.fixture.ts (test/expect), matchers.ts
├── utils/                  # env.ts (config), test-data.ts (loader)
├── data/                   # JSON fixtures (non-sensitive)
└── types/                  # shared TypeScript types
tests/
├── <module>/<name>.spec.ts # UI specs drive scenarios through page objects
└── api/<name>.spec.ts      # API specs drive requests through service objects
```

Specs talk to **page objects**, never to raw selectors. When the UI changes,
fix the page object under `src/pages/`, not the tests.

API specs follow the same pattern with **service objects**: they call a method
on a class under `src/api/` and assert on the response — they never build a URL,
set a header or serialise a payload. When an endpoint moves or its auth scheme
changes, fix the service object under `src/api/`, not the tests.

## Configuration

All behavior is driven by `.env` (see `.env.example`). No code edits required to change target environment, parallelism, or browser mode.

See `../EXECUTION.md` at the package root for the full execution guide.
