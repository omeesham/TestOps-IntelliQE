import axios from 'axios';
import pool from '../db.js';
import { decryptConfigData } from '../utils/crypto.js';

// --- Types ---
export type JiraCreds = { baseUrl: string; authHeader: string; projectKey?: string };
type StorySummary = { key: string; summary: string };
type StoryDetails = {
  key: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
};

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
    return { baseUrl: cfg.jira_url, authHeader: cfg.auth_header, projectKey: cfg.project_key || undefined };
  }
  // Legacy fallback
  const legacy = await pool.query(
    `SELECT jira_url, auth_header FROM jira_connections WHERE tenant_id = $1`,
    [tenantId]
  );
  if (legacy.rows.length === 0) return null;
  return { baseUrl: legacy.rows[0].jira_url, authHeader: legacy.rows[0].auth_header };
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
    [tenantId, JSON.stringify({ jira_url: jiraUrl, auth_header: authHeader, display_name: displayName, project_key: projectKey || null }), username]
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

// --- Issue type discovery ---
async function getIssueTypeNames(creds: JiraCreds): Promise<string[]> {
  try {
    const url = `${creds.baseUrl}/rest/api/3/issuetype`;
    const raw = await request<any>(creds, url);
    // Cloud returns a plain array; some Server/DC versions return { values: [...] }
    // or { issueTypes: [...] }. Normalise to an array before mapping.
    const all: any[] = Array.isArray(raw)
      ? raw
      : (raw?.values ?? raw?.issueTypes ?? []);
    const names = all.map((t) => String(t?.name || '').trim()).filter(Boolean);
    const matched = Array.from(new Set(names.filter((n) => /story/i.test(n) || /^task$/i.test(n))));
    return matched.length ? matched : ['Story', 'Task'];
  } catch {
    // If the issuetype endpoint is unavailable, fall back to the most common names.
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
  // A wrong base URL (e.g. a board URL) makes Atlassian return its SPA HTML with
  // a 200 status, so `me` parses to something without an accountId. Reject that
  // explicitly instead of saving a connection that can never fetch issues.
  if (!me || typeof me !== 'object' || !me.accountId) {
    throw new Error('JIRA did not return a valid account — check the site URL (use https://your-domain.atlassian.net, not a board/project URL)');
  }
  return { accountId: me.accountId, displayName: me.displayName, locale: me.locale };
}

/** Run a JQL search, trying Cloud and Server endpoints in order. */
async function jqlSearch(creds: JiraCreds, jql: string, maxResults = 100): Promise<any[]> {
  const params = { jql, maxResults, fields: 'summary,issuetype,status' };
  const endpoints = [
    `${creds.baseUrl}/rest/api/3/search`,       // works on both Cloud and Server
    `${creds.baseUrl}/rest/api/3/search/jql`,   // newer Cloud alias
  ];
  let lastErr: unknown;
  for (const url of endpoints) {
    try {
      const data = await request<any>(creds, url, params);
      const issues = Array.isArray(data?.issues) ? data.issues : [];
      console.log(`[JIRA] jqlSearch OK — url=${url} jql="${jql}" issues=${issues.length} total=${data?.total}`);
      return issues;
    } catch (err: any) {
      console.warn(`[JIRA] jqlSearch FAIL — url=${url} jql="${jql}" status=${err?.response?.status} msg=${err?.response?.data?.errorMessages?.[0] || err?.message}`);
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function getStories(creds: JiraCreds): Promise<StorySummary[]> {
  const issueTypeNames = await getIssueTypeNames(creds);
  const quoted = issueTypeNames.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(', ');
  const pKey = creds.projectKey ? creds.projectKey.replace(/"/g, '\\"') : '';

  console.log(`[JIRA] getStories — baseUrl=${creds.baseUrl} projectKey=${pKey || '(none)'} issueTypes=${quoted}`);

  // Escalating JQL strategies — stop at the first one that returns results.
  // Use absolute date floors (not bare ORDER BY) to avoid "unbounded query"
  // rejections on Atlassian Cloud's /search endpoint.
  const jqlCandidates = [
    // 1. Project + known story/task types (ideal)
    pKey ? `project = "${pKey}" AND issuetype in (${quoted}) ORDER BY created DESC` : null,
    // 2. Project, all issue types (catches boards using Bug/Epic/Feature/etc.)
    pKey ? `project = "${pKey}" ORDER BY created DESC` : null,
    // 3. Site-wide story/task types — project key wrong or missing
    `issuetype in (${quoted}) AND created >= "2000-01-01" ORDER BY created DESC`,
    // 4. Site-wide, all issues since 2000 — absolute last resort
    `created >= "2000-01-01" ORDER BY created DESC`,
  ].filter(Boolean) as string[];

  for (const jql of jqlCandidates) {
    try {
      const issues = await jqlSearch(creds, jql);
      if (issues.length > 0) {
        return issues.map((i: any) => ({ key: i.key, summary: i.fields?.summary ?? '' }));
      }
      console.log(`[JIRA] JQL returned 0 issues, trying next candidate`);
    } catch (err: any) {
      console.warn(`[JIRA] JQL candidate failed: ${err?.message}`);
      // continue to next candidate
    }
  }

  return []; // genuinely no issues found
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

export default { testConnection, getStories, getStory, getCredsForTenant, saveCredsForTenant, deleteCredsForTenant, getConnectionStatus };
