import { describe, expect, it } from "vitest";
import { runTool } from "../src/runtime.js";
import {
  compileMatcher,
  decodeCursor,
  encodeCursor,
  LogSearcher,
  readLines,
  type BuildLogResponse,
  type SearchLogResponse,
} from "../src/tools/logs.js";
import { json, logLines, mockJenkins, parse, session, streamedLog } from "./helpers.js";

const BUILD = "GET /job/app/lastBuild/api/json";
const LOG = "GET /job/app/7/logText/progressiveText";

function logJenkins(text: string | string[], opts: { more?: boolean; onPull?: () => void } = {}) {
  const chunks = Array.isArray(text) ? text : [text];
  const size = chunks.join("").length;
  return mockJenkins({
    [BUILD]: { number: 7 },
    [LOG]: (call) => {
      const start = Number(call.url.searchParams.get("start") ?? 0);
      const all = chunks.join("");
      const effective = start > all.length ? 0 : start;
      return streamedLog(start === 0 ? chunks : [all.slice(effective)], {
        textSize: size,
        more: opts.more,
        onPull: opts.onPull,
      });
    },
  });
}

async function getLog(
  jenkins: ReturnType<typeof mockJenkins>,
  args: Record<string, unknown>,
  maxResultChars?: number,
) {
  const out = await runTool(
    session(jenkins.fetch, maxResultChars ? { maxResultChars } : {}),
    "getBuildLog",
    {
      jobFullName: "app",
      ...args,
    },
  );
  const body = parse(out.text);
  return { out, body, result: body.result as BuildLogResponse };
}

describe("readLines", () => {
  it("splits across chunk boundaries and handles CRLF and a final partial line", async () => {
    const res = streamedLog(["a\r\nb", "c\nd", "e\n", "tail"]);
    const lines: string[] = [];
    for await (const l of readLines(res.body!)) lines.push(l);
    expect(lines).toEqual(["a", "bc", "de", "tail"]);
  });
});

describe("cursor", () => {
  it("round-trips and is tied to its build", () => {
    const c = encodeCursor(7, 1234, 50);
    expect(decodeCursor(c, 7)).toEqual({ offset: 1234, skipLines: 50 });
    expect(() => decodeCursor(c, 8)).toThrow(/issued for build #7, but build #8/);
    expect(() => decodeCursor("not-a-cursor", 7)).toThrow(/Invalid cursor/);
  });

  it("accepts the plugin's two-part form", () => {
    const pluginCursor = Buffer.from("7:99").toString("base64url");
    expect(decodeCursor(pluginCursor, 7)).toEqual({ offset: 99, skipLines: 0 });
  });
});

describe("getBuildLog paging", () => {
  it("returns the last 100 lines by default with exact totals", async () => {
    const { result } = await getLog(logJenkins(logLines(250)), {});
    expect(result.lines).toHaveLength(100);
    expect(result.lines[0]).toBe("line 151");
    expect(result.lines[99]).toBe("line 250");
    expect(result).toMatchObject({
      startLine: 151,
      endLine: 250,
      totalLines: 250,
      hasMoreContent: false,
      nextCursor: null,
    });
  });

  it("reads forward with skip and limit, then continues with the cursor", async () => {
    const jenkins = logJenkins(logLines(25));
    const first = await getLog(jenkins, { skip: 0, limit: 10 });
    expect(first.result.lines).toEqual(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`));
    expect(first.result).toMatchObject({
      startLine: 1,
      endLine: 10,
      totalLines: -1,
      hasMoreContent: true,
    });
    const second = await getLog(jenkins, { cursor: first.result.nextCursor, limit: 10 });
    expect(second.result.lines[0]).toBe("line 11");
    expect(second.result).toMatchObject({ startLine: -1, endLine: -1, hasMoreContent: true });
    const third = await getLog(jenkins, { cursor: second.result.nextCursor, limit: 10 });
    expect(third.result.lines).toEqual(["line 21", "line 22", "line 23", "line 24", "line 25"]);
    expect(third.result).toMatchObject({ hasMoreContent: false, nextCursor: null });
  });

  it("stops streaming as soon as the page is full", async () => {
    let pulls = 0;
    const chunks = Array.from({ length: 200 }, (_, i) => logLines(50, `c${i}`));
    const { result } = await getLog(logJenkins(chunks, { onPull: () => pulls++ }), {
      skip: 0,
      limit: 5,
    });
    expect(result.lines).toHaveLength(5);
    expect(pulls).toBeLessThan(5);
  });

  it("supports negative skip with positive limit (from the end, forward)", async () => {
    const { result } = await getLog(logJenkins(logLines(30)), { skip: -5, limit: 3 });
    expect(result.lines).toEqual(["line 26", "line 27", "line 28"]);
    expect(result).toMatchObject({
      startLine: 26,
      endLine: 28,
      totalLines: 30,
      hasMoreContent: true,
    });
    expect(decodeCursor(result.nextCursor!, 7)).toEqual({ offset: 0, skipLines: 28 });
  });

  it("keeps a cursor at the end of a running build so new output can be polled", async () => {
    const text = logLines(3);
    const { result } = await getLog(logJenkins(text, { more: true }), { skip: 0, limit: 10 });
    expect(result.hasMoreContent).toBe(false);
    expect(decodeCursor(result.nextCursor!, 7)).toEqual({ offset: text.length, skipLines: 0 });
  });

  it("rejects a cursor from another build", async () => {
    const { out } = await getLog(logJenkins(logLines(3)), { cursor: encodeCursor(6, 0, 0) });
    expect(out.isError).toBe(true);
    expect(parse(out.text).message).toMatch(/issued for build #6/);
  });

  it("shortens a page to the size cap and says how to continue", async () => {
    const big = Array.from({ length: 50 }, (_, i) => `${i}:${"x".repeat(200)}`).join("\n");
    const { body, result } = await getLog(logJenkins(big), { skip: 0, limit: 50 }, 3000);
    expect(result.lines.length).toBeLessThan(50);
    expect(result.hasMoreContent).toBe(true);
    expect(result.nextCursor).toBeTruthy();
    expect(body.message).toMatch(/Page shortened.*nextCursor/);
  });

  it("clips very long lines", async () => {
    const { result } = await getLog(logJenkins(`${"y".repeat(10_000)}\n`), {});
    expect(result.lines[0]!.length).toBeLessThan(4_100);
    expect(result.lines[0]).toMatch(/line clipped, 10000 chars/);
  });

  it("returns the empty result for a job without builds", async () => {
    const { body } = await getLog(mockJenkins({}), {});
    expect(body.result).toBeUndefined();
  });

  it("uses a given build number without resolving the last build", async () => {
    const jenkins = mockJenkins({
      "GET /job/app/3/logText/progressiveText": () => streamedLog(["only\n"]),
    });
    const { result } = await getLog(jenkins, { buildNumber: 3 });
    expect(result.lines).toEqual(["only"]);
    expect(jenkins.calls.map((c) => c.url.pathname)).toEqual([
      "/job/app/3/logText/progressiveText",
    ]);
  });
});

describe("log search", () => {
  const lines = [
    "start",
    "compile ok",
    "ERROR one",
    "after one",
    "x",
    "error two",
    "after two",
    "end",
  ];

  function search(maxMatches: number, contextLines: number, ignoreCase = false) {
    const s = new LogSearcher(compileMatcher("ERROR", false, ignoreCase), maxMatches, contextLines);
    for (const l of lines) if (!s.push(l)) break;
    return s;
  }

  it("matches plain text case-sensitively by default", () => {
    const s = search(10, 0);
    expect(s.matches.map((m) => m.matchedLineNumber)).toEqual([3]);
  });

  it("returns context before, the match, and context after", () => {
    const s = search(10, 1, true);
    expect(s.matches[0]).toEqual({
      matchedLineNumber: 3,
      matchedLine: "ERROR one",
      contextLines: ["compile ok", "ERROR one", "after one"],
      contextStartLine: 2,
      contextEndLine: 4,
    });
    expect(s.matches[1]!.contextLines).toEqual(["x", "error two", "after two"]);
  });

  it("stops early once the budget is full and one more match is seen", () => {
    const s = search(1, 0, true);
    expect(s.matches).toHaveLength(1);
    expect(s.hasMoreMatches).toBe(true);
    expect(s.lineNumber).toBe(6);
  });

  it("supports regex and inline (?i)", () => {
    expect(compileMatcher("err(or)? \\w+", true, true)("ERROR two")).toBe(true);
    expect(compileMatcher("(?i)error", true, false)("ERROR")).toBe(true);
    expect(compileMatcher("^end$", true, false)("the end")).toBe(false);
  });

  it("rejects catastrophic and invalid regexes", () => {
    expect(() => compileMatcher("(a+)+$", true, false)).toThrow(/too expensive/);
    expect(() => compileMatcher("(unclosed", true, false)).toThrow(/Invalid regular expression/);
  });

  it("runs end to end through the tool with the plugin's result shape", async () => {
    const jenkins = logJenkins(lines.join("\n"));
    const out = await runTool(session(jenkins.fetch), "searchBuildLog", {
      jobFullName: "app",
      pattern: "error",
      ignoreCase: true,
      maxMatches: 1,
    });
    const result = parse(out.text).result as SearchLogResponse;
    expect(result).toEqual({
      pattern: "error",
      useRegex: false,
      ignoreCase: true,
      matchCount: 1,
      hasMoreMatches: true,
      totalLines: 6,
      matches: [
        {
          matchedLineNumber: 3,
          matchedLine: "ERROR one",
          contextLines: ["ERROR one"],
          contextStartLine: 3,
          contextEndLine: 3,
        },
      ],
    });
  });

  it("validates pattern input like the plugin", async () => {
    const jenkins = logJenkins("x\n");
    const empty = await runTool(session(jenkins.fetch), "searchBuildLog", {
      jobFullName: "app",
      pattern: "",
    });
    expect(parse(empty.text).message).toBe("Search pattern cannot be null or empty");
    const long = await runTool(session(jenkins.fetch), "searchBuildLog", {
      jobFullName: "app",
      pattern: "a".repeat(1001),
      useRegex: true,
    });
    expect(parse(long.text).message).toMatch(/too long: 1001 characters, the maximum is 1000/);
  });

  it("redacts secrets that appear in log lines", async () => {
    const jenkins = mockJenkins({
      [BUILD]: json({ number: 7 }),
      [LOG]: () => streamedLog(["export AWS_SECRET_ACCESS_KEY=abc123\n", "password=hunter2\n"]),
    });
    const out = await runTool(session(jenkins.fetch), "getBuildLog", { jobFullName: "app" });
    expect(out.text).not.toContain("hunter2");
    expect(out.text).not.toContain("abc123");
    expect(out.text).toContain("[REDACTED]");
  });
});
