import type { AuthProvider } from "./auth.js";
import { JenkinsHttpError, JenkinsTimeoutError, ToolError } from "./errors.js";

export type FetchFn = typeof fetch;
export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  method?: "GET" | "POST";
  query?: Query;
  body?: string | URLSearchParams;
  contentType?: string;
  /** Statuses returned to the caller instead of thrown. */
  acceptStatus?: number[];
  /** Follow redirects (default) or hand the 3xx back. */
  redirect?: "follow" | "manual";
  /** Caller-owned abort signal; replaces the per-request timeout so a long body read stays covered. */
  signal?: AbortSignal;
}

export interface ClientOptions {
  baseUrl: string;
  auth: AuthProvider;
  timeoutMs: number;
  fetch?: FetchFn;
  userAgent?: string;
  onWarning?: (message: string) => void;
  allowInsecureHttp?: boolean;
  /** Called after every HTTP exchange, with the path only (no query, no headers). */
  onRequest?: (record: RequestRecord) => void;
}

export interface RequestRecord {
  method: string;
  path: string;
  /** HTTP status, or "timeout" / "network error". */
  status: number | "timeout" | "network error";
  ms: number;
}

/** Plain-HTTP warnings already printed in this process. */
const warnedInsecure = new Set<string>();

interface Crumb {
  field: string;
  value: string;
  cookie: string | null;
}

const MAX_ERROR_BODY = 300;

/** Thin REST client: auth, timeouts, CSRF crumbs and error mapping. Never logs headers. */
export class JenkinsClient {
  readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private crumb: Crumb | null | undefined;

  constructor(private readonly opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    const protocol = new URL(this.baseUrl).protocol;
    if (protocol === "http:") {
      if (!opts.allowInsecureHttp) {
        throw new ToolError(
          `Refusing plain HTTP for ${this.baseUrl}: the API token would cross the network unencrypted. ` +
            "Use https, or set allowInsecureHttp: true in the profile for a trusted internal network.",
        );
      }
      if (!warnedInsecure.has(this.baseUrl)) {
        warnedInsecure.add(this.baseUrl);
        opts.onWarning?.(
          `Warning: talking to ${this.baseUrl} over plain HTTP (allowInsecureHttp). The API token is sent unencrypted.`,
        );
      }
    }
  }

  url(path: string, query?: Query): URL {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return url;
  }

  async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const method = options.method ?? "GET";
    const send = async (retrying: boolean): Promise<Response> => {
      const url = this.url(path, options.query);
      const headers = new Headers();
      if (this.opts.userAgent) headers.set("User-Agent", this.opts.userAgent);
      if (options.contentType) headers.set("Content-Type", options.contentType);
      await this.opts.auth.apply(headers, url);
      if (method === "POST") {
        const crumb = await this.getCrumb();
        if (crumb) {
          headers.set(crumb.field, crumb.value);
          if (crumb.cookie) headers.set("Cookie", crumb.cookie);
        }
      }
      const res = await this.fetchWithTimeout(
        url,
        method,
        path,
        {
          method,
          headers,
          body: options.body,
          redirect: options.redirect ?? "follow",
        },
        options.signal,
      );
      if (!retrying && (res.status === 401 || res.status === 407) && this.opts.auth.refresh) {
        if (await this.opts.auth.refresh(res.status)) {
          await res.body?.cancel();
          return send(true);
        }
      }
      if (!retrying && method === "POST" && res.status === 403 && this.crumb) {
        const text = await res.text();
        if (/crumb/i.test(text)) {
          this.crumb = undefined;
          return send(true);
        }
        throw new JenkinsHttpError(res.status, method, path, text.slice(0, MAX_ERROR_BODY));
      }
      return res;
    };
    const res = await send(false);
    const ok = res.ok || (res.status >= 300 && res.status < 400 && options.redirect === "manual");
    if (!ok && !options.acceptStatus?.includes(res.status)) {
      const text = await res.text().catch(() => "");
      throw new JenkinsHttpError(res.status, method, path, text.slice(0, MAX_ERROR_BODY));
    }
    return res;
  }

  async json<T = unknown>(path: string, query?: Query): Promise<T> {
    const res = await this.request(path, { query });
    try {
      return (await res.json()) as T;
    } catch {
      throw new ToolError(`Jenkins answered ${path} with something that is not JSON`);
    }
  }

  /** Like {@link json} but resolves to null on 404. */
  async jsonOrNull<T = unknown>(path: string, query?: Query): Promise<T | null> {
    const res = await this.request(path, { query, acceptStatus: [404] });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    return (await res.json()) as T;
  }

  async text(path: string, query?: Query): Promise<string> {
    return (await this.request(path, { query })).text();
  }

  async post(
    path: string,
    body?: URLSearchParams | string,
    extra: Omit<RequestOptions, "method" | "body"> = {},
  ): Promise<Response> {
    return this.request(path, {
      ...extra,
      method: "POST",
      body: body ?? new URLSearchParams(),
      contentType:
        extra.contentType ??
        (typeof body === "string" ? "text/plain" : "application/x-www-form-urlencoded"),
    });
  }

  /** Fetches the crumb once per client. Servers without a crumb issuer (404) need none. */
  private async getCrumb(): Promise<Crumb | null> {
    if (this.crumb !== undefined) return this.crumb;
    const path = "/crumbIssuer/api/json";
    const url = this.url(path);
    const headers = new Headers();
    if (this.opts.userAgent) headers.set("User-Agent", this.opts.userAgent);
    await this.opts.auth.apply(headers, url);
    const res = await this.fetchWithTimeout(url, "GET", path, { method: "GET", headers });
    if (res.status === 404) {
      await res.body?.cancel();
      this.crumb = null;
      return null;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new JenkinsHttpError(res.status, "GET", path, text.slice(0, MAX_ERROR_BODY));
    }
    const data = (await res.json()) as { crumbRequestField?: string; crumb?: string };
    if (!data.crumbRequestField || !data.crumb) {
      this.crumb = null;
      return null;
    }
    this.crumb = {
      field: data.crumbRequestField,
      value: data.crumb,
      cookie: sessionCookie(res.headers),
    };
    return this.crumb;
  }

  private async fetchWithTimeout(
    url: URL,
    method: string,
    path: string,
    init: RequestInit,
    external?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const signal = external ?? controller.signal;
    const timer = external ? undefined : setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const started = Date.now();
    const record = (status: RequestRecord["status"]) =>
      this.opts.onRequest?.({ method, path: url.pathname, status, ms: Date.now() - started });
    try {
      const res = await this.fetchFn(url, { ...init, signal });
      record(res.status);
      return res;
    } catch (err) {
      record(signal.aborted ? "timeout" : "network error");
      if (signal.aborted) throw new JenkinsTimeoutError(method, path, this.opts.timeoutMs);
      const reason = (err as Error & { cause?: Error }).cause?.message ?? (err as Error).message;
      throw new ToolError(
        `Could not reach Jenkins at ${this.baseUrl} (${method} ${path}): ${reason}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Crumbs are bound to the web session that issued them, so the POST must carry that session cookie. */
function sessionCookie(headers: Headers): string | null {
  const list =
    typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : (headers.get("set-cookie") ?? "").split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
  const pairs = list
    .map((c) => c.split(";")[0]?.trim())
    .filter((c): c is string => Boolean(c && c.includes("=")));
  return pairs.length ? pairs.join("; ") : null;
}
