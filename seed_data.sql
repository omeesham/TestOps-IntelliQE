-- ════════════════════════════════════════════════════════════════════════
--  JBS IntelliQE — seed data (Azure SQL / SQL Server, dbo schema)
-- ════════════════════════════════════════════════════════════════════════
--  Idempotent: safe to run multiple times. The application also seeds this
--  data automatically on startup (initDb() in backend/src/db.ts) — this file
--  is for manual provisioning against Azure SQL when desired.
--
--  Run with (example):
--    sqlcmd -S intelliqe-sql.database.windows.net -d JBSTestOpsAI -U <admin> -P <pwd> -i seed_data.sql
--  or locally:
--    docker exec -i intelliqe-db /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa \
--      -P "$MSSQL_SA_PASSWORD" -C -d JBSTestOpsAI -i seed_data.sql
-- ════════════════════════════════════════════════════════════════════════

SET NOCOUNT ON;

-- ─── Platform tenant ───
IF NOT EXISTS (SELECT 1 FROM dbo.tenants WHERE slug = 'jbs')
    INSERT INTO dbo.tenants (name, slug, is_platform)
    VALUES ('Jade Business Solutions', 'jbs', 1);

-- ─── Default users (password_hash stored as plaintext here; the app upgrades
--     to bcrypt on first password change. Comparison supports both.) ───
IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE username = 'jbsadmin')
    INSERT INTO dbo.users (tenant_id, username, password_hash, full_name, role)
    VALUES ((SELECT id FROM dbo.tenants WHERE slug = 'jbs'),
            'jbsadmin', 'Omeesha@19', 'JBS Admin', 'admin');

IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE username = 'qaengineer')
    INSERT INTO dbo.users (tenant_id, username, password_hash, full_name, role)
    VALUES ((SELECT id FROM dbo.tenants WHERE slug = 'jbs'),
            'qaengineer', 'Login@2026', 'QA Engineer', 'qa_engineer');

-- ─── QA agent types ───
MERGE INTO dbo.qa_agent_types AS t
USING (VALUES
    ('requirements', 'Requirements Agent', 'Explores live UI via MCP browser tools',      'FileSearch',  'core', 'haiku',  '.github/agents/playwright-requirements.agent.md',   1),
    ('planning',     'Test Planner',       'Creates comprehensive test cases and plans',   'Map',         'core', 'sonnet', '.github/agents/playwright-test-planner.agent.md',    2),
    ('generation',   'Test Generator',     'Generates Playwright spec files',              'Code',        'core', 'sonnet', '.github/agents/playwright-test-generator.agent.md',  3),
    ('healing',      'Test Healer',        'Debugs and fixes failing tests',               'Heart',       'core', 'sonnet', '.github/agents/playwright-test-healer.agent.md',     4),
    ('audit',        'Pipeline Audit',     'Reviews artifacts for quality',                'ShieldCheck', 'core', 'haiku',  '.github/agents/playwright-pipeline-audit.agent.md',  5)
) AS s (id, name, description, icon, category, default_model, agent_file, sort_order)
ON t.id = s.id
WHEN NOT MATCHED THEN
    INSERT (id, name, description, icon, category, default_model, agent_file, sort_order)
    VALUES (s.id, s.name, s.description, s.icon, s.category, s.default_model, s.agent_file, s.sort_order);

PRINT 'Seed data applied (idempotent).';
