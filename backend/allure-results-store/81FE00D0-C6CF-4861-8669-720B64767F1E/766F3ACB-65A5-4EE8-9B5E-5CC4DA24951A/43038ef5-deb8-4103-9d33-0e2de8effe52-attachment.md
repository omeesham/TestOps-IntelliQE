# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-010-xss-username.spec.ts >> TC-010 - XSS payload in Username field >> XSS payload is not executed and is rendered inert or rejected
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-766F3ACB-65A5-4EE8-9B5E-5CC4DA24951A-1782822820482\tests\tc-010-xss-username.spec.ts:64:7

# Error details

```
Error: expect(received).toBeTruthy()

Received: false
```

# Test source

```ts
  1   | import { test, expect, type Page, type Locator } from '@playwright/test';
  2   | 
  3   | const LOGIN_URL =
  4   |   'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login';
  5   | 
  6   | class LoginPage {
  7   |   readonly page: Page;
  8   |   readonly usernameInput: Locator;
  9   |   readonly passwordInput: Locator;
  10  |   readonly loginButton: Locator;
  11  |   readonly errorAlert: Locator;
  12  |   readonly pageBody: Locator;
  13  | 
  14  |   constructor(page: Page) {
  15  |     this.page = page;
  16  |     this.usernameInput = page.getByPlaceholder('Username');
  17  |     this.passwordInput = page.getByPlaceholder('Password');
  18  |     this.loginButton = page.getByRole('button', { name: 'Login' });
  19  |     this.errorAlert = page.getByText('Invalid credentials', { exact: true });
  20  |     this.pageBody = page.locator('body');
  21  |   }
  22  | 
  23  |   async goto(): Promise<void> {
  24  |     await this.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  25  |   }
  26  | 
  27  |   async expectLoaded(): Promise<void> {
  28  |     await expect(this.usernameInput).toBeVisible();
  29  |     await expect(this.passwordInput).toBeVisible();
  30  |     await expect(this.loginButton).toBeVisible();
  31  |   }
  32  | 
  33  |   async enterUsername(value: string): Promise<void> {
  34  |     await this.usernameInput.fill(value);
  35  |     await expect(this.usernameInput).toHaveValue(value);
  36  |   }
  37  | 
  38  |   async enterPassword(value: string): Promise<void> {
  39  |     await this.passwordInput.fill(value);
  40  |     await expect(this.passwordInput).toHaveValue(value);
  41  |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  42  |   }
  43  | 
  44  |   async submit(): Promise<void> {
  45  |     await this.loginButton.click();
  46  |   }
  47  | 
  48  |   async expectInertOrRejected(): Promise<void> {
  49  |     // Either an Invalid credentials / validation message is shown,
  50  |     // and the literal <script> tag is NOT present as live HTML in the DOM.
  51  |     const scriptInjected = this.page.locator(
  52  |       'script:has-text("alert(\'xss\')")'
  53  |     );
  54  |     await expect(scriptInjected).toHaveCount(0);
  55  | 
  56  |     const bodyText = (await this.pageBody.innerText()).toString();
  57  |     const hasInvalid = /Invalid credentials/i.test(bodyText);
  58  |     const hasValidation = /Required/i.test(bodyText);
> 59  |     expect(hasInvalid || hasValidation).toBeTruthy();
      |                                         ^ Error: expect(received).toBeTruthy()
  60  |   }
  61  | }
  62  | 
  63  | test.describe('TC-010 - XSS payload in Username field', () => {
  64  |   test('XSS payload is not executed and is rendered inert or rejected', async ({
  65  |     page,
  66  |   }) => {
  67  |     const username = "<script>alert('xss')</script>";
  68  |     const password = 'anything123';
  69  | 
  70  |     let dialogFired = false;
  71  |     // Guard: if any JS alert dialog fires, the XSS executed -> fail.
  72  |     page.on('dialog', async (dialog) => {
  73  |       dialogFired = true;
  74  |       await dialog.dismiss();
  75  |     });
  76  | 
  77  |     const loginPage = new LoginPage(page);
  78  | 
  79  |     // Step 1: Navigate to login page.
  80  |     await loginPage.goto();
  81  |     await loginPage.expectLoaded();
  82  | 
  83  |     // Step 2: Enter XSS payload into Username; no alert at this point.
  84  |     await loginPage.enterUsername(username);
  85  |     expect(dialogFired, 'No alert should fire on input').toBeFalsy();
  86  | 
  87  |     // Step 3: Enter password (masked).
  88  |     await loginPage.enterPassword(password);
  89  | 
  90  |     // Step 4: Submit form; no alert should be triggered.
  91  |     await loginPage.submit();
  92  | 
  93  |     // Step 5: Confirm no JavaScript alert dialog appeared.
  94  |     expect(dialogFired, 'XSS alert must not execute').toBeFalsy();
  95  | 
  96  |     // Step 6: Error shown as plain text; script not rendered as live HTML.
  97  |     await loginPage.expectInertOrRejected();
  98  |     expect(dialogFired, 'XSS alert must not execute at any point').toBeFalsy();
  99  |   });
  100 | });
  101 | 
```