/**
 * Server-side cryptographic utilities.
 *
 * Two distinct concerns are handled here:
 *
 *   1. TRANSIT encryption (frontend → backend) — XOR + Base64 with a shared
 *      key. Used so credentials don't appear as plaintext in the browser's
 *      Network panel. HTTPS is the real wire-level protection; this is just
 *      defense-in-depth against console screenshots. Prefix: `__ENC__`.
 *      Must stay byte-compatible with frontend/src/utils/crypto.ts.
 *
 *   2. AT-REST encryption (DB column / file persistence) — AES-256-GCM with
 *      a 32-byte key supplied via `ENCRYPTION_KEY` env var (Base64). This is
 *      the real protection for stored credentials. Prefix: `__AES__`.
 *      In dev, if `ENCRYPTION_KEY` is unset, a deterministic dev key is used
 *      with a stderr warning (so the app still boots locally).
 *
 *   Legacy values stored with the `__ENC__` prefix (XOR-at-rest from older
 *   versions) are still decryptable transparently. `encryptConfigData` always
 *   writes the new `__AES__` format going forward.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const TRANSIT_KEY = 'iQE-s3cure-tr@nsit-2024!';
const TRANSIT_PREFIX = '__ENC__';
const REST_PREFIX = '__AES__';

// ─── Sensitive field names — credential keys across all integrations ───
export const SENSITIVE_CONFIG_KEYS = new Set([
  'password', 'apiToken', 'api_token', 'apiKey', 'clientSecret',
  'secretKey', 'sasToken', 'accessToken', 'access_token', 'auth_header',
  'serviceAccountKey', 'secretAccessKey', 'accessKey', 'accessKeyId',
  'connStr', 'connectionString', 'serviceKey', 'token', 'bearerToken',
  'authValue', 'smtpPassword', 'app_password', 'webhook_url',
  'anthropic_api_key', 'anthropicApiKey',
]);

// =====================================================================
// AT-REST KEY MANAGEMENT
// =====================================================================

let cachedRestKey: Buffer | null = null;

function getRestKey(): Buffer {
  if (cachedRestKey) return cachedRestKey;
  const raw = process.env.ENCRYPTION_KEY;
  if (raw) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be a Base64 string decoding to exactly 32 bytes (256 bits)');
    }
    cachedRestKey = buf;
  } else {
    // Dev fallback — deterministic, with a warning. NEVER acceptable in prod.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY is required in production');
    }
    // eslint-disable-next-line no-console
    console.warn(
      '[crypto] ENCRYPTION_KEY not set — using DEV fallback (NOT SECURE). ' +
      'Set ENCRYPTION_KEY=<base64 of 32 bytes> in your environment.',
    );
    cachedRestKey = scryptSync('intelliqe-dev-fallback', 'intelliqe-salt', 32);
  }
  return cachedRestKey;
}

// =====================================================================
// TRANSIT ENCRYPTION (frontend ↔ backend) — XOR + Base64
// =====================================================================

/**
 * Encrypt a single string value for safe transit over the wire.
 * Returns the input unchanged if it already carries an encryption prefix.
 */
export function encryptField(value: string): string {
  if (!value || value.startsWith(TRANSIT_PREFIX) || value.startsWith(REST_PREFIX)) return value;
  const keyBytes = Buffer.from(TRANSIT_KEY);
  const valueBytes = Buffer.from(value, 'utf8');
  const encrypted = Buffer.alloc(valueBytes.length);
  for (let i = 0; i < valueBytes.length; i++) {
    encrypted[i] = valueBytes[i]! ^ keyBytes[i % keyBytes.length]!;
  }
  return TRANSIT_PREFIX + encrypted.toString('base64');
}

/** Decrypt a transit-encrypted value. Returns input unchanged if not prefixed. */
export function decryptField(encoded: string): string {
  if (!encoded || !encoded.startsWith(TRANSIT_PREFIX)) {
    // Also unwrap AES if a caller fed us a stored value
    if (encoded && encoded.startsWith(REST_PREFIX)) return decryptAtRest(encoded);
    return encoded;
  }
  const b64 = encoded.slice(TRANSIT_PREFIX.length);
  const keyBytes = Buffer.from(TRANSIT_KEY);
  const encrypted = Buffer.from(b64, 'base64');
  const decrypted = Buffer.alloc(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    decrypted[i] = encrypted[i]! ^ keyBytes[i % keyBytes.length]!;
  }
  return decrypted.toString('utf8');
}

// =====================================================================
// AT-REST ENCRYPTION (DB / persisted storage) — AES-256-GCM
// =====================================================================

/**
 * Encrypt a value for at-rest storage.
 * Format: `__AES__<base64(iv || ciphertext || authTag)>`
 *   - iv:        12 bytes
 *   - authTag:   16 bytes (appended after ciphertext)
 *
 * Idempotent: returns input unchanged if already AES-encrypted.
 */
export function encryptAtRest(plaintext: string): string {
  if (!plaintext || plaintext.startsWith(REST_PREFIX)) return plaintext;
  const key = getRestKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return REST_PREFIX + Buffer.concat([iv, ct, tag]).toString('base64');
}

/** Decrypt an at-rest value. Throws on tampered ciphertext (GCM tag mismatch). */
export function decryptAtRest(encoded: string): string {
  if (!encoded || !encoded.startsWith(REST_PREFIX)) return encoded;
  const buf = Buffer.from(encoded.slice(REST_PREFIX.length), 'base64');
  if (buf.length < 12 + 16 + 1) throw new Error('Invalid AES ciphertext length');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', getRestKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Peel repeated encryption layers. Some values were accidentally encrypted more
 * than once — notably nested role passwords in Application Setup, which bypass
 * the top-level normalize-then-encrypt path and so got re-wrapped each time the
 * form was re-saved. `decryptStored` removes a single layer; this removes them
 * all. Capped to avoid a pathological loop; plaintext (no prefix) returns as-is.
 */
export function decryptStoredDeep(value: string, maxLayers = 6): string {
  let cur = value;
  for (let i = 0; i < maxLayers; i++) {
    if (!cur || (!cur.startsWith(REST_PREFIX) && !cur.startsWith(TRANSIT_PREFIX))) break;
    const next = decryptStored(cur);
    if (next === cur) break; // no progress — stop rather than spin
    cur = next;
  }
  return cur;
}

/**
 * Decrypt any stored value — handles both legacy `__ENC__` (XOR) and
 * current `__AES__` (AES-GCM). Plaintext passes through.
 */
export function decryptStored(value: string): string {
  if (!value) return value;
  if (value.startsWith(REST_PREFIX)) return decryptAtRest(value);
  if (value.startsWith(TRANSIT_PREFIX)) {
    // Legacy at-rest format from before the AES migration
    const b64 = value.slice(TRANSIT_PREFIX.length);
    const keyBytes = Buffer.from(TRANSIT_KEY);
    const encrypted = Buffer.from(b64, 'base64');
    const decrypted = Buffer.alloc(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
      decrypted[i] = encrypted[i]! ^ keyBytes[i % keyBytes.length]!;
    }
    return decrypted.toString('utf8');
  }
  return value;
}

// =====================================================================
// OBJECT-LEVEL HELPERS (used by configurations service + routes)
// =====================================================================

/** Decrypt any transit-encrypted fields in a request body. */
export function decryptBody<T extends Record<string, any>>(body: T): T {
  const result: any = { ...body };
  for (const key of Object.keys(result)) {
    if (typeof result[key] === 'string' && result[key].startsWith(TRANSIT_PREFIX)) {
      result[key] = decryptField(result[key]);
    }
  }
  return result;
}

/**
 * Encrypt all sensitive fields in a config object for at-rest DB storage.
 * Idempotent — values already prefixed with `__AES__` are left alone.
 */
export function encryptConfigData(configData: Record<string, any>): Record<string, any> {
  const result: any = { ...configData };
  for (const key of Object.keys(result)) {
    if (
      SENSITIVE_CONFIG_KEYS.has(key) &&
      typeof result[key] === 'string' &&
      result[key].length > 0 &&
      !result[key].startsWith(REST_PREFIX)
    ) {
      // First normalize transit-encrypted / legacy values, then re-encrypt at rest.
      let plain = result[key];
      if (plain.startsWith(TRANSIT_PREFIX)) plain = decryptStored(plain);
      result[key] = encryptAtRest(plain);
    }
  }
  return result;
}

/** Decrypt all sensitive fields in a config object loaded from DB. */
export function decryptConfigData(configData: Record<string, any>): Record<string, any> {
  const result: any = { ...configData };
  for (const key of Object.keys(result)) {
    if (typeof result[key] === 'string') {
      if (result[key].startsWith(REST_PREFIX) || result[key].startsWith(TRANSIT_PREFIX)) {
        result[key] = decryptStored(result[key]);
      }
    }
  }
  return result;
}

/** Mask sensitive fields for safe API responses (never exposes real values). */
export function maskConfigData(configData: Record<string, any>): Record<string, any> {
  const masked: any = { ...configData };
  for (const key of Object.keys(masked)) {
    if (SENSITIVE_CONFIG_KEYS.has(key) && typeof masked[key] === 'string') {
      const plain =
        masked[key].startsWith(REST_PREFIX) || masked[key].startsWith(TRANSIT_PREFIX)
          ? decryptStored(masked[key])
          : masked[key];
      masked[key] = maskSecret(plain);
    }
  }
  return masked;
}

/** Mask a string for safe display: first 3 + last 2 characters. */
export function maskSecret(value: string): string {
  if (!value || value.length < 8) return '•••••';
  return value.slice(0, 3) + '•••' + value.slice(-2);
}

// =====================================================================
// CHAT MESSAGE SANITIZATION (PHI/credential redaction)
// =====================================================================

const CREDENTIAL_PATTERNS: RegExp[] = [
  /(\?sv=|[&?]sig=)[^\s&"']{8,}/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/gi,
  /Basic\s+[A-Za-z0-9+/]{20,}=*/gi,
  /ghp_[A-Za-z0-9]{36,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /__ENC__[A-Za-z0-9+/=]+/g,
  /__AES__[A-Za-z0-9+/=]+/g,
  /(password|api[_-]?key|api[_-]?token|access[_-]?token|secret[_-]?key|sas[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[^\s"',]{8,}/gi,
];

export function sanitizeChatContent(content: string): string {
  let sanitized = content;
  for (const pattern of CREDENTIAL_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}
