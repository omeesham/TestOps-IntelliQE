/**
 * IntelliQE POC base smoke suite: proves the deployment is up, sign-in works,
 * and the client-facing scope is right (Web on; API and Mobile "Coming Soon";
 * no ADA; Agent Monitor hidden).
 *
 * Production allows 5 sign-in attempts per minute, so the suite signs in only
 * twice (one invalid, one valid) and runs the signed-in checks in one session.
 */
import { test, expect, type Page } from '@playwright/test';

const USER = process.env.SMOKE_USER || '';
const PASSWORD = process.env.SMOKE_PASSWORD || '';

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.locator('input[type="text"], input[name="username"]').first().fill(username);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').first().click();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (!USER || !PASSWORD) throw new Error('Set SMOKE_USER and SMOKE_PASSWORD (an admin account of this deployment).');
});

test('backend health endpoint returns 200', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect((await res.json()).status).toBe('ok');
});

test('public sign-up is closed', async ({ request }) => {
  const res = await request.post('/api/auth/signup', {
    data: { username: `smoke-${Date.now()}`, password: 'Smoke-Pass-123', role: 'admin' },
  });
  expect(res.status()).toBe(403);
});

test('invalid sign-in shows an error and stays on the login page', async ({ page }) => {
  await signIn(page, USER, 'definitely-not-the-password');
  await expect(page.getByText(/invalid credentials/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('signed-in admin: Chat, scope, menu and Reports', async ({ page }) => {
  await test.step('valid sign-in reaches Chat', async () => {
    await signIn(page, USER, PASSWORD);
    await expect(page).toHaveURL(/\/chat/, { timeout: 20_000 });
  });

  await test.step('Web Automation enabled; API and Mobile "Coming Soon"', async () => {
    const web = page.getByRole('button', { name: /Web Application Automation/ });
    const api = page.getByRole('button', { name: /API Automation/ });
    const mobile = page.getByRole('button', { name: /Mobile Application Automation/ });
    await expect(web).toBeEnabled();
    await expect(api).toBeDisabled();
    await expect(api).toContainText(/Coming Soon/i);
    await expect(mobile).toBeDisabled();
    await expect(mobile).toContainText(/Coming Soon/i);
  });

  const sidebar = page.locator('aside, nav').first();

  await test.step('sidebar shows the main menu; no ADA / Web Lab; Agent Monitor hidden', async () => {
    for (const item of ['Chat', 'Generated Test Cases', 'Reports', 'User Management', 'System Configuration']) {
      await expect(sidebar).toContainText(item);
    }
    await expect(sidebar).not.toContainText(/Web Lab|\bADA\b|Accessibility/i);
    await expect(sidebar).not.toContainText('Agent Monitor');
  });

  await test.step('Reports page loads', async () => {
    await sidebar.getByText('Reports', { exact: true }).click();
    await expect(page).toHaveURL(/\/reports/);
    await expect(page.locator('main')).toBeVisible();
  });

  await test.step('direct URLs: /web-lab does not exist, /agents is blocked', async () => {
    await page.goto('/web-lab');
    await expect(page).not.toHaveURL(/\/web-lab/);
    await page.goto('/agents');
    await expect(page).not.toHaveURL(/\/agents$/);
  });
});
