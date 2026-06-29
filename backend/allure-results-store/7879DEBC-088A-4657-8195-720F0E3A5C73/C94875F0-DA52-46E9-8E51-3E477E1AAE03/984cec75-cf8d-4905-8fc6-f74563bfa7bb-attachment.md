# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-009-sql-injection-username-rejected.spec.ts >> TC-009 - SQL injection payload in username is rejected without DB error leakage >> treats injection payload as invalid credentials with no verbose error leakage
- Location: ..\..\..\..\Users\VAMSEE~1\AppData\Local\Temp\jbs-pwexec-C94875F0-DA52-46E9-8E51-3E477E1AAE03-1782571560874\tests\tc-009-sql-injection-username-rejected.spec.ts:69:7

# Error details

```
Error: no authenticated session cookie should be created

expect(received).toBeFalsy()

Received: {"domain": "opensource-demo.orangehrmlive.com", "expires": -1, "httpOnly": true, "name": "orangehrm", "path": "/web", "sameSite": "Lax", "secure": true, "value": "kmta4jb6uuo74bgvadofgij36f"}
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
  5  | /**
  6  |  * Page Object for the OrangeHRM login screen.
  7  |  * All locators are accessibility-first and declared once.
  8  |  */
  9  | class LoginPage {
  10 |   readonly page: Page;
  11 |   readonly usernameInput: Locator;
  12 |   readonly passwordInput: Locator;
  13 |   readonly loginButton: Locator;
  14 |   readonly invalidCredentialsAlert: Locator;
  15 | 
  16 |   constructor(page: Page) {
  17 |     this.page = page;
  18 |     this.usernameInput = page.getByPlaceholder('Username');
  19 |     this.passwordInput = page.getByPlaceholder('Password');
  20 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  21 |     this.invalidCredentialsAlert = page.getByText('Invalid credentials', { exact: true });
  22 |   }
  23 | 
  24 |   async goto(): Promise<void> {
  25 |     await this.page.goto(LOGIN_URL);
  26 |     await expect(this.usernameInput).toBeVisible();
  27 |     await expect(this.passwordInput).toBeVisible();
  28 |   }
  29 | 
  30 |   async typeUsername(value: string): Promise<void> {
  31 |     await this.usernameInput.fill(value);
  32 |   }
  33 | 
  34 |   async typePassword(value: string): Promise<void> {
  35 |     await this.passwordInput.fill(value);
  36 |   }
  37 | 
  38 |   async submit(): Promise<void> {
  39 |     await this.loginButton.click();
  40 |   }
  41 | 
  42 |   async expectUsernameValue(value: string): Promise<void> {
  43 |     await expect(this.usernameInput).toHaveValue(value);
  44 |   }
  45 | 
  46 |   async expectPasswordMasked(): Promise<void> {
  47 |     // A password field is rendered as masked dots when its type is 'password'.
  48 |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  49 |   }
  50 | 
  51 |   async expectInvalidCredentials(): Promise<void> {
  52 |     await expect(this.invalidCredentialsAlert).toBeVisible();
  53 |     await expect(this.invalidCredentialsAlert).toHaveText('Invalid credentials');
  54 |   }
  55 | 
  56 |   async expectStillOnLoginPage(): Promise<void> {
  57 |     expect(this.page.url()).toContain('/auth/login');
  58 |     await expect(this.loginButton).toBeVisible();
  59 |   }
  60 | 
  61 |   async expectNoSessionCookie(): Promise<void> {
  62 |     const cookies = await this.page.context().cookies();
  63 |     const session = cookies.find((c) => /orangehrm|session|sid/i.test(c.name) && c.value.length > 0);
> 64 |     expect(session, 'no authenticated session cookie should be created').toBeFalsy();
     |                                                                          ^ Error: no authenticated session cookie should be created
  65 |   }
  66 | }
  67 | 
  68 | test.describe('TC-009 - SQL injection payload in username is rejected without DB error leakage', () => {
  69 |   test('treats injection payload as invalid credentials with no verbose error leakage', async ({ page }) => {
  70 |     const login = new LoginPage(page);
  71 |     await login.goto();
  72 | 
  73 |     // Step 1: username injection payload is accepted as literal text.
  74 |     await login.typeUsername("' OR '1'='1");
  75 |     await login.expectUsernameValue("' OR '1'='1");
  76 | 
  77 |     // Step 2: password payload is accepted and masked.
  78 |     await login.typePassword("admin' --");
  79 |     await login.expectPasswordMasked();
  80 | 
  81 |     // Step 3: authentication fails with the exact 'Invalid credentials' message.
  82 |     await login.submit();
  83 |     await login.expectInvalidCredentials();
  84 | 
  85 |     // Step 4: no SQL/DB error, framework version, or stack trace leaks; still on login page; no session.
  86 |     const html = await page.content();
  87 |     expect(
  88 |       html,
  89 |       'page must not leak SQL/DB errors, framework internals, or stack traces'
  90 |     ).not.toMatch(/SQL syntax|SQLSTATE|Doctrine|Symfony|stack trace|stacktrace|Uncaught|Fatal error|PDOException|ORA-|You have an error in your SQL/i);
  91 |     await login.expectStillOnLoginPage();
  92 |     await login.expectNoSessionCookie();
  93 |   });
  94 | });
  95 | 
```