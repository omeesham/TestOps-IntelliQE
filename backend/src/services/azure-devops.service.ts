/**
 * Azure DevOps (Azure Boards / Test Plans) integration service.
 *
 * Mirrors the JIRA service: connect + validate a Personal Access Token, then
 * fetch work items (User Stories, Bugs, Features, Epics, Tasks) and authored
 * Test Cases from Azure DevOps into the IntelliQE pipeline.
 *
 * Auth: Azure DevOps uses HTTP Basic with an EMPTY username and the PAT as the
 * password → `Authorization: Basic base64(":" + PAT)`.
 *
 * Credentials are stored per-tenant in client_configurations
 * (integration_id = 'azure-devops'); the derived auth header is AES-encrypted
 * at rest (auth_header is a sensitive config key).
 */
import axios from 'axios';
import pool from '../db.js';
import { encryptConfigData, decryptConfigData } from '../utils/crypto.js';

const API_VERSION = '7.0';

// Work item types offered when generating tests from board items: ONLY
// Epic, User Story and Task (per product decision — no backlog items,
// features, or bugs in the picker). Bugs live in the Bug Tracker flow and
// Test Case has its own dedicated import mode; everything else stays
// reachable through the "all work items" browse.
const STORY_TYPES = ['Epic', 'User Story', 'Task'];

// Everything a user might have in Boards, for the "all work items" browse mode.
const ALL_TYPES = [
  ...STORY_TYPES, 'Product Backlog Item', 'Requirement',
  'Feature', 'Issue', 'Bug', 'Test Case',
];

// Board cards in a terminal column are finished work — not candidates for test
// generation. Filter them in WIQL so the picker only offers open cards.
// ('Removed' is Azure's soft-delete state and must never surface.)
const DONE_STATES_CLAUSE = `[System.State] NOT IN ('Closed', 'Done', 'Removed')`;

export type AdoCreds = {
  /** Normalized org API base, e.g. https://dev.azure.com/my-org */
  baseUrl: string;
  /** Org short name (last path segment of baseUrl). */
  org: string;
  /** Project name (may contain spaces). */
  project: string;
  /** `Basic <base64>` header. */
  authHeader: string;
  /** Optional Area Path to scope the fetch (e.g. "MyProject\\QA"). */
  areaPath?: string;
};

type WorkItemSummary = { key: string; summary: string; type: string; state?: string };
type StoryDetails = { key: string; title: string; description?: string; acceptanceCriteria?: string; type?: string };
type TestStep = { step: number; action: string; expected: string };
type TestCaseSummary = { key: string; title: string; state?: string; steps: TestStep[] };

/**
 * Reduce any Azure DevOps org URL to the API base = https://dev.azure.com/{org}.
 * Accepts: full dev.azure.com URLs, legacy {org}.visualstudio.com, a project
 * URL (org is still the first path segment), or a bare org name. dev.azure.com
 * serves the REST API for both hosting styles, so we always target it.
 */
export function normalizeOrg(raw: string): { baseUrl: string; org: string } {
  let s = (raw || '').trim().replace(/\/+$/, '');
  if (!s) return { baseUrl: '', org: '' };

  // Legacy: https://my-org.visualstudio.com[/...]
  const legacy = s.match(/^https?:\/\/([^.]+)\.visualstudio\.com/i);
  if (legacy) {
    const org = legacy[1]!;
    return { baseUrl: `https://dev.azure.com/${org}`, org };
  }

  // Modern: https://dev.azure.com/{org}[/...]
  const modern = s.match(/^https?:\/\/dev\.azure\.com\/([^/]+)/i);
  if (modern) {
    const org = decodeURIComponent(modern[1]!);
    return { baseUrl: `https://dev.azure.com/${org}`, org };
  }

  // Bare org name (no scheme, no host).
  if (!/^https?:\/\//i.test(s) && !s.includes('/') && !s.includes('.')) {
    return { baseUrl: `https://dev.azure.com/${s}`, org: s };
  }

  // Fallback: last non-empty path segment after the host.
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const seg = u.pathname.split('/').filter(Boolean)[0] || '';
    if (u.host.toLowerCase() === 'dev.azure.com' && seg) {
      return { baseUrl: `https://dev.azure.com/${seg}`, org: seg };
    }
  } catch { /* ignore */ }
  return { baseUrl: s, org: '' };
}

/** Build the Basic auth header for a PAT (empty username, PAT as password). */
export function buildAuthHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
}

// ─── HTML → plain text (Azure fields are HTML) ───
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function htmlToPlain(html: string): string {
  if (!html) return '';
  let out = html;
  out = out.replace(/<\/li>\s*<li>/gi, '</li>\n<li>');
  out = out.replace(/<li[^>]*>/gi, '\n- ');
  out = out.replace(/<\/li>/gi, '');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(p|div)>\s*<(p|div)[^>]*>/gi, '\n');
  out = out.replace(/<(p|div)[^>]*>/gi, '');
  out = out.replace(/<\/(p|div)>/gi, '\n');
  out = out.replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(out)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse the Microsoft.VSTS.TCM.Steps XML into ordered {action, expected} steps.
 * Each <step> has two <parameterizedString> children: [0]=action, [1]=expected,
 * each carrying HTML-encoded rich text.
 */
function parseTestSteps(stepsXml: string): TestStep[] {
  if (!stepsXml) return [];
  const steps: TestStep[] = [];
  const stepRe = /<step\b[^>]*>([\s\S]*?)<\/step>/gi;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = stepRe.exec(stepsXml)) !== null) {
    const inner = m[1] || '';
    const parts: string[] = [];
    const psRe = /<parameterizedString\b[^>]*>([\s\S]*?)<\/parameterizedString>/gi;
    let pm: RegExpExecArray | null;
    while ((pm = psRe.exec(inner)) !== null) {
      // Content is double-encoded HTML — decode entities, then strip tags.
      parts.push(htmlToPlain(decodeHtmlEntities(pm[1] || '')));
    }
    n += 1;
    steps.push({ step: n, action: (parts[0] || '').trim(), expected: (parts[1] || '').trim() });
  }
  return steps;
}

// ─── HTTP helpers ───
function authHeaders(creds: AdoCreds) {
  return { Authorization: creds.authHeader, Accept: 'application/json' };
}

async function wiqlIds(creds: AdoCreds, whereClause: string, top = 200): Promise<number[]> {
  const url = `${creds.baseUrl}/${encodeURIComponent(creds.project)}/_apis/wit/wiql?api-version=${API_VERSION}`;
  const areaClause = creds.areaPath ? ` AND [System.AreaPath] UNDER '${creds.areaPath.replace(/'/g, "''")}'` : '';
  const query =
    `SELECT [System.Id] FROM WorkItems ` +
    `WHERE [System.TeamProject] = @project${whereClause ? ` AND (${whereClause})` : ''}${areaClause} ` +
    `ORDER BY [System.ChangedDate] DESC`;
  const resp = await axios.post(url, { query }, { headers: { ...authHeaders(creds), 'Content-Type': 'application/json' } });
  const items = Array.isArray(resp.data?.workItems) ? resp.data.workItems : [];
  return items.slice(0, top).map((w: any) => Number(w.id)).filter((n: number) => Number.isFinite(n));
}

async function batchFields(creds: AdoCreds, ids: number[], fields: string[]): Promise<any[]> {
  if (ids.length === 0) return [];
  const url = `${creds.baseUrl}/_apis/wit/workitemsbatch?api-version=${API_VERSION}`;
  const out: any[] = [];
  // Azure caps a batch at 200 ids.
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const resp = await axios.post(url, { ids: chunk, fields }, { headers: { ...authHeaders(creds), 'Content-Type': 'application/json' } });
    if (Array.isArray(resp.data?.value)) out.push(...resp.data.value);
  }
  return out;
}

function typesClause(types: string[]): string {
  return `[System.WorkItemType] IN (${types.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')})`;
}

// ─── Public API ───
export async function testConnection(creds: AdoCreds): Promise<{ id: string; name: string }> {
  // Validate with a WIQL query, NOT the projects API: fetching work items only
  // needs the Work Items (Read) scope we ask users for, whereas
  // `_apis/projects/{name}` needs the extra Project and Team (Read) scope — a
  // correctly-scoped PAT would fail validation there (Azure answers with an
  // HTML sign-in page) despite being perfectly able to fetch work items.
  const wiqlUrl = `${creds.baseUrl}/${encodeURIComponent(creds.project)}/_apis/wit/wiql?$top=1&api-version=${API_VERSION}`;
  const resp = await axios.post(
    wiqlUrl,
    { query: 'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project' },
    { headers: { ...authHeaders(creds), 'Content-Type': 'application/json' }, validateStatus: () => true },
  );

  const isJson = resp.data && typeof resp.data === 'object';
  if (resp.status === 200 && isJson && Array.isArray(resp.data.workItems)) {
    // Connection proven. Best-effort friendly project name (needs the optional
    // Project and Team (Read) scope — fall back to the name the user typed).
    try {
      const p = await axios.get(
        `${creds.baseUrl}/_apis/projects/${encodeURIComponent(creds.project)}?api-version=${API_VERSION}`,
        { headers: authHeaders(creds) },
      );
      if (p.data && typeof p.data === 'object' && p.data.id && p.data.name) {
        return { id: String(p.data.id), name: String(p.data.name) };
      }
    } catch { /* name lookup is optional */ }
    return { id: creds.project, name: creds.project };
  }

  if (resp.status === 401) {
    throw new Error(
      'Azure DevOps rejected the Personal Access Token (401). The PAT is invalid, expired, or was created for a different organization.',
    );
  }
  if (resp.status === 404) {
    throw new Error(
      `Project "${creds.project}" was not found in organization "${creds.org}". Check the Project name (it is case-insensitive but must match an existing project) and the Organization URL.`,
    );
  }
  if (resp.status === 203 || !isJson) {
    // Azure answers unauthenticated API calls with an HTML sign-in page
    // (often status 203) instead of a JSON error.
    throw new Error(
      'Azure DevOps returned a sign-in page instead of an API response — the PAT was not accepted for this organization. ' +
      'Recreate the PAT in this organization (https://dev.azure.com/' + creds.org + ') with at least Work Items (Read) scope, and check it has not expired.',
    );
  }
  throw new Error(
    `Azure DevOps API error (${resp.status}): ${isJson ? (resp.data.message || JSON.stringify(resp.data).slice(0, 200)) : String(resp.data).slice(0, 200)}`,
  );
}

export async function getStories(creds: AdoCreds): Promise<WorkItemSummary[]> {
  const ids = await wiqlIds(creds, `${typesClause(STORY_TYPES)} AND ${DONE_STATES_CLAUSE}`, 500);
  const items = await batchFields(creds, ids, ['System.Id', 'System.Title', 'System.WorkItemType', 'System.State']);
  return items.map((w) => ({
    key: String(w.id),
    summary: w.fields?.['System.Title'] ?? '',
    type: w.fields?.['System.WorkItemType'] ?? '',
    state: w.fields?.['System.State'] ?? '',
  }));
}

export async function getWorkItems(creds: AdoCreds, opts?: { type?: string }): Promise<WorkItemSummary[]> {
  const types = opts?.type ? [opts.type] : ALL_TYPES;
  const ids = await wiqlIds(creds, typesClause(types), 200);
  const items = await batchFields(creds, ids, ['System.Id', 'System.Title', 'System.WorkItemType', 'System.State']);
  return items.map((w) => ({
    key: String(w.id),
    summary: w.fields?.['System.Title'] ?? '',
    type: w.fields?.['System.WorkItemType'] ?? '',
    state: w.fields?.['System.State'] ?? '',
  }));
}

export async function getStory(creds: AdoCreds, id: string): Promise<StoryDetails> {
  const url = `${creds.baseUrl}/_apis/wit/workitems/${encodeURIComponent(id)}?api-version=${API_VERSION}&$expand=all`;
  const resp = await axios.get(url, { headers: authHeaders(creds) });
  const f = resp.data?.fields || {};
  const title = f['System.Title'] ?? id;
  // Bugs carry their detail in Repro Steps rather than Description — include
  // it so a Bug selected as a requirement source doesn't come back empty.
  const reproSteps = htmlToPlain(f['Microsoft.VSTS.TCM.ReproSteps'] || '');
  const description = [
    htmlToPlain(f['System.Description'] || ''),
    reproSteps ? `Steps to Reproduce:\n${reproSteps}` : '',
  ].filter(Boolean).join('\n\n');
  const acceptanceCriteria = htmlToPlain(f['Microsoft.VSTS.Common.AcceptanceCriteria'] || '');
  return { key: String(id), title, description, acceptanceCriteria, type: f['System.WorkItemType'] };
}

/** IntelliQE priority (P0–P3) → Azure DevOps Microsoft.VSTS.Common.Priority (1–4). */
function mapPriority(p?: string): number | undefined {
  const m: Record<string, number> = { P0: 1, P1: 2, P2: 3, P3: 4 };
  return p ? m[p.toUpperCase()] : undefined;
}
/** IntelliQE severity → Azure DevOps Microsoft.VSTS.Common.Severity string. */
function mapSeverity(s?: string): string | undefined {
  const m: Record<string, string> = {
    critical: '1 - Critical', high: '2 - High', medium: '3 - Medium', low: '4 - Low',
  };
  return s ? m[s.toLowerCase()] : undefined;
}

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\n/g, '<br/>');
}

export interface AdoBugInput {
  title: string;
  description?: string;
  stepsToReproduce?: string;
  expectedResult?: string;
  actualResult?: string;
  environment?: string;
  priority?: string;   // P0–P3
  severity?: string;   // critical/high/medium/low
  tags?: string[];
}

// Projects whose default team is already confirmed to surface Bugs on the
// Backlogs view (bugsBehavior = asRequirements). Keyed by baseUrl+project so
// we only hit the teamsettings API once per process lifetime.
const backlogEnsured = new Set<string>();

/**
 * Make pushed Bugs visible on Boards → Backlogs, not just the Work Items list.
 * Azure DevOps hides Bug work items from the backlog unless the team setting
 * "Working with bugs" is "Bugs are managed with requirements". Flipping
 * bugsBehavior to 'asRequirements' on the project's default team makes every
 * Bug in the team's area path (including previously pushed ones) appear on the
 * Backlogs view. Omitting the team segment in the URL targets the default team.
 *
 * Best-effort: needs the same Work Items (Read & Write) PAT scope as creating
 * a work item, but if the account lacks team-settings permission the push must
 * still succeed — the caller only loses backlog visibility.
 */
async function ensureBugsShowOnBacklog(creds: AdoCreds): Promise<void> {
  const key = `${creds.baseUrl}/${creds.project}`;
  if (backlogEnsured.has(key)) return;

  const url = `${creds.baseUrl}/${encodeURIComponent(creds.project)}/_apis/work/teamsettings?api-version=${API_VERSION}`;
  const headers = { ...authHeaders(creds), 'Content-Type': 'application/json' };

  const current = await axios.get(url, { headers });
  if (current.data?.bugsBehavior !== 'asRequirements') {
    await axios.patch(url, { bugsBehavior: 'asRequirements' }, { headers });
  }
  backlogEnsured.add(key);
}

/**
 * Create a Bug work item in Azure DevOps from an IntelliQE bug. Uses the
 * JSON-Patch document format Azure requires (Content-Type
 * application/json-patch+json). Returns the new work item's id + browser url.
 */
export async function createBug(creds: AdoCreds, bug: AdoBugInput): Promise<{ id: number; url: string }> {
  // Bugs raised from IntelliQE should land on the team's Backlogs view, not
  // only the flat Work Items list — ensure the team setting before pushing.
  try {
    await ensureBugsShowOnBacklog(creds);
  } catch (e: any) {
    console.warn(
      'Azure DevOps: could not set "Bugs are managed with requirements" on the default team — ' +
      'bugs will be created but may not appear on the Backlogs view. ' +
      'Set it manually under Project settings → Team configuration → Working with bugs. ' +
      `Reason: ${e?.response?.data?.message || e?.message || e}`,
    );
  }

  const url = `${creds.baseUrl}/${encodeURIComponent(creds.project)}/_apis/wit/workitems/${encodeURIComponent('$Bug')}?api-version=${API_VERSION}`;

  // Repro steps carry the reproduce/expected/actual/environment detail as HTML.
  const reproParts: string[] = [];
  if (bug.stepsToReproduce) reproParts.push(`<b>Steps to Reproduce</b><br/>${esc(bug.stepsToReproduce)}`);
  if (bug.expectedResult) reproParts.push(`<b>Expected Result</b><br/>${esc(bug.expectedResult)}`);
  if (bug.actualResult) reproParts.push(`<b>Actual Result</b><br/>${esc(bug.actualResult)}`);
  if (bug.environment) reproParts.push(`<b>Environment</b>: ${esc(bug.environment)}`);
  reproParts.push(`<br/><i>Raised from IntelliQE.</i>`);

  const baseOps: { op: string; path: string; value: any }[] = [
    { op: 'add', path: '/fields/System.Title', value: bug.title.slice(0, 255) },
    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: reproParts.join('<br/><br/>') },
  ];
  if (bug.description) baseOps.push({ op: 'add', path: '/fields/System.Description', value: esc(bug.description) });
  const prio = mapPriority(bug.priority);
  if (prio) baseOps.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: prio });
  const sev = mapSeverity(bug.severity);
  if (sev) baseOps.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: sev });
  if (creds.areaPath) baseOps.push({ op: 'add', path: '/fields/System.AreaPath', value: creds.areaPath });

  // Tags are best-effort: creating a NEW tag needs a separate permission
  // ("TF401289: does not have permissions to create tags"). If the PAT lacks it,
  // don't fail the whole push — drop the tags and create the bug anyway.
  const tags = ['IntelliQE', ...(bug.tags || []).filter(Boolean)].join('; ');
  const withTags = [...baseOps, { op: 'add', path: '/fields/System.Tags', value: tags }];

  const post = (ops: any[]) => axios.post(url, ops, {
    headers: { ...authHeaders(creds), 'Content-Type': 'application/json-patch+json' },
  });

  let resp;
  try {
    resp = await post(withTags);
  } catch (err: any) {
    const msg = String(err?.response?.data?.message || err?.message || '');
    if (/TF401289|permission.*create tags/i.test(msg)) {
      resp = await post(baseOps); // retry without tags
    } else {
      throw err;
    }
  }
  const id = Number(resp.data?.id);
  const webUrl = resp.data?._links?.html?.href
    || `${creds.baseUrl}/${encodeURIComponent(creds.project)}/_workitems/edit/${id}`;
  return { id, url: webUrl };
}

/**
 * Delete an Azure DevOps work item (moves it to the project Recycle Bin — the
 * standard, reversible delete). Used to cascade an IntelliQE bug deletion to the
 * ADO Bug it was raised as.
 */
export async function deleteWorkItem(creds: AdoCreds, id: number): Promise<void> {
  const url = `${creds.baseUrl}/${encodeURIComponent(creds.project)}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`;
  // X-TFS-FedAuthRedirect makes an expired/invalid PAT fail with a 401 instead
  // of a 2xx redirect to an HTML sign-in page (which would look like success).
  const resp = await axios.delete(url, {
    headers: { ...authHeaders(creds), 'X-TFS-FedAuthRedirect': 'Suppress' },
  });
  // ADO wraps permission failures in HTTP 200 with an error body that still
  // echoes the work item id: {"id":9,"code":404,"message":"VS403145:
  // Insufficient permissions to delete work item 9."} — so checking the id
  // alone is not enough. A real delete returns a WorkItemDelete body
  // ({ id, code: 200, deletedBy, deletedDate, ... }) with no message.
  const data = resp.data;
  const bodyCode = data && typeof data === 'object' ? Number(data.code) : NaN;
  if (data && typeof data === 'object' && typeof data.message === 'string') {
    throw new Error(data.message);
  }
  if (!data || typeof data !== 'object' || Number(data.id) !== id || (Number.isFinite(bodyCode) && bodyCode >= 300)) {
    throw new Error(
      'Azure DevOps did not confirm the delete. Check that the PAT is valid and the account has the "Delete and restore work items" permission.',
    );
  }
}

export async function getTestCases(creds: AdoCreds): Promise<TestCaseSummary[]> {
  const ids = await wiqlIds(creds, `[System.WorkItemType] = 'Test Case'`, 200);
  const items = await batchFields(creds, ids, ['System.Id', 'System.Title', 'System.State', 'Microsoft.VSTS.TCM.Steps']);
  return items.map((w) => ({
    key: String(w.id),
    title: w.fields?.['System.Title'] ?? '',
    state: w.fields?.['System.State'] ?? '',
    steps: parseTestSteps(w.fields?.['Microsoft.VSTS.TCM.Steps'] || ''),
  }));
}

// ─── DB helpers (tenant-scoped, client_configurations) ───
export async function getCredsForTenant(tenantId: string): Promise<AdoCreds | null> {
  const { rows } = await pool.query(
    `SELECT config_data FROM client_configurations
      WHERE tenant_id = $1 AND integration_id = 'azure-devops' AND status = 'connected'`,
    [tenantId],
  );
  if (rows.length === 0) return null;
  const cfg = decryptConfigData(rows[0].config_data || {});
  const { baseUrl, org } = normalizeOrg(cfg.org_url || '');
  if (!baseUrl || !cfg.project || !cfg.auth_header) return null;
  return { baseUrl, org, project: cfg.project, authHeader: cfg.auth_header, areaPath: cfg.area_path || undefined };
}

export async function saveCredsForTenant(
  tenantId: string,
  username: string,
  orgUrl: string,
  project: string,
  authHeader: string,
  displayName: string,
  areaPath?: string,
): Promise<void> {
  const config = encryptConfigData({
    org_url: orgUrl,
    project,
    auth_header: authHeader,
    area_path: areaPath || null,
    display_name: displayName,
  });
  await pool.query(
    `MERGE INTO client_configurations WITH (HOLDLOCK) AS t
     USING (SELECT $1 AS tenant_id, 'azure-devops' AS integration_id) AS s
       ON t.tenant_id = s.tenant_id AND t.integration_id = s.integration_id
     WHEN MATCHED THEN
       UPDATE SET status = 'connected', config_data = $2, connected_by = $3,
                  connected_at = SYSUTCDATETIME(), last_sync_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN
       INSERT (tenant_id, integration_id, status, config_data, connected_by, connected_at, last_sync_at)
       VALUES ($1, 'azure-devops', 'connected', $2, $3, SYSUTCDATETIME(), SYSUTCDATETIME());`,
    [tenantId, JSON.stringify(config), username],
  );
}

export async function deleteCredsForTenant(tenantId: string): Promise<void> {
  await pool.query(
    `DELETE FROM client_configurations WHERE tenant_id = $1 AND integration_id = 'azure-devops'`,
    [tenantId],
  );
}

export async function getConnectionStatus(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT config_data, connected_by, connected_at, last_sync_at
       FROM client_configurations
      WHERE tenant_id = $1 AND integration_id = 'azure-devops' AND status = 'connected'`,
    [tenantId],
  );
  if (rows.length === 0) return { connected: false };
  const cfg = rows[0].config_data || {};
  return {
    connected: true,
    orgUrl: cfg.org_url,
    project: cfg.project,
    displayName: cfg.display_name,
    connectedBy: rows[0].connected_by,
    connectedAt: rows[0].connected_at,
    lastSyncAt: rows[0].last_sync_at,
  };
}

export default {
  testConnection, getStories, getStory, getWorkItems, getTestCases, createBug, deleteWorkItem,
  getCredsForTenant, saveCredsForTenant, deleteCredsForTenant, getConnectionStatus,
  normalizeOrg, buildAuthHeader,
};
