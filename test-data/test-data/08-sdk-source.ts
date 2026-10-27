// Paste this into the SDK method (AI-read; needs a tenant Anthropic key). Each method
// that issues an HTTP call becomes an endpoint. Targets the live httpbin.org service.

export interface PostPayload {
  name: string;
  role?: string;
}

/** A tiny client library over httpbin.org. */
export class HttpbinClient {
  constructor(
    private readonly baseUrl: string = 'https://httpbin.org',
    private readonly token?: string,
  ) {}

  /** GET /ip — the caller's origin IP. */
  async getOriginIp(): Promise<{ origin: string }> {
    const res = await fetch(`${this.baseUrl}/ip`);
    return res.json();
  }

  /** GET /uuid — a server-generated UUID. */
  async getUuid(): Promise<{ uuid: string }> {
    const res = await fetch(`${this.baseUrl}/uuid`);
    return res.json();
  }

  /** GET /get?q=... — echoes the query string. */
  async echoQuery(q: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/get?q=${encodeURIComponent(q)}`);
    return res.json();
  }

  /** POST /post — echoes the JSON body. */
  async createRecord(payload: PostPayload): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  /** GET /bearer — requires a bearer token. */
  async checkBearer(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/bearer`, {
      headers: { Authorization: `Bearer ${this.token ?? ''}` },
    });
    return res.json();
  }
}
