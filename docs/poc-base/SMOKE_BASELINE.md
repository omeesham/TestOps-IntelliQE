# POC base: smoke reference run

This is the reference result for `poc-base-v1.0.0`. Later runs, on this base or on any client branch,
should match it.

| Item | Value |
| --- | --- |
| Date | 23-Oct-2026 |
| Code | `poc/base` (the commit tagged `poc-base-v1.0.0`) |
| Image | Built locally with `--build-arg APP_VERSION=poc-base-v1.0.0`; version stamp present in the UI bundle |
| Runtime | `NODE_ENV=production`, fresh SQL Server 2022 database, first admin from `INITIAL_ADMIN_*` |
| Browser | Microsoft Edge (Windows). The same suite also passed on Chromium in the Playwright 1.64.1 Linux image |
| Command | `cd backend && SMOKE_BASE_URL=… SMOKE_USER=… SMOKE_PASSWORD=… npm run smoke` |

## Result: 4 tests, 4 passed

| Test | Checks |
| --- | --- |
| Backend health | `GET /api/health` returns 200 `ok` |
| Public sign-up closed | `POST /api/auth/signup` returns 403 in production |
| Invalid sign-in | API returns 401; the UI shows "Invalid credentials" and stays on `/login` |
| Signed-in admin | Valid sign-in returns 200 and reaches `/chat`.<br>Web Automation is enabled; API Automation and Mobile are disabled and marked "Coming Soon".<br>The menu shows Chat, Generated Test Cases, Reports, User Management and System Configuration.<br>There is no Web Lab, ADA or Accessibility menu entry, and Agent Monitor is hidden.<br>The Reports page loads. `/web-lab` does not exist and `/agents` is blocked. |

## Negative control

The same suite run against an API-enabled build (`feature/OCRfeature-Manmohan`, local) **fails**,
with "API Automation is enabled". So the scope checks do catch a wrong build.

## Notes

- **Sign-in rate limit.** Production allows 5 sign-in attempts per minute and the suite uses 3.
  - Running it twice within a minute triggers a rate limit.
  - The suite reports that as "Rate-limited … wait a minute and re-run".
- **CI.** The POC build check builds the image, runs it in production mode against a throwaway
  SQL Server, runs this suite on Chromium and uploads the HTML report.
