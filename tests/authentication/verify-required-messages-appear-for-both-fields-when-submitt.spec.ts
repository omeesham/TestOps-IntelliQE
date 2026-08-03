import { test, expect } from '@playwright/test';

// Generated LIVE against the running application — every locator below was
// executed and verified in a real browser at generation time.
test("Verify 'Required' messages appear for both fields when submitting an empty form", async ({ page }) => {
  await page.goto("/web/index.php/auth/login");
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByText("Required", { exact: true }).nth(0)).toContainText("", { timeout: 15000 });
  await expect(page.getByText("Required", { exact: true }).nth(1)).toContainText("Required", { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("https://opensource-demo\\.orangehrmlive\\.com/web/index\\.php/auth/login"), { timeout: 15000 });
});
