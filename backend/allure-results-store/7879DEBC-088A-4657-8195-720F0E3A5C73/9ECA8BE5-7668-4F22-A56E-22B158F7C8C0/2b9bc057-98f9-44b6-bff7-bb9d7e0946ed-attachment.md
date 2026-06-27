# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-011-required-validation-screen-reader-live-region.spec.ts >> TC-011 - "Required" validation announced to screen readers via accessible live region >> keyboard-reachable, visibly focusable, and announced to assistive technology (WCAG 2.1 AA)
- Location: ..\..\..\..\Users\VAMSEE~1\AppData\Local\Temp\jbs-pwexec-9ECA8BE5-7668-4F22-A56E-22B158F7C8C0-1782550083607\tests\tc-011-required-validation-screen-reader-live-region.spec.ts:97:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByLabel('Password', { exact: true })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByLabel('Password', { exact: true })

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
            - textbox "Username" [active] [ref=e23]
          - generic [ref=e25]:
            - generic [ref=e26]:
              - generic [ref=e27]: 
              - generic [ref=e28]: Password
            - textbox "Password" [ref=e30]
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
  1   | import { test, expect, type Page, type Locator } from '@playwright/test';
  2   | 
  3   | /**
  4   |  * Page Object for the OrangeHRM login screen.
  5   |  * All locators are accessibility-first and declared once in the constructor.
  6   |  */
  7   | class LoginPage {
  8   |   readonly page: Page;
  9   |   readonly usernameInput: Locator;
  10  |   readonly passwordInput: Locator;
  11  |   readonly loginButton: Locator;
  12  |   readonly requiredMessages: Locator;
  13  | 
  14  |   constructor(page: Page) {
  15  |     this.page = page;
  16  |     // Accessibility-first locators: the OrangeHRM fields expose their labels as accessible names.
  17  |     this.usernameInput = page.getByRole('textbox', { name: 'Username' });
  18  |     this.passwordInput = page.getByLabel('Password', { exact: true });
  19  |     this.loginButton = page.getByRole('button', { name: 'Login' });
  20  |     // Each empty-field validation surfaces a 'Required' message.
  21  |     this.requiredMessages = page.getByText('Required', { exact: true });
  22  |   }
  23  | 
  24  |   async goto(): Promise<void> {
  25  |     await this.page.goto('https://opensource-demo.orangehrmlive.com/web/index.php/auth/login');
  26  |     await expect(this.usernameInput).toBeVisible();
> 27  |     await expect(this.passwordInput).toBeVisible();
      |                                      ^ Error: expect(locator).toBeVisible() failed
  28  |     await expect(this.loginButton).toBeVisible();
  29  |   }
  30  | 
  31  |   /** Step 1: drive focus through the form using the keyboard only and assert the focus order. */
  32  |   async tabThroughFormFromUrlBar(): Promise<void> {
  33  |     // Start from a known, neutral focus point (the document body) so Tab order is deterministic.
  34  |     await this.usernameInput.click();
  35  |     await expect(this.usernameInput).toBeFocused();
  36  | 
  37  |     await this.page.keyboard.press('Tab');
  38  |     await expect(this.passwordInput).toBeFocused();
  39  | 
  40  |     await this.page.keyboard.press('Tab');
  41  |     await expect(this.loginButton).toBeFocused();
  42  |   }
  43  | 
  44  |   /** Step 2: submit the empty form by activating the focused Login button with Enter. */
  45  |   async submitEmptyFormWithEnterKey(): Promise<void> {
  46  |     await expect(this.loginButton).toBeFocused();
  47  |     await this.page.keyboard.press('Enter');
  48  |   }
  49  | 
  50  |   /** Step 2 assertion: a 'Required' message appears beneath both empty fields. */
  51  |   async expectRequiredMessagesUnderBothFields(): Promise<void> {
  52  |     await expect(this.requiredMessages).toHaveCount(2);
  53  |     await expect(this.requiredMessages.first()).toBeVisible();
  54  |     await expect(this.requiredMessages.last()).toBeVisible();
  55  |   }
  56  | 
  57  |   /**
  58  |    * Step 3 assertion: each 'Required' message must be announced to assistive technology.
  59  |    * It is conformant if the message itself (or an ancestor) carries a live-region role/attribute
  60  |    * (role=alert | aria-live), which is how a screen reader picks up the dynamically inserted error.
  61  |    */
  62  |   async expectMessagesAnnouncedViaLiveRegion(): Promise<void> {
  63  |     const count = await this.requiredMessages.count();
  64  |     expect(count).toBe(2);
  65  | 
  66  |     for (let i = 0; i < count; i++) {
  67  |       const message = this.requiredMessages.nth(i); // iterating the asserted error set; no positional shortcut for finding it
  68  |       const isAnnounced = await message.evaluate((node: Element) => {
  69  |         const isLiveRegion = (el: Element | null): boolean => {
  70  |           while (el) {
  71  |             const role = el.getAttribute('role');
  72  |             const live = el.getAttribute('aria-live');
  73  |             if (role === 'alert' || role === 'status') return true;
  74  |             if (live === 'assertive' || live === 'polite') return true;
  75  |             el = el.parentElement;
  76  |           }
  77  |           return false;
  78  |         };
  79  |         return isLiveRegion(node);
  80  |       });
  81  |       expect(
  82  |         isAnnounced,
  83  |         'Each "Required" message must sit in a live region (role=alert/status or aria-live) so screen readers announce it.',
  84  |       ).toBe(true);
  85  |     }
  86  |   }
  87  | }
  88  | 
  89  | test.describe('TC-011 - "Required" validation announced to screen readers via accessible live region', () => {
  90  |   let loginPage: LoginPage;
  91  | 
  92  |   test.beforeEach(async ({ page }) => {
  93  |     loginPage = new LoginPage(page);
  94  |     await loginPage.goto();
  95  |   });
  96  | 
  97  |   test('keyboard-reachable, visibly focusable, and announced to assistive technology (WCAG 2.1 AA)', async () => {
  98  |     // Step 1 - Keyboard-only navigation moves focus through Username -> Password -> Login.
  99  |     await loginPage.tabThroughFormFromUrlBar();
  100 | 
  101 |     // Step 2 - Submitting the empty form with Enter reveals the 'Required' messages beneath both fields.
  102 |     await loginPage.submitEmptyFormWithEnterKey();
  103 |     await loginPage.expectRequiredMessagesUnderBothFields();
  104 | 
  105 |     // Step 3 - Each 'Required' message is exposed through a live region for screen-reader announcement.
  106 |     await loginPage.expectMessagesAnnouncedViaLiveRegion();
  107 |   });
  108 | });
  109 | 
```