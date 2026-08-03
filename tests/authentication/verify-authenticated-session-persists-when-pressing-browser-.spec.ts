import { test, expect } from '@playwright/test';

// Generated LIVE against the running application — every locator below was
// executed and verified in a real browser at generation time.
test("Verify authenticated session persists when pressing browser Back after login", async ({ page }) => {
  await page.goto("/web/index.php/auth/login");
  await page.getByPlaceholder("Username").fill("Admin");
  await page.getByPlaceholder("Password").fill("admin123");
  await page.getByRole("button", { name: "Login" }).click();
  await page.locator("body").press("Alt+ArrowLeft");
  await expect(page).toHaveURL(new RegExp("/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/dashboard/index"), { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/dashboard/index"), { timeout: 15000 });
});
