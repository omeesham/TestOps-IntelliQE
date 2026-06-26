# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: repeated-failed-logins-trigger-lockout.spec.ts >> TC-011 — Brute-force login protection >> repeated failed logins trigger rate limiting or lockout
- Location: ..\..\..\Users\VAMSEE~1\AppData\Local\Temp\jbs-pwexec-589F2795-92D6-4013-B667-664595C13BBB-1782455787467\tests\repeated-failed-logins-trigger-lockout.spec.ts:54:7

# Error details

```
Error: expect(locator).not.toHaveText(expected) failed

Locator:  getByRole('alert')
Expected: not "Invalid credentials"
Received: "Invalid credentials"
Timeout:  5000ms

Call log:
  - Expect "not toHaveText" with timeout 5000ms
  - waiting for getByRole('alert')
    9 × locator resolved to <div role="alert" data-v-87fcf455="" data-v-0af708be="" class="oxd-alert oxd-alert--error">…</div>
      - unexpected value "Invalid credentials"

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
  4  |  * TC-011 — Verify repeated failed logins for the same account trigger rate
  5  |  * limiting or lockout (inferred brute-force protection control).
  6  |  */
  7  | class LoginPage {
  8  |   readonly page: Page;
  9  |   readonly usernameInput: Locator;
  10 |   readonly passwordInput: Locator;
  11 |   readonly loginButton: Locator;
  12 |   readonly errorAlert: Locator;
  13 | 
  14 |   constructor(page: Page) {
  15 |     this.page = page;
  16 |     this.usernameInput = page.getByPlaceholder('Username');
  17 |     this.passwordInput = page.getByPlaceholder('Password');
  18 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  19 |     this.errorAlert = page.getByRole('alert');
  20 |   }
  21 | 
  22 |   async goto(): Promise<void> {
  23 |     await this.page.goto('https://opensource-demo.orangehrmlive.com/web/index.php/auth/login');
  24 |   }
  25 | 
  26 |   async login(username: string, password: string): Promise<void> {
  27 |     await this.usernameInput.fill(username);
  28 |     await this.passwordInput.fill(password);
  29 |     await this.loginButton.click();
  30 |   }
  31 | 
  32 |   async expectInvalidCredentials(): Promise<void> {
  33 |     await expect(this.errorAlert).toBeVisible();
  34 |     await expect(this.errorAlert).toContainText('Invalid credentials');
  35 |   }
  36 | 
  37 |   async expectThrottled(): Promise<void> {
  38 |     // Security control under test: beyond the threshold the server must surface
  39 |     // a lockout / too-many-attempts / CAPTCHA / delay signal rather than another
  40 |     // plain 'Invalid credentials' message.
  41 |     await expect(this.errorAlert).toBeVisible();
> 42 |     await expect(this.errorAlert).not.toHaveText('Invalid credentials');
     |                                       ^ Error: expect(locator).not.toHaveText(expected) failed
  43 |   }
  44 | 
  45 |   async expectStillBlocked(): Promise<void> {
  46 |     // Even a correct password must NOT authenticate while throttled.
  47 |     await expect(this.page).not.toHaveURL(/dashboard/);
  48 |   }
  49 | }
  50 | 
  51 | test.describe('TC-011 — Brute-force login protection', () => {
  52 |   const THRESHOLD = 5;
  53 | 
  54 |   test('repeated failed logins trigger rate limiting or lockout', async ({ page }) => {
  55 |     const login = new LoginPage(page);
  56 |     await login.goto();
  57 | 
  58 |     // Steps 1 & 2 — each attempt up to the threshold returns 'Invalid credentials'.
  59 |     for (let attempt = 1; attempt <= THRESHOLD; attempt++) {
  60 |       await login.login('Admin', 'WrongPass!00');
  61 |       await login.expectInvalidCredentials();
  62 |     }
  63 | 
  64 |     // Step 3 — one more failed attempt beyond the threshold must be throttled.
  65 |     await login.login('Admin', 'WrongPass!00');
  66 |     await login.expectThrottled();
  67 | 
  68 |     // Step 4 — a correct password must remain blocked while throttled,
  69 |     // confirming the control is enforced server-side.
  70 |     await login.login('Admin', 'admin123');
  71 |     await login.expectStillBlocked();
  72 |   });
  73 | });
  74 | 
```