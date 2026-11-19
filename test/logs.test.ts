import { describe, expect, it } from "vitest";
import { runTool } from "../src/runtime.js";
import { decodeCursor, encodeCursor, type BuildLogResponse } from "../src/tools/logs.js";
import { readLines, repeatKey, stripAnsi } from "../src/tools/logText.js";
import { json, logLines, mockJenkins, parse, session, streamedLog } from "./helpers.js";

const BUILD = "GET /job/app/lastBuild/api/json";
const LOG = "GET /job/app/7/logText/progressiveText";
const ESC = "\u001b";

export function logJenkins(
  text: string | string[],
  opts: { more?: boolean; onPull?: () => void } = {},
) {
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
  overrides: Parameters<typeof session>[1] = {},
) {
  const out = await runTool(session(jenkins.fetch, overrides), "getBuildLog", {
    jobFullName: "app",
    ...args,
  });
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

describe("getBuildLog size cap", () => {
  const wide = (n: number, width: number) =>
    Array.from({ length: n }, (_, i) => `${i}:${"x".repeat(width)}`).join("\n");

  it.each([
    ["forward", { skip: 0, limit: 2200 }],
    ["tail", { limit: -2200 }],
    ["default tail", {}],
  ])("keeps the whole %s result under maxResultChars as valid JSON", async (_name, args) => {
    for (const max of [1_000, 3_000, 40_000]) {
      const { out, body, result } = await getLog(logJenkins(wide(2500, 120)), args, {
        maxResultChars: max,
      });
      expect(out.text.length).toBeLessThanOrEqual(max);
      expect(body.truncatedResult).toBeUndefined();
      expect(result.lines.length).toBeGreaterThan(0);
    }
  });

  it("says how to continue a forward page it shortened", async () => {
    const { body, result } = await getLog(
      logJenkins(wide(50, 200)),
      { skip: 0, limit: 50 },
      {
        maxResultChars: 3_000,
      },
    );
    expect(result.lines.length).toBeLessThan(50);
    expect(result.hasMoreContent).toBe(true);
    const next = decodeCursor(result.nextCursor!, 7);
    expect(next.skipLines).toBe(result.lines.length);
    expect(body.message).toMatch(/Page shortened.*nextCursor/);
  });

  it("cuts a single line bigger than the cap and marks it", async () => {
    const { out, result } = await getLog(
      logJenkins(`${"y".repeat(5_000)}\n`),
      {},
      {
        maxResultChars: 1_000,
      },
    );
    expect(out.text.length).toBeLessThanOrEqual(1_000);
    expect(result.lines[0]).toMatch(/…\[line truncated\]$/);
  });

  it("clips very long lines even under a large cap", async () => {
    const { result } = await getLog(logJenkins(`${"y".repeat(10_000)}\n`), {});
    expect(result.lines[0]!.length).toBeLessThan(4_100);
    expect(result.lines[0]).toMatch(/…\[line truncated\]$/);
  });

  it("counts JSON escaping, so colour-heavy lines kept with keepAnsi still fit", async () => {
    const line = `${ESC}[35m${"z".repeat(30)}${ESC}[0m`.repeat(20);
    const text = Array.from({ length: 400 }, () => line).join("\n");
    const { out, body } = await getLog(
      logJenkins(text),
      { keepAnsi: true, limit: -400 },
      {
        maxResultChars: 5_000,
      },
    );
    expect(out.text.length).toBeLessThanOrEqual(5_000);
    expect(body.truncatedResult).toBeUndefined();
  });
});

describe("ANSI stripping", () => {
  it("removes CSI, OSC and two-byte escapes", () => {
    expect(stripAnsi(`${ESC}[35mpink${ESC}[0m ${ESC}[32;1mbold${ESC}[0m`)).toBe("pink bold");
    expect(stripAnsi(`${ESC}]8;;https://x.test\u0007link${ESC}]8;;\u0007`)).toBe("link");
    expect(stripAnsi(`${ESC}Mup`)).toBe("up");
    expect(stripAnsi("plain [35m text")).toBe("plain [35m text");
  });

  it("strips by default and keeps codes with keepAnsi", async () => {
    const text = `${ESC}[31mFAILED${ESC}[0m test\n`;
    const plain = await getLog(logJenkins(text), {});
    expect(plain.result.lines).toEqual(["FAILED test"]);
    const kept = await getLog(logJenkins(text), { keepAnsi: true });
    expect(kept.result.lines).toEqual([`${ESC}[31mFAILED${ESC}[0m test`]);
  });
});

describe("excludePattern", () => {
  it("drops matching lines before paging and reports how many", async () => {
    const text = ["a", "noise 1", "b", "noise 2", "c"].join("\n");
    const { body, result } = await getLog(logJenkins(text), { excludePattern: "^noise" });
    expect(result.lines).toEqual(["a", "b", "c"]);
    expect(result).toMatchObject({ startLine: 1, endLine: 5, totalLines: 5 });
    expect(body.message).toMatch(/Dropped 2 line\(s\) matching excludePattern/);
  });

  it("matches the ANSI-stripped text", async () => {
    const text = [`${ESC}[2mnoise${ESC}[0m`, "keep"].join("\n");
    const { result } = await getLog(logJenkins(text), { excludePattern: "^noise$" });
    expect(result.lines).toEqual(["keep"]);
  });

  it("rejects long and catastrophic patterns", async () => {
    const tooLong = await getLog(logJenkins("x"), { excludePattern: "a".repeat(1001) });
    expect(parse(tooLong.out.text).message).toMatch(/excludePattern is too long/);
    const slow = await getLog(logJenkins("x"), { excludePattern: "(a+)+$" });
    expect(parse(slow.out.text).message).toMatch(/excludePattern is too expensive/);
  });

  it("keeps cursors exact across dropped lines", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => (i % 2 ? `noise ${i}` : `keep ${i}`));
    const jenkins = logJenkins(lines.join("\n"));
    const first = await getLog(jenkins, { skip: 0, limit: 3, excludePattern: "^noise" });
    expect(first.result.lines).toEqual(["keep 0", "keep 2", "keep 4"]);
    const second = await getLog(jenkins, {
      cursor: first.result.nextCursor,
      limit: 3,
      excludePattern: "^noise",
    });
    expect(second.result.lines).toEqual(["keep 6", "keep 8", "keep 10"]);
  });
});

describe("collapseRepeats", () => {
  it("ignores leading timestamps when comparing lines", () => {
    expect(repeatKey("[16:48:09]: waiting for simulator")).toBe("waiting for simulator");
    expect(repeatKey("2026-01-02T03:04:05.123Z waiting")).toBe("waiting");
    expect(repeatKey("[2026-01-02 03:04:05] waiting")).toBe("waiting");
    expect(repeatKey("10:20:30.120 waiting")).toBe("waiting");
    expect(repeatKey("build 10:20")).toBe("build 10:20");
  });

  it("folds identical neighbouring lines with their line range", async () => {
    const text = [
      "start",
      ...Array.from({ length: 5 }, (_, i) => `[16:48:0${i}]: waiting for simulator`),
      "done",
    ].join("\n");
    const { body, result } = await getLog(logJenkins(text), { collapseRepeats: true });
    expect(result.lines).toEqual([
      "start",
      "[16:48:00]: waiting for simulator … repeated 5× (lines 2–6)",
      "done",
    ]);
    expect(result).toMatchObject({ startLine: 1, endLine: 7, totalLines: 7 });
    expect(body.message).toMatch(/Folded 4 repeated line/);
  });

  it("is off by default in MCP mode and on when the profile says so", async () => {
    const text = ["x", "x", "x"].join("\n");
    expect((await getLog(logJenkins(text), {})).result.lines).toEqual(["x", "x", "x"]);
    const folded = await getLog(logJenkins(text), {}, { collapseRepeats: true });
    expect(folded.result.lines).toEqual(["x … repeated 3× (lines 1–3)"]);
  });

  it("pages over folded runs without losing or repeating lines", async () => {
    const text = ["a", "r", "r", "r", "b", "c"].join("\n");
    const jenkins = logJenkins(text);
    const first = await getLog(jenkins, { skip: 0, limit: 2, collapseRepeats: true });
    expect(first.result.lines).toEqual(["a", "r … repeated 3× (lines 2–4)"]);
    const second = await getLog(jenkins, {
      cursor: first.result.nextCursor,
      limit: 2,
      collapseRepeats: true,
    });
    expect(second.result.lines).toEqual(["b", "c"]);
  });
});

describe("getBuildLog redaction", () => {
  it("redacts secrets in log lines and counts them", async () => {
    const jenkins = mockJenkins({
      [BUILD]: json({ number: 7 }),
      [LOG]: () => streamedLog(["export AWS_SECRET_ACCESS_KEY=abc123\n", "password=hunter2\n"]),
    });
    const out = await runTool(session(jenkins.fetch), "getBuildLog", { jobFullName: "app" });
    expect(out.text).not.toContain("hunter2");
    expect(out.text).not.toContain("abc123");
    expect(parse(out.text).message).toMatch(/^Data retrieved successfully \(2 values redacted\)\./);
  });
});
