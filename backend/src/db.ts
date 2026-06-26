/**
 * Azure SQL Database connection pool + idempotent schema initialization.
 *
 * Migrated from PostgreSQL → Azure SQL (SQL Server / T-SQL). To avoid touching
 * all ~389 call-sites, this module exposes a `pool.query(text, params)` shim
 * that mimics the `pg` driver's interface (returns `{ rows, rowCount }`) on top
 * of the `mssql` driver. The shim translates the mechanical dialect differences
 * automatically — see `translateSql()` and `mapRow()` below. SQL that needs a
 * genuine rewrite (MERGE, FOR JSON, JSON_MODIFY, table locking hints) is written
 * directly in T-SQL at the call-site.
 *
 * All tables live in the "JBSTestOpsAI" schema. The connecting user's
 * DEFAULT_SCHEMA is set to it so unqualified table names resolve there, matching
 * the old Postgres `search_path` behavior.
 *
 * Connection settings come from env vars (AZURE_SQL_* / DB_*) — see .env.example.
 * Schema init is fully idempotent: it never drops or recreates objects, so data
 * persists across every container redeploy.
 */
import sql from 'mssql';

// All objects live in the database's default `dbo` schema. The codebase still
// writes table references as "JBSTestOpsAI".x (the old Postgres schema) in many
// places; translateSql() strips that qualifier so every reference resolves to
// dbo. This avoids depending on a per-login DEFAULT_SCHEMA (sa and the Azure
// admin login both default to dbo and can't be reassigned).
const SCHEMA = 'dbo';

// ── Columns whose values are JSON (old JSONB) or arrays (old TEXT[]). ──
// SQL Server stores these as NVARCHAR(MAX); the shim JSON-parses them on read
// and JSON-stringifies object/array params on write, so call-sites keep seeing
// plain JS objects/arrays exactly as they did with pg's JSONB auto-marshalling.
const JSON_COLUMNS = new Set<string>([
  'config_data', 'metadata', 'columns', 'steps', 'test_steps', 'test_data',
  'tags', 'details', 'cascade_plan', 'result_data', 'context', 'result',
  'definition', 'capabilities', 'artifact_summary', 'auth_config',
  'setup_config', 'fields', 'source_config', 'stages', 'mobile_context',
]);

// ── Connection config ──
function buildConfig(): sql.config {
  // Prefer a full connection string when provided (Azure portal ADO.NET style
  // is parsed by mssql), else assemble from discrete vars.
  const server = process.env.AZURE_SQL_SERVER || process.env.DB_HOST || 'localhost';
  const database = process.env.AZURE_SQL_DATABASE || process.env.DB_NAME || 'JBSTestOpsAI';
  const user = process.env.AZURE_SQL_USER || process.env.DB_USER || 'sa';
  const password = process.env.AZURE_SQL_PASSWORD || process.env.DB_PASSWORD || '';
  const port = Number(process.env.AZURE_SQL_PORT || process.env.DB_PORT) || 1433;

  // Azure SQL always requires encryption; local SQL Server / mssql in Docker
  // typically uses a self-signed cert, so trust it unless told otherwise.
  const encrypt = (process.env.DB_SSL ?? 'true') !== 'false';
  const trustServerCertificate =
    process.env.DB_TRUST_SERVER_CERT === 'true' ||
    (process.env.NODE_ENV !== 'production' && !process.env.AZURE_SQL_SERVER);

  return {
    server,
    database,
    user,
    password,
    port,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt,
      trustServerCertificate,
      // Return ISO-8601 strings handled in mapRow(); keep tz info on read.
      useUTC: true,
    },
    connectionTimeout: 30000,
    requestTimeout: 60000,
  };
}

let poolPromise: Promise<sql.ConnectionPool> | null = null;

function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    const cp = new sql.ConnectionPool(buildConfig());
    cp.on('error', (err) => console.error('Unexpected Azure SQL pool error:', err));
    poolPromise = cp.connect().catch((err) => {
      poolPromise = null; // allow retry on next call
      throw err;
    });
  }
  return poolPromise;
}

// ── SQL dialect translation (the mechanical 85%) ──
function translateSql(text: string): string {
  let t = text;

  // Strip the legacy "JBSTestOpsAI". schema qualifier — all objects live in dbo.
  t = t.replace(/\[?"?JBSTestOpsAI"?\]?\s*\./gi, '');

  // Postgres positional params  $1 → @p1
  t = t.replace(/\$(\d+)/g, '@p$1');

  // now() → SYSUTCDATETIME()   (NOW() default handled in DDL)
  t = t.replace(/\bnow\(\)/gi, 'SYSUTCDATETIME()');

  // Case-insensitive LIKE — SQL Server collations are CI by default.
  t = t.replace(/\bILIKE\b/gi, 'LIKE');

  // Strip Postgres type casts:  '{}'::jsonb → '{}' ,  $1::uuid → $1
  t = t.replace(/::\s*"?\w+"?(\s*\[\])?/g, '');

  // RETURNING ... → OUTPUT INSERTED/DELETED ...
  t = translateReturning(t);

  // LIMIT / OFFSET → OFFSET ... ROWS FETCH NEXT ... ROWS ONLY
  t = translateLimit(t);

  return t;
}

/**
 * Convert a trailing `RETURNING <cols>` into a T-SQL `OUTPUT` clause placed
 * correctly for INSERT / UPDATE / DELETE. Call-sites with ON CONFLICT / MERGE
 * or subquery-based statements write their OUTPUT clause by hand and never use
 * RETURNING, so this only fires on the regular single-statement forms.
 */
function translateReturning(t: string): string {
  const m = t.match(/\sRETURNING\s+([\s\S]+?)\s*$/i);
  if (!m) return t;

  const cols = m[1].trim();
  const isDelete = /^\s*DELETE\b/i.test(t);
  const src = isDelete ? 'DELETED' : 'INSERTED';
  const output =
    cols === '*'
      ? `OUTPUT ${src}.*`
      : `OUTPUT ${cols.split(',').map((c) => `${src}.${c.trim()}`).join(', ')}`;

  const body = t.slice(0, m.index).trimEnd();

  if (/^\s*INSERT\b/i.test(body)) {
    // INSERT INTO t (cols) [OUTPUT] VALUES (...) | SELECT ...
    const vi = body.search(/\s(VALUES|SELECT|DEFAULT\s+VALUES)\b/i);
    if (vi === -1) return `${body} ${output}`;
    return `${body.slice(0, vi)} ${output}${body.slice(vi)}`;
  }

  // UPDATE / DELETE: OUTPUT goes right before WHERE (or at the end).
  const wi = body.search(/\sWHERE\b/i);
  if (wi === -1) return `${body} ${output}`;
  return `${body.slice(0, wi)} ${output}${body.slice(wi)}`;
}

/**
 * `... LIMIT n [OFFSET m]` / `... OFFSET m` → OFFSET/FETCH. OFFSET/FETCH requires
 * an ORDER BY, so inject a stable no-op order when the statement lacks one. Only
 * handles a *trailing* LIMIT (the common case); subquery LIMITs are rewritten to
 * TOP at the call-site since they aren't at the end of the statement.
 */
function translateLimit(t: string): string {
  const ensureOrder = (head: string): string =>
    /\bORDER\s+BY\b/i.test(head) ? head : `${head} ORDER BY (SELECT NULL)`;

  const limitOffset = t.match(/\sLIMIT\s+(\S+)\s+OFFSET\s+(\S+)\s*$/i);
  if (limitOffset) {
    const head = ensureOrder(t.slice(0, limitOffset.index));
    return `${head} OFFSET ${limitOffset[2]} ROWS FETCH NEXT ${limitOffset[1]} ROWS ONLY`;
  }
  const limitOnly = t.match(/\sLIMIT\s+(\S+)\s*$/i);
  if (limitOnly) {
    const head = ensureOrder(t.slice(0, limitOnly.index));
    return `${head} OFFSET 0 ROWS FETCH NEXT ${limitOnly[1]} ROWS ONLY`;
  }
  const offsetOnly = t.match(/\sOFFSET\s+(\S+)\s*$/i);
  if (offsetOnly && !/FETCH/i.test(t)) {
    const head = ensureOrder(t.slice(0, offsetOnly.index));
    return `${head} OFFSET ${offsetOnly[1]} ROWS`;
  }
  return t;
}

// ── Param binding ──
function bindParam(request: sql.Request, name: string, value: unknown): void {
  if (value === undefined || value === null) {
    request.input(name, null);
    return;
  }
  // Objects/arrays were JSONB/array columns in Postgres — store as JSON text.
  if (typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    request.input(name, sql.NVarChar(sql.MAX), JSON.stringify(value));
    return;
  }
  request.input(name, value);
}

// ── Row mapping (read side) ──
function mapRow<T>(row: Record<string, unknown>): T {
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (v instanceof Date) {
      // Preserve the old pg behavior: dates come back as ISO strings.
      row[key] = v.toISOString();
    } else if (typeof v === 'string' && JSON_COLUMNS.has(key)) {
      const s = v.trim();
      if (s.length && (s[0] === '{' || s[0] === '[')) {
        try { row[key] = JSON.parse(v); } catch { /* leave as-is */ }
      }
    }
  }
  return row as T;
}

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * The pg-compatible surface the codebase depends on. Functions that receive the
 * pool by injection type their parameter as `Db` (was `Pool` from 'pg').
 */
export interface Db {
  // Default row type is `any` to match the permissive `pg` query<R = any>()
  // signature the call-sites were written against.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/**
 * pg-compatible query shim. Accepts Postgres-style SQL with `$n` params and
 * returns `{ rows, rowCount }`. Most call-sites need no changes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function query<T = any>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  const pool = await getPool();
  const request = pool.request();
  params.forEach((v, i) => bindParam(request, `p${i + 1}`, v));

  const result = await request.query<T>(translateSql(text));
  const recordset = (result.recordset as unknown as Record<string, unknown>[]) || [];
  const rows = recordset.map((r) => mapRow<T>(r));
  const affected = Array.isArray(result.rowsAffected)
    ? result.rowsAffected.reduce((a, b) => a + b, 0)
    : 0;
  return { rows, rowCount: rows.length || affected };
}

// The exported `pool` keeps the same shape the codebase expects from `pg`.
export const pool = { query };
export default pool;

// ════════════════════════════════════════════════════════════════════════
//  Schema initialization (idempotent — data persists across deployments)
// ════════════════════════════════════════════════════════════════════════

/** Run one batch statement directly (no param shim, no translation). */
async function exec(text: string): Promise<void> {
  const cp = await getPool();
  await cp.request().batch(text);
}

/** CREATE TABLE only when it does not already exist. */
async function createTable(name: string, ddl: string): Promise<void> {
  await exec(
    `IF OBJECT_ID(N'${SCHEMA}.${name}', N'U') IS NULL\nBEGIN\n${ddl}\nEND`,
  );
}

/** ADD COLUMN only when it does not already exist (mirrors ADD COLUMN IF NOT EXISTS). */
async function addColumn(table: string, column: string, definition: string): Promise<void> {
  await exec(
    `IF COL_LENGTH(N'${SCHEMA}.${table}', N'${column}') IS NULL\n` +
    `  ALTER TABLE ${SCHEMA}.${table} ADD ${column} ${definition}`,
  );
}

/** CREATE INDEX only when it does not already exist. */
async function createIndex(name: string, table: string, spec: string): Promise<void> {
  await exec(
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'${name}' ` +
    `AND object_id = OBJECT_ID(N'${SCHEMA}.${table}'))\n` +
    `  CREATE INDEX ${name} ON ${SCHEMA}.${table} ${spec}`,
  );
}

/**
 * Create the target database if it doesn't exist. Opt-in via DB_BOOTSTRAP=true —
 * used for local SQL Server (Docker) where the server starts with only `master`.
 * On Azure SQL the database is provisioned out-of-band (az sql db create), and
 * the app user typically can't touch `master`, so this stays off in production.
 */
export async function ensureDatabaseExists(): Promise<void> {
  if (process.env.DB_BOOTSTRAP !== 'true') return;
  const cfg = buildConfig();
  const dbName = String(cfg.database);
  const master = await new sql.ConnectionPool({ ...cfg, database: 'master' }).connect();
  try {
    await master.request().batch(`IF DB_ID(N'${dbName}') IS NULL CREATE DATABASE [${dbName}]`);
    console.log(`[DB] Ensured database [${dbName}] exists`);
  } finally {
    await master.close();
  }
}

export async function initDb(): Promise<void> {
  try {
    await ensureDatabaseExists();

    // Objects are created in the dbo schema (always present) — no CREATE SCHEMA.

    // ─── 1. Tenants ───
    await createTable('tenants', `
      CREATE TABLE ${SCHEMA}.tenants (
        id                UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        name              NVARCHAR(200) NOT NULL,
        slug              NVARCHAR(100) NOT NULL UNIQUE,
        is_platform       BIT NOT NULL DEFAULT 0,
        anthropic_api_key NVARCHAR(MAX),
        created_at        DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at        DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME()
      )`);
    await addColumn('tenants', 'anthropic_api_key', 'NVARCHAR(MAX)');

    // ─── 2. Users ───
    await createTable('users', `
      CREATE TABLE ${SCHEMA}.users (
        id            UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        tenant_id     UNIQUEIDENTIFIER NOT NULL REFERENCES ${SCHEMA}.tenants(id),
        username      NVARCHAR(100) NOT NULL UNIQUE,
        password_hash NVARCHAR(500) NOT NULL,
        email         NVARCHAR(300),
        full_name     NVARCHAR(200),
        role          NVARCHAR(50) NOT NULL DEFAULT 'qa_engineer'
                      CHECK (role IN ('admin', 'qa_engineer', 'data_analyst')),
        is_active     BIT NOT NULL DEFAULT 1,
        created_at    DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at    DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME()
      )`);
    await addColumn('users', 'is_active', 'BIT NOT NULL DEFAULT 1');

    // ─── 3. Client configurations ───
    await createTable('client_configurations', `
      CREATE TABLE ${SCHEMA}.client_configurations (
        id             UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        tenant_id      UNIQUEIDENTIFIER NOT NULL REFERENCES ${SCHEMA}.tenants(id),
        integration_id NVARCHAR(50) NOT NULL,
        category       NVARCHAR(30) DEFAULT 'integration',
        status         NVARCHAR(20) NOT NULL DEFAULT 'available'
                       CHECK (status IN ('connected', 'available')),
        config_data    NVARCHAR(MAX) NOT NULL DEFAULT '{}',
        connected_by   NVARCHAR(100),
        connected_at   DATETIMEOFFSET,
        last_sync_at   DATETIMEOFFSET,
        created_at     DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at     DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT uq_client_config_tenant_integration UNIQUE (tenant_id, integration_id)
      )`);
    await addColumn('client_configurations', 'category', "NVARCHAR(30) DEFAULT 'integration'");

    // ─── 4. Conversations + messages ───
    await createTable('conversations', `
      CREATE TABLE ${SCHEMA}.conversations (
        id         UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        tenant_id  UNIQUEIDENTIFIER,
        username   NVARCHAR(100) NOT NULL,
        title      NVARCHAR(500),
        created_at DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME()
      )`);
    await addColumn('conversations', 'tenant_id', 'UNIQUEIDENTIFIER');

    await createTable('messages', `
      CREATE TABLE ${SCHEMA}.messages (
        id              UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        conversation_id UNIQUEIDENTIFIER NOT NULL REFERENCES ${SCHEMA}.conversations(id) ON DELETE CASCADE,
        role            NVARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content         NVARCHAR(MAX) NOT NULL,
        metadata        NVARCHAR(MAX),
        created_at      DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME()
      )`);

    // ─── 5. Jira connections ───
    await createTable('jira_connections', `
      CREATE TABLE ${SCHEMA}.jira_connections (
        id           UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        tenant_id    UNIQUEIDENTIFIER,
        username     NVARCHAR(100) NOT NULL UNIQUE,
        jira_url     NVARCHAR(500) NOT NULL,
        auth_header  NVARCHAR(MAX) NOT NULL,
        display_name NVARCHAR(200),
        created_at   DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME()
      )`);
    await addColumn('jira_connections', 'tenant_id', 'UNIQUEIDENTIFIER');

    // ─── 6. Test runs + test cases ───
    await createTable('test_runs', `
      CREATE TABLE ${SCHEMA}.test_runs (
        id          UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        tenant_id   UNIQUEIDENTIFIER,
        username    NVARCHAR(100) NOT NULL,
        story_key   NVARCHAR(50),
        story_title NVARCHAR(500),
        source      NVARCHAR(50),
        columns     NVARCHAR(MAX) NOT NULL DEFAULT '[]',
        module      NVARCHAR(200),
        submodule   NVARCHAR(200),
        created_at  DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME()
      )`);
    await addColumn('test_runs', 'tenant_id', 'UNIQUEIDENTIFIER');
    await addColumn('test_runs', 'module', 'NVARCHAR(200)');
    await addColumn('test_runs', 'submodule', 'NVARCHAR(200)');
    // Mobile Application Automation (additive; NULL = web/API run)
    await addColumn('test_runs', 'platform', 'NVARCHAR(20)');
    await addColumn('test_runs', 'mobile_context', 'NVARCHAR(MAX)');

    await createTable('test_cases', `
      CREATE TABLE ${SCHEMA}.test_cases (
        id           UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        test_run_id  UNIQUEIDENTIFIER NOT NULL REFERENCES ${SCHEMA}.test_runs(id) ON DELETE CASCADE,
        tc_number    NVARCHAR(20) NOT NULL,
        title        NVARCHAR(1000) NOT NULL,
        steps        NVARCHAR(MAX) NOT NULL DEFAULT '[]',
        expected     NVARCHAR(MAX),
        priority     NVARCHAR(10),
        type         NVARCHAR(50),
        feature      NVARCHAR(200),
        precondition NVARCHAR(MAX),
        status       NVARCHAR(50) DEFAULT 'generated',
        sort_order   INT NOT NULL DEFAULT 0,
        module       NVARCHAR(200),
        submodule    NVARCHAR(200),
        tags         NVARCHAR(MAX) NOT NULL DEFAULT '[]',
        created_at   DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME()
      )`);
    await addColumn('test_cases', 'module', 'NVARCHAR(200)');
    await addColumn('test_cases', 'submodule', 'NVARCHAR(200)');
    await addColumn('test_cases', 'tags', "NVARCHAR(MAX) NOT NULL DEFAULT '[]'");
    await addColumn('test_cases', 'description', 'NVARCHAR(MAX)');
    await addColumn('test_cases', 'test_steps', "NVARCHAR(MAX) DEFAULT '[]'");
    await addColumn('test_cases', 'test_data', "NVARCHAR(MAX) DEFAULT '{}'");
    await addColumn('test_cases', 'severity', 'NVARCHAR(20)');
    await addColumn('test_cases', 'traceability_id', 'NVARCHAR(100)');

    // ─── 7. Automation scripts ───
    await createTable('automation_scripts', `
      CREATE TABLE ${SCHEMA}.automation_scripts (
        id              UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        tenant_id       UNIQUEIDENTIFIER NOT NULL,
        test_run_id     UNIQUEIDENTIFIER NOT NULL,
        test_case_id    UNIQUEIDENTIFIER NOT NULL,
        tc_number       NVARCHAR(50),
        test_case_title NVARCHAR(MAX),
        file_name       NVARCHAR(255),
        language        NVARCHAR(50)  DEFAULT 'typescript',
        framework       NVARCHAR(50)  DEFAULT 'playwright',
        code            NVARCHAR(MAX),
        status          NVARCHAR(50)  DEFAULT 'generated',
        last_run_at     DATETIMEOFFSET,
        last_run_result NVARCHAR(50),
        version         INT           DEFAULT 1,
        created_by      NVARCHAR(100),
        created_at      DATETIMEOFFSET DEFAULT SYSUTCDATETIME(),
        updated_at      DATETIMEOFFSET DEFAULT SYSUTCDATETIME(),
        CONSTRAINT automation_scripts_unique_tc_per_run UNIQUE (test_run_id, test_case_id)
      )`);

    // ─── 7b. TestRail integration (synced from TestRail; tenant-scoped) ───
    await createTable('testrail_projects', `
      CREATE TABLE ${SCHEMA}.testrail_projects (
        id           UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        tenant_id    UNIQUEIDENTIFIER NOT NULL,
        project_id   INT NOT NULL,
        name         NVARCHAR(500),
        is_completed BIT DEFAULT 0,
        synced_at    DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT testrail_projects_unique UNIQUE (tenant_id, project_id)
      )`);
    await createTable('testrail_runs', `
      CREATE TABLE ${SCHEMA}.testrail_runs (
        id             UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        tenant_id      UNIQUEIDENTIFIER NOT NULL,
        project_id     INT NOT NULL,
        run_id         INT NOT NULL,
        name           NVARCHAR(500),
        milestone_id   INT,
        is_completed   BIT DEFAULT 0,
        created_on     DATETIMEOFFSET,
        passed_count   INT DEFAULT 0,
        failed_count   INT DEFAULT 0,
        blocked_count  INT DEFAULT 0,
        retest_count   INT DEFAULT 0,
        untested_count INT DEFAULT 0,
        total_count    INT DEFAULT 0,
        synced_at      DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT testrail_runs_unique UNIQUE (tenant_id, run_id)
      )`);
    await createTable('testrail_milestones', `
      CREATE TABLE ${SCHEMA}.testrail_milestones (
        id            UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        tenant_id     UNIQUEIDENTIFIER NOT NULL,
        project_id    INT NOT NULL,
        milestone_id  INT NOT NULL,
        name          NVARCHAR(500),
        is_completed  BIT DEFAULT 0,
        started_on    DATETIMEOFFSET,
        due_on        DATETIMEOFFSET,
        synced_at     DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT testrail_milestones_unique UNIQUE (tenant_id, milestone_id)
      )`);
    await createTable('testrail_sync', `
      CREATE TABLE ${SCHEMA}.testrail_sync (
        tenant_id      UNIQUEIDENTIFIER PRIMARY KEY,
        last_synced_at DATETIMEOFFSET,
        status         NVARCHAR(50),
        message        NVARCHAR(MAX),
        projects_count INT DEFAULT 0,
        runs_count     INT DEFAULT 0
      )`);

    // ─── 8. Audit log ───
    await createTable('audit_log', `
      CREATE TABLE ${SCHEMA}.audit_log (
        id            UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        tenant_id     UNIQUEIDENTIFIER NOT NULL REFERENCES ${SCHEMA}.tenants(id),
        user_id       UNIQUEIDENTIFIER,
        username      NVARCHAR(100) NOT NULL,
        request_id    UNIQUEIDENTIFIER,
        action        NVARCHAR(50) NOT NULL,
        resource_type NVARCHAR(50) NOT NULL,
        resource_id   NVARCHAR(200),
        details       NVARCHAR(MAX) DEFAULT '{}',
        ip_address    NVARCHAR(50),
        created_at    DATETIMEOFFSET DEFAULT SYSUTCDATETIME()
      )`);
    await addColumn('audit_log', 'request_id', 'UNIQUEIDENTIFIER');

    // ─── 9. QA pipeline tables ───
    await createTable('qa_pipeline_runs', `
      CREATE TABLE ${SCHEMA}.qa_pipeline_runs (
        id                  UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        tenant_id           UNIQUEIDENTIFIER REFERENCES ${SCHEMA}.tenants(id),
        feature             NVARCHAR(MAX) NOT NULL,
        module              NVARCHAR(MAX) NOT NULL,
        intent              NVARCHAR(MAX) NOT NULL,
        target_url          NVARCHAR(MAX),
        stage               NVARCHAR(100) NOT NULL DEFAULT 'queued',
        status              NVARCHAR(100) NOT NULL DEFAULT 'queued',
        priority            NVARCHAR(50) NOT NULL DEFAULT 'medium',
        cost                DECIMAL(10,4) DEFAULT 0,
        page_id             UNIQUEIDENTIFIER,
        cascade_plan        NVARCHAR(MAX),
        batch_id            UNIQUEIDENTIFIER,
        execution_mode_live NVARCHAR(100),
        created_at          DATETIMEOFFSET DEFAULT SYSUTCDATETIME(),
        updated_at          DATETIMEOFFSET DEFAULT SYSUTCDATETIME()
      )`);
    await createTable('qa_stage_results', `
      CREATE TABLE ${SCHEMA}.qa_stage_results (
        id           UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        run_id       UNIQUEIDENTIFIER NOT NULL REFERENCES ${SCHEMA}.qa_pipeline_runs(id) ON DELETE CASCADE,
        stage_id     NVARCHAR(100) NOT NULL,
        status       NVARCHAR(50) NOT NULL DEFAULT 'pending',
        attempt      INT DEFAULT 1,
        max_attempts INT DEFAULT 1,
        agent_model  NVARCHAR(100),
        cost         DECIMAL(10,4) DEFAULT 0,
        result_data  NVARCHAR(MAX),
        started_at   DATETIMEOFFSET,
        completed_at DATETIMEOFFSET,
        created_at   DATETIMEOFFSET DEFAULT SYSUTCDATETIME()
      )`);
    await createTable('qa_artifacts', `
      CREATE TABLE ${SCHEMA}.qa_artifacts (
        id          UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        run_id      UNIQUEIDENTIFIER NOT NULL REFERENCES ${SCHEMA}.qa_pipeline_runs(id) ON DELETE CASCADE,
        name        NVARCHAR(MAX) NOT NULL,
        type        NVARCHAR(100) NOT NULL,
        content     NVARCHAR(MAX),
        metadata    NVARCHAR(MAX),
        page_id     UNIQUEIDENTIFIER,
        version     INT DEFAULT 1,
        replaced_by UNIQUEIDENTIFIER,
        edited_by   NVARCHAR(200),
        created_at  DATETIMEOFFSET DEFAULT SYSUTCDATETIME()
      )`);
    await createTable('qa_worker_tasks', `
      CREATE TABLE ${SCHEMA}.qa_worker_tasks (
        id           UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        run_id       UNIQUEIDENTIFIER NOT NULL REFERENCES ${SCHEMA}.qa_pipeline_runs(id) ON DELETE CASCADE,
        tenant_id    UNIQUEIDENTIFIER,
        stage_id     NVARCHAR(100) NOT NULL,
        status       NVARCHAR(50) NOT NULL DEFAULT 'pending',
        agent_prompt NVARCHAR(MAX) NOT NULL,
        context      NVARCHAR(MAX),
        result       NVARCHAR(MAX),
        claimed_at   DATETIMEOFFSET,
        completed_at DATETIMEOFFSET,
        created_at   DATETIMEOFFSET DEFAULT SYSUTCDATETIME()
      )`);
    await createTable('qa_agent_types', `
      CREATE TABLE ${SCHEMA}.qa_agent_types (
        id            NVARCHAR(100) PRIMARY KEY,
        name          NVARCHAR(200) NOT NULL,
        description   NVARCHAR(MAX),
        icon          NVARCHAR(100) DEFAULT 'Bot',
        category      NVARCHAR(50) DEFAULT 'core',
        default_model NVARCHAR(50) DEFAULT 'sonnet',
        agent_file    NVARCHAR(MAX),
        capabilities  NVARCHAR(MAX),
        enabled       BIT DEFAULT 1,
        sort_order    INT DEFAULT 0,
        created_at    DATETIMEOFFSET DEFAULT SYSUTCDATETIME()
      )`);
    // UNIQUE(tenant_id): SQL Server treats NULLs as equal, matching the old
    // Postgres `UNIQUE NULLS NOT DISTINCT` (one default/global definition row).
    await createTable('qa_pipeline_definitions', `
      CREATE TABLE ${SCHEMA}.qa_pipeline_definitions (
        id         UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        tenant_id  UNIQUEIDENTIFIER,
        definition NVARCHAR(MAX) NOT NULL,
        version    INT DEFAULT 1,
        created_by NVARCHAR(255),
        created_at DATETIMEOFFSET DEFAULT SYSUTCDATETIME(),
        updated_at DATETIMEOFFSET DEFAULT SYSUTCDATETIME(),
        CONSTRAINT uq_qa_pipeline_def_tenant UNIQUE (tenant_id)
      )`);
    // module/page_slug are bounded (vs TEXT in Postgres) so they fit the unique
    // index key-size limit; both are short identifiers in practice.
    await createTable('qa_pages', `
      CREATE TABLE ${SCHEMA}.qa_pages (
        id             UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        tenant_id      UNIQUEIDENTIFIER,
        module         NVARCHAR(200) NOT NULL,
        page_slug      NVARCHAR(200) NOT NULL,
        display_name   NVARCHAR(MAX) NOT NULL,
        target_url     NVARCHAR(MAX),
        parent_page_id UNIQUEIDENTIFIER REFERENCES ${SCHEMA}.qa_pages(id),
        depth          INT DEFAULT 0,
        sort_order     INT DEFAULT 0,
        metadata       NVARCHAR(MAX),
        created_at     DATETIMEOFFSET DEFAULT SYSUTCDATETIME(),
        updated_at     DATETIMEOFFSET DEFAULT SYSUTCDATETIME(),
        CONSTRAINT uq_qa_page_tenant_module_slug UNIQUE (tenant_id, module, page_slug)
      )`);
    await createTable('qa_page_stage_status', `
      CREATE TABLE ${SCHEMA}.qa_page_stage_status (
        id                   UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        page_id              UNIQUEIDENTIFIER NOT NULL REFERENCES ${SCHEMA}.qa_pages(id) ON DELETE CASCADE,
        stage_id             NVARCHAR(100) NOT NULL,
        status               NVARCHAR(50) NOT NULL DEFAULT 'not_started',
        active_run_id        UNIQUEIDENTIFIER,
        last_run_id          UNIQUEIDENTIFIER,
        last_completed_at    DATETIMEOFFSET,
        artifact_summary     NVARCHAR(MAX),
        approved_by          NVARCHAR(200),
        approved_at          DATETIMEOFFSET,
        explore_without_reqs BIT DEFAULT 0,
        explore_permitted_by NVARCHAR(200),
        created_at           DATETIMEOFFSET DEFAULT SYSUTCDATETIME(),
        updated_at           DATETIMEOFFSET DEFAULT SYSUTCDATETIME(),
        CONSTRAINT uq_qa_page_stage UNIQUE (page_id, stage_id)
      )`);
    await createTable('qa_client_setup', `
      CREATE TABLE ${SCHEMA}.qa_client_setup (
        id           UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        tenant_id    UNIQUEIDENTIFIER NOT NULL UNIQUE,
        status       NVARCHAR(50) NOT NULL DEFAULT 'pending',
        home_url     NVARCHAR(MAX),
        auth_config  NVARCHAR(MAX),
        setup_config NVARCHAR(MAX),
        setup_run_id UNIQUEIDENTIFIER,
        initiated_by NVARCHAR(200) NOT NULL,
        created_at   DATETIMEOFFSET DEFAULT SYSUTCDATETIME(),
        updated_at   DATETIMEOFFSET DEFAULT SYSUTCDATETIME()
      )`);

    // ─── 10. Test data tables ───
    await createTable('test_datasets', `
      CREATE TABLE ${SCHEMA}.test_datasets (
        id            UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
        test_run_id   UNIQUEIDENTIFIER NOT NULL REFERENCES ${SCHEMA}.qa_pipeline_runs(id) ON DELETE CASCADE,
        dataset_id    NVARCHAR(20) NOT NULL,
        role          NVARCHAR(100) NOT NULL,
        scenario      NVARCHAR(500),
        fields        NVARCHAR(MAX) NOT NULL DEFAULT '{}',
        layer         NVARCHAR(10) DEFAULT 'ui' CHECK (layer IN ('ui', 'api', 'both')),
        source        NVARCHAR(20) DEFAULT 'static' CHECK (source IN ('static', 'database', 'mixed')),
        source_config NVARCHAR(MAX),
        created_at    DATETIMEOFFSET DEFAULT SYSUTCDATETIME()
      )`);
    await createTable('test_field_data', `
      CREATE TABLE ${SCHEMA}.test_field_data (
        id              UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
        test_run_id     UNIQUEIDENTIFIER NOT NULL REFERENCES ${SCHEMA}.qa_pipeline_runs(id) ON DELETE CASCADE,
        field_data_id   NVARCHAR(20) NOT NULL,
        field_name      NVARCHAR(200) NOT NULL,
        value           NVARCHAR(MAX),
        type            NVARCHAR(10) DEFAULT 'valid' CHECK (type IN ('valid', 'invalid')),
        data_type       NVARCHAR(50),
        validation_rule NVARCHAR(200),
        source          NVARCHAR(20) DEFAULT 'static' CHECK (source IN ('static', 'database', 'api', 'computed')),
        source_detail   NVARCHAR(500),
        created_at      DATETIMEOFFSET DEFAULT SYSUTCDATETIME()
      )`);
    await createTable('test_data_mapping', `
      CREATE TABLE ${SCHEMA}.test_data_mapping (
        id           UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
        test_run_id  UNIQUEIDENTIFIER NOT NULL REFERENCES ${SCHEMA}.qa_pipeline_runs(id) ON DELETE CASCADE,
        test_case_id NVARCHAR(20) NOT NULL,
        dataset_id   NVARCHAR(20) NOT NULL,
        created_at   DATETIMEOFFSET DEFAULT SYSUTCDATETIME()
      )`);

    // ─── 11. Indexes ───
    await createIndex('idx_users_tenant', 'users', '(tenant_id)');
    await createIndex('idx_client_configs_tenant', 'client_configurations', '(tenant_id)');
    await createIndex('idx_conversations_username', 'conversations', '(username)');
    await createIndex('idx_conversations_tenant', 'conversations', '(tenant_id)');
    await createIndex('idx_messages_conversation', 'messages', '(conversation_id)');
    await createIndex('idx_jira_connections_tenant', 'jira_connections', '(tenant_id)');
    await createIndex('idx_test_runs_tenant', 'test_runs', '(tenant_id)');
    await createIndex('idx_test_runs_module', 'test_runs', '(module)');
    await createIndex('idx_test_cases_run', 'test_cases', '(test_run_id)');
    await createIndex('idx_test_cases_module', 'test_cases', '(module)');
    await createIndex('idx_automation_scripts_tenant', 'automation_scripts', '(tenant_id)');
    await createIndex('idx_automation_scripts_run', 'automation_scripts', '(test_run_id)');
    await createIndex('idx_audit_tenant_time', 'audit_log', '(tenant_id, created_at DESC)');
    await createIndex('idx_audit_request', 'audit_log', '(request_id)');
    await createIndex('idx_qa_runs_tenant', 'qa_pipeline_runs', '(tenant_id)');
    await createIndex('idx_qa_runs_status', 'qa_pipeline_runs', '(status)');
    await createIndex('idx_qa_runs_page', 'qa_pipeline_runs', '(page_id)');
    await createIndex('idx_qa_stage_run', 'qa_stage_results', '(run_id)');
    await createIndex('idx_qa_artifacts_run', 'qa_artifacts', '(run_id)');
    await createIndex('idx_qa_worker_tasks_status', 'qa_worker_tasks', "(status) WHERE status = 'pending'");
    await createIndex('idx_qa_pages_tenant', 'qa_pages', '(tenant_id)');

    // ─── 12. Seed: JBS platform tenant + default users ───
    await exec(`
      IF NOT EXISTS (SELECT 1 FROM ${SCHEMA}.tenants WHERE slug = 'jbs')
        INSERT INTO ${SCHEMA}.tenants (name, slug, is_platform)
        VALUES ('Jade Business Solutions', 'jbs', 1)`);
    await exec(`
      IF NOT EXISTS (SELECT 1 FROM ${SCHEMA}.users WHERE username = 'jbsadmin')
        INSERT INTO ${SCHEMA}.users (tenant_id, username, password_hash, full_name, role)
        VALUES ((SELECT id FROM ${SCHEMA}.tenants WHERE slug = 'jbs'), 'jbsadmin', 'Omeesha@19', 'JBS Admin', 'admin')`);
    await exec(`
      IF NOT EXISTS (SELECT 1 FROM ${SCHEMA}.users WHERE username = 'qaengineer')
        INSERT INTO ${SCHEMA}.users (tenant_id, username, password_hash, full_name, role)
        VALUES ((SELECT id FROM ${SCHEMA}.tenants WHERE slug = 'jbs'), 'qaengineer', 'Login@2026', 'QA Engineer', 'qa_engineer')`);

    // ─── 13. Seed: QA agent types ───
    const agentSeeds: Array<[string, string, string, string, string, string, string, number]> = [
      ['requirements', 'Requirements Agent', 'Explores live UI via MCP browser tools', 'FileSearch', 'core', 'haiku', '.github/agents/playwright-requirements.agent.md', 1],
      ['planning', 'Test Planner', 'Creates comprehensive test cases and plans', 'Map', 'core', 'sonnet', '.github/agents/playwright-test-planner.agent.md', 2],
      ['generation', 'Test Generator', 'Generates Playwright spec files', 'Code', 'core', 'sonnet', '.github/agents/playwright-test-generator.agent.md', 3],
      ['healing', 'Test Healer', 'Debugs and fixes failing tests', 'Heart', 'core', 'sonnet', '.github/agents/playwright-test-healer.agent.md', 4],
      ['audit', 'Pipeline Audit', 'Reviews artifacts for quality', 'ShieldCheck', 'core', 'haiku', '.github/agents/playwright-pipeline-audit.agent.md', 5],
    ];
    for (const [id, name, description, icon, category, model, file, order] of agentSeeds) {
      await query(
        `IF NOT EXISTS (SELECT 1 FROM ${SCHEMA}.qa_agent_types WHERE id = $1)
         INSERT INTO ${SCHEMA}.qa_agent_types (id, name, description, icon, category, default_model, agent_file, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, name, description, icon, category, model, file, order],
      );
    }

    // ─── 14. Credential encryption migration (idempotent) ───
    await encryptExistingCredentials();

    console.log('Database initialized: core tables + AI orchestration tables ready');
  } catch (err) {
    console.error('Failed to initialize database tables:', err);
    throw err;
  }
}

/**
 * One-time migration: encrypt any plaintext sensitive fields in
 * client_configurations.config_data. Idempotent — only encrypts values
 * that don't already have the __ENC__ prefix.
 */
async function encryptExistingCredentials(): Promise<void> {
  const { encryptConfigData, SENSITIVE_CONFIG_KEYS } = await import('./utils/crypto.js');

  const { rows } = await query<{ id: string; config_data: Record<string, unknown> }>(
    `SELECT id, config_data FROM client_configurations`,
  );
  let updated = 0;

  for (const row of rows) {
    const data = row.config_data;
    if (!data || typeof data !== 'object') continue;

    let needsEncryption = false;
    for (const key of Object.keys(data)) {
      const val = (data as Record<string, unknown>)[key];
      if (
        SENSITIVE_CONFIG_KEYS.has(key) &&
        typeof val === 'string' &&
        val.length > 0 &&
        !val.startsWith('__ENC__') &&
        !val.startsWith('__AES__')
      ) {
        needsEncryption = true;
        break;
      }
    }

    if (needsEncryption) {
      const encrypted = encryptConfigData(data);
      await query(`UPDATE client_configurations SET config_data = $1 WHERE id = $2`, [
        JSON.stringify(encrypted),
        row.id,
      ]);
      updated++;
    }
  }

  if (updated > 0) console.log(`[Security] Encrypted credentials in ${updated} configuration(s)`);
}
