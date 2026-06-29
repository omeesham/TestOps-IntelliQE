# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-001-valid-admin-login-redirects-to-dashboard.spec.ts >> TC-001 - Successful login with valid Admin credentials >> redirects to the dashboard and renders the authenticated header
- Location: ..\..\..\..\Users\VAMSEE~1\AppData\Local\Temp\jbs-pwexec-C94875F0-DA52-46E9-8E51-3E477E1AAE03-1782571560874\tests\tc-001-valid-admin-login-redirects-to-dashboard.spec.ts:76:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('banner').getByRole('button')
Expected: visible
Error: strict mode violation: getByRole('banner').getByRole('button') resolved to 2 elements:
    1) <button size="large" type="button" data-v-78cde31a="" data-v-e60dde10="" class="oxd-glass-button orangehrm-upgrade-button">…</button> aka getByRole('button', { name: 'Upgrade' })
    2) <button title="Help" type="button" data-v-f5c763eb="" class="oxd-icon-button">…</button> aka getByTitle('Help')

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for getByRole('banner').getByRole('button')

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic:
    - complementary [ref=e4]:
      - navigation "Sidepanel" [ref=e5]:
        - generic [ref=e6]:
          - link "client brand banner" [ref=e7] [cursor=pointer]:
            - /url: https://www.orangehrm.com/
            - img "client brand banner" [ref=e9]
          - text: 
        - generic [ref=e10]:
          - generic [ref=e11]:
            - generic [ref=e12]:
              - textbox "Search" [ref=e15]
              - button "" [ref=e16] [cursor=pointer]:
                - generic [ref=e17]: 
            - separator [ref=e18]
          - list [ref=e19]:
            - listitem [ref=e20]:
              - link "Admin" [ref=e21] [cursor=pointer]:
                - /url: /web/index.php/admin/viewAdminModule
                - generic [ref=e24]: Admin
            - listitem [ref=e25]:
              - link "PIM" [ref=e26] [cursor=pointer]:
                - /url: /web/index.php/pim/viewPimModule
                - generic [ref=e40]: PIM
            - listitem [ref=e41]:
              - link "Leave" [ref=e42] [cursor=pointer]:
                - /url: /web/index.php/leave/viewLeaveModule
                - generic [ref=e45]: Leave
            - listitem [ref=e46]:
              - link "Time" [ref=e47] [cursor=pointer]:
                - /url: /web/index.php/time/viewTimeModule
                - generic [ref=e53]: Time
            - listitem [ref=e54]:
              - link "Recruitment" [ref=e55] [cursor=pointer]:
                - /url: /web/index.php/recruitment/viewRecruitmentModule
                - generic [ref=e61]: Recruitment
            - listitem [ref=e62]:
              - link "My Info" [ref=e63] [cursor=pointer]:
                - /url: /web/index.php/pim/viewMyDetails
                - generic [ref=e69]: My Info
            - listitem [ref=e70]:
              - link "Performance" [ref=e71] [cursor=pointer]:
                - /url: /web/index.php/performance/viewPerformanceModule
                - generic [ref=e79]: Performance
            - listitem [ref=e80]:
              - link "Dashboard" [ref=e81] [cursor=pointer]:
                - /url: /web/index.php/dashboard/index
                - generic [ref=e84]: Dashboard
            - listitem [ref=e85]:
              - link "Directory" [ref=e86] [cursor=pointer]:
                - /url: /web/index.php/directory/viewDirectory
                - generic [ref=e89]: Directory
            - listitem [ref=e90]:
              - link "Maintenance" [ref=e91] [cursor=pointer]:
                - /url: /web/index.php/maintenance/viewMaintenanceModule
                - generic [ref=e95]: Maintenance
            - listitem [ref=e96]:
              - link "Claim" [ref=e97] [cursor=pointer]:
                - /url: /web/index.php/claim/viewClaimModule
                - img [ref=e100]
                - generic [ref=e104]: Claim
            - listitem [ref=e105]:
              - link "Buzz" [ref=e106] [cursor=pointer]:
                - /url: /web/index.php/buzz/viewBuzz
                - generic [ref=e109]: Buzz
    - banner [ref=e110]:
      - generic [ref=e111]:
        - generic [ref=e112]:
          - text: 
          - heading "Dashboard" [level=6] [ref=e114]
        - link "Upgrade" [ref=e116]:
          - /url: https://orangehrm.com/open-source/upgrade-to-advanced
          - button "Upgrade" [ref=e117] [cursor=pointer]: Upgrade
        - list [ref=e123]:
          - listitem [ref=e124]:
            - generic [ref=e125] [cursor=pointer]:
              - img "profile picture" [ref=e126]
              - paragraph [ref=e127]: Dummy Tester
              - generic [ref=e128]: 
      - navigation "Topbar Menu" [ref=e130]:
        - list [ref=e131]:
          - button "" [ref=e133] [cursor=pointer]:
            - generic [ref=e134]: 
  - generic [ref=e135]:
    - generic [ref=e137]:
      - generic [ref=e139]:
        - generic [ref=e141]:
          - generic [ref=e142]: 
          - paragraph [ref=e143]: Time at Work
        - separator [ref=e144]
        - generic [ref=e146]:
          - generic [ref=e147]:
            - img "profile picture" [ref=e149]
            - generic [ref=e150]:
              - paragraph [ref=e151]: Punched Out
              - paragraph [ref=e152]: "Punched Out: Mar 29th at 01:19 PM (GMT 7)"
          - generic [ref=e153]:
            - generic [ref=e154]: 0h 0m Today
            - button "" [ref=e155] [cursor=pointer]:
              - generic [ref=e156]: 
          - separator [ref=e157]
          - generic [ref=e158]:
            - generic [ref=e159]:
              - paragraph [ref=e160]: This Week
              - paragraph [ref=e161]: Jun 22 - Jun 28
            - generic [ref=e162]:
              - generic [ref=e163]: 
              - paragraph [ref=e164]: 0h 0m
      - generic [ref=e168]:
        - generic [ref=e170]:
          - generic [ref=e171]: 
          - paragraph [ref=e172]: My Actions
        - separator [ref=e173]
        - generic [ref=e175]:
          - img "No Content" [ref=e176]
          - paragraph [ref=e177]: No Pending Actions to Perform
      - generic [ref=e179]:
        - generic [ref=e181]:
          - generic [ref=e182]: 
          - paragraph [ref=e183]: Quick Launch
        - separator [ref=e184]
        - generic [ref=e186]:
          - generic [ref=e187]:
            - button "Assign Leave" [ref=e188] [cursor=pointer]
            - generic "Assign Leave" [ref=e191]:
              - paragraph [ref=e192]: Assign Leave
          - generic [ref=e193]:
            - button "Leave List" [ref=e194] [cursor=pointer]
            - generic "Leave List" [ref=e201]:
              - paragraph [ref=e202]: Leave List
          - generic [ref=e203]:
            - button "Timesheets" [ref=e204] [cursor=pointer]
            - generic "Timesheets" [ref=e210]:
              - paragraph [ref=e211]: Timesheets
          - generic [ref=e212]:
            - button "Apply Leave" [ref=e213] [cursor=pointer]
            - generic "Apply Leave" [ref=e216]:
              - paragraph [ref=e217]: Apply Leave
          - generic [ref=e218]:
            - button "My Leave" [ref=e219] [cursor=pointer]
            - generic "My Leave" [ref=e224]:
              - paragraph [ref=e225]: My Leave
          - generic [ref=e226]:
            - button "My Timesheet" [ref=e227] [cursor=pointer]
            - generic "My Timesheet" [ref=e230]:
              - paragraph [ref=e231]: My Timesheet
      - generic [ref=e233]:
        - generic [ref=e235]:
          - generic [ref=e236]: 
          - paragraph [ref=e237]: Buzz Latest Posts
        - separator [ref=e238]
        - generic [ref=e240]:
          - generic [ref=e241]:
            - generic [ref=e242] [cursor=pointer]:
              - img "profile picture" [ref=e244]
              - generic [ref=e245]:
                - paragraph [ref=e246]: Dummy van Tester
                - paragraph [ref=e247]: 2026-27-06 08:15 PM
            - separator [ref=e248]
            - paragraph [ref=e249]: myravipost
          - generic [ref=e250]:
            - generic [ref=e251] [cursor=pointer]:
              - img "profile picture" [ref=e253]
              - generic [ref=e254]:
                - paragraph [ref=e255]: Dummy van Tester
                - paragraph [ref=e256]: 2026-27-06 08:14 PM
            - separator [ref=e257]
            - paragraph [ref=e258]: myravipost
          - generic [ref=e259]:
            - generic [ref=e260] [cursor=pointer]:
              - img "profile picture" [ref=e262]
              - generic [ref=e263]:
                - paragraph [ref=e264]: Dummy van Tester
                - paragraph [ref=e265]: 2026-27-06 08:12 PM
            - separator [ref=e266]
            - paragraph [ref=e267]: myravipost
          - generic [ref=e268]:
            - generic [ref=e269] [cursor=pointer]:
              - img "profile picture" [ref=e271]
              - generic [ref=e272]:
                - paragraph [ref=e273]: Dummy van Tester
                - paragraph [ref=e274]: 2026-27-06 08:12 PM
            - separator [ref=e275]
            - paragraph [ref=e276]: myravipost
          - generic [ref=e277]:
            - generic [ref=e278] [cursor=pointer]:
              - img "profile picture" [ref=e280]
              - generic [ref=e281]:
                - paragraph [ref=e282]: Dummy van Tester
                - paragraph [ref=e283]: 2026-27-06 08:11 PM
            - separator [ref=e284]
            - paragraph [ref=e285]: myravipost
      - generic [ref=e287]:
        - generic [ref=e288]:
          - paragraph [ref=e293]: Employees on Leave Today
          - generic [ref=e294] [cursor=pointer]: 
        - separator [ref=e295]
      - generic [ref=e299]:
        - generic [ref=e301]:
          - generic [ref=e302]: 
          - paragraph [ref=e303]: Employee Distribution by Sub Unit
        - separator [ref=e304]
      - generic [ref=e308]:
        - generic [ref=e310]:
          - generic [ref=e311]: 
          - paragraph [ref=e312]: Employee Distribution by Location
        - separator [ref=e313]
    - generic [ref=e316]:
      - paragraph [ref=e317]: OrangeHRM OS 5.8
      - paragraph [ref=e318]:
        - text: © 2005 - 2026
        - link "OrangeHRM, Inc" [ref=e319] [cursor=pointer]:
          - /url: http://www.orangehrm.com
        - text: . All rights reserved.
```

# Test source

```ts
  1  | import { test, expect, type Page, type Locator } from '@playwright/test';
  2  | 
  3  | /**
  4  |  * Page Object for the OrangeHRM login screen.
  5  |  */
  6  | class LoginPage {
  7  |   readonly page: Page;
  8  |   readonly usernameInput: Locator;
  9  |   readonly passwordInput: Locator;
  10 |   readonly loginButton: Locator;
  11 | 
  12 |   constructor(page: Page) {
  13 |     this.page = page;
  14 |     // The login inputs expose no <label>, so placeholder is the most reliable accessible handle.
  15 |     this.usernameInput = page.getByPlaceholder('Username');
  16 |     this.passwordInput = page.getByPlaceholder('Password');
  17 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  18 |   }
  19 | 
  20 |   async goto(): Promise<void> {
  21 |     await this.page.goto('https://opensource-demo.orangehrmlive.com/web/index.php/auth/login');
  22 |   }
  23 | 
  24 |   async expectFormDisplayed(): Promise<void> {
  25 |     await expect(this.usernameInput).toBeVisible();
  26 |     await expect(this.passwordInput).toBeVisible();
  27 |     await expect(this.loginButton).toBeVisible();
  28 |   }
  29 | 
  30 |   async fillUsername(username: string): Promise<void> {
  31 |     await this.usernameInput.fill(username);
  32 |     await expect(this.usernameInput).toHaveValue(username);
  33 |   }
  34 | 
  35 |   async fillPassword(password: string): Promise<void> {
  36 |     await this.passwordInput.fill(password);
  37 |     // Password is rendered masked; assert both the masking (type=password) and the stored value.
  38 |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  39 |     await expect(this.passwordInput).toHaveValue(password);
  40 |   }
  41 | 
  42 |   async submit(): Promise<void> {
  43 |     await this.loginButton.click();
  44 |   }
  45 | 
  46 |   async login(username: string, password: string): Promise<void> {
  47 |     await this.fillUsername(username);
  48 |     await this.fillPassword(password);
  49 |     await this.submit();
  50 |   }
  51 | }
  52 | 
  53 | /**
  54 |  * Page Object for the authenticated Dashboard screen.
  55 |  */
  56 | class DashboardPage {
  57 |   readonly page: Page;
  58 |   readonly heading: Locator;
  59 |   readonly userDropdown: Locator;
  60 | 
  61 |   constructor(page: Page) {
  62 |     this.page = page;
  63 |     this.heading = page.getByRole('heading', { name: 'Dashboard' });
  64 |     // Top-right header account name button (acts as the user dropdown trigger).
  65 |     this.userDropdown = page.getByRole('banner').getByRole('button');
  66 |   }
  67 | 
  68 |   async expectLoaded(): Promise<void> {
  69 |     await expect(this.page).toHaveURL(/\/web\/index\.php\/dashboard\/index$/, { timeout: 3000 });
  70 |     await expect(this.heading).toBeVisible();
> 71 |     await expect(this.userDropdown).toBeVisible();
     |                                     ^ Error: expect(locator).toBeVisible() failed
  72 |   }
  73 | }
  74 | 
  75 | test.describe('TC-001 - Successful login with valid Admin credentials', () => {
  76 |   test('redirects to the dashboard and renders the authenticated header', async ({ page }) => {
  77 |     const loginPage = new LoginPage(page);
  78 |     const dashboardPage = new DashboardPage(page);
  79 | 
  80 |     // Step 1: Navigate to the login page and confirm the form is displayed.
  81 |     await loginPage.goto();
  82 |     await loginPage.expectFormDisplayed();
  83 | 
  84 |     // Step 2 & 3: Enter valid credentials.
  85 |     await loginPage.fillUsername('Admin');
  86 |     await loginPage.fillPassword('admin123');
  87 | 
  88 |     // Step 4: Submit the login form.
  89 |     await loginPage.submit();
  90 | 
  91 |     // Step 4 & 5: Verify redirect to the dashboard and the rendered header/content.
  92 |     await dashboardPage.expectLoaded();
  93 |   });
  94 | });
  95 | 
```