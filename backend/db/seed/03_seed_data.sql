-- =====================================================================
-- JBS IntelliQE — Initial Seed Data
-- =====================================================================
-- Inserts the bare minimum rows the application needs to boot:
--   • One platform tenant (Jade Business Solutions, slug='jbs')
--   • Two default users (admin + qa_engineer)
--   • Five core agent type definitions
--
-- ⚠️  SECURITY:
--   The default user passwords below are PLAINTEXT placeholders that
--   match the existing dev defaults in backend/src/db.ts. They are NOT
--   safe for production. Before exposing the API to anyone other than
--   you on localhost, run the password-hash migration documented in
--   docs/DATABASE_SCHEMA.md → "Rotating the default users".
--
-- Run AFTER 01_schema.sql + 02_indexes.sql.
-- All inserts use ON CONFLICT DO NOTHING so this file is idempotent.
-- =====================================================================

SET search_path TO "JBSTestOpsAI";

-- ─── Platform tenant ─────────────────────────────────────────────────
-- The platform tenant is the operator of the system. is_platform=true
-- grants its admins elevated access to cross-tenant data (used for
-- support / debugging only — every other tenant is fully isolated).
INSERT INTO "JBSTestOpsAI".tenants (name, slug, is_platform)
VALUES ('Jade Business Solutions', 'jbs', true)
ON CONFLICT (slug) DO NOTHING;

-- ─── Default users ───────────────────────────────────────────────────
-- ⚠️  REPLACE the password_hash values with bcrypt hashes before
-- exposing this database to the network. Example one-liner:
--   node -e "console.log(require('bcrypt').hashSync('YourStrongPwd', 12))"
INSERT INTO "JBSTestOpsAI".users (tenant_id, username, password_hash, full_name, role)
VALUES
    ((SELECT id FROM "JBSTestOpsAI".tenants WHERE slug = 'jbs'),
        'jbsadmin',   'Omeesha@19', 'JBS Admin',   'admin'),
    ((SELECT id FROM "JBSTestOpsAI".tenants WHERE slug = 'jbs'),
        'qaengineer', 'Login@2026', 'QA Engineer', 'qa_engineer')
ON CONFLICT (username) DO NOTHING;

-- ─── Agent types ─────────────────────────────────────────────────────
-- The five core AI agents the platform invokes during a test-generation
-- pipeline. Each row points at a markdown file under .github/agents/
-- that holds the agent's system prompt (loaded by the worker at runtime).
INSERT INTO "JBSTestOpsAI".qa_agent_types
    (id,             name,                 description,                                       icon,         category, default_model, agent_file,                                                  sort_order)
VALUES
    ('requirements', 'Requirements Agent', 'Explores live UI via MCP browser tools',          'FileSearch', 'core',   'haiku',       '.github/agents/playwright-requirements.agent.md',           1),
    ('planning',     'Test Planner',       'Creates comprehensive test cases and plans',      'Map',        'core',   'sonnet',      '.github/agents/playwright-test-planner.agent.md',           2),
    ('generation',   'Test Generator',     'Generates Playwright spec files',                 'Code',       'core',   'sonnet',      '.github/agents/playwright-test-generator.agent.md',         3),
    ('healing',      'Test Healer',        'Debugs and fixes failing tests',                  'Heart',      'core',   'sonnet',      '.github/agents/playwright-test-healer.agent.md',            4),
    ('audit',        'Pipeline Audit',     'Reviews artifacts for quality',                   'ShieldCheck','core',   'haiku',       '.github/agents/playwright-pipeline-audit.agent.md',         5)
ON CONFLICT (id) DO NOTHING;

-- =====================================================================
-- DONE. The application can now be started against this database.
--
-- Verification queries:
--   SELECT COUNT(*) FROM "JBSTestOpsAI".tenants;           -- → 1
--   SELECT COUNT(*) FROM "JBSTestOpsAI".users;             -- → 2
--   SELECT COUNT(*) FROM "JBSTestOpsAI".qa_agent_types;    -- → 5
-- =====================================================================
