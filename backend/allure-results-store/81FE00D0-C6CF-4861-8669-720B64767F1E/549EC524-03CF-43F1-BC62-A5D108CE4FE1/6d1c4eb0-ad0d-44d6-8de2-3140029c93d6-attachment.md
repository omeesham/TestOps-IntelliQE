# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-002-invalid-credentials-error.spec.ts >> TC-002 - Login fails with valid username and wrong password >> shows 'Invalid credentials' and keeps the user on the login page
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-549EC524-03CF-43F1-BC62-A5D108CE4FE1-1782478690838\tests\tc-002-invalid-credentials-error.spec.ts:58:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('alert').filter({ hasText: 'Invalid credentials' })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('alert').filter({ hasText: 'Invalid credentials' })
    - waiting for" https://opensource-demo.orangehrmlive.com/web/index.php/auth/validate" navigation to finish...

```

# Test source

```ts
  1  | import { test, expect, type Page, type Locator } from '@playwright/test';
  2  | 
  3  | const LOGIN_URL = 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login';
  4  | 
  5  | class LoginPage {
  6  |   readonly page: Page;
  7  |   readonly usernameInput: Locator;
  8  |   readonly passwordInput: Locator;
  9  |   readonly loginButton: Locator;
  10 |   readonly errorBanner: Locator;
  11 | 
  12 |   constructor(page: Page) {
  13 |     this.page = page;
  14 |     this.usernameInput = page.getByPlaceholder('Username');
  15 |     this.passwordInput = page.getByPlaceholder('Password');
  16 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  17 |     // The credential error is rendered inside an alert region.
  18 |     this.errorBanner = page.getByRole('alert').filter({ hasText: 'Invalid credentials' });
  19 |   }
  20 | 
  21 |   async goto(): Promise<void> {
  22 |     await this.page.goto(LOGIN_URL);
  23 |   }
  24 | 
  25 |   async expectLoginFormDisplayed(): Promise<void> {
  26 |     await expect(this.usernameInput).toBeVisible();
  27 |     await expect(this.passwordInput).toBeVisible();
  28 |     await expect(this.loginButton).toBeVisible();
  29 |   }
  30 | 
  31 |   async fillUsername(username: string): Promise<void> {
  32 |     await this.usernameInput.fill(username);
  33 |     await expect(this.usernameInput).toHaveValue(username);
  34 |   }
  35 | 
  36 |   async fillPassword(password: string): Promise<void> {
  37 |     await this.passwordInput.fill(password);
  38 |     await expect(this.passwordInput).toHaveValue(password);
  39 |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  40 |   }
  41 | 
  42 |   async submit(): Promise<void> {
  43 |     await this.loginButton.click();
  44 |   }
  45 | 
  46 |   async expectInvalidCredentialsError(): Promise<void> {
> 47 |     await expect(this.errorBanner).toBeVisible();
     |                                    ^ Error: expect(locator).toBeVisible() failed
  48 |     await expect(this.errorBanner).toHaveText('Invalid credentials');
  49 |   }
  50 | 
  51 |   async expectStillOnLoginPage(): Promise<void> {
  52 |     await expect(this.page).toHaveURL(/\/auth\/login/);
  53 |     await expect(this.loginButton).toBeVisible();
  54 |   }
  55 | }
  56 | 
  57 | test.describe('TC-002 - Login fails with valid username and wrong password', () => {
  58 |   test("shows 'Invalid credentials' and keeps the user on the login page", async ({ page }) => {
  59 |     const loginPage = new LoginPage(page);
  60 | 
  61 |     // Step 1: Navigate to the login page.
  62 |     await loginPage.goto();
  63 |     await loginPage.expectLoginFormDisplayed();
  64 | 
  65 |     // Step 2 & 3: Enter a valid username with a wrong password.
  66 |     await loginPage.fillUsername('Admin');
  67 |     await loginPage.fillPassword('Invalid123');
  68 | 
  69 |     // Step 4: Submit and verify the error banner.
  70 |     await loginPage.submit();
  71 |     await loginPage.expectInvalidCredentialsError();
  72 | 
  73 |     // Step 5: Verify no redirect occurred.
  74 |     await loginPage.expectStillOnLoginPage();
  75 |   });
  76 | });
  77 | 
```