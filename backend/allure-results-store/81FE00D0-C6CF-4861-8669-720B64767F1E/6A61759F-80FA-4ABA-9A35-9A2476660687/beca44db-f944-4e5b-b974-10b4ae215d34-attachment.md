# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-002-login-fails-with-invalid-credentials.spec.ts >> TC-002 - Invalid Credentials Error Handling >> Verify login fails with valid username and wrong password showing exact 'Invalid credentials' message
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-6A61759F-80FA-4ABA-9A35-9A2476660687-1782467247131\tests\tc-002-login-fails-with-invalid-credentials.spec.ts:61:7

# Error details

```
Error: expect(received).toBeFalsy()

Received: true
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
  5  | class LoginPage {
  6  |   readonly page: Page;
  7  |   readonly usernameInput: Locator;
  8  |   readonly passwordInput: Locator;
  9  |   readonly loginButton: Locator;
  10 |   readonly errorAlert: Locator;
  11 | 
  12 |   constructor(page: Page) {
  13 |     this.page = page;
  14 |     this.usernameInput = page.getByPlaceholder('Username');
  15 |     this.passwordInput = page.getByPlaceholder('Password');
  16 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  17 |     this.errorAlert = page.getByRole('alert');
  18 |   }
  19 | 
  20 |   async goto(): Promise<void> {
  21 |     await this.page.goto(LOGIN_URL);
  22 |   }
  23 | 
  24 |   async expectFormEmpty(): Promise<void> {
  25 |     await expect(this.usernameInput).toBeVisible();
  26 |     await expect(this.passwordInput).toBeVisible();
  27 |     await expect(this.usernameInput).toHaveValue('');
  28 |     await expect(this.passwordInput).toHaveValue('');
  29 |   }
  30 | 
  31 |   async enterUsername(username: string): Promise<void> {
  32 |     await this.usernameInput.fill(username);
  33 |     await expect(this.usernameInput).toHaveValue(username);
  34 |   }
  35 | 
  36 |   async enterPassword(password: string): Promise<void> {
  37 |     await this.passwordInput.fill(password);
  38 |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  39 |   }
  40 | 
  41 |   async submit(): Promise<void> {
  42 |     await this.loginButton.click();
  43 |   }
  44 | 
  45 |   async expectInvalidCredentialsError(): Promise<void> {
  46 |     await expect(this.errorAlert).toBeVisible();
  47 |     await expect(this.errorAlert).toHaveText('Invalid credentials');
  48 |   }
  49 | 
  50 |   async expectStillOnLoginPage(): Promise<void> {
  51 |     await expect(this.page).toHaveURL(/\/auth\/login/);
  52 |   }
  53 | 
  54 |   async expectNoSessionCookie(): Promise<void> {
  55 |     const cookies = await this.page.context().cookies();
> 56 |     expect(cookies.some((c) => c.name === 'orangehrm')).toBeFalsy();
     |                                                         ^ Error: expect(received).toBeFalsy()
  57 |   }
  58 | }
  59 | 
  60 | test.describe('TC-002 - Invalid Credentials Error Handling', () => {
  61 |   test("Verify login fails with valid username and wrong password showing exact 'Invalid credentials' message", async ({ page }) => {
  62 |     const loginPage = new LoginPage(page);
  63 | 
  64 |     // Step 1: Navigate and verify empty login form
  65 |     await loginPage.goto();
  66 |     await loginPage.expectFormEmpty();
  67 | 
  68 |     // Step 2: Enter a valid username
  69 |     await loginPage.enterUsername('Admin');
  70 | 
  71 |     // Step 3: Enter an invalid (masked) password
  72 |     await loginPage.enterPassword('Invalid123');
  73 | 
  74 |     // Step 4: Submit and expect the exact 'Invalid credentials' error banner
  75 |     await loginPage.submit();
  76 |     await loginPage.expectInvalidCredentialsError();
  77 | 
  78 |     // Step 5: Verify the user stays on the login page and no session is created
  79 |     await loginPage.expectStillOnLoginPage();
  80 |     await loginPage.expectNoSessionCookie();
  81 |   });
  82 | });
  83 | 
```