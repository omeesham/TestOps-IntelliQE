# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-010-nonadmin-denied-admin-url.spec.ts >> TC-010 - Server-side authorization for admin-only routes >> non-admin user is denied admin access at the UI, route, and API layers
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-6CF4ED70-6D3A-4B40-895E-3EB92AB03C63-1782398745504\tests\tc-010-nonadmin-denied-admin-url.spec.ts:63:7

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /dashboard/
Received string:  "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"
Timeout: 5000ms

Call log:
  - Expect "toHaveURL" with timeout 5000ms
    8 × unexpected value "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"

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
  3  | const BASE_URL = 'https://opensource-demo.orangehrmlive.com';
  4  | const LOGIN_URL = `${BASE_URL}/web/index.php/auth/login`;
  5  | const ADMIN_URL = `${BASE_URL}/web/index.php/admin/viewSystemUsers`;
  6  | // Server-side data endpoint that backs the admin System Users screen.
  7  | const ADMIN_API_URL = `${BASE_URL}/web/index.php/api/v2/admin/users`;
  8  | 
  9  | class LoginPage {
  10 |   readonly page: Page;
  11 |   readonly usernameInput: Locator;
  12 |   readonly passwordInput: Locator;
  13 |   readonly loginButton: Locator;
  14 | 
  15 |   constructor(page: Page) {
  16 |     this.page = page;
  17 |     this.usernameInput = page.getByPlaceholder('Username');
  18 |     this.passwordInput = page.getByPlaceholder('Password');
  19 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  20 |   }
  21 | 
  22 |   async goto(): Promise<void> {
  23 |     await this.page.goto(LOGIN_URL);
  24 |     await expect(this.usernameInput).toBeVisible();
  25 |   }
  26 | 
  27 |   async login(username: string, password: string): Promise<void> {
  28 |     await this.usernameInput.fill(username);
  29 |     await this.passwordInput.fill(password);
  30 |     await this.loginButton.click();
  31 |   }
  32 | }
  33 | 
  34 | class DashboardPage {
  35 |   readonly page: Page;
  36 |   readonly dashboardHeading: Locator;
  37 |   readonly adminMenu: Locator;
  38 |   readonly systemUsersHeading: Locator;
  39 | 
  40 |   constructor(page: Page) {
  41 |     this.page = page;
  42 |     this.dashboardHeading = page.getByRole('heading', { name: 'Dashboard' });
  43 |     this.adminMenu = page.getByRole('link', { name: 'Admin' });
  44 |     this.systemUsersHeading = page.getByRole('heading', { name: 'System Users' });
  45 |   }
  46 | 
  47 |   async expectLoaded(): Promise<void> {
> 48 |     await expect(this.page).toHaveURL(/dashboard/);
     |                             ^ Error: expect(page).toHaveURL(expected) failed
  49 |     await expect(this.dashboardHeading).toBeVisible();
  50 |   }
  51 | 
  52 |   async expectAdminMenuHidden(): Promise<void> {
  53 |     await expect(this.adminMenu).toHaveCount(0);
  54 |   }
  55 | 
  56 |   async expectAdminScreenNotRendered(): Promise<void> {
  57 |     // The admin-only System Users management screen must never render for a non-admin user.
  58 |     await expect(this.systemUsersHeading).toHaveCount(0);
  59 |   }
  60 | }
  61 | 
  62 | test.describe('TC-010 - Server-side authorization for admin-only routes', () => {
  63 |   test('non-admin user is denied admin access at the UI, route, and API layers', async ({ page }) => {
  64 |     // Step 1: Log in as the standard non-admin user -> Dashboard reached, Admin menu hidden.
  65 |     const loginPage = new LoginPage(page);
  66 |     await loginPage.goto();
  67 |     await loginPage.login('ess.user', 'ESSpass@123');
  68 | 
  69 |     const dashboard = new DashboardPage(page);
  70 |     await dashboard.expectLoaded();
  71 |     await dashboard.expectAdminMenuHidden();
  72 | 
  73 |     // Step 2: Manually navigate to the admin-only URL -> access blocked, admin screen not rendered.
  74 |     await page.goto(ADMIN_URL);
  75 |     await expect(this_isNotAdmin(page), 'User must not land on the admin System Users page').toBeTruthy();
  76 |     await dashboard.expectAdminScreenNotRendered();
  77 | 
  78 |     // Step 3: Direct API call using the user's authenticated session -> server returns 403/unauthorized.
  79 |     // page.request shares the browser context's session cookies, so this exercises real server-side authz.
  80 |     const apiResponse = await page.request.get(ADMIN_API_URL, { maxRedirects: 0 });
  81 |     expect(
  82 |       [401, 403].includes(apiResponse.status()),
  83 |       `Admin API must reject the non-admin session, received status ${apiResponse.status()}`
  84 |     ).toBeTruthy();
  85 |   });
  86 | });
  87 | 
  88 | /**
  89 |  * Helper: confirms the browser is NOT showing the admin route. A correctly authorized
  90 |  * application either 403s or redirects the user away from the admin path.
  91 |  */
  92 | function this_isNotAdmin(page: Page): boolean {
  93 |   return !page.url().includes('/admin/viewSystemUsers');
  94 | }
  95 | 
```