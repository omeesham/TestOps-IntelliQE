import { type ApiClient } from './api-client';
import { logger } from '../utils/logger';

/**
 * Automatic test-data cleanup.
 *
 * A test registers each resource it creates (by its DELETE path); the
 * `apiCleanup` fixture runs `dispose()` in its teardown phase, so created data
 * is removed after every test. This keeps tests idempotent and prevents
 * environment pollution — no orphaned records accumulate across runs.
 */
export class ApiCleanup {
  private readonly deletePaths: string[] = [];

  constructor(private readonly api: ApiClient) {}

  /** Register a resource (by its DELETE path) to be removed at test teardown. */
  track(deletePath: string): void {
    this.deletePaths.push(deletePath);
  }

  /** Delete all tracked resources (most-recent first). Best-effort: never throws. */
  async dispose(): Promise<void> {
    for (const path of [...this.deletePaths].reverse()) {
      try {
        await this.api.delete(path);
      } catch (error) {
        logger.warn(`Cleanup failed for ${path}`, error);
      }
    }
  }
}
