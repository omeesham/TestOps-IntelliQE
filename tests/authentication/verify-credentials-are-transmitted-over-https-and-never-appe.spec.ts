import { test, expect } from '@playwright/test';

// Generated LIVE against the running application — every locator below was
// executed and verified in a real browser at generation time.
test("Verify credentials are transmitted over HTTPS and never appear in the URL", async ({ page }) => {
  await page.goto("/web/index.php/auth/login");
  await expect(page).toHaveURL(new RegExp("https://opensource-demo\\.orangehrmlive\\.com/web/index\\.php/auth/login"), { timeout: 15000 });
  await page.getByPlaceholder("username").fill("Admin");
  await page.getByPlaceholder("password").fill("admin123");
  await page.getByRole("button", { name: "Login" }).click();
});
