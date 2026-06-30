# Persistent Report Storage on Azure (Azure Files volume)

Reference runbook for giving the IntelliQE Container App a **durable, shared**
directory for test reports (Playwright HTML + Allure), so reports survive
redeploys and are visible across replicas.

## Why this is needed

Reports are written to disk under `REPORTS_ROOT` (see
`backend/src/services/allure-report.service.ts`). On **Azure Container Apps** the
container filesystem is **ephemeral and per-replica**:

- It is **wiped on every redeploy / restart** → "No run / No report" after a deploy.
- It is **not shared across replicas** → the replica that ran the execution has
  the report; a Reports-page request load-balanced to another replica sees nothing.

Mounting an **Azure Files** share at a fixed path and pointing `REPORTS_DIR` at it
fixes both: reports persist across deploys and all replicas read/write the same store.

## Code side (already done)

`REPORTS_ROOT` is configurable and used by every reader and writer:

```ts
// backend/src/services/allure-report.service.ts
export const REPORTS_ROOT = process.env.REPORTS_DIR || path.join(BACKEND_ROOT, 'allure-reports');
```

Consumers: `pipeline-flow.routes.ts` (writes reports), `allure-report.service.ts`
(`getLatestReport` / `getReportStatus` / generate), `allure.routes.ts` (serves files).
With `REPORTS_DIR` unset it uses the in-image path (local dev); set it to the mount
path on Azure.

## Environment (this deployment)

| Thing | Value |
|---|---|
| Resource group | `IntelliQE` |
| Container App | `ca-intelliqe` |
| Managed environment | `env-qe` |
| Location | `eastus` |
| Mount path (in container) | `/data/reports` |
| Env var | `REPORTS_DIR=/data/reports` |
| Env storage name (logical) | `reportsshare` |
| File share name | `reports` |

> `az` not on PATH? Prefix commands with the full path, e.g.
> `& "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd" ...` (PowerShell).
> Run `az login` first.

---

## Step 1 — Create the storage account + file share, and register it with the environment

The storage-account name must be **globally unique, lowercase, ≤24 chars**, so we
append a random suffix.

### PowerShell (one line)

```powershell
$STORAGE="intelliqereports$(Get-Random -Maximum 99999)"; az storage account create -g IntelliQE -n $STORAGE -l eastus --sku Standard_LRS --kind StorageV2; $KEY=(az storage account keys list -g IntelliQE -n $STORAGE --query "[0].value" -o tsv); az storage share-rm create -g IntelliQE --storage-account $STORAGE -n reports --quota 50; az containerapp env storage set -g IntelliQE -n env-qe --storage-name reportsshare --azure-file-account-name $STORAGE --azure-file-account-key $KEY --azure-file-share-name reports --access-mode ReadWrite
```

### bash / WSL (one line)

```bash
STORAGE=intelliqereports$RANDOM; az storage account create -g IntelliQE -n $STORAGE -l eastus --sku Standard_LRS --kind StorageV2 && KEY=$(az storage account keys list -g IntelliQE -n $STORAGE --query "[0].value" -o tsv) && az storage share-rm create -g IntelliQE --storage-account $STORAGE -n reports --quota 50 && az containerapp env storage set -g IntelliQE -n env-qe --storage-name reportsshare --azure-file-account-name $STORAGE --azure-file-account-key "$KEY" --azure-file-share-name reports --access-mode ReadWrite
```

What each command does:

| Command | Purpose |
|---|---|
| `az storage account create` | Creates a Standard LRS StorageV2 account to host the share. |
| `az storage account keys list` | Reads the account key (used to authorize the share for the environment). |
| `az storage share-rm create` | Creates the `reports` file share (50 GiB quota). |
| `az containerapp env storage set` | Registers the share with the **managed environment** under the logical name `reportsshare`, ReadWrite. |

Verify the share is registered:

```powershell
az containerapp env storage list -g IntelliQE -n env-qe -o table
```

You should see `reportsshare`.

---

## Step 2 — Mount the share on the Container App

Volume mounts can't be set with plain flags, so export → edit → apply.

```powershell
az containerapp show -g IntelliQE -n ca-intelliqe -o yaml > app.yaml
```

Edit `app.yaml`: under `properties.template` add a **volumes** block, and a
**volumeMounts** block inside the container (container name is `ca-intelliqe`):

```yaml
properties:
  template:
    containers:
      - name: ca-intelliqe
        # ...existing image / env / resources stay unchanged...
        volumeMounts:
          - volumeName: reports
            mountPath: /data/reports
    volumes:
      - name: reports
        storageType: AzureFile
        storageName: reportsshare
```

Apply:

```powershell
az containerapp update -g IntelliQE -n ca-intelliqe --yaml app.yaml
```

---

## Step 3 — Point the app at the mount

```powershell
az containerapp update -g IntelliQE -n ca-intelliqe --set-env-vars REPORTS_DIR=/data/reports
```

`--set-env-vars` **merges** (doesn't replace), so existing env vars are preserved.

---

## Step 4 — Keep it across future deploys

The CI workflow (`.github/workflows/azure-build-push.yml`) deploys with
`az containerapp update --image … --set-env-vars …`, which **merges** — so the
volume, mount, and `REPORTS_DIR` persist across redeploys once set.

To be safe, add `REPORTS_DIR=/data/reports` to the workflow's `--set-env-vars`
list so it is always asserted on every deploy.

---

## Verify it works

1. Confirm the env var and mount are live:
   ```powershell
   az containerapp show -g IntelliQE -n ca-intelliqe --query "properties.template.volumes" -o json
   az containerapp show -g IntelliQE -n ca-intelliqe --query "properties.template.containers[0].volumeMounts" -o json
   ```
2. Run a fresh execution from the Chat flow.
3. Open **Reports** — the Basic (and Allure) report should render, and should
   still be there **after the next redeploy**.

---

## Notes / troubleshooting

- **`argument --resource-group/-g: expected one argument`** → a shell variable
  (`$RG`/`$APP`) was empty (variables don't persist across PowerShell windows).
  Use literal values as shown above.
- **`az` not recognized** → use the full path
  `C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd`.
- **Storage account name already taken** → re-run Step 1; the random suffix changes.
- The share quota (50 GiB) is generous for reports; lower it if desired
  (`--quota`).
- Reports are grouped as `/data/reports/<tenantId>/<runId>/` — the root holds the
  Playwright HTML report (Basic), with the Allure report under `…/allure/`.
- To inspect the share contents directly, mount it locally or browse it in the
  Azure Portal (Storage account → File shares → `reports`).
