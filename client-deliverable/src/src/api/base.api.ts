import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * BaseApi — the contract every service object extends.
 *
 * This is the API half of the Page Object Model. Where a page object
 * encapsulates the selectors and interactions of one screen, a SERVICE OBJECT
 * encapsulates the requests of one endpoint or resource: the URL, the headers,
 * the payload. Specs talk to service objects, never to raw URLs — that is the
 * whole point: when the endpoint moves, its auth scheme changes or a header is
 * added, you fix one service object, not dozens of tests.
 *
 * Generated service objects look like:
 *
 *   export class UsersApi extends BaseApi {
 *     async listUsers(): Promise<APIResponse> {
 *       return this.send('GET', 'https://api.example.com/v1/users', {
 *         headers: { Accept: 'application/json' },
 *       });
 *     }
 *   }
 */

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Request body, already serialised. */
  data?: string;
}

export abstract class BaseApi {
  /** Wall-clock duration of the most recent request, in milliseconds. */
  private lastDurationMs = 0;

  constructor(protected readonly request: APIRequestContext) {}

  /** How long the last request took — what response-time assertions read. */
  get durationMs(): number {
    return this.lastDurationMs;
  }

  /**
   * Issue one HTTP request and time it. Every service-object method goes
   * through here, so timing — and any cross-cutting concern added later
   * (retries, correlation ids, logging) — has exactly one place to live.
   */
  protected async send(method: string, url: string, options: RequestOptions = {}): Promise<APIResponse> {
    const started = Date.now();
    try {
      return await this.request.fetch(url, { method, ...options });
    } finally {
      this.lastDurationMs = Date.now() - started;
    }
  }

  /**
   * Parse a response as JSON, failing with the reason rather than a bare
   * "Unexpected token" when the endpoint answers with HTML or an empty body.
   */
  async json(response: APIResponse): Promise<any> {
    try {
      return await response.json();
    } catch (e) {
      throw new Error('Expected a JSON response body but it did not parse: ' + (e as Error).message);
    }
  }

  /** Response body as text. */
  async text(response: APIResponse): Promise<string> {
    return response.text();
  }
}

/**
 * Read a dotted path ("data.0.email") out of a parsed body.
 *
 * Shared here rather than copied into the top of every spec, which is what the
 * pre-POM renderer did — one definition, one place to fix.
 */
export function getPath(obj: any, path: string): any {
  if (!path) return obj;
  return path.split('.').reduce((o: any, k: string) => (o == null ? undefined : o[k]), obj);
}
