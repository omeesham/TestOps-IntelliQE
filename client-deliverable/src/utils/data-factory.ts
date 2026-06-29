/**
 * Test-data factory.
 *
 * Generates unique, disposable data so tests stay INDEPENDENT and IDEMPOTENT:
 * no collisions on re-run, no reliance on pre-seeded records. Tests should
 * create the data they need (here or via the API layer) rather than assuming
 * fixtures already exist in the environment.
 */
import { randomUUID } from 'crypto';

export function uniqueId(prefix = 'id'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function uniqueEmail(domain = 'example.com'): string {
  return `qa.${uniqueId('user')}@${domain}`;
}

export interface NewUser {
  username: string;
  email: string;
  password: string;
}

/** Build a fresh, unique user. Override any field for a specific scenario. */
export function makeUser(overrides: Partial<NewUser> = {}): NewUser {
  return {
    username: uniqueId('user'),
    email: uniqueEmail(),
    password: `Pw!${randomUUID().slice(0, 10)}`,
    ...overrides,
  };
}
