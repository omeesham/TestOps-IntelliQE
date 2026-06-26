# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-001-valid-login-redirects-dashboard.spec.ts >> TC-001 - Successful login with valid credentials redirects to Dashboard >> authenticates Admin and lands on the Dashboard within SLA
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-BB701CA4-6BE4-48FC-A6E9-EF8909C49DCF-1782309870206\tests\tc-001-valid-login-redirects-dashboard.spec.ts:76:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('banner').getByText('Admin')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('banner').getByText('Admin')

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
                - paragraph [ref=e263]: manda akhil user
                - paragraph [ref=e264]: 2026-24-06 07:34 PM
            - separator [ref=e265]
            - paragraph [ref=e266]: "\"For undercover police work, Chuck Norris pins his badge underneath his shirt, directly into his chest.\""
          - generic [ref=e267]:
            - generic [ref=e268] [cursor=pointer]:
              - img "profile picture" [ref=e270]
              - generic [ref=e271]:
                - paragraph [ref=e272]: manda akhil user
                - paragraph [ref=e273]: 2026-24-06 07:33 PM
            - separator [ref=e274]
            - paragraph [ref=e275]: "\"There are only two things that can cut diamonds: other diamonds, and Chuck Norris.\""
          - generic [ref=e276]:
            - generic [ref=e277] [cursor=pointer]:
              - img "profile picture" [ref=e279]
              - generic [ref=e280]:
                - paragraph [ref=e281]: manda akhil user
                - paragraph [ref=e282]: 2026-24-06 07:33 PM
            - separator [ref=e283]
            - paragraph [ref=e284]: "\"Time waits for no man. Unless that man is Chuck Norris.\""
          - generic [ref=e285]:
            - generic [ref=e286] [cursor=pointer]:
              - img "profile picture" [ref=e288]
              - generic [ref=e289]:
                - paragraph [ref=e290]: manda akhil user
                - paragraph [ref=e291]: 2020-08-10 09:08 AM
            - separator [ref=e292]
            - paragraph [ref=e293]: "Hi All; Linda has been blessed with a baby boy! Linda: With love, we welcome your dear new baby to this world. Congratulations!"
          - generic [ref=e294]:
            - generic [ref=e295] [cursor=pointer]:
              - img "profile picture" [ref=e297]
              - generic [ref=e298]:
                - paragraph [ref=e299]: Sania Shaheen
                - paragraph [ref=e300]: 2020-08-10 09:08 AM
            - separator [ref=e301]
            - paragraph [ref=e302]: "World Championship: What makes the perfect snooker player? Mark Selby: Robertson has one of the best techniques in the game. It is very, very straight and he fully commits to every single shot he plays. John Higgins: Every shot is repetitive. He always keeps the same technique and cues through the ball bang straight. Barry Hawkins: Robertson is textbook with his grip and has a ramrod solid cue action, delivering it in a straight line. Honourable mentions: Shaun Murphy, Ding Junhui, Jack Lisowski."
      - generic [ref=e304]:
        - generic [ref=e305]:
          - paragraph [ref=e310]: Employees on Leave Today
          - generic [ref=e311] [cursor=pointer]: 
        - separator [ref=e312]
        - generic [ref=e314]:
          - img "No Content" [ref=e315]
          - paragraph [ref=e316]: No Employees are on Leave Today
      - generic [ref=e318]:
        - generic [ref=e320]:
          - generic [ref=e321]: 
          - paragraph [ref=e322]: Employee Distribution by Sub Unit
        - separator [ref=e323]
        - list [ref=e328]:
          - listitem [ref=e329] [cursor=pointer]:
            - generic "Engineering" [ref=e331]
          - listitem [ref=e332] [cursor=pointer]:
            - generic "Human Resources" [ref=e334]
          - listitem [ref=e335] [cursor=pointer]:
            - generic "Administration" [ref=e337]
          - listitem [ref=e338] [cursor=pointer]:
            - generic "Client Services" [ref=e340]
          - listitem [ref=e341] [cursor=pointer]:
            - generic "Unassigned" [ref=e343]
      - generic [ref=e345]:
        - generic [ref=e347]:
          - generic [ref=e348]: 
          - paragraph [ref=e349]: Employee Distribution by Location
        - separator [ref=e350]
        - list [ref=e355]:
          - listitem [ref=e356] [cursor=pointer]:
            - generic "Texas R&D" [ref=e358]
          - listitem [ref=e359] [cursor=pointer]:
            - generic "New York Sales Office" [ref=e361]
          - listitem [ref=e362] [cursor=pointer]:
            - generic "Unassigned" [ref=e364]
    - generic [ref=e365]:
      - paragraph [ref=e366]: OrangeHRM OS 5.8
      - paragraph [ref=e367]:
        - text: © 2005 - 2026
        - link "OrangeHRM, Inc" [ref=e368] [cursor=pointer]:
          - /url: http://www.orangehrm.com
        - text: . All rights reserved.
```

# Test source

```ts
  1   | import { test, expect, type Page, type Locator } from '@playwright/test';
  2   | 
  3   | /**
  4   |  * Page Object for the OrangeHRM Login screen.
  5   |  * All locators are accessibility-first and declared once as readonly fields.
  6   |  */
  7   | class LoginPage {
  8   |   readonly page: Page;
  9   |   readonly logo: Locator;
  10  |   readonly usernameInput: Locator;
  11  |   readonly passwordInput: Locator;
  12  |   readonly loginButton: Locator;
  13  |   readonly forgotPasswordLink: Locator;
  14  | 
  15  |   constructor(page: Page) {
  16  |     this.page = page;
  17  |     // OrangeHRM logo image (accessible name comes from its alt text).
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
  37  |   async fillUsername(username: string): Promise<void> {
  38  |     await this.usernameInput.fill(username);
  39  |     await expect(this.usernameInput).toHaveValue(username);
  40  |   }
  41  | 
  42  |   async fillPassword(password: string): Promise<void> {
  43  |     await this.passwordInput.fill(password);
  44  |     await expect(this.passwordInput).toHaveValue(password);
  45  |     // Password field must mask input.
  46  |     await expect(this.passwordInput).toHaveAttribute('type', 'password');
  47  |   }
  48  | 
  49  |   async submit(): Promise<void> {
  50  |     await this.loginButton.click();
  51  |   }
  52  | }
  53  | 
  54  | /**
  55  |  * Page Object for the authenticated Dashboard screen.
  56  |  */
  57  | class DashboardPage {
  58  |   readonly page: Page;
  59  |   readonly heading: Locator;
  60  |   readonly userDropdown: Locator;
  61  | 
  62  |   constructor(page: Page) {
  63  |     this.page = page;
  64  |     this.heading = page.getByRole('heading', { name: 'Dashboard' });
  65  |     this.userDropdown = page.getByRole('banner').getByText('Admin');
  66  |   }
  67  | 
  68  |   async expectLoaded(): Promise<void> {
  69  |     await expect(this.page).toHaveURL(/.*\/dashboard\/index/);
  70  |     await expect(this.heading).toBeVisible();
> 71  |     await expect(this.userDropdown).toBeVisible();
      |                                     ^ Error: expect(locator).toBeVisible() failed
  72  |   }
  73  | }
  74  | 
  75  | test.describe('TC-001 - Successful login with valid credentials redirects to Dashboard', () => {
  76  |   test('authenticates Admin and lands on the Dashboard within SLA', async ({ page, context }) => {
  77  |     const loginPage = new LoginPage(page);
  78  |     const dashboardPage = new DashboardPage(page);
  79  | 
  80  |     // Step 1 - Navigate to the login page over HTTPS and verify it renders.
  81  |     await loginPage.goto();
  82  |     await loginPage.expectLoaded();
  83  | 
  84  |     // Step 2 - Enter the username.
  85  |     await loginPage.fillUsername('Admin');
  86  | 
  87  |     // Step 3 - Enter the masked password.
  88  |     await loginPage.fillPassword('admin123');
  89  | 
  90  |     // Step 4 - Submit and get redirected to the Dashboard.
  91  |     await loginPage.submit();
  92  | 
  93  |     // Step 5 - Dashboard is displayed with the authenticated user's context.
  94  |     await dashboardPage.expectLoaded();
  95  | 
  96  |     // A session cookie must be created after a successful authentication.
  97  |     const cookies = await context.cookies();
  98  |     expect(cookies.some((c) => c.name.toLowerCase().includes('orangehrm'))).toBeTruthy();
  99  |   });
  100 | });
  101 | 
```