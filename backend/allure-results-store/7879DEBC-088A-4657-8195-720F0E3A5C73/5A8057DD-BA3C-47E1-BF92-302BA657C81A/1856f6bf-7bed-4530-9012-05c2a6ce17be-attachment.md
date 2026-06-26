# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: login-username-trim.spec.ts >> TC-011 - Username Field Validation (whitespace trimming) >> Username with leading/trailing spaces is trimmed and authenticates
- Location: ..\..\..\Users\VAMSEE~1\AppData\Local\Temp\jbs-pwexec-5A8057DD-BA3C-47E1-BF92-302BA657C81A-1782407000148\tests\login-username-trim.spec.ts:65:7

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /.*\/dashboard\/index/
Received string:  "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"
Timeout: 5000ms

Call log:
  - Expect "toHaveURL" with timeout 5000ms
    8 × unexpected value "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"

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
  11 |   readonly loginHeading: Locator;
  12 | 
  13 |   constructor(page: Page) {
  14 |     this.page = page;
  15 |     this.usernameInput = page.getByPlaceholder('Username');
  16 |     this.passwordInput = page.getByPlaceholder('Password');
  17 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  18 |     this.loginHeading = page.getByRole('heading', { name: 'Login' });
  19 |   }
  20 | 
  21 |   async goto(): Promise<void> {
  22 |     await this.page.goto('https://opensource-demo.orangehrmlive.com/web/index.php/auth/login');
  23 |   }
  24 | 
  25 |   async expectLoaded(): Promise<void> {
  26 |     await expect(this.loginHeading).toBeVisible();
  27 |   }
  28 | 
  29 |   async enterUsername(username: string): Promise<void> {
  30 |     await this.usernameInput.fill(username);
  31 |     // Field should accept the spaced value verbatim before submission.
  32 |     await expect(this.usernameInput).toHaveValue(username);
  33 |   }
  34 | 
  35 |   async enterPassword(password: string): Promise<void> {
  36 |     await this.passwordInput.fill(password);
  37 |     // Password input must be masked.
  38 |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  39 |   }
  40 | 
  41 |   async clickLogin(): Promise<void> {
  42 |     await this.loginButton.click();
  43 |   }
  44 | }
  45 | 
  46 | /**
  47 |  * Page Object for the authenticated Dashboard landing screen.
  48 |  */
  49 | class DashboardPage {
  50 |   readonly page: Page;
  51 |   readonly heading: Locator;
  52 | 
  53 |   constructor(page: Page) {
  54 |     this.page = page;
  55 |     this.heading = page.getByRole('heading', { name: 'Dashboard' });
  56 |   }
  57 | 
  58 |   async expectLoaded(): Promise<void> {
> 59 |     await expect(this.page).toHaveURL(/.*\/dashboard\/index/);
     |                             ^ Error: expect(page).toHaveURL(expected) failed
  60 |     await expect(this.heading).toBeVisible();
  61 |   }
  62 | }
  63 | 
  64 | test.describe('TC-011 - Username Field Validation (whitespace trimming)', () => {
  65 |   test('Username with leading/trailing spaces is trimmed and authenticates', async ({ page }) => {
  66 |     const loginPage = new LoginPage(page);
  67 |     const dashboardPage = new DashboardPage(page);
  68 | 
  69 |     // Step 1: Navigate to the login page
  70 |     await loginPage.goto();
  71 |     await loginPage.expectLoaded();
  72 | 
  73 |     // Step 2: Enter ' Admin ' (spaced) into the Username field
  74 |     await loginPage.enterUsername(' Admin ');
  75 | 
  76 |     // Step 3: Enter 'admin123' into the (masked) Password field
  77 |     await loginPage.enterPassword('admin123');
  78 | 
  79 |     // Step 4: Click Login -> username trimmed to 'Admin', auth succeeds, Dashboard shown
  80 |     await loginPage.clickLogin();
  81 |     await dashboardPage.expectLoaded();
  82 |   });
  83 | });
  84 | 
```