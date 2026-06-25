# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tc-009-secure-https-credential-transmission.spec.ts >> TC-009 - Secure (HTTPS) Credential Transmission >> redirects HTTP to HTTPS, enforces HSTS, and posts credentials in the HTTPS body
- Location: ..\..\..\Users\VIKASY~1\AppData\Local\Temp\jbs-pwexec-6CF4ED70-6D3A-4B40-895E-3EB92AB03C63-1782398745504\tests\tc-009-secure-https-credential-transmission.spec.ts:37:7

# Error details

```
Error: apiRequestContext.get: connect ECONNREFUSED 18.170.178.137:80
Call log:
  - → GET http://opensource-demo.orangehrmlive.com/web/index.php/auth/login
    - user-agent: Playwright/1.59.1 (x64; windows 10.0) node/24.17 CI/1
    - accept: */*
    - accept-encoding: gzip,deflate,br

```

# Test source

```ts
  1  | import { test, expect, type Page, type Locator } from '@playwright/test';
  2  | 
  3  | const LOGIN_URL = 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login';
  4  | const HTTP_LOGIN_URL = 'http://opensource-demo.orangehrmlive.com/web/index.php/auth/login';
  5  | 
  6  | /**
  7  |  * Page Object for the OrangeHRM login screen.
  8  |  * All locators are declared once and initialised in the constructor.
  9  |  */
  10 | class LoginPage {
  11 |   readonly page: Page;
  12 |   readonly usernameInput: Locator;
  13 |   readonly passwordInput: Locator;
  14 |   readonly loginButton: Locator;
  15 | 
  16 |   constructor(page: Page) {
  17 |     this.page = page;
  18 |     // OrangeHRM does not associate <label> elements; placeholders are the most reliable accessible hook.
  19 |     this.usernameInput = page.getByPlaceholder('Username');
  20 |     this.passwordInput = page.getByPlaceholder('Password');
  21 |     this.loginButton = page.getByRole('button', { name: 'Login' });
  22 |   }
  23 | 
  24 |   async goto(): Promise<void> {
  25 |     await this.page.goto(LOGIN_URL);
  26 |     await expect(this.usernameInput).toBeVisible();
  27 |   }
  28 | 
  29 |   async login(username: string, password: string): Promise<void> {
  30 |     await this.usernameInput.fill(username);
  31 |     await this.passwordInput.fill(password);
  32 |     await this.loginButton.click();
  33 |   }
  34 | }
  35 | 
  36 | test.describe('TC-009 - Secure (HTTPS) Credential Transmission', () => {
  37 |   test('redirects HTTP to HTTPS, enforces HSTS, and posts credentials in the HTTPS body', async ({ page, request }) => {
  38 |     // Step 1: Request the login page over plain HTTP -> expect a 3xx redirect to the HTTPS equivalent.
> 39 |     const httpResponse = await request.get(HTTP_LOGIN_URL, { maxRedirects: 0 });
     |                                        ^ Error: apiRequestContext.get: connect ECONNREFUSED 18.170.178.137:80
  40 |     expect(httpResponse.status(), 'Plain HTTP should answer with a redirect status').toBeGreaterThanOrEqual(300);
  41 |     expect(httpResponse.status(), 'Plain HTTP should answer with a redirect status').toBeLessThan(400);
  42 |     const location = httpResponse.headers()['location'] ?? '';
  43 |     expect(location.startsWith('https://'), `Redirect Location must be HTTPS, received: ${location}`).toBeTruthy();
  44 | 
  45 |     // Step 2: Inspect the HTTPS response headers -> Strict-Transport-Security (HSTS) must be present.
  46 |     const httpsResponse = await request.get(LOGIN_URL);
  47 |     expect(httpsResponse.ok(), 'HTTPS login page should load successfully').toBeTruthy();
  48 |     const hsts = httpsResponse.headers()['strict-transport-security'];
  49 |     expect(hsts, 'Strict-Transport-Security (HSTS) header should be present on the HTTPS response').toBeTruthy();
  50 | 
  51 |     // Step 3: Submit valid credentials and capture the auth request -> must be HTTPS, body-carried, never in the URL.
  52 |     const loginPage = new LoginPage(page);
  53 |     await loginPage.goto();
  54 | 
  55 |     const authRequestPromise = page.waitForRequest(
  56 |       (req) => req.method() === 'POST' && req.url().includes('/auth/validate')
  57 |     );
  58 | 
  59 |     await loginPage.login('Admin', 'admin123');
  60 | 
  61 |     const authRequest = await authRequestPromise;
  62 |     expect(authRequest.url().startsWith('https://'), 'Credential POST must travel over HTTPS').toBeTruthy();
  63 |     expect(authRequest.url(), 'Credentials must not appear in the URL/query string').not.toContain('admin123');
  64 |     const postData = authRequest.postData() ?? '';
  65 |     expect(postData, 'Credentials must be carried in the request body').toContain('admin123');
  66 |   });
  67 | });
  68 | 
```