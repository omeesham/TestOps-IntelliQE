/**
 * Site inventory — turns a raw list of URLs (sitemap + discovered links) into
 * something a person can reason about:
 *
 *   9,894 URLs in the sitemap
 *   → 5 language versions of the same site (en-us, es-us, so-us, vi-us, zh-us)
 *   → 1,987 unique pages in the audited language
 *   → of which 1,354 are templated articles (news by year) — sampled, not all audited
 *
 * It also decides the crawl order: every section gets covered before any one
 * templated section (news, blog, press releases) eats the page budget.
 */

export interface SiteInventory {
  /** Raw <loc> entries read from the sitemap(s). */
  sitemapUrls: number;
  /** Same-site, de-duplicated pages across every language. */
  uniquePages: number;
  /** Language prefixes seen in the paths (e.g. en-us). Empty when the site is not localised by path. */
  locales: { code: string; pages: number; audited: boolean }[];
  auditedLocale: string | null;
  /** Unique pages in the audited language — the number the audit works against. */
  pagesInScope: number;
  /** Top sections of the audited language, biggest first. */
  sections: { path: string; pages: number; templated: boolean }[];
  /** Pages that live in templated sections (news/blog/press archives). */
  templatedPages: number;
}

const LOCALE_SEG = /^[a-z]{2}(?:-[a-z]{2,4})?$/i;
const TEMPLATED_NAME = /news|blog|press|article|stor(?:y|ies)|release|media|insight|event|archive|announcement|noticia|nouvelles|resource-hub|case-stud/i;
const TEMPLATED_MIN_PAGES = 40;
/** How many pages of each templated section go in front of the queue; the rest are audited last. */
export const TEMPLATED_SAMPLE = 8;

function pathOf(u: string): string {
  try { return new URL(u).pathname.replace(/\/+$/, '') || '/'; } catch { return '/'; }
}

/** Language prefix of a URL path, e.g. "/en-us/about" → "en-us". */
export function localeOf(u: string): string | null {
  const first = pathOf(u).split('/')[1] || '';
  return LOCALE_SEG.test(first) ? first.toLowerCase() : null;
}

/** Path without its language prefix, so translations of one page compare equal. */
function pathSansLocale(u: string): string {
  const p = pathOf(u);
  const segs = p.split('/');
  if (segs[1] && LOCALE_SEG.test(segs[1])) return '/' + segs.slice(2).join('/');
  return p;
}

/** Section key = first two path segments after the language prefix ("/about-us/news"). */
export function sectionOf(u: string): string {
  const segs = pathSansLocale(u).split('/').filter(Boolean);
  return '/' + segs.slice(0, 2).join('/');
}

export function buildInventory(rawUrls: string[], startUrl: string): SiteInventory {
  const unique = [...new Set(rawUrls)];
  const byLocale = new Map<string, number>();
  for (const u of unique) {
    const l = localeOf(u);
    if (l) byLocale.set(l, (byLocale.get(l) || 0) + 1);
  }
  // Only treat prefixes as languages when the site really is localised that way:
  // more than one prefix, or the start URL itself carries one.
  const startLocale = localeOf(startUrl);
  const localised = byLocale.size > 1 || (startLocale !== null && byLocale.has(startLocale));
  let auditedLocale: string | null = null;
  if (localised) {
    if (startLocale && byLocale.has(startLocale)) auditedLocale = startLocale;
    else {
      const sorted = [...byLocale.entries()].sort((a, b) => (Number(b[0].startsWith('en')) - Number(a[0].startsWith('en'))) || b[1] - a[1]);
      auditedLocale = sorted[0]?.[0] ?? null;
    }
  }
  const inScope = unique.filter((u) => !auditedLocale || localeOf(u) === auditedLocale || (localeOf(u) === null && byLocale.size === 0));

  const sectionCounts = new Map<string, { pages: number; years: Set<string> }>();
  for (const u of inScope) {
    const s = sectionOf(u);
    const e = sectionCounts.get(s) || { pages: 0, years: new Set<string>() };
    e.pages += 1;
    const yr = pathSansLocale(u).split('/')[3];
    if (yr && /^(19|20)\d{2}$/.test(yr)) e.years.add(yr);
    sectionCounts.set(s, e);
  }
  const sections = [...sectionCounts.entries()]
    .map(([path, e]) => ({ path, pages: e.pages, templated: e.pages >= TEMPLATED_MIN_PAGES && (TEMPLATED_NAME.test(path) || e.years.size >= 3) }))
    .sort((a, b) => b.pages - a.pages);

  return {
    sitemapUrls: rawUrls.length,
    uniquePages: unique.length,
    locales: [...byLocale.entries()].sort((a, b) => b[1] - a[1]).map(([code, pages]) => ({ code, pages, audited: code === auditedLocale })),
    auditedLocale,
    pagesInScope: inScope.length,
    sections,
    templatedPages: sections.filter((s) => s.templated).reduce((a, s) => a + s.pages, 0),
  };
}

/** True when a URL belongs to the language being audited (or the site is not localised). */
export function inAuditedLocale(u: string, inv: SiteInventory): boolean {
  if (!inv.auditedLocale) return true;
  const l = localeOf(u);
  return l === null || l === inv.auditedLocale;
}

/**
 * Crawl order for sitemap pages: shallow pages first, sections interleaved so
 * every part of the site is reached early, and only a sample of each templated
 * section up front — the remaining articles go to the back of the queue.
 */
export function orderForCrawl(urls: string[], inv: SiteInventory): string[] {
  const templated = new Set(inv.sections.filter((s) => s.templated).map((s) => s.path));
  const groups = new Map<string, string[]>();
  for (const u of urls) {
    const s = sectionOf(u);
    (groups.get(s) || groups.set(s, []).get(s)!).push(u);
  }
  const depth = (u: string) => pathOf(u).split('/').filter(Boolean).length;
  const front: string[][] = [];
  const back: string[] = [];
  for (const [s, list] of groups) {
    list.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
    if (templated.has(s)) { front.push(list.slice(0, TEMPLATED_SAMPLE)); back.push(...list.slice(TEMPLATED_SAMPLE)); }
    else front.push(list);
  }
  // Round-robin across sections.
  const out: string[] = [];
  let more = true;
  for (let i = 0; more; i++) {
    more = false;
    for (const list of front) if (i < list.length) { out.push(list[i]); more = true; }
  }
  return out.concat(back);
}

export function describeInventory(inv: SiteInventory): string {
  const parts: string[] = [];
  parts.push(`Sitemap lists ${inv.sitemapUrls.toLocaleString()} URL${inv.sitemapUrls === 1 ? '' : 's'}`);
  if (inv.auditedLocale) {
    const others = inv.locales.filter((l) => !l.audited).map((l) => l.code);
    parts.push(`${inv.pagesInScope.toLocaleString()} unique pages in ${inv.auditedLocale}${others.length ? ` (${others.length} other language version${others.length === 1 ? '' : 's'}: ${others.join(', ')} — translations of the same pages, not audited)` : ''}`);
  } else if (inv.uniquePages !== inv.sitemapUrls) {
    parts.push(`${inv.uniquePages.toLocaleString()} unique pages`);
  }
  if (inv.templatedPages) {
    const names = inv.sections.filter((s) => s.templated).map((s) => `${s.path} (${s.pages.toLocaleString()})`).join(', ');
    parts.push(`${inv.templatedPages.toLocaleString()} are templated articles in ${names} — a sample is audited first, the rest last`);
  }
  return parts.join(' · ') + '.';
}
