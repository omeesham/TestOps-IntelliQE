# JBS IntelliQE — Azure Deployment Run-Book

End-to-end reference for how IntelliQE is deployed to Azure Container Apps, what is
configured automatically vs. manually, and how to diagnose problems.

> **Audience:** whoever owns the Azure deployment / CI/CD.
> **Scope:** the single Container App `ca-intelliqe` deployed from `main` via GitHub Actions.

---

## 1. Architecture at a glance

```
GitHub (push to main)
      │  .github/workflows/azure-build-push.yml
      ▼
GitHub Actions ──build──► ACR (intelliqeacr.azurecr.io/jbsintelliqe-app:<sha>)
      │                        │
      │  az containerapp update│ (pull image)
      ▼                        ▼
Azure Container App  ca-intelliqe   ──TCP 1433 (TLS)──►  Azure SQL Database
  (1 container, 3 processes via supervisor)                intelliqe.database.windows.net
    • nginx        :80  ── serves React SPA + proxies /api  DB: Intelliqe-sql
    • Express API  :3001                                    user: intelliqeuser
    • worker            (pipeline jobs)
```

**Single image, single container.** The React frontend, Express API, and pipeline
worker all ship in one image (`Dockerfile`). nginx serves the SPA on port 80 and
reverse-proxies `/api` (+ SSE) to the API on 3001. There is **no separate frontend
deploy** — a frontend change requires rebuilding and redeploying this image.

---

## 2. Azure resources & identifiers

| Thing | Value |
|---|---|
| Subscription | New Microsoft Azure Sponsorship |
| Resource group | `IntelliQE` |
| Container App | `ca-intelliqe` |
| Managed environment | `env-qe` |
| Public URL | https://ca-intelliqe.kindrock-4b091262.eastus.azurecontainerapps.io |
| Container Registry | `intelliqeacr.azurecr.io` |
| Image | `jbsintelliqe-app` (tags: `latest` + per-commit `<sha>`) |
| SQL logical server | `intelliqe` (FQDN `intelliqe.database.windows.net`) |
| SQL database | `Intelliqe-sql` |
| SQL user | `intelliqeuser` |
| Ingress | external, **targetPort 80**, transport auto |
| Health probes | Liveness / Readiness / Startup → **TCP 80** |

---

## 3. What is configured (the "have")

### 3.1 Container App runtime — environment variables

All set on `ca-intelliqe` and **persist across deploys** (the workflow uses
`--set-env-vars`, which merges rather than replaces):

| Env var | Value / source |
|---|---|
| `NODE_ENV` | `production` |
| `AZURE_SQL_SERVER` | `intelliqe.database.windows.net` |
| `AZURE_SQL_DATABASE` | `Intelliqe-sql` |
| `AZURE_SQL_USER` | `intelliqeuser` |
| `AZURE_SQL_PORT` | `1433` |
| `DB_SSL` | `true` |
| `AZURE_SQL_PASSWORD` | `secretref:sqlpassword` |
| `JWT_SECRET` | `secretref:jwtsecret` |
| `ENCRYPTION_KEY` | `secretref:encryptionkey` |
| `WORKER_SECRET` | `secretref:workersecret` |

### 3.2 Container App secrets (provisioned out-of-band, persist across deploys)

| Secret | Purpose | Required in prod? |
|---|---|---|
| `sqlpassword` | Azure SQL password for `intelliqeuser` | Yes — DB auth |
| `jwtsecret` | HS256 key for signing user JWTs (≥32 chars) | **Yes** — `jwt.ts` throws without it |
| `encryptionkey` | AES-256-GCM key (base64, 32 bytes) for at-rest credential encryption | **Yes** — `crypto.ts` throws without it |
| `workersecret` | Shared secret for worker ↔ API auth | Recommended |

> These four secrets live **on the Container App** (and ideally should be backed by
> Azure Key Vault). The CI workflow only *references* them via `secretref` and only
> *overwrites* one if the matching GitHub secret is non-empty — so a blank or stale
> GitHub secret can never wipe a working value.

### 3.3 Seed data (automatic)

`backend/src/db.ts → initDb()` runs on every API boot. It is fully idempotent
(`IF NOT EXISTS` guards) — it creates all tables and seeds:

- 1 platform tenant — `Jade Business Solutions` (slug `jbs`, `is_platform=1`)
- Users:
  - `jbsadmin` / `Omeesha@19` — role `admin`
  - `qaengineer` / `Login@2026` — role `qa_engineer`
- 5 `qa_agent_types` rows

> ⚠️ The seed passwords are stored **plaintext** in `db.ts` (the login route at
> `index.ts` accepts plaintext OR bcrypt). Rotate them to bcrypt hashes before any
> real production use — see §5.5. Do **not** apply the SQL files in
> `backend/db/seed/*.sql`; those are legacy **PostgreSQL** dialect and will error on
> Azure SQL. The runtime `initDb()` is the only correct path.

### 3.4 CI/CD workflow — `.github/workflows/azure-build-push.yml`

On `push: main` (or manual `workflow_dispatch`):

1. Build the image, push to ACR as `:latest` and `:<sha>`.
2. `az containerapp registry set` (only if `ACR_USERNAME` provided).
3. Refresh the 4 app secrets **only** from non-empty GitHub secrets.
4. `az containerapp ingress update --target-port 80` — guarantees reachability.
5. `az containerapp update --image :<sha> --set-env-vars …` — the immutable per-commit
   tag forces a **new revision**; single-revision mode shifts 100% traffic to it.

DB target (server/database/user) is read from **GitHub Actions Variables** with the
current values as fallback defaults — see §5.2.

### 3.5 Local development

- `backend/.env` (gitignored) holds `AZURE_SQL_*` for `npm run dev`.
- `npm run dev` / `npm run worker:start` load it via Node's `--env-file-if-exists=.env`.
- `docker-compose.yml` runs the full image locally; it reads `AZURE_SQL_*` from a
  `.env` next to the compose file (`${VAR:-default}` interpolation). The local SQL
  Server container was removed — local dev points at the same Azure SQL by default.

---

## 4. Prerequisites / one-time setup

### 4.1 Azure CLI (for manual ops)

`az` is installed but **not on PATH**. Either add it or call the full path:

```
C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd
```

Add to PATH (PowerShell, current user):
```powershell
$p = "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin"
[Environment]::SetEnvironmentVariable("Path", "$env:Path;$p", "User")
```

Verify a session exists:
```powershell
az account show -o table     # if empty: az login
```

---

## 5. What you must do manually (the "to-do")

### 5.1 Required GitHub secrets (CI cannot deploy without these)

These authenticate to the registry and Azure — unavoidable for any CI deploy. Set in
**GitHub → Settings → Secrets and variables → Actions → Secrets**:

| Secret | Used by | Notes |
|---|---|---|
| `ACR_USERNAME` | build + deploy | ACR admin username (or use managed identity) |
| `ACR_PASSWORD` | build + deploy | ACR admin password |
| `AZURE_CREDENTIALS` | `azure/login` | service-principal JSON |

### 5.2 Changing the database (e.g. standing up a prod DB)

DB connection is **environment-variable driven** — no code change needed.

**For CI/CD (prod):** GitHub → Settings → Secrets and variables → Actions →
**Variables** tab, set any of:

| Variable | Default if unset |
|---|---|
| `AZURE_SQL_SERVER` | `intelliqe.database.windows.net` |
| `AZURE_SQL_DATABASE` | `Intelliqe-sql` |
| `AZURE_SQL_USER` | `intelliqeuser` |

Set the password via the **Secret** `SQL_ADMIN_PASSWORD` (or rotate the `sqlpassword`
Container App secret directly — §5.4). Then push to `main`; the next revision connects
to the new DB.

**For local docker-compose:** edit `.env` next to `docker-compose.yml`.
**For `npm run dev`:** edit `backend/.env`.

> New DB checklist: (1) DB exists and `initDb()` user can create tables in `dbo`;
> (2) firewall allows the app (see §6.1); (3) the `sqlpassword` secret matches the new
> user's password.

### 5.3 Deploying (trigger CI/CD)

The workflow triggers on **push to `main`**. Current work is on
`feature-exploration-agent` — merge/PR it into `main` to deploy.

**Confirming a deploy went live.** The sidebar shows a build stamp at the bottom in
the form `V<build>-DDMMYY` (e.g. `V42-150626`), where `<build>` is the GitHub Actions
run number and `DDMMYY` is the build date. It is injected at image-build time
(`Dockerfile` ARG `APP_VERSION` → `VITE_APP_VERSION` → `import.meta.env`). After a
deploy, hard-refresh the app and check the stamp incremented — if it didn't change,
you're still on the old revision (browser cache, or the deploy didn't run). Locally it
reads `dev`.

### 5.4 Rotating a Container App secret manually

```powershell
az containerapp secret set -n ca-intelliqe -g IntelliQE --secrets "sqlpassword=<new>"
# restart so the change takes effect (or just deploy):
az containerapp revision restart -n ca-intelliqe -g IntelliQE `
  --revision $(az containerapp show -n ca-intelliqe -g IntelliQE --query properties.latestRevisionName -o tsv)
```

Generate strong values:
```powershell
# 32-byte base64 (JWT / ENCRYPTION_KEY)
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

> `ENCRYPTION_KEY` must stay **stable** once data has been written — changing it makes
> previously at-rest-encrypted values undecryptable.

### 5.5 Hardening before real production

- Rotate seed user passwords to bcrypt hashes (see `backend/db/seed/README.md` §"After
  running the seed"); update the values in `db.ts` seed so fresh DBs aren't plaintext.
- Back the 4 Container App secrets with Azure Key Vault references.
- Restrict SQL firewall from "Allow all Azure services" to the app's outbound IPs.
- Set a platform `ANTHROPIC_API_KEY` if you want platform-wide AI (otherwise per-tenant
  keys only — the worker logs `No platform ANTHROPIC_API_KEY`).

---

## 6. Root-cause playbook

Every issue below was actually hit and fixed during setup. **The pattern: the symptom
the user sees is rarely the root cause — always pull the container logs and the
revision/ingress/probe config.**

### Triage order
1. `az containerapp revision list` → is the latest revision **Healthy/Running**?
2. `az containerapp logs show --type console` → what does the app actually say at boot?
3. `curl https://<fqdn>/api/health` → is ingress routing to the app?
4. Reproduce the failing API call with `curl` and read the **HTTP status** — it
   distinguishes "bad request/credentials" (4xx) from "server threw" (500).

### 6.1 DB: `Failed to connect to localhost:1433`
- **Cause:** no `AZURE_SQL_SERVER` (and no `DB_HOST`) on the running container, so
  `db.ts buildConfig()` falls back to `localhost`.
- **Find it:** `az containerapp logs show … --type console`; check env with
  `az containerapp show … --query "properties.template.containers[0].env[].name"`.
- **Fix:** set `AZURE_SQL_*` env vars (§3.1). Via CI it's automatic now.

### 6.2 DB: `Login failed for user '…'`
- **Cause:** wrong password, wrong user, or **SQL firewall blocking** the container.
- **Find it:** distinct from "could not connect" (that's network/host). "Login failed"
  = reached the server, auth rejected. Check the `sqlpassword` secret vs. the DB user.
- **Firewall:** the app's outbound IPs must be allowed. The server has
  `AllowAllWindowsAzureIps` (0.0.0.0) which covers Container Apps. Verify:
  ```powershell
  az sql server firewall-rule list -g IntelliQE -s intelliqe -o table
  ```

### 6.3 URL times out / 0 bytes (app looks fine in logs)
- **Cause #1 — ingress `targetPort: 0`:** ingress not pointed at nginx.
- **Cause #2 — health probes on a bogus port (e.g. TCP 23040):** all probes fail →
  revision stays `Unhealthy`/`Activating` → Container Apps refuses to route traffic,
  even though the app started cleanly.
- **Find it:**
  ```powershell
  az containerapp show -n ca-intelliqe -g IntelliQE `
    --query "{tp:properties.configuration.ingress.targetPort, probes:properties.template.containers[0].probes}" -o json
  az containerapp revision list -n ca-intelliqe -g IntelliQE `
    --query "[].{name:name, health:properties.healthState, running:properties.runningState}" -o json
  ```
- **Fix:**
  ```powershell
  az containerapp ingress update -n ca-intelliqe -g IntelliQE --type external --target-port 80 --transport auto
  # probes: export yaml, set tcpSocket.port to 80, re-apply
  az containerapp show -n ca-intelliqe -g IntelliQE -o yaml > app.yaml   # edit ports 23040 -> 80
  az containerapp update -n ca-intelliqe -g IntelliQE --yaml app.yaml
  ```
  (Both are now enforced by the workflow / live template, so they carry forward.)

### 6.4 Login shows "Invalid credentials" but creds are correct
- **Cause:** the API actually returns **HTTP 500 "Login failed"** (a server throw), and
  the frontend renders any failure as "Invalid credentials". The throw is
  `JWT_SECRET is required in production` from `jwt.ts` — `JWT_SECRET` was unset.
- **Find it:** curl the endpoint and read the status:
  ```bash
  curl -sS -X POST https://<fqdn>/api/auth/login -H "Content-Type: application/json" \
    -d '{"username":"jbsadmin","password":"Omeesha@19"}' -w "\nHTTP %{http_code}\n"
  # 401 = real bad credentials;  500 "Login failed" = server threw (check JWT_SECRET)
  ```
  Confirm the stored value if in doubt — connect to the DB and `SELECT username,
  password_hash, is_active FROM dbo.users`.
- **Fix:** set `jwtsecret` secret (≥32 chars) + `JWT_SECRET=secretref:jwtsecret` env.

### 6.5 Saving an integration/credential 500s
- **Cause:** `ENCRYPTION_KEY is required in production` from `crypto.ts` — at-rest AES
  encryption has no key. Login does not use it, so this only surfaces when a config
  with a credential is saved.
- **Fix:** set `encryptionkey` secret (base64, 32 bytes) + `ENCRYPTION_KEY=secretref:encryptionkey`.

### 6.6 A working app breaks right after a deploy
- **Cause:** the deploy overwrote a secret/env with a bad value (e.g. a GitHub secret
  that is empty or stale), or the workflow pointed at the wrong DB.
- **Find it:** compare env/secrets before vs. after; read the Actions run log for the
  `containerapp update` / `secret set` step.
- **Prevention (already in place):** the workflow only refreshes a secret when its
  GitHub secret is non-empty, and DB target falls back to known-good defaults.

---

## 7. Diagnostic command cheat-sheet

> Prefix with the full `az` path if not on PATH (§4.1).

```powershell
# Health of the latest revision
az containerapp revision list -n ca-intelliqe -g IntelliQE `
  --query "[].{name:name, health:properties.healthState, running:properties.runningState, replicas:properties.replicas}" -o table

# Live application logs (stdout of api/nginx/worker)
az containerapp logs show -n ca-intelliqe -g IntelliQE --type console --tail 50
az containerapp logs show -n ca-intelliqe -g IntelliQE --type console --follow   # stream

# System logs (provisioning / pull / probe events)
az containerapp logs show -n ca-intelliqe -g IntelliQE --type system --tail 50

# Full effective config
az containerapp show -n ca-intelliqe -g IntelliQE -o yaml

# Env var names / secret names
az containerapp show -n ca-intelliqe -g IntelliQE --query "properties.template.containers[0].env[].name" -o tsv
az containerapp secret list -n ca-intelliqe -g IntelliQE --query "[].name" -o tsv

# Ingress + probes
az containerapp show -n ca-intelliqe -g IntelliQE `
  --query "{ingress:properties.configuration.ingress, probes:properties.template.containers[0].probes}" -o json

# End-to-end HTTP checks
curl -sS https://ca-intelliqe.kindrock-4b091262.eastus.azurecontainerapps.io/api/health -w "\nHTTP %{http_code}\n"
curl -sS https://ca-intelliqe.kindrock-4b091262.eastus.azurecontainerapps.io/ -o /dev/null -w "HTTP %{http_code}\n"

# SQL firewall rules
az sql server firewall-rule list -g IntelliQE -s intelliqe -o table
```

```bash
# Inspect users in the DB (run from backend/ with AZURE_SQL_* set)
node --env-file=.env -e "import('mssql').then(async m=>{const p=await new m.default.ConnectionPool({server:process.env.AZURE_SQL_SERVER,database:process.env.AZURE_SQL_DATABASE,user:process.env.AZURE_SQL_USER,password:process.env.AZURE_SQL_PASSWORD,options:{encrypt:true,trustServerCertificate:true}}).connect();console.table((await p.request().query('SELECT username,role,is_active FROM dbo.users')).recordset);await p.close()})"
```

---

## 8. Production-required env vars (quick reference)

If `NODE_ENV=production`, the API **throws on boot or on use** when these are missing:

| Env var | Enforced in | Failure mode |
|---|---|---|
| `JWT_SECRET` (≥32 chars) | `utils/jwt.ts` | login → 500 "Login failed" |
| `ENCRYPTION_KEY` (base64 32 bytes) | `utils/crypto.ts` | saving any credential → 500 |
| `AZURE_SQL_*` + `sqlpassword` | `db.ts` | DB connect/login failure at boot |

All are currently set on `ca-intelliqe`. Keep them set on any new environment.
