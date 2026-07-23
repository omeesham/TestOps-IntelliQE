import axios from 'axios';
import pool from '../db.js';
import { decryptConfigData, encryptConfigData } from '../utils/crypto.js';

// --- Types ---
export type JiraCreds = { baseUrl: string; authHeader: string; projectKey?: string };
type JiraUser = { accountId: string; displayName: string; emailAddress?: string; avatarUrl?: string };
type StorySummary = { key: string; summary: string; assignee: JiraUser | null };
type StoryDetails = {
  key: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
};

/**
 * Reduce any JIRA URL to the API base = the site ORIGIN (scheme + host).
 * Atlassian Cloud serves the REST API at the host root (https://site.atlassian.net
 * + /rest/api/3/...). Users frequently paste a board/project URL like
 * `https://site.atlassian.net/jira/software/c/projects/IQ/boards/447`; that path
 * returns the app's HTML (HTTP 200) for every `/rest/...` sub-path, so requests
 * silently "succeed" while returning no data. Stripping to the origin fixes it.
 * Applied on BOTH write and read so already-saved bad values self-heal.
 */
export function toApiBase(raw: string): string {
  let s = (raw || '').trim();
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return s.replace(/\/+$/, '');
  }
}

/**
 * Pull the JIRA project key out of a pasted URL so we can scope story fetches to
 * the project the user is actually working on — not every project in the org.
 * Handles the common shapes:
 *   .../projects/IQ/boards/447   .../jira/software/c/projects/IQ/...
 *   .../browse/IQ-123            ?projectKey=IQ / ?selectedProjectKey=IQ
 * Returns the upper-cased key, or undefined when the URL is just the site root.
 */
export function extractProjectKey(url: string): string | undefined {
  const s = url || '';
  let m = s.match(/\/projects\/([A-Za-z][A-Za-z0-9_]+)/);
  if (m) return m[1]!.toUpperCase();
  m = s.match(/\/browse\/([A-Za-z][A-Za-z0-9_]+)-\d+/);
  if (m) return m[1]!.toUpperCase();
  m = s.match(/[?&](?:projectKey|selectedProjectKey)=([A-Za-z0-9_]+)/i);
  if (m) return m[1]!.toUpperCase();
  return undefined;
}

// --- DB helpers (tenant-scoped) ---
export async function getCredsForTenant(tenantId: string): Promise<JiraCreds | null> {
  // First check client_configurations, fall back to legacy jira_connections
  const { rows } = await pool.query(
    `SELECT config_data FROM client_configurations WHERE tenant_id = $1 AND integration_id = 'jira' AND status = 'connected'`,
    [tenantId]
  );
  if (rows.length > 0) {
    // Decrypt any encrypted fields from DB storage
    const cfg = decryptConfigData(rows[0].config_data);
    // Prefer an explicitly stored project_key; otherwise recover it from the
    // originally-saved URL (which still carries /projects/<KEY>/...).
    const projectKey = cfg.project_key || extractProjectKey(cfg.jira_url);
    return { baseUrl: toApiBase(cfg.jira_url), authHeader: cfg.auth_header, projectKey };
  }
  // Legacy fallback
  const legacy = await pool.query(
    `SELECT jira_url, auth_header FROM jira_connections WHERE tenant_id = $1`,
    [tenantId]
  );
  if (legacy.rows.length === 0) return null;
  return {
    baseUrl: toApiBase(legacy.rows[0].jira_url),
    authHeader: legacy.rows[0].auth_header,
    projectKey: extractProjectKey(legacy.rows[0].jira_url),
  };
}

export async function saveCredsForTenant(
  tenantId: string,
  username: string,
  jiraUrl: string,
  authHeader: string,
  displayName?: string,
  projectKey?: string
): Promise<void> {
  // Write to legacy table
  await pool.query(
    `MERGE INTO jira_connections WITH (HOLDLOCK) AS t
     USING (SELECT $1 AS username) AS s ON t.username = s.username
     WHEN MATCHED THEN
       UPDATE SET jira_url = $2, auth_header = $3, display_name = $4, tenant_id = $5, created_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN
       INSERT (username, jira_url, auth_header, display_name, tenant_id) VALUES ($1, $2, $3, $4, $5);`,
    [username, jiraUrl, authHeader, displayName || null, tenantId]
  );
  // Dual-write to client_configurations
  await pool.query(
    `MERGE INTO client_configurations WITH (HOLDLOCK) AS t
     USING (SELECT $1 AS tenant_id, 'jira' AS integration_id) AS s
       ON t.tenant_id = s.tenant_id AND t.integration_id = s.integration_id
     WHEN MATCHED THEN
       UPDATE SET status = 'connected', config_data = $2, connected_by = $3,
                  connected_at = SYSUTCDATETIME(), last_sync_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN
       INSERT (tenant_id, integration_id, status, config_data, connected_by, connected_at, last_sync_at)
       VALUES ($1, 'jira', 'connected', $2, $3, SYSUTCDATETIME(), SYSUTCDATETIME());`,
    [tenantId, JSON.stringify(encryptConfigData({ jira_url: jiraUrl, auth_header: authHeader, display_name: displayName, project_key: projectKey || null })), username]
  );
}

export async function deleteCredsForTenant(tenantId: string): Promise<void> {
  await pool.query(`DELETE FROM jira_connections WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM client_configurations WHERE tenant_id = $1 AND integration_id = 'jira'`, [tenantId]);
}

export async function getConnectionStatus(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT config_data, connected_by, connected_at, last_sync_at
     FROM client_configurations
     WHERE tenant_id = $1 AND integration_id = 'jira' AND status = 'connected'`,
    [tenantId]
  );
  if (rows.length === 0) {
    // Legacy fallback
    const legacy = await pool.query(
      `SELECT jira_url, display_name, created_at FROM jira_connections WHERE tenant_id = $1`,
      [tenantId]
    );
    if (legacy.rows.length === 0) return { connected: false };
    return {
      connected: true,
      jiraUrl: legacy.rows[0].jira_url,
      displayName: legacy.rows[0].display_name,
      connectedAt: legacy.rows[0].created_at,
    };
  }
  const cfg = rows[0].config_data;
  return {
    connected: true,
    jiraUrl: cfg.jira_url,
    displayName: cfg.display_name,
    connectedBy: rows[0].connected_by,
    connectedAt: rows[0].connected_at,
    lastSyncAt: rows[0].last_sync_at,
  };
}

// --- JIRA HTTP helper ---
async function request<T>(creds: JiraCreds, url: string, params?: Record<string, any>): Promise<T> {
  const resp = await axios.get<T>(url, {
    params,
    headers: {
      Authorization: creds.authHeader,
      Accept: 'application/json',
    },
  });
  return resp.data;
}

// PUT sibling of request() — same auth headers, used for issue mutations (assign).
async function putRequest<T>(creds: JiraCreds, url: string, body: any): Promise<T> {
  const resp = await axios.put<T>(url, body, {
    headers: {
      Authorization: creds.authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
  return resp.data;
}

// POST sibling of request() — used for issue creation.
async function postRequest<T>(creds: JiraCreds, url: string, body: any): Promise<T> {
  const resp = await axios.post<T>(url, body, {
    headers: {
      Authorization: creds.authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
  return resp.data;
}

// Normalise a JIRA user object into the shape the UI needs.
function mapUser(u: any): { accountId: string; displayName: string; emailAddress?: string; avatarUrl?: string } | null {
  if (!u || !u.accountId) return null;
  return {
    accountId: u.accountId,
    displayName: u.displayName || u.emailAddress || u.accountId,
    emailAddress: u.emailAddress || undefined,
    avatarUrl: u.avatarUrls?.['24x24'] || u.avatarUrls?.['48x48'] || undefined,
  };
}

// --- Issue type discovery ---
// Best-effort: discovery is a convenience to scope the JQL to this instance's
// real Story/Task names. If it fails (permission scope, deprecated payload,
// transient error) we MUST NOT abort the whole stories fetch — fall back to the
// standard names and let the search itself surface any genuine auth error.
async function getIssueTypeNames(creds: JiraCreds): Promise<string[]> {
  try {
    const url = `${creds.baseUrl}/rest/api/3/issuetype`;
    const all = await request<any[]>(creds, url);
    const names = (all || []).map((t) => String(t?.name || '').trim()).filter(Boolean);
    const matched = Array.from(new Set(names.filter((n) => /story/i.test(n) || /^task$/i.test(n))));
    return matched.length ? matched : ['Story', 'Task'];
  } catch (err: any) {
    console.warn('[jira] issue-type discovery failed, using defaults:', err?.response?.status || err?.message);
    return ['Story', 'Task'];
  }
}

// --- HTML to plain text helpers ---
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
  out = out.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
  out = out.replace(/<p[^>]*>/gi, '');
  out = out.replace(/<\/p>/gi, '\n');
  out = out.replace(/<[^>]+>/g, '');
  out = decodeHtmlEntities(out)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out;
}

function extractSectionByHeading(html: string, contains: RegExp) {
  if (!html) return null;
  const headingRegex = /<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi;
  const headings: { start: number; end: number; text: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRegex.exec(html)) !== null) {
    const raw = m[0];
    const text = htmlToPlain(raw).trim();
    headings.push({ start: m.index, end: m.index + raw.length, text });
  }
  let idx = -1;
  for (let i = 0; i < headings.length; i++) {
    if (contains.test(headings[i].text)) { idx = i; break; }
  }
  if (idx === -1) return null;
  const acHead = headings[idx];
  const sectionStart = acHead.end;
  const sectionEnd = idx + 1 < headings.length ? headings[idx + 1].start : html.length;
  const sectionHtml = html.slice(sectionStart, sectionEnd);
  const withoutSectionHtml = html.slice(0, acHead.start) + html.slice(sectionEnd);
  return { sectionHtml, withoutSectionHtml };
}

// --- Public API ---
export async function testConnection(creds: JiraCreds): Promise<any> {
  const url = `${creds.baseUrl}/rest/api/3/myself`;
  const me = await request<any>(creds, url);
  // A wrong Base URL (e.g. a board URL) returns the app's HTML with HTTP 200 and
  // no accountId — reject it instead of saving a connection that can't fetch.
  if (!me || typeof me !== 'object' || !me.accountId) {
    throw new Error(
      'That URL did not return a JIRA API response. Use your site root — e.g. https://your-site.atlassian.net — not a board or project URL.',
    );
  }
  return { accountId: me.accountId, displayName: me.displayName, locale: me.locale };
}

function isStoryOrTask(name: string): boolean {
  return /story/i.test(name) || /^task$/i.test(name);
}

export async function getStories(creds: JiraCreds): Promise<StorySummary[]> {
  // Use the new /search/jql endpoint (old /search was removed by Atlassian).
  const url = `${creds.baseUrl}/rest/api/3/search/jql`;

  const run = async (jql: string, maxResults: number): Promise<any[]> => {
    const data = await request<any>(creds, url, { jql, maxResults, fields: 'summary,issuetype,assignee' });
    return Array.isArray(data.issues) ? data.issues : [];
  };

  const issueTypeNames = await getIssueTypeNames(creds);
  const quoted = issueTypeNames.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(', ');
  // Scope to the project the user linked (e.g. "IQ"), not the whole org. The
  // project restriction also makes the JQL "bounded" for the new search API.
  const projectClause = creds.projectKey ? `project = "${creds.projectKey}" AND ` : '';
  const scopedJql = `${projectClause}issuetype in (${quoted}) ORDER BY created DESC`;

  let issues: any[] = [];
  try {
    issues = await run(scopedJql, 50);
  } catch (err: any) {
    // Auth / permission failures won't be fixed by a broader query — surface them.
    const status = err?.response?.status;
    if (status === 401 || status === 403) throw err;
  }

  // Empty result OR a non-auth failure above → broaden issue types but KEEP the
  // project scope. The new endpoint rejects unbounded JQL, so when there's no
  // project we add a date restriction instead.
  if (issues.length === 0) {
    const broadJql = creds.projectKey
      ? `project = "${creds.projectKey}" ORDER BY created DESC`
      : 'created >= "2000-01-01" ORDER BY created DESC';
    try {
      const broad = await run(broadJql, 100);
      issues = broad.filter((i: any) => isStoryOrTask(String(i?.fields?.issuetype?.name || '')));
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) throw err;
      // Otherwise return whatever we have (likely empty).
    }
  }

  return issues.map((i: any) => ({
    key: i.key,
    summary: i.fields?.summary ?? '',
    assignee: mapUser(i.fields?.assignee),
  }));
}

// --- Assignee support ---
// Current connected JIRA user — used for the "Assign to me" shortcut.
export async function getCurrentUser(creds: JiraCreds): Promise<JiraUser> {
  const url = `${creds.baseUrl}/rest/api/3/myself`;
  const me = await request<any>(creds, url);
  const mapped = mapUser(me);
  if (!mapped) {
    throw new Error('Could not resolve the current JIRA user (no accountId returned).');
  }
  return mapped;
}

// Users who can be assigned to an issue (or, as a fallback, to the project).
export async function getAssignableUsers(creds: JiraCreds, issueKey?: string): Promise<JiraUser[]> {
  const url = `${creds.baseUrl}/rest/api/3/user/assignable/search`;
  const params: Record<string, any> = { maxResults: 50 };
  if (issueKey) params.issueKey = issueKey;
  else if (creds.projectKey) params.project = creds.projectKey;
  const users = await request<any[]>(creds, url, params);
  return (Array.isArray(users) ? users : []).map(mapUser).filter((u): u is JiraUser => u !== null);
}

// Assign an issue to a user. JIRA Cloud requires accountId (not username).
export async function assignIssue(creds: JiraCreds, issueKey: string, accountId: string): Promise<{ ok: true }> {
  const url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`;
  await putRequest(creds, url, { accountId });
  return { ok: true };
}

// Remove the assignee from an issue. JIRA Cloud clears it with accountId: null.
export async function unassignIssue(creds: JiraCreds, issueKey: string): Promise<{ ok: true }> {
  const url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`;
  await putRequest(creds, url, { accountId: null });
  return { ok: true };
}

export async function getStory(creds: JiraCreds, key: string): Promise<StoryDetails> {
  const url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}`;
  const params = { expand: 'renderedFields,names', fields: '*all' };
  const data = await request<any>(creds, url, params);

  const title: string = data.fields?.summary ?? key;
  let renderedDesc: string | undefined = data.renderedFields?.description;
  let acPlain: string | undefined;

  // 1) Specific AC custom field (if configured)
  const configuredKey = process.env.JIRA_AC_FIELD_KEY;
  if (configuredKey && data.fields?.hasOwnProperty(configuredKey)) {
    const v = data.fields[configuredKey];
    acPlain = typeof v === 'string' ? htmlToPlain(v) : htmlToPlain(JSON.stringify(v));
  }

  // 2) Auto-discover AC field by visible name
  if (!acPlain) {
    const names = data.names || {};
    for (const fieldId of Object.keys(names)) {
      const label = String(names[fieldId] || '').toLowerCase();
      if (label.includes('acceptance') && label.includes('criteria')) {
        const v = data.fields?.[fieldId];
        if (v != null) {
          acPlain = typeof v === 'string' ? htmlToPlain(v) : htmlToPlain(JSON.stringify(v));
          break;
        }
      }
    }
  }

  // 3) Extract AC from description HTML
  let descriptionPlain: string | undefined;
  if (!acPlain && renderedDesc) {
    const picked = extractSectionByHeading(renderedDesc, /acceptance\s*criteria/i);
    if (picked && picked.sectionHtml) {
      acPlain = htmlToPlain(picked.sectionHtml);
      renderedDesc = picked.withoutSectionHtml;
    }
  }

  // 4) Plain-text extraction fallback
  if (!acPlain && !renderedDesc && typeof data.fields?.description === 'string') {
    const text = data.fields.description as string;
    const lines = text.split(/\r?\n/);
    const startIdx = lines.findIndex((l: string) => /(^|\b)Acceptance\s*Criteria\b/i.test(l));
    if (startIdx !== -1) {
      const kept: string[] = [];
      for (let i = 0; i < startIdx; i++) kept.push(lines[i]);
      const ac: string[] = [];
      let i = startIdx + 1;
      for (; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*#{1,6}\s+\w+/.test(line)) break;
        if (/^\s*[A-Z][A-Za-z ]{2,}:\s*$/.test(line)) break;
        ac.push(line);
      }
      acPlain = ac.join('\n').trim();
      const rest = lines.slice(i).join('\n');
      descriptionPlain = (kept.join('\n') + '\n' + rest).trim();
    } else {
      descriptionPlain = text.trim();
    }
  }

  // Finalize description
  if (!descriptionPlain) {
    if (renderedDesc) descriptionPlain = htmlToPlain(renderedDesc);
    else if (typeof data.fields?.description === 'string') descriptionPlain = data.fields.description.trim();
    else if (data.fields?.description) descriptionPlain = htmlToPlain(JSON.stringify(data.fields.description));
  }

  return { key, title, description: descriptionPlain, acceptanceCriteria: acPlain || '' };
}

// --- Bug push (Bug Tracker → JIRA) ---
export interface JiraBugInput {
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

// IntelliQE P0–P3 → the default JIRA priority scheme.
const JIRA_PRIORITY_MAP: Record<string, string> = {
  P0: 'Highest', P1: 'High', P2: 'Medium', P3: 'Low',
};

// One labelled section of the ADF description: a bold label paragraph followed
// by the section text (one paragraph per line, blank lines dropped).
function adfSection(label: string, text: string): any[] {
  const paras = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }));
  return [
    { type: 'paragraph', content: [{ type: 'text', text: label, marks: [{ type: 'strong' }] }] },
    ...paras,
  ];
}

// Best-effort: find this instance's real Bug issue-type name. Defaults to
// 'Bug' when discovery fails — the create call will surface a genuine error.
async function findBugIssueTypeName(creds: JiraCreds): Promise<string> {
  try {
    const all = await request<any[]>(creds, `${creds.baseUrl}/rest/api/3/issuetype`);
    const names = (all || []).map((t) => String(t?.name || '').trim()).filter(Boolean);
    return names.find((n) => /^bug$/i.test(n)) || names.find((n) => /bug|defect/i.test(n)) || 'Bug';
  } catch {
    return 'Bug';
  }
}

/**
 * Create a Bug issue in JIRA from an IntelliQE bug. The full bug detail
 * (description, repro steps, expected/actual, environment, severity) lands in
 * the issue description as ADF so it reads well on the JIRA board. Returns the
 * new issue's key + browser url.
 */
export async function createBug(creds: JiraCreds, bug: JiraBugInput): Promise<{ key: string; url: string }> {
  if (!creds.projectKey) {
    throw new Error('No JIRA project is linked. Re-connect JIRA in System Configuration using a project or board URL (e.g. .../projects/IQ/...).');
  }
  const issueType = await findBugIssueTypeName(creds);

  const content: any[] = [];
  if (bug.description) content.push(...adfSection('Description', bug.description));
  if (bug.stepsToReproduce) content.push(...adfSection('Steps to Reproduce', bug.stepsToReproduce));
  if (bug.expectedResult) content.push(...adfSection('Expected Result', bug.expectedResult));
  if (bug.actualResult) content.push(...adfSection('Actual Result', bug.actualResult));
  if (bug.environment) content.push(...adfSection('Environment', bug.environment));
  if (bug.severity) content.push(...adfSection('Severity', bug.severity));
  content.push({ type: 'paragraph', content: [{ type: 'text', text: 'Raised from IntelliQE.', marks: [{ type: 'em' }] }] });

  const baseFields: Record<string, any> = {
    project: { key: creds.projectKey },
    issuetype: { name: issueType },
    summary: bug.title.slice(0, 255),
    description: { type: 'doc', version: 1, content },
  };
  // JIRA labels cannot contain spaces — dash them.
  const labels = ['IntelliQE', ...(bug.tags || [])]
    .map((t) => String(t).trim().replace(/\s+/g, '-'))
    .filter(Boolean);
  const priorityName = JIRA_PRIORITY_MAP[bug.priority || ''];
  const richFields = {
    ...baseFields,
    labels,
    ...(priorityName ? { priority: { name: priorityName } } : {}),
  };

  const post = (fields: Record<string, any>) =>
    postRequest<any>(creds, `${creds.baseUrl}/rest/api/3/issue`, { fields });

  let data: any;
  try {
    data = await post(richFields);
  } catch (err: any) {
    // priority/labels are frequently not on the project's create screen; the
    // push must still succeed — retry with just the core fields.
    const fieldErrors = err?.response?.data?.errors || {};
    if (err?.response?.status === 400 && (fieldErrors.priority || fieldErrors.labels)) {
      data = await post(baseFields);
    } else {
      throw err;
    }
  }
  const key = data?.key;
  if (!key) throw new Error('JIRA did not return an issue key for the created bug.');
  return { key, url: `${creds.baseUrl}/browse/${key}` };
}

/**
 * Delete a JIRA issue (used to cascade an IntelliQE bug deletion / unlink to
 * the JIRA Bug it was raised as). Subtasks are deleted along with it.
 */
export async function deleteIssue(creds: JiraCreds, issueKey: string): Promise<void> {
  await axios.delete(`${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    params: { deleteSubtasks: 'true' },
    headers: { Authorization: creds.authHeader, Accept: 'application/json' },
  });
}

export default { testConnection, getStories, getStory, getCurrentUser, getAssignableUsers, assignIssue, unassignIssue, getCredsForTenant, saveCredsForTenant, deleteCredsForTenant, getConnectionStatus, createBug, deleteIssue };
