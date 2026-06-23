# QE Playwright Tests — Source Build

Human-readable TypeScript Playwright test suite. Environment-agnostic, no hardcoded credentials, no external framework dependencies.

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

## Layout

```
src/
├── tests/    # .spec.ts test files
├── config/   # playwright.config.ts + env.ts
├── utils/    # test-data loader
└── data/     # JSON fixtures (non-sensitive)
```

## Configuration

All behavior is driven by `.env` (see `.env.example`). No code edits required to change target environment, parallelism, or browser mode.

See `../EXECUTION.md` at the package root for the full execution guide.
