/**
 * Cloud-agnostic secret resolution.
 *
 *   SECRETS_PROVIDER=env  (default) — read straight from process.env
 *   SECRETS_PROVIDER=azure-kv       — fetch from Azure Key Vault
 *   SECRETS_PROVIDER=aws-sm         — fetch from AWS Secrets Manager
 *   SECRETS_PROVIDER=gcp-sm         — fetch from GCP Secret Manager
 *
 * Callers do `await getSecret('JWT_SECRET')` and the right backend is used.
 * Values are cached in-process; call `clearSecretCache()` when rotating.
 *
 * For Azure KV: env vars `AZURE_KEY_VAULT_URL` + the standard Azure
 * `DefaultAzureCredential` chain (Managed Identity in Azure App Service).
 * For AWS SM: standard AWS credential chain + `AWS_REGION`.
 * For GCP SM: `GCP_PROJECT_ID` + `GOOGLE_APPLICATION_CREDENTIALS`.
 */

const cache = new Map<string, string>();

async function fetchFromAzure(name: string): Promise<string | undefined> {
  const url = process.env.AZURE_KEY_VAULT_URL;
  if (!url) throw new Error('AZURE_KEY_VAULT_URL is required for SECRETS_PROVIDER=azure-kv');
  const { DefaultAzureCredential } = await import('@azure/identity');
  const { SecretClient } = await import('@azure/keyvault-secrets');
  const client = new SecretClient(url, new DefaultAzureCredential());
  const secret = await client.getSecret(name);
  return secret.value || undefined;
}

async function fetchFromAws(name: string): Promise<string | undefined> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const res = await client.send(new GetSecretValueCommand({ SecretId: name }));
  return res.SecretString || undefined;
}

async function fetchFromGcp(name: string): Promise<string | undefined> {
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) throw new Error('GCP_PROJECT_ID is required for SECRETS_PROVIDER=gcp-sm');
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({
    name: `projects/${projectId}/secrets/${name}/versions/latest`,
  });
  return version.payload?.data?.toString();
}

/**
 * Resolve a secret by name. Returns `undefined` if not found and no fallback.
 * For provider=env, returns `process.env[name]` directly.
 */
export async function getSecret(name: string, fallback?: string): Promise<string | undefined> {
  if (cache.has(name)) return cache.get(name);
  const provider = (process.env.SECRETS_PROVIDER || 'env').toLowerCase();
  let value: string | undefined;
  try {
    switch (provider) {
      case 'env':       value = process.env[name]; break;
      case 'azure-kv':  value = await fetchFromAzure(name); break;
      case 'aws-sm':    value = await fetchFromAws(name); break;
      case 'gcp-sm':    value = await fetchFromGcp(name); break;
      default:
        throw new Error(`Unknown SECRETS_PROVIDER: ${provider}`);
    }
  } catch (err) {
    // Fall through to fallback / env on resolution errors so the app can boot
    // even if the secrets backend is briefly unavailable. Log and continue.
    // eslint-disable-next-line no-console
    console.error(`[secrets] Failed to resolve "${name}" via ${provider}:`, (err as Error).message);
  }
  if (!value) value = process.env[name] ?? fallback;
  if (value !== undefined) cache.set(name, value);
  return value;
}

export function clearSecretCache(name?: string): void {
  if (name) cache.delete(name);
  else cache.clear();
}
