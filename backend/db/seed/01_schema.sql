-- =====================================================================
-- JBS IntelliQE — Database Schema (Postgres 14+)
-- =====================================================================
-- This file creates the complete `JBSTestOpsAI` schema from scratch.
-- It is the canonical, hand-written equivalent of the `initDb()` function
-- in backend/src/db.ts. Run this once against an empty Postgres database
-- and the application will boot without needing any further migrations.
--
-- All statements are idempotent:
--   • `CREATE SCHEMA IF NOT EXISTS`
--   • `CREATE TABLE IF NOT EXISTS`
--   • `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
-- so re-running this file is safe.
--
-- Total tables: 22
--   Group A — Identity / Tenancy             (2 tables)
--   Group B — Integration Configurations     (1 table)
--   Group C — Chat & Conversations           (2 tables)
--   Group D — Test Authoring & Execution     (4 tables)
--   Group E — Pipeline Orchestration         (9 tables)
--   Group F — Test Data                      (3 tables)
--   Group G — Audit                          (1 table)
--
-- Sensitive columns (encrypted at rest with AES-256-GCM, prefix `__AES__`):
--   • tenants.anthropic_api_key
--   • users.password_hash (recommended bcrypt; current values are plain
--     dev defaults — see 03_seed_data.sql for the security note)
--   • client_configurations.config_data (JSONB; sensitive keys encrypted
--     by field — see backend/src/utils/crypto.ts SENSITIVE_CONFIG_KEYS)
--   • jira_connections.auth_header
--   • automation_scripts.code (may contain credentials in fixtures)
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS "JBSTestOpsAI";
SET search_path TO "JBSTestOpsAI";

-- ---------------------------------------------------------------------
-- GROUP A — IDENTITY / TENANCY
-- ---------------------------------------------------------------------

-- A1. Tenants (organisations) — every other row in the system filters on tenant_id.
-- `is_platform=true` marks the JBS platform tenant which has elevated access.
-- `anthropic_api_key` is each tenant's own Claude API key (AES-encrypted at rest)
-- so per-customer cost attribution works correctly.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".tenants (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(200) NOT NULL,
    slug                VARCHAR(100) NOT NULL UNIQUE,
    is_platform         BOOLEAN NOT NULL DEFAULT false,
    anthropic_api_key   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A2. Users — authentication identities scoped to a tenant.
-- Roles: 'admin' (full tenant access), 'qa_engineer' (default), 'data_analyst' (read-mostly).
-- `is_active=false` lets us soft-disable accounts without losing audit history.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES "JBSTestOpsAI".tenants(id),
    username        VARCHAR(100) NOT NULL UNIQUE,
    password_hash   VARCHAR(500) NOT NULL,
    email           VARCHAR(300),
    full_name       VARCHAR(200),
    role            VARCHAR(50) NOT NULL DEFAULT 'qa_engineer'
                    CHECK (role IN ('admin', 'qa_engineer', 'data_analyst')),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- GROUP B — INTEGRATION CONFIGURATIONS
-- ---------------------------------------------------------------------

-- B1. Client configurations — one row per (tenant, integration) pair.
-- Every integration the user connects (Jira, Confluence, SharePoint,
-- GitHub, Azure Blob, etc.) stores its credentials + settings here as
-- JSONB. Sensitive keys inside config_data are AES-encrypted per-field
-- by encryptConfigData() in backend/src/utils/crypto.ts.
--
-- `category` groups integrations:
--   - 'requirement-source'  → jira, confluence, sharepoint
--   - 'data-source'         → azure-blob, aws-s3, gcp-storage, jenkins
--   - 'git-repo'            → github, gitlab, bitbucket
--   - 'notification'        → notif-email
--   - 'settings'            → general-settings, ai-self-healing
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".client_configurations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES "JBSTestOpsAI".tenants(id),
    integration_id  VARCHAR(50) NOT NULL,
    category        VARCHAR(30) DEFAULT 'integration',
    status          VARCHAR(20) NOT NULL DEFAULT 'available'
                    CHECK (status IN ('connected', 'available')),
    config_data     JSONB NOT NULL DEFAULT '{}',
    connected_by    VARCHAR(100),
    connected_at    TIMESTAMPTZ,
    last_sync_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, integration_id)
);

-- ---------------------------------------------------------------------
-- GROUP C — CHAT & CONVERSATIONS
-- ---------------------------------------------------------------------

-- C1. Conversations — top-level chat sessions in the wizard UI.
-- Used by the Tessa assistant to persist a user's wizard state.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID,
    username    VARCHAR(100) NOT NULL,
    title       VARCHAR(500),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- C2. Messages — individual turns in a conversation.
-- role ∈ { 'user', 'assistant', 'system' }. Free-form metadata captures
-- which agent produced a message, what tool was invoked, etc.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES "JBSTestOpsAI".conversations(id) ON DELETE CASCADE,
    role            VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content         TEXT NOT NULL,
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- GROUP D — TEST AUTHORING & EXECUTION
-- ---------------------------------------------------------------------

-- D1. Test runs — header record for a single "generate tests" invocation.
-- One run can contain many test cases. `source` records where the
-- requirement came from (jira, upload, explore, paste). `columns` is the
-- list of test-case columns the user asked to see in the UI.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".test_runs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID,
    username     VARCHAR(100) NOT NULL,
    story_key    VARCHAR(50),
    story_title  VARCHAR(500),
    source       VARCHAR(50),
    columns      JSONB NOT NULL DEFAULT '[]',
    module       VARCHAR(200),
    submodule    VARCHAR(200),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- D2. Test cases — the core IEEE-829 / ISTQB-shaped test case rows.
-- `steps` is a string array for legacy/list views; `test_steps` is the
-- structured per-step (action + expected) JSONB array. Both are kept
-- in sync by the generator agent so older UI keeps working.
-- `traceability_id` links back to the source requirement (e.g., a Jira
-- story key or REQ-AUTH-01).
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".test_cases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_run_id     UUID NOT NULL REFERENCES "JBSTestOpsAI".test_runs(id) ON DELETE CASCADE,
    tc_number       VARCHAR(20) NOT NULL,
    title           VARCHAR(1000) NOT NULL,
    description     TEXT,
    steps           JSONB NOT NULL DEFAULT '[]',
    test_steps      JSONB DEFAULT '[]',
    test_data       JSONB DEFAULT '{}',
    expected        TEXT,
    priority        VARCHAR(10),
    severity        VARCHAR(20),
    type            VARCHAR(50),
    feature         VARCHAR(200),
    precondition    TEXT,
    status          VARCHAR(50) DEFAULT 'generated',
    sort_order      INTEGER NOT NULL DEFAULT 0,
    module          VARCHAR(200),
    submodule       VARCHAR(200),
    tags            TEXT[] NOT NULL DEFAULT '{}',
    traceability_id VARCHAR(100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- D3. Jira connections (legacy table; dual-write target).
-- New code writes credentials to client_configurations; this table is
-- preserved for backwards-compatibility with older API endpoints and
-- the periodic sync job. Safe to drop in a future major release.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".jira_connections (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID,
    username     VARCHAR(100) NOT NULL UNIQUE,
    jira_url     VARCHAR(500) NOT NULL,
    auth_header  TEXT NOT NULL,
    display_name VARCHAR(200),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- D4. Automation scripts — Playwright (or other framework) source files
-- generated by the scriptAgent. `code` is the full TypeScript spec body.
-- Updated by the healingAgent when a test fails; `version` bumps on each
-- successful heal.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".automation_scripts (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL,
    test_run_id      UUID NOT NULL,
    test_case_id     UUID NOT NULL,
    tc_number        VARCHAR(50),
    test_case_title  TEXT,
    file_name        VARCHAR(255),
    language         VARCHAR(50)  DEFAULT 'typescript',
    framework        VARCHAR(50)  DEFAULT 'playwright',
    code             TEXT,
    status           VARCHAR(50)  DEFAULT 'generated',
    last_run_at      TIMESTAMPTZ,
    last_run_result  VARCHAR(50),
    version          INTEGER      DEFAULT 1,
    created_by       VARCHAR(100),
    created_at       TIMESTAMPTZ  DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  DEFAULT NOW(),
    CONSTRAINT automation_scripts_unique_tc_per_run UNIQUE (test_run_id, test_case_id)
);

-- ---------------------------------------------------------------------
-- GROUP E — PIPELINE ORCHESTRATION (the AI agent runtime)
-- ---------------------------------------------------------------------

-- E1. Pipeline runs — one row per multi-agent test-generation execution.
-- The orchestrator advances `stage` through the configured pipeline
-- definition (typically requirement → audit → planning → generation →
-- scripting → execution → healing → completed).
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_pipeline_runs (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID REFERENCES "JBSTestOpsAI".tenants(id),
    feature               TEXT NOT NULL,
    module                TEXT NOT NULL,
    intent                TEXT NOT NULL,
    target_url            TEXT,
    stage                 TEXT NOT NULL DEFAULT 'queued',
    status                TEXT NOT NULL DEFAULT 'queued',
    priority              TEXT NOT NULL DEFAULT 'medium',
    cost                  NUMERIC(10,4) DEFAULT 0,
    page_id               UUID,
    cascade_plan          JSONB,
    batch_id              UUID,
    execution_mode_live   TEXT,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- E2. Stage results — one row per (run × stage) pair.
-- `attempt` tracks retry count; `result_data` captures the agent output
-- as JSONB. Cost is summed up to qa_pipeline_runs.cost on completion.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_stage_results (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id        UUID NOT NULL REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE CASCADE,
    stage_id      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    attempt       INT DEFAULT 1,
    max_attempts  INT DEFAULT 1,
    agent_model   TEXT,
    cost          NUMERIC(10,4) DEFAULT 0,
    result_data   JSONB,
    started_at    TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- E3. Artifacts — files / blobs produced by each stage.
-- Examples: requirement.md, test-plan.json, test-cases.json, *.spec.ts.
-- `version` + `replaced_by` lets the UI show diff history when a stage
-- re-runs and overwrites a previous output.
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

-- E4. Worker tasks — units of agent execution claimed by external worker
-- processes. The orchestrator INSERTs pending tasks; workers poll, claim
-- with `claimed_at = NOW()`, run the agent, then UPDATE with result.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_worker_tasks (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id        UUID NOT NULL REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE CASCADE,
    tenant_id     UUID,
    stage_id      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    agent_prompt  TEXT NOT NULL,
    context       JSONB,
    result        JSONB,
    claimed_at    TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- E5. Agent type registry — the catalogue of agents the platform knows
-- about. Seeded with 5 core agents in 03_seed_data.sql.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_agent_types (
    id              VARCHAR(100) PRIMARY KEY,
    name            VARCHAR(200) NOT NULL,
    description     TEXT,
    icon            VARCHAR(100) DEFAULT 'Bot',
    category        VARCHAR(50)  DEFAULT 'core',
    default_model   VARCHAR(50)  DEFAULT 'sonnet',
    agent_file      TEXT,
    capabilities    TEXT[],
    enabled         BOOLEAN DEFAULT true,
    sort_order      INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- E6. Per-tenant pipeline definition overrides.
-- The default definition lives in backend/config/pipeline-definition.json.
-- Tenants who customise stage timeouts, budgets, or retry policies have
-- their override JSON stored here. UNIQUE (tenant_id NULLS NOT DISTINCT)
-- enforces "at most one override per tenant, plus one global default
-- when tenant_id IS NULL".
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_pipeline_definitions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID,
    definition   JSONB NOT NULL,
    version      INTEGER DEFAULT 1,
    created_by   VARCHAR(255),
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_qa_pipeline_def_tenant UNIQUE NULLS NOT DISTINCT (tenant_id)
);

-- E7. Pages — logical pages of the application under test, organised
-- in a parent/child hierarchy. The dependency engine uses this to plan
-- cascading test re-runs when an upstream page changes.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_pages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID,
    module          TEXT NOT NULL,
    page_slug       TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    target_url      TEXT,
    parent_page_id  UUID REFERENCES "JBSTestOpsAI".qa_pages(id) ON DELETE SET NULL,
    depth           INT DEFAULT 0,
    sort_order      INT DEFAULT 0,
    metadata        JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_qa_page_tenant_module_slug UNIQUE (tenant_id, module, page_slug)
);

-- E8. Per-page, per-stage readiness — caches "is this page ready for the
-- next stage" so the orchestrator can resume runs without re-deriving
-- status from raw artifacts each time.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_page_stage_status (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id                 UUID NOT NULL REFERENCES "JBSTestOpsAI".qa_pages(id) ON DELETE CASCADE,
    stage_id                TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'not_started',
    active_run_id           UUID REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE SET NULL,
    last_run_id             UUID REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE SET NULL,
    last_completed_at       TIMESTAMPTZ,
    artifact_summary        JSONB,
    approved_by             TEXT,
    approved_at             TIMESTAMPTZ,
    explore_without_reqs    BOOLEAN DEFAULT false,
    explore_permitted_by    TEXT,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_qa_page_stage UNIQUE (page_id, stage_id)
);

-- E9. Client setup — first-run onboarding state per tenant
-- (home URL discovery, authentication probe results, etc.).
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".qa_client_setup (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL UNIQUE,
    status        TEXT NOT NULL DEFAULT 'pending',
    home_url      TEXT,
    auth_config   JSONB,
    setup_config  JSONB,
    setup_run_id  UUID REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE SET NULL,
    initiated_by  TEXT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- GROUP F — TEST DATA (data-aware test generation)
-- ---------------------------------------------------------------------

-- F1. Test datasets — named collections of test inputs (e.g.,
-- "valid customer with US billing address"). One row per dataset.
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

-- F2. Field data — individual valid/invalid values per field, tagged
-- with their data type and the rule they exercise (e.g., RFC-5322 email).
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

-- F3. Test data mapping — many-to-many bridge between test cases and the
-- datasets they should run with.
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".test_data_mapping (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    test_run_id   UUID NOT NULL REFERENCES "JBSTestOpsAI".qa_pipeline_runs(id) ON DELETE CASCADE,
    test_case_id  VARCHAR(20) NOT NULL,
    dataset_id    VARCHAR(20) NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- GROUP G — AUDIT
-- ---------------------------------------------------------------------

-- G1. Audit log — HIPAA-style immutable record of every state-changing
-- action. `request_id` is a per-HTTP-request UUID propagated from
-- middleware so we can trace a single user action across services.
-- `details` JSONB captures the before/after diff (PII-masked).
CREATE TABLE IF NOT EXISTS "JBSTestOpsAI".audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES "JBSTestOpsAI".tenants(id),
    user_id         UUID,
    username        VARCHAR(100) NOT NULL,
    request_id      UUID,
    action          VARCHAR(50)  NOT NULL,
    resource_type   VARCHAR(50)  NOT NULL,
    resource_id     VARCHAR(200),
    details         JSONB DEFAULT '{}',
    ip_address      VARCHAR(50),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================================
-- DONE. Run 02_indexes.sql next.
-- =====================================================================
