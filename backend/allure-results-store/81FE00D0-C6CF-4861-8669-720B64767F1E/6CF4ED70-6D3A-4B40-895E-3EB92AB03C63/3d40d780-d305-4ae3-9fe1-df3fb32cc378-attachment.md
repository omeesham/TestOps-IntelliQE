# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-001-successful-login-redirects-to-dashboard.spec.ts >> TC-001 - Successful login redirects to Dashboard and creates a session >> valid credentials authenticate and land on the Dashboard within the NFR
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-6CF4ED70-6D3A-4B40-895E-3EB92AB03C63-1782398745504\tests\tc-001-successful-login-redirects-to-dashboard.spec.ts:81:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('main')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('main')

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
              - paragraph [ref=e127]: manda user
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
        - generic [ref=e176]:
          - button [ref=e177] [cursor=pointer]
          - paragraph [ref=e183] [cursor=pointer]: (1) Pending Self Review
      - generic [ref=e185]:
        - generic [ref=e187]:
          - generic [ref=e188]: 
          - paragraph [ref=e189]: Quick Launch
        - separator [ref=e190]
        - generic [ref=e192]:
          - generic [ref=e193]:
            - button "Assign Leave" [ref=e194] [cursor=pointer]
            - generic "Assign Leave" [ref=e197]:
              - paragraph [ref=e198]: Assign Leave
          - generic [ref=e199]:
            - button "Leave List" [ref=e200] [cursor=pointer]
            - generic "Leave List" [ref=e207]:
              - paragraph [ref=e208]: Leave List
          - generic [ref=e209]:
            - button "Timesheets" [ref=e210] [cursor=pointer]
            - generic "Timesheets" [ref=e216]:
              - paragraph [ref=e217]: Timesheets
          - generic [ref=e218]:
            - button "Apply Leave" [ref=e219] [cursor=pointer]
            - generic "Apply Leave" [ref=e222]:
              - paragraph [ref=e223]: Apply Leave
          - generic [ref=e224]:
            - button "My Leave" [ref=e225] [cursor=pointer]
            - generic "My Leave" [ref=e230]:
              - paragraph [ref=e231]: My Leave
          - generic [ref=e232]:
            - button "My Timesheet" [ref=e233] [cursor=pointer]
            - generic "My Timesheet" [ref=e236]:
              - paragraph [ref=e237]: My Timesheet
      - generic [ref=e239]:
        - generic [ref=e241]:
          - generic [ref=e242]: 
          - paragraph [ref=e243]: Buzz Latest Posts
        - separator [ref=e244]
        - generic [ref=e246]:
          - generic [ref=e247]:
            - generic [ref=e248] [cursor=pointer]:
              - img "profile picture" [ref=e250]
              - generic [ref=e251]:
                - paragraph [ref=e252]: manda akhil user
                - paragraph [ref=e253]: 2026-25-06 08:01 PM
            - separator [ref=e254]
            - paragraph [ref=e255]: Hello, this is a test post from Playwright automation script.
            - img [ref=e256]
          - generic [ref=e257]:
            - generic [ref=e258] [cursor=pointer]:
              - img "profile picture" [ref=e260]
              - generic [ref=e261]:
                - paragraph [ref=e262]: manda akhil user
                - paragraph [ref=e263]: 2026-25-06 07:47 PM
            - separator [ref=e264]
            - paragraph [ref=e265]: Iste excepturi quo saepe.
          - generic [ref=e266]:
            - generic [ref=e267] [cursor=pointer]:
              - img "profile picture" [ref=e269]
              - generic [ref=e270]:
                - paragraph [ref=e271]: manda akhil user
                - paragraph [ref=e272]: 2020-08-10 09:08 AM
            - separator [ref=e273]
            - paragraph [ref=e274]: "Hi All; Linda has been blessed with a baby boy! Linda: With love, we welcome your dear new baby to this world. Congratulations!"
      - generic [ref=e276]:
        - generic [ref=e277]:
          - paragraph [ref=e282]: Employees on Leave Today
          - generic [ref=e283] [cursor=pointer]: 
        - separator [ref=e284]
        - generic [ref=e286]:
          - img "No Content" [ref=e287]
          - paragraph [ref=e288]: No Employees are on Leave Today
      - generic [ref=e290]:
        - generic [ref=e292]:
          - generic [ref=e293]: 
          - paragraph [ref=e294]: Employee Distribution by Sub Unit
        - separator [ref=e295]
        - list [ref=e300]:
          - listitem [ref=e301] [cursor=pointer]:
            - generic "Human Resources" [ref=e303]
          - listitem [ref=e304] [cursor=pointer]:
            - generic "Unassigned" [ref=e306]
      - generic [ref=e308]:
        - generic [ref=e310]:
          - generic [ref=e311]: 
          - paragraph [ref=e312]: Employee Distribution by Location
        - separator [ref=e313]
        - list [ref=e318]:
          - listitem [ref=e319] [cursor=pointer]:
            - generic "Texas R&D" [ref=e321]
          - listitem [ref=e322] [cursor=pointer]:
            - generic "Unassigned" [ref=e324]
    - generic [ref=e325]:
      - paragraph [ref=e326]: OrangeHRM OS 5.8
      - paragraph [ref=e327]:
        - text: © 2005 - 2026
        - link "OrangeHRM, Inc" [ref=e328] [cursor=pointer]:
          - /url: http://www.orangehrm.com
        - text: . All rights reserved.
```

# Test source

```ts
  1   | import { test, expect, type Page, type Locator } from '@playwright/test';
  2   | 
  3   | /**
  4   |  * Page Object for the OrangeHRM Login screen.
  5   |  * All locators are accessibility-first; the password/username inputs in OrangeHRM
  6   |  * have no associated <label>, so getByPlaceholder is the most stable accessible hook.
  7   |  */
  8   | class LoginPage {
  9   |   readonly page: Page;
  10  |   readonly logo: Locator;
  11  |   readonly usernameInput: Locator;
  12  |   readonly passwordInput: Locator;
  13  |   readonly loginButton: Locator;
  14  |   readonly forgotPasswordLink: Locator;
  15  | 
  16  |   constructor(page: Page) {
  17  |     this.page = page;
  18  |     this.logo = page.getByAltText('company-branding');
  19  |     this.usernameInput = page.getByPlaceholder('Username');
  20  |     this.passwordInput = page.getByPlaceholder('Password');
  21  |     this.loginButton = page.getByRole('button', { name: 'Login' });
  22  |     this.forgotPasswordLink = page.getByText('Forgot your password?');
  23  |   }
  24  | 
  25  |   async goto(): Promise<void> {
  26  |     await this.page.goto('https://opensource-demo.orangehrmlive.com/web/index.php/auth/login');
  27  |   }
  28  | 
  29  |   async expectLoaded(): Promise<void> {
  30  |     await expect(this.logo).toBeVisible();
  31  |     await expect(this.usernameInput).toBeVisible();
  32  |     await expect(this.passwordInput).toBeVisible();
  33  |     await expect(this.loginButton).toBeVisible();
  34  |     await expect(this.forgotPasswordLink).toBeVisible();
  35  |   }
  36  | 
  37  |   async enterUsername(username: string): Promise<void> {
  38  |     await this.usernameInput.fill(username);
  39  |     await expect(this.usernameInput).toHaveValue(username);
  40  |   }
  41  | 
  42  |   async enterPassword(password: string): Promise<void> {
  43  |     await this.passwordInput.fill(password);
  44  |     // Masking is enforced by the input type; verify no plaintext leak.
  45  |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  46  |   }
  47  | 
  48  |   async submit(): Promise<void> {
  49  |     await this.loginButton.click();
  50  |   }
  51  | }
  52  | 
  53  | /**
  54  |  * Page Object for the authenticated Dashboard screen.
  55  |  */
  56  | class DashboardPage {
  57  |   readonly page: Page;
  58  |   readonly header: Locator;
  59  |   readonly dashboardGrid: Locator;
  60  | 
  61  |   constructor(page: Page) {
  62  |     this.page = page;
  63  |     this.header = page.getByRole('heading', { name: 'Dashboard' });
  64  |     this.dashboardGrid = page.getByRole('main');
  65  |   }
  66  | 
  67  |   async expectLoaded(): Promise<void> {
  68  |     await expect(this.page).toHaveURL(/\/web\/index\.php\/dashboard\/index/);
  69  |     await expect(this.header).toBeVisible();
> 70  |     await expect(this.dashboardGrid).toBeVisible();
      |                                      ^ Error: expect(locator).toBeVisible() failed
  71  |   }
  72  | 
  73  |   async expectAuthenticatedSession(): Promise<void> {
  74  |     const cookies = await this.page.context().cookies();
  75  |     const sessionCookie = cookies.find((c) => /orangehrm/i.test(c.name) || /session/i.test(c.name));
  76  |     expect(sessionCookie, 'an authenticated session cookie should be present').toBeTruthy();
  77  |   }
  78  | }
  79  | 
  80  | test.describe('TC-001 - Successful login redirects to Dashboard and creates a session', () => {
  81  |   test('valid credentials authenticate and land on the Dashboard within the NFR', async ({ page }) => {
  82  |     const loginPage = new LoginPage(page);
  83  |     const dashboardPage = new DashboardPage(page);
  84  | 
  85  |     // Step 1: navigate and verify the login page renders.
  86  |     await loginPage.goto();
  87  |     await loginPage.expectLoaded();
  88  | 
  89  |     // Step 2 & 3: enter valid credentials.
  90  |     await loginPage.enterUsername('Admin');
  91  |     await loginPage.enterPassword('admin123');
  92  | 
  93  |     // Step 4: submit and verify redirect to the Dashboard.
  94  |     await loginPage.submit();
  95  |     await dashboardPage.expectLoaded();
  96  | 
  97  |     // Step 5: verify the authenticated session cookie and rendered Dashboard.
  98  |     await dashboardPage.expectAuthenticatedSession();
  99  |   });
  100 | });
  101 | 
```