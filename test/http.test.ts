import { describe, expect, it } from "vitest";
import { BasicAuth } from "../src/auth.js";
import { JenkinsClient } from "../src/http.js";
import { runTool } from "../src/runtime.js";
import { BASE, json, mockJenkins, parse, session, TOKEN, USER } from "./helpers.js";

const auth = () => new BasicAuth(USER, TOKEN);

describe("crumb handling", () => {
  it("fetches a crumb once and sends it with its session cookie on every POST", async () => {
    const jenkins = mockJenkins({
      "GET /crumbIssuer/api/json": () =>
        json({ crumbRequestField: "Jenkins-Crumb", crumb: "c-123" }, 200, {
          "Set-Cookie": "JSESSIONID.abc=sess1; Path=/; HttpOnly",
        }),
      "POST /job/a/build": () =>
        new Response(null, { status: 201, headers: { Location: `${BASE}/queue/item/5/` } }),
    });
    const client = new JenkinsClient({
      baseUrl: BASE,
      auth: auth(),
      timeoutMs: 1000,
      fetch: jenkins.fetch,
    });
    await client.post("/job/a/build");
    await client.post("/job/a/build");
    const crumbCalls = jenkins.calls.filter((c) => c.url.pathname === "/crumbIssuer/api/json");
    const posts = jenkins.calls.filter((c) => c.method === "POST");
    expect(crumbCalls).toHaveLength(1);
    expect(posts).toHaveLength(2);
    for (const p of posts) {
      expect(p.headers.get("Jenkins-Crumb")).toBe("c-123");
      expect(p.headers.get("Cookie")).toBe("JSESSIONID.abc=sess1");
      expect(p.headers.get("Authorization")).toMatch(/^Basic /);
    }
  });

  it("posts without a crumb when the server has no crumb issuer", async () => {
    const jenkins = mockJenkins({
      "GET /crumbIssuer/api/json": 404,
      "POST /job/a/build": () => new Response(null, { status: 201 }),
    });
    const client = new JenkinsClient({
      baseUrl: BASE,
      auth: auth(),
      timeoutMs: 1000,
      fetch: jenkins.fetch,
    });
    await client.post("/job/a/build");
    await client.post("/job/a/build");
    const post = jenkins.calls.find((c) => c.method === "POST")!;
    expect(post.headers.get("Jenkins-Crumb")).toBeNull();
    expect(jenkins.calls.filter((c) => c.url.pathname === "/crumbIssuer/api/json")).toHaveLength(1);
  });

  it("refetches an expired crumb once", async () => {
    let issued = 0;
    let posts = 0;
    const jenkins = mockJenkins({
      "GET /crumbIssuer/api/json": () =>
        json({ crumbRequestField: "Jenkins-Crumb", crumb: `c-${++issued}` }),
      "POST /job/a/build": (call) => {
        posts++;
        return call.headers.get("Jenkins-Crumb") === "c-1"
          ? new Response("No valid crumb was included in the request", { status: 403 })
          : new Response(null, { status: 201 });
      },
    });
    const client = new JenkinsClient({
      baseUrl: BASE,
      auth: auth(),
      timeoutMs: 1000,
      fetch: jenkins.fetch,
    });
    const res = await client.post("/job/a/build");
    expect(res.status).toBe(201);
    expect(issued).toBe(2);
    expect(posts).toBe(2);
  });
});

describe("transport rules", () => {
  it("refuses plain HTTP unless the profile allows it, and warns when it does", () => {
    expect(
      () =>
        new JenkinsClient({ baseUrl: "http://ci.internal.test", auth: auth(), timeoutMs: 1000 }),
    ).toThrow(/Refusing plain HTTP/);
    const warnings: string[] = [];
    new JenkinsClient({
      baseUrl: "http://ci.internal.test",
      auth: auth(),
      timeoutMs: 1000,
      allowInsecureHttp: true,
      onWarning: (m) => warnings.push(m),
    });
    expect(warnings[0]).toMatch(/plain HTTP/);
  });

  it("sends basic auth built from user and token", async () => {
    const jenkins = mockJenkins({ "GET /whoAmI/api/json": { name: "alice", anonymous: false } });
    const client = new JenkinsClient({
      baseUrl: BASE,
      auth: auth(),
      timeoutMs: 1000,
      fetch: jenkins.fetch,
    });
    await client.json("/whoAmI/api/json");
    expect(jenkins.calls[0]!.headers.get("Authorization")).toBe(
      `Basic ${Buffer.from(`${USER}:${TOKEN}`).toString("base64")}`,
    );
  });
});

describe("error mapping", () => {
  const cases: [number, RegExp][] = [
    [401, /rejected the credentials.*HTTP 401/],
    [403, /HTTP 403.*not authenticated.*or this user lacks the permission/],
    [405, /HTTP 405/],
    [500, /server error \(HTTP 500/],
    [503, /server error \(HTTP 503/],
  ];

  it.each(cases)("maps HTTP %i to a FAILED result with a hint", async (status, pattern) => {
    const jenkins = mockJenkins({ "GET /whoAmI/api/json": status });
    const out = await runTool(session(jenkins.fetch), "whoAmI", {});
    expect(out.isError).toBe(true);
    const body = parse(out.text);
    expect(body.status).toBe("FAILED");
    expect(body.message).toMatch(pattern);
  });

  it("maps a 404 on a core lookup to the plugin's empty result, not an error", async () => {
    const jenkins = mockJenkins({});
    const out = await runTool(session(jenkins.fetch), "getBuild", { jobFullName: "missing" });
    expect(out.isError).toBe(false);
    expect(parse(out.text)).toEqual({
      status: "COMPLETED",
      message: "Search completed, but no results were found for the specified criteria.",
    });
  });

  it("maps a timeout", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const out = await runTool(session(hanging, { timeoutMs: 50 }), "whoAmI", {});
    expect(out.isError).toBe(true);
    expect(parse(out.text).message).toMatch(/timed out after 50 ms/);
  });

  it("maps a network failure", async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("getaddrinfo ENOTFOUND ci.example.test"),
      });
    };
    const out = await runTool(session(failing), "whoAmI", {});
    expect(parse(out.text).message).toMatch(/Could not reach Jenkins.*ENOTFOUND/);
  });

  it("never echoes credentials, even when Jenkins reflects them", async () => {
    const encoded = Buffer.from(`${USER}:${TOKEN}`).toString("base64");
    const jenkins = mockJenkins({
      "GET /job/a/lastBuild/api/json": () =>
        json({
          number: 1,
          description: `Authorization: Basic ${encoded} token ${TOKEN}`,
        }),
    });
    const out = await runTool(session(jenkins.fetch), "getBuild", { jobFullName: "a" });
    expect(out.text).not.toContain(TOKEN);
    expect(out.text).not.toContain(encoded);
  });
});
