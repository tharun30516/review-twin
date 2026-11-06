import { sleep } from "./limit.js";

export type Fetch = typeof fetch;

export interface GitHubOptions {
  token?: string;
  baseUrl?: string;
  fetch?: Fetch;
  maxRetries?: number;
}

/**
 * Small GitHub REST client with the parts that matter at scale:
 * - ETag cache: repeat requests return 304 and do not count against the rate limit
 * - waits for the rate-limit reset instead of failing
 * - retries 5xx / secondary limits with exponential backoff
 */
export class GitHub {
  private etags = new Map<string, { etag: string; body: unknown }>();
  private f: Fetch;
  private base: string;

  constructor(private opts: GitHubOptions = {}) {
    this.f = opts.fetch ?? fetch;
    this.base = opts.baseUrl ?? "https://api.github.com";
  }

  async get<T>(path: string): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.base}${path}`;
    const maxRetries = this.opts.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "review-twin",
      };
      if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
      const cached = this.etags.get(url);
      if (cached) headers["if-none-match"] = cached.etag;

      const res = await this.f(url, { headers });
      if (res.status === 304 && cached) return cached.body as T;
      if (res.ok) {
        const body = (await res.json()) as T;
        const etag = res.headers.get("etag");
        if (etag) this.etags.set(url, { etag, body });
        return body;
      }

      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0);
      const retryAfter = Number(res.headers.get("retry-after") ?? 0);
      const limited = (res.status === 403 || res.status === 429) && (remaining === "0" || retryAfter > 0);
      const retryable = limited || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        throw new Error(`GitHub ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
      }
      const wait = retryAfter > 0
        ? retryAfter * 1000
        : limited && reset
          ? Math.max(0, reset * 1000 - Date.now()) + 1000
          : 2 ** attempt * 500;
      await sleep(Math.min(wait, 60_000));
    }
  }

  /** Follows `per_page` pagination until `max` items or no more pages. */
  async list<T>(path: string, max: number): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; out.length < max; page++) {
      const batch = await this.get<T[]>(`${path}${sep}per_page=${Math.min(100, max)}&page=${page}`);
      out.push(...batch);
      if (batch.length < Math.min(100, max)) break;
    }
    return out.slice(0, max);
  }

  async postJson(path: string, body: unknown): Promise<unknown> {
    const res = await this.f(`${this.base}${path}`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "review-twin",
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} for POST ${path}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}
