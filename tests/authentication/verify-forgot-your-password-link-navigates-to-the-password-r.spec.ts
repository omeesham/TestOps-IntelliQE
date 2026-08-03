import { test, expect } from '@playwright/test';

// Generated LIVE against the running application — every locator below was
// executed and verified in a real browser at generation time.
test("Verify 'Forgot your password?' link navigates to the Password Reset page", async ({ page }) => {
  await page.goto("/web/index.php/auth/login");
  await expect(page.getByText("Forgot Your Password?")).toBeVisible({ timeout: 15000 });
  await page.getByText("Forgot Your Password?").click();
  await expect(page).toHaveURL(new RegExp("/requestPasswordResetCode"), { timeout: 15000 });
  await expect(page.getByRole("button", { name: "Reset Password" })).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(new RegExp("/requestPasswordResetCode"), { timeout: 15000 });
});
