import { createDecipheriv, createECDH, createHmac } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/credentials.js";
import {
  BRIDGE_TOKEN_ACCOUNT,
  BridgeHost,
  pairingKey,
  signBridgeRequest,
  startBridge,
  verifyBridgeResponse,
  withJenkinsLogin,
  type Bridge,
} from "../src/bridge.js";

const TOKEN = "test-bridge-token-0123456789";
const JOB = "https://jenkins.example.test/job/app/api/json";

let bridges: Bridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.map((b) => b.close()));
  bridges = [];
});

async function make(pollTimeoutMs = 50): Promise<Bridge> {
  const b = await startBridge({ port: 0, token: TOKEN, pollTimeoutMs });
  bridges.push(b);
  return b;
}

const base = (port: number) => `http://127.0.0.1:${port}`;

/** Calls the bridge as the extension does: signed request, verified response. */
async function call(
  port: number,
  method: string,
  path: string,
  body?: string,
  token = TOKEN,
): Promise<{ status: number; text: string; verified: boolean }> {
  const { headers, nonce } = signBridgeRequest(token, method, path, body ?? "");
  const res = await fetch(`${base(port)}${path}`, {
    method,
    headers: { ...headers, ...(body != null ? { "content-type": "application/json" } : {}) },
    body,
  });
  const text = await res.text();
  const proof = res.headers.get("x-ridealong-proof");
  return {
    status: res.status,
    text,
    verified: verifyBridgeResponse(token, nonce, res.status, text, proof),
  };
}

type Work = { id: string; method: string; url: string; body: string | null };
const getWork = async (b: Bridge): Promise<Work> =>
  JSON.parse((await call(b.port, "GET", "/poll")).text) as Work;
const postResult = (b: Bridge, reply: Record<string, unknown>) =>
  call(b.port, "POST", "/result", JSON.stringify(reply));

/** A raw request so we can set the Host header (fetch() forbids it) or replay exact headers. */
function rawGet(b: Bridge, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: b.port, path, method: "GET", headers },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("bridge transport", () => {
  it("forwards a request to the extension and returns its response", async () => {
    const b = await make();
    const p = b.fetch(JOB);
    const work = await getWork(b);
    expect(work.method).toBe("GET");
    expect(work.url).toBe(JOB);
    await postResult(b, {
      id: work.id,
      status: 200,
      headers: { "content-type": "application/json", "x-more-data": "false" },
      bodyB64: Buffer.from('{"ok":1}').toString("base64"),
    });
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.headers.get("x-more-data")).toBe("false");
    expect(await res.json()).toEqual({ ok: 1 });
  });

  it("carries the method and body of a POST", async () => {
    const b = await make();
    const p = b.fetch("https://jenkins.example.test/job/app/build", {
      method: "POST",
      body: "a=1",
    });
    const work = await getWork(b);
    expect(work.method).toBe("POST");
    expect(work.body).toBe("a=1");
    await postResult(b, { id: work.id, status: 201 });
    expect((await p).status).toBe(201);
  });

  it("returns a bodyless response for 204 without throwing", async () => {
    const b = await make();
    const p = b.fetch(JOB);
    const work = await getWork(b);
    await postResult(b, { id: work.id, status: 204 });
    const res = await p;
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("rejects the fetch when its signal aborts", async () => {
    const b = await make();
    const controller = new AbortController();
    const p = b.fetch(JOB, { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });
});

describe("bridge mutual authentication", () => {
  it("signs every response, including an idle poll", async () => {
    const b = await make(30);
    const health = await call(b.port, "GET", "/health");
    expect(health).toMatchObject({ status: 200, verified: true });
    const idle = await call(b.port, "GET", "/poll");
    expect(idle).toMatchObject({ status: 204, verified: true });
  });

  it("never puts the token on the wire", () => {
    const { headers } = signBridgeRequest(TOKEN, "GET", "/poll");
    expect(JSON.stringify(headers)).not.toContain(TOKEN);
  });

  it("rejects unsigned, wrongly signed and path-tampered requests", async () => {
    const b = await make();
    expect((await fetch(`${base(b.port)}/health`)).status).toBe(401);
    expect((await call(b.port, "GET", "/health", undefined, "wrong-token")).status).toBe(401);
    const { headers } = signBridgeRequest(TOKEN, "GET", "/health");
    expect((await fetch(`${base(b.port)}/poll`, { headers })).status).toBe(401);
  });

  it("refuses a replayed request and one outside the clock window", async () => {
    const b = await make();
    const { headers } = signBridgeRequest(TOKEN, "GET", "/health");
    expect(await rawGet(b, "/health", headers)).toBe(200);
    expect(await rawGet(b, "/health", headers)).toBe(401);
    const stale = signBridgeRequest(TOKEN, "GET", "/health").headers;
    expect(
      await rawGet(b, "/health", { ...stale, "x-ridealong-ts": String(Date.now() - 600_000) }),
    ).toBe(401);
  });

  it("a squatter on the port cannot prove itself or learn the token", async () => {
    const seen: string[] = [];
    const squatter = createServer((req, res) => {
      seen.push(JSON.stringify(req.headers));
      res.setHeader("x-ridealong-proof", "0".repeat(64));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", method: "GET", url: "https://mail.example.com/inbox" }));
    });
    await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", r));
    const { port } = squatter.address() as AddressInfo;
    const res = await call(port, "GET", "/poll");
    await new Promise<void>((r) => squatter.close(() => r()));
    expect(res.verified).toBe(false);
    expect(seen.join("")).not.toContain(TOKEN);
  });

  it("ignores a forged unsigned result", async () => {
    const b = await make();
    const p = b.fetch(JOB);
    const work = await getWork(b);
    const forged = await fetch(`${base(b.port)}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: work.id,
        status: 200,
        bodyB64: Buffer.from("forged").toString("base64"),
      }),
    });
    expect(forged.status).toBe(401);
    await postResult(b, {
      id: work.id,
      status: 200,
      bodyB64: Buffer.from("real").toString("base64"),
    });
    expect(await (await p).text()).toBe("real");
  });

  it("rejects a non-extension Origin even when signed", async () => {
    const b = await make();
    const { headers } = signBridgeRequest(TOKEN, "GET", "/health");
    const res = await fetch(`${base(b.port)}/health`, {
      headers: { ...headers, origin: "https://evil.example" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a mismatched Host header (DNS rebinding)", async () => {
    const b = await make();
    const signed = () => signBridgeRequest(TOKEN, "GET", "/health").headers;
    expect(await rawGet(b, "/health", { ...signed(), host: "evil.example" })).toBe(403);
    expect(await rawGet(b, "/health", { ...signed(), host: `127.0.0.1:${b.port}` })).toBe(200);
  });
});

/** The extension's pairing handshake, in Node crypto. Returns the token, or null if refused. */
async function pairClient(port: number, secret: string): Promise<string | null> {
  const keyRes = await fetch(`${base(port)}/pair/key`);
  if (!keyRes.ok) return null;
  const { pub: bridgePub } = (await keyRes.json()) as { pub: string };
  const mine = createECDH("prime256v1");
  mine.generateKeys();
  const extensionPub = mine.getPublicKey().toString("base64url");
  const shared = mine.computeSecret(Buffer.from(bridgePub, "base64url"));
  const key = pairingKey(secret, shared, bridgePub, extensionPub);
  const confirm = createHmac("sha256", key).update("ridealong-v1|pair-client").digest("hex");
  const res = await fetch(`${base(port)}/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pub: extensionPub, confirm }),
  });
  if (!res.ok) return null;
  const { iv, ct } = (await res.json()) as { iv: string; ct: string };
  const sealed = Buffer.from(ct, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from("ridealong-v1|pair-token"));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}

describe("bridge click-to-pair", () => {
  const secretOf = (url: string) => new URL(url).hash.slice(1);

  async function pairable(): Promise<{ b: Bridge; urls: string[]; paired: () => number }> {
    const urls: string[] = [];
    let paired = 0;
    const b = await startBridge({
      port: 0,
      pollTimeoutMs: 30,
      onPairingUrl: (u) => urls.push(u),
      onPaired: () => paired++,
    });
    bridges.push(b);
    return { b, urls, paired: () => paired };
  }

  it("hands the token over once to the holder of the link's secret", async () => {
    const { b, urls, paired } = await pairable();
    b.pair();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${b.port}/pair#[A-Za-z0-9_-]{43}$`),
    );
    const secret = secretOf(urls[0]!);
    expect(await pairClient(b.port, "x".repeat(43))).toBeNull();
    expect(await pairClient(b.port, secret)).toBe(b.token);
    expect(paired()).toBe(1);
    expect(await pairClient(b.port, secret)).toBeNull();
    expect((await call(b.port, "GET", "/health", undefined, b.token)).status).toBe(200);
  });

  it("serves a pairing page that carries neither secret nor token", async () => {
    const { b, urls } = await pairable();
    b.pair();
    const page = await (await fetch(`${base(b.port)}/pair`)).text();
    expect(page).not.toContain(secretOf(urls[0]!));
    expect(page).not.toContain(b.token);
  });

  it("re-opens the page on an extension's request, rate-limited", async () => {
    const { b, urls } = await pairable();
    const ask = () => fetch(`${base(b.port)}/pair/request`, { method: "POST" });
    expect((await ask()).status).toBe(202);
    expect((await ask()).status).toBe(202);
    expect(urls).toHaveLength(1);
  });

  it("refuses pairing requests from a web page", async () => {
    const { b, urls } = await pairable();
    const res = await fetch(`${base(b.port)}/pair/request`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(401);
    expect(urls).toHaveLength(0);
  });

  it("offers no pairing key until pairing starts", async () => {
    const { b } = await pairable();
    expect((await fetch(`${base(b.port)}/pair/key`)).status).toBe(404);
  });
});

describe("Jenkins login guard", () => {
  const ROOT = "https://jenkins.example.test/";
  const WHO = `${ROOT}whoAmI/api/json`;
  const JOB_URL = `${ROOT}job/app/api/json`;

  /** A fake Jenkins: anonymous until `visit` is called (when `visitLogsIn`), then signed in. */
  function fakeJenkins(
    opts: { visitLogsIn?: boolean; visitStatus?: number; jobStatus?: number[] } = {},
  ) {
    let signedIn = false;
    const calls: string[] = [];
    const jobStatus = [...(opts.jobStatus ?? [])];
    const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url === WHO ? "whoAmI" : "job");
      if (url === WHO)
        return Response.json({ anonymous: !signedIn, name: signedIn ? "me" : "anonymous" });
      return new Response("{}", { status: jobStatus.shift() ?? 200 });
    }) as typeof fetch;
    const visit = async (url: string): Promise<Response> => {
      calls.push(`visit ${url}`);
      if (opts.visitLogsIn !== false) signedIn = true;
      return new Response(opts.visitStatus === 401 ? "sign in please" : "{}", {
        status: opts.visitStatus ?? 200,
      });
    };
    return {
      fetchFn,
      visit,
      calls,
      signIn: () => (signedIn = true),
      signOut: () => (signedIn = false),
    };
  }

  it("renews an anonymous Jenkins login by visiting Jenkins before the call", async () => {
    const j = fakeJenkins();
    const guarded = withJenkinsLogin(j.fetchFn, j.visit, ROOT.slice(0, -1));
    expect((await guarded(JOB_URL)).status).toBe(200);
    expect(j.calls).toEqual(["whoAmI", `visit ${ROOT}`, "whoAmI", "job"]);
  });

  it("checks whoAmI at most once a minute while signed in", async () => {
    const j = fakeJenkins();
    j.signIn();
    let t = 0;
    const guarded = withJenkinsLogin(j.fetchFn, j.visit, ROOT, () => t);
    await guarded(JOB_URL);
    t = 30_000;
    await guarded(JOB_URL);
    t = 91_000;
    await guarded(JOB_URL);
    expect(j.calls).toEqual(["whoAmI", "job", "job", "whoAmI", "job"]);
  });

  it("fails with a sign-in message instead of returning anonymous data", async () => {
    const j = fakeJenkins({ visitLogsIn: false });
    const guarded = withJenkinsLogin(j.fetchFn, j.visit, ROOT);
    await expect(guarded(JOB_URL)).rejects.toThrow(/still treats you as anonymous/);
    expect(j.calls).not.toContain("job");
  });

  it("passes on the extension's message when the page needs a manual sign-in", async () => {
    const j = fakeJenkins({ visitStatus: 401 });
    const guarded = withJenkinsLogin(j.fetchFn, j.visit, ROOT);
    await expect(guarded(JOB_URL)).rejects.toThrow("sign in please");
  });

  it("retries a 403 once after renewing a login that lapsed mid-minute", async () => {
    const j = fakeJenkins({ jobStatus: [200, 403] });
    j.signIn();
    let t = 0;
    const guarded = withJenkinsLogin(j.fetchFn, j.visit, ROOT, () => t);
    await guarded(JOB_URL);
    j.signOut();
    t = 10_000;
    expect((await guarded(JOB_URL)).status).toBe(200);
    expect(j.calls).toEqual(["whoAmI", "job", "job", "whoAmI", `visit ${ROOT}`, "whoAmI", "job"]);
  });

  it("returns a 403 untouched when the user is signed in and simply lacks permission", async () => {
    const j = fakeJenkins({ jobStatus: [403] });
    j.signIn();
    const guarded = withJenkinsLogin(j.fetchFn, j.visit, ROOT);
    expect((await guarded(JOB_URL)).status).toBe(403);
    expect(j.calls).toEqual(["whoAmI", "job", "whoAmI"]);
  });
});

describe("bridge visit", () => {
  it("queues a page-open work item and returns the extension's outcome", async () => {
    const b = await make();
    const p = b.visit("https://jenkins.example.test/");
    const work = JSON.parse((await call(b.port, "GET", "/poll")).text) as Record<string, unknown>;
    expect(Object.keys(work).sort()).toEqual(["id", "kind", "url"]);
    expect(work.kind).toBe("visit");
    await postResult(b, {
      id: work.id,
      status: 200,
      bodyB64: Buffer.from("{}").toString("base64"),
    });
    expect((await p).status).toBe(200);
  });
});

describe("bridge host", () => {
  const hosts: BridgeHost[] = [];
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((h) => h.close()));
  });
  const host = (opts: Partial<ConstructorParameters<typeof BridgeHost>[0]> = {}) => {
    const h = new BridgeHost({ env: {}, store: new MemoryStore(), port: 0, ...opts });
    hosts.push(h);
    return h;
  };

  it("starts nothing until a bridge is needed", async () => {
    const store = new MemoryStore();
    host({ store });
    expect(store.tokens.size).toBe(0);
  });

  it("keeps one token in the credential store and reuses it on the next run", async () => {
    const store = new MemoryStore();
    const first = await host({ store }).bridge();
    expect(store.tokens.get(BRIDGE_TOKEN_ACCOUNT)).toBe(first.token);
    const second = await host({ store }).bridge();
    expect(second.token).toBe(first.token);
  });

  it("lets BUTLERBRIDGE_BRIDGE_TOKEN override the stored token", async () => {
    const store = new MemoryStore();
    const b = await host({ store, env: { BUTLERBRIDGE_BRIDGE_TOKEN: TOKEN } }).bridge();
    expect(b.token).toBe(TOKEN);
    expect(store.tokens.size).toBe(0);
  });

  it("explains a port already taken by another bridge", async () => {
    const taken = await host().bridge();
    await expect(host({ port: taken.port }).bridge()).rejects.toThrow(/already in use/);
  });

  it("offers pairing only when no extension connects in time", async () => {
    const opened: string[] = [];
    await host({ openUrl: (u) => opened.push(u), pairIfSilentMs: 20 }).bridge();
    await new Promise((r) => setTimeout(r, 60));
    expect(opened).toHaveLength(1);

    const quiet: string[] = [];
    const store = new MemoryStore();
    await store.set(BRIDGE_TOKEN_ACCOUNT, TOKEN);
    const b = await host({ store, openUrl: (u) => quiet.push(u), pairIfSilentMs: 40 }).bridge();
    await call(b.port, "GET", "/health");
    void call(b.port, "GET", "/poll").catch(() => {});
    await new Promise((r) => setTimeout(r, 80));
    expect(quiet).toHaveLength(0);
  });
});
