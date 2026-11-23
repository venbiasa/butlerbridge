import { signRequest, verifyResponse } from "ridealong";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/credentials.js";
import {
  BRIDGE_TOKEN_ACCOUNT,
  BridgeHost,
  startBridge,
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
  const { headers, nonce } = signRequest(token, method, path, body ?? "");
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
    verified: verifyResponse(token, nonce, res.status, text, proof),
  };
}

type Work = { id: string; method: string; url: string; body: string | null };
const getWork = async (b: Bridge): Promise<Work> =>
  JSON.parse((await call(b.port, "GET", "/poll")).text) as Work;
const postResult = (b: Bridge, reply: Record<string, unknown>) =>
  call(b.port, "POST", "/result", JSON.stringify(reply));

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
    expect(Object.keys(work).sort()).toEqual(["deadline", "id", "kind", "url"]);
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
