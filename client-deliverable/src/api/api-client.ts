import { type APIRequestContext, type APIResponse, expect } from '@playwright/test';
import { logger } from '../utils/logger';

/**
 * Thin, typed wrapper over Playwright's APIRequestContext.
 *
 * Use it for API-level setup/teardown (create the data a UI test depends on)
 * and for validating backend responses alongside UI flows. Centralizing the URL
 * resolution, logging, and the "assert OK" helper keeps call sites clean (DRY).
 */
export class ApiClient {
  constructor(
    private readonly request: APIRequestContext,
    private readonly baseUrl = '',
  ) {}

  private resolve(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  }

  async get(path: string): Promise<APIResponse> {
    const url = this.resolve(path);
    logger.debug(`GET ${url}`);
    return this.request.get(url);
  }

  async post<TBody>(path: string, body: TBody): Promise<APIResponse> {
    const url = this.resolve(path);
    logger.debug(`POST ${url}`);
    return this.request.post(url, { data: body });
  }

  async delete(path: string): Promise<APIResponse> {
    const url = this.resolve(path);
    logger.debug(`DELETE ${url}`);
    return this.request.delete(url);
  }

  /** GET and assert a 2xx response (web-first message), returning the response. */
  async getAndAssertOk(path: string): Promise<APIResponse> {
    const res = await this.get(path);
    expect(res.ok(), `GET ${path} should return a 2xx response`).toBeTruthy();
    return res;
  }

  /** GET, assert a 2xx response, and return the parsed JSON body. */
  async getJson<TResponse>(path: string): Promise<TResponse> {
    const res = await this.getAndAssertOk(path);
    return (await res.json()) as TResponse;
  }
}
