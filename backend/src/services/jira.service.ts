import axios from 'axios';
import pool from '../db.js';
import { decryptConfigData, encryptConfigData } from '../utils/crypto.js';

// --- Types ---
export type JiraCreds = { baseUrl: string; authHeader: string; projectKey?: string };
type StorySummary = { key: string; summary: string };
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
 * Validate that the pasted value is actually a JIRA site URL — not, e.g., an
 * API token typed into the URL field by mistake. That mistake otherwise reaches
 * the network layer as `https://ATATT…/` and surfaces as a cryptic DNS
 * "ENOTFOUND". Returns a user-facing error string, or null when the URL is OK.
 */
export function validateJiraUrl(raw: string): string | null {
  const s = (raw || '').trim();
  if (!s) return 'JIRA URL is required.';
  let host: string;
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    host = new URL(withProto).host;
  } catch {
    return 'That JIRA URL is not valid. Use your site root — e.g. https://your-site.atlassian.net.';
  }
  // Drop any port to check the bare hostname.
  const hostname = host.replace(/:\d+$/, '');
  if (!hostname) {
    return 'That JIRA URL is not valid. Use your site root — e.g. https://your-site.atlassian.net.';
  }
  // A real host is dotted (sub.domain.tld). An Atlassian API token ("ATATT…") or
  // any bare word has no dot — almost always a token pasted into the URL field.
  if (!hostname.includes('.')) {
    return 'That looks like an API token or an incomplete address, not a JIRA URL. Enter your site URL — e.g. https://your-site.atlassian.net — here, and put the token in the API Token field.';
  }
  return null;
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
  // Tables: keep the grid readable so an API table pasted into a description or
  // comment survives as tab-separated rows (cells merged into one run would lose
  // the method/URL/status columns and defeat endpoint extraction).
  out = out.replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, '\t');
  out = out.replace(/<\/tr>/gi, '\n');
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
    const data = await request<any>(creds, url, { jql, maxResults, fields: 'summary,issuetype' });
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
  }));
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

// --- Expanded fetch (Module 4): projects + all issue types ---
export interface JiraProject { key: string; name: string; id: string; projectTypeKey?: string }
export interface JiraIssueSummary { key: string; summary: string; type: string; status?: string; priority?: string; parentKey?: string }

/** List the projects visible to the connected account. */
export async function getProjects(creds: JiraCreds): Promise<JiraProject[]> {
  const data = await request<any>(creds, `${creds.baseUrl}/rest/api/3/project/search`, { maxResults: 100, orderBy: 'name' });
  const values = Array.isArray(data?.values) ? data.values : Array.isArray(data) ? data : [];
  return values.map((p: any) => ({ key: p.key, name: p.name, id: String(p.id), projectTypeKey: p.projectTypeKey })).slice(0, 200);
}

const ISSUE_FIELDS = 'summary,issuetype,status,priority,parent';

/** Map a raw Jira issue (search or agile endpoint) to our summary shape. */
function mapIssue(i: any): JiraIssueSummary {
  return {
    key: i.key,
    summary: i.fields?.summary ?? '',
    type: i.fields?.issuetype?.name ?? '',
    status: i.fields?.status?.name,
    priority: i.fields?.priority?.name,
    parentKey: i.fields?.parent?.key,
  };
}

/**
 * Build bounded JQL from filter options. An explicit `jql` wins; otherwise a
 * project/type clause is assembled, with a date floor so the new /search/jql
 * endpoint (which rejects unbounded JQL) always has a bound.
 */
function buildIssuesJql(opts: { types?: string[]; jql?: string; projectKey?: string }, fallbackProjectKey?: string): string {
  const explicit = (opts.jql || '').trim();
  if (explicit) return explicit;
  const projectKey = opts.projectKey || fallbackProjectKey;
  const clauses: string[] = [];
  if (projectKey) clauses.push(`project = "${projectKey}"`);
  if (opts.types?.length) {
    const quoted = opts.types.map((t) => `"${String(t).replace(/"/g, '\\"')}"`).join(', ');
    clauses.push(`issuetype in (${quoted})`);
  }
  if (!clauses.length) clauses.push('created >= "2000-01-01"'); // keep the JQL bounded
  return `${clauses.join(' AND ')} ORDER BY created DESC`;
}

/**
 * Fetch issues of any type (epics, stories, tasks, subtasks, bugs). Scoped to a
 * project when one is known; the new /search/jql endpoint requires bounded JQL,
 * so a date clause is added when there is no project or type restriction.
 */
export async function getIssues(
  creds: JiraCreds,
  opts?: { types?: string[]; jql?: string; maxResults?: number; projectKey?: string },
): Promise<JiraIssueSummary[]> {
  const max = Math.min(100, Math.max(1, opts?.maxResults ?? 50));
  const jql = buildIssuesJql(opts || {}, creds.projectKey);
  const data = await request<any>(creds, `${creds.baseUrl}/rest/api/3/search/jql`, {
    jql, maxResults: max, fields: ISSUE_FIELDS,
  });
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  return issues.map(mapIssue);
}

/**
 * Fetch ALL matching issues across pages, beyond the single-request cap. The new
 * /search/jql endpoint is token-paginated: each response carries a
 * `nextPageToken` until the last page (`isLast: true` / token absent). A total
 * cap and an iteration guard keep this bounded even on a misbehaving server.
 */
export async function getAllIssues(
  creds: JiraCreds,
  opts?: { types?: string[]; jql?: string; projectKey?: string; maxTotal?: number; pageSize?: number },
): Promise<JiraIssueSummary[]> {
  const maxTotal = Math.min(5000, Math.max(1, opts?.maxTotal ?? 1000));
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 100));
  const jql = buildIssuesJql(opts || {}, creds.projectKey);
  const url = `${creds.baseUrl}/rest/api/3/search/jql`;
  const out: JiraIssueSummary[] = [];
  let nextPageToken: string | undefined;
  let guard = 0;
  do {
    const data = await request<any>(creds, url, {
      jql,
      maxResults: Math.min(pageSize, maxTotal - out.length),
      fields: ISSUE_FIELDS,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    const issues = Array.isArray(data?.issues) ? data.issues : [];
    for (const i of issues) out.push(mapIssue(i));
    nextPageToken = typeof data?.nextPageToken === 'string' ? data.nextPageToken : undefined;
    if (data?.isLast === true || issues.length === 0) nextPageToken = undefined;
    guard += 1;
  } while (nextPageToken && out.length < maxTotal && guard < 200);
  return out.slice(0, maxTotal);
}

// --- Comments & changelog (read) ---
export interface JiraComment { id: string; author?: string; body: string; created?: string; updated?: string }

/** Read an issue's comments as plain text (rendered HTML flattened), newest first. */
export async function getIssueComments(creds: JiraCreds, key: string, opts?: { maxResults?: number }): Promise<JiraComment[]> {
  const max = Math.min(100, Math.max(1, opts?.maxResults ?? 50));
  const url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/comment`;
  const data = await request<any>(creds, url, { maxResults: max, expand: 'renderedBody', orderBy: '-created' });
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  return comments
    .map((c: any): JiraComment => ({
      id: String(c?.id ?? ''),
      author: c?.author?.displayName || undefined,
      body: c?.renderedBody ? htmlToPlain(String(c.renderedBody))
        : typeof c?.body === 'string' ? c.body
        : c?.body ? htmlToPlain(JSON.stringify(c.body)) : '',
      created: c?.created || undefined,
      updated: c?.updated || undefined,
    }))
    .filter((c: JiraComment) => c.id);
}

export interface JiraChange { field: string; from?: string; to?: string }
export interface JiraChangelogEntry { id: string; author?: string; created?: string; changes: JiraChange[] }

/**
 * Read an issue's change history (field transitions). Note the Jira item fields
 * are literally named `fromString` / `toString`; `toString` collides with
 * Object.prototype, so each is accepted only when it is actually a string.
 */
export async function getIssueChangelog(creds: JiraCreds, key: string, opts?: { maxResults?: number }): Promise<JiraChangelogEntry[]> {
  const max = Math.min(100, Math.max(1, opts?.maxResults ?? 50));
  const url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/changelog`;
  const data = await request<any>(creds, url, { maxResults: max });
  const values = Array.isArray(data?.values) ? data.values : [];
  return values
    .map((v: any): JiraChangelogEntry => ({
      id: String(v?.id ?? ''),
      author: v?.author?.displayName || undefined,
      created: v?.created || undefined,
      changes: (Array.isArray(v?.items) ? v.items : []).map((it: any): JiraChange => ({
        field: String(it?.field ?? it?.fieldId ?? ''),
        from: typeof it?.fromString === 'string' ? it.fromString : (it?.from != null ? String(it.from) : undefined),
        to: typeof it?.toString === 'string' ? it.toString : (it?.to != null ? String(it.to) : undefined),
      })),
    }))
    .filter((e: JiraChangelogEntry) => e.id);
}

// --- Agile: boards, sprints, backlog (/rest/agile/1.0) ---
export interface JiraBoard { id: number; name: string; type?: string }
export interface JiraSprint { id: number; name: string; state?: string; startDate?: string; endDate?: string; boardId?: number }

/** List agile boards, optionally scoped to a project (key or numeric id). */
export async function getBoards(creds: JiraCreds, opts?: { projectKeyOrId?: string; maxResults?: number }): Promise<JiraBoard[]> {
  const max = Math.min(100, Math.max(1, opts?.maxResults ?? 50));
  const params: Record<string, any> = { maxResults: max };
  if (opts?.projectKeyOrId) params.projectKeyOrId = opts.projectKeyOrId;
  const data = await request<any>(creds, `${creds.baseUrl}/rest/agile/1.0/board`, params);
  const values = Array.isArray(data?.values) ? data.values : [];
  return values
    .map((b: any): JiraBoard => ({ id: Number(b?.id), name: String(b?.name ?? ''), type: b?.type }))
    .filter((b: JiraBoard) => Number.isFinite(b.id));
}

/** List the sprints on a board, optionally by state (future | active | closed). */
export async function getSprints(creds: JiraCreds, boardId: number, opts?: { state?: string; maxResults?: number }): Promise<JiraSprint[]> {
  const max = Math.min(100, Math.max(1, opts?.maxResults ?? 50));
  const params: Record<string, any> = { maxResults: max };
  if (opts?.state) params.state = opts.state;
  const data = await request<any>(creds, `${creds.baseUrl}/rest/agile/1.0/board/${encodeURIComponent(String(boardId))}/sprint`, params);
  const values = Array.isArray(data?.values) ? data.values : [];
  return values
    .map((s: any): JiraSprint => ({ id: Number(s?.id), name: String(s?.name ?? ''), state: s?.state, startDate: s?.startDate, endDate: s?.endDate, boardId: s?.originBoardId }))
    .filter((s: JiraSprint) => Number.isFinite(s.id));
}

/** Fetch the issues in a sprint. */
export async function getSprintIssues(creds: JiraCreds, sprintId: number, opts?: { maxResults?: number }): Promise<JiraIssueSummary[]> {
  const max = Math.min(100, Math.max(1, opts?.maxResults ?? 100));
  const data = await request<any>(creds, `${creds.baseUrl}/rest/agile/1.0/sprint/${encodeURIComponent(String(sprintId))}/issue`, { maxResults: max, fields: ISSUE_FIELDS });
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  return issues.map(mapIssue);
}

/** Fetch a board's backlog issues (those not assigned to any sprint). */
export async function getBacklogIssues(creds: JiraCreds, boardId: number, opts?: { maxResults?: number }): Promise<JiraIssueSummary[]> {
  const max = Math.min(100, Math.max(1, opts?.maxResults ?? 100));
  const data = await request<any>(creds, `${creds.baseUrl}/rest/agile/1.0/board/${encodeURIComponent(String(boardId))}/backlog`, { maxResults: max, fields: ISSUE_FIELDS });
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  return issues.map(mapIssue);
}

// --- Saved JQL filters ---
export interface JiraFilter { id: string; name: string; jql: string; owner?: string; favourite?: boolean }

function mapFilter(f: any, fallbackId?: string): JiraFilter {
  return {
    id: String(f?.id ?? fallbackId ?? ''),
    name: String(f?.name ?? ''),
    jql: String(f?.jql ?? ''),
    owner: f?.owner?.displayName || undefined,
    favourite: typeof f?.favourite === 'boolean' ? f.favourite : undefined,
  };
}

/** List the account's saved JQL filters, each with its JQL. */
export async function getFilters(creds: JiraCreds, opts?: { maxResults?: number }): Promise<JiraFilter[]> {
  const max = Math.min(100, Math.max(1, opts?.maxResults ?? 50));
  const data = await request<any>(creds, `${creds.baseUrl}/rest/api/3/filter/search`, { maxResults: max, expand: 'jql,owner' });
  const values = Array.isArray(data?.values) ? data.values : [];
  return values.map((f: any) => mapFilter(f)).filter((f: JiraFilter) => f.id);
}

/** Get a single saved filter (with its JQL). */
export async function getFilter(creds: JiraCreds, id: string): Promise<JiraFilter> {
  const f = await request<any>(creds, `${creds.baseUrl}/rest/api/3/filter/${encodeURIComponent(id)}`, { expand: 'jql,owner' });
  return mapFilter(f, id);
}

/** Run a saved filter: resolve its JQL, then fetch the matching issues. */
export async function runFilter(creds: JiraCreds, id: string, opts?: { maxResults?: number; fetchAll?: boolean }): Promise<{ filter: JiraFilter; issues: JiraIssueSummary[] }> {
  const filter = await getFilter(creds, id);
  if (!filter.jql) return { filter, issues: [] };
  const issues = opts?.fetchAll
    ? await getAllIssues(creds, { jql: filter.jql, maxTotal: opts?.maxResults })
    : await getIssues(creds, { jql: filter.jql, maxResults: opts?.maxResults });
  return { filter, issues };
}

/** Add a plain-text comment to an issue (used when a failure recurs on an existing defect). */
export async function addComment(creds: JiraCreds, issueKey: string, text: string): Promise<void> {
  const body = { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: String(text).slice(0, 4000) }] }] } };
  await postRequest<any>(creds, `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, body);
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

export interface JiraAttachmentMeta {
  /** Jira attachment id. */
  id: string;
  /** Original file name (e.g. api-tests.xlsx, swagger.json). */
  name: string;
  /** File size in bytes, when Jira reports it. */
  sizeBytes?: number;
  /** Upload date, when Jira reports it. */
  createdDate?: string;
}

/**
 * List the files attached to a Jira issue WITHOUT downloading them — metadata
 * only (name, size, id), read from the issue's `attachment` field. Read-only.
 */
export async function listIssueAttachments(creds: JiraCreds, key: string): Promise<JiraAttachmentMeta[]> {
  const url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}`;
  const data = await request<any>(creds, url, { fields: 'attachment' });
  const atts = Array.isArray(data?.fields?.attachment) ? data.fields.attachment : [];
  return atts
    .map((a: any): JiraAttachmentMeta => {
      const size = Number(a?.size);
      return {
        id: String(a?.id ?? ''),
        name: String(a?.filename || `attachment-${a?.id ?? ''}`),
        sizeBytes: Number.isFinite(size) && size >= 0 ? size : undefined,
        createdDate: a?.created || undefined,
      };
    })
    .filter((a: JiraAttachmentMeta) => a.id);
}

/** An attachment downloaded from a Jira issue — metadata plus its raw bytes. */
export interface JiraAttachmentFile {
  id: string;
  name: string;
  buffer: Buffer;
}

/**
 * Download the files attached to a Jira issue (optionally only the given
 * attachment ids). Reads the issue's attachment metadata, then fetches each
 * file's bytes from `/rest/api/3/attachment/content/{id}`. One unreadable
 * attachment is skipped, not fatal. `maxFiles` caps how many are pulled.
 */
export async function downloadIssueAttachments(
  creds: JiraCreds,
  key: string,
  opts: { ids?: string[]; maxFiles?: number } = {},
): Promise<JiraAttachmentFile[]> {
  const meta = await listIssueAttachments(creds, key);
  const wanted = opts.ids && opts.ids.length ? new Set(opts.ids.map(String)) : null;
  const picked = (wanted ? meta.filter((m) => wanted.has(m.id)) : meta).slice(0, opts.maxFiles ?? 20);
  const out: JiraAttachmentFile[] = [];
  for (const m of picked) {
    try {
      const dl = await axios.get(`${creds.baseUrl}/rest/api/3/attachment/content/${encodeURIComponent(m.id)}`, {
        headers: { Authorization: creds.authHeader },
        responseType: 'arraybuffer',
        maxRedirects: 5,
      });
      out.push({ id: m.id, name: m.name, buffer: Buffer.from(dl.data) });
    } catch { /* one unreadable attachment shouldn't fail the whole import */ }
  }
  return out;
}

export default {
  testConnection, getStories, getStory, getCredsForTenant, saveCredsForTenant,
  deleteCredsForTenant, getConnectionStatus, createBug, deleteIssue, getProjects,
  getIssues, addComment, listIssueAttachments, downloadIssueAttachments,
  getAllIssues, getIssueComments, getIssueChangelog, getBoards, getSprints,
  getSprintIssues, getBacklogIssues, getFilters, getFilter, runFilter,
};
