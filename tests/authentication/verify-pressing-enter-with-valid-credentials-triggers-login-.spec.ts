import { test, expect } from '@playwright/test';

// Generated LIVE against the running application — every locator below was
// executed and verified in a real browser at generation time.
test("Verify pressing Enter with valid credentials triggers login equivalent to clicking Login", async ({ page }) => {
  await page.goto("/web/index.php/auth/login");
  await page.getByPlaceholder("Username").fill("Admin");
  await page.getByPlaceholder("Password").fill("admin123");
  await page.getByPlaceholder("Password").press("Enter");
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/dashboard/index"), { timeout: 15000 });
});
