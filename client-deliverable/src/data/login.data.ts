import type { Credentials } from '../types';

/**
 * Typed, non-sensitive test data for the Login examples.
 *
 * Keep real or sensitive data OUT of source — load credentials from the
 * environment (`config/env.ts`) or an untracked file via `utils/test-data.ts`.
 */
export const invalidCredentials: Credentials = {
  username: 'invalid.user@example.com',
  password: 'wrong-password',
};

/** Data-driven negative-login cases — each row runs as its own independent test. */
export interface LoginCase {
  name: string;
  username: string;
  password: string;
}

export const invalidLoginCases: readonly LoginCase[] = [
  { name: 'unknown user', username: 'nobody@example.com', password: 'whatever' },
  { name: 'empty password', username: 'user@example.com', password: '' },
  { name: 'injection-style payload', username: "' OR '1'='1", password: 'x' },
];
