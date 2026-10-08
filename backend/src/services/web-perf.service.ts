/**
 * web-perf.service.ts
 * ───────────────────
 * Web performance metrics — a standalone, opt-in Web Lab tool. Loads a URL in a
 * headless browser and captures Core Web Vitals and navigation/resource timing
 * from the page's own Performance APIs (no Lighthouse binary). Lives alongside
 * the pipeline and never touches it.
 */
import { withPage, assertWebUrl, ENGINE_LABEL, type WebEngine } from './web-browser.service.js';

export type Rating = 'good' | 'needs-improvement' | 'poor' | 'na';

export interface Metric { key: string; label: string; value: number | null; unit: string; rating: Rating }

export interface PerfReport {
  url: string;
  engine: WebEngine;
  engineLabel: string;
  metrics: Metric[];
  resources: { total: number; transferBytes: number; byType: { type: string; count: number; bytes: number }[] };
  overall: Rating;
  measuredAt: string;
}

/* Common Core Web Vitals thresholds (good / needs-improvement boundaries). */
function rate(value: number | null, good: number, ni: number): Rating {
  if (value == null) return 'na';
  if (value <= good) return 'good';
  if (value <= ni) return 'needs-improvement';
  return 'poor';
}

interface RawPerf {
  ttfb: number | null; fcp: number | null; lcp: number | null; cls: number | null;
  domContentLoaded: number | null; load: number | null;
  resources: { type: string; bytes: number }[];
}

/** Collected inside the page: buffered paint/LCP/CLS entries + navigation timing. */
/* eslint-disable */
function collectInPage(): Promise<RawPerf> {
  return new Promise<RawPerf>((resolve) => {
    const out: any = { ttfb: null, fcp: null, lcp: null, cls: null, domContentLoaded: null, load: null, resources: [] };
    try {
      const nav = (performance.getEntriesByType('navigation') as any[])[0];
      if (nav) {
        out.ttfb = Math.round(nav.responseStart);
        out.domContentLoaded = Math.round(nav.domContentLoadedEventEnd);
        out.load = Math.round(nav.loadEventEnd || nav.duration);
      }
      const fcp = performance.getEntriesByType('paint').find((e: any) => e.name === 'first-contentful-paint') as any;
      if (fcp) out.fcp = Math.round(fcp.startTime);
      for (const r of performance.getEntriesByType('resource') as any[]) {
        out.resources.push({ type: r.initiatorType || 'other', bytes: r.transferSize || r.encodedBodySize || 0 });
      }
      let cls = 0;
      try {
        const clsObs = new PerformanceObserver((list) => { for (const e of list.getEntries() as any[]) if (!e.hadRecentInput) cls += e.value; });
        clsObs.observe({ type: 'layout-shift', buffered: true } as any);
      } catch (e) {}
      let lcp: number | null = null;
      try {
        const lcpObs = new PerformanceObserver((list) => { const es = list.getEntries() as any[]; const last = es[es.length - 1]; if (last) lcp = Math.round(last.startTime); });
        lcpObs.observe({ type: 'largest-contentful-paint', buffered: true } as any);
      } catch (e) {}
      setTimeout(() => { out.cls = Math.round(cls * 1000) / 1000; out.lcp = lcp; resolve(out as RawPerf); }, 1200);
    } catch (e) {
      resolve(out as RawPerf);
    }
  });
}
/* eslint-enable */

export async function capturePerformance(input: { url: unknown; engine?: unknown }): Promise<PerfReport> {
  const url = assertWebUrl(input.url);
  const engine: WebEngine = (['chromium', 'firefox', 'webkit'].includes(String(input.engine)) ? input.engine : 'chromium') as WebEngine;

  const raw = await withPage(url, async (page) => {
    await page.waitForLoadState('load').catch(() => {});
    return page.evaluate(collectInPage);
  }, { engine, waitUntil: 'load', gotoTimeoutMs: 60_000 });

  const metrics: Metric[] = [
    { key: 'lcp', label: 'Largest Contentful Paint', value: raw.lcp, unit: 'ms', rating: rate(raw.lcp, 2500, 4000) },
    { key: 'fcp', label: 'First Contentful Paint', value: raw.fcp, unit: 'ms', rating: rate(raw.fcp, 1800, 3000) },
    { key: 'cls', label: 'Cumulative Layout Shift', value: raw.cls, unit: '', rating: rate(raw.cls == null ? null : raw.cls, 0.1, 0.25) },
    { key: 'ttfb', label: 'Time to First Byte', value: raw.ttfb, unit: 'ms', rating: rate(raw.ttfb, 800, 1800) },
    { key: 'dcl', label: 'DOM Content Loaded', value: raw.domContentLoaded, unit: 'ms', rating: 'na' },
    { key: 'load', label: 'Load', value: raw.load, unit: 'ms', rating: rate(raw.load, 2500, 5000) },
  ];

  const byTypeMap = new Map<string, { count: number; bytes: number }>();
  let transferBytes = 0;
  for (const r of raw.resources) {
    transferBytes += r.bytes;
    const cur = byTypeMap.get(r.type) || { count: 0, bytes: 0 };
    cur.count++; cur.bytes += r.bytes;
    byTypeMap.set(r.type, cur);
  }
  const byType = [...byTypeMap.entries()].map(([type, v]) => ({ type, count: v.count, bytes: v.bytes })).sort((a, b) => b.bytes - a.bytes).slice(0, 10);

  const core = metrics.filter((m) => ['lcp', 'cls', 'fcp'].includes(m.key)).map((m) => m.rating);
  const overall: Rating = core.includes('poor') ? 'poor' : core.includes('needs-improvement') ? 'needs-improvement' : core.every((r) => r === 'good') ? 'good' : 'na';

  return {
    url, engine, engineLabel: ENGINE_LABEL[engine],
    metrics,
    resources: { total: raw.resources.length, transferBytes, byType },
    overall,
    measuredAt: new Date().toISOString(),
  };
}
