# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: login-both-fields-required.spec.ts >> OrangeHRM Login - TC-003 both fields blank validation >> Verify both fields blank yields two independent 'Required' messages and blocks authentication
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-FEDF6490-3CE7-4997-8CB9-A0ED32B033C5-1782401131580\tests\login-both-fields-required.spec.ts:71:7

# Error details

```
Error: no session should be created when validation blocks submit

expect(received).toBeFalsy()

Received: {"domain": "opensource-demo.orangehrmlive.com", "expires": -1, "httpOnly": true, "name": "orangehrm", "path": "/web", "sameSite": "Lax", "secure": true, "value": "s3kjseif8t59ph0hgj0ba4q3fd"}
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
  5  | /**
  6  |  * Page Object for the OrangeHRM Login screen focused on mandatory-field validation.
  7  |  */
  8  | class LoginPage {
  9  |   readonly page: Page;
  10 |   readonly usernameInput: Locator;
  11 |   readonly passwordInput: Locator;
  12 |   readonly loginButton: Locator;
  13 |   readonly requiredMessages: Locator;
  14 |   readonly usernameRequiredMessage: Locator;
  15 |   readonly passwordRequiredMessage: Locator;
  16 | 
  17 |   constructor(page: Page) {
  18 |     this.page = page;
  19 |     this.usernameInput = page.getByPlaceholder('Username');
  20 |     this.passwordInput = page.getByPlaceholder('Password');
  21 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  22 |     // All inline validation messages on the form.
  23 |     this.requiredMessages = page.getByText('Required');
  24 |     // The validation message lives in the same input group as its field. There is no
  25 |     // accessible association (aria-describedby) on OrangeHRM, so scope by the group
  26 |     // container that contains the field — the only reliable way to bind error->field.
  27 |     this.usernameRequiredMessage = page
  28 |       .locator('.oxd-input-group')
  29 |       .filter({ has: this.usernameInput })
  30 |       .getByText('Required');
  31 |     this.passwordRequiredMessage = page
  32 |       .locator('.oxd-input-group')
  33 |       .filter({ has: this.passwordInput })
  34 |       .getByText('Required');
  35 |   }
  36 | 
  37 |   async goto(): Promise<void> {
  38 |     await this.page.goto(LOGIN_URL);
  39 |   }
  40 | 
  41 |   async expectEmptyForm(): Promise<void> {
  42 |     await expect(this.usernameInput).toBeVisible();
  43 |     await expect(this.usernameInput).toHaveValue('');
  44 |     await expect(this.passwordInput).toBeVisible();
  45 |     await expect(this.passwordInput).toHaveValue('');
  46 |   }
  47 | 
  48 |   async submit(): Promise<void> {
  49 |     await this.loginButton.click();
  50 |   }
  51 | 
  52 |   async expectTwoIndependentRequiredMessages(): Promise<void> {
  53 |     await expect(this.usernameRequiredMessage).toBeVisible();
  54 |     await expect(this.passwordRequiredMessage).toBeVisible();
  55 |     // Exactly two independent messages, not one combined message.
  56 |     await expect(this.requiredMessages).toHaveCount(2);
  57 |   }
  58 | 
  59 |   async expectStillOnLoginPage(): Promise<void> {
  60 |     await expect(this.page).toHaveURL(/\/web\/index\.php\/auth\/login/);
  61 |   }
  62 | 
  63 |   async expectNoSessionCookie(): Promise<void> {
  64 |     const cookies = await this.page.context().cookies();
  65 |     const sessionCookie = cookies.find((c) => /orangehrm/i.test(c.name));
> 66 |     expect(sessionCookie, 'no session should be created when validation blocks submit').toBeFalsy();
     |                                                                                         ^ Error: no session should be created when validation blocks submit
  67 |   }
  68 | }
  69 | 
  70 | test.describe('OrangeHRM Login - TC-003 both fields blank validation', () => {
  71 |   test("Verify both fields blank yields two independent 'Required' messages and blocks authentication", async ({ page }) => {
  72 |     const loginPage = new LoginPage(page);
  73 | 
  74 |     // Step 1: navigate with both fields empty.
  75 |     await loginPage.goto();
  76 |     await loginPage.expectEmptyForm();
  77 | 
  78 |     // Step 2: submit without entering any text.
  79 |     await loginPage.submit();
  80 | 
  81 |     // Steps 2-3: two independent 'Required' messages under each field.
  82 |     await loginPage.expectTwoIndependentRequiredMessages();
  83 | 
  84 |     // Step 4: no authentication, still on login page, no session.
  85 |     await loginPage.expectStillOnLoginPage();
  86 |     await loginPage.expectNoSessionCookie();
  87 |   });
  88 | });
  89 | 
```