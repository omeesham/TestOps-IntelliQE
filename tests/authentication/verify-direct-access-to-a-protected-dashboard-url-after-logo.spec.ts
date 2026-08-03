import { test, expect } from '@playwright/test';

// Generated LIVE against the running application — every locator below was
// executed and verified in a real browser at generation time.
test("Verify direct access to a protected Dashboard URL after logout redirects to login", async ({ page }) => {
  await page.goto("/web/index.php/auth/login");
  await page.getByPlaceholder("Username").fill("");
  await page.getByPlaceholder("Username").fill("Admin");
  await page.getByPlaceholder("Password").fill("admin123");
  await page.getByRole("button", { name: "Login" }).click();
  await page.locator(".oxd-userdropdown-tab").click();
  await page.getByText("Logout", { exact: true }).click();
  await page.goto("/web/index.php/dashboard/index");
  await expect(page).toHaveURL(new RegExp("/auth/login"), { timeout: 15000 });
  await expect(page.getByRole("button", { name: "Login" })).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".oxd-topbar-header")).toBeHidden({ timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/auth/login"), { timeout: 15000 });
});
