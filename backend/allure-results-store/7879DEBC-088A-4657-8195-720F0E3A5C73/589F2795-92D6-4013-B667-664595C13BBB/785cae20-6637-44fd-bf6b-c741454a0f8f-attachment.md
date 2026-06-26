# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-004-required-validation-both-fields-blank.spec.ts >> TC-004 Required validation under both fields when Username and Password are blank >> submitting with both fields empty shows two Required messages and creates no session
- Location: ..\..\..\Users\VAMSEE~1\AppData\Local\Temp\jbs-pwexec-589F2795-92D6-4013-B667-664595C13BBB-1782455787467\tests\tc-004-required-validation-both-fields-blank.spec.ts:53:7

# Error details

```
Error: no authenticated session cookie should be created on validation failure

expect(received).toBeFalsy()

Received: {"domain": "opensource-demo.orangehrmlive.com", "expires": -1, "httpOnly": true, "name": "orangehrm", "path": "/web", "sameSite": "Lax", "secure": true, "value": "t3tpr30b9qu3u651re7fhnmkfo"}
```

# Page snapshot

```yaml
- generic [ref=e4]:
  - generic [ref=e6]:
    - img "company-branding" [ref=e8]
    - generic [ref=e9]:
      - heading "Login" [level=5] [ref=e10]
      - generic [ref=e11]:
        - generic [ref=e13]:
          - paragraph [ref=e14]: "Username : Admin"
          - paragraph [ref=e15]: "Password : admin123"
        - generic [ref=e16]:
          - generic [ref=e18]:
            - generic [ref=e19]:
              - generic [ref=e20]: 
              - generic [ref=e21]: Username
            - textbox "Username" [ref=e23]
            - generic [ref=e24]: Required
          - generic [ref=e26]:
            - generic [ref=e27]:
              - generic [ref=e28]: 
              - generic [ref=e29]: Password
            - textbox "Password" [ref=e31]
            - generic [ref=e32]: Required
          - button "Login" [active] [ref=e34] [cursor=pointer]
          - paragraph [ref=e36] [cursor=pointer]: Forgot your password?
      - generic [ref=e37]:
        - generic [ref=e38]:
          - link [ref=e39] [cursor=pointer]:
            - /url: https://www.linkedin.com/company/orangehrm/mycompany/
          - link [ref=e42] [cursor=pointer]:
            - /url: https://www.facebook.com/OrangeHRM/
          - link [ref=e45] [cursor=pointer]:
            - /url: https://twitter.com/orangehrm?lang=en
          - link [ref=e48] [cursor=pointer]:
            - /url: https://www.youtube.com/c/OrangeHRMInc
        - generic [ref=e51]:
          - paragraph [ref=e52]: OrangeHRM OS 5.8
          - paragraph [ref=e53]:
            - text: © 2005 - 2026
            - link "OrangeHRM, Inc" [ref=e54] [cursor=pointer]:
              - /url: http://www.orangehrm.com
            - text: . All rights reserved.
  - img "orangehrm-logo" [ref=e56]
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
  10 |   readonly requiredMessages: Locator;
  11 |   readonly dashboardHeader: Locator;
  12 | 
  13 |   constructor(page: Page) {
  14 |     this.page = page;
  15 |     this.usernameInput = page.getByPlaceholder('Username');
  16 |     this.passwordInput = page.getByPlaceholder('Password');
  17 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  18 |     // Each mandatory field renders the text 'Required' beneath it when left empty.
  19 |     this.requiredMessages = page.getByText('Required', { exact: true });
  20 |     this.dashboardHeader = page.getByRole('heading', { name: 'Dashboard' });
  21 |   }
  22 | 
  23 |   async goto(): Promise<void> {
  24 |     await this.page.goto(LOGIN_URL);
  25 |   }
  26 | 
  27 |   async expectLoadedEmpty(): Promise<void> {
  28 |     await expect(this.page).toHaveURL(/\/auth\/login/);
  29 |     await expect(this.usernameInput).toBeVisible();
  30 |     await expect(this.usernameInput).toHaveValue('');
  31 |     await expect(this.passwordInput).toBeVisible();
  32 |     await expect(this.passwordInput).toHaveValue('');
  33 |   }
  34 | 
  35 |   async submit(): Promise<void> {
  36 |     await this.loginButton.click();
  37 |   }
  38 | 
  39 |   async expectRequiredUnderBothFields(): Promise<void> {
  40 |     // Both empty fields must each raise their own 'Required' message simultaneously.
  41 |     await expect(this.requiredMessages).toHaveCount(2);
  42 |     await expect(this.requiredMessages.nth(0)).toBeVisible();
  43 |     await expect(this.requiredMessages.nth(1)).toBeVisible();
  44 |   }
  45 | 
  46 |   async expectStillOnLogin(): Promise<void> {
  47 |     await expect(this.page).toHaveURL(/\/auth\/login/);
  48 |     await expect(this.dashboardHeader).toBeHidden();
  49 |   }
  50 | }
  51 | 
  52 | test.describe('TC-004 Required validation under both fields when Username and Password are blank', () => {
  53 |   test('submitting with both fields empty shows two Required messages and creates no session', async ({ page, context }) => {
  54 |     const loginPage = new LoginPage(page);
  55 | 
  56 |     // Step 1: Navigate to the login page with both fields empty.
  57 |     await loginPage.goto();
  58 |     await loginPage.expectLoadedEmpty();
  59 | 
  60 |     // Step 2 & 3: Submit without entering anything; expect a 'Required' message under each field.
  61 |     await loginPage.submit();
  62 |     await loginPage.expectRequiredUnderBothFields();
  63 | 
  64 |     // Step 4: No redirect, no session created.
  65 |     await loginPage.expectStillOnLogin();
  66 |     const cookies = await context.cookies();
  67 |     const authCookie = cookies.find((c) => c.httpOnly && c.secure);
> 68 |     expect(authCookie, 'no authenticated session cookie should be created on validation failure').toBeFalsy();
     |                                                                                                   ^ Error: no authenticated session cookie should be created on validation failure
  69 |   });
  70 | });
  71 | 
```