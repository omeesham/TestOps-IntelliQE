# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-007-sql-injection-login.spec.ts >> TC-007 - SQL injection payload is rejected without leakage >> rejects SQL injection with generic Invalid credentials and no SQL leakage
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-657D1A26-6D61-4979-997A-886F86E9CD74-1782394362512\tests\tc-007-sql-injection-login.spec.ts:73:7

# Error details

```
TimeoutError: page.goto: Timeout 30000ms exceeded.
Call log:
  - navigating to "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login", waiting until "load"

```

# Test source

```ts
  1  | import { test, expect, type Page, type Locator } from '@playwright/test';
  2  | 
  3  | /**
  4  |  * Page Object for the OrangeHRM Login screen with credential entry and
  5  |  * error-message verification used for the SQL injection security check.
  6  |  */
  7  | class LoginPage {
  8  |   readonly page: Page;
  9  |   readonly usernameInput: Locator;
  10 |   readonly passwordInput: Locator;
  11 |   readonly loginButton: Locator;
  12 |   readonly invalidCredentialsAlert: Locator;
  13 | 
  14 |   constructor(page: Page) {
  15 |     this.page = page;
  16 |     this.usernameInput = page.getByPlaceholder('Username');
  17 |     this.passwordInput = page.getByPlaceholder('Password');
  18 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  19 |     this.invalidCredentialsAlert = page.getByRole('alert').filter({ hasText: 'Invalid credentials' });
  20 |   }
  21 | 
  22 |   async goto(): Promise<void> {
> 23 |     await this.page.goto('https://opensource-demo.orangehrmlive.com/web/index.php/auth/login');
     |                     ^ TimeoutError: page.goto: Timeout 30000ms exceeded.
  24 |   }
  25 | 
  26 |   async expectLoaded(): Promise<void> {
  27 |     await expect(this.usernameInput).toBeVisible();
  28 |     await expect(this.passwordInput).toBeVisible();
  29 |     await expect(this.loginButton).toBeVisible();
  30 |   }
  31 | 
  32 |   async enterUsername(value: string): Promise<void> {
  33 |     await this.usernameInput.fill(value);
  34 |     // Payload accepted as literal text input
  35 |     await expect(this.usernameInput).toHaveValue(value);
  36 |   }
  37 | 
  38 |   async enterPassword(value: string): Promise<void> {
  39 |     await this.passwordInput.fill(value);
  40 |     // Payload accepted as masked literal text input
  41 |     await expect(this.passwordInput).toHaveValue(value);
  42 |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  43 |   }
  44 | 
  45 |   async submit(): Promise<void> {
  46 |     await this.loginButton.click();
  47 |   }
  48 | 
  49 |   async expectRejectedOnLoginPage(): Promise<void> {
  50 |     // User remains on the login page; no authenticated redirect occurred.
  51 |     await expect(this.page).toHaveURL(/\/auth\/login/);
  52 |     await expect(this.loginButton).toBeVisible();
  53 |   }
  54 | 
  55 |   async expectInvalidCredentials(): Promise<void> {
  56 |     await expect(this.invalidCredentialsAlert).toBeVisible();
  57 |     await expect(this.invalidCredentialsAlert).toHaveText('Invalid credentials');
  58 |   }
  59 | 
  60 |   async expectNoSqlLeakage(): Promise<void> {
  61 |     // No raw SQL error, stack trace, or DB detail should be reflected anywhere on the page.
  62 |     const body = this.page.locator('body');
  63 |     await expect(body).not.toContainText('SQL', { ignoreCase: true });
  64 |     await expect(body).not.toContainText('syntax', { ignoreCase: true });
  65 |     await expect(body).not.toContainText('Exception', { ignoreCase: true });
  66 |     await expect(body).not.toContainText('stack trace', { ignoreCase: true });
  67 |   }
  68 | }
  69 | 
  70 | test.describe('TC-007 - SQL injection payload is rejected without leakage', () => {
  71 |   const INJECTION = "' OR '1'='1";
  72 | 
  73 |   test('rejects SQL injection with generic Invalid credentials and no SQL leakage', async ({ page }) => {
  74 |     const loginPage = new LoginPage(page);
  75 | 
  76 |     // Step 1: Login form is displayed
  77 |     await loginPage.goto();
  78 |     await loginPage.expectLoaded();
  79 | 
  80 |     // Step 2 & 3: Enter the injection payload in both fields (accepted as literal text)
  81 |     await loginPage.enterUsername(INJECTION);
  82 |     await loginPage.enterPassword(INJECTION);
  83 | 
  84 |     // Step 4: Submit; authentication is rejected and the user stays on the login page
  85 |     await loginPage.submit();
  86 |     await loginPage.expectRejectedOnLoginPage();
  87 | 
  88 |     // Step 5: Exact 'Invalid credentials' message; no SQL/stack/DB detail leaked
  89 |     await loginPage.expectInvalidCredentials();
  90 |     await loginPage.expectNoSqlLeakage();
  91 |   });
  92 | });
  93 | 
```