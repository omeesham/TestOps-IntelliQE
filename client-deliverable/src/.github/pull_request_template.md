<!-- PR template. The checklist mirrors the CI quality gates. -->

## What & why

<!-- Briefly describe the change and the reason for it. Link the issue. -->

Closes #

## Affected layers

<!-- e.g. tests/auth, pages/login, selectors/login, fixtures, api -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes locally (or the relevant suite for the change)
- [ ] No `.only` left in any spec; intentional `.skip`s are documented as templates
- [ ] Tests are independent and idempotent (no ordering/shared-state assumptions)
- [ ] Locators come from the selector registry (no raw `page.*`/inline selectors in specs or page objects)
- [ ] No secrets, credentials, or `.env` committed
- [ ] Docs updated if conventions/structure changed
