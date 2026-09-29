# Microsoft SSO (Entra ID) — setup

IntelliQE can sign users in with their Microsoft work/school account next to
the existing username/password form. The flow is a standard OpenID Connect
authorization-code exchange with PKCE, handled entirely by the backend; the
SPA only needs to know whether the provider is enabled.

```
Login page ──click──▶ GET /api/auth/sso/microsoft ──302──▶ login.microsoftonline.com
                                                                   │ user signs in
GET /api/auth/sso/microsoft/callback?code&state ◀──────302─────────┘
   │ verify state cookie, exchange code (PKCE), verify ID token (JWKS)
   │ find / link / provision user, mint app JWT
   └──302──▶ /auth/sso/callback#token=…  ──▶ SPA stores token, loads /api/auth/me
```

## 1. Register the app in Entra ID

1. Azure portal → **Microsoft Entra ID → App registrations → New registration**.
2. Name: `JBS IntelliQE`. Supported account types: *Accounts in this
   organizational directory only* (single tenant) or *any organizational
   directory* (multi-tenant).
3. Platform **Web**, redirect URI:
   `https://<your-host>/api/auth/sso/microsoft/callback`
   (for local dev add `http://127.0.0.1:5173/api/auth/sso/microsoft/callback`,
   which the Vite proxy forwards to the backend).
4. **Certificates & secrets → New client secret**. Copy the secret *value*.
5. **API permissions**: Microsoft Graph delegated `openid`, `profile`, `email`
   (these are the defaults). Grant admin consent if your tenant requires it.
6. **Token configuration** (optional): add the `email` optional claim to the
   ID token so users without a UPN-shaped email still resolve.

## 2. Configure the backend

Set these in `.env` (local) or App Service configuration (prod):

| Variable | Required | Meaning |
|---|---|---|
| `MS_SSO_CLIENT_ID` | yes | Application (client) ID |
| `MS_SSO_CLIENT_SECRET` | yes | Client secret value |
| `MS_SSO_TENANT_ID` | no | Directory (tenant) ID to pin sign-in to one tenant. Default `organizations` (any work/school account). |
| `MS_SSO_REDIRECT_URI` | no | Override the callback URL when the public origin differs from what the backend sees (defaults to request origin + `/api/auth/sso/microsoft/callback`). |
| `MS_SSO_ALLOWED_DOMAINS` | no | Comma-separated email domains allowed to sign in. |
| `MS_SSO_AUTO_PROVISION` | no | `true` (default) creates an IntelliQE user on first sign-in; `false` requires an existing account. |
| `MS_SSO_DEFAULT_TENANT_SLUG` | no | IntelliQE tenant auto-provisioned users join. Default `jbs`. |
| `MS_SSO_DEFAULT_ROLE` | no | Role for auto-provisioned users. Default `qa_engineer`. |

The **Continue with Microsoft** button appears automatically once the client
ID and secret are set (the login page calls `GET /api/auth/sso/providers`).
No frontend rebuild is needed.

## 3. How users are matched

On each sign-in the backend looks for a user in this order:

1. `users.sso_provider = 'microsoft'` and `users.sso_subject = <oid>` — a
   previously linked account.
2. An existing account whose `email` or `username` equals the Microsoft
   email (case-insensitive) — it is linked by writing the `oid`, so an admin
   can pre-create accounts with the right role and tenant and let SSO attach.
3. Otherwise, if auto-provisioning is on, a new user is created with
   `username = email`, the default tenant and role, and an unusable random
   password hash (password login is impossible for that account).

Deactivated accounts (`is_active = 0`) are refused with a clear message.

## 4. Security properties

- `state`, the PKCE `code_verifier` and the OIDC `nonce` are stored in a
  signed, HttpOnly, SameSite=Lax cookie scoped to `/api/auth/sso` with a
  10-minute lifetime. The cookie is cleared on the callback.
- The ID token's RS256 signature is verified against Microsoft's published
  JWKS (cached one hour, refreshed on unknown `kid`), along with audience,
  issuer, nonce and (when pinned) tenant.
- The session token is passed to the SPA in the URL **fragment**, so it is
  never written to server or proxy logs and is scrubbed from the address bar
  immediately.
- Failures never leak details to the browser: the user lands on
  `/login?sso_error=<code>` and the login page maps codes to plain messages.
  Full reasons are in the backend log.
