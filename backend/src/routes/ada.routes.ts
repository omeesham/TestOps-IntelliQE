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
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import {
  startScan, getProgress, cancelScan, tenantHasRunningScan, DEFAULT_OPTIONS,
} from '../services/ada/ada-scan.service.js';
import { normaliseStartUrl } from '../services/ada/ada-engine.js';
import { remediate } from '../services/ada/ada-remediation.js';
import type { ScanOptions } from '../services/ada/ada-types.js';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = ['accessibility', 'links', 'best-practice', 'review'];
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
    };
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

router.get('/scans/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid scan id' }); return; }
    const tenantId = req.user!.tenantId;
    const { rows } = await pool.query(`SELECT * FROM ada_scans WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (rows.length === 0) { res.status(404).json({ error: 'Audit not found' }); return; }
    const scan = rows[0];
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
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete audit' });
  }
});

export default router;
