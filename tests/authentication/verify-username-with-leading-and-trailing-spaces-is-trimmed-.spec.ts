import { OrangeHRMPage } from '../../src/pages/orange-hrm/orange-hrm.page';
import { test, expect } from '@playwright/test';

test.describe('Field Validation', () => {
  test('Verify username with leading and trailing spaces is trimmed before authentication', async ({ page }) => {
    const login = new OrangeHRMPage(page);

    // 1. Navigate to the login page
    // 2. Enter '  Admin  ' (with two leading and two trailing spaces) into the Username field
    // 3. Enter 'admin123' into the Password field
    // 4. Click the 'Login' button — the app must trim the username and authenticate,
    //    landing on the Dashboard.
    await login.loginExpectingTrim('  Admin  ', 'admin123');
  });
});