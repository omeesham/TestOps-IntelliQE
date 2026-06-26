/**
 * Client-side encryption for sensitive fields before network transmission.
 * Prevents credentials from appearing in plain text in the browser Network tab.
 * Uses XOR cipher + Base64 encoding with a shared key.
 */

const SHARED_KEY = 'iQE-s3cure-tr@nsit-2024!';

export function encryptField(value: string): string {
  // Idempotency guard — never re-encrypt an already-encrypted value. Without
  // this, re-saving a form that loaded a stored `__ENC__`/`__AES__` value (e.g.
  // a role password in Application Setup) would wrap it in another layer, and
  // the server's single-pass decrypt would then hand ciphertext to consumers.
  if (!value || value.startsWith('__ENC__') || value.startsWith('__AES__')) return value;
  const keyBytes = new TextEncoder().encode(SHARED_KEY);
  const valueBytes = new TextEncoder().encode(value);
  const encrypted = new Uint8Array(valueBytes.length);
  for (let i = 0; i < valueBytes.length; i++) {
    encrypted[i] = valueBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return '__ENC__' + btoa(String.fromCharCode(...encrypted));
}

/** Encrypt all values in an object that match sensitive key names */
const SENSITIVE_KEYS = new Set([
  'password', 'apiToken', 'api_token', 'apiKey', 'clientSecret', 'secretKey',
  'connStr', 'connectionString', 'serviceKey', 'secretAccessKey',
  'accessKey', 'accessKeyId', 'token', 'bearerToken', 'authValue',
  // Integration-specific credential field names
  'sasToken', 'accessToken', 'access_token', 'auth_header', 'serviceAccountKey',
  'smtpPassword', 'app_password', 'webhook_url',
  // Databricks
  'DATABRICKS_TOKEN', 'databricks_token',
]);

export function encryptSensitiveFields<T extends Record<string, any>>(obj: T): T {
  const result = { ...obj };
  for (const key of Object.keys(result)) {
    if (SENSITIVE_KEYS.has(key) && typeof result[key] === 'string') {
      (result as any)[key] = encryptField(result[key]);
    }
  }
  return result;
}
