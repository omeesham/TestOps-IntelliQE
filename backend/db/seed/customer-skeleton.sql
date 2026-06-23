-- =====================================================================
-- IntelliQE — Reusable Database Skeleton (Postgres 14+)
-- =====================================================================
-- A CUSTOMER-NEUTRAL copy of the JBSTestOpsAI schema, stripped of all
-- JBS-specific seed data (no hard-coded tenant, no plaintext passwords).
-- Use this to stand up the same schema in a customer's own database.
--
-- Mirrors backend/src/db.ts -> initDb() (the runtime source of truth) and
-- backend/db/seed/01_schema.sql + 02_indexes.sql, minus 03_seed_data.sql.
--
-- ── HOW TO REUSE FOR A CUSTOMER ─────────────────────────────────────
--   1. Pick a schema name. Default below is "JBSTestOpsAI". To rebrand,
--      find/replace "JBSTestOpsAI" with the customer's schema name
--      (e.g. "AcmeTestOps") everywhere in this file, and set the same
--      value in the app's search_path (backend/src/db.ts / DATABASE_URL).
--   2. Run this file once against an empty database:
--        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f customer-skeleton.sql
--   3. Insert the customer's OWN platform tenant + admin user (template at
--      the bottom of this file). Never reuse JBS credentials.
--   4. Set ENCRYPTION_KEY in the app env (openssl rand -base64 32) so the
--      AES-256-GCM at-rest encryption uses a real key, not the dev fallback.
--
-- All statements are idempotent (CREATE ... IF NOT EXISTS), so re-running
-- this file is safe.
--
-- Total tables: 22
--   Group A — Identity / Tenancy            (2)  tenants, users
--   Group B — Integration Configurations    (1)  client_configurations
--   Group C — Chat & Conversations          (2)  conversations, messages
--   Group D — Test Authoring & Execution    (4)  jira_connections, test_runs,
--                                                test_cases, automation_scripts
--   Group E — Pipeline Orchestration        (9)  qa_pipeline_runs, qa_stage_results,
--                                                qa_artifacts, qa_worker_tasks,
--                                                qa_agent_types, qa_pipeline_definitions,
--                                                qa_pages, qa_page_stage_status,
--                                                qa_client_setup
--   Group F — Test Data                     (3)  test_datasets, test_field_data,
--                                                test_data_mapping
--   Group G — Audit                         (1)  audit_log
--
-- Sensitive columns (encrypt at rest — prefix __AES__ / __ENC__):
--   tenants.anthropic_api_key, users.password_hash (use bcrypt),
--   client_configurations.config_data (per-key), jira_connections.auth_header
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS "JBSTestOpsAI";
SET search_path TO "JBSTestOpsAI";

-- pgcrypto provides gen_random_uuid() on older Postgres; 13+ has it built in.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────
-- Group A — Identity / Tenancy
-- ─────────────────────────────────────────────────────────────────────

-- 1. Tenants (organizations). Every other table filters by tenant_id.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".tenants (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              VARCHAR(200) NOT NULL,
    slug              VARCHAR(100) NOT NULL UNIQUE,
    is_platform       BOOLEAN NOT NULL DEFAULT false,   -- elevated cross-tenant access
    anthropic_api_key TEXT,                             -- AES-encrypted at rest
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Users. Auth middleware resolves a token to a row here.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES "JBSTestOpsAI".tenants(id),
    username      VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(500) NOT NULL,               -- store a bcrypt hash
    email         VARCHAR(300),
    full_name     VARCHAR(200),
    role          VARCHAR(50) NOT NULL DEFAULT 'qa_engineer'
                  CHECK (role IN ('admin', 'qa_engineer', 'data_analyst')),
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────
-- Group B — Integration Configurations
-- ─────────────────────────────────────────────────────────────────────

-- 3. Per-tenant integration configs (Jira, Git, Confluence, SharePoint, …).
--    Sensitive keys inside config_data are field-level encrypted.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".client_configurations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES "JBSTestOpsAI".tenants(id),
    integration_id VARCHAR(50) NOT NULL,
    category       VARCHAR(30) DEFAULT 'integration',
    status         VARCHAR(20) NOT NULL DEFAULT 'available'
                   CHECK (status IN ('connected', 'available')),
    config_data    JSONB NOT NULL DEFAULT '{}',
    connected_by   VARCHAR(100),
    connected_at   TIMESTAMPTZ,
    last_sync_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, integration_id)
);

-- ─────────────────────────────────────────────────────────────────────
-- Group C — Chat & Conversations
-- ─────────────────────────────────────────────────────────────────────

-- 4. Chat conversations (the ChatPage wizard flow).
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".conversations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID,
    username   VARCHAR(100) NOT NULL,
    title      VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Messages within a conversation.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES "JBSTestOpsAI".conversations(id) ON DELETE CASCADE,
    role            VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content         TEXT NOT NULL,
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────
-- Group D — Test Authoring & Execution
-- ─────────────────────────────────────────────────────────────────────

-- 6. Jira connections (per user/tenant).
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".jira_connections (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID,
    username     VARCHAR(100) NOT NULL UNIQUE,
    jira_url     VARCHAR(500) NOT NULL,
    auth_header  TEXT NOT NULL,                         -- encrypted at rest
    display_name VARCHAR(200),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Test runs (a batch of generated test cases for a story/module).
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".test_runs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID,
    username    VARCHAR(100) NOT NULL,
    story_key   VARCHAR(50),
    story_title VARCHAR(500),
    source      VARCHAR(50),
    columns     JSONB NOT NULL DEFAULT '[]',
    module      VARCHAR(200),
    submodule   VARCHAR(200),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Test cases (IEEE-829 style). Note legacy `steps` + newer `test_steps`.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".test_cases (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_run_id    UUID NOT NULL REFERENCES "JBSTestOpsAI".test_runs(id) ON DELETE CASCADE,
    tc_number      VARCHAR(20) NOT NULL,
    title          VARCHAR(1000) NOT NULL,
    steps          JSONB NOT NULL DEFAULT '[]',
    expected       TEXT,
    priority       VARCHAR(10),
    type           VARCHAR(50),
    feature        VARCHAR(200),
    precondition   TEXT,
    status         VARCHAR(50) DEFAULT 'generated',
    sort_order     INTEGER NOT NULL DEFAULT 0,
    module         VARCHAR(200),
    submodule      VARCHAR(200),
    tags           TEXT[] NOT NULL DEFAULT '{}',
    -- Professional / IEEE-829 fields
    description    TEXT,
    test_steps     JSONB DEFAULT '[]',
    test_data      JSONB DEFAULT '{}',
    severity       VARCHAR(20),
    traceability_id VARCHAR(100),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Generated automation scripts (Playwright by default).
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".automation_scripts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    test_run_id     UUID NOT NULL,
    test_case_id    UUID NOT NULL,
    tc_number       VARCHAR(50),
    test_case_title TEXT,
    file_name       VARCHAR(255),
    language        VARCHAR(50) DEFAULT 'typescript',
    framework       VARCHAR(50) DEFAULT 'playwright',
    code            TEXT,
    status          VARCHAR(50) DEFAULT 'generated',
    last_run_at     TIMESTAMPTZ,
    last_run_result VARCHAR(50),
    version         INTEGER DEFAULT 1,
    created_by      VARCHAR(100),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT automation_scripts_unique_tc_per_run UNIQUE (test_run_id, test_case_id)
);

-- ─────────────────────────────────────────────────────────────────────
-- Group E — Pipeline Orchestration (core AI engine)
-- ─────────────────────────────────────────────────────────────────────

-- 10. Pipeline runs — one row per orchestrated generation/healing run.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_pipeline_runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID REFERENCES "JBSTestOpsAI".tenants(id),
    feature             TEXT NOT NULL,
    module              TEXT NOT NULL,
    intent              TEXT NOT NULL,
    target_url          TEXT,
    stage               TEXT NOT NULL DEFAULT 'queued',
    status              TEXT NOT NULL DEFAULT 'queued',
    priority            TEXT NOT NULL DEFAULT 'medium',
    cost                NUMERIC(10,4) DEFAULT 0,
    page_id             UUID,
    cascade_plan        JSONB,
    batch_id            UUID,
    execution_mode_live TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Per-stage results within a run.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_stage_results (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id       UUID NOT NULL REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE CASCADE,
    stage_id     TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    attempt      INT DEFAULT 1,
    max_attempts INT DEFAULT 1,
    agent_model  TEXT,
    cost         NUMERIC(10,4) DEFAULT 0,
    result_data  JSONB,
    started_at   TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 12. Artifacts produced by stages (requirements, plans, scripts, reports).
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_artifacts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id      UUID NOT NULL REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    content     TEXT,
    metadata    JSONB,
    page_id     UUID,
    version     INT DEFAULT 1,
    replaced_by UUID,
    edited_by   TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 13. Worker task queue — workers poll this for pending AI work.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_worker_tasks (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id       UUID NOT NULL REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE CASCADE,
    tenant_id    UUID,
    stage_id     TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    agent_prompt TEXT NOT NULL,
    context      JSONB,
    result       JSONB,
    claimed_at   TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 14. Agent type catalog (which AI agents exist, model + prompt file).
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_agent_types (
    id            VARCHAR(100) PRIMARY KEY,
    name          VARCHAR(200) NOT NULL,
    description   TEXT,
    icon          VARCHAR(100) DEFAULT 'Bot',
    category      VARCHAR(50) DEFAULT 'core',
    default_model VARCHAR(50) DEFAULT 'sonnet',
    agent_file    TEXT,
    capabilities  TEXT[],
    enabled       BOOLEAN DEFAULT true,
    sort_order    INTEGER DEFAULT 0,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 15. Pipeline definitions (stage graph, budgets, guards) — per tenant override.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_pipeline_definitions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID,
    definition JSONB NOT NULL,
    version    INTEGER DEFAULT 1,
    created_by VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_qa_pipeline_def_tenant UNIQUE NULLS NOT DISTINCT (tenant_id)
);

-- 16. Pages — hierarchical map of the application-under-test.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_pages (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID,
    module         TEXT NOT NULL,
    page_slug      TEXT NOT NULL,
    display_name   TEXT NOT NULL,
    target_url     TEXT,
    parent_page_id UUID REFERENCES "JBSTestOpsAI".qa_pages(id) ON DELETE SET NULL,
    depth          INT DEFAULT 0,
    sort_order     INT DEFAULT 0,
    metadata       JSONB,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_qa_page_tenant_module_slug UNIQUE (tenant_id, module, page_slug)
);

-- 17. Per-page, per-stage readiness/approval status (dependency engine).
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_page_stage_status (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id              UUID NOT NULL REFERENCES "JBSTestOpsAI".qa_pages(id) ON DELETE CASCADE,
    stage_id             TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'not_started',
    active_run_id        UUID REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE SET NULL,
    last_run_id          UUID REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE SET NULL,
    last_completed_at    TIMESTAMPTZ,
    artifact_summary     JSONB,
    approved_by          TEXT,
    approved_at          TIMESTAMPTZ,
    explore_without_reqs BOOLEAN DEFAULT false,
    explore_permitted_by TEXT,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_qa_page_stage UNIQUE (page_id, stage_id)
);

-- 18. One-time client onboarding/setup state (home URL, auth, setup run).
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_client_setup (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL UNIQUE,
    status       TEXT NOT NULL DEFAULT 'pending',
    home_url     TEXT,
    auth_config  JSONB,
    setup_config JSONB,
    setup_run_id UUID REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE SET NULL,
    initiated_by TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────
-- Group F — Test Data (data-aware generation)
-- ─────────────────────────────────────────────────────────────────────

-- 19. Datasets (a named set of field values for a role/scenario).
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".test_datasets (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    test_run_id   UUID NOT NULL REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE CASCADE,
    dataset_id    VARCHAR(20) NOT NULL,
    role          VARCHAR(100) NOT NULL,
    scenario      VARCHAR(500),
    fields        JSONB NOT NULL DEFAULT '{}',
    layer         VARCHAR(10) DEFAULT 'ui'    CHECK (layer  IN ('ui', 'api', 'both')),
    source        VARCHAR(20) DEFAULT 'static' CHECK (source IN ('static', 'database', 'mixed')),
    source_config JSONB,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 20. Individual field values (valid/invalid) for data-driven tests.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".test_field_data (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    test_run_id     UUID NOT NULL REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE CASCADE,
    field_data_id   VARCHAR(20) NOT NULL,
    field_name      VARCHAR(200) NOT NULL,
    value           TEXT,
    type            VARCHAR(10) DEFAULT 'valid'  CHECK (type   IN ('valid', 'invalid')),
    data_type       VARCHAR(50),
    validation_rule VARCHAR(200),
    source          VARCHAR(20) DEFAULT 'static' CHECK (source IN ('static', 'database', 'api', 'computed')),
    source_detail   VARCHAR(500),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 21. Mapping of test cases to datasets.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".test_data_mapping (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    test_run_id  UUID NOT NULL REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE CASCADE,
    test_case_id VARCHAR(20) NOT NULL,
    dataset_id   VARCHAR(20) NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────
-- Group G — Audit
-- ─────────────────────────────────────────────────────────────────────

-- 22. HIPAA-style audit log. request_id ties rows to one API request.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".audit_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES "JBSTestOpsAI".tenants(id),
    user_id       UUID,
    username      VARCHAR(100) NOT NULL,
    request_id    UUID,
    action        VARCHAR(50) NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    resource_id   VARCHAR(200),
    details       JSONB DEFAULT '{}',
    ip_address    VARCHAR(50),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_tenant            ON "JBSTestOpsAI".users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_client_configs_tenant   ON "JBSTestOpsAI".client_configurations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_conversations_username  ON "JBSTestOpsAI".conversations(username);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant    ON "JBSTestOpsAI".conversations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation   ON "JBSTestOpsAI".messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_jira_connections_tenant ON "JBSTestOpsAI".jira_connections(tenant_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_tenant        ON "JBSTestOpsAI".test_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_module        ON "JBSTestOpsAI".test_runs(module);
CREATE INDEX IF NOT EXISTS idx_test_cases_run          ON "JBSTestOpsAI".test_cases(test_run_id);
CREATE INDEX IF NOT EXISTS idx_test_cases_module       ON "JBSTestOpsAI".test_cases(module);
CREATE INDEX IF NOT EXISTS idx_test_cases_tags         ON "JBSTestOpsAI".test_cases USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_automation_scripts_tenant ON "JBSTestOpsAI".automation_scripts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_automation_scripts_run    ON "JBSTestOpsAI".automation_scripts(test_run_id);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time       ON "JBSTestOpsAI".audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_request           ON "JBSTestOpsAI".audit_log(request_id);
CREATE INDEX IF NOT EXISTS idx_qa_runs_tenant          ON "JBSTestOpsAI".qa_pipeline_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_qa_runs_status          ON "JBSTestOpsAI".qa_pipeline_runs(status);
CREATE INDEX IF NOT EXISTS idx_qa_runs_page            ON "JBSTestOpsAI".qa_pipeline_runs(page_id);
CREATE INDEX IF NOT EXISTS idx_qa_stage_run            ON "JBSTestOpsAI".qa_stage_results(run_id);
CREATE INDEX IF NOT EXISTS idx_qa_artifacts_run        ON "JBSTestOpsAI".qa_artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_qa_worker_tasks_status  ON "JBSTestOpsAI".qa_worker_tasks(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_qa_pages_tenant         ON "JBSTestOpsAI".qa_pages(tenant_id);

-- ─────────────────────────────────────────────────────────────────────
-- Seed: agent catalog (safe to ship — no secrets, app needs these rows)
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO "JBSTestOpsAI".qa_agent_types
    (id,             name,                 description,                                  icon,         category, default_model, agent_file,                                          sort_order)
VALUES
    ('requirements', 'Requirements Agent', 'Explores live UI via MCP browser tools',     'FileSearch', 'core',   'haiku',  '.github/agents/playwright-requirements.agent.md',    1),
    ('planning',     'Test Planner',       'Creates comprehensive test cases and plans', 'Map',        'core',   'sonnet', '.github/agents/playwright-test-planner.agent.md',    2),
    ('generation',   'Test Generator',     'Generates Playwright spec files',            'Code',       'core',   'sonnet', '.github/agents/playwright-test-generator.agent.md',  3),
    ('healing',      'Test Healer',        'Debugs and fixes failing tests',             'Heart',      'core',   'sonnet', '.github/agents/playwright-test-healer.agent.md',     4),
    ('audit',        'Pipeline Audit',     'Reviews artifacts for quality',              'ShieldCheck','core',   'haiku',  '.github/agents/playwright-pipeline-audit.agent.md',  5)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- TEMPLATE: customer platform tenant + first admin (FILL IN, then run)
-- ─────────────────────────────────────────────────────────────────────
-- Replace the placeholders. Generate the password hash with:
--   node -e "console.log(require('bcrypt').hashSync('<strong password>', 12))"
--
-- INSERT INTO "JBSTestOpsAI".tenants (name, slug, is_platform)
-- VALUES ('<Customer Name>', '<customer-slug>', true)
-- ON CONFLICT (slug) DO NOTHING;
--
-- INSERT INTO "JBSTestOpsAI".users (tenant_id, username, password_hash, email, full_name, role)
-- VALUES (
--     (SELECT id FROM "JBSTestOpsAI".tenants WHERE slug = '<customer-slug>'),
--     '<admin-username>', '<bcrypt-hash>', '<admin-email>', '<Admin Name>', 'admin'
-- )
-- ON CONFLICT (username) DO NOTHING;

-- =====================================================================
-- DONE. Verify: SELECT tablename FROM pg_tables
--               WHERE schemaname = 'JBSTestOpsAI' ORDER BY tablename;  -- 22 rows
-- =====================================================================
