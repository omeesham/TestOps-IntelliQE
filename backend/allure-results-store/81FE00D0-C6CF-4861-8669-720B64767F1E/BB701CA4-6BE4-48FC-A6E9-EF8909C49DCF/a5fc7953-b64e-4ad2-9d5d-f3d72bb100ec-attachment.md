# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-007-username-trim-login.spec.ts >> TC-007 - Leading/trailing spaces in username are trimmed >> Padded username is trimmed and login succeeds
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-BB701CA4-6BE4-48FC-A6E9-EF8909C49DCF-1782309870206\tests\tc-007-username-trim-login.spec.ts:75:7

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /dashboard/
Received string:  "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"
Timeout: 5000ms

Call log:
  - Expect "toHaveURL" with timeout 5000ms
    2 × unexpected value "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"
    - waiting for" https://opensource-demo.orangehrmlive.com/web/index.php/auth/validate" navigation to finish...
    - navigated to "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"
    6 × unexpected value "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"

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
  21 |     await expect(this.usernameInput).toBeVisible();
  22 |   }
  23 | 
  24 |   /** Step 1: the padded value is accepted into the username field. */
  25 |   async enterUsername(value: string): Promise<void> {
  26 |     await this.usernameInput.fill(value);
  27 |     await expect(this.usernameInput).toHaveValue(value);
  28 |   }
  29 | 
  30 |   /** Step 2: the password field shows masked dots. */
  31 |   async enterPassword(value: string): Promise<void> {
  32 |     await this.passwordInput.fill(value);
  33 |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  34 |     await expect(this.passwordInput).toHaveValue(value);
  35 |   }
  36 | 
  37 |   /** Step 3: submit credentials. */
  38 |   async submit(): Promise<void> {
  39 |     await this.loginButton.click();
  40 |   }
  41 | }
  42 | 
  43 | /**
  44 |  * Page Object for the post-login Dashboard screen.
  45 |  */
  46 | class DashboardPage {
  47 |   readonly page: Page;
  48 |   readonly heading: Locator;
  49 |   readonly invalidCredentialsAlert: Locator;
  50 | 
  51 |   constructor(page: Page) {
  52 |     this.page = page;
  53 |     this.heading = page.getByRole('heading', { name: 'Dashboard' });
  54 |     this.invalidCredentialsAlert = page.getByText('Invalid credentials');
  55 |   }
  56 | 
  57 |   /** Step 4: authenticated and redirected to the Dashboard with no error. */
  58 |   async expectLoggedIn(): Promise<void> {
> 59 |     await expect(this.page).toHaveURL(/dashboard/);
     |                             ^ Error: expect(page).toHaveURL(expected) failed
  60 |     await expect(this.heading).toBeVisible();
  61 |     await expect(this.invalidCredentialsAlert).toHaveCount(0);
  62 |   }
  63 | }
  64 | 
  65 | test.describe('TC-007 - Leading/trailing spaces in username are trimmed', () => {
  66 |   let loginPage: LoginPage;
  67 |   let dashboardPage: DashboardPage;
  68 | 
  69 |   test.beforeEach(async ({ page }) => {
  70 |     loginPage = new LoginPage(page);
  71 |     dashboardPage = new DashboardPage(page);
  72 |     await loginPage.goto();
  73 |   });
  74 | 
  75 |   test('Padded username is trimmed and login succeeds', async () => {
  76 |     // Step 1: enter '  Admin  ' (two leading + two trailing spaces).
  77 |     await loginPage.enterUsername('  Admin  ');
  78 | 
  79 |     // Step 2: enter the password; field is masked.
  80 |     await loginPage.enterPassword('admin123');
  81 | 
  82 |     // Step 3: submit; the surrounding whitespace is trimmed before auth.
  83 |     await loginPage.submit();
  84 | 
  85 |     // Step 4: authenticated and redirected to the Dashboard, no error shown.
  86 |     await dashboardPage.expectLoggedIn();
  87 |   });
  88 | });
  89 | 
```