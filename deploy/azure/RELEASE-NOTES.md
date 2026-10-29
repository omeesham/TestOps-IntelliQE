# IntelliQE release notes

## poc-v1-rc1 (29 Oct 2026)

Image: `jbsintelliqe-app:poc-v1-rc1` (container image, Linux, Chromium test browser).

### Included

- Test design from the application (Explore), Jira tickets and requirement documents (PDF, Word), including document scanning screens: header fields, table columns and mandatory ("*") fields.
- Document checks against an answer key: per-field accuracy, confidence, and a scorecard per run.
- Read-only mode per environment: data-changing requests are blocked, with an allow-list (for example the Scan request).
- Script generation in the background, one test case per AI call, reviewed cases only once review has started; failures are named and retried on the next click.
- Safe self-healing: a failure is first re-run unchanged; fixes that weaken checks or change the test case's values are rejected; a script that passed before is sent to a person; a fix is kept only if it passes.
- Document values (names, hours) are removed from failure text before it reaches the AI.

### Verified in the container

Production mode on a fresh database: first administrator, application with read-only setting, test-file upload, test run, script generation, test execution in the container browser, document scorecard, read-only guard, healing, and files and reports kept across a container replacement.

### Security scan (Trivy, CRITICAL and HIGH)

- Critical: 0.
- High: 25, all in third-party components:
  - base image (Ubuntu 24.04): `libbrotli1` (fix available), GStreamer plug-ins (no fix yet);
  - bundled Java libraries: `jackson-core`, `jackson-databind` (fix available);
  - Node packages: `@azure/msal-node`, `basic-ftp`, `extract-zip`, `nodemailer`, `serialize-javascript`, `xlsx`.
- Plan: update these packages and the base image in the next version.

### Known limits

- Runs as one copy; script-generation progress lives in memory.
- AI features need the Anthropic API key in Key Vault (`anthropic-api-key`).
