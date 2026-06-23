# JBS IntelliQE — Database Setup Prompt

> **How to use this file**
> Paste the contents below into Claude, ChatGPT, or any other AI agent
> that has access to your cloud Postgres credentials. The agent will
> follow the steps end-to-end and create a fully functional database
> for the IntelliQE platform.
>
> The prompt is **self-contained**: it does not assume the agent has
> read any other file. It tells the agent exactly which files to use
> and in what order.

---

```
You are setting up the PostgreSQL database for the JBS IntelliQE
platform — an AI-powered QA test automation system. Your job is to
create the schema, indexes, and initial seed data exactly as specified
below. The database must be ready for the application to boot against
without any further migrations.

═══════════════════════════════════════════════════════════════════
ENVIRONMENT
═══════════════════════════════════════════════════════════════════
- PostgreSQL 14 or higher (required for NULLS NOT DISTINCT in unique
  constraints — used by qa_pipeline_definitions).
- The database itself may be a managed service (AWS RDS, Azure Database
  for PostgreSQL, Google Cloud SQL, Supabase, Neon, etc.) or self-hosted.
- The schema name MUST be exactly: "JBSTestOpsAI"  (quoted, case-sensitive).
- The application connects via the DATABASE_URL env var or the
  individual DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME vars.
- Connection options set search_path so unqualified names resolve.

═══════════════════════════════════════════════════════════════════
PREREQUISITES (do these FIRST)
═══════════════════════════════════════════════════════════════════
1. Confirm you can reach the target Postgres instance:
       psql "$DATABASE_URL" -c "SELECT version();"
   Expect a version string starting "PostgreSQL 14" or higher.

2. Confirm the connecting role has CREATE privilege on the database:
       psql "$DATABASE_URL" -c "SELECT has_database_privilege(current_user, current_database(), 'CREATE');"
   Expect "t" (true). If false, ask the user for a role that has it
   (typically the owner or a member of the rds_superuser group).

3. Verify the `pgcrypto` extension OR Postgres >= 13 (which has
   gen_random_uuid() built-in). For Postgres < 13 you must run:
       CREATE EXTENSION IF NOT EXISTS pgcrypto;
   For 13+ this is unnecessary — gen_random_uuid() is in the core.

═══════════════════════════════════════════════════════════════════
FILES YOU WILL APPLY (in order)
═══════════════════════════════════════════════════════════════════
All three live under `backend/db/seed/` in the IntelliQE repo:

1. backend/db/seed/01_schema.sql
   Creates the schema "JBSTestOpsAI" and 22 tables across 7 groups:
     A. Identity & Tenancy        (tenants, users)
     B. Integrations              (client_configurations)
     C. Chat                      (conversations, messages)
     D. Test Authoring            (test_runs, test_cases, jira_connections, automation_scripts)
     E. Pipeline Orchestration    (9 qa_* tables)
     F. Test Data                 (test_datasets, test_field_data, test_data_mapping)
     G. Audit                     (audit_log)
   All CREATE statements use IF NOT EXISTS — safe to re-run.

2. backend/db/seed/02_indexes.sql
   Creates ~20 performance indexes (tenant filters, run lookups,
   message threads, audit queries, plus a GIN index on test_cases.tags
   and a partial index on qa_worker_tasks for the pending-task queue).

3. backend/db/seed/03_seed_data.sql
   Inserts:
     • One platform tenant (slug='jbs')
     • Two default users (jbsadmin, qaengineer)
       ⚠ The shipped passwords are PLAINTEXT placeholders. You MUST
         replace them with bcrypt hashes before exposing the API
         (see step 6 below).
     • Five core agent type rows (requirements, planning, generation,
       healing, audit).

═══════════════════════════════════════════════════════════════════
EXECUTION STEPS
═══════════════════════════════════════════════════════════════════
Run each step and stop if any step errors. Re-run safety: every step
is idempotent — if it has already been applied, it will be a no-op.

Step 1 — Apply the schema
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/db/seed/01_schema.sql

   Expected output: "CREATE SCHEMA" then many "CREATE TABLE" / "ALTER TABLE"
   lines. No errors.

Step 2 — Apply the indexes
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/db/seed/02_indexes.sql

   Expected output: "CREATE INDEX" lines (or "NOTICE: relation … already
   exists, skipping" on a re-run).

Step 3 — Apply the seed data
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/db/seed/03_seed_data.sql

   Expected output: "INSERT 0 1" / "INSERT 0 2" / "INSERT 0 5" for the
   three blocks, OR "INSERT 0 0" if the rows already exist.

Step 4 — Verify the schema
   Run:
       psql "$DATABASE_URL" -c '\dt "JBSTestOpsAI".*'
   You should see all 22 tables. If any are missing, re-run Step 1.

Step 5 — Verify the seed
   Run all three:
       psql "$DATABASE_URL" -c 'SELECT COUNT(*) FROM "JBSTestOpsAI".tenants;'
       psql "$DATABASE_URL" -c 'SELECT COUNT(*) FROM "JBSTestOpsAI".users;'
       psql "$DATABASE_URL" -c 'SELECT COUNT(*) FROM "JBSTestOpsAI".qa_agent_types;'
   Expected counts: 1, 2, 5.

Step 6 — Rotate the default passwords (REQUIRED before any non-localhost use)
   The seed file ships with PLAINTEXT placeholder passwords. Replace
   them with bcrypt hashes (cost 12+):

   a. Generate hashes (any language — bcrypt is standard):
        node -e "console.log(require('bcrypt').hashSync('<your strong password>', 12))"

   b. Apply them:
        UPDATE "JBSTestOpsAI".users
           SET password_hash = '<hash from step a>'
         WHERE username = 'jbsadmin';
        UPDATE "JBSTestOpsAI".users
           SET password_hash = '<different hash>'
         WHERE username = 'qaengineer';

   c. If neither default user is needed (you have your own SSO/JWT
      identity provider), set them inactive instead:
        UPDATE "JBSTestOpsAI".users
           SET is_active = false
         WHERE username IN ('jbsadmin', 'qaengineer');

Step 7 — Set the encryption key (REQUIRED for production)
   The application encrypts integration credentials (Jira tokens, Azure
   SAS, GitHub PATs, etc.) at rest with AES-256-GCM. The key comes from
   the ENCRYPTION_KEY env var.

   a. Generate the key:
        openssl rand -base64 32
   b. Set it in the application's environment (NOT in the DB):
        ENCRYPTION_KEY=<output of step a>
   c. Without this, the app falls back to a deterministic dev key
      and prints "[crypto] ENCRYPTION_KEY not set — using DEV fallback"
      on every boot. That is acceptable for localhost only.

Step 8 — Hand the database back to the application
   The application boots with `npm start` (or `npm run dev`). On boot
   it calls initDb() which is itself idempotent — it will only ADD
   missing columns and seed rows. It will NOT undo anything you have
   done here.

═══════════════════════════════════════════════════════════════════
WHAT GETS STORED IN THIS DATABASE
═══════════════════════════════════════════════════════════════════
See docs/DATABASE_SCHEMA.md for a customer-facing field-by-field tour.
Brief summary by sensitivity:

  🔴 Encrypted-at-rest secrets:
        - tenants.anthropic_api_key
        - users.password_hash (bcrypt; one-way)
        - client_configurations.config_data (per-field AES on
          credential keys defined in SENSITIVE_CONFIG_KEYS)
        - jira_connections.auth_header (legacy)

  🟡 PII / business content:
        - users.email, users.full_name
        - messages.content (sanitised by sanitizeChatContent at write)
        - test_cases / test_data may contain customer fixture values
        - audit_log.ip_address, audit_log.details

  🟢 Operational metadata (no PII):
        - All qa_* pipeline tables (timing, cost, agent prompts/results)
        - Index names, schema metadata, sort_order columns

═══════════════════════════════════════════════════════════════════
DISASTER-RECOVERY PROCEDURE
═══════════════════════════════════════════════════════════════════
If you have a backup:
  1. Restore with pg_restore (or your provider's restore UI).
  2. Confirm Step 4 + Step 5 still pass.
  3. Bring the application back up.

If you do NOT have a backup and need to start over:
  1. Drop the schema:
        DROP SCHEMA "JBSTestOpsAI" CASCADE;
  2. Re-run Steps 1–8 above.
  3. The application will start clean. All test cases and pipeline
     history will be GONE — only the seed data survives.

═══════════════════════════════════════════════════════════════════
TROUBLESHOOTING
═══════════════════════════════════════════════════════════════════
Q: "permission denied for schema JBSTestOpsAI"
A: The connecting role lacks CREATE / USAGE on the schema. Grant it:
        GRANT USAGE, CREATE ON SCHEMA "JBSTestOpsAI" TO <role>;
        GRANT ALL ON ALL TABLES IN SCHEMA "JBSTestOpsAI" TO <role>;
        ALTER DEFAULT PRIVILEGES IN SCHEMA "JBSTestOpsAI"
            GRANT ALL ON TABLES TO <role>;

Q: "function gen_random_uuid() does not exist"
A: You are on Postgres < 13. Run:
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
   Then re-run Step 1.

Q: "syntax error near NULLS NOT DISTINCT"
A: You are on Postgres < 15. The qa_pipeline_definitions UNIQUE
   constraint uses this feature. Either:
   - Upgrade to Postgres 15+, OR
   - Edit 01_schema.sql to remove the constraint and enforce
     "one row per tenant" at the application layer.

Q: "duplicate key value violates unique constraint tenants_slug_key"
A: You already have a tenant with slug='jbs'. Either change the seed
   data's slug OR skip Step 3 entirely (the application boots fine
   against an existing seeded tenant).

═══════════════════════════════════════════════════════════════════
SUCCESS CRITERIA — REPORT THESE BACK TO THE USER
═══════════════════════════════════════════════════════════════════
After running Steps 1–6 successfully, output:
  ✓ Schema "JBSTestOpsAI" created with 22 tables
  ✓ All performance indexes installed
  ✓ Seed data loaded (1 tenant, 2 users, 5 agent types)
  ✓ Default passwords rotated to bcrypt hashes (or accounts disabled)
  ✓ ENCRYPTION_KEY set in the application environment
  ✓ Database is ready for application boot

If any step failed, output:
  ✗ <step number> failed at <command>
    Error: <full error message>
    Recommended fix: <one of the troubleshooting items above>
```

---

## Why this file exists

You asked for a deliverable you could hand to a cloud agent or AI
helper and have the database recreated end-to-end. The prompt above
references the three SQL files in `backend/db/seed/`, walks the agent
through prerequisites, execution, verification, and security
hardening, and includes troubleshooting for the most common managed-
Postgres gotchas. If you ever lose the database, paste the block
between the triple backticks into your AI of choice along with access
to the seed files and you'll be back up in minutes.
