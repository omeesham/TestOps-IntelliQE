import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import { registerSSEConnection, broadcastSSE } from '../services/sse-manager.js';
import {
  getCredsForTenant as getAdoCreds,
  getConnectionStatus as getAdoStatus,
  createBug as createAdoBug,
  deleteWorkItem as deleteAdoWorkItem,
} from '../services/azure-devops.service.js';
import {
  getCredsForTenant as getJiraCreds,
  getConnectionStatus as getJiraStatus,
  createBug as createJiraBug,
  deleteIssue as deleteJiraIssue,
} from '../services/jira.service.js';
import { runPlaywrightForRun, PlaywrightRunError } from '../services/playwright-runner.service.js';
import { sendWebhookSdetTicket } from '../services/webhook-notification.service.js';

// JIRA error payloads carry the reason in errorMessages[] or errors{field: msg}.
function jiraErrorDetail(e: any, fallback: string): string {
  const data = e?.response?.data;
  return (
    data?.errorMessages?.[0] ||
    (data?.errors && Object.values(data.errors)[0] as string) ||
    e?.message ||
    fallback
  );
}

const router = Router();

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const STATUSES = ['open', 'in_progress', 'resolved', 'closed', 'revoked'];
// Bug origin/classification. 'failure' = a test that failed and stayed failing;
// 'flaky' = a test that failed then passed after auto-heal; 'manual' = filed by
// a person. Kept in sync with the bug_type column added in db.ts.
const BUG_TYPES = ['manual', 'failure', 'flaky'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Editable columns shared by create/update. tags is JSON (auto-parsed on read via db.ts JSON_COLUMNS).
const EDITABLE_FIELDS = [
  'title', 'description', 'severity', 'priority', 'status', 'environment',
  'module', 'steps_to_reproduce', 'expected_result', 'actual_result',
  'tags', 'test_run_id', 'test_case_id', 'assigned_to', 'resolution_notes',
] as const;

// T-SQL LIKE treats [ % _ as metacharacters (unlike Postgres); bracket-escape
// them so search filters match the text literally.
const escapeLike = (s: string) => s.replace(/[[%_]/g, (c) => `[${c}]`);

// Column bounds from the bugs DDL in db.ts — reject early with a 400 instead
// of letting SQL Server fail the insert with a truncation error.
const MAX_LENGTHS: Record<string, number> = {
  title: 400, environment: 100, module: 100, test_case_id: 100, assigned_to: 100,
};

function validateLengths(body: Record<string, any>): string | null {
  for (const [field, max] of Object.entries(MAX_LENGTHS)) {
    const value = body[field];
    if (typeof value === 'string' && value.trim().length > max) {
      return `${field} must be at most ${max} characters`;
    }
  }
  return null;
}

const bugChannel = (tenantId: string) => `bugs:${tenantId}`;

function emitBugEvent(tenantId: string, type: string, payload: Record<string, any>): void {
  // Bug events are not part of the pipeline SSEEvent union; the manager treats
  // events opaquely (JSON.stringify), so a cast is safe here.
  broadcastSSE(bugChannel(tenantId), {
    type,
    ...payload,
    timestamp: new Date().toISOString(),
  } as any);
}

async function logActivity(
  bugId: string,
  tenantId: string,
  action: string,
  details: Record<string, any> | null,
  performedBy: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO bug_activity (bug_id, tenant_id, action, details, performed_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [bugId, tenantId, action, details ? JSON.stringify(details) : null, performedBy],
  );
}

function validateEnums(body: Record<string, any>): string | null {
  if (body.severity !== undefined && !SEVERITIES.includes(body.severity)) {
    return `severity must be one of: ${SEVERITIES.join(', ')}`;
  }
  if (body.priority !== undefined && !PRIORITIES.includes(body.priority)) {
    return `priority must be one of: ${PRIORITIES.join(', ')}`;
  }
  if (body.status !== undefined && !STATUSES.includes(body.status)) {
    return `status must be one of: ${STATUSES.join(', ')}`;
  }
  if (body.test_run_id !== undefined && body.test_run_id !== null && body.test_run_id !== ''
      && !UUID_RE.test(String(body.test_run_id))) {
    return 'test_run_id must be a valid UUID';
  }
  if (body.tags !== undefined && body.tags !== null && !Array.isArray(body.tags)) {
    return 'tags must be an array of strings';
  }
  return null;
}

async function findBug(bugId: string, tenantId: string) {
  const result = await pool.query(
    `SELECT * FROM bugs WHERE id = $1 AND tenant_id = $2`,
    [bugId, tenantId],
  );
  return result.rows[0] || null;
}

// GET / — paginated list with filters
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(5, parseInt(req.query.limit as string) || 10));
    const offset = (page - 1) * limit;

    const params: any[] = [user.tenantId];
    let where = ` WHERE tenant_id = $1`;

    const search = (req.query.search as string || '').trim();
    if (search) {
      params.push(`%${escapeLike(search)}%`);
      where += ` AND (title LIKE $${params.length} OR description LIKE $${params.length}` +
               ` OR module LIKE $${params.length} OR test_case_id LIKE $${params.length}` +
               ` OR assigned_to LIKE $${params.length} OR reported_by LIKE $${params.length})`;
    }
    const status = req.query.status as string;
    if (status && STATUSES.includes(status)) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }
    const severity = req.query.severity as string;
    if (severity && SEVERITIES.includes(severity)) {
      params.push(severity);
      where += ` AND severity = $${params.length}`;
    }
    const priority = req.query.priority as string;
    if (priority && PRIORITIES.includes(priority)) {
      params.push(priority);
      where += ` AND priority = $${params.length}`;
    }
    const assignee = (req.query.assignee as string || '').trim();
    if (assignee) {
      params.push(`%${escapeLike(assignee)}%`);
      where += ` AND assigned_to LIKE $${params.length}`;
    }
    // Bug type filter (manual | failure | flaky). Accept either `type` or
    // `bug_type` so the query param name is forgiving.
    const bugType = (req.query.type as string) || (req.query.bug_type as string);
    if (bugType && BUG_TYPES.includes(bugType)) {
      params.push(bugType);
      where += ` AND bug_type = $${params.length}`;
    }

    const countRes = await pool.query(`SELECT COUNT(*) AS count FROM bugs${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const dataRes = await pool.query(
      `SELECT * FROM bugs${where}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );

    res.json({
      bugs: dataRes.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err: any) {
    console.error('List bugs error:', err.message);
    res.status(500).json({ error: 'Failed to list bugs' });
  }
});

// GET /stats — dashboard counts by status and severity
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const result = await pool.query(
      `SELECT status, severity, bug_type, COUNT(*) AS count FROM bugs
       WHERE tenant_id = $1 GROUP BY status, severity, bug_type`,
      [user.tenantId],
    );

    const byStatus: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let total = 0;
    for (const row of result.rows) {
      const count = parseInt(row.count);
      byStatus[row.status] = (byStatus[row.status] || 0) + count;
      bySeverity[row.severity] = (bySeverity[row.severity] || 0) + count;
      byType[row.bug_type || 'manual'] = (byType[row.bug_type || 'manual'] || 0) + count;
      total += count;
    }
    res.json({ total, byStatus, bySeverity, byType });
  } catch (err: any) {
    console.error('Bug stats error:', err.message);
    res.status(500).json({ error: 'Failed to load bug stats' });
  }
});

// GET /events — live SSE stream, channel derived server-side from the caller's tenant
router.get('/events', (req: Request, res: Response) => {
  const user = req.user!;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
  registerSSEConnection(bugChannel(user.tenantId), res);

  const keepalive = setInterval(() => {
    try { res.write(`: keepalive\n\n`); } catch { clearInterval(keepalive); }
  }, 30000);
  req.on('close', () => clearInterval(keepalive));
});

// GET /ado/status — is Azure DevOps connected for this tenant? (drives the
// "Raise in Azure DevOps" UI in the Bug Tracker)
router.get('/ado/status', async (req: Request, res: Response) => {
  try {
    const status = await getAdoStatus(req.user!.tenantId);
    res.json(status);
  } catch (err: any) {
    console.error('Bug ADO status error:', err.message);
    res.status(500).json({ error: 'Failed to check Azure DevOps status' });
  }
});

// POST /sdet-ticket — escalate the selected bug(s) to the JBS SDET team for
// automation-framework fixes. Sends one card to the tenant's connected Teams
// webhook (System Configuration) and logs the escalation on each bug.
// Body: { ids: string[] }.
router.post('/sdet-ticket', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: any) => UUID_RE.test(String(x))) : [];
    if (ids.length === 0) { res.status(400).json({ error: 'ids (array of bug UUIDs) is required' }); return; }

    const bugs: any[] = [];
    for (const id of ids) {
      const bug = await findBug(id, user.tenantId);
      if (bug) bugs.push(bug);
    }
    if (bugs.length === 0) { res.status(404).json({ error: 'No matching bugs found' }); return; }

    const sent = await sendWebhookSdetTicket(user.tenantId, {
      bugs: bugs.map((b) => ({
        bugNumber: b.bug_number,
        title: b.title,
        severity: b.severity,
        priority: b.priority,
        bugType: b.bug_type || undefined,
        module: b.module || null,
      })),
      raisedBy: user.displayName || user.username,
      tenantName: user.tenantName,
    });
    if (!sent.sent) {
      res.status(400).json({ error: sent.error || 'Could not send the Teams notification' });
      return;
    }

    for (const b of bugs) {
      await logActivity(b.id, user.tenantId, 'sdet_ticket_raised', { via: 'teams' }, user.displayName || user.username);
    }

    res.json({ ok: true, notified: bugs.length });
  } catch (err: any) {
    console.error('Bug SDET ticket error:', err.message);
    res.status(500).json({ error: 'Failed to raise the SDET ticket' });
  }
});

// POST /ado/push — raise the selected bug(s) in Azure DevOps as Bug work items.
// Body: { ids: string[] }. Returns a per-bug result so the UI can report
// exactly which succeeded / failed. Already-pushed bugs are skipped.
router.post('/ado/push', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: any) => UUID_RE.test(String(x))) : [];
    if (ids.length === 0) { res.status(400).json({ error: 'ids (array of bug UUIDs) is required' }); return; }

    const creds = await getAdoCreds(user.tenantId);
    if (!creds) {
      res.status(400).json({ error: 'Not connected to Azure DevOps. Connect it in System Configuration → Requirement Sources first.' });
      return;
    }

    const results: { id: string; ok: boolean; adoId?: number; adoUrl?: string; error?: string }[] = [];
    for (const id of ids) {
      const bug = await findBug(id, user.tenantId);
      if (!bug) { results.push({ id, ok: false, error: 'Bug not found' }); continue; }
      if (bug.ado_work_item_id) {
        results.push({ id, ok: true, adoId: bug.ado_work_item_id, adoUrl: bug.ado_url, error: 'Already raised' });
        continue;
      }
      try {
        const created = await createAdoBug(creds, {
          title: bug.title,
          description: bug.description || undefined,
          stepsToReproduce: bug.steps_to_reproduce || undefined,
          expectedResult: bug.expected_result || undefined,
          actualResult: bug.actual_result || undefined,
          environment: bug.environment || undefined,
          priority: bug.priority,
          severity: bug.severity,
          tags: Array.isArray(bug.tags) ? bug.tags : [],
        });
        const upd = await pool.query(
          `UPDATE bugs SET ado_work_item_id = $1, ado_url = $2, ado_pushed_at = now(), updated_at = now()
           WHERE id = $3 AND tenant_id = $4 RETURNING *`,
          [created.id, created.url, id, user.tenantId],
        );
        await logActivity(id, user.tenantId, 'ado_raised', { adoId: created.id, adoUrl: created.url }, user.displayName || user.username);
        emitBugEvent(user.tenantId, 'bug_updated', { bugId: id, bug: upd.rows[0] });
        results.push({ id, ok: true, adoId: created.id, adoUrl: created.url });
      } catch (e: any) {
        const detail = e?.response?.data?.message || e?.message || 'Failed to create Azure DevOps work item';
        console.error(`Bug ADO push error [${id}]:`, detail);
        results.push({ id, ok: false, error: detail });
      }
    }

    const raised = results.filter((r) => r.ok && r.error !== 'Already raised').length;
    res.json({ ok: true, raised, results, project: creds.project, org: creds.org });
  } catch (err: any) {
    console.error('Bug ADO push error:', err.message);
    res.status(500).json({ error: 'Failed to raise bugs in Azure DevOps' });
  }
});

// DELETE /:id/ado — delete just the Azure DevOps work item a bug was raised as
// (moves it to the ADO Recycle Bin) and clear the link locally. The IntelliQE
// bug itself stays and becomes raisable again. If someone already deleted the
// work item in ADO (404), the link is still cleared.
router.delete('/:id/ado', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const bugId = req.params.id as string;
    if (!UUID_RE.test(bugId)) { res.status(404).json({ error: 'Bug not found' }); return; }

    const existing = await findBug(bugId, user.tenantId);
    if (!existing) { res.status(404).json({ error: 'Bug not found' }); return; }
    if (!existing.ado_work_item_id) {
      res.status(400).json({ error: 'This bug has not been raised in Azure DevOps' });
      return;
    }

    const creds = await getAdoCreds(user.tenantId);
    if (!creds) {
      res.status(400).json({ error: 'Not connected to Azure DevOps. Connect it in System Configuration → Requirement Sources first.' });
      return;
    }

    const adoId = Number(existing.ado_work_item_id);
    let alreadyGone = false;
    try {
      await deleteAdoWorkItem(creds, adoId);
    } catch (e: any) {
      if (e?.response?.status === 404) {
        alreadyGone = true;
      } else {
        const detail = e?.response?.data?.message || e?.message || 'Failed to delete the Azure DevOps work item';
        console.error(`Bug ADO remove error [${bugId} → #${adoId}]:`, detail);
        res.status(502).json({ error: detail });
        return;
      }
    }

    const upd = await pool.query(
      `UPDATE bugs SET ado_work_item_id = NULL, ado_url = NULL, ado_pushed_at = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [bugId, user.tenantId],
    );
    await logActivity(
      bugId, user.tenantId, 'ado_removed',
      { adoId, ...(alreadyGone ? { note: 'work item was already deleted in Azure DevOps' } : {}) },
      user.displayName || user.username,
    );
    emitBugEvent(user.tenantId, 'bug_updated', { bugId, bug: upd.rows[0] });

    res.json({ ok: true, adoId, alreadyGone });
  } catch (err: any) {
    console.error('Bug ADO remove error:', err.message);
    res.status(500).json({ error: 'Failed to delete the Azure DevOps work item' });
  }
});

// GET /jira/status — is JIRA connected for this tenant? (drives the
// "Raise in JIRA" UI in the Bug Tracker)
router.get('/jira/status', async (req: Request, res: Response) => {
  try {
    const status = await getJiraStatus(req.user!.tenantId);
    if (!status.connected) { res.json(status); return; }
    // Bug creation needs a project to land in — surface the linked key so the
    // UI can show it (and warn when the connection has no project scope).
    const creds = await getJiraCreds(req.user!.tenantId);
    res.json({ ...status, projectKey: creds?.projectKey });
  } catch (err: any) {
    console.error('Bug JIRA status error:', err.message);
    res.status(500).json({ error: 'Failed to check JIRA status' });
  }
});

// POST /jira/push — raise the selected bug(s) in JIRA as Bug issues.
// Body: { ids: string[] }. Same per-bug result shape as /ado/push so the UI
// can report exactly which succeeded / failed. Already-pushed bugs are skipped.
router.post('/jira/push', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: any) => UUID_RE.test(String(x))) : [];
    if (ids.length === 0) { res.status(400).json({ error: 'ids (array of bug UUIDs) is required' }); return; }

    const creds = await getJiraCreds(user.tenantId);
    if (!creds) {
      res.status(400).json({ error: 'Not connected to JIRA. Connect it in System Configuration → Requirement Sources first.' });
      return;
    }

    const results: { id: string; ok: boolean; jiraKey?: string; jiraUrl?: string; error?: string }[] = [];
    for (const id of ids) {
      const bug = await findBug(id, user.tenantId);
      if (!bug) { results.push({ id, ok: false, error: 'Bug not found' }); continue; }
      if (bug.jira_issue_key) {
        results.push({ id, ok: true, jiraKey: bug.jira_issue_key, jiraUrl: bug.jira_url, error: 'Already raised' });
        continue;
      }
      try {
        const created = await createJiraBug(creds, {
          title: bug.title,
          description: bug.description || undefined,
          stepsToReproduce: bug.steps_to_reproduce || undefined,
          expectedResult: bug.expected_result || undefined,
          actualResult: bug.actual_result || undefined,
          environment: bug.environment || undefined,
          priority: bug.priority,
          severity: bug.severity,
          tags: Array.isArray(bug.tags) ? bug.tags : [],
        });
        const upd = await pool.query(
          `UPDATE bugs SET jira_issue_key = $1, jira_url = $2, jira_pushed_at = now(), updated_at = now()
           WHERE id = $3 AND tenant_id = $4 RETURNING *`,
          [created.key, created.url, id, user.tenantId],
        );
        await logActivity(id, user.tenantId, 'jira_raised', { jiraKey: created.key, jiraUrl: created.url }, user.displayName || user.username);
        emitBugEvent(user.tenantId, 'bug_updated', { bugId: id, bug: upd.rows[0] });
        results.push({ id, ok: true, jiraKey: created.key, jiraUrl: created.url });
      } catch (e: any) {
        const detail = jiraErrorDetail(e, 'Failed to create the JIRA issue');
        console.error(`Bug JIRA push error [${id}]:`, detail);
        results.push({ id, ok: false, error: detail });
      }
    }

    const raised = results.filter((r) => r.ok && r.error !== 'Already raised').length;
    res.json({ ok: true, raised, results, projectKey: creds.projectKey });
  } catch (err: any) {
    console.error('Bug JIRA push error:', err.message);
    res.status(500).json({ error: 'Failed to raise bugs in JIRA' });
  }
});

// DELETE /:id/jira — delete just the JIRA issue a bug was raised as and clear
// the link locally. The IntelliQE bug itself stays and becomes raisable again.
// If someone already deleted the issue in JIRA (404), the link is still cleared.
router.delete('/:id/jira', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const bugId = req.params.id as string;
    if (!UUID_RE.test(bugId)) { res.status(404).json({ error: 'Bug not found' }); return; }

    const existing = await findBug(bugId, user.tenantId);
    if (!existing) { res.status(404).json({ error: 'Bug not found' }); return; }
    if (!existing.jira_issue_key) {
      res.status(400).json({ error: 'This bug has not been raised in JIRA' });
      return;
    }

    const creds = await getJiraCreds(user.tenantId);
    if (!creds) {
      res.status(400).json({ error: 'Not connected to JIRA. Connect it in System Configuration → Requirement Sources first.' });
      return;
    }

    const jiraKey = String(existing.jira_issue_key);
    let alreadyGone = false;
    try {
      await deleteJiraIssue(creds, jiraKey);
    } catch (e: any) {
      if (e?.response?.status === 404) {
        alreadyGone = true;
      } else {
        const detail = jiraErrorDetail(e, 'Failed to delete the JIRA issue');
        console.error(`Bug JIRA remove error [${bugId} → ${jiraKey}]:`, detail);
        res.status(502).json({ error: detail });
        return;
      }
    }

    const upd = await pool.query(
      `UPDATE bugs SET jira_issue_key = NULL, jira_url = NULL, jira_pushed_at = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [bugId, user.tenantId],
    );
    await logActivity(
      bugId, user.tenantId, 'jira_removed',
      { jiraKey, ...(alreadyGone ? { note: 'issue was already deleted in JIRA' } : {}) },
      user.displayName || user.username,
    );
    emitBugEvent(user.tenantId, 'bug_updated', { bugId, bug: upd.rows[0] });

    res.json({ ok: true, jiraKey, alreadyGone });
  } catch (err: any) {
    console.error('Bug JIRA remove error:', err.message);
    res.status(500).json({ error: 'Failed to delete the JIRA issue' });
  }
});

// GET /:id — full bug detail + activity timeline
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const bugId = req.params.id as string;
    if (!UUID_RE.test(bugId)) { res.status(404).json({ error: 'Bug not found' }); return; }

    const bug = await findBug(bugId, user.tenantId);
    if (!bug) { res.status(404).json({ error: 'Bug not found' }); return; }

    const activityRes = await pool.query(
      `SELECT * FROM bug_activity WHERE bug_id = $1 ORDER BY created_at DESC`,
      [bugId],
    );
    res.json({ bug, activity: activityRes.rows });
  } catch (err: any) {
    console.error('Get bug error:', err.message);
    res.status(500).json({ error: 'Failed to load bug' });
  }
});

// POST / — report a new bug
router.post('/', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const body = req.body || {};

    const title = String(body.title || '').trim();
    if (!title) { res.status(400).json({ error: 'title is required' }); return; }
    const enumError = validateEnums(body);
    if (enumError) { res.status(400).json({ error: enumError }); return; }
    const lengthError = validateLengths(body);
    if (lengthError) { res.status(400).json({ error: lengthError }); return; }

    const tags = Array.isArray(body.tags)
      ? body.tags.map((t: any) => String(t).trim()).filter(Boolean)
      : [];

    const result = await pool.query(
      `INSERT INTO bugs (
         tenant_id, title, description, severity, priority, status,
         environment, module, steps_to_reproduce, expected_result, actual_result,
         tags, test_run_id, test_case_id, reported_by, assigned_to, bug_type
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      [
        user.tenantId,
        title,
        body.description || null,
        body.severity || 'medium',
        body.priority || 'P2',
        body.status && STATUSES.includes(body.status) ? body.status : 'open',
        body.environment || null,
        body.module || null,
        body.steps_to_reproduce || null,
        body.expected_result || null,
        body.actual_result || null,
        JSON.stringify(tags),
        body.test_run_id || null,
        body.test_case_id || null,
        user.displayName || user.username,
        body.assigned_to || null,
        body.bug_type && BUG_TYPES.includes(body.bug_type) ? body.bug_type : 'manual',
      ],
    );
    const bug = result.rows[0];

    await logActivity(bug.id, user.tenantId, 'created', null, user.displayName || user.username);
    emitBugEvent(user.tenantId, 'bug_created', { bugId: bug.id, bug });

    res.json({ ok: true, bug });
  } catch (err: any) {
    console.error('Create bug error:', err.message);
    res.status(500).json({ error: 'Failed to create bug' });
  }
});

// POST /from-run — auto-register bugs from a completed execution run.
// Body: { testRunId?, appName?, environment?, module?, items: [
//   { testCaseId, testName, bugType: 'failure'|'flaky', error?, fix?, severity? }
// ] }
// Upserts by (tenant_id, test_run_id, test_case_id): a test that reappears in a
// later cycle (e.g. failure → healed-flaky) updates its existing bug instead of
// creating a duplicate. Only 'failure' and 'flaky' are accepted here — manual
// bugs go through POST /.
router.post('/from-run', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const body = req.body || {};
    const testRunId = body.testRunId && UUID_RE.test(String(body.testRunId)) ? String(body.testRunId) : null;
    const environment = body.environment ? String(body.environment).slice(0, 100) : null;
    const defaultModule = body.module ? String(body.module).slice(0, 100) : null;

    const rawItems = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
    if (rawItems.length === 0) { res.json({ ok: true, created: 0, updated: 0, skipped: 0, bugs: [] }); return; }

    let created = 0, updated = 0, skipped = 0;
    const bugs: any[] = [];
    const actor = user.displayName || user.username;

    for (const item of rawItems) {
      const testCaseId = String(item?.testCaseId || '').trim().slice(0, 100);
      const bugType = item?.bugType === 'flaky' ? 'flaky' : item?.bugType === 'failure' ? 'failure' : null;
      if (!testCaseId || !bugType) { skipped++; continue; }

      const testName = String(item?.testName || testCaseId).trim();
      const errorText = item?.error ? String(item.error).slice(0, 8000) : '';
      const fixText = item?.fix ? String(item.fix).slice(0, 4000) : '';
      const severity = SEVERITIES.includes(item?.severity)
        ? item.severity
        : (bugType === 'failure' ? 'high' : 'medium');
      const title = (bugType === 'flaky'
        ? `Flaky test (auto-healed): ${testName}`
        : `Test failed: ${testName}`).slice(0, 400);
      const description = bugType === 'flaky'
        ? `This test failed on execution but passed after auto-healing, so it is flaky.${fixText ? `\n\nApplied fix:\n${fixText}` : ''}${errorText ? `\n\nOriginal error:\n${errorText}` : ''}`
        : `This test failed during automated execution.${errorText ? `\n\nError:\n${errorText}` : ''}`;
      const tags = ['auto', bugType, ...(bugType === 'flaky' ? ['auto-healed'] : [])];

      // Upsert only when we can key on a run — without a test_run_id there's no
      // safe dedup key, so we always insert.
      let existing: any = null;
      if (testRunId) {
        const found = await pool.query(
          `SELECT * FROM bugs WHERE tenant_id = $1 AND test_run_id = $2 AND test_case_id = $3
             AND bug_type IN ('failure','flaky') ORDER BY created_at DESC`,
          [user.tenantId, testRunId, testCaseId],
        );
        existing = found.rows[0] || null;
      }

      if (existing) {
        // Refresh classification + latest error, and reopen if it had been
        // resolved/closed but is failing again. Never touch a revoked bug.
        if (existing.status === 'revoked') { skipped++; continue; }
        const reopen = bugType === 'failure' && ['resolved', 'closed'].includes(existing.status);
        const upd = await pool.query(
          `UPDATE bugs SET bug_type = $1, severity = $2, title = $3, description = $4,
             actual_result = $5, tags = $6${reopen ? ", status = 'open'" : ''}, updated_at = now()
           WHERE id = $7 AND tenant_id = $8 RETURNING *`,
          [bugType, severity, title, description, errorText || null, JSON.stringify(tags), existing.id, user.tenantId],
        );
        const bug = upd.rows[0];
        await logActivity(existing.id, user.tenantId, 'auto_updated', { bugType, reopened: reopen }, actor);
        emitBugEvent(user.tenantId, 'bug_updated', { bugId: existing.id, bug });
        bugs.push(bug); updated++;
      } else {
        const ins = await pool.query(
          `INSERT INTO bugs (
             tenant_id, title, description, severity, priority, status,
             environment, module, actual_result, tags, test_run_id, test_case_id,
             reported_by, bug_type
           ) VALUES ($1,$2,$3,$4,'P2','open',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [
            user.tenantId, title, description, severity,
            environment, defaultModule, errorText || null,
            JSON.stringify(tags), testRunId, testCaseId, actor, bugType,
          ],
        );
        const bug = ins.rows[0];
        await logActivity(bug.id, user.tenantId, 'auto_created', { bugType }, actor);
        emitBugEvent(user.tenantId, 'bug_created', { bugId: bug.id, bug });
        bugs.push(bug); created++;
      }
    }

    res.json({ ok: true, created, updated, skipped, bugs });
  } catch (err: any) {
    console.error('Register bugs from run error:', err.message);
    res.status(500).json({ error: 'Failed to register bugs from run' });
  }
});

// POST /rerun — re-execute the tests behind the selected/flaky/failure bugs.
// Body: { bugType?: 'flaky'|'failure', ids?: string[] }. Groups the target bugs
// by their linked test_run_id and re-runs just those test cases via Playwright,
// then resolves any bug whose test now passes and refreshes the error on the
// rest. Synchronous — the caller shows a spinner while tests run.
router.post('/rerun', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const body = req.body || {};
    const bugType = BUG_TYPES.includes(body.bugType) && body.bugType !== 'manual' ? body.bugType : null;
    const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((x: any) => UUID_RE.test(String(x))) : [];
    if (!bugType && ids.length === 0) {
      res.status(400).json({ error: 'Provide bugType ("flaky" | "failure") or ids to re-run.' });
      return;
    }

    // Select the target bugs: linked to a run, still active (open/in_progress).
    const params: any[] = [user.tenantId];
    let where = `WHERE tenant_id = $1 AND test_run_id IS NOT NULL AND test_case_id IS NOT NULL
                 AND status IN ('open','in_progress')`;
    if (ids.length > 0) {
      const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
      where += ` AND id IN (${placeholders})`;
      params.push(...ids);
    } else if (bugType) {
      params.push(bugType);
      where += ` AND bug_type = $${params.length}`;
    }
    const targetRes = await pool.query(`SELECT * FROM bugs ${where}`, params);
    const targets: any[] = targetRes.rows;
    if (targets.length === 0) {
      res.json({ ok: true, ran: 0, passed: 0, failed: 0, resolved: 0, byRun: [], message: 'No re-runnable tests found for the selection.' });
      return;
    }

    // Group by run, collect the distinct test case ids to execute.
    const byRunId = new Map<string, { bugs: any[]; testCaseIds: Set<string> }>();
    for (const b of targets) {
      const g = byRunId.get(b.test_run_id) || { bugs: [], testCaseIds: new Set<string>() };
      g.bugs.push(b);
      g.testCaseIds.add(String(b.test_case_id));
      byRunId.set(b.test_run_id, g);
    }

    let ran = 0, passed = 0, failed = 0, resolved = 0;
    const byRun: { testRunId: string; ran: number; passed: number; failed: number; error?: string }[] = [];
    const actor = user.displayName || user.username;

    for (const [runId, group] of byRunId) {
      const wantIds = [...group.testCaseIds];
      try {
        const { results } = await runPlaywrightForRun(user.tenantId, user.isPlatform, runId, wantIds);
        const resultByTc = new Map(results.map((r) => [r.testCaseId, r]));
        let rp = 0, rf = 0;
        for (const bug of group.bugs) {
          const r = resultByTc.get(String(bug.test_case_id));
          if (!r) continue; // no result for this test (didn't run) — leave untouched
          ran++;
          if (r.passed) {
            passed++; rp++; resolved++;
            const upd = await pool.query(
              `UPDATE bugs SET status = 'resolved', resolution_notes = $1, updated_at = now()
               WHERE id = $2 AND tenant_id = $3 RETURNING *`,
              [`Passed on re-run at ${new Date().toISOString()}.`, bug.id, user.tenantId],
            );
            await logActivity(bug.id, user.tenantId, 'rerun_passed', null, actor);
            emitBugEvent(user.tenantId, 'bug_updated', { bugId: bug.id, bug: upd.rows[0] });
          } else {
            failed++; rf++;
            const upd = await pool.query(
              `UPDATE bugs SET actual_result = $1, updated_at = now()
               WHERE id = $2 AND tenant_id = $3 RETURNING *`,
              [(r.errorMessage || 'Still failing on re-run').slice(0, 8000), bug.id, user.tenantId],
            );
            await logActivity(bug.id, user.tenantId, 'rerun_failed', null, actor);
            emitBugEvent(user.tenantId, 'bug_updated', { bugId: bug.id, bug: upd.rows[0] });
          }
        }
        byRun.push({ testRunId: runId, ran: rp + rf, passed: rp, failed: rf });
      } catch (e: any) {
        const msg = e instanceof PlaywrightRunError ? `${e.code}: ${e.message}` : (e?.message || 'Re-run failed');
        console.error(`Bug re-run error [run ${runId}]:`, msg);
        byRun.push({ testRunId: runId, ran: 0, passed: 0, failed: 0, error: msg });
      }
    }

    res.json({ ok: true, ran, passed, failed, resolved, byRun });
  } catch (err: any) {
    console.error('Bug re-run error:', err.message);
    res.status(500).json({ error: 'Failed to re-run tests' });
  }
});

// PUT /:id — edit fields (also used to reopen / change status)
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const bugId = req.params.id as string;
    if (!UUID_RE.test(bugId)) { res.status(404).json({ error: 'Bug not found' }); return; }

    const existing = await findBug(bugId, user.tenantId);
    if (!existing) { res.status(404).json({ error: 'Bug not found' }); return; }

    const body = req.body || {};
    const enumError = validateEnums(body);
    if (enumError) { res.status(400).json({ error: enumError }); return; }
    const lengthError = validateLengths(body);
    if (lengthError) { res.status(400).json({ error: lengthError }); return; }
    if (body.title !== undefined && !String(body.title).trim()) {
      res.status(400).json({ error: 'title cannot be empty' }); return;
    }

    // Optimistic concurrency: the editor sends the updated_at it loaded; if the
    // bug changed underneath it, reject rather than silently overwrite.
    if (body.expected_updated_at && existing.updated_at !== body.expected_updated_at) {
      res.status(409).json({ error: 'This bug was modified by someone else. Close and reopen the editor to get the latest version.' });
      return;
    }

    const sets: string[] = [];
    const params: any[] = [];
    const changes: Record<string, { from: any; to: any }> = {};

    for (const field of EDITABLE_FIELDS) {
      if (body[field] === undefined) continue;
      let value = body[field];
      if (field === 'title') value = String(value).trim();
      if (field === 'tags') {
        value = JSON.stringify(
          (value || []).map((t: any) => String(t).trim()).filter(Boolean),
        );
      }
      if (value === '') value = null;

      const before = field === 'tags' ? JSON.stringify(existing.tags || []) : existing[field];
      if (before !== value) changes[field] = { from: existing[field], to: body[field] };

      params.push(value);
      sets.push(`${field} = $${params.length}`);
    }

    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

    // Clear the revoke reason when a revoked bug is moved back to an active status
    if (body.status && body.status !== 'revoked' && existing.status === 'revoked') {
      sets.push(`revoke_reason = NULL`);
    }

    params.push(bugId, user.tenantId);
    const result = await pool.query(
      `UPDATE bugs SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
       RETURNING *`,
      params,
    );
    const bug = result.rows[0];

    if (Object.keys(changes).length > 0) {
      const action = changes.status ? 'status_changed' : 'updated';
      await logActivity(bugId, user.tenantId, action, { changes }, user.displayName || user.username);
    }
    emitBugEvent(user.tenantId, 'bug_updated', { bugId, bug });

    res.json({ ok: true, bug });
  } catch (err: any) {
    console.error('Update bug error:', err.message);
    res.status(500).json({ error: 'Failed to update bug' });
  }
});

// POST /:id/revoke — withdraw a bug (kept in history, excluded from active work)
router.post('/:id/revoke', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const bugId = req.params.id as string;
    if (!UUID_RE.test(bugId)) { res.status(404).json({ error: 'Bug not found' }); return; }

    const existing = await findBug(bugId, user.tenantId);
    if (!existing) { res.status(404).json({ error: 'Bug not found' }); return; }
    if (existing.status === 'revoked') {
      res.status(400).json({ error: 'Bug is already revoked' }); return;
    }

    const reason = String(req.body?.reason || '').trim().slice(0, 500) || null;
    const result = await pool.query(
      `UPDATE bugs SET status = 'revoked', revoke_reason = $1, updated_at = now()
       WHERE id = $2 AND tenant_id = $3
       RETURNING *`,
      [reason, bugId, user.tenantId],
    );
    const bug = result.rows[0];

    await logActivity(bugId, user.tenantId, 'revoked', reason ? { reason } : null,
      user.displayName || user.username);
    emitBugEvent(user.tenantId, 'bug_updated', { bugId, bug });

    res.json({ ok: true, bug });
  } catch (err: any) {
    console.error('Revoke bug error:', err.message);
    res.status(500).json({ error: 'Failed to revoke bug' });
  }
});

// DELETE /:id — permanently remove a bug (activity rows cascade)
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const bugId = req.params.id as string;
    if (!UUID_RE.test(bugId)) { res.status(404).json({ error: 'Bug not found' }); return; }

    const existing = await findBug(bugId, user.tenantId);
    if (!existing) { res.status(404).json({ error: 'Bug not found' }); return; }

    // Cascade the delete to Azure DevOps when the bug was raised there — move the
    // linked work item to the ADO Recycle Bin. Best-effort: a failure here (perms,
    // already deleted, disconnected) must NOT block removing the local bug; we
    // report it back so the UI can warn.
    let adoDeleted = false;
    let adoError: string | undefined;
    if (existing.ado_work_item_id) {
      try {
        const creds = await getAdoCreds(user.tenantId);
        if (!creds) {
          adoError = 'Azure DevOps is not connected — the local bug was deleted but its work item remains.';
        } else {
          await deleteAdoWorkItem(creds, Number(existing.ado_work_item_id));
          adoDeleted = true;
        }
      } catch (e: any) {
        adoError = e?.response?.data?.message || e?.message || 'Failed to delete the Azure DevOps work item.';
        console.error(`Bug ADO delete error [${bugId} → #${existing.ado_work_item_id}]:`, adoError);
      }
    }

    // Same best-effort cascade for JIRA: delete the linked issue when the bug
    // was raised there, but never block the local delete on it.
    let jiraDeleted = false;
    let jiraError: string | undefined;
    if (existing.jira_issue_key) {
      try {
        const jiraCreds = await getJiraCreds(user.tenantId);
        if (!jiraCreds) {
          jiraError = 'JIRA is not connected — the local bug was deleted but its JIRA issue remains.';
        } else {
          await deleteJiraIssue(jiraCreds, String(existing.jira_issue_key));
          jiraDeleted = true;
        }
      } catch (e: any) {
        if (e?.response?.status === 404) {
          jiraDeleted = true; // already gone in JIRA — nothing left to remove
        } else {
          jiraError = jiraErrorDetail(e, 'Failed to delete the JIRA issue.');
          console.error(`Bug JIRA delete error [${bugId} → ${existing.jira_issue_key}]:`, jiraError);
        }
      }
    }

    await pool.query(`DELETE FROM bugs WHERE id = $1 AND tenant_id = $2`, [bugId, user.tenantId]);
    emitBugEvent(user.tenantId, 'bug_deleted', { bugId });

    res.json({
      ok: true,
      adoDeleted, adoError, adoId: existing.ado_work_item_id || undefined,
      jiraDeleted, jiraError, jiraKey: existing.jira_issue_key || undefined,
    });
  } catch (err: any) {
    console.error('Delete bug error:', err.message);
    res.status(500).json({ error: 'Failed to delete bug' });
  }
});

export default router;
