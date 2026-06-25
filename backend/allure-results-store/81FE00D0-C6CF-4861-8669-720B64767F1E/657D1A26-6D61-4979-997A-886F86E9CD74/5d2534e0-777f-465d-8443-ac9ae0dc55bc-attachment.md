# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: brute-force-lockout.spec.ts >> TC-011 - Brute Force Protection >> account is throttled or locked after exceeding the failed-login threshold
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-657D1A26-6D61-4979-997A-886F86E9CD74-1782394362512\tests\brute-force-lockout.spec.ts:47:7

# Error details

```
Error: expect(page).not.toHaveURL(expected) failed

Expected pattern: not /\/dashboard\/index/
Received string: "https://opensource-demo.orangehrmlive.com/web/index.php/dashboard/index"
Timeout: 5000ms

Call log:
  - Expect "not toHaveURL" with timeout 5000ms
    8 × unexpected value "https://opensource-demo.orangehrmlive.com/web/index.php/dashboard/index"

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
              - paragraph [ref=e127]: mandaa Bergkamp
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
              - paragraph [ref=e152]: "Punched Out: Today at 06:39 PM (GMT 5.5)"
          - generic [ref=e153]:
            - generic [ref=e154]: 9h 0m Today
            - button "" [ref=e155] [cursor=pointer]:
              - generic [ref=e156]: 
          - separator [ref=e157]
          - generic [ref=e158]:
            - generic [ref=e159]:
              - paragraph [ref=e160]: This Week
              - paragraph [ref=e161]: Jun 22 - Jun 28
            - generic [ref=e162]:
              - generic [ref=e163]: 
              - paragraph [ref=e164]: 9h 0m
      - generic [ref=e168]:
        - generic [ref=e170]:
          - generic [ref=e171]: 
          - paragraph [ref=e172]: My Actions
        - separator [ref=e173]
        - generic [ref=e175]:
          - generic [ref=e176]:
            - button [ref=e177] [cursor=pointer]
            - paragraph [ref=e183] [cursor=pointer]: (1) Pending Self Review
          - generic [ref=e184]:
            - button [ref=e185] [cursor=pointer]
            - paragraph [ref=e194] [cursor=pointer]: (1) Candidate to Interview
      - generic [ref=e196]:
        - generic [ref=e198]:
          - generic [ref=e199]: 
          - paragraph [ref=e200]: Quick Launch
        - separator [ref=e201]
        - generic [ref=e203]:
          - generic [ref=e204]:
            - button "Assign Leave" [ref=e205] [cursor=pointer]
            - generic "Assign Leave" [ref=e208]:
              - paragraph [ref=e209]: Assign Leave
          - generic [ref=e210]:
            - button "Leave List" [ref=e211] [cursor=pointer]
            - generic "Leave List" [ref=e218]:
              - paragraph [ref=e219]: Leave List
          - generic [ref=e220]:
            - button "Timesheets" [ref=e221] [cursor=pointer]
            - generic "Timesheets" [ref=e227]:
              - paragraph [ref=e228]: Timesheets
          - generic [ref=e229]:
            - button "Apply Leave" [ref=e230] [cursor=pointer]
            - generic "Apply Leave" [ref=e233]:
              - paragraph [ref=e234]: Apply Leave
          - generic [ref=e235]:
            - button "My Leave" [ref=e236] [cursor=pointer]
            - generic "My Leave" [ref=e241]:
              - paragraph [ref=e242]: My Leave
          - generic [ref=e243]:
            - button "My Timesheet" [ref=e244] [cursor=pointer]
            - generic "My Timesheet" [ref=e247]:
              - paragraph [ref=e248]: My Timesheet
      - generic [ref=e250]:
        - generic [ref=e252]:
          - generic [ref=e253]: 
          - paragraph [ref=e254]: Buzz Latest Posts
        - separator [ref=e255]
        - generic [ref=e257]:
          - generic [ref=e258]:
            - generic [ref=e259] [cursor=pointer]:
              - img "profile picture" [ref=e261]
              - generic [ref=e262]:
                - paragraph [ref=e263]: mandaa akhill Bergkamp
                - paragraph [ref=e264]: 2026-25-06 07:01 PM
            - separator [ref=e265]
            - paragraph [ref=e266]: Dolorum et sunt doloribus doloribus tenetur facilis.
          - generic [ref=e267]:
            - generic [ref=e268] [cursor=pointer]:
              - img "profile picture" [ref=e270]
              - generic [ref=e271]:
                - paragraph [ref=e272]: mandaa akhill Bergkamp
                - paragraph [ref=e273]: 2026-25-06 06:40 PM
            - separator [ref=e274]
            - paragraph [ref=e275]: Delete test test_20260625201034_djml
          - generic [ref=e276]:
            - generic [ref=e277] [cursor=pointer]:
              - img "profile picture" [ref=e279]
              - generic [ref=e280]:
                - paragraph [ref=e281]: mandaa akhill Bergkamp
                - paragraph [ref=e282]: 2026-25-06 06:40 PM
            - separator [ref=e283]
            - paragraph [ref=e284]: Media test test_20260625201013_tueu
          - generic [ref=e285]:
            - generic [ref=e286] [cursor=pointer]:
              - img "profile picture" [ref=e288]
              - generic [ref=e289]:
                - paragraph [ref=e290]: mandaa akhill Bergkamp
                - paragraph [ref=e291]: 2026-25-06 06:39 PM
            - separator [ref=e292]
            - paragraph [ref=e293]: Comment test test_20260625200926_ascs
          - generic [ref=e294]:
            - generic [ref=e295] [cursor=pointer]:
              - img "profile picture" [ref=e297]
              - generic [ref=e298]:
                - paragraph [ref=e299]: mandaa akhill Bergkamp
                - paragraph [ref=e300]: 2026-25-06 06:39 PM
            - separator [ref=e301]
            - paragraph [ref=e302]: Like test test_20260625200902_hrjr
      - generic [ref=e304]:
        - generic [ref=e305]:
          - paragraph [ref=e310]: Employees on Leave Today
          - generic [ref=e311] [cursor=pointer]: 
        - separator [ref=e312]
        - generic [ref=e314]:
          - img "profile picture" [ref=e316]
          - generic [ref=e317]:
            - paragraph [ref=e318]: mandaa Bergkamp
            - paragraph [ref=e319]: CAN - Personal
          - paragraph [ref=e320]: muser
      - generic [ref=e322]:
        - generic [ref=e324]:
          - generic [ref=e325]: 
          - paragraph [ref=e326]: Employee Distribution by Sub Unit
        - separator [ref=e327]
        - list [ref=e332]:
          - listitem [ref=e333] [cursor=pointer]:
            - generic "Human Resources" [ref=e335]
          - listitem [ref=e336] [cursor=pointer]:
            - generic "Unassigned" [ref=e338]
      - generic [ref=e340]:
        - generic [ref=e342]:
          - generic [ref=e343]: 
          - paragraph [ref=e344]: Employee Distribution by Location
        - separator [ref=e345]
        - list [ref=e350]:
          - listitem [ref=e351] [cursor=pointer]:
            - generic "Texas R&D" [ref=e353]
          - listitem [ref=e354] [cursor=pointer]:
            - generic "Unassigned" [ref=e356]
    - generic [ref=e357]:
      - paragraph [ref=e358]: OrangeHRM OS 5.8
      - paragraph [ref=e359]:
        - text: © 2005 - 2026
        - link "OrangeHRM, Inc" [ref=e360] [cursor=pointer]:
          - /url: http://www.orangehrm.com
        - text: . All rights reserved.
```

# Test source

```ts
  1  | import { test, expect, type Page, type Locator } from '@playwright/test';
  2  | 
  3  | const LOGIN_URL = 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login';
  4  | const FAILED_ATTEMPT_THRESHOLD = 5;
  5  | 
  6  | class LoginPage {
  7  |   readonly page: Page;
  8  |   readonly usernameInput: Locator;
  9  |   readonly passwordInput: Locator;
  10 |   readonly loginButton: Locator;
  11 |   readonly invalidCredentialsAlert: Locator;
  12 |   readonly lockoutMessage: Locator;
  13 | 
  14 |   constructor(page: Page) {
  15 |     this.page = page;
  16 |     this.usernameInput = page.getByPlaceholder('Username');
  17 |     this.passwordInput = page.getByPlaceholder('Password');
  18 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  19 |     this.invalidCredentialsAlert = page.getByText('Invalid credentials');
  20 |     this.lockoutMessage = page.getByText(/locked|too many|try again later|rate limit/i);
  21 |   }
  22 | 
  23 |   async goto(): Promise<void> {
  24 |     await this.page.goto(LOGIN_URL);
  25 |   }
  26 | 
  27 |   async login(username: string, password: string): Promise<void> {
  28 |     await this.usernameInput.fill(username);
  29 |     await this.passwordInput.fill(password);
  30 |     await this.loginButton.click();
  31 |   }
  32 | 
  33 |   async expectInvalidCredentials(): Promise<void> {
  34 |     await expect(this.invalidCredentialsAlert).toBeVisible();
  35 |   }
  36 | 
  37 |   async expectThrottledOrLocked(): Promise<void> {
  38 |     // The credential must NOT be processed into an authenticated session.
> 39 |     await expect(this.page).not.toHaveURL(/\/dashboard\/index/);
     |                                 ^ Error: expect(page).not.toHaveURL(expected) failed
  40 |     // Evidence of throttling/lockout: an explicit lock/rate-limit message, or the
  41 |     // persistent invalid-credentials guard confirming no session was granted.
  42 |     await expect(this.lockoutMessage.or(this.invalidCredentialsAlert)).toBeVisible();
  43 |   }
  44 | }
  45 | 
  46 | test.describe('TC-011 - Brute Force Protection', () => {
  47 |   test('account is throttled or locked after exceeding the failed-login threshold', async ({ page }) => {
  48 |     const loginPage = new LoginPage(page);
  49 | 
  50 |     // Step 1: Submit wrong password up to the threshold; each attempt reports invalid credentials
  51 |     for (let attempt = 1; attempt <= FAILED_ATTEMPT_THRESHOLD; attempt++) {
  52 |       await loginPage.goto();
  53 |       await loginPage.login('Admin', 'WrongPass99');
  54 |       await loginPage.expectInvalidCredentials();
  55 |     }
  56 | 
  57 |     // Step 2: One additional failed attempt beyond the threshold must be throttled/locked
  58 |     await loginPage.goto();
  59 |     await loginPage.login('Admin', 'WrongPass99');
  60 |     await loginPage.expectThrottledOrLocked();
  61 | 
  62 |     // Step 3: Correct credentials within the lockout window must remain blocked
  63 |     await loginPage.goto();
  64 |     await loginPage.login('Admin', 'admin123');
  65 |     await loginPage.expectThrottledOrLocked();
  66 |   });
  67 | });
  68 | 
```