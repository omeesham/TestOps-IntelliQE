import { LoginPage } from '../pages';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import type { Credentials } from '../types';

/**
 * Business-action layer.
 *
 * Flows orchestrate one or more page objects into reusable, intent-named
 * business operations (e.g. "log in as a user"). Tests call flows for
 * multi-step journeys, while page objects stay focused on a single screen (SRP).
 * This keeps specs readable and removes duplicated multi-step setup (DRY).
 */
export class AuthFlow {
  constructor(private readonly loginPage: LoginPage) {}

  /** Navigate to the login screen and submit the given credentials. */
  async login(credentials: Credentials): Promise<void> {
    logger.info(`Logging in as "${credentials.username}"`);
    await this.loginPage.open();
    await this.loginPage.login(credentials.username, credentials.password);
  }

  /**
   * Log in as the environment-configured user (USERNAME/PASSWORD from `.env` or
   * the secret manager). Keeps real credentials out of test code entirely.
   */
  async loginAsEnvUser(): Promise<void> {
    if (!env.USERNAME || !env.PASSWORD) {
      throw new Error('USERNAME/PASSWORD are not set. Provide them via .env or your secret manager.');
    }
    await this.login({ username: env.USERNAME, password: env.PASSWORD });
  }
}
