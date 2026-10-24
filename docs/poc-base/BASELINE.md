# POC base: baseline record

The `poc/base` branch is the starting point for every client POC branch. It is cut from
`integration` (reviewed product changes) and adds only POC-only changes: scope defaults, docs,
the smoke suite and CI.

## Starting point

| Item | Value |
| --- | --- |
| Branch | `poc/base` |
| Cut from | `integration` @ `9674b97eac92a8b92ae06400f716799f42c40502` (24-Oct-2026) |
| `integration` holds | `main` @ `f639160` ("ux changes", 27-Jun-2026) + PR #3 (`hardening/v1`: security, build, dependencies) + PR #4 (product improvements: coverage engine, environments, test files, read-only environments, review flow) |
| Not included | `develop` commits 4316e79 and 175a6ee; the API automation branch (unreviewed; can be added in a later base version) |
| Recorded | 24-Oct-2026 |
| Build check | Fresh clone: backend and frontend `npm ci` + `npm run build` pass (Node 24.21.0, npm 11.19.0) |
| Container base images | `node:24-alpine` (UI build), `mcr.microsoft.com/playwright:v1.64.1-noble` (API build and runtime) |

## Product scope at the starting point

| Area | State |
| --- | --- |
| Web Automation | Enabled |
| API Automation | "Coming Soon" tile only (no API module code) |
| Mobile Automation | "Coming Soon" tile only |
| ADA / Web Lab | Not present (no route, menu or page) |
| Routes | `/`, `/login`, `/chat`, `/dashboard`, `/generated-tests`, `/automation-scripts`, `/reports`, `/execution-recordings`, `/agents`, `/user-management`, `/system-configuration`, `/feature-toggles`, `/configurations`, `/settings` |
| Sidebar | Chat, Dashboard, Generated Test Cases, Automation Scripts, Reports, Execution Recordings, Agent Monitor, User Management, System Configuration, Feature Toggles |

"Accessibility" appears only as a test-case type that the AI agents can generate. It is not the
ADA module.

## Known issues found in `main` @ f639160 (fixed by `hardening/v1`, now in `integration`)

1. A Windows clone fails with "Filename too long": 235 Allure result files are committed under `backend/allure-results-store/`.
2. The container build fails: the `Dockerfile` copies `.github/agents`, but the agent files are in `client-deliverable/.github/agents`.
3. CI never runs: the only workflow is in `client-deliverable/.github/workflows/`.
4. Vulnerable production dependencies:
   - backend: 51 (3 critical: dompurify, handlebars, proxy-addr);
   - frontend: 5 (axios, form-data, follow-redirects).
5. Internal JBS notes, scripts and prompts are committed in the repository root.
6. Login and security:
   - public signup can choose any role, including Admin;
   - seed users have known plaintext passwords;
   - plaintext password fallback;
   - the legacy demo token is accepted;
   - passwords are partly shown in API responses;
   - report links need no login.

## Status at `poc-base-v1.0.0`

| # | Issue | Status |
| --- | --- | --- |
| 1 | Windows clone fails | Fixed. Allure results removed from git and ignored |
| 2 | Container build fails | Fixed. The agents path is corrected and the image builds |
| 3 | CI never runs | Fixed for POC branches. The root workflow builds, runs the image and runs the smoke suite on `poc/**` |
| 4 | Vulnerable dependencies | Critical issues: 0 (was 3). Frontend: 0. Backend: 22 high remain, all needing major upgrades or having no fix (see PORT_BACK.md) |
| 5 | Internal files in the repo root | Removed. JBS demo passwords also removed from the docs and seed files |
| 6 | Login and security | Fixed: production sign-in rules, credentials encrypted and masked, report links require sign-in |

Found and fixed during the work:
- **Container runtime:**
  - test runs could not work inside the container (Playwright 1.48 browsers vs a 1.59+ library, and Edge is not available on Linux);
  - Node 20 was end-of-life.
- **Windows-built image would not start:** the container scripts had CRLF line endings.
- **Production start-up:**
  - the worker secret silently defaulted to `dev-secret`;
  - the app now refuses to start without its required secrets.
- **Client view:** Agent Monitor showed sample data; it is now hidden by default.
