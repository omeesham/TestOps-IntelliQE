# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: login-blank-username-required.spec.ts >> OrangeHRM Login - TC-004 blank username validation >> Verify blank username with valid password shows single 'Required' under Username only
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-FEDF6490-3CE7-4997-8CB9-A0ED32B033C5-1782401131580\tests\login-blank-username-required.spec.ts:80:7

# Error details

```
Error: no session should be created when validation blocks submit

expect(received).toBeFalsy()

Received: {"domain": "opensource-demo.orangehrmlive.com", "expires": -1, "httpOnly": true, "name": "orangehrm", "path": "/web", "sameSite": "Lax", "secure": true, "value": "sdtgr3r0v96020gnofe0j65717"}
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
            - textbox "Password" [ref=e31]: admin123
          - button "Login" [active] [ref=e33] [cursor=pointer]
          - paragraph [ref=e35] [cursor=pointer]: Forgot your password?
      - generic [ref=e36]:
        - generic [ref=e37]:
          - link [ref=e38] [cursor=pointer]:
            - /url: https://www.linkedin.com/company/orangehrm/mycompany/
          - link [ref=e41] [cursor=pointer]:
            - /url: https://www.facebook.com/OrangeHRM/
          - link [ref=e44] [cursor=pointer]:
            - /url: https://twitter.com/orangehrm?lang=en
          - link [ref=e47] [cursor=pointer]:
            - /url: https://www.youtube.com/c/OrangeHRMInc
        - generic [ref=e50]:
          - paragraph [ref=e51]: OrangeHRM OS 5.8
          - paragraph [ref=e52]:
            - text: © 2005 - 2026
            - link "OrangeHRM, Inc" [ref=e53] [cursor=pointer]:
              - /url: http://www.orangehrm.com
            - text: . All rights reserved.
  - img "orangehrm-logo" [ref=e55]
```

# Test source

```ts
  1   | import { test, expect, type Page, type Locator } from '@playwright/test';
  2   | 
  3   | const LOGIN_URL = 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login';
  4   | 
  5   | /**
  6   |  * Page Object for the OrangeHRM Login screen focused on single-field validation.
  7   |  */
  8   | class LoginPage {
  9   |   readonly page: Page;
  10  |   readonly usernameInput: Locator;
  11  |   readonly passwordInput: Locator;
  12  |   readonly loginButton: Locator;
  13  |   readonly requiredMessages: Locator;
  14  |   readonly usernameRequiredMessage: Locator;
  15  |   readonly passwordRequiredMessage: Locator;
  16  | 
  17  |   constructor(page: Page) {
  18  |     this.page = page;
  19  |     this.usernameInput = page.getByPlaceholder('Username');
  20  |     this.passwordInput = page.getByPlaceholder('Password');
  21  |     this.loginButton = page.getByRole('button', { name: 'Login' });
  22  |     this.requiredMessages = page.getByText('Required');
  23  |     // No accessible error->field association exists on OrangeHRM, so scope each
  24  |     // validation message by the input group that contains its field.
  25  |     this.usernameRequiredMessage = page
  26  |       .locator('.oxd-input-group')
  27  |       .filter({ has: this.usernameInput })
  28  |       .getByText('Required');
  29  |     this.passwordRequiredMessage = page
  30  |       .locator('.oxd-input-group')
  31  |       .filter({ has: this.passwordInput })
  32  |       .getByText('Required');
  33  |   }
  34  | 
  35  |   async goto(): Promise<void> {
  36  |     await this.page.goto(LOGIN_URL);
  37  |   }
  38  | 
  39  |   async expectEmptyForm(): Promise<void> {
  40  |     await expect(this.usernameInput).toBeVisible();
  41  |     await expect(this.usernameInput).toHaveValue('');
  42  |     await expect(this.passwordInput).toBeVisible();
  43  |     await expect(this.passwordInput).toHaveValue('');
  44  |   }
  45  | 
  46  |   async enterPassword(password: string): Promise<void> {
  47  |     await this.passwordInput.fill(password);
  48  |     await expect(this.passwordInput).toHaveValue(password);
  49  |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  50  |   }
  51  | 
  52  |   async expectUsernameEmpty(): Promise<void> {
  53  |     await expect(this.usernameInput).toHaveValue('');
  54  |   }
  55  | 
  56  |   async submit(): Promise<void> {
  57  |     await this.loginButton.click();
  58  |   }
  59  | 
  60  |   async expectOnlyUsernameRequired(): Promise<void> {
  61  |     await expect(this.usernameRequiredMessage).toBeVisible();
  62  |     // No validation message under the Password field.
  63  |     await expect(this.passwordRequiredMessage).toHaveCount(0);
  64  |     // Exactly one 'Required' message on the whole form.
  65  |     await expect(this.requiredMessages).toHaveCount(1);
  66  |   }
  67  | 
  68  |   async expectStillOnLoginPage(): Promise<void> {
  69  |     await expect(this.page).toHaveURL(/\/web\/index\.php\/auth\/login/);
  70  |   }
  71  | 
  72  |   async expectNoSessionCookie(): Promise<void> {
  73  |     const cookies = await this.page.context().cookies();
  74  |     const sessionCookie = cookies.find((c) => /orangehrm/i.test(c.name));
> 75  |     expect(sessionCookie, 'no session should be created when validation blocks submit').toBeFalsy();
      |                                                                                         ^ Error: no session should be created when validation blocks submit
  76  |   }
  77  | }
  78  | 
  79  | test.describe('OrangeHRM Login - TC-004 blank username validation', () => {
  80  |   test("Verify blank username with valid password shows single 'Required' under Username only", async ({ page }) => {
  81  |     const loginPage = new LoginPage(page);
  82  | 
  83  |     // Step 1: navigate with empty fields.
  84  |     await loginPage.goto();
  85  |     await loginPage.expectEmptyForm();
  86  | 
  87  |     // Step 2: leave username empty, fill a valid password.
  88  |     await loginPage.enterPassword('admin123');
  89  |     await loginPage.expectUsernameEmpty();
  90  | 
  91  |     // Step 3: submit.
  92  |     await loginPage.submit();
  93  | 
  94  |     // Steps 3-4: single 'Required' under Username only, no auth request.
  95  |     await loginPage.expectOnlyUsernameRequired();
  96  |     await loginPage.expectStillOnLoginPage();
  97  |     await loginPage.expectNoSessionCookie();
  98  |   });
  99  | });
  100 | 
```