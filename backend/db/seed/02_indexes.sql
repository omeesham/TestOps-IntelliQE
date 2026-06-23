-- =====================================================================
-- JBS IntelliQE — Indexes
-- =====================================================================
-- Performance indexes. Order matches frequency of use: tenant-scoping
-- indexes first, then per-resource lookup indexes, then specialised
-- (GIN, partial) indexes.
--
-- Run AFTER 01_schema.sql.
-- All statements use `IF NOT EXISTS` so this file is safely re-runnable.
-- =====================================================================

SET search_path TO "JBSTestOpsAI";

-- ─── Multi-tenant filtering ──────────────────────────────────────────
-- Every query above the auth middleware filters by tenant_id; these are
-- the hottest indexes in the system.
CREATE INDEX IF NOT EXISTS idx_users_tenant                ON "JBSTestOpsAI".users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_client_configs_tenant       ON "JBSTestOpsAI".client_configurations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant        ON "JBSTestOpsAI".conversations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_jira_connections_tenant     ON "JBSTestOpsAI".jira_connections(tenant_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_tenant            ON "JBSTestOpsAI".test_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_automation_scripts_tenant   ON "JBSTestOpsAI".automation_scripts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_qa_runs_tenant              ON "JBSTestOpsAI".qa_pipeline_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_qa_pages_tenant             ON "JBSTestOpsAI".qa_pages(tenant_id);

-- ─── User & conversation lookups ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_conversations_username      ON "JBSTestOpsAI".conversations(username);
CREATE INDEX IF NOT EXISTS idx_messages_conversation       ON "JBSTestOpsAI".messages(conversation_id);

-- ─── Test runs & cases ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_test_runs_module            ON "JBSTestOpsAI".test_runs(module);
CREATE INDEX IF NOT EXISTS idx_test_cases_run              ON "JBSTestOpsAI".test_cases(test_run_id);
CREATE INDEX IF NOT EXISTS idx_test_cases_module           ON "JBSTestOpsAI".test_cases(module);
-- GIN index for fast tag-array searches (e.g., WHERE tags && ARRAY['SMOKE','UI']).
CREATE INDEX IF NOT EXISTS idx_test_cases_tags             ON "JBSTestOpsAI".test_cases USING GIN (tags);

-- ─── Automation scripts ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_automation_scripts_run      ON "JBSTestOpsAI".automation_scripts(test_run_id);

-- ─── Audit ───────────────────────────────────────────────────────────
-- DESC on created_at because audit views always show "recent first".
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time           ON "JBSTestOpsAI".audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_request               ON "JBSTestOpsAI".audit_log(request_id);

-- ─── QA pipeline ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_qa_runs_status              ON "JBSTestOpsAI".qa_pipeline_runs(status);
CREATE INDEX IF NOT EXISTS idx_qa_runs_page                ON "JBSTestOpsAI".qa_pipeline_runs(page_id);
CREATE INDEX IF NOT EXISTS idx_qa_stage_run                ON "JBSTestOpsAI".qa_stage_results(run_id);
CREATE INDEX IF NOT EXISTS idx_qa_artifacts_run            ON "JBSTestOpsAI".qa_artifacts(run_id);

-- Partial index: workers poll for pending tasks only, so a tiny index
-- on (status='pending') rows beats a full-column index by orders of
-- magnitude on busy tenants.
CREATE INDEX IF NOT EXISTS idx_qa_worker_tasks_status
    ON "JBSTestOpsAI".qa_worker_tasks(status)
    WHERE status = 'pending';

-- =====================================================================
-- DONE. Run 03_seed_data.sql next (or skip if you only want the schema).
-- =====================================================================
