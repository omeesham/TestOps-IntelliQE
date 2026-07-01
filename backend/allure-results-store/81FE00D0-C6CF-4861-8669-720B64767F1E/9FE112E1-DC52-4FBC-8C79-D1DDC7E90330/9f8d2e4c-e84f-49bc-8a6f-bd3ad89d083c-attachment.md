# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-008-forgot-password-navigation.spec.ts >> TC-008 - Forgot Password Navigation >> Verify clicking the Forgot your password link navigates to the Password Reset page without error
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-9FE112E1-DC52-4FBC-8C79-D1DDC7E90330-1782493959599\tests\tc-008-forgot-password-navigation.spec.ts:45:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('link', { name: 'Forgot your password?' })
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for getByRole('link', { name: 'Forgot your password?' })

```

# Page snapshot

```yaml
- generic [ref=e4]:
  - generic [ref=e6]:
    - img "company-branding" [ref=e8]
    - generic [ref=e9]:
      - heading "Login" [level=5] [ref=e10]
      - generic [ref=e11]:
        - generic [ref=e13]:
          - paragraph [ref=e14]: "Username : Admin"
          - paragraph [ref=e15]: "Password : admin123"
        - generic [ref=e16]:
          - generic [ref=e18]:
            - generic [ref=e19]:
              - generic [ref=e20]: 
              - generic [ref=e21]: Username
            - textbox "Username" [active] [ref=e23]
          - generic [ref=e25]:
            - generic [ref=e26]:
              - generic [ref=e27]: 
              - generic [ref=e28]: Password
            - textbox "Password" [ref=e30]
          - button "Login" [ref=e32] [cursor=pointer]
          - paragraph [ref=e34] [cursor=pointer]: Forgot your password?
      - generic [ref=e35]:
        - generic [ref=e36]:
          - link [ref=e37] [cursor=pointer]:
            - /url: https://www.linkedin.com/company/orangehrm/mycompany/
          - link [ref=e40] [cursor=pointer]:
            - /url: https://www.facebook.com/OrangeHRM/
          - link [ref=e43] [cursor=pointer]:
            - /url: https://twitter.com/orangehrm?lang=en
          - link [ref=e46] [cursor=pointer]:
            - /url: https://www.youtube.com/c/OrangeHRMInc
        - generic [ref=e49]:
          - paragraph [ref=e50]: OrangeHRM OS 5.8
          - paragraph [ref=e51]:
            - text: © 2005 - 2026
            - link "OrangeHRM, Inc" [ref=e52] [cursor=pointer]:
              - /url: http://www.orangehrm.com
            - text: . All rights reserved.
  - img "orangehrm-logo" [ref=e54]
```

# Test source

```ts
  1  | import { test, expect, type Page, type Locator } from '@playwright/test';
  2  | 
  3  | class LoginPage {
  4  |   readonly page: Page;
  5  |   readonly forgotPasswordLink: Locator;
  6  | 
  7  |   constructor(page: Page) {
  8  |     this.page = page;
  9  |     this.forgotPasswordLink = page.getByRole('link', { name: 'Forgot your password?' });
  10 |   }
  11 | 
  12 |   async goto() {
  13 |     await this.page.goto('https://opensource-demo.orangehrmlive.com/web/index.php/auth/login');
  14 |   }
  15 | 
  16 |   async clickForgotPassword() {
  17 |     await this.forgotPasswordLink.click();
  18 |   }
  19 | }
  20 | 
  21 | class PasswordResetPage {
  22 |   readonly page: Page;
  23 |   readonly pageHeading: Locator;
  24 |   readonly resetButton: Locator;
  25 | 
  26 |   constructor(page: Page) {
  27 |     this.page = page;
  28 |     // OrangeHRM password reset page heading
  29 |     this.pageHeading = page.getByRole('heading', { name: 'Reset Password' });
  30 |     this.resetButton = page.getByRole('button', { name: 'Reset Password' });
  31 |   }
  32 | 
  33 |   async expectUrlContainsResetPath() {
  34 |     await expect(this.page).toHaveURL(new RegExp('requestPasswordResetCode'));
  35 |   }
  36 | 
  37 |   async expectRenderedWithoutError() {
  38 |     // Heading visible confirms a 200-level response with content — not a 404/403/500 error page
  39 |     await expect(this.pageHeading).toBeVisible();
  40 |     await expect(this.resetButton).toBeVisible();
  41 |   }
  42 | }
  43 | 
  44 | test.describe('TC-008 - Forgot Password Navigation', () => {
  45 |   test(
  46 |     'Verify clicking the Forgot your password link navigates to the Password Reset page without error',
  47 |     async ({ page }) => {
  48 |       const loginPage = new LoginPage(page);
  49 |       const resetPage = new PasswordResetPage(page);
  50 | 
  51 |       // Step 1: Navigate to login page; link must be visible before interaction
  52 |       await loginPage.goto();
> 53 |       await expect(loginPage.forgotPasswordLink).toBeVisible();
     |                                                  ^ Error: expect(locator).toBeVisible() failed
  54 | 
  55 |       // Steps 2 & 3: Click the link and confirm navigation to the reset path
  56 |       await loginPage.clickForgotPassword();
  57 |       await resetPage.expectUrlContainsResetPath();
  58 | 
  59 |       // Step 4: Destination page renders the reset form without any HTTP error
  60 |       await resetPage.expectRenderedWithoutError();
  61 |     }
  62 |   );
  63 | });
```