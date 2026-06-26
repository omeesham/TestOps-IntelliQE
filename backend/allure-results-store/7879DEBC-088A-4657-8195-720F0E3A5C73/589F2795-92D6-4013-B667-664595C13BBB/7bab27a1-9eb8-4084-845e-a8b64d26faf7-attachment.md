# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-008-sql-injection-username.spec.ts >> TC-008 - SQL Injection Prevention >> SQL injection payload in Username does not bypass authentication
- Location: ..\..\..\Users\VAMSEE~1\AppData\Local\Temp\jbs-pwexec-589F2795-92D6-4013-B667-664595C13BBB-1782455787467\tests\tc-008-sql-injection-username.spec.ts:76:7

# Error details

```
Error: no authenticated session cookie must be set

expect(received).toEqual(expected) // deep equality

- Expected  -  1
+ Received  + 12

- Array []
+ Array [
+   Object {
+     "domain": "opensource-demo.orangehrmlive.com",
+     "expires": -1,
+     "httpOnly": true,
+     "name": "orangehrm",
+     "path": "/web",
+     "sameSite": "Lax",
+     "secure": true,
+     "value": "2hidr1p1kk7m77ie4p9cp20nri",
+   },
+ ]
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
  3  | const LOGIN_URL =
  4  |   'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login';
  5  | const SQL_PAYLOAD = "' OR '1'='1' --";
  6  | 
  7  | /**
  8  |  * Page Object for the OrangeHRM Login screen, focused on injection safety.
  9  |  */
  10 | class LoginPage {
  11 |   readonly page: Page;
  12 |   readonly usernameInput: Locator;
  13 |   readonly passwordInput: Locator;
  14 |   readonly loginButton: Locator;
  15 |   readonly errorAlert: Locator;
  16 | 
  17 |   constructor(page: Page) {
  18 |     this.page = page;
  19 |     this.usernameInput = page.getByPlaceholder('Username');
  20 |     this.passwordInput = page.getByPlaceholder('Password');
  21 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  22 |     // OrangeHRM renders the auth failure inside an alert region.
  23 |     this.errorAlert = page.getByRole('alert').filter({ hasText: 'Invalid credentials' });
  24 |   }
  25 | 
  26 |   async goto(): Promise<void> {
  27 |     await this.page.goto(LOGIN_URL);
  28 |   }
  29 | 
  30 |   async expectLoaded(): Promise<void> {
  31 |     await expect(this.usernameInput).toBeVisible();
  32 |     await expect(this.passwordInput).toBeVisible();
  33 |     await expect(this.loginButton).toBeVisible();
  34 |   }
  35 | 
  36 |   async enterUsername(username: string): Promise<void> {
  37 |     await this.usernameInput.fill(username);
  38 |     // The payload is accepted as a literal string, not executed.
  39 |     await expect(this.usernameInput).toHaveValue(username);
  40 |   }
  41 | 
  42 |   async enterPassword(password: string): Promise<void> {
  43 |     await this.passwordInput.fill(password);
  44 |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  45 |   }
  46 | 
  47 |   async submit(): Promise<void> {
  48 |     await this.loginButton.click();
  49 |   }
  50 | 
  51 |   /**
  52 |    * A generic invalid-credentials message must appear; no SQL error or
  53 |    * stack trace should ever be exposed.
  54 |    */
  55 |   async expectGenericInvalidCredentials(): Promise<void> {
  56 |     await expect(this.errorAlert).toBeVisible();
  57 |     await expect(this.errorAlert).toHaveText(/Invalid credentials/i);
  58 |     await expect(this.page.getByText(/SQL|syntax|stack trace|exception/i)).toHaveCount(0);
  59 |   }
  60 | 
  61 |   async expectStillOnLoginPage(): Promise<void> {
  62 |     await expect(this.page).toHaveURL(/auth\/login/);
  63 |     await expect(this.loginButton).toBeVisible();
  64 |     await expect(this.page).not.toHaveURL(/dashboard/i);
  65 |   }
  66 | }
  67 | 
  68 | test.describe('TC-008 - SQL Injection Prevention', () => {
  69 |   let loginPage: LoginPage;
  70 | 
  71 |   test.beforeEach(async ({ page }) => {
  72 |     loginPage = new LoginPage(page);
  73 |     await loginPage.goto();
  74 |   });
  75 | 
  76 |   test('SQL injection payload in Username does not bypass authentication', async ({
  77 |     page,
  78 |   }) => {
  79 |     // Step 1: Login form is displayed.
  80 |     await loginPage.expectLoaded();
  81 | 
  82 |     // Step 2: Enter the SQL injection payload as the username (literal).
  83 |     await loginPage.enterUsername(SQL_PAYLOAD);
  84 | 
  85 |     // Step 3: Enter an arbitrary password (masked).
  86 |     await loginPage.enterPassword('anything');
  87 | 
  88 |     // Step 4: Click Login -> generic invalid credentials, no SQL error.
  89 |     await loginPage.submit();
  90 |     await loginPage.expectGenericInvalidCredentials();
  91 | 
  92 |     // Step 5: Still on login page, no dashboard redirect, no auth cookie.
  93 |     await loginPage.expectStillOnLoginPage();
  94 |     const cookies = await page.context().cookies();
  95 |     const authCookies = cookies.filter((c) => /orangehrm|session/i.test(c.name));
> 96 |     expect(authCookies, 'no authenticated session cookie must be set').toEqual([]);
     |                                                                        ^ Error: no authenticated session cookie must be set
  97 |   });
  98 | });
  99 | 
```