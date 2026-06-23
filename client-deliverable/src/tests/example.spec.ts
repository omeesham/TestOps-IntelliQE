import { test, expect } from '@playwright/test';

/**
 * Placeholder smoke test.
 * Real generated `.spec.ts` files are exported into this folder by the delivery
 * pipeline. This file proves the Playwright configuration works end-to-end on
 * any machine with only `BASE_URL` set in `.env`.
 */
test.describe('Smoke', () => {
  test('base URL responds', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/.*/);
  });
});
