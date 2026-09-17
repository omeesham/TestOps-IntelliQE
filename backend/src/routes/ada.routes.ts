/**
 * ADA Compliance / website audit API.
 *
 *   POST   /api/ada/scans              start a scan  → { scanId }
 *   GET    /api/ada/scans              list this tenant's scans
 *   GET    /api/ada/scans/:id?after=N  scan record + live progress events after cursor N
 *   GET    /api/ada/scans/:id/findings filterable findings (category, severity, page, q)
 *   GET    /api/ada/scans/:id/pages    pages crawled with per-page scores
 *   POST   /api/ada/scans/:id/cancel   stop a running scan (partial results are kept)
 *   DELETE /api/ada/scans/:id          delete a scan and everything under it
 *   GET    /api/ada/trend?url=         finished audits of one site, oldest first, for run-over-run comparison
 *   GET    /api/ada/schedules          recurring audits for this tenant
 *   POST   /api/ada/schedules          create one  { url, frequency, runHourUtc, runWeekday?, maxPages?, checkExternalLinks?, username?, password? }
 *   PATCH  /api/ada/schedules/:id      change cadence / options / enabled
 *   DELETE /api/ada/schedules/:id
 *   POST   /api/ada/schedules/:id/run  start that schedule's audit now
 *   GET    /api/ada/devices            device profiles available for UX checks
 *   GET    /api/ada/standards          uploaded design standards
 *   POST   /api/ada/standards          upload one  { name, content }  (tokens JSON or CSS variables, as text)
 *   DELETE /api/ada/standards/:id
 *   GET    /api/ada/scans/:id/evidence/:file   cropped screenshot for a UX finding
 *   GET    /api/ada/health?url=        latest finished audit of a site + pass/fail gate — answers instantly
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import path from 'path';
import { existsSync } from 'fs';
import {
  startScan, getProgress, cancelScan, tenantHasRunningScan, DEFAULT_OPTIONS, evidenceDirFor, removeEvidence,
} from '../services/ada/ada-scan.service.js';
import { DEVICE_PROFILES, RECOMMENDED_DEVICE_IDS, PRIMARY_DEVICE_ID } from '../services/ada/ada-devices.js';
import { listStandards, loadStandard, createStandard, deleteStandard } from '../services/ada/ada-standard.service.js';
import { normaliseStartUrl } from '../services/ada/ada-engine.js';
import { normaliseLegacySummary } from '../services/ada/ada-score.js';
import { listSchedules, createSchedule, updateSchedule, deleteSchedule, runScheduleNow } from '../services/ada/ada-schedule.service.js';
import { remediate } from '../services/ada/ada-remediation.js';
import type { ScanOptions } from '../services/ada/ada-types.js';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = ['accessibility', 'links', 'best-practice', 'review', 'visual'];
const SEVERITIES = ['critical', 'serious', 'moderate', 'minor'];
const escapeLike = (s: string) => s.replace(/[[%_]/g, (c) => `[${c}]`);

/**
 * The server fetches whatever URL the user types. Refuse anything that points
 * inside the network the server sits on — an audit tool must not double as an
 * internal port scanner. Override with ADA_ALLOW_PRIVATE_TARGETS=true for
 * genuinely internal customer apps on a trusted deployment.
 */
function isPrivateTarget(url: URL): boolean {
  if (process.env.ADA_ALLOW_PRIVATE_TARGETS === 'true') return false;
  const h = url.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.|^::1$|^fc|^fd|^fe80/.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

router.post('/scans', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
    if (!rawUrl) { res.status(400).json({ error: 'url is required' }); return; }
    let url: URL;
    try { url = new URL(normaliseStartUrl(rawUrl)); } catch { res.status(400).json({ error: 'That does not look like a valid website address' }); return; }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) {
      res.status(400).json({ error: 'Enter a public website address, e.g. https://www.example.com' }); return;
    }
    if (isPrivateTarget(url)) { res.status(400).json({ error: 'Internal or private network addresses cannot be audited' }); return; }

    const tenantId = req.user!.tenantId;
    const running = tenantHasRunningScan(tenantId);
    if (running) { res.status(409).json({ error: 'An audit is already running for your account', scanId: running }); return; }

    const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
      const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
    };
    const options: ScanOptions = {
      url: url.toString(),
      username: typeof body.username === 'string' && body.username.trim() ? body.username.trim() : undefined,
      password: typeof body.password === 'string' && body.password ? body.password : undefined,
      maxPages: clamp(body.maxPages, 5, 500, DEFAULT_OPTIONS.maxPages),
      maxDepth: clamp(body.maxDepth, 1, 12, DEFAULT_OPTIONS.maxDepth),
      useSitemap: body.useSitemap !== false,
      checkExternalLinks: body.checkExternalLinks !== false,
      crawlDelayMs: clamp(body.crawlDelayMs, 0, 5000, DEFAULT_OPTIONS.crawlDelayMs),
      uxEnabled: body.ux !== false,
      devices: Array.isArray(body.devices) && body.devices.length ? body.devices.map(String).slice(0, 8) : DEFAULT_OPTIONS.devices,
      uxPagesPerDevice: clamp(body.uxPagesPerDevice, 1, 100, DEFAULT_OPTIONS.uxPagesPerDevice),
      designStandard: null,
    };
    if (options.uxEnabled && typeof body.designStandardId === 'string' && UUID_RE.test(body.designStandardId)) {
      const std = await loadStandard(tenantId, body.designStandardId);
      if (!std) { res.status(400).json({ error: 'That design standard no longer exists' }); return; }
      options.designStandard = { id: std.id, name: std.name, standard: std.standard };
    }
    const scanId = await startScan(tenantId, req.user!.username, options);
    res.status(202).json({ scanId, url: options.url });
  } catch (err: any) {
    console.error('[ada] start scan failed:', err.message);
    res.status(500).json({ error: err.message || 'Failed to start audit' });
  }
});

router.get('/scans', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, target_url, site_name, status, overall_score, pages_crawled, links_checked, findings_count,
              created_by, started_at, finished_at, created_at, error
         FROM ada_scans WHERE tenant_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [req.user!.tenantId],
    );
    res.json({ scans: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list audits' });
  }
});

/**
 * Trend of one site: every finished audit of the same normalised URL, oldest
 * first, reduced to the numbers a run-over-run comparison needs. The report
 * uses it to show "vs previous audit" deltas.
 */
router.get('/trend', async (req: Request, res: Response) => {
  try {
    const raw = String(req.query.url || '').trim();
    if (!raw) { res.status(400).json({ error: 'url is required' }); return; }
    let url: string;
    try { url = normaliseStartUrl(raw); } catch { res.status(400).json({ error: 'Invalid url' }); return; }
    const limit = Math.min(50, Math.max(2, Number(req.query.limit) || 12));
    const { rows } = await pool.query(
      `SELECT id, status, overall_score, pages_crawled, links_checked, findings_count, result, finished_at, created_by
         FROM ada_scans
        WHERE tenant_id = $1 AND target_url = $2 AND status IN ('completed', 'cancelled') AND finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT ${limit}`,
      [req.user!.tenantId, url],
    );
    const points = rows.reverse().map((r: any) => {
      let result: any = r.result;
      if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = null; } }
      result = normaliseLegacySummary(result);
      const cats = result?.categories || {};
      // UX findings are tracked on their own so that turning UX testing on does
      // not look like a thousand new accessibility issues in the trend.
      const uxCount = cats.ux ? (cats.ux.issues || 0) + (cats.ux.needsReview || 0) : 0;
      return {
        id: r.id,
        status: r.status,
        finishedAt: r.finished_at,
        createdBy: r.created_by,
        score: r.overall_score,
        pagesAudited: r.pages_crawled,
        pagesFound: result?.pagesDiscovered ?? r.pages_crawled,
        linksChecked: r.links_checked,
        issues: Math.max(0, r.findings_count - uxCount),
        uxScore: cats.ux?.score ?? null,
        uxIssues: cats.ux ? cats.ux.issues : null,
        violations: cats.accessibility?.violations ?? null,
        needsReview: cats.accessibility?.needsReview ?? null,
        brokenLinks: cats.links ? (cats.links.broken + cats.links.serverErrors + cats.links.timeouts) : null,
        bestPracticeFailing: cats.bestPractice?.failingRules?.length ?? null,
        accessibilityScore: cats.accessibility?.score ?? null,
        linksScore: cats.links?.score ?? null,
        bestPracticeScore: cats.bestPractice?.score ?? null,
      };
    });
    res.json({ url, points });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to load trend' });
  }
});

/* ───────────────────────────── UX: devices, design standards, evidence ───────────────────────────── */

router.get('/devices', (_req: Request, res: Response) => {
  res.json({ devices: DEVICE_PROFILES.map((d) => ({ id: d.id, label: d.label, kind: d.kind, vendor: d.vendor, viewport: d.viewport, recommended: !!d.recommended, primary: d.id === PRIMARY_DEVICE_ID })), recommended: RECOMMENDED_DEVICE_IDS });
});

router.get('/standards', async (req: Request, res: Response) => {
  try {
    const rows = await listStandards(req.user!.tenantId);
    res.json({ standards: rows.map(({ standard, ...s }) => ({ ...s, preview: { colors: standard.colors?.slice(0, 12) || [], fontFamilies: standard.fontFamilies || [], fontSizes: standard.fontSizes || [] } })) });
  } catch (err: any) { res.status(500).json({ error: err.message || 'Failed to list design standards' }); }
});

router.post('/standards', async (req: Request, res: Response) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (!name) { res.status(400).json({ error: 'Give the design standard a name' }); return; }
    if (!content.trim()) { res.status(400).json({ error: 'The file is empty' }); return; }
    const { standard, ...s } = await createStandard(req.user!.tenantId, req.user!.username, name, content);
    res.status(201).json({ standard: { ...s, preview: { colors: standard.colors.slice(0, 12), fontFamilies: standard.fontFamilies, fontSizes: standard.fontSizes } } });
  } catch (err: any) {
    // Parse failures are the user's to fix, so they come back as 400 with the reason.
    res.status(400).json({ error: err.message || 'Could not read that file' });
  }
});

router.delete('/standards/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
    if (!(await deleteStandard(req.user!.tenantId, id))) { res.status(404).json({ error: 'Design standard not found' }); return; }
    res.json({ deleted: true });
  } catch (err: any) { res.status(500).json({ error: err.message || 'Failed to delete' }); }
});

router.get('/scans/:id/evidence/:file', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id), file = String(req.params.file);
    if (!UUID_RE.test(id) || !/^e\d{4}\.jpg$/.test(file)) { res.status(400).json({ error: 'Invalid evidence reference' }); return; }
    const own = await pool.query(`SELECT id FROM ada_scans WHERE id = $1 AND tenant_id = $2`, [id, req.user!.tenantId]);
    if (own.rows.length === 0) { res.status(404).json({ error: 'Audit not found' }); return; }
    const abs = path.join(evidenceDirFor(id), file);
    if (!existsSync(abs)) { res.status(404).json({ error: 'Evidence image is no longer available' }); return; }
    res.setHeader('Cache-Control', 'private, max-age=86400');
    // Serve relative to the evidence folder: Express rejects absolute paths that pass
    // through a dot-directory (a checkout under ".claude/…", a "~/.cache" reports dir).
    res.sendFile(file, { root: evidenceDirFor(id) });
  } catch (err: any) { res.status(500).json({ error: err.message || 'Failed to load evidence' }); }
});

/**
 * Instant health: the latest finished audit of a site, its change against the
 * previous one, and a pass/fail gate. It reads stored results only, so it
 * answers in milliseconds — the "is this site OK right now?" call for a
 * dashboard, a release checklist or a CI step. Thresholds are query params:
 *   minScore (default 80) · minUx (optional) · maxCritical (default 0)
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    const raw = String(req.query.url || '').trim();
    if (!raw) { res.status(400).json({ error: 'url is required' }); return; }
    let url: string;
    try { url = normaliseStartUrl(raw); } catch { res.status(400).json({ error: 'Invalid url' }); return; }
    const { rows } = await pool.query(
      `SELECT id, status, overall_score, pages_crawled, findings_count, result, finished_at, created_by
         FROM ada_scans WHERE tenant_id = $1 AND target_url = $2 AND status IN ('completed', 'cancelled') AND finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 2`,
      [req.user!.tenantId, url],
    );
    if (rows.length === 0) { res.status(404).json({ error: 'No finished audit for this site yet', url }); return; }
    const parse = (r: any) => { let x = r.result; if (typeof x === 'string') { try { x = JSON.parse(x); } catch { x = null; } } return x || {}; };
    const cur = parse(rows[0]), prev = rows[1] ? parse(rows[1]) : null;
    const cats = cur.categories || {};
    const uxCountOf = (x: any) => x?.categories?.ux ? (x.categories.ux.issues || 0) + (x.categories.ux.needsReview || 0) : 0;
    const issuesNow = Math.max(0, rows[0].findings_count - uxCountOf(cur));
    const sev = cats.accessibility?.bySeverity || {};
    const minScore = Number(req.query.minScore ?? 80), maxCritical = Number(req.query.maxCritical ?? 0);
    const minUx = req.query.minUx !== undefined ? Number(req.query.minUx) : null;
    const checks = [
      { name: 'overall-score', ok: (rows[0].overall_score ?? 0) >= minScore, actual: rows[0].overall_score, threshold: `>= ${minScore}` },
      { name: 'critical-accessibility', ok: (sev.critical || 0) <= maxCritical, actual: sev.critical || 0, threshold: `<= ${maxCritical}` },
      ...(minUx !== null ? [{ name: 'ux-score', ok: cats.ux?.score != null && cats.ux.score >= minUx, actual: cats.ux?.score ?? null, threshold: `>= ${minUx}` }] : []),
    ];
    res.json({
      url, scanId: rows[0].id, status: rows[0].status, finishedAt: rows[0].finished_at, runBy: rows[0].created_by,
      ageHours: Math.round(((Date.now() - new Date(rows[0].finished_at).getTime()) / 36e5) * 10) / 10,
      score: rows[0].overall_score, grade: cur.overall?.grade ?? null,
      categories: {
        accessibility: cats.accessibility?.score ?? null, links: cats.links?.score ?? null, bestPractice: cats.bestPractice?.score ?? null,
        ux: cats.ux?.score ?? null, uxLayout: cats.ux?.layout?.score ?? null, uxAdherence: cats.ux?.adherence?.score ?? null,
      },
      pagesAudited: rows[0].pages_crawled, issues: issuesNow, uxIssues: cats.ux ? cats.ux.issues : null,
      change: prev ? { since: rows[1].finished_at, score: (rows[0].overall_score ?? 0) - (rows[1].overall_score ?? 0), issues: issuesNow - Math.max(0, rows[1].findings_count - uxCountOf(prev)) } : null,
      gate: { passed: checks.every((c) => c.ok), checks },
    });
  } catch (err: any) { res.status(500).json({ error: err.message || 'Failed to load health' }); }
});

/* ───────────────────────────── recurring audits ───────────────────────────── */

router.get('/schedules', async (req: Request, res: Response) => {
  try { res.json({ schedules: await listSchedules(req.user!.tenantId) }); }
  catch (err: any) { res.status(500).json({ error: err.message || 'Failed to list schedules' }); }
});

router.post('/schedules', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
    if (!rawUrl) { res.status(400).json({ error: 'url is required' }); return; }
    let url: URL;
    try { url = new URL(normaliseStartUrl(rawUrl)); } catch { res.status(400).json({ error: 'That does not look like a valid website address' }); return; }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) { res.status(400).json({ error: 'Enter a public website address' }); return; }
    if (isPrivateTarget(url)) { res.status(400).json({ error: 'Internal or private network addresses cannot be audited' }); return; }
    const schedule = await createSchedule(req.user!.tenantId, req.user!.username, {
      url: url.toString(),
      frequency: body.frequency === 'weekly' ? 'weekly' : 'daily',
      runHourUtc: Number(body.runHourUtc ?? 3),
      runWeekday: body.runWeekday === undefined || body.runWeekday === null ? null : Number(body.runWeekday),
      maxPages: body.maxPages !== undefined ? Number(body.maxPages) : undefined,
      checkExternalLinks: body.checkExternalLinks !== false,
      username: typeof body.username === 'string' ? body.username : undefined,
      password: typeof body.password === 'string' && body.password ? body.password : undefined,
      ux: body.ux !== false,
      devices: Array.isArray(body.devices) ? body.devices.map(String) : undefined,
      designStandardId: typeof body.designStandardId === 'string' && UUID_RE.test(body.designStandardId) ? body.designStandardId : undefined,
    });
    res.status(201).json({ schedule });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create schedule' });
  }
});

router.patch('/schedules/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid schedule id' }); return; }
    const b = req.body || {};
    const schedule = await updateSchedule(req.user!.tenantId, id, {
      url: typeof b.url === 'string' ? b.url : undefined,
      frequency: b.frequency === 'daily' || b.frequency === 'weekly' ? b.frequency : undefined,
      runHourUtc: b.runHourUtc !== undefined ? Number(b.runHourUtc) : undefined,
      runWeekday: b.runWeekday !== undefined ? (b.runWeekday === null ? null : Number(b.runWeekday)) : undefined,
      maxPages: b.maxPages !== undefined ? Number(b.maxPages) : undefined,
      checkExternalLinks: typeof b.checkExternalLinks === 'boolean' ? b.checkExternalLinks : undefined,
      username: typeof b.username === 'string' ? b.username : undefined,
      password: typeof b.password === 'string' ? b.password : undefined,
      ux: typeof b.ux === 'boolean' ? b.ux : undefined,
      devices: Array.isArray(b.devices) ? b.devices.map(String) : undefined,
      designStandardId: typeof b.designStandardId === 'string' ? b.designStandardId : undefined,
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
    });
    if (!schedule) { res.status(404).json({ error: 'Schedule not found' }); return; }
    res.json({ schedule });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update schedule' });
  }
});

router.delete('/schedules/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid schedule id' }); return; }
    const ok = await deleteSchedule(req.user!.tenantId, id);
    if (!ok) { res.status(404).json({ error: 'Schedule not found' }); return; }
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete schedule' });
  }
});

router.post('/schedules/:id/run', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid schedule id' }); return; }
    const tenantId = req.user!.tenantId;
    const running = tenantHasRunningScan(tenantId);
    if (running) { res.status(409).json({ error: 'An audit is already running for your account', scanId: running }); return; }
    const scanId = await runScheduleNow(tenantId, id, req.user!.username);
    res.status(202).json({ scanId });
  } catch (err: any) {
    const status = /not found/i.test(err.message) ? 404 : 500;
    res.status(status).json({ error: err.message || 'Failed to start audit' });
  }
});

router.get('/scans/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid scan id' }); return; }
    const tenantId = req.user!.tenantId;
    const { rows } = await pool.query(`SELECT * FROM ada_scans WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (rows.length === 0) { res.status(404).json({ error: 'Audit not found' }); return; }
    const scan = rows[0];
    if (typeof scan.result === 'string') { try { scan.result = JSON.parse(scan.result); } catch { scan.result = null; } }
    scan.result = normaliseLegacySummary(scan.result);
    // progress_log is stored as text (not in the shim's JSON column list) - parse it here.
    if (typeof scan.progress_log === 'string') { try { scan.log = JSON.parse(scan.progress_log); } catch { scan.log = []; } }
    else scan.log = Array.isArray(scan.progress_log) ? scan.progress_log : [];
    delete scan.progress_log;
    const after = Number(req.query.after) || 0;
    const progress = getProgress(tenantId, id, after);
    // A scan that was running when the server restarted has no live state and
    // never got a terminal status — report it honestly rather than spinning forever.
    if (!progress && scan.status === 'running') {
      scan.status = 'failed';
      scan.error = 'The server restarted while this audit was running. Start it again.';
      await pool.query(`UPDATE ada_scans SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [id, scan.error]).catch(() => { /* best effort */ });
    }
    res.json({ scan, progress });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to load audit' });
  }
});

router.get('/scans/:id/findings', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid scan id' }); return; }
    const tenantId = req.user!.tenantId;
    const where: string[] = ['scan_id = $1', 'tenant_id = $2'];
    const params: unknown[] = [id, tenantId];
    const category = String(req.query.category || '');
    const severity = String(req.query.severity || '');
    const pageUrl = String(req.query.page || '');
    const q = String(req.query.q || '').trim();
    if (CATEGORIES.includes(category)) { params.push(category); where.push(`category = $${params.length}`); }
    // UX findings have their own tab; the issue explorer asks for everything except them.
    const notCategory = String(req.query.notCategory || '');
    if (CATEGORIES.includes(notCategory)) { params.push(notCategory); where.push(`category <> $${params.length}`); }
    if (SEVERITIES.includes(severity)) { params.push(severity); where.push(`severity = $${params.length}`); }
    if (pageUrl) { params.push(pageUrl); where.push(`page_url = $${params.length}`); }
    if (q) { params.push(`%${escapeLike(q)}%`); where.push(`(title LIKE $${params.length} OR rule_id LIKE $${params.length} OR page_url LIKE $${params.length} OR element LIKE $${params.length})`); }
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const count = await pool.query(`SELECT COUNT(*) AS n, COALESCE(SUM(occurrences), 0) AS occ FROM ada_findings WHERE ${where.join(' AND ')}`, params);
    const { rows } = await pool.query(
      `SELECT id, page_url, category, rule_id, severity, title, description, wcag, element, html_snippet, help_url, occurrences, details
         FROM ada_findings WHERE ${where.join(' AND ')}
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'serious' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END, rule_id, page_url
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
      params,
    );
    // Findings stored before remediation existed get it computed on the way out.
    for (const r of rows) {
      const details = (r.details && typeof r.details === 'object') ? r.details : {};
      if (!details.remediation) {
        details.remediation = remediate({
          pageUrl: r.page_url, category: r.category, ruleId: r.rule_id, severity: r.severity, title: r.title,
          description: r.description || undefined, wcag: r.wcag || undefined, element: r.element || undefined,
          htmlSnippet: r.html_snippet || undefined, helpUrl: r.help_url || undefined, occurrences: r.occurrences, details,
        });
        r.details = details;
      }
    }
    res.json({ findings: rows, total: Number(count.rows[0]?.n || 0), occurrences: Number(count.rows[0]?.occ || 0), limit, offset });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to load findings' });
  }
});

router.get('/scans/:id/pages', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid scan id' }); return; }
    const { rows } = await pool.query(
      `SELECT url, title, status_code, depth, parent_url, source, load_ms, links_found, a11y_score, bp_score, findings_count
         FROM ada_pages WHERE scan_id = $1 AND tenant_id = $2 ORDER BY depth, url`,
      [id, req.user!.tenantId],
    );
    res.json({ pages: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to load pages' });
  }
});

router.post('/scans/:id/cancel', (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid scan id' }); return; }
  const ok = cancelScan(req.user!.tenantId, id);
  if (!ok) { res.status(404).json({ error: 'No running audit with that id' }); return; }
  res.json({ cancelled: true });
});

router.delete('/scans/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid scan id' }); return; }
    const result = await pool.query(`DELETE FROM ada_scans WHERE id = $1 AND tenant_id = $2`, [id, req.user!.tenantId]);
    if (!result.rowCount) { res.status(404).json({ error: 'Audit not found' }); return; }
    await removeEvidence(id);
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete audit' });
  }
});

export default router;
