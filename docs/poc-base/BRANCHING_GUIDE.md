# POC branching guide

How IntelliQE client POC branches are created, kept up to date and upgraded.

## Branches

```
main (f639160)
 ├── hardening/v1    fixes that are right for every customer (security, build, dependencies)
 │                     → merged into poc/base now; offered to main as one PR (see PORT_BACK.md)
 └── poc/base        hardening/v1 + POC-only changes (scope, docs, smoke suite, CI)
       tag poc-base-v1.0.0
        ├── poc/ges-us     GES US   (client contact: Ashok)
        └── poc/ges-emea   GES EMEA (client contacts: Ajay, Liberty)
```

| Branch | Holds | Never holds |
| --- | --- | --- |
| `hardening/vN` | Product fixes, each a small commit with proof | Client names, client config, POC-only hiding |
| `poc/base` | Merges of `hardening/vN`; POC-only commits (feature defaults, docs, smoke suite, CI) | Client-specific values |
| `poc/<client>-<region>` | Region configuration; client-specific features (see "Features" below) | Fixes that every client needs; those go to `hardening` |

**Naming:**
- Branches: `poc/<client>-<region>`, for example `poc/ges-us`.
- Base tags: `poc-base-vMAJOR.MINOR.PATCH`.
- Client tags: `<client>-<region>-vX.Y.Z`, for example `ges-us-v1.0.0`.

## Where a change goes

| Change | Branch | Then |
| --- | --- | --- |
| Bug or security fix for everyone | `hardening/vN` | Merge into `poc/base` → tag a new base → merge the tag into each client branch |
| POC-only behaviour (hide a screen, docs, CI) | `poc/base` | Tag a new base → merge into the client branches |
| One client's configuration | `poc/<client>-<region>` | Tag that client branch |
| One client's feature (e.g. OCR document checks for GES US) | `poc/<client>-<region>`, ported as small commits with tests | Move it to `hardening` if a second client needs it |

**Rules:**
- **Never commit directly to a POC branch.** Use a PR with 1 review.
- **Never force-push.**
- **Never merge a client branch back into `poc/base`, `hardening` or `main`.**

## Upgrading a client branch to a new base

1. Tag the new base on `poc/base`, for example `poc-base-v1.1.0`, after its smoke run passes.
2. Open a PR into `poc/<client>-<region>` that merges the tag.
3. CI builds the branch and runs the smoke suite, then the reviewer approves.
4. Tag the client branch and record the smoke result.

## Every release (base or client)

- [ ] Fresh-clone build passes: backend and frontend `npm ci` + `npm run build`, plus `docker build`.
- [ ] `npm test` passes in `backend`.
- [ ] The smoke suite passes against the image running with `NODE_ENV=production`.
- [ ] The image is built with `--build-arg APP_VERSION=<tag>`, and the version shows in the sidebar.
- [ ] `PORT_BACK.md` is updated for any new hardening fix.

## Deployment settings (client Azure)

Secrets go in the client's Key Vault and are passed to the container as Key Vault references:
- `ANTHROPIC_API_KEY`
- `JWT_SECRET`
- `ENCRYPTION_KEY` (never change it after first use)
- `AZURE_SQL_PASSWORD`
- `WORKER_SECRET`
- `INITIAL_ADMIN_PASSWORD` (first start only)

With `NODE_ENV=production` the app refuses to start if a required secret is missing.
Leave `DB_BOOTSTRAP` unset: the client creates the database. See `.env.example`.

## Owners

| Branch | JBS owner | Reviewer |
| --- | --- | --- |
| `hardening/vN`, `poc/base` | _to confirm_ | _to confirm_ |
| `poc/ges-us` | _to confirm_ | _to confirm_ |
| `poc/ges-emea` | _to confirm_ | _to confirm_ |
