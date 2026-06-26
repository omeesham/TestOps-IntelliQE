# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-006-sql-injection-username-rejected.spec.ts >> TC-006 - Input Sanitization / SQL Injection Prevention >> SQL injection payload in username is treated as literal text and rejected without DB error
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-6CF4ED70-6D3A-4B40-895E-3EB92AB03C63-1782398745504\tests\tc-006-sql-injection-username-rejected.spec.ts:70:7

# Error details

```
Error: response.text: Response body is unavailable for redirect responses
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
  4  |  * Page Object for the OrangeHRM login screen, focused on injection handling.
  5  |  */
  6  | class LoginPage {
  7  |   readonly page: Page;
  8  |   readonly usernameInput: Locator;
  9  |   readonly passwordInput: Locator;
  10 |   readonly loginButton: Locator;
  11 |   readonly loginHeading: Locator;
  12 |   readonly errorAlert: Locator;
  13 | 
  14 |   constructor(page: Page) {
  15 |     this.page = page;
  16 |     // OrangeHRM inputs have no associated <label>; placeholder is the stable a11y locator.
  17 |     this.usernameInput = page.getByPlaceholder('Username');
  18 |     this.passwordInput = page.getByPlaceholder('Password');
  19 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  20 |     this.loginHeading = page.getByRole('heading', { name: 'Login' });
  21 |     // The error banner is rendered with role=alert by OrangeHRM.
  22 |     this.errorAlert = page.getByRole('alert');
  23 |   }
  24 | 
  25 |   async goto(): Promise<void> {
  26 |     await this.page.goto('https://opensource-demo.orangehrmlive.com/web/index.php/auth/login');
  27 |   }
  28 | 
  29 |   async expectFormDisplayed(): Promise<void> {
  30 |     await expect(this.loginHeading).toBeVisible();
  31 |     await expect(this.usernameInput).toBeVisible();
  32 |     await expect(this.passwordInput).toBeVisible();
  33 |   }
  34 | 
  35 |   async enterUsername(username: string): Promise<void> {
  36 |     await this.usernameInput.fill(username);
  37 |     // The payload must be retained verbatim as literal text.
  38 |     await expect(this.usernameInput).toHaveValue(username);
  39 |   }
  40 | 
  41 |   async enterPassword(password: string): Promise<void> {
  42 |     await this.passwordInput.fill(password);
  43 |     await expect(this.passwordInput).toHaveValue(password);
  44 |   }
  45 | 
  46 |   async submit(): Promise<void> {
  47 |     await this.loginButton.click();
  48 |   }
  49 | 
  50 |   async expectInvalidCredentials(): Promise<void> {
  51 |     await expect(this.errorAlert).toBeVisible();
  52 |     await expect(this.errorAlert).toContainText('Invalid credentials');
  53 |   }
  54 | 
  55 |   async expectStillOnLogin(): Promise<void> {
  56 |     // No session is created -> we remain on the auth/login route.
  57 |     await expect(this.page).toHaveURL(/\/auth\/login/);
  58 |     await expect(this.loginHeading).toBeVisible();
  59 |   }
  60 | }
  61 | 
  62 | test.describe('TC-006 - Input Sanitization / SQL Injection Prevention', () => {
  63 |   const SQL_PAYLOAD = "' OR '1'='1' --";
  64 | 
  65 |   test.beforeEach(async ({ page }) => {
  66 |     const loginPage = new LoginPage(page);
  67 |     await loginPage.goto();
  68 |   });
  69 | 
  70 |   test('SQL injection payload in username is treated as literal text and rejected without DB error', async ({ page }) => {
  71 |     const loginPage = new LoginPage(page);
  72 | 
  73 |     // Capture the server response for the authentication request to inspect for leakage.
  74 |     const loginResponsePromise = page.waitForResponse(
  75 |       (response) => response.url().includes('/auth/validate') || response.request().method() === 'POST',
  76 |     );
  77 | 
  78 |     // Step 1: Login form is displayed
  79 |     await loginPage.expectFormDisplayed();
  80 | 
  81 |     // Step 2: Payload accepted as a literal text value
  82 |     await loginPage.enterUsername(SQL_PAYLOAD);
  83 | 
  84 |     // Step 3: Authentication fails with the generic 'Invalid credentials' message
  85 |     await loginPage.enterPassword('anything');
  86 |     await loginPage.submit();
  87 |     await loginPage.expectInvalidCredentials();
  88 | 
  89 |     // Step 4: No SQL/DB error, stack trace or schema detail is exposed; no session created
  90 |     const loginResponse = await loginResponsePromise;
> 91 |     const bodyText = (await loginResponse.text()).toLowerCase();
     |                                           ^ Error: response.text: Response body is unavailable for redirect responses
  92 |     const leakageMarkers = ['sql', 'syntax error', 'stack trace', 'exception', 'odbc', 'mysql', 'sqlstate', 'pdoexception'];
  93 |     for (const marker of leakageMarkers) {
  94 |       expect(bodyText, `response should not disclose '${marker}'`).not.toContain(marker);
  95 |     }
  96 |     await loginPage.expectStillOnLogin();
  97 |   });
  98 | });
  99 | 
```