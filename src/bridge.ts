import { randomBytes } from "node:crypto";
import {
  DEFAULT_PORT,
  openInBrowser,
  startBridge as startRidealong,
  type BridgeResponse,
} from "ridealong";
import type { AuthProvider } from "./auth.js";
import type { Env } from "./config.js";
import type { CredentialStore } from "./credentials.js";
import { ToolError } from "./errors.js";
import type { FetchFn } from "./http.js";

export { openInBrowser };

export const DEFAULT_BRIDGE_PORT = DEFAULT_PORT;

/**
 * No credentials of our own: the browser extension carries the request inside the user's signed-in
 * session, so both the IAP cookie and Jenkins' own session cookie are attached by the browser.
 */
export class BridgeAuth implements AuthProvider {
  async apply(): Promise<void> {}
  secrets(): string[] {
    return [];
  }
}

/** The ridealong bridge seen through `fetch`, which is what the Jenkins client speaks. */
export interface Bridge {
  /** A fetch that forwards each request to the extension instead of hitting the network. */
  fetch: FetchFn;
  port: number;
  token: string;
  close(): Promise<void>;
  /** Starts (or re-opens) click-to-pair: hands a one-time pairing link to `onPairingUrl`. */
  pair(): void;
  /**
   * Has the extension open `url` as a page in a background tab, which renews an app login that an
   * API call doesn't. 200 once the page settles on the target origin; 401 when it is left open on a
   * sign-in page for the user.
   */
  visit(url: string, signal?: AbortSignal): Promise<Response>;
  /** Whether an extension holding the token has polled since the bridge started. */
  connected(): boolean;
}

export interface BridgeOptions {
  /** Fixed port so the extension can be preconfigured; 0 picks a free one (tests). */
  port?: number;
  /** Supplied in tests; otherwise a fresh 256-bit token. */
  token?: string;
  pollTimeoutMs?: number;
  /** Receives each pairing link; the caller opens it in the browser that has ridealong. */
  onPairingUrl?: (url: string) => void;
  onPaired?: () => void;
}

type HeadersArg = NonNullable<Parameters<FetchFn>[1]>["headers"];

function headersToObject(init: HeadersArg): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (init instanceof Headers) {
    init.forEach((v, k) => (out[k] = v));
  } else if (Array.isArray(init)) {
    for (const [k, v] of init) if (k) out[k] = v ?? "";
  } else {
    Object.assign(out, init);
  }
  return out;
}

function toResponse(reply: BridgeResponse): Response {
  const noBody = reply.status === 204 || reply.status === 304 || reply.body.length === 0;
  return new Response(noBody ? null : reply.body, {
    status: reply.status,
    statusText: reply.statusText,
    headers: reply.headers,
  });
}

/** Starts a ridealong bridge and exposes it as a `fetch`. */
export async function startBridge(opts: BridgeOptions = {}): Promise<Bridge> {
  const bridge = await startRidealong(opts);
  const fetchFn = (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const url =
      input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    const reply = await bridge.request({
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      headers: headersToObject(init?.headers),
      body: init?.body == null ? null : String(init.body),
      signal: init?.signal ?? undefined,
    });
    return toResponse(reply);
  }) as FetchFn;
  return {
    fetch: fetchFn,
    port: bridge.port,
    token: bridge.token,
    close: () => bridge.close(),
    pair: () => bridge.pair(),
    visit: async (url, signal) => toResponse(await bridge.visit({ url, signal })),
    connected: () => bridge.connected(),
  };
}

/** How long a confirmed Jenkins login is trusted before whoAmI is asked again. */
const LOGIN_CHECK_TTL_MS = 60_000;
/** The login check gets its own budget: opening a page can outlast one API call's timeout. */
const LOGIN_CHECK_TIMEOUT_MS = 60_000;

/**
 * Wraps a bridge fetch so Jenkins calls never quietly run as anonymous. Jenkins' own login lapses
 * separately from the gateway's, and a page load renews it while an API call doesn't. So before a
 * call (at most once a minute, and again after a 403) it asks `whoAmI`; when that says anonymous it
 * has the extension open Jenkins in a background tab, checks again, and fails with a sign-in message
 * if Jenkins still doesn't know the user. A 403 is retried once after a renewed login.
 */
export function withJenkinsLogin(
  fetchFn: FetchFn,
  visit: Bridge["visit"],
  baseUrl: string,
  now: () => number = Date.now,
): FetchFn {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const whoAmIUrl = new URL("whoAmI/api/json", root).toString();
  let verifiedAt = -Infinity;
  let inflight: Promise<boolean> | null = null;

  const isAnonymous = async (signal: AbortSignal): Promise<boolean | null> => {
    const res = await fetchFn(whoAmIUrl, { headers: { accept: "application/json" }, signal });
    if (!res.ok) return null;
    try {
      return ((await res.json()) as { anonymous?: unknown }).anonymous === true;
    } catch {
      return null;
    }
  };

  /** Resolves true when it had to renew the login, false when it was already fine or unknowable. */
  const ensure = async (): Promise<boolean> => {
    const signal = AbortSignal.timeout(LOGIN_CHECK_TIMEOUT_MS);
    const anonymous = await isAnonymous(signal);
    if (anonymous === false) verifiedAt = now();
    // Unknown (the gateway itself refused, say): let the real call surface that error.
    if (anonymous !== true) return false;
    const opened = await visit(root, signal);
    if (opened.status !== 200) {
      throw new Error(
        (await opened.text()) || "Jenkins needs you to sign in in the browser that has ridealong.",
      );
    }
    if ((await isAnonymous(signal)) === true) {
      throw new Error(
        "Jenkins still treats you as anonymous after opening it in the browser. Sign in to Jenkins " +
          "in the browser that has ridealong, then retry.",
      );
    }
    verifiedAt = now();
    return true;
  };

  const ensureShared = (): Promise<boolean> => {
    inflight ??= ensure().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    if (now() - verifiedAt > LOGIN_CHECK_TTL_MS) await ensureShared();
    const res = await fetchFn(input, init);
    if (res.status !== 403) return res;
    verifiedAt = -Infinity;
    return (await ensureShared()) ? fetchFn(input, init) : res;
  }) as FetchFn;
}

/** Credential-store account of the bridge token; the colon keeps it apart from profile names. */
export const BRIDGE_TOKEN_ACCOUNT = ":ridealong-bridge";
/** A paired extension polls within its keepalive interval; past this, offer the pairing page. */
const PAIR_IF_SILENT_MS = 40_000;

export interface BridgeHostOptions {
  env: Env;
  store: CredentialStore;
  port?: number;
  warn?: (message: string) => void;
  /** Opens the pairing link; defaults to the system browser. */
  openUrl?: (url: string) => void;
  pairIfSilentMs?: number;
}

/**
 * One bridge per process, started on the first call that needs it, so launching the MCP server (or
 * a client's connection check) opens nothing. The token is kept in the OS credential store, so a
 * paired extension stays paired across runs; `BUTLERBRIDGE_BRIDGE_TOKEN` overrides it. The pairing
 * page opens only when the extension asks for it or hasn't connected within `pairIfSilentMs`.
 */
export class BridgeHost {
  private started: Promise<Bridge> | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: BridgeHostOptions) {}

  readonly fetch = ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) =>
    this.bridge().then((b) => b.fetch(input, init))) as FetchFn;

  readonly visit = (url: string, signal?: AbortSignal): Promise<Response> =>
    this.bridge().then((b) => b.visit(url, signal));

  bridge(): Promise<Bridge> {
    this.started ??= this.start().catch((err: unknown) => {
      this.started = null;
      throw err;
    });
    return this.started;
  }

  async close(): Promise<void> {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    const b = await this.started?.catch(() => null);
    await b?.close();
    this.started = null;
  }

  private async token(): Promise<string | undefined> {
    if (this.opts.env.BUTLERBRIDGE_BRIDGE_TOKEN) return this.opts.env.BUTLERBRIDGE_BRIDGE_TOKEN;
    try {
      const stored = await this.opts.store.get(BRIDGE_TOKEN_ACCOUNT);
      if (stored) return stored;
      const fresh = randomBytes(32).toString("base64url");
      await this.opts.store.set(BRIDGE_TOKEN_ACCOUNT, fresh);
      return fresh;
    } catch (err) {
      this.opts.warn?.(
        `butlerbridge bridge: no OS credential store (${(err as Error).message}); pairing lasts for this run only`,
      );
      return undefined;
    }
  }

  private async start(): Promise<Bridge> {
    const warn = this.opts.warn ?? (() => {});
    const port = this.opts.port ?? DEFAULT_BRIDGE_PORT;
    let bridge: Bridge;
    try {
      bridge = await startBridge({
        port,
        token: await this.token(),
        onPairingUrl: (url) => {
          warn(`butlerbridge bridge: pair the ridealong extension by opening ${url}`);
          (this.opts.openUrl ?? openInBrowser)(url);
        },
        onPaired: () => warn("butlerbridge bridge: paired with the ridealong extension."),
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new ToolError(
          `The bridge port ${port} is already in use, most likely by another butlerbridge session or ` +
            "`ridealong get`. Close that one, or serve with --bridge-port <n> and set the same port in " +
            "the ridealong extension's options.",
        );
      }
      throw err;
    }
    warn(`butlerbridge bridge: listening on 127.0.0.1 port ${bridge.port}`);
    this.silenceTimer = setTimeout(() => {
      if (!bridge.connected()) bridge.pair();
    }, this.opts.pairIfSilentMs ?? PAIR_IF_SILENT_MS);
    this.silenceTimer.unref();
    return bridge;
  }
}
