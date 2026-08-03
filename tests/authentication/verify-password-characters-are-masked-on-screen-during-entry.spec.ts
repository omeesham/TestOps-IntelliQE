import { test, expect } from '@playwright/test';

// Generated LIVE against the running application — every locator below was
// executed and verified in a real browser at generation time.
test("Verify password characters are masked on screen during entry", async ({ page }) => {
  await page.goto("/web/index.php/auth/login");
  await page.getByPlaceholder("Password").fill("admin123");
  await expect(page.locator("input[name=\"password\"][type=\"password\"]")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("input[name=\"password\"][type=\"password\"]")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("input[name=\"password\"][type=\"password\"]")).toBeVisible({ timeout: 15000 });
});
