# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: verify-username-trimmed-password-spaces-preserved.spec.ts >> TC-004 - Username spaces trimmed (login succeeds); password spaces preserved (login fails) >> padded username logs in, padded password is rejected
- Location: ..\..\..\Users\VAMSEE~1\AppData\Local\Temp\jbs-pwexec-B4C51F7D-8CB5-4B39-A4FE-7D2B507E27DC-1782466340014\tests\verify-username-trimmed-password-spaces-preserved.spec.ts:69:7

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /\/web\/index\.php\/dashboard/
Received string:  "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"
Timeout: 5000ms

Call log:
  - Expect "toHaveURL" with timeout 5000ms
    - unexpected value "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"
    - waiting for navigation to finish...
    - navigated to "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"
    4 × unexpected value "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"

```

# Page snapshot

```yaml
- generic [ref=e4]:
  - generic [ref=e6]:
    - img "company-branding" [ref=e8]
    - generic [ref=e9]:
      - heading "Login" [level=5] [ref=e10]
      - generic [ref=e11]:
        - generic [ref=e12]:
          - alert [ref=e13]:
            - generic [ref=e14]:
              - generic [ref=e15]: 
              - paragraph [ref=e16]: Invalid credentials
          - generic [ref=e18]:
            - paragraph [ref=e19]: "Username : Admin"
            - paragraph [ref=e20]: "Password : admin123"
        - generic [ref=e21]:
          - generic [ref=e23]:
            - generic [ref=e24]:
              - generic [ref=e25]: 
              - generic [ref=e26]: Username
            - textbox "Username" [active] [ref=e28]
          - generic [ref=e30]:
            - generic [ref=e31]:
              - generic [ref=e32]: 
              - generic [ref=e33]: Password
            - textbox "Password" [ref=e35]
          - button "Login" [ref=e37] [cursor=pointer]
          - paragraph [ref=e39] [cursor=pointer]: Forgot your password?
      - generic [ref=e40]:
        - generic [ref=e41]:
          - link [ref=e42] [cursor=pointer]:
            - /url: https://www.linkedin.com/company/orangehrm/mycompany/
          - link [ref=e45] [cursor=pointer]:
            - /url: https://www.facebook.com/OrangeHRM/
          - link [ref=e48] [cursor=pointer]:
            - /url: https://twitter.com/orangehrm?lang=en
          - link [ref=e51] [cursor=pointer]:
            - /url: https://www.youtube.com/c/OrangeHRMInc
        - generic [ref=e54]:
          - paragraph [ref=e55]: OrangeHRM OS 5.8
          - paragraph [ref=e56]:
            - text: © 2005 - 2026
            - link "OrangeHRM, Inc" [ref=e57] [cursor=pointer]:
              - /url: http://www.orangehrm.com
            - text: . All rights reserved.
  - img "orangehrm-logo" [ref=e59]
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
  10 |   readonly errorAlert: Locator;
  11 | 
  12 |   constructor(page: Page) {
  13 |     this.page = page;
  14 |     this.usernameInput = page.getByPlaceholder('Username');
  15 |     this.passwordInput = page.getByPlaceholder('Password');
  16 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  17 |     this.errorAlert = page.getByRole('alert').getByText('Invalid credentials');
  18 |   }
  19 | 
  20 |   async goto(): Promise<void> {
  21 |     await this.page.goto(LOGIN_URL);
  22 |     await expect(this.loginButton).toBeVisible();
  23 |   }
  24 | 
  25 |   async fillUsername(username: string): Promise<void> {
  26 |     await this.usernameInput.fill(username);
  27 |   }
  28 | 
  29 |   async fillPassword(password: string): Promise<void> {
  30 |     await this.passwordInput.fill(password);
  31 |   }
  32 | 
  33 |   async submit(): Promise<void> {
  34 |     await this.loginButton.click();
  35 |   }
  36 | 
  37 |   async login(username: string, password: string): Promise<void> {
  38 |     await this.fillUsername(username);
  39 |     await this.fillPassword(password);
  40 |     await this.submit();
  41 |   }
  42 | 
  43 |   async expectInvalidCredentials(): Promise<void> {
  44 |     await expect(this.errorAlert).toBeVisible();
  45 |     await expect(this.errorAlert).toHaveText('Invalid credentials');
  46 |     await expect(this.page).toHaveURL(/\/web\/index\.php\/auth\/login/);
  47 |   }
  48 | }
  49 | 
  50 | class DashboardPage {
  51 |   readonly page: Page;
  52 |   readonly heading: Locator;
  53 |   readonly userProfileMenu: Locator;
  54 | 
  55 |   constructor(page: Page) {
  56 |     this.page = page;
  57 |     this.heading = page.getByRole('heading', { name: 'Dashboard' });
  58 |     this.userProfileMenu = page.getByRole('img', { name: 'profile picture' });
  59 |   }
  60 | 
  61 |   async expectLoaded(): Promise<void> {
> 62 |     await expect(this.page).toHaveURL(/\/web\/index\.php\/dashboard/);
     |                             ^ Error: expect(page).toHaveURL(expected) failed
  63 |     await expect(this.heading).toBeVisible();
  64 |     await expect(this.userProfileMenu).toBeVisible();
  65 |   }
  66 | }
  67 | 
  68 | test.describe('TC-004 - Username spaces trimmed (login succeeds); password spaces preserved (login fails)', () => {
  69 |   test('padded username logs in, padded password is rejected', async ({ page }) => {
  70 |     const loginPage = new LoginPage(page);
  71 |     const dashboardPage = new DashboardPage(page);
  72 | 
  73 |     // --- Part 1: Steps 1-4 — username with leading/trailing spaces is trimmed and login succeeds ---
  74 |     await loginPage.goto();
  75 | 
  76 |     await loginPage.fillUsername('  Admin  ');
  77 |     await expect(loginPage.usernameInput).toHaveValue('  Admin  ');
  78 | 
  79 |     await loginPage.fillPassword('admin123');
  80 |     await expect(loginPage.passwordInput).toHaveAttribute('type', 'password');
  81 | 
  82 |     await loginPage.submit();
  83 |     await dashboardPage.expectLoaded();
  84 | 
  85 |     // --- Part 2: Step 5 — password leading space is preserved, so authentication fails ---
  86 |     await loginPage.goto();
  87 | 
  88 |     await loginPage.fillUsername('  Admin  ');
  89 |     await loginPage.fillPassword(' admin123');
  90 |     await expect(loginPage.passwordInput).toHaveValue(' admin123');
  91 | 
  92 |     await loginPage.submit();
  93 |     await loginPage.expectInvalidCredentials();
  94 |     await expect(page).not.toHaveURL(/\/dashboard/);
  95 |   });
  96 | });
  97 | 
```