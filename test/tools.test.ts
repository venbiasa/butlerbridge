import { describe, expect, it } from "vitest";
import { runTool } from "../src/runtime.js";
import { jobNameFromUrl, queueIdFromLocation } from "../src/tools/common.js";
import { parseReplayPage, pipelineConfigXml } from "../src/tools/core.js";
import { branchSpecMatches, looselyMatches, parseGitScms } from "../src/tools/scm.js";
import { parseLogFeed, parseRecorderNames } from "../src/tools/systemLog.js";
import { abbreviate, resolveSummary } from "../src/tools/tests.js";
import { BASE, json, mockJenkins, parse, session } from "./helpers.js";

async function call(
  routes: Parameters<typeof mockJenkins>[0],
  name: string,
  args: object,
  allowWrite = false,
) {
  const jenkins = mockJenkins({ "GET /crumbIssuer/api/json": 404, ...routes });
  const out = await runTool(session(jenkins.fetch, { allowWrite }), name, args);
  return { out, body: parse(out.text), calls: jenkins.calls };
}

describe("getJob / getJobs / getBuild", () => {
  it("getBuild sends the plugin's default tree, and * for the full object", async () => {
    const { calls } = await call({ "GET /job/a/12/api/json": { number: 12 } }, "getBuild", {
      jobFullName: "a",
      buildNumber: 12,
    });
    expect(calls[0]!.url.searchParams.get("tree")).toBe(
      "number,url,result,building,timestamp,duration,displayName,description",
    );
    const full = await call({ "GET /job/a/12/api/json": { number: 12 } }, "getBuild", {
      jobFullName: "a",
      buildNumber: 12,
      tree: "*",
    });
    expect(full.calls[0]!.url.searchParams.has("tree")).toBe(false);
  });

  it("getJob returns nothing for folders", async () => {
    const { body } = await call(
      {
        "GET /job/f/api/json": { _class: "com.cloudbees.hudson.plugins.folder.Folder", name: "f" },
      },
      "getJob",
      { jobFullName: "f" },
    );
    expect(body.result).toBeUndefined();
  });

  it("getJobs sorts by name, pages, and caps limit at 10", async () => {
    const jobs = Array.from({ length: 15 }, (_, i) => ({
      name: `j${String(i).padStart(2, "0")}`,
      color: "blue",
    }));
    const { body, calls } = await call(
      { "GET /job/f/api/json": { jobs: [...jobs].reverse() } },
      "getJobs",
      {
        parentFullName: "f",
        skip: 2,
        limit: 50,
        tree: "color",
      },
    );
    expect(calls[0]!.url.searchParams.get("tree")).toBe("jobs[name,fullName,color]");
    const result = body.result as Record<string, unknown>[];
    expect(result).toHaveLength(10);
    expect(result[0]).toEqual({ color: "blue" });
  });
});

describe("triggerBuild", () => {
  it("fills parameters like the plugin and returns the queue item", async () => {
    const { body, calls } = await call(
      {
        "GET /job/app/api/json": {
          buildable: true,
          property: [
            {
              parameterDefinitions: [
                { name: "BRANCH", type: "StringParameterDefinition" },
                { name: "DRY_RUN", type: "BooleanParameterDefinition" },
                { name: "ENV", type: "ChoiceParameterDefinition", choices: ["dev", "prod"] },
                { name: "TARGETS", type: "ExtendedChoiceParameterDefinition" },
                { name: "UNSET", type: "StringParameterDefinition" },
              ],
            },
          ],
        },
        "POST /job/app/buildWithParameters": () =>
          new Response(null, { status: 201, headers: { Location: `${BASE}/queue/item/41/` } }),
        "GET /queue/item/41/api/json": { id: 41 },
      },
      "triggerBuild",
      {
        jobFullName: "app",
        parameters: {
          BRANCH: "main",
          DRY_RUN: "true",
          ENV: "staging",
          TARGETS: ["a", "b"],
          IGNORED: 1,
        },
      },
    );
    const post = calls.find((c) => c.method === "POST")!;
    expect(Object.fromEntries(new URLSearchParams(post.body))).toEqual({
      BRANCH: "main",
      DRY_RUN: "true",
      TARGETS: "a,b",
    });
    expect(body.result).toEqual({ id: 41 });
    expect(body.message).toMatch(/'staging' is not a valid choice for 'ENV'/);
  });

  it("returns nothing for a disabled job", async () => {
    const { body, calls } = await call(
      { "GET /job/app/api/json": { buildable: false } },
      "triggerBuild",
      {
        jobFullName: "app",
      },
    );
    expect(body.result).toBeUndefined();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("finds the queue id in Jenkins' Location header", () => {
    expect(queueIdFromLocation("https://ci/queue/item/123/")).toBe(123);
    expect(queueIdFromLocation(null)).toBeNull();
  });
});

describe("cancelBuild", () => {
  it("validates its arguments", async () => {
    const both = await call(
      {},
      "cancelBuild",
      { jobFullName: "a", buildNumber: 1, queueId: 2 },
      true,
    );
    expect(both.body.message).toBe("Give either queueId, or jobFullName and buildNumber, not both");
    const neither = await call({}, "cancelBuild", { jobFullName: "a" }, true);
    expect(neither.body.message).toBe("Give either queueId, or jobFullName and buildNumber");
  });

  it.each([
    [{ "GET /job/a/3/api/json": { building: true }, "POST /job/a/3/stop": 302 }, "STOP_REQUESTED"],
    [{ "GET /job/a/3/api/json": { building: false } }, "NOT_RUNNING"],
    [{}, "NOT_FOUND"],
    [{ "GET /job/a/3/api/json": { building: true }, "POST /job/a/3/stop": 403 }, "NO_PERMISSION"],
  ])("maps build states (%#)", async (routes, expected) => {
    const { body } = await call(routes, "cancelBuild", { jobFullName: "a", buildNumber: 3 }, true);
    expect(body.result).toBe(expected);
  });

  it("cancels queue items", async () => {
    const { body } = await call(
      { "GET /queue/item/8/api/json": { id: 8 }, "POST /queue/cancelItem": 204 },
      "cancelBuild",
      { queueId: 8 },
      true,
    );
    expect(body.result).toBe("CANCELLED");
  });
});

describe("whoAmI and getStatus", () => {
  it("reports anonymous", async () => {
    const { body } = await call(
      { "GET /whoAmI/api/json": { name: "anonymous", anonymous: true } },
      "whoAmI",
      {},
    );
    expect(body.result).toEqual({ fullName: "anonymous" });
  });

  it("builds the plugin's status map", async () => {
    const { body } = await call(
      {
        "GET /api/json": { quietingDown: false, url: "https://ci/" },
        "GET /queue/api/json": { items: [{ buildable: true }, { buildable: false }] },
        "GET /computer/api/json": {
          computer: [
            { offline: false, numExecutors: 2 },
            { offline: true, numExecutors: 4 },
          ],
        },
      },
      "getStatus",
      {},
    );
    expect(body.result).toEqual({
      "Quiet Mode": false,
      "Full Queue Size": 2,
      "Buildable Queue Size": 1,
      "Available executors (any label)": 2,
      "Active administrative monitors": "Not available through the REST API",
      "Root URL Status": "OK",
    });
  });
});

describe("test results", () => {
  const action = {
    _class: "hudson.tasks.junit.TestResultAction",
    failCount: 1,
    skipCount: 0,
    totalCount: 3,
    urlName: "testReport",
  };
  const report = {
    passCount: 2,
    failCount: 1,
    skipCount: 0,
    suites: [
      {
        cases: [
          { className: "A", name: "ok", status: "PASSED" },
          {
            className: "A",
            name: "boom",
            status: "REGRESSION",
            errorDetails: "",
            errorStackTrace: "java.lang.AssertionError\n\tat A",
            age: 1,
          },
          {
            className: "B",
            name: "retry",
            status: "PASSED",
            flakyFailures: [{ message: "timeout", type: "IOException" }],
          },
        ],
      },
    ],
  };
  const routes = {
    "GET /job/app/lastBuild/api/json": (c: { url: URL }) =>
      json(c.url.searchParams.get("tree") === "number" ? { number: 5 } : {}),
    "GET /job/app/5/api/json": { actions: [{}, action] },
    "GET /job/app/5/testReport/api/json": report,
  };

  it("summarizes by default", async () => {
    const { body } = await call(routes, "getTestResults", { jobFullName: "app" });
    expect(body.result).toEqual({
      TestResultAction: action,
      TestResultSummary: {
        buildNumber: 5,
        totalCount: 3,
        failCount: 1,
        skipCount: 0,
        passCount: 2,
        flakyTestCount: 1,
        failedTests: [
          {
            className: "A",
            testName: "boom",
            errorDetails: "java.lang.AssertionError\n\tat A",
            age: 1,
          },
        ],
      },
    });
  });

  it("returns failing tests in full when onlyFailingTests is set", async () => {
    const { body } = await call(routes, "getTestResults", {
      jobFullName: "app",
      onlyFailingTests: true,
    });
    expect((body.result as { failingTests: unknown[] }).failingTests).toHaveLength(1);
  });

  it("caps the number of test cases and says so", async () => {
    const many = {
      ...report,
      suites: [
        {
          cases: Array.from({ length: 300 }, (_, i) => ({
            name: `t${i}`,
            status: i % 2 ? "FAILED" : "PASSED",
          })),
        },
      ],
    };
    const { body } = await call(
      { ...routes, "GET /job/app/5/testReport/api/json": many },
      "getTestResults",
      {
        jobFullName: "app",
        summary: false,
      },
    );
    const cases = (body.result as { TestResult: { suites: { cases: { status: string }[] }[] } })
      .TestResult.suites[0]!.cases;
    expect(cases).toHaveLength(200);
    expect(cases.filter((c) => c.status === "FAILED")).toHaveLength(150);
    expect(body.message).toMatch(/Showing 200 of 300 test cases/);
  });

  it("summarizes flaky failures", async () => {
    const { body } = await call(routes, "getFlakyFailures", { jobFullName: "app" });
    expect((body.result as Record<string, unknown>).FlakyFailuresSummary).toEqual({
      buildNumber: 5,
      flakyTestCount: 1,
      flakyFailureCount: 1,
      flakyTests: [
        {
          className: "B",
          testName: "retry",
          flakyFailures: [{ message: "timeout", type: "IOException" }],
        },
      ],
    });
  });

  it("returns the empty result when the build has no test report", async () => {
    const { body } = await call(
      { ...routes, "GET /job/app/5/api/json": { actions: [] } },
      "getTestResults",
      { jobFullName: "app" },
    );
    expect(body.result).toBeUndefined();
    expect(body.status).toBe("COMPLETED");
  });

  it("says the plugin is missing when the report endpoint is gone", async () => {
    const { out, body } = await call(
      { ...routes, "GET /job/app/5/testReport/api/json": 404 },
      "getTestResults",
      { jobFullName: "app" },
    );
    expect(out.isError).toBe(true);
    expect(body.message).toMatch(/not available on this server/);
  });

  it("resolves summary like the plugin and abbreviates messages", () => {
    expect(resolveSummary(undefined, undefined)).toBe(true);
    expect(resolveSummary(undefined, true)).toBe(false);
    expect(resolveSummary(true, true)).toBe(true);
    expect(abbreviate("x".repeat(600))).toHaveLength(512);
  });
});

describe("SCM helpers", () => {
  it("matches git URLs loosely", () => {
    expect(looselyMatches("git@github.com:org/repo.git", "https://github.com/org/repo")).toBe(true);
    expect(
      looselyMatches("ssh://git@github.com:22/org/repo.git", "https://github.com/org/repo.git/"),
    ).toBe(true);
    expect(looselyMatches("https://github.com/org/repo", "https://gitlab.com/org/repo")).toBe(
      false,
    );
    expect(looselyMatches("https://github.com/org/repo", "https://github.com/org/other")).toBe(
      false,
    );
  });

  it("matches branch specs", () => {
    expect(branchSpecMatches("*/main", "origin", "main")).toBe(true);
    expect(branchSpecMatches("main", "origin", "main")).toBe(true);
    expect(branchSpecMatches("refs/heads/main", "origin", "main")).toBe(true);
    expect(branchSpecMatches("**", "origin", "feature/x")).toBe(true);
    expect(branchSpecMatches("*/release-*", "origin", "release-1.2")).toBe(true);
    expect(branchSpecMatches("*/main", "origin", "dev")).toBe(false);
    expect(branchSpecMatches("${BRANCH}", "origin", "anything")).toBe(true);
  });

  it("parses Git SCMs out of config.xml", () => {
    const xml = `<project><scm class="hudson.plugins.git.GitSCM" plugin="git@5">
      <userRemoteConfigs><hudson.plugins.git.UserRemoteConfig><url>git@github.com:org/a.git</url><name>upstream</name></hudson.plugins.git.UserRemoteConfig></userRemoteConfigs>
      <branches><hudson.plugins.git.BranchSpec><name>*/main</name></hudson.plugins.git.BranchSpec></branches>
    </scm></project>`;
    expect(parseGitScms(xml)).toEqual([
      { remotes: [{ url: "git@github.com:org/a.git", name: "upstream" }], branches: ["*/main"] },
    ]);
  });

  it("getJobScm returns the plugin's GitScmConfig shape", async () => {
    const { body } = await call(
      {
        "GET /job/a/config.xml": `<project><scm class="hudson.plugins.git.GitSCM"><userRemoteConfigs><hudson.plugins.git.UserRemoteConfig><url>https://h/r.git</url></hudson.plugins.git.UserRemoteConfig></userRemoteConfigs><branches><hudson.plugins.git.BranchSpec><name>*/main</name></hudson.plugins.git.BranchSpec></branches></scm></project>`,
      },
      "getJobScm",
      { jobFullName: "a" },
    );
    expect(body.result).toEqual([
      { uris: ["https://h/r.git"], branches: ["*/main"], commit: null, name: "Git" },
    ]);
  });

  it("getBuildScm reads the build's Git data", async () => {
    const { body } = await call(
      {
        "GET /job/a/2/api/json": {
          actions: [
            {
              _class: "hudson.plugins.git.util.BuildData",
              remoteUrls: ["https://h/r.git"],
              lastBuiltRevision: { SHA1: "abc", branch: [{ name: "origin/main" }] },
            },
          ],
        },
      },
      "getBuildScm",
      { jobFullName: "a", buildNumber: 2 },
    );
    expect(body.result).toEqual([
      { uris: ["https://h/r.git"], branches: ["origin/main"], commit: "abc", name: "Git" },
    ]);
  });

  it("findJobsWithScmUrl walks jobs and returns SimpleJob entries", async () => {
    const gitXml = (url: string) =>
      `<project><scm class="hudson.plugins.git.GitSCM"><userRemoteConfigs><hudson.plugins.git.UserRemoteConfig><url>${url}</url></hudson.plugins.git.UserRemoteConfig></userRemoteConfigs><branches><hudson.plugins.git.BranchSpec><name>*/main</name></hudson.plugins.git.BranchSpec></branches></scm></project>`;
    const { body } = await call(
      {
        "GET /api/json": {
          jobs: [
            {
              _class: "com.cloudbees.hudson.plugins.folder.Folder",
              name: "f",
              fullName: "f",
              jobs: [
                {
                  _class: "hudson.model.FreeStyleProject",
                  name: "one",
                  displayName: "one",
                  fullDisplayName: "f » one",
                  fullName: "f/one",
                  lastBuild: { result: "FAILURE" },
                },
              ],
            },
            {
              _class: "hudson.model.FreeStyleProject",
              name: "two",
              fullName: "two",
              lastBuild: null,
            },
          ],
        },
        "GET /job/f/job/one/config.xml": gitXml("git@github.com:org/repo.git"),
        "GET /job/two/config.xml": gitXml("https://github.com/org/other.git"),
      },
      "findJobsWithScmUrl",
      { scmUrl: "https://github.com/org/repo", branch: "main" },
    );
    expect(body.result).toEqual([
      {
        name: "one",
        displayName: "one",
        fullDisplayName: "f » one",
        fullName: "f/one",
        url: "job/f/job/one/",
        lastResult: "FAILURE",
      },
    ]);
  });
});

describe("pipeline, replay and system log helpers", () => {
  it("escapes the script in config.xml", () => {
    expect(pipelineConfigXml("echo '<a & b>'")).toContain(
      "<script>echo '&lt;a &amp; b&gt;'</script>",
    );
  });

  it("reads scripts from the replay page", () => {
    const html = `<form><textarea name="_.mainScript" class="x">\nnode { echo &quot;hi&quot; }</textarea>
      <textarea name="_.Script1">return 1 &lt; 2</textarea></form>`;
    expect(parseReplayPage(html)).toEqual({
      mainScript: 'node { echo "hi" }',
      loadedScripts: { Script1: "return 1 < 2" },
    });
  });

  it("parses the log feed", () => {
    const feed = `<feed><entry><title>Started up</title><published>2026-01-02T03:04:05Z</published>
      <content type="html">Jan 02, 2026 3:04:05 AM jenkins.InitReactorRunner$1 onAttained
INFO: Started up</content></entry>
      <entry><title>Boom</title><published>2026-01-02T03:05:00Z</published>
      <content type="html">Jan 02, 2026 3:05:00 AM hudson.Foo run
SEVERE: Boom
java.lang.RuntimeException: x
	at hudson.Foo.run</content></entry></feed>`;
    expect(parseLogFeed(feed)).toEqual([
      {
        timestamp: "2026-01-02T03:04:05.000Z",
        level: "INFO",
        logger: "jenkins.InitReactorRunner$1 onAttained",
        message: "Started up",
        exception: null,
      },
      {
        timestamp: "2026-01-02T03:05:00.000Z",
        level: "SEVERE",
        logger: "hudson.Foo run",
        message: "Boom",
        exception: "java.lang.RuntimeException: x\n\tat hudson.Foo.run",
      },
    ]);
  });

  it("getSystemLog filters by level, newest first, and maps 403 to the plugin's message", async () => {
    const feed = `<feed>${["INFO", "SEVERE", "WARNING"].map((l, i) => `<entry><title>m${i}</title><published>2026-01-0${i + 1}T00:00:00Z</published><content>Jan 0${i + 1}, 2026 0:00:00 AM x y\n${l}: m${i}</content></entry>`).join("")}</feed>`;
    const { body } = await call({ "GET /log/rss": feed }, "getSystemLog", { level: "WARNING" });
    expect(
      (body.result as { entries: { message: string }[] }).entries.map((e) => e.message),
    ).toEqual(["m2", "m1"]);
    const denied = await call({ "GET /log/rss": 403 }, "getSystemLog", {});
    expect(denied.body.message).toBe(
      "Access denied: tool 'getSystemLog' requires one of [hudson.model.Hudson.SystemRead]",
    );
  });

  it("lists log recorders from the log page", () => {
    expect(
      parseRecorderNames(
        `<a href="all">All</a><a href="my%20rec/configure">x</a><a href="./other/configure">y</a>`,
      ),
    ).toEqual(["my rec", "other"]);
  });

  it("derives job names from job URLs", () => {
    expect(jobNameFromUrl("https://ci/job/a/job/feature%252Fx/")).toBe("a/feature%2Fx");
    expect(jobNameFromUrl("https://ci/computer/")).toBeNull();
  });
});
