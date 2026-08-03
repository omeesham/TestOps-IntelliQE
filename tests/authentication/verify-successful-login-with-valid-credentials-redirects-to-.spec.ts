import { test, expect } from '@playwright/test';

// Generated LIVE against the running application — every locator below was
// executed and verified in a real browser at generation time.
test("Verify successful login with valid credentials redirects to Dashboard", async ({ page }) => {
  await page.goto("/web/index.php/auth/login");
  await page.getByPlaceholder("username").fill("Admin");
  await page.getByPlaceholder("password").fill("admin123");
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page).toHaveURL(new RegExp("/dashboard/index"), { timeout: 15000 });
  await expect(page.getByRole("heading", { name: "Dashboard" })).toContainText("Dashboard", { timeout: 15000 });
});
