# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-003-mandatory-field-validation.spec.ts >> TC-003 - Mandatory field validation >> submitting blank form shows Required on both fields and blocks login
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-E7E7F62A-B5A0-4043-B714-220F92A9837A-1782380266483\tests\tc-003-mandatory-field-validation.spec.ts:82:7

# Error details

```
Error: no session cookie should be created

expect(received).toBeFalsy()

Received: {"domain": "opensource-demo.orangehrmlive.com", "expires": -1, "httpOnly": true, "name": "orangehrm", "path": "/web", "sameSite": "Lax", "secure": true, "value": "988i6o7qm4ai70f8ehsn8uka3o"}
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
  4  | const LOGIN_URL_RX = /\/web\/index\.php\/auth\/login/;
  5  | 
  6  | /**
  7  |  * Page Object for the OrangeHRM Login screen, focused on field validation.
  8  |  */
  9  | class LoginPage {
  10 |   readonly page: Page;
  11 |   readonly usernameInput: Locator;
  12 |   readonly passwordInput: Locator;
  13 |   readonly loginButton: Locator;
  14 |   readonly usernameError: Locator;
  15 |   readonly passwordError: Locator;
  16 | 
  17 |   constructor(page: Page) {
  18 |     this.page = page;
  19 |     this.usernameInput = page.getByPlaceholder('Username');
  20 |     this.passwordInput = page.getByPlaceholder('Password');
  21 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  22 |     // Each field is wrapped in an oxd-input-group; the 'Required' message renders
  23 |     // as adjacent text within that group. We scope the text match to the group
  24 |     // that contains the corresponding input so the assertion is field-specific.
  25 |     this.usernameError = this.fieldErrorFor(this.usernameInput);
  26 |     this.passwordError = this.fieldErrorFor(this.passwordInput);
  27 |   }
  28 | 
  29 |   private fieldErrorFor(input: Locator): Locator {
  30 |     // No accessible association (aria-describedby) exists between the input and
  31 |     // its error text, so we navigate to the enclosing field group and read the
  32 |     // error text node within it.
  33 |     return input
  34 |       .locator('xpath=ancestor::div[contains(@class,"oxd-input-group")]')
  35 |       .getByText('Required', { exact: true });
  36 |   }
  37 | 
  38 |   async goto(): Promise<void> {
  39 |     await this.page.goto(LOGIN_URL);
  40 |   }
  41 | 
  42 |   async expectEmptyForm(): Promise<void> {
  43 |     await expect(this.usernameInput).toBeVisible();
  44 |     await expect(this.usernameInput).toHaveValue('');
  45 |     await expect(this.passwordInput).toBeVisible();
  46 |     await expect(this.passwordInput).toHaveValue('');
  47 |   }
  48 | 
  49 |   async submitEmpty(): Promise<void> {
  50 |     await this.loginButton.click();
  51 |   }
  52 | 
  53 |   async expectUsernameRequired(): Promise<void> {
  54 |     await expect(this.usernameError).toBeVisible();
  55 |     await expect(this.usernameError).toHaveText('Required');
  56 |   }
  57 | 
  58 |   async expectPasswordRequired(): Promise<void> {
  59 |     await expect(this.passwordError).toBeVisible();
  60 |     await expect(this.passwordError).toHaveText('Required');
  61 |   }
  62 | 
  63 |   async expectStillOnLoginPage(): Promise<void> {
  64 |     await expect(this.page).toHaveURL(LOGIN_URL_RX);
  65 |   }
  66 | 
  67 |   async expectNoSessionCookie(): Promise<void> {
  68 |     const cookies = await this.page.context().cookies();
  69 |     const session = cookies.find((c) => c.name.toLowerCase().includes('orangehrm'));
> 70 |     expect(session, 'no session cookie should be created').toBeFalsy();
     |                                                            ^ Error: no session cookie should be created
  71 |   }
  72 | }
  73 | 
  74 | test.describe('TC-003 - Mandatory field validation', () => {
  75 |   let loginPage: LoginPage;
  76 | 
  77 |   test.beforeEach(async ({ page }) => {
  78 |     loginPage = new LoginPage(page);
  79 |     await loginPage.goto();
  80 |   });
  81 | 
  82 |   test('submitting blank form shows Required on both fields and blocks login', async () => {
  83 |     // Step 1: Form loads with empty Username and Password fields.
  84 |     await loginPage.expectEmptyForm();
  85 | 
  86 |     // Step 2: Submit without entering any data; auth must not proceed.
  87 |     await loginPage.submitEmpty();
  88 | 
  89 |     // Step 3 & 4: Both fields show a field-level 'Required' message.
  90 |     await loginPage.expectUsernameRequired();
  91 |     await loginPage.expectPasswordRequired();
  92 | 
  93 |     // Step 5: User remains on the login page and no session is created.
  94 |     await loginPage.expectStillOnLoginPage();
  95 |     await loginPage.expectNoSessionCookie();
  96 |   });
  97 | });
  98 | 
```