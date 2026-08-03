import { test, expect } from '@playwright/test';

// Generated LIVE against the running application — every locator below was
// executed and verified in a real browser at generation time.
test("Verify login fails with invalid username and valid password", async ({ page }) => {
  await page.goto("/web/index.php/auth/login");
  await page.getByPlaceholder("Username").fill("NotARealUser");
  await page.getByPlaceholder("Password").fill("admin123");
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByText("Invalid credentials")).toContainText("Invalid credentials", { timeout: 15000 });
  await expect(page.getByText("Invalid credentials")).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/auth/login"), { timeout: 15000 });
  await expect(page.getByText("Invalid credentials")).toContainText("Invalid credentials", { timeout: 15000 });
  await expect(page.getByText("Invalid credentials")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Invalid credentials")).toContainText("Invalid credentials", { timeout: 15000 });
  await expect(page.getByText("Invalid credentials")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Invalid credentials")).toContainText("Invalid credentials", { timeout: 15000 });
  await expect(page.getByText("Invalid credentials")).toContainText("Invalid credentials", { timeout: 15000 });
});
