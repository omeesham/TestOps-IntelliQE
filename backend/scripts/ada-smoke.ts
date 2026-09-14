/**
 * Standalone smoke run of the ADA audit engine — no database, no server.
 *   npx tsx scripts/ada-smoke.ts https://www.centerpointenergy.com 10
 */
import { runScan } from '../src/services/ada/ada-engine.js';

const url = process.argv[2] || 'https://www.centerpointenergy.com';
const maxPages = Number(process.argv[3]) || 10;

const t0 = Date.now();
const result = await runScan(
  { url, maxPages, maxDepth: 3, useSitemap: true, checkExternalLinks: true, crawlDelayMs: 400 },
  (e) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${e.type.padEnd(14)} ${e.message}`),
  { cancelled: false },
);

const s = result.summary;
console.log('\n================ SUMMARY ================');
console.log(JSON.stringify({
  site: s.siteName, pages: s.pagesCrawled, linksFound: s.linksFound, linksChecked: s.linksChecked,
  overall: s.overall, accessibility: { score: s.categories.accessibility.score, violations: s.categories.accessibility.violations, bySeverity: s.categories.accessibility.bySeverity },
  links: { score: s.categories.links.score, ok: s.categories.links.ok, redirects: s.categories.links.redirects, broken: s.categories.links.broken, serverErrors: s.categories.links.serverErrors, timeouts: s.categories.links.timeouts },
  bestPractice: { score: s.categories.bestPractice.score, failing: s.categories.bestPractice.failingRules.map((r) => `${r.ruleId}(${r.pages})`) },
  notes: s.notes, durationSec: Math.round(s.durationMs / 1000),
}, null, 2));
console.log('\nTop accessibility rules:');
for (const r of s.categories.accessibility.topRules.slice(0, 8)) console.log(`  ${r.severity.padEnd(8)} ${r.ruleId.padEnd(28)} pages=${r.pages} occ=${r.occurrences} ${r.wcag || ''}`);
console.log('\nBroken links (first 10):');
for (const l of s.categories.links.brokenLinks.slice(0, 10)) console.log(`  ${String(l.status ?? l.kind).padEnd(6)} ${l.url}  <- ${l.referrers[0]}`);
console.log('\nPages:');
for (const p of result.pages) console.log(`  d${p.depth} ${String(p.statusCode).padEnd(4)} a11y=${String(p.a11yScore).padStart(3)} bp=${String(p.bpScore).padStart(3)} ${p.loadMs}ms ${p.url}`);
