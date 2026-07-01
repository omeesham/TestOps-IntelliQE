# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-001-successful-login-redirects-to-dashboard.spec.ts >> TC-001 - Successful Login Redirect to Dashboard >> Verify successful login with valid credentials redirects to Dashboard and creates a session
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-6A61759F-80FA-4ABA-9A35-9A2476660687-1782467247131\tests\tc-001-successful-login-redirects-to-dashboard.spec.ts:82:7

# Error details

```
TimeoutError: page.goto: Timeout 30000ms exceeded.
Call log:
  - navigating to "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login", waiting until "load"

```

# Test source

```ts
  1   | import { test, expect, type Page, type Locator } from '@playwright/test';
  2   | 
  3   | const LOGIN_URL = 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login';
  4   | const DASHBOARD_URL_PATTERN = /\/web\/index\.php\/dashboard\/index/;
  5   | 
  6   | class LoginPage {
  7   |   readonly page: Page;
  8   |   readonly logo: Locator;
  9   |   readonly usernameInput: Locator;
  10  |   readonly passwordInput: Locator;
  11  |   readonly loginButton: Locator;
  12  |   readonly forgotPasswordLink: Locator;
  13  | 
  14  |   constructor(page: Page) {
  15  |     this.page = page;
  16  |     this.logo = page.getByAltText('company-branding');
  17  |     this.usernameInput = page.getByPlaceholder('Username');
  18  |     this.passwordInput = page.getByPlaceholder('Password');
  19  |     this.loginButton = page.getByRole('button', { name: 'Login' });
  20  |     this.forgotPasswordLink = page.getByText('Forgot your password?');
  21  |   }
  22  | 
  23  |   async goto(): Promise<void> {
> 24  |     await this.page.goto(LOGIN_URL);
      |                     ^ TimeoutError: page.goto: Timeout 30000ms exceeded.
  25  |   }
  26  | 
  27  |   async expectLoaded(): Promise<void> {
  28  |     await expect(this.page).toHaveURL(/^https:\/\//);
  29  |     await expect(this.logo).toBeVisible();
  30  |     await expect(this.usernameInput).toBeVisible();
  31  |     await expect(this.passwordInput).toBeVisible();
  32  |     await expect(this.loginButton).toBeVisible();
  33  |     await expect(this.forgotPasswordLink).toBeVisible();
  34  |   }
  35  | 
  36  |   async enterUsername(username: string): Promise<void> {
  37  |     await this.usernameInput.fill(username);
  38  |     await expect(this.usernameInput).toHaveValue(username);
  39  |   }
  40  | 
  41  |   async enterPassword(password: string): Promise<void> {
  42  |     await this.passwordInput.fill(password);
  43  |     await expect(this.passwordInput).toHaveValue(password);
  44  |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  45  |   }
  46  | 
  47  |   async submit(): Promise<void> {
  48  |     await this.loginButton.click();
  49  |   }
  50  | }
  51  | 
  52  | class DashboardPage {
  53  |   readonly page: Page;
  54  |   readonly heading: Locator;
  55  |   readonly adminMenu: Locator;
  56  |   readonly pimMenu: Locator;
  57  |   readonly leaveMenu: Locator;
  58  | 
  59  |   constructor(page: Page) {
  60  |     this.page = page;
  61  |     this.heading = page.getByRole('heading', { name: 'Dashboard' });
  62  |     this.adminMenu = page.getByRole('link', { name: 'Admin' });
  63  |     this.pimMenu = page.getByRole('link', { name: 'PIM' });
  64  |     this.leaveMenu = page.getByRole('link', { name: 'Leave' });
  65  |   }
  66  | 
  67  |   async expectLoaded(): Promise<void> {
  68  |     await expect(this.page).toHaveURL(DASHBOARD_URL_PATTERN);
  69  |     await expect(this.heading).toBeVisible();
  70  |     await expect(this.adminMenu).toBeVisible();
  71  |     await expect(this.pimMenu).toBeVisible();
  72  |     await expect(this.leaveMenu).toBeVisible();
  73  |   }
  74  | 
  75  |   async expectSessionCookie(): Promise<void> {
  76  |     const cookies = await this.page.context().cookies();
  77  |     expect(cookies.some((c) => c.name === 'orangehrm')).toBeTruthy();
  78  |   }
  79  | }
  80  | 
  81  | test.describe('TC-001 - Successful Login Redirect to Dashboard', () => {
  82  |   test('Verify successful login with valid credentials redirects to Dashboard and creates a session', async ({ page }) => {
  83  |     const loginPage = new LoginPage(page);
  84  |     const dashboardPage = new DashboardPage(page);
  85  | 
  86  |     // Step 1: Navigate and verify the login page loads over HTTPS with all elements
  87  |     await loginPage.goto();
  88  |     await loginPage.expectLoaded();
  89  | 
  90  |     // Step 2: Enter a valid username
  91  |     await loginPage.enterUsername('Admin');
  92  | 
  93  |     // Step 3: Enter a valid (masked) password
  94  |     await loginPage.enterPassword('admin123');
  95  | 
  96  |     // Step 4: Submit and expect redirect to the Dashboard with a session cookie
  97  |     await loginPage.submit();
  98  |     await dashboardPage.expectLoaded();
  99  |     await dashboardPage.expectSessionCookie();
  100 | 
  101 |     // Step 5: Verify Dashboard heading and authenticated navigation menu are visible
  102 |     await expect(dashboardPage.heading).toBeVisible();
  103 |     await expect(dashboardPage.adminMenu).toBeVisible();
  104 |   });
  105 | });
  106 | 
```