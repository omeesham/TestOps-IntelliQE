# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: login-password-masking.spec.ts >> TC-005 - Password is always masked and not exposed in the DOM >> keeps the password type=password and never renders the plaintext value
- Location: ..\..\..\Users\VAMSEE~1\AppData\Local\Temp\jbs-pwexec-196BB0C2-8075-43DA-861D-055A1881134D-1782391300802\tests\login-password-masking.spec.ts:49:7

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  getByText('admin123')
Expected: 0
Received: 1
Timeout:  5000ms

Call log:
  - Expect "toHaveCount" with timeout 5000ms
  - waiting for getByText('admin123')
    9 × locator resolved to 1 element
      - unexpected value "1"

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
          - generic [ref=e25]:
            - generic [ref=e26]:
              - generic [ref=e27]: 
              - generic [ref=e28]: Password
            - textbox "Password" [active] [ref=e30]: admin123
          - button "Login" [ref=e32] [cursor=pointer]
          - paragraph [ref=e34] [cursor=pointer]: Forgot your password?
      - generic [ref=e35]:
        - generic [ref=e36]:
          - link [ref=e37] [cursor=pointer]:
            - /url: https://www.linkedin.com/company/orangehrm/mycompany/
          - link [ref=e40] [cursor=pointer]:
            - /url: https://www.facebook.com/OrangeHRM/
          - link [ref=e43] [cursor=pointer]:
            - /url: https://twitter.com/orangehrm?lang=en
          - link [ref=e46] [cursor=pointer]:
            - /url: https://www.youtube.com/c/OrangeHRMInc
        - generic [ref=e49]:
          - paragraph [ref=e50]: OrangeHRM OS 5.8
          - paragraph [ref=e51]:
            - text: © 2005 - 2026
            - link "OrangeHRM, Inc" [ref=e52] [cursor=pointer]:
              - /url: http://www.orangehrm.com
            - text: . All rights reserved.
  - img "orangehrm-logo" [ref=e54]
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
  10 | 
  11 |   constructor(page: Page) {
  12 |     this.page = page;
  13 |     this.usernameInput = page.getByRole('textbox', { name: 'Username' });
  14 |     // Password inputs (type=password) expose no ARIA 'textbox' role, so target by placeholder.
  15 |     this.passwordInput = page.getByPlaceholder('Password');
  16 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  17 |   }
  18 | 
  19 |   async goto(): Promise<void> {
  20 |     await this.page.goto(LOGIN_URL);
  21 |   }
  22 | 
  23 |   async expectFormVisible(): Promise<void> {
  24 |     await expect(this.usernameInput).toBeVisible();
  25 |     await expect(this.passwordInput).toBeVisible();
  26 |     await expect(this.loginButton).toBeVisible();
  27 |   }
  28 | 
  29 |   async typePasswordCharByChar(password: string): Promise<void> {
  30 |     await this.passwordInput.click();
  31 |     // pressSequentially mimics real per-character typing.
  32 |     await this.passwordInput.pressSequentially(password, { delay: 50 });
  33 |     await expect(this.passwordInput).toHaveValue(password);
  34 |   }
  35 | 
  36 |   async expectMaskedType(): Promise<void> {
  37 |     // The input's masking guarantee: type attribute is always 'password'.
  38 |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  39 |   }
  40 | 
  41 |   async expectPlaintextNotExposed(plaintext: string): Promise<void> {
  42 |     // The literal value must not appear as readable text anywhere on the page
  43 |     // (page source / accessibility tree), confirming it is never rendered unmasked.
> 44 |     await expect(this.page.getByText(plaintext, { exact: false })).toHaveCount(0);
     |                                                                    ^ Error: expect(locator).toHaveCount(expected) failed
  45 |   }
  46 | }
  47 | 
  48 | test.describe('TC-005 - Password is always masked and not exposed in the DOM', () => {
  49 |   test('keeps the password type=password and never renders the plaintext value', async ({ page }) => {
  50 |     const loginPage = new LoginPage(page);
  51 |     const secret = 'admin123';
  52 | 
  53 |     // Step 1: Navigate to the login page and confirm the form renders.
  54 |     await loginPage.goto();
  55 |     await loginPage.expectFormVisible();
  56 | 
  57 |     // Step 2: Type the password character by character (renders as masked dots).
  58 |     await loginPage.typePasswordCharByChar(secret);
  59 | 
  60 |     // Step 3: Verify the input's type attribute equals 'password'.
  61 |     await loginPage.expectMaskedType();
  62 | 
  63 |     // Step 4: Verify the plaintext value is not exposed as readable text.
  64 |     await loginPage.expectPlaintextNotExposed(secret);
  65 |   });
  66 | });
  67 | 
```