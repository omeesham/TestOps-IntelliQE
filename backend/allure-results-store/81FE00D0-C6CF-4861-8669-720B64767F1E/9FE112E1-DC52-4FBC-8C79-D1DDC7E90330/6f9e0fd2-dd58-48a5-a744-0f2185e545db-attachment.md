# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-011-username-whitespace-trimming.spec.ts >> TC-011: Username Whitespace Trimming >> leading and trailing spaces around valid username are stripped so authentication succeeds
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-9FE112E1-DC52-4FBC-8C79-D1DDC7E90330-1782493959599\tests\tc-011-username-whitespace-trimming.spec.ts:26:7

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /\/web\/index\.php\/dashboard\/index/
Received string:  "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"
Timeout: 10000ms

Call log:
  - Expect "toHaveURL" with timeout 10000ms
    14 × unexpected value "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"

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
  3  | class LoginPage {
  4  |   readonly page: Page;
  5  |   readonly usernameField: Locator;
  6  |   readonly passwordField: Locator;
  7  |   readonly loginButton: Locator;
  8  | 
  9  |   constructor(page: Page) {
  10 |     this.page = page;
  11 |     this.usernameField = page.getByPlaceholder('Username');
  12 |     this.passwordField = page.getByPlaceholder('Password');
  13 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  14 |   }
  15 | 
  16 |   async goto(): Promise<void> {
  17 |     await this.page.goto('https://opensource-demo.orangehrmlive.com/web/index.php/auth/login');
  18 |   }
  19 | 
  20 |   async expectDashboard(): Promise<void> {
> 21 |     await expect(this.page).toHaveURL(/\/web\/index\.php\/dashboard\/index/, { timeout: 10000 });
     |                             ^ Error: expect(page).toHaveURL(expected) failed
  22 |   }
  23 | }
  24 | 
  25 | test.describe('TC-011: Username Whitespace Trimming', () => {
  26 |   test('leading and trailing spaces around valid username are stripped so authentication succeeds', async ({ page }) => {
  27 |     const loginPage = new LoginPage(page);
  28 |     const usernameWithSpaces = '   Admin   ';
  29 | 
  30 |     // Step 1: Login page loads with empty username field
  31 |     await loginPage.goto();
  32 |     await expect(loginPage.usernameField).toBeVisible();
  33 |     await expect(loginPage.usernameField).toHaveValue('');
  34 | 
  35 |     // Step 2: Enter username with 3 leading and 3 trailing spaces
  36 |     await loginPage.usernameField.click();
  37 |     await loginPage.usernameField.fill(usernameWithSpaces);
  38 |     await expect(loginPage.usernameField).toHaveValue(usernameWithSpaces);
  39 | 
  40 |     // Step 3: Enter correct password
  41 |     await loginPage.passwordField.fill('admin123');
  42 | 
  43 |     // Steps 4-5: Submit — system must trim spaces and authenticate successfully
  44 |     await loginPage.loginButton.click();
  45 |     await loginPage.expectDashboard();
  46 |   });
  47 | });
  48 | 
```