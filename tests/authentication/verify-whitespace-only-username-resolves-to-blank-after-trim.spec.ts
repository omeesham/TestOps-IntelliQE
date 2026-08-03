import { test, expect } from '@playwright/test';

// Generated LIVE against the running application — every locator below was
// executed and verified in a real browser at generation time.
test("Verify whitespace-only username resolves to blank after trim and displays 'Required'", async ({ page }) => {
  await page.goto("/web/index.php/auth/login");
  await page.getByPlaceholder("username").fill("     ");
  await page.getByPlaceholder("password").fill("admin123");
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByText("Required")).toContainText("", { timeout: 15000 });
  await expect(page.getByText("Required", { exact: true })).toContainText("Required", { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/auth/login"), { timeout: 15000 });
});
