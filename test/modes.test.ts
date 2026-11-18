import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { parseArgv, toolArgsFromFlags } from "../src/args.js";
import { runTool } from "../src/runtime.js";
import { buildServer, listTools } from "../src/server.js";
import { findTool, TOOLS } from "../src/tools/index.js";
import { mockJenkins, session } from "./helpers.js";

const PLUGIN_TOOLS = [
  "cancelBuild",
  "createPipeline",
  "findJobsWithScmUrl",
  "getBuild",
  "getBuildChangeSets",
  "getBuildLog",
  "getBuildScm",
  "getFlakyFailures",
  "getJob",
  "getJobScm",
  "getJobs",
  "getLogRecorders",
  "getQueueItem",
  "getReplayScripts",
  "getStatus",
  "getSystemLog",
  "getTestResults",
  "rebuildBuild",
  "replayBuild",
  "searchBuildLog",
  "triggerBuild",
  "updateBuild",
  "whoAmI",
];

describe("tool contract", () => {
  it("exposes exactly the plugin's tools", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(PLUGIN_TOOLS);
  });

  it("lists every tool in docs/tool-contract.md", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync(new URL("../docs/tool-contract.md", import.meta.url), "utf8");
    for (const name of PLUGIN_TOOLS) expect(doc).toContain(`### ${name}`);
  });

  it("advertises tree only on the plugin's exported-bean tools", () => {
    const withTree = TOOLS.filter((t) => "tree" in (t.inputSchema.properties as object)).map(
      (t) => t.name,
    );
    expect(withTree.sort()).toEqual(
      [
        "getBuild",
        "getJob",
        "getJobs",
        "getQueueItem",
        "rebuildBuild",
        "replayBuild",
        "triggerBuild",
      ].sort(),
    );
  });
});

describe("CLI argument mapping", () => {
  it("converts flags with the tool schema", () => {
    const { command, flags } = parseArgv([
      "getBuildLog",
      "--jobFullName",
      "team/app",
      "--buildNumber=lastSuccessfulBuild",
      "--skip",
      "-5",
      "--pretty",
    ]);
    expect(command).toBe("getBuildLog");
    expect(toolArgsFromFlags(findTool("getBuildLog")!, flags)).toEqual({
      jobFullName: "team/app",
      buildNumber: "lastSuccessfulBuild",
      skip: -5,
    });
  });

  it("supports object parameters as JSON or dotted flags", () => {
    const tool = findTool("triggerBuild")!;
    expect(
      toolArgsFromFlags(
        tool,
        parseArgv(["x", "--jobFullName", "a", "--parameters", '{"A":"1"}']).flags,
      ),
    ).toEqual({
      jobFullName: "a",
      parameters: { A: "1" },
    });
    expect(
      toolArgsFromFlags(
        tool,
        parseArgv(["x", "--jobFullName", "a", "--parameters.B", "two"]).flags,
      ),
    ).toEqual({
      jobFullName: "a",
      parameters: { B: "two" },
    });
  });

  it("rejects unknown parameters and bad types", () => {
    const tool = findTool("getBuild")!;
    expect(() => toolArgsFromFlags(tool, parseArgv(["x", "--job", "a"]).flags)).toThrow(
      /Unknown parameter --job/,
    );
    expect(() =>
      toolArgsFromFlags(findTool("getJobs")!, parseArgv(["x", "--limit", "ten"]).flags),
    ).toThrow(/must be an integer/);
  });
});

describe("MCP and CLI parity", () => {
  it("returns the same result for the same input in both modes", async () => {
    const routes = {
      "GET /job/team/job/app/lastBuild/api/json": {
        number: 3,
        result: "FAILURE",
        description: "password=x",
      },
    };
    const cliSession = session(mockJenkins(routes).fetch);
    const cliArgs = toolArgsFromFlags(
      findTool("getBuild")!,
      parseArgv(["getBuild", "--jobFullName", "team/app"]).flags,
    );
    const cli = await runTool(cliSession, "getBuild", cliArgs);

    const server = buildServer(async () => session(mockJenkins(routes).fetch));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(PLUGIN_TOOLS);
    expect(listed.tools.find((t) => t.name === "getBuild")?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });

    const mcp = await client.callTool({ name: "getBuild", arguments: { jobFullName: "team/app" } });
    expect(mcp.isError).toBe(false);
    expect((mcp.content as { text: string }[])[0]!.text).toBe(cli.text);
    expect(cli.text).toContain("password=[REDACTED]");

    const who = await client.callTool({ name: "whoAmI", arguments: {} });
    expect(who.isError).toBe(true);
    await client.close();
  });

  it("reports a missing login as a tool error instead of failing to start", async () => {
    const server = buildServer(async () => {
      throw new Error("No API token for profile 'default'. Run `butlerbridge login`");
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);
    expect((await client.listTools()).tools).toHaveLength(listTools().length);
    const res = await client.callTool({ name: "getStatus", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toMatch(/butlerbridge login/);
    await client.close();
  });
});
