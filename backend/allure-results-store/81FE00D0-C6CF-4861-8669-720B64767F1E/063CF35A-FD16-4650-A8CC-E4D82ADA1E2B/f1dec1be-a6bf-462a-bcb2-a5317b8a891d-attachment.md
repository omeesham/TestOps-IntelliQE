# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-009-forgot-password-navigation.spec.ts >> TC-009 - Forgot Password Navigation >> clicking "Forgot your password?" navigates to Password Reset page in the same tab
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-063CF35A-FD16-4650-A8CC-E4D82ADA1E2B-1782737385916\tests\tc-009-forgot-password-navigation.spec.ts:64:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByAltText('company-branding')
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for getByAltText('company-branding')

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e6]:
    - heading "Reset Password" [level=6] [ref=e7]
    - separator [ref=e8]
    - paragraph [ref=e9]:
      - paragraph [ref=e10]: Please enter your username to identify your account to reset your password
    - generic [ref=e12]:
      - generic [ref=e13]:
        - generic [ref=e14]: 
        - generic [ref=e15]: Username
      - textbox "Username" [ref=e17]
    - separator [ref=e18]
    - generic [ref=e19]:
      - button "Cancel" [ref=e20] [cursor=pointer]
      - button "Reset Password" [ref=e21] [cursor=pointer]
  - generic [ref=e22]:
    - paragraph [ref=e23]: OrangeHRM OS 5.8
    - paragraph [ref=e24]:
      - text: © 2005 - 2026
      - link "OrangeHRM, Inc" [ref=e25] [cursor=pointer]:
        - /url: http://www.orangehrm.com
      - text: . All rights reserved.
```

# Test source

```ts
  1  | import { test, expect, type Page, type Locator } from '@playwright/test';
  2  | 
  3  | const LOGIN_URL = 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login';
  4  | const RESET_URL_FRAGMENT = '/web/index.php/auth/requestPasswordResetCode';
  5  | 
  6  | class LoginPage {
  7  |   readonly page: Page;
  8  |   readonly usernameInput: Locator;
  9  |   readonly passwordInput: Locator;
  10 |   readonly loginButton: Locator;
  11 |   readonly forgotPasswordLink: Locator;
  12 |   readonly brandingLogo: Locator;
  13 | 
  14 |   constructor(page: Page) {
  15 |     this.page = page;
  16 |     this.usernameInput = page.getByPlaceholder('Username');
  17 |     this.passwordInput = page.getByPlaceholder('Password');
  18 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  19 |     this.forgotPasswordLink = page.getByText('Forgot your password?');
  20 |     this.brandingLogo = page.getByAltText('company-branding');
  21 |   }
  22 | 
  23 |   async goto() {
  24 |     await this.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  25 |   }
  26 | 
  27 |   async expectLoaded() {
  28 |     await expect(this.usernameInput).toBeVisible();
  29 |     await expect(this.forgotPasswordLink).toBeVisible();
  30 |   }
  31 | 
  32 |   async clickForgotPassword() {
  33 |     await this.forgotPasswordLink.click();
  34 |   }
  35 | }
  36 | 
  37 | class PasswordResetPage {
  38 |   readonly page: Page;
  39 |   readonly usernameInput: Locator;
  40 |   readonly resetButton: Locator;
  41 |   readonly cancelButton: Locator;
  42 |   readonly heading: Locator;
  43 |   readonly brandingLogo: Locator;
  44 | 
  45 |   constructor(page: Page) {
  46 |     this.page = page;
  47 |     this.usernameInput = page.getByPlaceholder('Username');
  48 |     this.resetButton = page.getByRole('button', { name: 'Reset Password' });
  49 |     this.cancelButton = page.getByRole('button', { name: 'Cancel' });
  50 |     this.heading = page.getByRole('heading', { name: 'Reset Password' });
  51 |     this.brandingLogo = page.getByAltText('company-branding');
  52 |   }
  53 | 
  54 |   async expectOnResetPage() {
  55 |     await expect(this.page).toHaveURL(new RegExp(RESET_URL_FRAGMENT));
  56 |     await expect(this.heading).toBeVisible();
  57 |     await expect(this.usernameInput).toBeVisible();
  58 |     await expect(this.resetButton).toBeVisible();
> 59 |     await expect(this.brandingLogo).toBeVisible();
     |                                     ^ Error: expect(locator).toBeVisible() failed
  60 |   }
  61 | }
  62 | 
  63 | test.describe('TC-009 - Forgot Password Navigation', () => {
  64 |   test('clicking "Forgot your password?" navigates to Password Reset page in the same tab', async ({ page, context }) => {
  65 |     const loginPage = new LoginPage(page);
  66 | 
  67 |     // Step 1: Navigate to login page and verify it is fully rendered
  68 |     await loginPage.goto();
  69 |     await loginPage.expectLoaded();
  70 | 
  71 |     const tabsBeforeClick = context.pages().length;
  72 | 
  73 |     // Step 2: Click the 'Forgot your password?' link - no new tab/popup should open
  74 |     await loginPage.clickForgotPassword();
  75 |     expect(context.pages().length).toBe(tabsBeforeClick);
  76 | 
  77 |     // Step 3 & 4: Verify URL fragment and the reset page content / branding
  78 |     const resetPage = new PasswordResetPage(page);
  79 |     await resetPage.expectOnResetPage();
  80 |   });
  81 | });
  82 | 
```