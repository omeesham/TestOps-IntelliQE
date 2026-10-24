/**
 * Unit tests for read-only protection (services/uat-safety.service.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  parseSafety, pathMatches, blockReason, guardSpec, specForRun, safetyEnv, GUARD_FIXTURE_SOURCE, DEFAULT_AUTH_ALLOW,
} from '../src/services/uat-safety.service.js';
import { appEnvironments, readOnlyEnvironmentForUrl } from '../src/services/app-environments.js';

const on = parseSafety({ readOnly: true })!;
const nav = (url: string) => ({ method: 'GET', url, isNavigation: true });

test('off unless readOnly is exactly true; default sign-in endpoints apply', () => {
  assert.equal(parseSafety(undefined), undefined);
  assert.equal(parseSafety({ readOnly: 'true' }), undefined);
  assert.deepEqual(on.allowWrite, DEFAULT_AUTH_ALLOW);
  assert.deepEqual(parseSafety({ readOnly: true, allowWrite: [' /api/session ', ''] })!.allowWrite, ['/api/session']);
});

test('sign-in entries match whole path segments, or a prefix when they contain "/"', () => {
  assert.equal(pathMatches('https://a.test/api/auth/login', ['auth']), true);
  assert.equal(pathMatches('https://a.test/authors/12', ['auth']), false);
  assert.equal(pathMatches('https://a.test/api/session/new', ['/api/session']), true);
  assert.equal(pathMatches('https://a.test/x/api/session', ['/api/session']), false);
});

test('writes are blocked, reads and sign-in are allowed', () => {
  assert.match(blockReason({ method: 'POST', url: 'https://a.test/api/orders', isNavigation: false }, on)!, /write request POST/);
  assert.match(blockReason({ method: 'delete', url: 'https://a.test/api/orders/1', isNavigation: false }, on)!, /DELETE/);
  assert.equal(blockReason({ method: 'GET', url: 'https://a.test/api/orders', isNavigation: false }, on), null);
  assert.equal(blockReason({ method: 'POST', url: 'https://a.test/login', isNavigation: false }, on), null);
});

test('allowed paths limit navigation on the app origin only', () => {
  const s = parseSafety({ readOnly: true, allowedPaths: ['/reports'] })!;
  assert.equal(blockReason(nav('https://a.test/reports/1'), s, 'https://a.test'), null);
  assert.match(blockReason(nav('https://a.test/admin'), s, 'https://a.test')!, /outside allowed paths/);
  assert.equal(blockReason(nav('https://other.test/admin'), s, 'https://a.test'), null);
  assert.equal(blockReason(nav('https://a.test/login'), s, 'https://a.test'), null);
});

test('guardSpec points test/expect at the fixture and keeps other imports', () => {
  const g = guardSpec(`import { test, expect, type Page } from '@playwright/test';\ntest('x', async () => {});`);
  assert.equal(g.ok, true);
  assert.match(g.code, /import \{ test, expect \} from '\.\.\/iqe-guard';/);
  assert.match(g.code, /import \{ type Page \} from '@playwright\/test';/);
  assert.doesNotMatch(g.code, /import \{ test[^}]*\} from '@playwright\/test'/);
});

test('specs that could escape the guard are refused (fail closed)', () => {
  for (const code of [
    `import { test, chromium } from '@playwright/test';\nconst b = await chromium.launch();`,
    `import { test } from '@playwright/test';\ntest('x', async ({ browser }) => { await browser.newContext(); });`,
    `import { test } from '@playwright/test';\ntest('x', async ({ page }) => { await page.route('**', (r) => r.continue()); });`,
    `import { test } from '@playwright/test';\ntest.use({ serviceWorkers: 'allow' });`,
    `import * as pw from '@playwright/test';`,
    `const { test } = require('@playwright/test');`,
    `test('no import', async () => {});`,
  ]) assert.equal(guardSpec(code).ok, false, code);
  const stub = specForRun(`const { test } = require('@playwright/test');`, 'Book a ticket', on);
  assert.match(stub, /blocked by read-only safety/);
  assert.match(stub, /toBe\(true\)/);
});

test('nothing changes when read-only is off', () => {
  const code = `import { test } from '@playwright/test';`;
  assert.equal(specForRun(code, 't', undefined), code);
});

test('a typed URL on a read-only environment is found; other environments are not', () => {
  const configs = [{ configData: { environments: [
    { id: 'qa', name: 'QA', baseUrl: 'https://qa.shop.test' },
    { id: 'uat', name: 'UAT', baseUrl: 'https://uat.shop.test/app', safety: { readOnly: true } },
  ] } }];
  assert.equal(readOnlyEnvironmentForUrl(configs, 'https://uat.shop.test/checkout')?.id, 'uat');
  assert.equal(readOnlyEnvironmentForUrl(configs, 'https://qa.shop.test/'), undefined);
  assert.equal(readOnlyEnvironmentForUrl(configs, 'not a url'), undefined);
  assert.equal(appEnvironments(configs[0].configData)[0].safety, undefined);
});

test('the run fixture decides exactly like the service', async () => {
  const s = parseSafety({ readOnly: true, allowedPaths: ['/reports'], allowWrite: ['auth', '/api/session'] })!;
  Object.assign(process.env, safetyEnv(s, 'https://a.test/'));
  // The fixture imports @playwright/test, so it is loaded from inside the backend.
  const file = path.join(process.cwd(), `.iqe-guard-${process.pid}.ts`);
  fs.writeFileSync(file, GUARD_FIXTURE_SOURCE);
  try {
    const fixture = await import(pathToFileURL(file).href);
    const cases = [
      ['POST', 'https://a.test/api/orders', false], ['GET', 'https://a.test/api/orders', false],
      ['POST', 'https://a.test/api/auth/login', false], ['POST', 'https://a.test/authors', false],
      ['PUT', 'https://a.test/api/session/1', false], ['GET', 'https://a.test/admin', true],
      ['GET', 'https://a.test/reports/9', true], ['GET', 'https://b.test/admin', true],
    ] as const;
    for (const [method, url, isNavigation] of cases) {
      assert.equal(fixture.blockReason(method, url, isNavigation), blockReason({ method, url, isNavigation }, s, 'https://a.test'), `${method} ${url}`);
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
});
