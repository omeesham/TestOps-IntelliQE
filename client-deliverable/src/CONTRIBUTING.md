# Contributing

Treat this test suite as production code: branched, reviewed, linted, type-safe.

## Branching

- `main` is protected: no direct pushes; changes land via pull request.
- Branch names: `feature/<slug>`, `fix/<slug>`, `chore/<slug>`.
- Recommended protection rules on `main`: require a passing CI run (quality +
  e2e) and at least one approving review (see `.github/CODEOWNERS`).

## Commits

- Imperative mood, concise subject (e.g. "Add checkout page object").
- Reference the issue where relevant (e.g. "… (#123)").

## Pull requests

- Fill in `.github/pull_request_template.md`.
- CI must be green: `npm run typecheck`, `npm run lint`, and `npm test`.
- A CODEOWNER for each touched layer must approve.

## Local checks before pushing

```bash
npm run typecheck
npm run lint
npm test            # or a focused suite: npm run test:smoke
```

## Conventions

- Follow the layered Page Object Model documented in `README.md`
  (tests → flows → pages/components → selectors/api/utils/config).
- Specs never touch raw selectors or `page.*`; locators live in `selectors/`.
- No fixed sleeps — rely on web-first, auto-retrying assertions.
- Tests must be independent and idempotent; create unique data via
  `utils/data-factory.ts` and clean it up via the `apiCleanup` fixture.

## Flaky tests

Do not blanket-retry to hide flakiness. Quarantine a genuinely flaky test
(`test.fixme()` with a linked tracking issue), then fix the root cause. Track
suite health — pass rate, mean duration, flake rate — from the JUnit/Allure
output, and treat a falling pass rate as a release blocker.
