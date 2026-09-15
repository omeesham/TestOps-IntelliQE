/** Sanity check for the site inventory against a real sitemap dump: npx tsx scripts/inventory-smoke.ts <urls.txt> <startUrl> */
import { readFileSync } from 'node:fs';
import { buildInventory, describeInventory, orderForCrawl, inAuditedLocale } from '../src/services/ada/ada-inventory.js';

const [file, start = 'https://www.centerpointenergy.com/'] = process.argv.slice(2);
const urls = readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean);
const inv = buildInventory(urls, start);
console.log(describeInventory(inv));
console.log({ sitemapUrls: inv.sitemapUrls, uniquePages: inv.uniquePages, auditedLocale: inv.auditedLocale, pagesInScope: inv.pagesInScope, templatedPages: inv.templatedPages });
console.log('locales', inv.locales);
console.log('sections', inv.sections.slice(0, 12));
const order = orderForCrawl(urls.filter((u) => inAuditedLocale(u, inv)), inv);
console.log('queue length', order.length, '\nfirst 25:'); order.slice(0, 25).forEach((u) => console.log('  ', u));
console.log('news pages within first 500:', order.slice(0, 500).filter((u) => u.includes('/about-us/news/')).length);
