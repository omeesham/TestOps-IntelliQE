/**
 * UI regression: the journeys users already rely on still work end to end.
 * AI steps are answered by fake-ai.mjs; generated scripts test a page they
 * build themselves, and one of them fails until it is healed.
 *
 * Every journey also fails on browser errors or 5xx API responses, except the
 * known issues in expected-differences.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { BASELINE, PASSWORD, USER, apiAsAdmin, requireCredentials, signIn, startSignedIn, watchForErrors } from './helpers';
import { KNOWN_ISSUES } from './expected-differences';

const IGNORE = KNOWN_ISSUES.map((k) => k.pattern);
let errors: () => string[];

test.beforeAll(() => requireCredentials());

test.beforeEach(async ({ context, page }, testInfo) => {
  if (testInfo.title !== 'sign-in rejects a wrong password and accepts the right one') await startSignedIn(context);
  errors = watchForErrors(page, IGNORE);
});

test.afterEach(() => {
  const found = errors();
  expect(found, `errors behind the screen:\n${found.join('\n')}`).toEqual([]);
});

/** Chat → Web Application Automation, past the sub-category choice when shown. */
async function startWebFlow(page: Page, source: RegExp): Promise<void> {
  await page.goto('/chat');
  const newChat = page.getByRole('button', { name: /New chat|Start New Test/ }).first();
  if (await newChat.isVisible().catch(() => false)) await newChat.click();
  await page.getByRole('button', { name: /Web Application Automation/ }).click();
  const sourceButton = page.getByRole('button', { name: source });
  if (!(await sourceButton.isVisible({ timeout: 3_000 }).catch(() => false))) {
    await page.locator('div.grid button:not([disabled])').first().click();
  }
  await sourceButton.click();
}

/** Generate from the column step and end on the saved suite (older builds needed a manual Save). */
async function generateAndSave(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Generate Test Cases/ }).click();
  const saved = page.getByText('Test Cases Saved!');
  const saveButton = page.getByRole('button', { name: /^Save Test Cases$/ }).first();
  await expect(saved.or(saveButton)).toBeVisible({ timeout: 120_000 });
  if (await saveButton.isVisible().catch(() => false)) await saveButton.click();
  await expect(saved).toBeVisible({ timeout: 30_000 });
}

test('sign-in rejects a wrong password and accepts the right one', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[type="text"], input[name="username"]').first().fill(USER);
  await page.locator('input[type="password"]').first().fill('definitely-not-the-password');
  await page.locator('button[type="submit"]').first().click();
  await expect(page.getByText(/invalid credentials/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, USER, PASSWORD);
});

test('chat: requirements → saved suite → scripts → run → heal → report', async ({ page }) => {
  test.setTimeout(900_000);
  await test.step('pasted requirements become a saved suite', async () => {
    await startWebFlow(page, /Paste Requirements/);
    await page.locator('textarea').first().fill('The shop home page shows the heading "Regression Shop" and a "Sign in" button.');
    await page.getByRole('button', { name: /Submit Requirements/ }).click();
    await generateAndSave(page);
    await expect(page.getByText(/3 test cases saved/).first()).toBeVisible();
  });
  await test.step('scripts are generated and executed; one fails', async () => {
    await page.getByRole('button', { name: /Generate Automation Scripts/ }).click();
    await page.getByRole('button', { name: /Execute Test Suite/ }).click({ timeout: 120_000 });
    await expect(page.getByRole('button', { name: /Auto-Heal & Re-Execute/ })).toBeVisible({ timeout: 300_000 });
  });
  await test.step('healing fixes it and the report is generated', async () => {
    await page.getByRole('button', { name: /Auto-Heal & Re-Execute/ }).click();
    const report = page.getByRole('button', { name: /^Generate Report$/ });
    await expect(report, 'all scripts pass after healing').toBeVisible({ timeout: 300_000 });
    await report.click();
    await expect(page.getByText('Test Execution Report').first()).toBeVisible({ timeout: 120_000 });
  });
});

test('chat: an uploaded requirements document becomes a saved test suite', async ({ page }) => {
  const file = path.join(os.tmpdir(), `regression-requirements-${Date.now()}.txt`);
  fs.writeFileSync(file, 'Shop home page\n\nThe home page shows the heading "Regression Shop" and a "Sign in" button.\n');
  await startWebFlow(page, /Upload Document/);
  await page.locator('input[type="file"]').first().setInputFiles(file);
  const next = page.getByRole('button', { name: /Use this document|Continue|Submit|Extract|Analy[sz]e/ }).first();
  if (await next.isVisible({ timeout: 10_000 }).catch(() => false)) await next.click();
  await generateAndSave(page);
  fs.rmSync(file, { force: true });
});

test('generated test cases: open a suite, edit, add and delete a case, export CSV', async ({ page }) => {
  const id = Date.now().toString(36);
  const suite = `Review suite ${id}`;
  const api = await apiAsAdmin();
  const saved = await api.post('/api/test-cases/save', {
    data: { username: 'regression', storyTitle: suite, source: 'text', columns: ['title', 'steps', 'expected'],
      testCases: [{ title: `Case ${id}`, steps: ['Open the page'], expectedResult: 'Page opens', priority: 'P1', type: 'positive' }] },
  });
  expect(saved.ok(), 'save a suite to review').toBeTruthy();
  await api.dispose();

  await page.goto('/generated-tests');
  await page.getByText(suite).first().click();
  await expect(page.getByText(`Case ${id}`).first()).toBeVisible();

  await page.getByTitle('Edit').first().click();
  const editRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Save', exact: true }) });
  await editRow.getByRole('textbox').first().fill(`Case ${id} (edited)`);
  await editRow.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(`Case ${id} (edited)`).first()).toBeVisible();

  await page.getByRole('button', { name: /^Add Test Case$/ }).click();
  await page.getByPlaceholder('e.g. Verify login with valid credentials').fill(`Added ${id}`);
  await page.getByRole('button', { name: /^(Save|Add)( Test Case)?$/ }).last().click();
  await expect(page.getByText(`Added ${id}`).first()).toBeVisible();

  await page.getByRole('row', { name: new RegExp(`Added ${id}`) }).getByTitle('Delete').click();
  const dialog = page.getByText('Confirm Delete').locator('xpath=ancestor::div[.//button][1]');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText(`Added ${id}`)).toHaveCount(0);

  await page.goto('/generated-tests');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTitle('Export CSV').first().click()]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
});

test('automation scripts: list and open a script', async ({ page }) => {
  await page.goto('/automation-scripts');
  await expect(page.getByText(/\.spec\.ts/).first()).toBeVisible({ timeout: 15_000 });
  await page.getByTitle('View/Edit').first().click();
  const code = page.locator('pre code').first();
  await expect(code).toContainText('setContent');
  const text = await code.innerText();
  if (BASELINE) {
    test.info().annotations.push({ type: 'baseline', description: 'Code colouring leaked markup on the approved build (fixed since)' });
  } else {
    expect(text, 'no colouring markup inside the code').not.toMatch(/font-semibold|text-emerald|text-purple/);
  }
});

test('reports: the executed suite is listed', async ({ page }) => {
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Reports' }).first()).toBeVisible();
  await expect(page.getByText(/Regression|Requirements|Manual|Suite/).first()).toBeVisible({ timeout: 15_000 });
});

test('user management: create a user and find it', async ({ page }) => {
  const username = `reg.user.${Date.now().toString(36)}`;
  await page.goto('/user-management');
  await page.getByRole('button', { name: /Add User|New User|Create User/ }).first().click();
  await page.getByPlaceholder('Enter username').fill(username);
  await page.getByPlaceholder('Enter full name').fill('Regression User');
  await page.getByPlaceholder('Enter email').fill(`${username}@example.test`);
  await page.getByPlaceholder('Enter password', { exact: true }).fill('Regression-Pass-1');
  await page.getByPlaceholder('Re-enter password').fill('Regression-Pass-1');
  await page.getByRole('button', { name: /^(Create|Save|Add)( User)?$/ }).last().click();
  await page.getByPlaceholder(/Search by username/).fill(username);
  await expect(page.getByText(username).first()).toBeVisible({ timeout: 15_000 });
});

test('feature toggles: the page loads its toggles', async ({ page }) => {
  await page.goto('/feature-toggles');
  await expect(page.getByRole('switch').or(page.locator('input[type="checkbox"]')).first()).toBeVisible({ timeout: 15_000 });
});

test('system configuration: every section opens', async ({ page }) => {
  await page.goto('/system-configuration');
  const sections = ['General Settings', 'Application Setup', 'Requirement Sources', 'Data Sources', 'Git Repositories', 'Notifications', 'AI & Healer Agent', 'Voice Assistant'];
  for (const name of sections) {
    const item = page.getByText(name, { exact: true }).first();
    if (!(await item.isVisible().catch(() => false))) continue;
    await item.click();
    await expect(page.getByText(/something went wrong|failed to load/i)).toHaveCount(0);
  }
  await page.getByText('Application Setup', { exact: true }).first().click();
  await expect(page.getByText('Regression Shop').first()).toBeVisible();
});
