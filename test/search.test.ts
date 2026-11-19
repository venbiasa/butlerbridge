import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cliMain.js";
import { MemoryStore } from "../src/credentials.js";
import { runTool } from "../src/runtime.js";
import type { Unit } from "../src/tools/logText.js";
import {
  compileMatcher,
  decodeSearchCursor,
  encodeSearchCursor,
  LogSearcher,
  type SearchLogResponse,
} from "../src/tools/search.js";
import { BASE, mockJenkins, parse, session, streamedLog, TOKEN, USER } from "./helpers.js";

const BUILD = "GET /job/app/lastBuild/api/json";
const LOG = "GET /job/app/7/logText/progressiveText";
const ESC = "\u001b";

function logJenkins(text: string) {
  const chunks = text.match(/[\s\S]{1,65536}/g) ?? [""];
  return mockJenkins({
    [BUILD]: { number: 7 },
    [LOG]: () => streamedLog(chunks),
  });
}

async function search(
  text: string,
  args: Record<string, unknown>,
  overrides: Parameters<typeof session>[1] = {},
) {
  const out = await runTool(session(logJenkins(text).fetch, overrides), "searchBuildLog", {
    jobFullName: "app",
    ...args,
  });
  const body = parse(out.text);
  return { out, body, result: body.result as SearchLogResponse };
}

function units(lines: string[]): Unit[] {
  return lines.map((text, i) => ({ first: i, last: i, text, plain: text, count: 1 }));
}

const LINES = [
  "start",
  "compile ok",
  "ERROR one",
  "after one",
  "x",
  "error two",
  "after two",
  "end",
];

describe("matchers", () => {
  it("supports regex and inline (?i)", () => {
    expect(compileMatcher("err(or)? \\w+", true, true)("ERROR two")).toBe(true);
    expect(compileMatcher("(?i)error", true, false)("ERROR")).toBe(true);
    expect(compileMatcher("^end$", true, false)("the end")).toBe(false);
  });

  it("rejects catastrophic and invalid regexes", () => {
    expect(() => compileMatcher("(a+)+$", true, false)).toThrow(/too expensive/);
    expect(() => compileMatcher("(unclosed", true, false)).toThrow(
      /not a valid regular expression/,
    );
  });
});

describe("LogSearcher", () => {
  function run(maxMatches: number, contextLines: number, ignoreCase = false) {
    const s = new LogSearcher(compileMatcher("ERROR", false, ignoreCase), maxMatches, contextLines);
    for (const u of units(LINES)) if (!s.push(u)) break;
    return s;
  }

  it("matches plain text case-sensitively by default", () => {
    expect(run(10, 0).hits.map((h) => h.unit.first + 1)).toEqual([3]);
  });

  it("keeps context before and after", () => {
    const s = run(10, 1, true);
    expect(s.hits[0]!.before.map((u) => u.text)).toEqual(["compile ok"]);
    expect(s.hits[0]!.after.map((u) => u.text)).toEqual(["after one"]);
  });

  it("stops early once the budget is full and one more match is seen", () => {
    const s = new LogSearcher(compileMatcher("ERROR", false, true), 1, 0);
    let pushed = 0;
    for (const u of units(LINES)) {
      pushed++;
      if (!s.push(u)) break;
    }
    expect(s.hits).toHaveLength(1);
    expect(s.hasMoreMatches).toBe(true);
    expect(pushed).toBe(6);
  });
});

describe("searchBuildLog shapes", () => {
  it("keeps the plugin's shape by default in MCP mode", async () => {
    const { result } = await search(LINES.join("\n"), {
      pattern: "error",
      ignoreCase: true,
      maxMatches: 1,
    });
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
      nextCursor: encodeSearchCursor(7, false, 4),
    });
  });

  it("returns {line, text} or {startLine, text} when compact", async () => {
    const noContext = await search(LINES.join("\n"), { pattern: "ERROR", compact: true });
    expect(noContext.result.matches).toEqual([{ line: 3, text: "ERROR one" }]);
    const withContext = await search(LINES.join("\n"), {
      pattern: "ERROR",
      compact: true,
      contextLines: 1,
    });
    expect(withContext.result.matches).toEqual([
      { startLine: 2, text: "compile ok\nERROR one\nafter one" },
    ]);
  });

  it("uses compact matches when the profile asks for them", async () => {
    const { result } = await search(
      LINES.join("\n"),
      { pattern: "ERROR" },
      { compactSearch: true },
    );
    expect(result.matches).toEqual([{ line: 3, text: "ERROR one" }]);
  });

  it("validates pattern input like the plugin", async () => {
    const empty = await search("x", { pattern: "" });
    expect(empty.body.message).toBe("Search pattern cannot be null or empty");
    const long = await search("x", { pattern: "a".repeat(1001), useRegex: true });
    expect(long.body.message).toMatch(/too long: 1001 characters, the maximum is 1000/);
  });
});

describe("continuing a search", () => {
  const text = Array.from({ length: 30 }, (_, i) =>
    i % 3 === 0 ? `hit ${i + 1}` : `x ${i + 1}`,
  ).join("\n");
  const all = Array.from({ length: 10 }, (_, i) => i * 3 + 1);

  it("pages forward with nextCursor without gaps or repeats", async () => {
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const { result } = await search(text, {
        pattern: "hit",
        maxMatches: 4,
        compact: true,
        cursor,
      });
      seen.push(...result.matches.map((m) => (m as { line: number }).line));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(all);
  });

  it("pages backwards with fromEnd, newest first", async () => {
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const { result } = await search(text, {
        pattern: "hit",
        maxMatches: 4,
        compact: true,
        fromEnd: true,
        cursor,
      });
      seen.push(...result.matches.map((m) => (m as { line: number }).line));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual([...all].reverse());
  });

  it("accepts startLine as a plain alternative", async () => {
    const forward = await search(text, { pattern: "hit", startLine: 20, compact: true });
    expect(forward.result.matches.map((m) => (m as { line: number }).line)).toEqual([22, 25, 28]);
    const back = await search(text, {
      pattern: "hit",
      startLine: 10,
      fromEnd: true,
      compact: true,
    });
    expect(back.result.matches.map((m) => (m as { line: number }).line)).toEqual([10, 7, 4, 1]);
  });

  it("rejects a cursor from another build", async () => {
    expect(() => decodeSearchCursor(encodeSearchCursor(6, false, 3), 7)).toThrow(/build #6/);
  });
});

describe("fromEnd", () => {
  it("returns the last matches with correct line numbers and after-context", async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
    lines[899] = "error: late";
    lines[997] = "error: last";
    const { result } = await search(lines.join("\n"), {
      pattern: "error:",
      fromEnd: true,
      maxMatches: 1,
      contextLines: 2,
    });
    expect(result.matches).toEqual([
      {
        matchedLineNumber: 998,
        matchedLine: "error: last",
        contextLines: ["line 996", "line 997", "error: last", "line 999", "line 1000"],
        contextStartLine: 996,
        contextEndLine: 1000,
      },
    ]);
    expect(result).toMatchObject({ hasMoreMatches: true, totalLines: 1000 });
    expect(decodeSearchCursor(result.nextCursor!, 7)).toEqual({ fromEnd: true, startLine: 997 });
  });
});

describe("text handling in search", () => {
  it("matches the ANSI-stripped text", async () => {
    const { result } = await search(`${ESC}[31mFAIL${ESC}[0mED: build`, {
      pattern: "FAILED:",
      compact: true,
    });
    expect(result.matches).toEqual([{ line: 1, text: "FAILED: build" }]);
  });

  it("folds repeated matching lines into one match", async () => {
    const text = [
      "ok",
      ...Array.from({ length: 500 }, () => "warning: deprecated API"),
      "end",
    ].join("\n");
    const { result } = await search(text, {
      pattern: "warning",
      compact: true,
      collapseRepeats: true,
    });
    expect(result.matches).toEqual([
      { line: 2, text: "warning: deprecated API … repeated 500× (lines 2–501)" },
    ]);
  });

  it("drops excluded lines and reports the count", async () => {
    const { body, result } = await search(["error: real", "error: noise"].join("\n"), {
      pattern: "error",
      excludePattern: "noise",
      compact: true,
    });
    expect(result.matches).toEqual([{ line: 1, text: "error: real" }]);
    expect(body.message).toMatch(/Dropped 1 line\(s\) matching excludePattern/);
  });
});

describe("search size cap", () => {
  const big = Array.from({ length: 200 }, (_, i) => `error ${i}: ${"y".repeat(300)}`).join("\n");

  it.each([1_000, 3_000, 20_000])(
    "stays valid JSON under maxResultChars=%i and offers a cursor",
    async (max) => {
      const { out, body, result } = await search(
        big,
        { pattern: "error", contextLines: 4, maxMatches: 200 },
        { maxResultChars: max },
      );
      expect(out.text.length).toBeLessThanOrEqual(max);
      expect(body.truncatedResult).toBeUndefined();
      expect(result.matchCount).toBe(result.matches.length);
      expect(result.matchCount).toBeGreaterThan(0);
      expect(result.hasMoreMatches).toBe(true);
      expect(result.nextCursor).toBeTruthy();
      expect(body.message).toMatch(/Stopped at \d+ match\(es\) to stay under maxResultChars/);
    },
  );

  it("continues after the last match it returned", async () => {
    const first = await search(big, { pattern: "error", compact: true }, { maxResultChars: 2_000 });
    const lastLine = (first.result.matches.at(-1) as { line: number }).line;
    const second = await search(
      big,
      { pattern: "error", compact: true, cursor: first.result.nextCursor },
      { maxResultChars: 2_000 },
    );
    expect((second.result.matches[0] as { line: number }).line).toBe(lastLine + 1);
  });

  it("cuts a single giant match to fit", async () => {
    const { out, body, result } = await search(
      `error: ${"z".repeat(3_900)}`,
      { pattern: "error" },
      { maxResultChars: 1_000 },
    );
    expect(out.text.length).toBeLessThanOrEqual(1_000);
    expect(body.truncatedResult).toBeUndefined();
    expect(result.matches).toHaveLength(1);
  });
});

describe("finding the last error in a noisy 20k-line log", () => {
  function fixture(): { text: string; lastError: number } {
    const lines: string[] = [];
    let lastError = 0;
    for (let i = 1; i <= 20_000; i++) {
      if (i >= 12_000 && i < 12_500) {
        lines.push(
          `[16:48:${String(i % 60).padStart(2, "0")}]: ${ESC}[2mSimulator: waiting for boot${ESC}[0m`,
        );
      } else if (i % 1_500 === 0 || i === 19_950) {
        lines.push(`${ESC}[1;31m❌ error: test target failed at step ${i}${ESC}[0m`);
        lastError = i;
      } else {
        lines.push(
          `${ESC}[35m▸${ESC}[0m ${ESC}[1mCompiling${ESC}[0m Module${i % 97}.swift in target App`,
        );
      }
    }
    return { text: lines.join("\n"), lastError };
  }

  it("takes one call and at least 50% fewer characters than before", async () => {
    const { text, lastError } = fixture();

    const before = await runTool(session(logJenkins(text).fetch), "searchBuildLog", {
      jobFullName: "app",
      pattern: "error:",
      maxMatches: 5,
      contextLines: 3,
      keepAnsi: true,
      compact: false,
      collapseRepeats: false,
    });
    const beforeBody = parse(before.text) as { result: Record<string, unknown> };
    delete beforeBody.result.nextCursor;
    const beforeChars = JSON.stringify(beforeBody).length;
    const firstFive = (beforeBody.result.matches as { matchedLineNumber: number }[]).map(
      (m) => m.matchedLineNumber,
    );
    expect(firstFive).not.toContain(lastError);

    const jenkins = logJenkins(text);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      [
        "searchBuildLog",
        "--jobFullName",
        "app",
        "--pattern",
        "error:",
        "--fromEnd",
        "true",
        "--maxMatches",
        "5",
        "--contextLines",
        "3",
      ],
      {
        env: {
          JENKINS_URL: BASE,
          JENKINS_USER: USER,
          JENKINS_TOKEN: TOKEN,
          BUTLERBRIDGE_CONFIG: join(tmpdir(), "butlerbridge-test-missing", "config.json"),
        },
        store: new MemoryStore(),
        fetch: jenkins.fetch,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
      },
    );
    expect(code).toBe(0);
    expect(jenkins.calls.filter((c) => c.url.pathname.endsWith("progressiveText"))).toHaveLength(1);
    const afterChars = out.join("\n").length;
    const result = (parse(out.join("\n")).result as SearchLogResponse).matches;
    const firstText = (result[0] as { startLine: number; text: string }).text;
    expect(firstText).toContain(`error: test target failed at step ${lastError}`);
    expect(firstText).not.toContain(ESC);
    expect(afterChars).toBeLessThanOrEqual(beforeChars * 0.5);
  });
});
