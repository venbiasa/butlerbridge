import { spawn } from "node:child_process";
import {
  createCipheriv,
  createECDH,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  type ECDH,
} from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AuthProvider } from "./auth.js";
import type { Env } from "./config.js";
import type { CredentialStore } from "./credentials.js";
import { ToolError } from "./errors.js";
import type { FetchFn } from "./http.js";

export const DEFAULT_BRIDGE_PORT = 8731;
/** A reconstructed response body larger than this is refused; Jenkins log pages are far smaller. */
const MAX_RESULT_BYTES = 64 * 1024 * 1024;
/** How long a /poll waits for work before answering 204 so the extension re-polls. */
const DEFAULT_POLL_TIMEOUT_MS = 25_000;

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

/** A request waiting for the extension to run it; `visit` opens the URL as a page instead. */
type Work =
  | {
      id: string;
      method: string;
      url: string;
      headers: Record<string, string>;
      body: string | null;
    }
  | { id: string; kind: "visit"; url: string };

/** What the extension sends back for one Work item. */
interface Reply {
  id: string;
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  bodyB64?: string;
}

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

interface Pairing {
  secret: string;
  ecdh: ECDH;
  pub: string;
  expires: number;
  openedAt: number;
}

/** How long a pairing link stays usable. */
const PAIRING_TTL_MS = 10 * 60_000;
/** An extension asking to pair again within this window doesn't open another browser tab. */
const PAIR_REOPEN_MS = 60_000;

const PAIR_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>ridealong pairing</title>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1>ridealong</h1>
<p>Handing this pairing request to the ridealong extension&hellip;</p>
<p>If nothing happens, this browser doesn't have the extension. Copy this page's full address,
including everything after <code>#</code>, into the browser where ridealong is installed.</p>
</body>`;

/** Opens a URL in the default browser; failures are silent because the caller also prints it. */
export function openInBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed link is the fallback.
  }
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
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

function toResponse(reply: Reply): Response {
  const noBody = reply.status === 204 || reply.status === 304 || !reply.bodyB64;
  const body = noBody ? null : Buffer.from(reply.bodyB64 as string, "base64");
  return new Response(body, {
    status: reply.status,
    statusText: reply.statusText,
    headers: reply.headers ?? {},
  });
}

const PROTOCOL_VERSION = "ridealong-v1";
/** Signed requests older or newer than this are refused (replay window). */
const MAX_CLOCK_SKEW_MS = 120_000;

const sha256Hex = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
const hmacHex = (key: string, msg: string): string =>
  createHmac("sha256", key).update(msg).digest("hex");

function equalHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const clientMessage = (
  method: string,
  path: string,
  ts: number,
  nonce: string,
  bodyHash: string,
): string => `${PROTOCOL_VERSION}|client|${method}|${path}|${ts}|${nonce}|${bodyHash}`;

const serverMessage = (nonce: string, status: number, bodyHash: string): string =>
  `${PROTOCOL_VERSION}|server|${nonce}|${status}|${bodyHash}`;

/**
 * The key both sides derive while pairing: keyed by the link's one-time secret, over the ECDH shared
 * secret and both public keys, so neither someone who only saw the link nor someone who only
 * watched the exchange can derive it.
 */
export function pairingKey(
  secret: string,
  sharedSecret: Buffer,
  bridgePub: string,
  extensionPub: string,
): Buffer {
  return createHmac("sha256", secret)
    .update(`${PROTOCOL_VERSION}|pair|${sharedSecret.toString("hex")}|${bridgePub}|${extensionPub}`)
    .digest();
}

/** Signs a bridge call the way the ridealong extension does. */
export function signBridgeRequest(
  token: string,
  method: string,
  path: string,
  body = "",
): { headers: Record<string, string>; nonce: string } {
  const ts = Date.now();
  const nonce = randomBytes(16).toString("hex");
  const auth = hmacHex(token, clientMessage(method, path, ts, nonce, sha256Hex(Buffer.from(body))));
  return {
    nonce,
    headers: { "x-ridealong-ts": String(ts), "x-ridealong-nonce": nonce, "x-ridealong-auth": auth },
  };
}

/** Checks a bridge response's proof the way the ridealong extension does. */
export function verifyBridgeResponse(
  token: string,
  nonce: string,
  status: number,
  body: string,
  proof: string | null,
): boolean {
  const expected = hmacHex(token, serverMessage(nonce, status, sha256Hex(Buffer.from(body))));
  return typeof proof === "string" && equalHex(proof, expected);
}

/**
 * A local control channel for the ridealong browser extension, speaking its `ridealong-v1`
 * protocol (/poll, /result, /health). butlerbridge enqueues Jenkins requests; the extension
 * long-polls `/poll`, runs each in the user's signed-in tab, and posts the response to `/result`.
 *
 * The token is never sent: the extension HMAC-signs each request with it and this bridge signs
 * each response, so a program squatting on the port can neither learn the token nor hand the
 * extension work. Bound to 127.0.0.1, with Host and Origin checks. The Jenkins credentials never
 * reach this process — only the response bytes do.
 *
 * The extension gets the token by click-to-pair: `pair()` (also triggered by an unpaired extension
 * via `/pair/request`) hands `onPairingUrl` a link with a one-time secret; once the user clicks Pair
 * the two run an ECDH exchange keyed by that secret and the token travels encrypted.
 */
export async function startBridge(opts: BridgeOptions = {}): Promise<Bridge> {
  const token = opts.token ?? randomBytes(32).toString("base64url");
  const pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const queue: Work[] = [];
  let connected = false;
  const waiters: ((work: Work | null) => void)[] = [];
  const pending = new Map<string, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
  const seenNonces = new Map<string, number>();
  let port = 0;
  let pairing: Pairing | null = null;

  const activePairing = (): Pairing | null =>
    pairing && pairing.expires > Date.now() ? pairing : null;

  const pair = (): void => {
    let p = activePairing();
    if (!p) {
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      p = pairing = {
        secret: randomBytes(32).toString("base64url"),
        ecdh,
        pub: ecdh.getPublicKey().toString("base64url"),
        expires: Date.now() + PAIRING_TTL_MS,
        openedAt: 0,
      };
    }
    p.openedAt = Date.now();
    opts.onPairingUrl?.(`http://127.0.0.1:${port}/pair#${p.secret}`);
  };

  /** The encrypted token for a valid pairing claim, else null. */
  const claim = (body: Buffer): { iv: string; ct: string } | null => {
    const p = activePairing();
    if (!p) return null;
    let extensionPub: unknown;
    let confirm: unknown;
    let shared: Buffer;
    try {
      ({ pub: extensionPub, confirm } = JSON.parse(body.toString("utf8")) as {
        pub?: unknown;
        confirm?: unknown;
      });
      if (typeof extensionPub !== "string" || typeof confirm !== "string") return null;
      shared = p.ecdh.computeSecret(Buffer.from(extensionPub, "base64url"));
    } catch {
      return null;
    }
    const key = pairingKey(p.secret, shared, p.pub, extensionPub);
    const expected = createHmac("sha256", key)
      .update(`${PROTOCOL_VERSION}|pair-client`)
      .digest("hex");
    if (!equalHex(confirm, expected)) return null;
    pairing = null;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${PROTOCOL_VERSION}|pair-token`));
    const ct = Buffer.concat([cipher.update(token, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return { iv: iv.toString("base64url"), ct: ct.toString("base64url") };
  };

  const dispatch = (work: Work): void => {
    const waiter = waiters.shift();
    if (waiter) waiter(work);
    else queue.push(work);
  };

  /** The request's nonce when its signature is valid and fresh, else null. */
  const verifyClient = (req: IncomingMessage, path: string, body: Buffer): string | null => {
    const ts = Number(req.headers["x-ridealong-ts"]);
    const nonce = req.headers["x-ridealong-nonce"];
    const auth = req.headers["x-ridealong-auth"];
    if (!Number.isFinite(ts) || typeof auth !== "string") return null;
    if (typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) return null;
    const now = Date.now();
    if (Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) return null;
    for (const [n, expires] of seenNonces) if (expires < now) seenNonces.delete(n);
    if (seenNonces.has(nonce)) return null;
    const expected = hmacHex(
      token,
      clientMessage(req.method ?? "", path, ts, nonce, sha256Hex(body)),
    );
    if (!equalHex(auth, expected)) return null;
    seenNonces.set(nonce, now + 2 * MAX_CLOCK_SKEW_MS);
    return nonce;
  };

  const send = (
    res: ServerResponse,
    nonce: string,
    status: number,
    body: string | null,
    contentType?: string,
  ): void => {
    const buf = body == null ? Buffer.alloc(0) : Buffer.from(body);
    res.setHeader(
      "x-ridealong-proof",
      hmacHex(token, serverMessage(nonce, status, sha256Hex(buf))),
    );
    if (contentType) res.setHeader("content-type", contentType);
    res.writeHead(status).end(buf.length ? buf : undefined);
  };

  const cors = (req: IncomingMessage, res: ServerResponse): void => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin.startsWith("chrome-extension://")) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader(
        "Access-Control-Allow-Headers",
        "content-type, x-ridealong-ts, x-ridealong-nonce, x-ridealong-auth",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "x-ridealong-proof");
    }
  };

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_RESULT_BYTES) {
          reject(new Error("bridge body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    cors(req, res);
    // Reject a mismatched Host (DNS-rebinding defence): only loopback names may reach us.
    const host = (req.headers.host ?? "").split(":")[0];
    if (host && host !== "127.0.0.1" && host !== "localhost") {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin === "string" && !origin.startsWith("chrome-extension://")) {
      res.writeHead(401).end();
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413).end();
      return;
    }
    const path = (req.url ?? "").split("?")[0] ?? "";

    // Pairing is unauthenticated by nature; the one-time secret in the link carries the trust.
    if (req.method === "GET" && path === "/pair") {
      res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader("cache-control", "no-store");
      res.setHeader("referrer-policy", "no-referrer");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAIR_PAGE);
      return;
    }
    if (req.method === "GET" && path === "/pair/key") {
      const p = activePairing();
      if (!p) res.writeHead(404).end();
      else
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ pub: p.pub }));
      return;
    }
    if (req.method === "POST" && path === "/pair/claim") {
      const sealed = claim(body);
      if (!sealed) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(sealed));
      opts.onPaired?.();
      return;
    }
    if (req.method === "POST" && path === "/pair/request") {
      const p = activePairing();
      if (!p || Date.now() - p.openedAt > PAIR_REOPEN_MS) pair();
      res.writeHead(202).end();
      return;
    }

    const nonce = verifyClient(req, path, body);
    if (!nonce) {
      res.writeHead(401).end();
      return;
    }

    if (req.method === "GET" && path === "/health") {
      send(res, nonce, 200, JSON.stringify({ ok: true }), "application/json");
      return;
    }
    if (req.method === "GET" && path === "/poll") {
      connected = true;
      const next = queue.shift();
      if (next) {
        send(res, nonce, 200, JSON.stringify(next), "application/json");
        return;
      }
      let settled = false;
      const finish = (work: Work | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (work) send(res, nonce, 200, JSON.stringify(work), "application/json");
        else send(res, nonce, 204, null);
      };
      const timer = setTimeout(() => finish(null), pollTimeoutMs);
      waiters.push(finish);
      // The request body is already consumed, so only the response's close reliably signals a
      // dropped long-poll.
      res.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const i = waiters.indexOf(finish);
        if (i >= 0) waiters.splice(i, 1);
      });
      return;
    }
    if (req.method === "POST" && path === "/result") {
      send(res, nonce, 204, null);
      let reply: Reply;
      try {
        reply = JSON.parse(body.toString("utf8")) as Reply;
      } catch {
        return;
      }
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      try {
        entry.resolve(toResponse(reply));
      } catch (err) {
        entry.reject(err as Error);
      }
      return;
    }
    send(res, nonce, 404, null);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? DEFAULT_BRIDGE_PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const enqueue = (work: Work, signal?: AbortSignal): Promise<Response> => {
    const { id } = work;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = (): void => {
        pending.delete(id);
        reject(abortError());
      };
      pending.set(id, {
        resolve: (r) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(r);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      dispatch(work);
    });
  };

  const fetchFn = ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const url =
      input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headersToObject(init?.headers);
    const body = init?.body == null ? null : String(init.body);
    const id = randomBytes(12).toString("hex");
    return enqueue({ id, method, url, headers, body }, init?.signal ?? undefined);
  }) as FetchFn;

  const visit = (url: string, signal?: AbortSignal): Promise<Response> =>
    enqueue({ id: randomBytes(12).toString("hex"), kind: "visit", url }, signal);

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      for (const w of waiters.splice(0)) w(null);
      for (const { reject } of pending.values()) reject(new Error("bridge closed"));
      pending.clear();
      server.close(() => resolve());
      server.closeAllConnections();
    });

  const address = server.address();
  port = typeof address === "object" && address ? address.port : (opts.port ?? DEFAULT_BRIDGE_PORT);
  return { fetch: fetchFn, port, token, close, pair, visit, connected: () => connected };
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
