/**
 * PII Masking Utility
 * Detects and masks personally identifiable information in data before storage.
 */

const PII_PATTERNS: { name: string; regex: RegExp; mask: (m: string) => string }[] = [
  {
    name: 'ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    mask: (m) => `***-**-${m.slice(-4)}`,
  },
  {
    name: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/gi,
    mask: (m) => {
      const [local, domain] = m.split('@');
      return `${local[0]}***@***.${domain.split('.').pop()}`;
    },
  },
  {
    name: 'credit_card',
    regex: /\b\d{13,16}\b/g,
    mask: (m) => `****-****-****-${m.slice(-4)}`,
  },
  {
    name: 'phone',
    regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
    mask: (m) => `***-***-${m.slice(-4)}`,
  },
];

/** Known PII column names (case-insensitive) */
const SENSITIVE_COLUMN_NAMES = new Set([
  'email', 'e_mail', 'email_address', 'emailaddress',
  'ssn', 'social_security', 'social_security_number',
  'phone', 'phone_number', 'phonenumber', 'mobile', 'cell',
  'credit_card', 'creditcard', 'card_number', 'cardnumber',
  'password', 'passwd', 'secret', 'token', 'api_key', 'apikey',
  'first_name', 'last_name', 'full_name', 'firstname', 'lastname',
  'address', 'street', 'zip', 'zipcode', 'zip_code',
  'date_of_birth', 'dob', 'birth_date',
  'ip_address', 'ipaddress',
]);

/**
 * Check if a column name is likely PII
 */
export function isSensitiveColumn(columnName: string): boolean {
  return SENSITIVE_COLUMN_NAMES.has(columnName.toLowerCase().trim());
}

/**
 * Mask PII patterns found in a string value
 */
export function maskPiiInString(value: string): string {
  let masked = value;
  for (const pattern of PII_PATTERNS) {
    masked = masked.replace(pattern.regex, pattern.mask);
  }
  return masked;
}

/**
 * Recursively mask PII in an object. Masks:
 * 1. Known sensitive column names → fully masked
 * 2. String values matching PII regex patterns → partially masked
 */
export function maskPiiInObject(
  obj: Record<string, any>,
  sensitiveColumns?: string[]
): Record<string, any> {
  const extraSensitive = new Set(
    (sensitiveColumns || []).map((c) => c.toLowerCase())
  );

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();

    // Fully mask known sensitive columns
    if (SENSITIVE_COLUMN_NAMES.has(lowerKey) || extraSensitive.has(lowerKey)) {
      result[key] = typeof value === 'string' ? '***MASKED***' : value;
      continue;
    }

    // Recursively handle nested objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = maskPiiInObject(value, sensitiveColumns);
      continue;
    }

    // Mask PII patterns in string values
    if (typeof value === 'string') {
      result[key] = maskPiiInString(value);
      continue;
    }

    // Handle arrays
    if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === 'string') return maskPiiInString(item);
        if (item && typeof item === 'object') return maskPiiInObject(item, sensitiveColumns);
        return item;
      });
      continue;
    }

    result[key] = value;
  }
  return result;
}

/**
 * Mask PII in sample data rows (array of objects)
 */
export function maskSampleData(
  rows: Record<string, any>[],
  sensitiveColumns?: string[]
): Record<string, any>[] {
  return rows.map((row) => maskPiiInObject(row, sensitiveColumns));
}
