# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-012-http-to-https-redirect.spec.ts >> TC-012 - HTTP login is redirected to HTTPS >> HTTP access redirects to HTTPS and credentials transmit only over HTTPS
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-766F3ACB-65A5-4EE8-9B5E-5CC4DA24951A-1782822820482\tests\tc-012-http-to-https-redirect.spec.ts:44:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://opensource-demo.orangehrmlive.com/web/index.php/auth/login
Call log:
  - navigating to "http://opensource-demo.orangehrmlive.com/web/index.php/auth/login", waiting until "domcontentloaded"

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e3]:
    - generic [ref=e6]:
      - heading "Hmmm… can't reach this page" [level=1] [ref=e7]
      - paragraph [ref=e8]:
        - strong [ref=e9]: opensource-demo.orangehrmlive.com
        - text: refused to connect.
      - generic [ref=e10]:
        - paragraph [ref=e11]: "Try:"
        - list [ref=e12]:
          - listitem [ref=e13]: •Checking the connection
          - listitem [ref=e14]:
            - text: •
            - link "Checking the proxy and the firewall" [ref=e15] [cursor=pointer]:
              - /url: "#buttons"
      - generic [ref=e16]: ERR_CONNECTION_REFUSED
    - button "Refresh" [ref=e19] [cursor=pointer]
  - generic [ref=e22]: Microsoft Edge
```

# Test source

```ts
  1   | import { test, expect, type Page, type Locator, type Response } from '@playwright/test';
  2   | 
  3   | const HTTP_URL =
  4   |   'http://opensource-demo.orangehrmlive.com/web/index.php/auth/login';
  5   | const HTTPS_URL =
  6   |   'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login';
  7   | 
  8   | class LoginPage {
  9   |   readonly page: Page;
  10  |   readonly usernameInput: Locator;
  11  |   readonly passwordInput: Locator;
  12  |   readonly loginButton: Locator;
  13  | 
  14  |   constructor(page: Page) {
  15  |     this.page = page;
  16  |     this.usernameInput = page.getByPlaceholder('Username');
  17  |     this.passwordInput = page.getByPlaceholder('Password');
  18  |     this.loginButton = page.getByRole('button', { name: 'Login' });
  19  |   }
  20  | 
  21  |   async gotoHttp(): Promise<Response | null> {
> 22  |     return this.page.goto(HTTP_URL, { waitUntil: 'domcontentloaded' });
      |                      ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://opensource-demo.orangehrmlive.com/web/index.php/auth/login
  23  |   }
  24  | 
  25  |   async expectLoaded(): Promise<void> {
  26  |     await expect(this.usernameInput).toBeVisible();
  27  |     await expect(this.passwordInput).toBeVisible();
  28  |     await expect(this.loginButton).toBeVisible();
  29  |   }
  30  | 
  31  |   async expectSecureUrl(): Promise<void> {
  32  |     await expect(this.page).toHaveURL(/^https:\/\//);
  33  |     await expect(this.page).toHaveURL(HTTPS_URL);
  34  |   }
  35  | 
  36  |   async login(user: string, pass: string): Promise<void> {
  37  |     await this.usernameInput.fill(user);
  38  |     await this.passwordInput.fill(pass);
  39  |     await this.loginButton.click();
  40  |   }
  41  | }
  42  | 
  43  | test.describe('TC-012 - HTTP login is redirected to HTTPS', () => {
  44  |   test('HTTP access redirects to HTTPS and credentials transmit only over HTTPS', async ({
  45  |     page,
  46  |   }) => {
  47  |     const username = 'Admin';
  48  |     const password = 'admin123';
  49  | 
  50  |     // Step 1: Record all network requests (equivalent to 'Preserve log').
  51  |     const insecureCredentialRequests: string[] = [];
  52  |     page.on('request', (request) => {
  53  |       const url = request.url();
  54  |       if (url.startsWith('http://') && /auth\/(login|validate)/i.test(url)) {
  55  |         insecureCredentialRequests.push(url);
  56  |       }
  57  |     });
  58  | 
  59  |     const loginPage = new LoginPage(page);
  60  | 
  61  |     // Step 2: Navigate to the HTTP URL and capture the response chain.
  62  |     const response = await loginPage.gotoHttp();
  63  |     expect(response, 'Navigation should yield a response').not.toBeNull();
  64  | 
  65  |     // Step 3: After navigation the URL must be upgraded to HTTPS.
  66  |     await loginPage.expectSecureUrl();
  67  |     await loginPage.expectLoaded();
  68  | 
  69  |     // Step 4: Inspect the redirect chain — the initial HTTP request must have
  70  |     // been answered with a 301/302 redirect to HTTPS (or an HSTS upgrade).
  71  |     const finalResponse = response as Response;
  72  |     const chain: Response[] = [];
  73  |     let current: Response | null = finalResponse;
  74  |     while (current) {
  75  |       chain.push(current);
  76  |       const req = current.request().redirectedFrom();
  77  |       current = req ? await req.response() : null;
  78  |     }
  79  | 
  80  |     const redirectStatuses = chain.map((r) => r.status());
  81  |     const sawRedirect = redirectStatuses.some((s) => s === 301 || s === 302);
  82  |     const finalIsHttps = finalResponse.url().startsWith('https://');
  83  | 
  84  |     // Either an explicit 301/302 redirect occurred, or the browser performed an
  85  |     // HSTS upgrade so the landed page is securely served over HTTPS.
  86  |     expect(
  87  |       sawRedirect || finalIsHttps,
  88  |       'HTTP request must be redirected/upgraded to HTTPS before serving the login page'
  89  |     ).toBeTruthy();
  90  |     expect(finalIsHttps, 'Login page must finally be served over HTTPS').toBeTruthy();
  91  | 
  92  |     // Step 5: Submit credentials and assert no credential payload over HTTP.
  93  |     await loginPage.login(username, password);
  94  |     expect(
  95  |       insecureCredentialRequests,
  96  |       'No credential request must be sent over plain HTTP'
  97  |     ).toEqual([]);
  98  |   });
  99  | });
  100 | 
```