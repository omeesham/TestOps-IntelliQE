# JBS IntelliQE — Database Schema Reference

This document describes **every piece of data** the JBS IntelliQE platform
stores, why we store it, how long we keep it, and which fields are
considered sensitive. It is intended for customers, compliance reviewers,
security auditors, and engineers who need a complete picture of the
data footprint before approving an installation.

> **Where the schema lives**
> - PostgreSQL 14 or higher
> - Schema name: `"JBSTestOpsAI"` (case-sensitive, must be quoted in SQL)
> - 22 tables in 7 functional groups
> - Schema is created on first boot by `initDb()` in `backend/src/db.ts`
> - SQL equivalent: `backend/db/seed/01_schema.sql` (idempotent)

---

## At a glance

| Group | Tables | What it holds | Sensitivity |
|---|---|---|---|
| **A. Identity & Tenancy** | `tenants`, `users` | Organisations and the people in them | 🟡 PII (email, name) + 🔴 secrets (API keys, password hashes) |
| **B. Integrations** | `client_configurations` | Credentials + settings for third-party tools | 🔴 Secrets (encrypted) |
| **C. Chat** | `conversations`, `messages` | Wizard chat transcripts with the Tessa assistant | 🟡 May contain PII if user pastes it |
| **D. Test Authoring** | `test_runs`, `test_cases`, `automation_scripts`, `jira_connections` | Generated tests + scripts | 🟢 Mostly metadata; scripts may embed fixture data |
| **E. Pipeline** | 9 `qa_*` tables | AI agent orchestration state | 🟢 Operational, no customer PII |
| **F. Test Data** | `test_datasets`, `test_field_data`, `test_data_mapping` | Concrete values used to drive tests | 🟡 May embed PII if test data mirrors prod |
| **G. Audit** | `audit_log` | Immutable record of every state-changing action | 🟡 Captures who-did-what, when, from-which-IP |

> Legend: 🔴 secret, 🟡 PII / business data, 🟢 operational metadata.

---

## Group A — Identity & Tenancy

### `tenants` — Organisations

One row per customer organisation. Every other table in the schema filters by `tenant_id` so two customers can never see each other's data.

| Column | Type | Purpose | Example |
|---|---|---|---|
| `id` | UUID PK | Internal tenant identifier | `7f3cb6e6-7cce-49d9-9105-ea4ae92a0e2a` |
| `name` | VARCHAR(200) | Human-readable name | `"Acme Healthcare"` |
| `slug` | VARCHAR(100) UNIQUE | URL-safe shortname | `"acme"` |
| `is_platform` | BOOLEAN | `true` only for the JBS operator tenant | `false` |
| `anthropic_api_key` | TEXT 🔴 | Tenant's own Claude API key (AES-256-GCM at rest) | `__AES__abc123…` |
| `created_at` / `updated_at` | TIMESTAMPTZ | Timestamps | |

**Retention:** Permanent for the life of the contract. Deleting a tenant cascades through every other table.

### `users` — Authentication identities

Login accounts scoped to a tenant. Roles control what the user can see and do.

| Column | Type | Purpose | Example |
|---|---|---|---|
| `id` | UUID PK | Internal user id | |
| `tenant_id` | UUID FK | Which tenant they belong to | |
| `username` | VARCHAR(100) UNIQUE | Login name (globally unique) | `"jdoe"` |
| `password_hash` | VARCHAR(500) 🔴 | Bcrypt hash (recommended) | `"$2b$12$..."` |
| `email` | VARCHAR(300) 🟡 | Notification email | `"jdoe@acme.com"` |
| `full_name` | VARCHAR(200) 🟡 | Display name | `"Jane Doe"` |
| `role` | VARCHAR(50) | One of `admin`, `qa_engineer`, `data_analyst` | `"qa_engineer"` |
| `is_active` | BOOLEAN | Soft-disable flag (preserves audit history) | `true` |

**Retention:** Soft-deleted by setting `is_active=false`. Hard-delete only on tenant termination.

> **Security note:** The seed file `03_seed_data.sql` ships with plaintext placeholder passwords (`Omeesha@19`, `Login@2026`) that match dev defaults. Replace them with bcrypt hashes before going to production — see [Rotating the default users](#rotating-the-default-users) below.

---

## Group B — Integrations

### `client_configurations` — Connected third-party tools

One row per `(tenant, integration_id)` pair. Holds the credentials and settings for every external service the customer has connected.

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | Internal config id |
| `tenant_id` | UUID FK | Owning tenant |
| `integration_id` | VARCHAR(50) | e.g., `jira`, `confluence`, `sharepoint`, `github`, `gitlab`, `bitbucket`, `azure-blob`, `aws-s3`, `notif-email` |
| `category` | VARCHAR(30) | Grouping: `requirement-source`, `data-source`, `git-repo`, `notification`, `settings` |
| `status` | VARCHAR(20) | `connected` or `available` |
| `config_data` | JSONB 🔴 | Per-integration credentials + URLs (sensitive fields AES-encrypted by name) |
| `connected_by` | VARCHAR(100) | Username who connected it |
| `connected_at` / `last_sync_at` | TIMESTAMPTZ | When and last-used timestamps |

**Per-integration `config_data` shapes:**

| integration_id | Required JSON keys |
|---|---|
| `jira`, `confluence` | `url` / `jira_url`, `email`, `api_token` 🔴 |
| `sharepoint` | `siteUrl`, `tenantId` (Azure AD), `clientId`, `clientSecret` 🔴 |
| `github`, `gitlab` | `repo_url`, `branch`, `access_token` 🔴 |
| `bitbucket` | `repo_url`, `branch`, `username`, `app_password` 🔴 |
| `azure-blob` | `accountName`, `containerName`, `sasToken` 🔴 |
| `aws-s3` | `bucket`, `region`, `accessKeyId`, `secretAccessKey` 🔴 |
| `gcp-storage` | `projectId`, `bucket`, `serviceAccountKey` 🔴 (full JSON) |
| `notif-email` | `smtpHost`, `smtpPort`, `smtpUser`, `smtpPassword` 🔴, `fromEmail`, `toEmail`, `ccEmail` |

**Encryption:** Field-level AES-256-GCM. The set of "sensitive" key names is centralised in `backend/src/utils/crypto.ts → SENSITIVE_CONFIG_KEYS`. Encrypted values carry the `__AES__` prefix.

**Retention:** Permanent until the user disconnects the integration.

---

## Group C — Chat & Conversations

### `conversations` — Wizard sessions

One row per chat session the user opens with the Tessa assistant in the wizard.

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | Conversation id |
| `tenant_id` | UUID | Owning tenant |
| `username` | VARCHAR(100) | Who started it |
| `title` | VARCHAR(500) | First-line summary or user-chosen title |
| `created_at` / `updated_at` | TIMESTAMPTZ | Timestamps |

### `messages` — Individual chat turns

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | Message id |
| `conversation_id` | UUID FK | Parent conversation (CASCADE delete) |
| `role` | VARCHAR(20) | `user`, `assistant`, or `system` |
| `content` | TEXT 🟡 | Message body (PII-masked at write time by `sanitizeChatContent`) |
| `metadata` | JSONB | Agent name, tool call, model used, token counts |
| `created_at` | TIMESTAMPTZ | Time sent |

**PII guard:** `sanitizeChatContent` (in `backend/src/utils/crypto.ts`) redacts patterns that look like API keys, bearer tokens, AWS keys, and embedded credential JSON before the message is persisted.

**Retention:** Configurable per tenant; default is the life of the conversation. Customers can request deletion of an entire conversation at any time (CASCADE on `id` → wipes all `messages`).

---

## Group D — Test Authoring & Execution

### `test_runs` — Header per "Generate" invocation

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | Run id |
| `tenant_id` | UUID | Owning tenant |
| `username` | VARCHAR(100) | Who triggered it |
| `story_key` | VARCHAR(50) | Source identifier (Jira key, page id, "EXPLORE", "UPLOAD") |
| `story_title` | VARCHAR(500) | Human-readable title |
| `source` | VARCHAR(50) | `jira`, `confluence`, `sharepoint`, `upload`, `text`, `explore` |
| `columns` | JSONB | Which columns the user chose to display in the UI |
| `module` / `submodule` | VARCHAR(200) | Suite classification |

### `test_cases` — Individual IEEE-829 / ISTQB test cases

This is the customer-visible "deliverable" of the platform.

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | DB row id |
| `test_run_id` | UUID FK | Parent run (CASCADE delete) |
| `tc_number` | VARCHAR(20) | Stable id, e.g., `TC-001` |
| `title` | VARCHAR(1000) | "Verify <action> <object> <condition>" |
| `description` | TEXT | 2-3 sentence purpose statement |
| `precondition` | TEXT | Required state before execution |
| `steps` | JSONB | String array — legacy view format |
| `test_steps` | JSONB | Structured array `[{step, action, expected, testData?}]` (IEEE 829 style) |
| `test_data` | JSONB | Concrete values used (e.g., `{"email":"alice@example.com"}`) |
| `expected` | TEXT | Cumulative expected outcome |
| `priority` | VARCHAR(10) | `P0`–`P3` |
| `severity` | VARCHAR(20) | `Critical`, `Major`, `Moderate`, `Minor` |
| `type` | VARCHAR(50) | `positive`, `negative`, `edge`, `e2e`, `api`, `data`, `smoke`, `security`, `accessibility`, `performance` |
| `feature` / `module` / `submodule` | VARCHAR | Classification |
| `tags` | TEXT[] | Free-form filters (smoke, regression, sanity, etc.) |
| `traceability_id` | VARCHAR(100) | Link back to source requirement (Jira key, REQ-id) |
| `status` | VARCHAR(50) | `generated` → `automated` → `executed` → `passed`/`failed` |
| `sort_order` | INTEGER | UI ordering within a run |

### `jira_connections` — Legacy connection table

Deprecated dual-write target preserved for the periodic Jira sync job. New code reads from `client_configurations` first; this table will be removed in a future major release.

### `automation_scripts` — Generated Playwright spec files

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `tenant_id` / `test_run_id` / `test_case_id` | UUID | Ownership chain |
| `tc_number` / `test_case_title` | | Denormalised for display |
| `file_name` | VARCHAR(255) | e.g., `login-success.spec.ts` |
| `language` / `framework` | VARCHAR | `typescript` / `playwright` |
| `code` | TEXT 🟡 | Full source — may embed fixture data |
| `status` | VARCHAR(50) | `generated`, `executed`, `healed` |
| `last_run_at` / `last_run_result` | | Execution outcome |
| `version` | INTEGER | Bumps on each successful heal |

**Retention:** Stored with the test_run; same lifecycle.

---

## Group E — Pipeline Orchestration

9 tables that drive the multi-agent AI pipeline. These are operational
and contain no customer business data — only timing, costs, and the
intermediate artifacts each AI agent produces.

### `qa_pipeline_runs` — One row per multi-stage pipeline execution
Records `feature`, `module`, `intent`, `target_url`, current `stage`, `status`, `priority`, accumulated `cost`, and an optional `cascade_plan` for dependent re-runs.

### `qa_stage_results` — One row per `(run × stage)`
Captures `attempt`, `max_attempts`, `agent_model` used, per-stage `cost`, `result_data` JSON, and start/complete timestamps.

### `qa_artifacts` — Files produced by each stage
e.g., `requirement.md`, `test-plan.json`, `test-cases.json`, `*.spec.ts`. Includes version chain (`version`, `replaced_by`) so the UI can show diffs.

### `qa_worker_tasks` — Work queue for external workers
Workers poll for rows with `status='pending'`, claim them with `claimed_at = NOW()`, run the agent, and write `result` back. A partial index (`status='pending'`) makes polling cheap.

### `qa_agent_types` — Catalogue of available agents
Seeded with 5 core agents: `requirements`, `planning`, `generation`, `healing`, `audit`.

### `qa_pipeline_definitions` — Per-tenant pipeline overrides
Default lives in `backend/config/pipeline-definition.json`. Tenants who customise stage timeouts, budgets, or retry policies have their override JSON stored here.

### `qa_pages` — Application page tree
Logical pages of the application under test, organised parent → child. The dependency engine uses this to plan cascading re-runs when an upstream page changes.

### `qa_page_stage_status` — Per-page readiness cache
"Is this page ready for the next stage?" — cached so the orchestrator can resume runs without re-deriving status from raw artifacts each time.

### `qa_client_setup` — First-run onboarding state
Home URL discovery, authentication probe results, etc.

**Retention:** Pipeline data is operational. Customers can request archival to cold storage at any time; nothing here is required for billing reconciliation beyond the `cost` columns, which are retained for 7 years per typical SaaS practice.

---

## Group F — Test Data

Three small tables that let the generator agent produce data-driven tests.

### `test_datasets`
Named collections — e.g., `dataset_id="DS-01"`, `role="Customer"`, `scenario="US billing address"`, `fields={"email":"…","zip":"02101"}`.

### `test_field_data`
Individual valid/invalid values per field name, tagged with their data type and the rule they exercise (`RFC-5322 email`, `Luhn-valid card`, `MIN-LENGTH-8`).

### `test_data_mapping`
Bridge table: which test case uses which dataset.

**Sensitivity note:** If a customer seeds these tables with real production data (PII), the platform treats them like any other PII column — never shown in logs, encrypted on backup at the storage layer.

---

## Group G — Audit

### `audit_log` — HIPAA-style immutable record

Every state-changing API request writes one row here.

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `tenant_id` | UUID FK | Owning tenant |
| `user_id` / `username` | | Who did it |
| `request_id` | UUID | Per-HTTP-request correlation id (set by `request-context` middleware) |
| `action` | VARCHAR(50) | e.g., `create`, `update`, `delete`, `connect_integration` |
| `resource_type` | VARCHAR(50) | e.g., `test_case`, `client_configuration`, `user` |
| `resource_id` | VARCHAR(200) | The affected row's id |
| `details` | JSONB | Before/after diff, PII-masked |
| `ip_address` | VARCHAR(50) | Source IP at request time |
| `created_at` | TIMESTAMPTZ | When |

**Append-only.** No application code ever issues UPDATE or DELETE against this table.

**Retention:** Minimum 7 years (HIPAA recommendation). Customers in regulated industries can extend further via backup retention policies.

---

## Sample data — what a real row looks like

### `test_cases` (the most customer-visible row)

```json
{
  "id": "8a1f0c2e-…",
  "test_run_id": "5d49…",
  "tc_number": "TC-007",
  "title": "Verify login fails when password is correct but account is locked",
  "description": "Confirms the system enforces lockout after 5 failed attempts even when the 6th attempt uses the correct password. Mitigates account-takeover risk via brute-force replay.",
  "precondition": "User account 'alice@acme.com' exists; 5 failed login attempts recorded in the last 15 minutes.",
  "test_data": { "email": "alice@acme.com", "password": "Correct@2026" },
  "test_steps": [
    { "step": 1, "action": "Navigate to /login", "expected": "Login form is shown" },
    { "step": 2, "action": "Enter email 'alice@acme.com'", "expected": "Email field accepts the value" },
    { "step": 3, "action": "Enter password 'Correct@2026'", "expected": "Password field accepts the value (masked)" },
    { "step": 4, "action": "Click 'Sign In'", "expected": "Error 'Account locked. Try again in 14 minutes.' is shown; user remains on /login" }
  ],
  "steps": ["1. Navigate to /login → Expected: Login form is shown", "2. Enter email 'alice@acme.com' → …", "…"],
  "expected": "Login is rejected with a clear lockout message; no session cookie is set.",
  "type": "security",
  "priority": "P0",
  "severity": "Critical",
  "feature": "Authentication",
  "module": "Account",
  "submodule": "Login",
  "tags": ["smoke", "auth", "security"],
  "traceability_id": "REQ-AUTH-LOCKOUT-01",
  "status": "generated"
}
```

---

## Operational concerns

### Rotating the default users

1. Generate fresh bcrypt hashes:
   ```bash
   node -e "console.log(require('bcrypt').hashSync('YourStrongPassword', 12))"
   ```
2. Update the rows:
   ```sql
   UPDATE "JBSTestOpsAI".users
      SET password_hash = '<bcrypt hash from step 1>'
    WHERE username IN ('jbsadmin', 'qaengineer');
   ```
3. Set `is_active = false` for any account you don't recognise.

### Encryption at rest

- `ENCRYPTION_KEY` env var must be a Base64-encoded 32-byte key in production.
- Generate one with: `openssl rand -base64 32`
- Without it, the application falls back to a deterministic dev key and prints a stderr warning — **never** acceptable in production.

### Backups

- Standard `pg_dump --format=custom` works for full backups.
- For point-in-time recovery, use WAL archiving (`archive_mode=on`).
- Decrypted backups must be stored in the same security tier as the production database — encrypted columns remain encrypted in `pg_dump` output, but the snapshot itself should still be encrypted at the storage layer.

### Multi-tenant isolation

The application's auth middleware attaches `tenant_id` to every request and the data-access layer adds `WHERE tenant_id = $1` to every query. Cross-tenant queries are only possible from the platform tenant's admin role and are logged in `audit_log`.

---

## How this document is maintained

This document is hand-curated from the live schema in
`backend/src/db.ts → initDb()`. The SQL equivalent in
`backend/db/seed/01_schema.sql` is kept in lock-step. If you change the
schema, update **all three** locations and run `npm run build` to
confirm types still align.
