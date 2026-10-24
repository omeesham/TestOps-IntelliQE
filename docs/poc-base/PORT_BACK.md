# Port-back log: fixes for `main`

The fixes below were made on `hardening/v1` (cut from `main` @ f639160) and merged into `integration`
by PR #3. `poc/base` is cut from `integration`, so it has them too. They reach `main` when
`integration` is merged into `main`.

## Commits on hardening/v1

| Commit | Change | Verified by |
| --- | --- | --- |
| Repo | Allure results no longer committed; `.gitattributes` keeps binaries binary | Fresh Windows clone works without long-path settings |
| Build | Dockerfile agents path (`client-deliverable/.github/agents`); runtime data kept out of the image | Image builds; 6 agent files in the image |
| Deps | `npm update` within ranges plus a dompurify override (backend); `npm audit fix` (frontend) | 0 critical issues (was 3); frontend 0 issues; both build |
| Build | Node 24 + Playwright 1.64.1 image matching the lockfile; `PLAYWRIGHT_CHANNEL=chromium` in the container | A browser launches inside the image |
| Security | Production sign-in hardening | 8 live checks against SQL Server in production mode |
| Security | Saved credentials: nested encryption, full password masking, masked values never overwrite | 5 live checks + 6 unit tests |
| Security | Report files require a signed, tenant-bound report cookie | 5 live checks |
| Build | LF line endings for container scripts and config | A container built from a Windows checkout starts; API + worker run |

## Before deploying to an EXISTING environment (e.g. JBS's own Azure)

- **Plain-text passwords:** existing users whose stored password is still plain text (the old seed users,
  `jbsadmin` / `qaengineer`) **cannot sign in under `NODE_ENV=production`**.
  - Deploy once with `ALLOW_PLAINTEXT_PASSWORDS=true`.
  - Have each such user sign in once; the password is then re-hashed.
  - Then remove the setting.
- **Legacy demo tokens** are off by default; users still on them must sign in again.
- **Report links** open only after the user loads Reports, or generates a report, in the same browser.
  Old bookmarked report links return 401 until then.
- **Container base changed** (Playwright 1.48/Node 20 → 1.64.1/Node 24). Upgrade `@playwright/test` and the
  image tag together from now on.

## Known items not fixed (backlog for `main`)

- **Dependencies, 22 high:**
  - webdriverio 9 → 10 (major; mobile, currently "Coming Soon");
  - nodemailer 8 → 10 (major);
  - xlsx (no fixed version on npm).
- **Sign-up (when enabled) joins any existing tenant by name, and the caller picks their role.**
  Restrict this to invitations or admin-created users.
- **Feature Toggles:** any signed-in user can switch features on or off for the whole tenant (documented as product spec).
- **Plain-text passwords remain in docs and seed files:** `docs/AZURE_DEPLOYMENT_RUNBOOK.md`, `docs/TECHNICAL_SPEC.md`,
  `seed_data.sql`, `backend/db/seed/03_seed_data.sql`. Rotate those passwords wherever they are still in use.
- **AI usage** is neither tracked nor capped in the Chat flow, and the default model is Opus. The pipeline budget
  settings exist but are not enforced.
- **Docs drift:** CLAUDE.md says the schema is `JBSTestOpsAI`; the code uses `dbo`.
