# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: login-invalid-credentials.spec.ts >> OrangeHRM Login - TC-002 invalid credentials error handling >> Verify login fails with valid username and wrong password showing generic 'Invalid credentials'
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-FEDF6490-3CE7-4997-8CB9-A0ED32B033C5-1782401131580\tests\login-invalid-credentials.spec.ts:74:7

# Error details

```
Error: no authenticated session cookie should be created

expect(received).toBeFalsy()

Received: {"domain": "opensource-demo.orangehrmlive.com", "expires": -1, "httpOnly": true, "name": "orangehrm", "path": "/web", "sameSite": "Lax", "secure": true, "value": "qv8fckamtk1tli2pru3tkd20a6"}
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
  6  |  * Page Object for the OrangeHRM Login screen with invalid-credential handling.
  7  |  */
  8  | class LoginPage {
  9  |   readonly page: Page;
  10 |   readonly usernameInput: Locator;
  11 |   readonly passwordInput: Locator;
  12 |   readonly loginButton: Locator;
  13 |   readonly errorAlert: Locator;
  14 | 
  15 |   constructor(page: Page) {
  16 |     this.page = page;
  17 |     this.usernameInput = page.getByPlaceholder('Username');
  18 |     this.passwordInput = page.getByPlaceholder('Password');
  19 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  20 |     // OrangeHRM surfaces auth failures in an ARIA alert banner.
  21 |     this.errorAlert = page.getByRole('alert');
  22 |   }
  23 | 
  24 |   async goto(): Promise<void> {
  25 |     await this.page.goto(LOGIN_URL);
  26 |   }
  27 | 
  28 |   async expectEmptyForm(): Promise<void> {
  29 |     await expect(this.usernameInput).toBeVisible();
  30 |     await expect(this.usernameInput).toHaveValue('');
  31 |     await expect(this.passwordInput).toBeVisible();
  32 |     await expect(this.passwordInput).toHaveValue('');
  33 |   }
  34 | 
  35 |   async enterUsername(username: string): Promise<void> {
  36 |     await this.usernameInput.fill(username);
  37 |     await expect(this.usernameInput).toHaveValue(username);
  38 |   }
  39 | 
  40 |   async enterPassword(password: string): Promise<void> {
  41 |     await this.passwordInput.fill(password);
  42 |     await expect(this.passwordInput).toHaveValue(password);
  43 |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  44 |   }
  45 | 
  46 |   async submit(): Promise<void> {
  47 |     await this.loginButton.click();
  48 |   }
  49 | 
  50 |   async login(username: string, password: string): Promise<void> {
  51 |     await this.enterUsername(username);
  52 |     await this.enterPassword(password);
  53 |     await this.submit();
  54 |   }
  55 | 
  56 |   async expectInvalidCredentialsError(): Promise<void> {
  57 |     await expect(this.errorAlert).toBeVisible();
  58 |     // Message must be the exact generic text, not field-specific.
  59 |     await expect(this.errorAlert).toHaveText('Invalid credentials');
  60 |   }
  61 | 
  62 |   async expectStillOnLoginPage(): Promise<void> {
  63 |     await expect(this.page).toHaveURL(/\/web\/index\.php\/auth\/login/);
  64 |   }
  65 | 
  66 |   async expectNoSessionCookie(): Promise<void> {
  67 |     const cookies = await this.page.context().cookies();
  68 |     const sessionCookie = cookies.find((c) => /orangehrm/i.test(c.name));
> 69 |     expect(sessionCookie, 'no authenticated session cookie should be created').toBeFalsy();
     |                                                                                ^ Error: no authenticated session cookie should be created
  70 |   }
  71 | }
  72 | 
  73 | test.describe('OrangeHRM Login - TC-002 invalid credentials error handling', () => {
  74 |   test("Verify login fails with valid username and wrong password showing generic 'Invalid credentials'", async ({ page }) => {
  75 |     const loginPage = new LoginPage(page);
  76 | 
  77 |     // Step 1: navigate to the login page with empty fields.
  78 |     await loginPage.goto();
  79 |     await loginPage.expectEmptyForm();
  80 | 
  81 |     // Steps 2-4: submit a valid username with a wrong password.
  82 |     await loginPage.login('Admin', 'Invalid123');
  83 | 
  84 |     // Step 4 & 5: generic error, still on login page, no session.
  85 |     await loginPage.expectInvalidCredentialsError();
  86 |     await loginPage.expectStillOnLoginPage();
  87 |     await loginPage.expectNoSessionCookie();
  88 |   });
  89 | });
  90 | 
```