# LLM API keys in Azure Key Vault

IntelliQE never asks for, stores, or displays an LLM API key. The key lives in
the customer's own Azure Key Vault; the backend reads it at call time with its
**managed identity**. The LLM Configuration page only shows *where* the key is,
tests the connection, and lets an admin pick models from the provider's live
catalogue.

```
Admin ──(adds secret)──▶ Azure Key Vault ◀──(managed identity, RBAC: Secrets User)── IntelliQE backend ──▶ Anthropic API
                                                                                          │
                                                             per task, over TLS ──────────┘──▶ worker
```

## One-time setup (per environment)

Replace `<rg>`, `<kv>`, `<app>` with your resource group, vault and Container App names.

```bash
# 1. Give the backend an identity (system-assigned)
az containerapp identity assign -n <app> -g <rg> --system-assigned
PRINCIPAL_ID=$(az containerapp show -n <app> -g <rg> --query identity.principalId -o tsv)

# 2. Let it READ secrets — nothing more (vault must use Azure RBAC permission model)
KV_ID=$(az keyvault show -n <kv> -g <rg> --query id -o tsv)
az role assignment create --assignee-object-id $PRINCIPAL_ID --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" --scope $KV_ID

# 3. Store the key
az keyvault secret set --vault-name <kv> --name anthropic-api-key --value "<sk-ant-api03-…>"

# 4. Point the app at the vault
az containerapp update -n <app> -g <rg> --set-env-vars AZURE_KEY_VAULT_URL=https://<kv>.vault.azure.net/
```

Then open **System Configuration → LLM Configuration**, click **Test
Connection**, choose the default / per-agent models and **Save Settings**.

## Secret names

| Provider  | Default secret name | Override env var           |
|-----------|---------------------|----------------------------|
| Anthropic | `anthropic-api-key` | `ANTHROPIC_KV_SECRET_NAME` |
| OpenAI    | `openai-api-key`    | `OPENAI_KV_SECRET_NAME`    |
| Gemini    | `gemini-api-key`    | `GEMINI_KV_SECRET_NAME`    |

**Per-tenant keys (optional):** `<tenant-slug>-anthropic-api-key` is tried
before the shared secret, so one deployment can bill different tenants to
different Anthropic accounts.

A Claude Code OAuth token (`sk-ant-oat…`) may be stored in the same secret; it
is detected by prefix and sent as a Bearer token.

## Rotation

Create a new version of the secret in Key Vault (`az keyvault secret set …`
again). The backend caches reads for `KV_CACHE_TTL_SECONDS` (default 300 s), so
the new key is used within five minutes without a restart. **Test Connection**
always reads the vault fresh.

## Local development

`az login` is enough — `DefaultAzureCredential` falls back to your Azure CLI
login, so set `AZURE_KEY_VAULT_URL` and grant yourself *Key Vault Secrets User*.
Without a vault, set `ANTHROPIC_API_KEY` in `backend/.env`; the page will show
the key source as an environment variable with a warning.

## Troubleshooting (shown on the page under "API Key Source")

| Message | Fix |
|---|---|
| Access denied — grant … "Key Vault Secrets User" | Step 2 above; RBAC can take a few minutes to apply. If the vault uses *access policies* instead of RBAC, add a policy with **Get** on secrets. |
| No Azure identity available | Step 1 above (or `az login` locally). For a user-assigned identity also set `AZURE_CLIENT_ID`. |
| Key Vault host not reachable | Check `AZURE_KEY_VAULT_URL`; with a private endpoint, the app must be on the VNet. |
| Secret "anthropic-api-key" not found | Step 3 above, or set `ANTHROPIC_KV_SECRET_NAME` to your secret's name. |

## Migrating from keys stored in the database

Earlier versions saved the key in `client_configurations.config_data.apiKey`
and `tenants.anthropic_api_key`. Those values are **no longer read**. After the
key is in Key Vault:

- Saving the LLM settings once rewrites the row without the key.
- `DELETE /api/tenant-settings/anthropic-key` clears the legacy tenant column, or run:
  ```sql
  UPDATE "JBSTestOpsAI".tenants SET anthropic_api_key = NULL;
  ```
