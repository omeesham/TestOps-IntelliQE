/**
 * Unit tests for the healing fix rules (services/heal-guard.service.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weakerFixReason } from '../src/services/heal-guard.service.js';

const caseText = 'Log in with "jane@acme.com" and check the message "Order saved" and total "$120.00"';

const before = `import { test, expect } from '@playwright/test';
test('save order', async ({ page }) => {
  await page.goto('https://shop.example.com/orders'); // open the orders page
  await page.locator('#email').fill('jane@acme.com');
  await page.locator('#save').click();
  await expect(page.getByText('Order saved')).toBeVisible();
  await expect(page.locator('#total')).toHaveText('$120.00');
});
`;
const swap = (from: string, to: string) => before.replace(from, to);

test('fixes that only change how the test finds and waits for things are accepted', () => {
  assert.equal(weakerFixReason(before, swap(`page.locator('#email')`, `page.getByLabel('Email')`), caseText), null);
  assert.equal(weakerFixReason(before, swap(`page.locator('#save').click();`, `page.getByRole('button', { name: 'Save' }).click();\n  await page.waitForLoadState('networkidle');`), caseText), null);
  assert.equal(weakerFixReason(before, swap(`'https://shop.example.com/orders'`, `'https://shop.example.com/orders', { waitUntil: 'domcontentloaded', timeout: 60000 }`), caseText), null);
  assert.equal(weakerFixReason(before, swap(`toBeVisible()`, `toBeVisible({ timeout: 15000 })`), caseText), null);
  // An expectation the test case does not name may be corrected to what the app really shows.
  assert.equal(weakerFixReason(before, swap(`'#total'`, `'#order-total'`).replace(`'$120.00'`, `/\\$120\\.00/`), 'check the order total'), null);
});

test('a removed, skipped, always-true or ignored check is rejected', () => {
  assert.match(weakerFixReason(before, swap(`  await expect(page.locator('#total')).toHaveText('$120.00');\n`, ''), caseText)!, /removes checks \(2 → 1\)/);
  assert.match(weakerFixReason(before, swap(`  await expect(page.locator('#total'))`, `  // await expect(page.locator('#total'))`), caseText)!, /removes checks/);
  assert.match(weakerFixReason(before, swap(`test('save order'`, `test.skip('save order'`), caseText)!, /skips the test/);
  assert.match(weakerFixReason(before, swap(`await expect(page.getByText('Order saved')).toBeVisible();`, `await expect(true).toBeTruthy();`), 'save')!, /always true/);
  assert.match(weakerFixReason(before, swap(`await expect(page.locator('#total')).toHaveText('$120.00');`, `try { await expect(page.locator('#total')).toHaveText('$120.00'); } catch {}`), caseText)!, /ignores a check/);
  assert.match(weakerFixReason(before, swap(`toHaveText('$120.00');`, `toHaveText('$120.00').catch(() => {});`), caseText)!, /ignores a check/);
});

test('a value the test case names may not change, in a check or in typed input', () => {
  assert.match(weakerFixReason(before, swap(`'$120.00'`, `'$125.00'`), caseText)!, /changes "\$120\.00"/);
  assert.match(weakerFixReason(before, swap(`getByText('Order saved')`, `getByText('Saved')`), caseText)!, /changes "Order saved"/);
  assert.match(weakerFixReason(before, swap(`fill('jane@acme.com')`, `fill('admin@acme.com')`), caseText)!, /changes "jane@acme.com"/);
});

test('picking the first match, fixed waits and long timeouts are rejected', () => {
  const first = swap(`page.locator('#save').click()`, `page.getByRole('button').first().click()`);
  assert.match(weakerFixReason(before, first, caseText, 'locator.click: Timeout 15000ms exceeded')!, /first\/last match/);
  assert.equal(weakerFixReason(before, first, caseText, "strict mode violation: getByRole('button') resolved to 2 elements"), null);
  assert.match(weakerFixReason(before, swap(`await page.locator('#save').click();`, `await page.locator('#save').click();\n  await page.waitForTimeout(5000);`), caseText)!, /fixed wait/);
  assert.match(weakerFixReason(before, swap(`toBeVisible()`, `toBeVisible({ timeout: 120_000 })`), caseText)!, /timeout to 120s/);
});

test('an existing answer-key check cannot be dropped', () => {
  const doc = `test('ticket', async ({ page }) => {\n  await checkDocument(doc, await readFields(page));\n});\n`;
  assert.match(weakerFixReason(doc, doc.replace('await checkDocument(doc, await readFields(page));', 'await readFields(page);'), '')!, /answer-key check/);
});
