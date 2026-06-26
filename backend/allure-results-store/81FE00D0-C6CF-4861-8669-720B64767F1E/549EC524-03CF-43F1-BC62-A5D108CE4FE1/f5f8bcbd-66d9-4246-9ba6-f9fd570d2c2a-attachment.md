# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-006-enter-key-submission.spec.ts >> TC-006 - Enter key submission >> Verify pressing Enter with valid credentials submits login identically to button click
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-549EC524-03CF-43F1-BC62-A5D108CE4FE1-1782478690838\tests\tc-006-enter-key-submission.spec.ts:73:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByPlaceholder('Username')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByPlaceholder('Username')

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
  10 | 
  11 |   constructor(page: Page) {
  12 |     this.page = page;
  13 |     this.usernameInput = page.getByPlaceholder('Username');
  14 |     this.passwordInput = page.getByPlaceholder('Password');
  15 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  16 |   }
  17 | 
  18 |   async goto(): Promise<void> {
  19 |     await this.page.goto(LOGIN_URL);
  20 |     await this.expectLoginFormVisible();
  21 |   }
  22 | 
  23 |   async expectLoginFormVisible(): Promise<void> {
> 24 |     await expect(this.usernameInput).toBeVisible();
     |                                      ^ Error: expect(locator).toBeVisible() failed
  25 |     await expect(this.passwordInput).toBeVisible();
  26 |     await expect(this.loginButton).toBeVisible();
  27 |   }
  28 | 
  29 |   async enterCredentials(username: string, password: string): Promise<void> {
  30 |     await this.usernameInput.fill(username);
  31 |     await this.passwordInput.fill(password);
  32 |   }
  33 | 
  34 |   async expectCredentialsEntered(username: string, password: string): Promise<void> {
  35 |     await expect(this.usernameInput).toHaveValue(username);
  36 |     await expect(this.passwordInput).toHaveValue(password);
  37 |     // Password remains masked while populated.
  38 |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  39 |   }
  40 | 
  41 |   /** Submit by pressing Enter while focus is in the password field (no button click). */
  42 |   async submitWithEnterFromPassword(): Promise<void> {
  43 |     await this.passwordInput.focus();
  44 |     await this.passwordInput.press('Enter');
  45 |   }
  46 | }
  47 | 
  48 | class DashboardPage {
  49 |   readonly page: Page;
  50 |   readonly heading: Locator;
  51 | 
  52 |   constructor(page: Page) {
  53 |     this.page = page;
  54 |     this.heading = page.getByRole('heading', { name: 'Dashboard' });
  55 |   }
  56 | 
  57 |   async expectLoaded(): Promise<void> {
  58 |     await expect(this.page).toHaveURL(/\/dashboard\/index/, { timeout: 3000 });
  59 |     await expect(this.heading).toBeVisible({ timeout: 3000 });
  60 |   }
  61 | }
  62 | 
  63 | test.describe('TC-006 - Enter key submission', () => {
  64 |   let loginPage: LoginPage;
  65 |   let dashboardPage: DashboardPage;
  66 | 
  67 |   test.beforeEach(async ({ page }) => {
  68 |     loginPage = new LoginPage(page);
  69 |     dashboardPage = new DashboardPage(page);
  70 |     await loginPage.goto();
  71 |   });
  72 | 
  73 |   test('Verify pressing Enter with valid credentials submits login identically to button click', async () => {
  74 |     const username = 'Admin';
  75 |     const password = 'admin123';
  76 | 
  77 |     // Step 1: Login form is displayed (asserted in goto()).
  78 |     await loginPage.expectLoginFormVisible();
  79 | 
  80 |     // Step 2: Enter username and masked password.
  81 |     await loginPage.enterCredentials(username, password);
  82 |     await loginPage.expectCredentialsEntered(username, password);
  83 | 
  84 |     // Step 3: Press Enter from the password field (no Login click) and land on Dashboard < 3s.
  85 |     await loginPage.submitWithEnterFromPassword();
  86 |     await dashboardPage.expectLoaded();
  87 |   });
  88 | });
  89 | 
```