# POC base: baseline record

The `poc/base` branch is the starting point for every client POC branch. It is cut from the
released product and carries only hardening, build fixes and client-safe configuration.

## Starting point

| Item | Value |
| --- | --- |
| Branch | `poc/base` |
| Cut from | `main` @ `f6391601de17937e51fb9fa3b5e9c1f9ffb76e80` ("ux changes", 27-Jun-2026) |
| Not included | `develop` commits 4316e79 and 175a6ee (unreviewed; can be added in a later base version) |
| Recorded | 23-Oct-2026 |
| Build check | Fresh clone: backend and frontend `npm ci` + `npm run build` pass (Node 24.21.0, npm 11.19.0) |
| Container base images | `node:20-alpine` (UI build), `mcr.microsoft.com/playwright:v1.48.0-jammy` (API build and runtime) |

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

## Known issues found at the starting point (fixed on this branch)

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
