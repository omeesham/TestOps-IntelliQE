import { test, expect } from '@playwright/test';

// Generated LIVE against the running application — every locator below was
// executed and verified in a real browser at generation time.
test("Verify SQL/script injection strings in the Username field are sanitized and rejected", async ({ page }) => {
  await page.goto("/web/index.php/auth/login");
  await page.getByPlaceholder("username").fill("' OR '1'='1");
  await page.getByPlaceholder("password").fill("<script>alert(1)</script>");
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByText("Invalid credentials")).toContainText("", { timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/web/index\\.php/auth/login"), { timeout: 15000 });
  await expect(page.getByText("Invalid credentials")).toContainText("Invalid credentials", { timeout: 15000 });
});
