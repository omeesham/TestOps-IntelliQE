// TEMP probe (safe to delete): log into the Navigator staging app via SSO and
// dump the REAL post-login navigation so generated scripts can be grounded.
// Credentials are read from the tenant's Application Setup config at runtime
// (same decrypt path the pipeline uses) — nothing sensitive is stored here.
import { chromium } from '@playwright/test';
import pool from '../src/db.js';
import { decryptConfigData } from '../src/utils/crypto.js';

const cfgRes = await pool.query(
  `SELECT config_data FROM client_configurations WHERE integration_id = $1`,
  ['app-encoreglobal'],
);
const cfg = decryptConfigData(cfgRes.rows[0]?.config_data || {});
const BASE = String(cfg.baseUrl || '').replace(/\/+$/, '');
const role = (cfg.roles || [])[0] || {};
const USER = String(role.username || '');
const PASS = String(role.password || '');
if (!BASE || !USER || !PASS) { console.log('MISSING APP CONFIG'); process.exit(1); }
console.log('base:', BASE, '| user:', USER.replace(/(.{3}).*(@.*)/, '$1***$2'));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto(`${BASE}/auth/sign-in`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const continueBtn = page.getByRole('button', { name: 'Continue Now' });
  await continueBtn.waitFor({ state: 'visible', timeout: 30000 });
  await continueBtn.click();

  const emailField = page.locator('input[name="loginfmt"], input[type="email"], input[type="text"]').first();
  await emailField.waitFor({ state: 'visible', timeout: 30000 });
  await emailField.fill(USER);
  await page.locator('input[type="submit"], button[type="submit"], #idSIButton9').first().click();

  const passwordField = page.locator('input[name="passwd"], input[type="password"]').first();
  await passwordField.waitFor({ state: 'visible', timeout: 30000 });
  await passwordField.fill(PASS);
  await page.locator('input[type="submit"], button[type="submit"], #idSIButton9').first().click();

  const offIdp = (u: URL | string) => !/login\.microsoftonline|okta|auth0|accounts\.google|login\.windows/i.test(u.toString());
  await Promise.race([
    page.waitForURL(offIdp, { timeout: 45000 }).catch(() => {}),
    page.getByText(/stay signed in\?/i).waitFor({ state: 'visible', timeout: 45000 }).catch(() => {}),
  ]);
  if (!offIdp(page.url()) && (await page.getByText(/stay signed in\?/i).isVisible().catch(() => false))) {
    await page.locator('#idSIButton9, input[type="submit"], button[type="submit"]').first().click();
  }
  await page.waitForURL(offIdp, { timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);

  console.log('LANDED URL:', page.url());
  console.log('TITLE:', await page.title());

  // String-form evaluate: tsx/esbuild injects a `__name` helper into compiled
  // closures which doesn't exist inside the browser context.
  const dump = await page.evaluate(`(() => {
    const seen = new Set();
    const grab = (sel) => [...document.querySelectorAll(sel)]
      .map((e) => (e.innerText || '').trim() || e.getAttribute('aria-label') || '')
      .filter((t) => t && t.length < 60 && !seen.has(t) && seen.add(t));
    return {
      links: grab('a'),
      buttons: grab('button'),
      menuitems: grab('[role="menuitem"], [role="tab"], nav a, nav button, nav span'),
      officeMatches: [...document.querySelectorAll('*')]
        .filter((e) => e.children.length === 0 && /office/i.test(e.innerText || ''))
        .map((e) => e.innerText.trim().slice(0, 80)).slice(0, 20),
    };
  })()`) as any;
  console.log('LINKS:', JSON.stringify(dump.links.slice(0, 40)));
  console.log('BUTTONS:', JSON.stringify(dump.buttons.slice(0, 40)));
  console.log('NAV/MENU:', JSON.stringify(dump.menuitems.slice(0, 40)));
  console.log('OFFICE MATCHES:', JSON.stringify(dump.officeMatches));
} catch (e: any) {
  console.log('PROBE ERROR:', e?.message);
  console.log('URL AT ERROR:', page.url());
} finally {
  await browser.close();
}
process.exit(0);
