# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-001-login-page-ui-elements.spec.ts >> TC-001 - Login Page Display >> Verify login page renders all mandatory UI elements within 2 seconds of initial navigation
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-9FE112E1-DC52-4FBC-8C79-D1DDC7E90330-1782493959599\tests\tc-001-login-page-ui-elements.spec.ts:53:7

# Error details

```
Error: Page load must complete within 2 seconds

expect(received).toBeLessThanOrEqual(expected)

Expected: <= 2000
Received:    4059
```

# Test source

```ts
  1  | import { test, expect, type Page, type Locator } from '@playwright/test';
  2  | 
  3  | class LoginPage {
  4  |   readonly page: Page;
  5  |   readonly logo: Locator;
  6  |   readonly usernameInput: Locator;
  7  |   readonly passwordInput: Locator;
  8  |   readonly loginButton: Locator;
  9  |   readonly forgotPasswordLink: Locator;
  10 | 
  11 |   constructor(page: Page) {
  12 |     this.page = page;
  13 |     // Brand logo has no semantic role or accessible label; CSS scoped to the login-branding container is the only reliable alternative
  14 |     this.logo = page.locator('.orangehrm-login-branding img');
  15 |     this.usernameInput = page.getByPlaceholder('Username');
  16 |     this.passwordInput = page.getByPlaceholder('Password');
  17 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  18 |     this.forgotPasswordLink = page.getByRole('link', { name: 'Forgot your password?' });
  19 |   }
  20 | 
  21 |   async goto(): Promise<void> {
  22 |     await this.page.goto('https://opensource-demo.orangehrmlive.com/web/index.php/auth/login');
  23 |   }
  24 | 
  25 |   async expectLogoVisible(): Promise<void> {
  26 |     await expect(this.logo).toBeVisible();
  27 |   }
  28 | 
  29 |   async expectUsernameFieldReady(): Promise<void> {
  30 |     await expect(this.usernameInput).toBeVisible();
  31 |     await expect(this.usernameInput).toBeEnabled();
  32 |     await this.usernameInput.focus();
  33 |     await expect(this.usernameInput).toBeFocused();
  34 |   }
  35 | 
  36 |   async expectPasswordFieldMasked(): Promise<void> {
  37 |     await expect(this.passwordInput).toBeVisible();
  38 |     await expect(this.passwordInput).toBeEnabled();
  39 |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  40 |   }
  41 | 
  42 |   async expectLoginButtonReady(): Promise<void> {
  43 |     await expect(this.loginButton).toBeVisible();
  44 |     await expect(this.loginButton).toBeEnabled();
  45 |   }
  46 | 
  47 |   async expectForgotPasswordLinkVisible(): Promise<void> {
  48 |     await expect(this.forgotPasswordLink).toBeVisible();
  49 |   }
  50 | }
  51 | 
  52 | test.describe('TC-001 - Login Page Display', () => {
  53 |   test('Verify login page renders all mandatory UI elements within 2 seconds of initial navigation', async ({ page }) => {
  54 |     const loginPage = new LoginPage(page);
  55 | 
  56 |     const navigationStart = Date.now();
  57 |     await loginPage.goto();
  58 |     const navigationDuration = Date.now() - navigationStart;
  59 | 
> 60 |     expect(navigationDuration, 'Page load must complete within 2 seconds').toBeLessThanOrEqual(2000);
     |                                                                            ^ Error: Page load must complete within 2 seconds
  61 |     await expect(page).toHaveTitle(/OrangeHRM/i);
  62 | 
  63 |     await loginPage.expectLogoVisible();
  64 |     await loginPage.expectUsernameFieldReady();
  65 |     await loginPage.expectPasswordFieldMasked();
  66 |     await loginPage.expectLoginButtonReady();
  67 |     await loginPage.expectForgotPasswordLinkVisible();
  68 |   });
  69 | });
  70 | 
```