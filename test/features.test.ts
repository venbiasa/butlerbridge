import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BasicAuth } from "../src/auth.js";
import { runCli } from "../src/cliMain.js";
import { parseConfig } from "../src/config.js";
import { MemoryStore } from "../src/credentials.js";
import { JenkinsClient, type FetchFn } from "../src/http.js";
import { runTool } from "../src/runtime.js";
import { setQueuePollMs } from "../src/tools/common.js";
import { TOOLS } from "../src/tools/index.js";
import { BASE, json, mockJenkins, parse, session, streamedLog, TOKEN, USER } from "./helpers.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bb-features-"));
  setQueuePollMs(1);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  setQueuePollMs(1000);
});

function cliEnv(extra: Record<string, string> = {}) {
  return {
    JENKINS_URL: BASE,
    JENKINS_USER: USER,
    JENKINS_TOKEN: TOKEN,
    BUTLERBRIDGE_CONFIG: join(dir, "missing.json"),
    ...extra,
  };
}

async function cli(argv: string[], fetch: FetchFn, env = cliEnv()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    env,
    store: new MemoryStore(),
    fetch,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("CLI diagnostics for empty answers", () => {
  it("lists the requests behind a 'no results' answer on stderr, path only", async () => {
    const { code, out, err } = await cli(
      ["getBuild", "--jobFullName", "team/app"],
      mockJenkins({}).fetch,
    );
    expect(code).toBe(0);
    expect(parse(out).message).toBe(
      "Search completed, but no results were found for the specified criteria.",
    );
    expect(err).toBe("butlerbridge: GET /job/team/job/app/lastBuild/api/json → 404");
  });

  it("says when a build published no test report", async () => {
    const jenkins = mockJenkins({
      "GET /job/app/10/api/json": { actions: [{ _class: "hudson.model.CauseAction" }] },
    });
    const { err } = await cli(
      ["getTestResults", "--jobFullName", "app", "--buildNumber", "10"],
      jenkins.fetch,
    );
    expect(err).toContain("butlerbridge: GET /job/app/10/api/json → 200");
    expect(err).toContain("butlerbridge: this build published no test report");
  });

  it("tells a report without failures apart from a missing report", async () => {
    const jenkins = mockJenkins({
      "GET /job/app/10/api/json": {
        actions: [{ _class: "hudson.tasks.junit.TestResultAction", failCount: 0 }],
      },
      "GET /job/app/10/testReport/api/json": {
        passCount: 3,
        failCount: 0,
        skipCount: 0,
        suites: [],
      },
    });
    const { err } = await cli(
      ["getTestResults", "--jobFullName", "app", "--buildNumber", "10"],
      jenkins.fetch,
    );
    expect(err).toBe("butlerbridge: the test report of build #10 has no failing tests");
  });

  it("prints every request with its timing under --verbose", async () => {
    const jenkins = mockJenkins({ "GET /job/app/lastBuild/api/json": { number: 1 } });
    const { err } = await cli(["getBuild", "--jobFullName", "app", "--verbose"], jenkins.fetch);
    expect(err).toMatch(/^butlerbridge: GET \/job\/app\/lastBuild\/api\/json → 200 \(\d+ ms\)$/);
  });

  it("keeps MCP results free of diagnostics", async () => {
    const out = await runTool(session(mockJenkins({}).fetch), "getBuild", { jobFullName: "app" });
    expect(out.text).not.toContain("→");
  });

  it("defaults to compact matches and folded repeats in the CLI", async () => {
    const jenkins = mockJenkins({
      "GET /job/app/lastBuild/api/json": { number: 7 },
      "GET /job/app/7/logText/progressiveText": () => streamedLog(["warn x\nwarn x\nwarn x\n"]),
    });
    const { out } = await cli(
      ["searchBuildLog", "--jobFullName", "app", "--pattern", "warn"],
      jenkins.fetch,
    );
    expect((parse(out).result as { matches: unknown[] }).matches).toEqual([
      { line: 1, text: "warn x … repeated 3× (lines 1–3)" },
    ]);
  });
});

describe("triggerBuild waits for the build", () => {
  function triggerJenkins(probes: object[]) {
    let probe = 0;
    return mockJenkins({
      "GET /crumbIssuer/api/json": 404,
      "GET /job/app/api/json": { buildable: true, property: [] },
      "POST /job/app/build": () =>
        new Response(null, { status: 201, headers: { Location: `${BASE}/queue/item/9/` } }),
      "GET /queue/item/9/api/json": (call) =>
        json(
          call.url.searchParams.get("tree") === "executable[number,url],cancelled,why"
            ? (probes[Math.min(probe++, probes.length - 1)] as object)
            : { id: 9, ...(probes[probes.length - 1] as object) },
        ),
      "POST /job/app/12/submitDescription": 302,
    });
  }

  it("returns once the queue item has a build number", async () => {
    const jenkins = triggerJenkins([
      { why: "Waiting for next available executor" },
      { executable: { number: 12, url: `${BASE}/job/app/12/` } },
    ]);
    const out = await runTool(session(jenkins.fetch, { triggerWaitMs: 2_000 }), "triggerBuild", {
      jobFullName: "app",
    });
    const body = parse(out.text);
    expect(body.message).toContain(`Build #12 started: ${BASE}/job/app/12/.`);
    expect((body.result as { executable: { number: number } }).executable.number).toBe(12);
  });

  it("says why it is still queued when the wait runs out", async () => {
    const jenkins = triggerJenkins([{ why: "Waiting for next available executor" }]);
    const out = await runTool(session(jenkins.fetch, { triggerWaitMs: 30 }), "triggerBuild", {
      jobFullName: "app",
    });
    expect(parse(out.text).message).toMatch(
      /Still queued after 0 s: Waiting for next available executor\. Poll getQueueItem with id 9\./,
    );
  });

  it("reports a cancelled queue item", async () => {
    const jenkins = triggerJenkins([{ cancelled: true }]);
    const out = await runTool(session(jenkins.fetch, { triggerWaitMs: 500 }), "triggerBuild", {
      jobFullName: "app",
    });
    expect(parse(out.text).message).toMatch(/cancelled before a build started/);
  });

  it("labels the build when allowWrite is set", async () => {
    const jenkins = triggerJenkins([{ executable: { number: 12, url: "u" } }]);
    const out = await runTool(
      session(jenkins.fetch, { triggerWaitMs: 500, allowWrite: true }),
      "triggerBuild",
      { jobFullName: "app", description: "flaky test rerun" },
    );
    const post = jenkins.calls.find((c) => c.url.pathname.endsWith("submitDescription"))!;
    expect(new URLSearchParams(post.body).get("description")).toBe(
      "triggered via butlerbridge: flaky test rerun",
    );
    expect(parse(out.text).message).toMatch(/Build description set\./);
  });

  it("skips the label without allowWrite and never fails the trigger over it", async () => {
    const skipped = triggerJenkins([{ executable: { number: 12, url: "u" } }]);
    const out = await runTool(session(skipped.fetch, { triggerWaitMs: 500 }), "triggerBuild", {
      jobFullName: "app",
      description: "x",
    });
    expect(out.isError).toBe(false);
    expect(parse(out.text).message).toMatch(/Description not set: allowWrite is false/);
    expect(skipped.calls.some((c) => c.url.pathname.endsWith("submitDescription"))).toBe(false);

    const failing = mockJenkins({
      "GET /crumbIssuer/api/json": 404,
      "GET /job/app/api/json": { buildable: true, property: [] },
      "POST /job/app/build": () =>
        new Response(null, { status: 201, headers: { Location: `${BASE}/queue/item/9/` } }),
      "GET /queue/item/9/api/json": { id: 9, executable: { number: 12, url: "u" } },
      "POST /job/app/12/submitDescription": 403,
    });
    const res = await runTool(
      session(failing.fetch, { triggerWaitMs: 500, allowWrite: true }),
      "triggerBuild",
      { jobFullName: "app", description: "x" },
    );
    expect(res.isError).toBe(false);
    expect(parse(res.text).message).toMatch(/Could not set the build description.*still triggered/);
  });
});

describe("visible and configurable redaction", () => {
  const routes = (description: string) =>
    mockJenkins({ "GET /job/app/lastBuild/api/json": { number: 1, description } });

  it("counts redactions in the message without revealing them", async () => {
    const out = await runTool(session(routes("password=a token=b secret=c").fetch), "getBuild", {
      jobFullName: "app",
    });
    expect(parse(out.text).message).toBe("Data retrieved successfully (3 values redacted).");
    expect(out.redactions).toBe(3);
  });

  it("applies profile redactPatterns after the built-in rules", async () => {
    const out = await runTool(
      session(routes("ssh ci-runner.internal.example.test 10.20.30.40 /srv/agent-7/x").fetch, {
        redactPatterns: [
          "[a-z-]+\\.internal\\.example\\.test",
          "\\b10\\.\\d+\\.\\d+\\.\\d+\\b",
          "/srv/[^/\\s]+",
        ],
      }),
      "getBuild",
      { jobFullName: "app" },
    );
    const body = parse(out.text);
    expect((body.result as { description: string }).description).toBe(
      "ssh [REDACTED] [REDACTED] [REDACTED]/x",
    );
    expect(body.message).toMatch(/\(3 values redacted\)/);
  });

  it("masks e-mail addresses when maskEmails is on", async () => {
    const jenkins = routes("by jane.doe@example.com and ops@build.example.org");
    const plain = await runTool(session(jenkins.fetch), "getBuild", { jobFullName: "app" });
    expect(plain.text).toContain("jane.doe@example.com");
    const masked = await runTool(session(jenkins.fetch, { maskEmails: true }), "getBuild", {
      jobFullName: "app",
    });
    expect((parse(masked.text).result as { description: string }).description).toBe(
      "by j***@example.com and o***@build.example.org",
    );
  });

  it.each([
    [["(unclosed"], /not a valid regular expression/],
    [["a".repeat(1001)], /too long/],
    [["(a+)+"], /too expensive/],
  ])("rejects invalid redactPatterns when the config loads (%#)", (patterns, error) => {
    const raw = { profiles: { p: { url: "https://x.test", user: "u", redactPatterns: patterns } } };
    expect(() => parseConfig(JSON.stringify(raw))).toThrow(error);
  });

  it("rejects a maxResultChars too small to hold a result", () => {
    const raw = { profiles: { p: { url: "https://x.test", user: "u", maxResultChars: 500 } } };
    expect(() => parseConfig(JSON.stringify(raw))).toThrow(/at least 1000/);
  });

  it("doctor --redaction-sample prints rule names and counts, never values", async () => {
    const file = join(dir, "sample.log");
    writeFileSync(
      file,
      [
        "password=hunter2",
        "Authorization: Bearer abcdefgh12345678",
        "export API_TOKEN=xyz987",
        "ok",
      ].join("\n"),
    );
    const { code, out } = await cli(["doctor", "--redaction-sample", file], mockJenkins({}).fetch);
    expect(code).toBe(0);
    expect(out).toMatch(/secret-assignment/);
    expect(out).toMatch(/authorization-header/);
    expect(out).not.toMatch(/hunter2|abcdefgh12345678|xyz987/);
  });
});

describe("plain-HTTP warning", () => {
  it("is printed once per process for each URL", () => {
    const warnings: string[] = [];
    for (let i = 0; i < 3; i++) {
      new JenkinsClient({
        baseUrl: "http://warn-once.internal.test",
        auth: new BasicAuth(USER, TOKEN),
        timeoutMs: 1000,
        allowInsecureHttp: true,
        onWarning: (m) => warnings.push(m),
      });
    }
    expect(warnings).toHaveLength(1);
  });
});

describe("credentials never leak", () => {
  const encoded = Buffer.from(`${USER}:${TOKEN}`).toString("base64");

  /** A Jenkins that puts the token into every body, header and error it can. */
  function echoing(mode: "ok" | "error"): FetchFn {
    return async (input, init) => {
      const url = new URL(String(input));
      const p = url.pathname;
      const headers: Record<string, string> = {
        "X-Echo": TOKEN,
        "Set-Cookie": `JSESSIONID=${TOKEN}`,
        Location: `${BASE}/queue/item/5/?t=${TOKEN}`,
      };
      if (mode === "error") {
        return new Response(`boom ${TOKEN} Authorization: Basic ${encoded}`, {
          status: 500,
          headers,
        });
      }
      if (p === "/crumbIssuer/api/json")
        return json({ crumbRequestField: "Jenkins-Crumb", crumb: TOKEN });
      if (p.endsWith("progressiveText")) {
        return new Response(`line ${TOKEN}\npassword=${TOKEN}\n${"x".repeat(3000)}${TOKEN}\n`, {
          headers: { ...headers, "X-Text-Size": "10" },
        });
      }
      if (p.endsWith("config.xml")) {
        return new Response(
          `<project><scm class="hudson.plugins.git.GitSCM"><userRemoteConfigs><hudson.plugins.git.UserRemoteConfig><url>https://h/${TOKEN}.git</url></hudson.plugins.git.UserRemoteConfig></userRemoteConfigs></scm></project>`,
          { headers },
        );
      }
      if (p.endsWith("/rss")) {
        return new Response(
          `<feed><entry><title>${TOKEN}</title><published>2026-01-01T00:00:00Z</published><content>Jan 01, 2026 0:00:00 AM x y\nSEVERE: ${TOKEN}</content></entry></feed>`,
          { headers },
        );
      }
      if (p.endsWith("/replay/")) {
        return new Response(`<textarea name="_.mainScript">${TOKEN}</textarea>`, { headers });
      }
      if (p === "/log/") return new Response(`<a href="${TOKEN}/configure">x</a>`, { headers });
      if (init?.method === "POST") return new Response(null, { status: 201, headers });
      return json(
        {
          number: 5,
          building: true,
          buildable: true,
          name: "app",
          fullName: "app",
          anonymous: false,
          description: `${"d".repeat(2000)} ${TOKEN} ${"d".repeat(2000)}`,
          url: `${BASE}/job/app/?t=${TOKEN}`,
          fullName2: `Authorization: Basic ${encoded}`,
          jobs: [{ name: TOKEN, fullName: "app", _class: "hudson.model.FreeStyleProject" }],
          property: [],
          actions: [
            { _class: "hudson.tasks.junit.TestResultAction", failCount: 1, totalCount: 1 },
            {
              _class: "hudson.plugins.git.util.BuildData",
              remoteUrls: [`https://h/${TOKEN}`],
              lastBuiltRevision: { SHA1: TOKEN, branch: [{ name: TOKEN }] },
            },
            { parameters: [{ name: "P", value: TOKEN }] },
          ],
          suites: [
            {
              cases: [
                {
                  name: TOKEN,
                  status: "FAILED",
                  errorDetails: TOKEN,
                  flakyFailures: [{ message: TOKEN }],
                },
              ],
            },
          ],
          passCount: 0,
          failCount: 1,
          skipCount: 0,
          executable: { number: 5, url: TOKEN },
          why: TOKEN,
          items: [{ buildable: true, why: TOKEN }],
          computer: [{ offline: false, numExecutors: 1 }],
          changeSets: [{ items: [{ msg: TOKEN, authorEmail: `${TOKEN}@example.com` }] }],
          task: { url: `${BASE}/job/app/` },
          queueItem: { id: 5 },
        },
        200,
        headers,
      );
    };
  }

  const args = (name: string): Record<string, unknown> => {
    const base = {
      jobFullName: "app",
      buildNumber: 5,
      pattern: "line",
      mainScript: TOKEN,
      jobName: "new-job",
      pipelineScript: TOKEN,
      id: 5,
      scmUrl: `https://h/${TOKEN}.git`,
      parameters: { P: TOKEN },
      description: TOKEN,
      displayName: TOKEN,
      contextLines: 2,
    };
    if (name === "cancelBuild") return { jobFullName: "app", buildNumber: 5 };
    return base;
  };

  const configFile = (max: number) => {
    const file = join(dir, `allow-${max}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        defaultProfile: "p",
        profiles: {
          p: { url: BASE, user: USER, allowWrite: true, maxResultChars: max, triggerWaitMs: 50 },
        },
      }),
    );
    return file;
  };

  for (const mode of ["ok", "error"] as const) {
    for (const max of [40_000, 1_000]) {
      it(`keeps the token out of every tool's output (${mode}, maxResultChars=${max})`, async () => {
        for (const tool of TOOLS) {
          const mcp = await runTool(
            session(echoing(mode), { allowWrite: true, maxResultChars: max, triggerWaitMs: 50 }),
            tool.name,
            args(tool.name),
          );
          const seen = `${mcp.text}\n${JSON.stringify(mcp.structured ?? {})}\n${(mcp.hints ?? []).join("\n")}`;
          expect(seen, `${tool.name} (MCP)`).not.toContain(TOKEN);
          expect(seen, `${tool.name} (MCP)`).not.toContain(encoded);

          const run = await cli(
            [tool.name, "--json", JSON.stringify(args(tool.name)), "--verbose"],
            echoing(mode),
            { ...cliEnv(), BUTLERBRIDGE_CONFIG: configFile(max) },
          );
          expect(`${run.out}\n${run.err}`, `${tool.name} (CLI)`).not.toContain(TOKEN);
          expect(`${run.out}\n${run.err}`, `${tool.name} (CLI)`).not.toContain(encoded);
        }
      });
    }
  }
});
