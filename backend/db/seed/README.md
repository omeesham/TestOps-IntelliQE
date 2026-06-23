# JBS IntelliQE — Database Seed Files

This directory contains the canonical SQL that creates the entire
PostgreSQL schema the IntelliQE platform needs. Run it once against
an empty database and the application will boot without any further
migrations.

## What's in here

| File | Purpose | Re-runnable? |
|---|---|---|
| `01_schema.sql` | `CREATE SCHEMA` + 22 `CREATE TABLE` statements (with column-level documentation) | ✅ Idempotent |
| `02_indexes.sql` | ~20 performance indexes (tenant filters, run lookups, GIN tags, partial worker queue) | ✅ Idempotent |
| `03_seed_data.sql` | 1 platform tenant + 2 default users + 5 agent type rows | ✅ Idempotent (`ON CONFLICT DO NOTHING`) |
| `README.md` | This file | — |

## How to apply

### Local Postgres (most common)

```bash
# Assumes: createdb -U postgres intelliqe   (or just use the default `postgres` db)
export PGUSER=postgres
export PGPASSWORD=admin
export PGHOST=localhost
export PGDATABASE=postgres

psql -v ON_ERROR_STOP=1 -f 01_schema.sql
psql -v ON_ERROR_STOP=1 -f 02_indexes.sql
psql -v ON_ERROR_STOP=1 -f 03_seed_data.sql
```

### Managed Postgres (AWS RDS / Azure / GCP / Supabase / Neon)

```bash
export DATABASE_URL="postgres://user:pass@host:5432/dbname?sslmode=require"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 01_schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 02_indexes.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 03_seed_data.sql
```

### Through an AI/cloud agent

See `docs/DATABASE_SETUP_PROMPT.md` for a self-contained prompt you can
paste into Claude/ChatGPT/Copilot that will walk through the same steps
plus prerequisite checks and security hardening.

## Verification

After all three files run cleanly:

```sql
-- Should list 22 rows
SELECT tablename
  FROM pg_tables
 WHERE schemaname = 'JBSTestOpsAI'
 ORDER BY tablename;

-- Seed checks
SELECT COUNT(*) FROM "JBSTestOpsAI".tenants;          -- → 1
SELECT COUNT(*) FROM "JBSTestOpsAI".users;            -- → 2
SELECT COUNT(*) FROM "JBSTestOpsAI".qa_agent_types;   -- → 5
```

## After running the seed — REQUIRED for production

1. **Rotate the default passwords** — the seed file ships with plaintext
   placeholders. Replace them with bcrypt hashes:
   ```bash
   node -e "console.log(require('bcrypt').hashSync('<strong password>', 12))"
   ```
   ```sql
   UPDATE "JBSTestOpsAI".users
      SET password_hash = '<bcrypt hash>'
    WHERE username = 'jbsadmin';
   ```

2. **Set `ENCRYPTION_KEY`** in the application environment:
   ```bash
   openssl rand -base64 32      # produces a 32-byte Base64 key
   ```
   Without this, the app falls back to a deterministic dev key and
   prints a stderr warning on every boot.

## How this file stays in sync with the app

The canonical schema definition lives in `backend/src/db.ts → initDb()`.
These SQL files are the hand-curated equivalent — kept in lock-step so
they can be applied independently of running the Node.js process.

If you change the schema in code:
1. Update `backend/src/db.ts` (the runtime source of truth).
2. Mirror the change in `01_schema.sql` (CREATE) or add an
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` near the bottom of the
   relevant CREATE block.
3. Update the field tables in `docs/DATABASE_SCHEMA.md`.
4. Run `npm run build` to confirm TypeScript types still align.

## Customer-facing schema documentation

`docs/DATABASE_SCHEMA.md` — every table, every column, what data is
stored, sensitivity classification, retention policy, sample rows.
Share that file with security reviewers and compliance auditors.
