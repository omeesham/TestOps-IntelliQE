import pool from '../db.js';

export interface ConfigRow {
  id: string;
  tenantId: string;
  integrationId: string;
  status: string;
  configData: Record<string, any>;
  connectedBy: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Get all configurations for a tenant.
 */
export async function getConfigsForTenant(tenantId: string): Promise<ConfigRow[]> {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, integration_id, status, config_data, connected_by, connected_at, last_sync_at, created_at, updated_at
     FROM client_configurations
     WHERE tenant_id = $1
     ORDER BY integration_id`,
    [tenantId]
  );
  return rows.map(r => ({
    id: r.id,
    tenantId: r.tenant_id,
    integrationId: r.integration_id,
    status: r.status,
    configData: r.config_data,
    connectedBy: r.connected_by,
    connectedAt: r.connected_at,
    lastSyncAt: r.last_sync_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * Get configurations for a tenant filtered by category.
 */
export async function getConfigsForTenantByCategory(tenantId: string, category: string): Promise<ConfigRow[]> {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, integration_id, status, config_data, connected_by, connected_at, last_sync_at, created_at, updated_at
     FROM client_configurations
     WHERE tenant_id = $1 AND category = $2
     ORDER BY integration_id`,
    [tenantId, category]
  );
  return rows.map(r => ({
    id: r.id,
    tenantId: r.tenant_id,
    integrationId: r.integration_id,
    status: r.status,
    configData: r.config_data,
    connectedBy: r.connected_by,
    connectedAt: r.connected_at,
    lastSyncAt: r.last_sync_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * Return every properly-configured ("ready") application under test for a
 * tenant — a connected `app-*` integration carrying a non-empty base URL, the
 * same shape the UI requires before it lets the config be saved.
 *
 * When a tenant has MORE THAN ONE application configured (e.g. "OrangeHRM"
 * and "encoreglobal"), callers must pick a specific one by integrationId
 * rather than defaulting to "the first" — silently running one application's
 * stories against a different application's URL is the bug this replaces.
 */
export async function getReadyApplications(tenantId: string): Promise<ConfigRow[]> {
  const configs = await getConfigsForTenant(tenantId);
  return configs.filter(
    (c) =>
      c.integrationId.startsWith('app-') &&
      c.status === 'connected' &&
      !!(c.configData?.baseUrl && String(c.configData.baseUrl).trim()),
  );
}

/**
 * Return the tenant's first properly-configured application under test, or
 * null. Only safe to use where the caller genuinely has no specific
 * application in mind (e.g. a bare "is anything configured at all?" gate) —
 * prefer resolveAppConfig()/getReadyApplications() when a specific
 * application matters.
 */
export async function getConfiguredApplication(tenantId: string): Promise<ConfigRow | null> {
  const ready = await getReadyApplications(tenantId);
  return ready[0] || null;
}

/**
 * Resolve exactly one application by its integrationId (the `app-<slug>` id
 * Application Setup assigns). Returns null when that specific application
 * isn't configured/connected/missing a base URL — callers MUST treat that as
 * an error rather than falling back to a different application.
 */
export async function resolveAppConfig(tenantId: string, appId: string): Promise<ConfigRow | null> {
  const ready = await getReadyApplications(tenantId);
  return ready.find((c) => c.integrationId === appId) || null;
}

/**
 * Look up an application's display name even if it isn't (yet) properly
 * configured — used to produce a human-readable error like
 * "OrangeHRM isn't fully configured yet" instead of a bare integrationId.
 */
export async function getApplicationDisplayName(tenantId: string, appId: string): Promise<string> {
  const configs = await getConfigsForTenant(tenantId);
  const match = configs.find((c) => c.integrationId === appId);
  const name = match?.configData?.appName;
  if (name && String(name).trim()) return String(name).trim();
  return appId.replace(/^app-/, '').replace(/-/g, ' ');
}

/**
 * Upsert an integration configuration for a tenant.
 */
/** Derive category from integration_id */
function deriveCategory(integrationId: string): string {
  if (integrationId.startsWith('app-')) return 'application';
  if (integrationId.startsWith('notif-')) return 'notification';
  if (['general-settings', 'ai-self-healing'].includes(integrationId)) return 'settings';
  if (['jira', 'confluence', 'sharepoint'].includes(integrationId)) return 'requirement-source';
  if (['github', 'gitlab', 'bitbucket'].includes(integrationId)) return 'git-repo';
  if (integrationId === 'azure-storage') return 'storage';
  if (['azure-blob', 'aws-s3', 'gcp-storage', 'databricks', 'snowflake', 'postgresql', 'mysql', 'mssql', 'oracle', 'sharepoint-data', 'jenkins'].includes(integrationId)) return 'data-source';
  return 'integration';
}

export async function upsertConfig(
  tenantId: string,
  integrationId: string,
  status: string,
  configData: Record<string, any>,
  connectedBy: string
): Promise<ConfigRow> {
  const category = deriveCategory(integrationId);
  const { rows } = await pool.query(
    `MERGE INTO client_configurations WITH (HOLDLOCK) AS t
     USING (SELECT $1 AS tenant_id, $2 AS integration_id) AS s
       ON t.tenant_id = s.tenant_id AND t.integration_id = s.integration_id
     WHEN MATCHED THEN
       UPDATE SET status = $3, config_data = $4, connected_by = $5,
                  connected_at = SYSUTCDATETIME(), last_sync_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME(), category = $6
     WHEN NOT MATCHED THEN
       INSERT (tenant_id, integration_id, status, config_data, connected_by, connected_at, last_sync_at, category)
       VALUES ($1, $2, $3, $4, $5, SYSUTCDATETIME(), SYSUTCDATETIME(), $6)
     OUTPUT INSERTED.id, INSERTED.tenant_id, INSERTED.integration_id, INSERTED.status, INSERTED.config_data,
            INSERTED.connected_by, INSERTED.connected_at, INSERTED.last_sync_at, INSERTED.created_at, INSERTED.updated_at;`,
    [tenantId, integrationId, status, JSON.stringify(configData), connectedBy, category]
  );
  const r = rows[0];
  return {
    id: r.id,
    tenantId: r.tenant_id,
    integrationId: r.integration_id,
    status: r.status,
    configData: r.config_data,
    connectedBy: r.connected_by,
    connectedAt: r.connected_at,
    lastSyncAt: r.last_sync_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Soft-disconnect an integration: flip its status to 'disconnected' but KEEP
 * the stored config_data (repo URL, token, branch, …) so it can be reconnected
 * later without re-entering everything. The config is only removed by
 * deleteConfig(). Active consumers filter on status='connected', so a
 * disconnected config is inert until reconnected.
 */
export async function disconnectConfig(tenantId: string, integrationId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE client_configurations
       SET status = 'disconnected', updated_at = SYSUTCDATETIME()
     WHERE tenant_id = $1 AND integration_id = $2`,
    [tenantId, integrationId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Reconnect a previously-disconnected integration, reusing its stored config. */
export async function reconnectConfig(tenantId: string, integrationId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE client_configurations
       SET status = 'connected', connected_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
     WHERE tenant_id = $1 AND integration_id = $2`,
    [tenantId, integrationId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Permanently delete an integration configuration for a tenant. */
export async function deleteConfig(tenantId: string, integrationId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM client_configurations WHERE tenant_id = $1 AND integration_id = $2`,
    [tenantId, integrationId]
  );
  return (result.rowCount ?? 0) > 0;
}
