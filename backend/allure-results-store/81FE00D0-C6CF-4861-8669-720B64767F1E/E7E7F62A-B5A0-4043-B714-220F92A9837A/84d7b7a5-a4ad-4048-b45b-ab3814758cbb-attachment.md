# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: username-trim-leading-trailing-spaces.spec.ts >> TC-012 - Verify username with leading and trailing spaces is trimmed and login still succeeds >> leading/trailing spaces in username are trimmed and login succeeds
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-E7E7F62A-B5A0-4043-B714-220F92A9837A-1782380266483\tests\username-trim-leading-trailing-spaces.spec.ts:78:7

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /\/dashboard\/index/
Received string:  "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"
Timeout: 5000ms

Call log:
  - Expect "toHaveURL" with timeout 5000ms
    9 × unexpected value "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"

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
  3  | /**
  4  |  * Page Object for the OrangeHRM Login screen.
  5  |  */
  6  | class LoginPage {
  7  |   readonly page: Page;
  8  |   readonly usernameInput: Locator;
  9  |   readonly passwordInput: Locator;
  10 |   readonly loginButton: Locator;
  11 | 
  12 |   constructor(page: Page) {
  13 |     this.page = page;
  14 |     this.usernameInput = page.getByPlaceholder('Username');
  15 |     this.passwordInput = page.getByPlaceholder('Password');
  16 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  17 |   }
  18 | 
  19 |   async goto(): Promise<void> {
  20 |     await this.page.goto('https://opensource-demo.orangehrmlive.com/web/index.php/auth/login');
  21 |   }
  22 | 
  23 |   // Step 1 — Login form is displayed.
  24 |   async expectLoginFormVisible(): Promise<void> {
  25 |     await expect(this.usernameInput).toBeVisible();
  26 |     await expect(this.passwordInput).toBeVisible();
  27 |     await expect(this.loginButton).toBeVisible();
  28 |   }
  29 | 
  30 |   // Step 2 — Enter a username; the field accepts the value including surrounding spaces.
  31 |   async enterUsername(username: string): Promise<void> {
  32 |     await this.usernameInput.fill(username);
  33 |     await expect(this.usernameInput).toHaveValue(username);
  34 |   }
  35 | 
  36 |   // Step 3 — Enter the password and confirm it is rendered masked.
  37 |   async enterPassword(password: string): Promise<void> {
  38 |     await this.passwordInput.fill(password);
  39 |     await expect(this.passwordInput).toHaveValue(password);
  40 |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  41 |   }
  42 | 
  43 |   // Step 4 — Click the Login button.
  44 |   async submit(): Promise<void> {
  45 |     await this.loginButton.click();
  46 |   }
  47 | }
  48 | 
  49 | /**
  50 |  * Page Object for the authenticated Dashboard landing screen.
  51 |  */
  52 | class DashboardPage {
  53 |   readonly page: Page;
  54 |   readonly heading: Locator;
  55 | 
  56 |   constructor(page: Page) {
  57 |     this.page = page;
  58 |     this.heading = page.getByRole('heading', { name: 'Dashboard' });
  59 |   }
  60 | 
  61 |   // Step 4 (assertion) — username trimmed server-side; authentication succeeds and redirects.
  62 |   async expectLoaded(): Promise<void> {
> 63 |     await expect(this.page).toHaveURL(/\/dashboard\/index/);
     |                             ^ Error: expect(page).toHaveURL(expected) failed
  64 |     await expect(this.heading).toBeVisible();
  65 |   }
  66 | }
  67 | 
  68 | test.describe('TC-012 - Verify username with leading and trailing spaces is trimmed and login still succeeds', () => {
  69 |   let loginPage: LoginPage;
  70 |   let dashboardPage: DashboardPage;
  71 | 
  72 |   test.beforeEach(async ({ page }) => {
  73 |     loginPage = new LoginPage(page);
  74 |     dashboardPage = new DashboardPage(page);
  75 |     await loginPage.goto();
  76 |   });
  77 | 
  78 |   test('leading/trailing spaces in username are trimmed and login succeeds', async () => {
  79 |     // Step 1: Login form is displayed.
  80 |     await loginPage.expectLoginFormVisible();
  81 | 
  82 |     // Step 2: Enter ' Admin ' with surrounding spaces; the field accepts the raw value.
  83 |     await loginPage.enterUsername(' Admin ');
  84 | 
  85 |     // Step 3: Enter the password; it is masked.
  86 |     await loginPage.enterPassword('admin123');
  87 | 
  88 |     // Step 4: Click Login; the username is trimmed server-side and the Dashboard loads.
  89 |     await loginPage.submit();
  90 |     await dashboardPage.expectLoaded();
  91 |   });
  92 | });
  93 | 
```