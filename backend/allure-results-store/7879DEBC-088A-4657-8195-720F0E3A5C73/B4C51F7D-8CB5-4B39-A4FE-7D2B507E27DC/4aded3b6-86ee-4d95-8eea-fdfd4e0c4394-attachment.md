# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-009-sql-injection-login.spec.ts >> TC-009 - SQL injection payload fails authentication via parameterized queries >> rejects SQL injection in credentials with a generic error and no DB leakage
- Location: ..\..\..\Users\VAMSEE~1\AppData\Local\Temp\jbs-pwexec-B4C51F7D-8CB5-4B39-A4FE-7D2B507E27DC-1782466340014\tests\tc-009-sql-injection-login.spec.ts:66:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Invalid credentials')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByText('Invalid credentials')
    - waiting for" https://opensource-demo.orangehrmlive.com/web/index.php/auth/validate" navigation to finish...
    - navigated to "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"

```

# Test source

```ts
  1   | import { test, expect, type Page, type Locator } from '@playwright/test';
  2   | 
  3   | const LOGIN_URL = 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login';
  4   | 
  5   | /**
  6   |  * Page Object for the OrangeHRM login screen.
  7   |  * All locators are declared once as readonly fields and initialised in the constructor.
  8   |  */
  9   | class LoginPage {
  10  |   readonly page: Page;
  11  |   readonly usernameInput: Locator;
  12  |   readonly passwordInput: Locator;
  13  |   readonly loginButton: Locator;
  14  |   readonly invalidCredentialsAlert: Locator;
  15  | 
  16  |   constructor(page: Page) {
  17  |     this.page = page;
  18  |     this.usernameInput = page.getByPlaceholder('Username');
  19  |     this.passwordInput = page.getByPlaceholder('Password');
  20  |     this.loginButton = page.getByRole('button', { name: 'Login' });
  21  |     this.invalidCredentialsAlert = page.getByText('Invalid credentials');
  22  |   }
  23  | 
  24  |   async goto(): Promise<void> {
  25  |     await this.page.goto(LOGIN_URL);
  26  |   }
  27  | 
  28  |   async expectLoginFormVisible(): Promise<void> {
  29  |     await expect(this.usernameInput).toBeVisible();
  30  |     await expect(this.passwordInput).toBeVisible();
  31  |     await expect(this.loginButton).toBeEnabled();
  32  |   }
  33  | 
  34  |   async enterUsername(username: string): Promise<void> {
  35  |     await this.usernameInput.fill(username);
  36  |     // Payload must be accepted verbatim as literal text.
  37  |     await expect(this.usernameInput).toHaveValue(username);
  38  |   }
  39  | 
  40  |   async enterPassword(password: string): Promise<void> {
  41  |     await this.passwordInput.fill(password);
  42  |   }
  43  | 
  44  |   async expectPasswordMasked(): Promise<void> {
  45  |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  46  |   }
  47  | 
  48  |   async submit(): Promise<void> {
  49  |     await this.loginButton.click();
  50  |   }
  51  | 
  52  |   async expectInvalidCredentials(): Promise<void> {
> 53  |     await expect(this.invalidCredentialsAlert).toBeVisible();
      |                                                ^ Error: expect(locator).toBeVisible() failed
  54  |   }
  55  | 
  56  |   async expectStillOnLogin(): Promise<void> {
  57  |     await expect(this.page).toHaveURL(/\/auth\/login/);
  58  |   }
  59  | 
  60  |   async expectNoSqlErrorLeak(): Promise<void> {
  61  |     await expect(this.page.getByText(/SQL|syntax error|stack trace|exception|ORA-|SQLSTATE/i)).toHaveCount(0);
  62  |   }
  63  | }
  64  | 
  65  | test.describe('TC-009 - SQL injection payload fails authentication via parameterized queries', () => {
  66  |   test('rejects SQL injection in credentials with a generic error and no DB leakage', async ({ page }) => {
  67  |     const payload = "' OR '1'='1";
  68  |     const loginPage = new LoginPage(page);
  69  | 
  70  |     // Capture any 5xx / SQL-layer error responses from the auth backend.
  71  |     const serverErrors: number[] = [];
  72  |     page.on('response', (response) => {
  73  |       if (response.url().includes('/auth/') && response.status() >= 500) {
  74  |         serverErrors.push(response.status());
  75  |       }
  76  |     });
  77  | 
  78  |     // Step 1: Navigate to the login page -> form is displayed.
  79  |     await loginPage.goto();
  80  |     await loginPage.expectLoginFormVisible();
  81  | 
  82  |     // Step 2: Type the payload into Username -> accepted as literal text.
  83  |     await loginPage.enterUsername(payload);
  84  | 
  85  |     // Step 3: Type the payload into Password -> field is masked.
  86  |     await loginPage.enterPassword(payload);
  87  |     await loginPage.expectPasswordMasked();
  88  | 
  89  |     // Step 4: Click Login -> generic 'Invalid credentials'; no session created.
  90  |     await loginPage.submit();
  91  |     await loginPage.expectInvalidCredentials();
  92  |     await loginPage.expectStillOnLogin();
  93  | 
  94  |     // Step 5: No SQL error/stack trace and no authenticated redirect.
  95  |     expect(serverErrors, 'no 5xx / SQL error response should be returned').toHaveLength(0);
  96  |     await expect(page).not.toHaveURL(/\/dashboard/);
  97  |     await loginPage.expectNoSqlErrorLeak();
  98  |   });
  99  | });
  100 | 
```