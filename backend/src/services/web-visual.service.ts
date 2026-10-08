/**
 * web-visual.service.ts
 * ─────────────────────
 * Visual + cross-browser screenshot testing — a standalone, opt-in Web Lab
 * tool. Captures a URL across browser engines (Chromium / Firefox / WebKit) and
 * viewports, and does visual-regression: store a baseline screenshot, then diff
 * a fresh capture against it with a pixel comparison. Mirrors the API module's
 * response baselines; lives alongside the pipeline and never touches it.
 *
 * Firefox/WebKit are optional — an engine whose binary is missing is reported as
 * unavailable rather than failing the whole capture.
 */
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import pool from '../db.js';
import { withPage, assertWebUrl, ENGINE_LABEL, BrowserNotInstalledError, WEB_ENGINES, type WebEngine } from './web-browser.service.js';

export interface Viewport { name: string; width: number; height: number }
export const VIEWPORTS: Record<string, Viewport> = {
  desktop: { name: 'desktop', width: 1280, height: 800 },
  laptop: { name: 'laptop', width: 1440, height: 900 },
  tablet: { name: 'tablet', width: 768, height: 1024 },
  mobile: { name: 'mobile', width: 390, height: 844 },
};

const PNG_BASE64_LIMIT = 6_000_000; // ~4.4 MB PNG; rejects oversized full captures

function viewportOf(name: unknown): Viewport {
  const key = String(name || 'desktop');
  return VIEWPORTS[key] || VIEWPORTS.desktop;
}
function engineOf(name: unknown, fallback: WebEngine = 'chromium'): WebEngine {
  return (WEB_ENGINES.includes(String(name) as WebEngine) ? name : fallback) as WebEngine;
}

/** Take one screenshot; returns PNG buffer + dimensions, or throws. */
async function shoot(url: string, engine: WebEngine, vp: Viewport, fullPage: boolean): Promise<{ buf: Buffer; width: number; height: number }> {
  return withPage(url, async (page) => {
    await page.waitForTimeout(400); // let late paints settle
    const buf = await page.screenshot({ type: 'png', fullPage });
    const png = PNG.sync.read(buf);
    return { buf, width: png.width, height: png.height };
  }, { engine, context: { viewport: { width: vp.width, height: vp.height } }, waitUntil: 'networkidle', gotoTimeoutMs: 45_000 });
}

/* ────────────────────────────────────────────────────────────────
   Cross-browser / cross-viewport capture (no storage)
   ──────────────────────────────────────────────────────────────── */

export interface CaptureCell { engine: WebEngine; engineLabel: string; viewport: string; ok: boolean; pngBase64?: string; width?: number; height?: number; error?: string; unavailable?: boolean }
export interface CaptureReport { url: string; cells: CaptureCell[]; capturedAt: string }

export async function captureScreens(input: { url: unknown; engines?: unknown; viewports?: unknown; fullPage?: unknown }): Promise<CaptureReport> {
  const url = assertWebUrl(input.url);
  const engines = (Array.isArray(input.engines) ? input.engines.map((e) => engineOf(e)).filter((e, i, a) => a.indexOf(e) === i) : ['chromium']) as WebEngine[];
  const vps = (Array.isArray(input.viewports) && input.viewports.length ? input.viewports.map(viewportOf) : [VIEWPORTS.desktop]);
  const fullPage = !!input.fullPage;

  const cells: CaptureCell[] = [];
  for (const engine of engines.slice(0, 3)) {
    for (const vp of vps.slice(0, 4)) {
      try {
        const { buf, width, height } = await shoot(url, engine, vp, fullPage);
        const b64 = buf.toString('base64');
        cells.push({ engine, engineLabel: ENGINE_LABEL[engine], viewport: vp.name, ok: true, pngBase64: b64.length > PNG_BASE64_LIMIT ? undefined : b64, width, height, error: b64.length > PNG_BASE64_LIMIT ? 'Screenshot too large to preview' : undefined });
      } catch (err) {
        const unavailable = err instanceof BrowserNotInstalledError;
        cells.push({ engine, engineLabel: ENGINE_LABEL[engine], viewport: vp.name, ok: false, unavailable, error: (err as Error).message });
        if (unavailable) break; // don't retry the same missing engine for every viewport
      }
    }
  }
  return { url, cells, capturedAt: new Date().toISOString() };
}

/* ────────────────────────────────────────────────────────────────
   Visual-regression baselines (stored; pixel diff on compare)
   ──────────────────────────────────────────────────────────────── */

function sigOf(url: string, engine: WebEngine, viewport: string): string {
  return createHash('sha1').update(`${engine}|${viewport}|${url.toLowerCase()}`).digest('hex');
}

export interface VisualBaseline { id: string; sig: string; url: string; engine: WebEngine; viewport: string; width: number; height: number; capturedBy: string; capturedAt: string; updatedAt: string }

function mapBaseline(r: any): VisualBaseline {
  return { id: String(r.id), sig: r.sig, url: r.url, engine: r.engine, viewport: r.viewport, width: Number(r.width) || 0, height: Number(r.height) || 0, capturedBy: r.captured_by || '', capturedAt: r.captured_at, updatedAt: r.updated_at };
}

export async function listVisualBaselines(tenantId: string): Promise<VisualBaseline[]> {
  const { rows } = await pool.query(`SELECT id, sig, url, engine, viewport, width, height, captured_by, captured_at, updated_at FROM web_visual_baselines WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(mapBaseline);
}

export async function captureVisualBaseline(tenantId: string, username: string, input: { url: unknown; engine?: unknown; viewport?: unknown; fullPage?: unknown }): Promise<VisualBaseline> {
  const url = assertWebUrl(input.url);
  const engine = engineOf(input.engine);
  const vp = viewportOf(input.viewport);
  const { buf, width, height } = await shoot(url, engine, vp, !!input.fullPage);
  const b64 = buf.toString('base64');
  if (b64.length > PNG_BASE64_LIMIT) throw new Error('This screenshot is too large to store as a baseline. Try a smaller viewport or disable full-page.');
  const sig = sigOf(url, engine, vp.name);
  await pool.query(`DELETE FROM web_visual_baselines WHERE tenant_id = $1 AND sig = $2`, [tenantId, sig]);
  const { rows } = await pool.query(
    `INSERT INTO web_visual_baselines (tenant_id, sig, url, engine, viewport, width, height, png, captured_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, sig, url, engine, viewport, width, height, captured_by, captured_at, updated_at`,
    [tenantId, sig, url, engine, vp.name, width, height, b64, username || ''],
  );
  return mapBaseline(rows[0]);
}

export async function deleteVisualBaseline(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM web_visual_baselines WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

export interface VisualCompare {
  url: string; engine: WebEngine; viewport: string;
  hasBaseline: boolean;
  matched: boolean;
  reason?: 'size-changed';
  diffPixels: number; totalPixels: number; diffRatio: number;
  width: number; height: number;
  baselinePng?: string; currentPng?: string; diffPng?: string;
  comparedAt: string;
}

export async function compareVisual(tenantId: string, input: { url: unknown; engine?: unknown; viewport?: unknown; fullPage?: unknown; threshold?: unknown }): Promise<VisualCompare> {
  const url = assertWebUrl(input.url);
  const engine = engineOf(input.engine);
  const vp = viewportOf(input.viewport);
  const sig = sigOf(url, engine, vp.name);
  const { rows } = await pool.query(`SELECT png, width, height FROM web_visual_baselines WHERE tenant_id = $1 AND sig = $2`, [tenantId, sig]);
  const base = { url, engine, viewport: vp.name, comparedAt: new Date().toISOString() };
  if (!rows.length) {
    return { ...base, hasBaseline: false, matched: false, diffPixels: 0, totalPixels: 0, diffRatio: 0, width: 0, height: 0 };
  }
  const { buf: curBuf } = await shoot(url, engine, vp, !!input.fullPage);
  const baseBuf = Buffer.from(rows[0].png, 'base64');
  const basePng = PNG.sync.read(baseBuf);
  const curPng = PNG.sync.read(curBuf);
  // Dimensions must agree for a pixel diff; a size change is itself a visual diff.
  if (basePng.width !== curPng.width || basePng.height !== curPng.height) {
    return {
      ...base, hasBaseline: true, matched: false, reason: 'size-changed',
      diffPixels: 0, totalPixels: basePng.width * basePng.height, diffRatio: 1,
      width: curPng.width, height: curPng.height,
      baselinePng: baseBuf.toString('base64'), currentPng: curBuf.toString('base64'),
    };
  }
  const { width, height } = basePng;
  const diff = new PNG({ width, height });
  const threshold = Math.min(1, Math.max(0, Number(input.threshold) || 0.1));
  const diffPixels = pixelmatch(basePng.data, curPng.data, diff.data, width, height, { threshold });
  const totalPixels = width * height;
  const diffRatio = totalPixels ? diffPixels / totalPixels : 0;
  const matched = diffPixels === 0;
  const curB64 = curBuf.toString('base64');
  const diffB64 = PNG.sync.write(diff).toString('base64');
  return {
    ...base, hasBaseline: true, matched,
    diffPixels, totalPixels, diffRatio: +diffRatio.toFixed(5),
    width, height,
    baselinePng: baseBuf.length > PNG_BASE64_LIMIT ? undefined : baseBuf.toString('base64'),
    currentPng: curB64.length > PNG_BASE64_LIMIT ? undefined : curB64,
    diffPng: diffB64.length > PNG_BASE64_LIMIT ? undefined : diffB64,
  };
}
