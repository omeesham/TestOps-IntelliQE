# IntelliQE on Azure: install pack

One script installs or updates IntelliQE in a resource group: `deploy-intelliqe.ps1`.
It is safe to run again; every step checks what already exists.

## Before you run it

| Needed | Who | Notes |
| --- | --- | --- |
| Resource group | Client infra | One per installation |
| Access to the resource group | Client infra | **Contributor** is enough with `-AccessModel policy` (default). With **Contributor + Role Based Access Control Administrator**, use `-AccessModel rbac` (no registry password; preferred) |
| Container registry in the resource group, with the image imported | Client infra / JBS | `az acr import --name <registry> --source intelliqeacr.azurecr.io/jbsintelliqe-app:<tag> --username <guest pass> --password <...>` |
| Subnet with a route to the app under test | Client infra | Only when the app under test is on the client's private network: a /23 (or larger) subnet delegated to `Microsoft.App/environments`, routed to the on-prem network, with DNS for the app's host name. Pass it as `-InfrastructureSubnetId`. **It cannot be added to an existing environment later** |
| Anthropic API key | Client | Put into the Key Vault the script creates, as `anthropic-api-key`; the script stops and says so when it is missing |
| Azure CLI 2.60+ and PowerShell 5.1+ | Whoever runs it | `az login --tenant <tenant id>` first |

## Run

```powershell
./deploy-intelliqe.ps1 -SubscriptionId <id> -ResourceGroup <rg> -Location <region> `
  -NamePrefix <3-12 lowercase> -RegistryName <registry> -ImageTag poc-v1 `
  [-InfrastructureSubnetId <subnet resource id>] [-AccessModel policy|rbac]
```

The first run creates the Key Vault and stops if `anthropic-api-key` is missing; add it and run again.
At the end it prints the URL, the health result and where the first administrator's password is.

## What it creates

| Resource | Name | Purpose |
| --- | --- | --- |
| Managed identity | `id-<prefix>` | Reads the app's secrets from Key Vault (and pulls the image with `rbac`) |
| Key Vault | `kv-<prefix>-nnnn` | `sqlpassword`, `jwtsecret`, `encryptionkey`, `workersecret`, `initial-admin-password` (generated, never overwritten), `anthropic-api-key` (client) |
| Azure SQL server + database | `sql-<prefix>-nnnnn` / `JBSTestOpsAI` (Basic) | Users, test cases, results. Firewall: Azure services only |
| Storage account + file share | `st<prefix>nnnnn` / `intelliqe` | Test files, run reports, artifacts (survive restarts and updates) |
| Log Analytics + Container Apps environment | `log-<prefix>`, `cae-<prefix>` | Logs; where the app runs |
| Container App | `ca-<prefix>` | IntelliQE: 2 CPU, 4 GiB, exactly 1 copy, HTTPS on port 443 |

Resources are tagged `intelliqe=<prefix>`; a second run finds them by that tag.

## Network (all HTTPS, port 443)

| From | To | Why |
| --- | --- | --- |
| IntelliQE | The app under test | To test it (needs the subnet above for a private app) |
| IntelliQE | `api.anthropic.com` | The AI that writes and heals tests |
| IntelliQE | Jira (if used) | Read tickets, log defects |
| Users | `https://ca-<prefix>.<region>.azurecontainerapps.io` | Use IntelliQE in a browser |

## Check after install

1. The script prints `health: OK`.
2. Sign in as `iqeadmin` with the password from Key Vault; change it; create named users.
3. System Configuration: LLM Test Connection says Connected; add the application with its URL and the read-only setting.
4. Run one test against the application. If it cannot open the app, it is the network path.

## Update and roll back

- Update: import the new tag, run the script with `-ImageTag <new tag>`.
- Roll back: run it with the previous tag. SQL data and the file share are not touched.
- Remove: delete the resources tagged `intelliqe=<prefix>` (or the resource group).

## Known limits (POC)

- One copy of the app (in-memory script-generation progress and a single test runner).
- The app signs in to SQL as the server administrator; a contained database user is the production step.
- SQL firewall allows Azure services; private endpoints are the production step.
