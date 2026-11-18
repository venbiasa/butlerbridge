import { ToolError } from "../errors.js";
import { buildPath, normalizeBuildRef } from "../jobPath.js";
import { resolveBuildNumber } from "./common.js";
import {
  bool,
  int,
  JOB_FULL_NAME_DESC,
  objectSchema,
  READ_ONLY,
  reqStr,
  s,
  str,
  type ToolContext,
  type ToolDef,
} from "./types.js";

export const MAX_LIMIT = 10_000;
export const MAX_LINE_CHARS = 4_000;
export const MAX_PATTERN_LENGTH = 1_000;
/** Regexes only see this much of a line, which bounds the work one line can cost. */
const MAX_MATCH_CHARS = 10_000;
/** Log streams may take longer than one ordinary request. */
const LOG_TIMEOUT_FACTOR = 4;

export interface BuildLogResponse {
  lines: string[];
  hasMoreContent: boolean;
  startLine: number;
  endLine: number;
  totalLines: number;
  nextCursor: string | null;
}

export interface SearchMatch {
  matchedLineNumber: number;
  matchedLine: string;
  contextLines: string[];
  contextStartLine: number;
  contextEndLine: number;
}

export interface SearchLogResponse {
  pattern: string;
  useRegex: boolean;
  ignoreCase: boolean;
  matchCount: number;
  hasMoreMatches: boolean;
  totalLines: number;
  matches: SearchMatch[];
}

/**
 * base64url of `<build>:<byteOffset>:<linesToSkip>`. The offset is one Jenkins accepts as
 * `progressiveText?start=`; the line count covers positions inside that chunk, because the plain
 * text Jenkins streams no longer maps line by line onto raw byte offsets.
 */
export function encodeCursor(build: number, offset: number, skipLines: number): string {
  return Buffer.from(`${build}:${offset}:${skipLines}`, "ascii").toString("base64url");
}

export function decodeCursor(
  cursor: string,
  expectedBuild: number,
): { offset: number; skipLines: number } {
  const raw = Buffer.from(cursor, "base64url").toString("ascii");
  const m = /^(\d+):(\d+)(?::(\d+))?$/.exec(raw);
  if (!m) throw new ToolError("Invalid cursor");
  const build = Number(m[1]);
  if (build !== expectedBuild) {
    throw new ToolError(
      `Cursor was issued for build #${build}, but build #${expectedBuild} was requested`,
    );
  }
  return { offset: Number(m[2]), skipLines: Number(m[3] ?? 0) };
}

export function clipLine(line: string, max = MAX_LINE_CHARS): string {
  return line.length <= max ? line : `${line.slice(0, max)}… [line clipped, ${line.length} chars]`;
}

/** Splits a streamed body into lines; the final unterminated line is yielded too, like the plugin's forceEol. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = pending + decoder.decode(value, { stream: true });
      let start = 0;
      for (let nl = chunk.indexOf("\n"); nl !== -1; nl = chunk.indexOf("\n", start)) {
        const end = nl > start && chunk.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
        yield chunk.slice(start, end);
        start = nl + 1;
      }
      pending = chunk.slice(start);
    }
    pending += decoder.decode();
    if (pending.length) yield pending.replace(/\r$/, "");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

interface OpenLog {
  lines: AsyncGenerator<string>;
  textSize: number;
  building: boolean;
  close(): void;
}

async function openLog(
  ctx: ToolContext,
  job: string,
  build: number,
  start: number,
): Promise<OpenLog | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.profile.timeoutMs * LOG_TIMEOUT_FACTOR);
  const close = () => {
    clearTimeout(timer);
    controller.abort();
  };
  try {
    const res = await ctx.client.request(`${buildPath(job, build)}/logText/progressiveText`, {
      query: { start },
      acceptStatus: [404],
      signal: controller.signal,
    });
    if (res.status === 404 || !res.body) {
      close();
      return null;
    }
    const textSize = Number(res.headers.get("x-text-size") ?? NaN);
    const building = res.headers.get("x-more-data") === "true";
    const inner = readLines(res.body);
    const lines = (async function* () {
      try {
        yield* inner;
      } catch (err) {
        if (controller.signal.aborted) {
          throw new ToolError(
            `Reading the log took longer than ${ctx.profile.timeoutMs * LOG_TIMEOUT_FACTOR} ms; narrow the request or raise timeoutMs.`,
          );
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    })();
    return { lines, textSize: Number.isFinite(textSize) ? textSize : -1, building, close };
  } catch (err) {
    close();
    throw err;
  }
}

/** Characters available for lines once the envelope and JSON escaping are accounted for. */
function charBudget(ctx: ToolContext): number {
  return Math.max(1_000, Math.floor(ctx.profile.maxResultChars * 0.85) - 500);
}

async function readForward(
  ctx: ToolContext,
  job: string,
  build: number,
  startOffset: number,
  skipLines: number,
  limit: number,
  knowLineNumbers: boolean,
): Promise<BuildLogResponse> {
  const log = await openLog(ctx, job, build, startOffset);
  if (!log) return emptyLog(null);
  try {
    if (startOffset > 0 && log.textSize >= 0 && log.textSize < startOffset) {
      throw new ToolError("Invalid cursor: it points past the end of this build's log");
    }
    const budget = charBudget(ctx);
    const lines: string[] = [];
    let used = 0;
    let index = 0;
    let hasMore = false;
    for await (const raw of log.lines) {
      if (index++ < skipLines) continue;
      const line = clipLine(raw);
      const cost = line.length + 4;
      if (lines.length >= limit || (lines.length > 0 && used + cost > budget)) {
        hasMore = true;
        if (lines.length < limit) {
          ctx.notes.push(
            `Page shortened to ${lines.length} lines to stay under maxResultChars; pass nextCursor as cursor to continue.`,
          );
        }
        break;
      }
      lines.push(line);
      used += cost;
    }
    const nextCursor = hasMore
      ? encodeCursor(build, startOffset, skipLines + lines.length)
      : log.building && log.textSize >= 0
        ? encodeCursor(build, log.textSize, 0)
        : null;
    const numbered = knowLineNumbers && lines.length > 0;
    return {
      lines,
      hasMoreContent: hasMore,
      startLine: numbered ? skipLines + 1 : -1,
      endLine: numbered ? skipLines + lines.length : -1,
      totalLines: -1,
      nextCursor,
    };
  } finally {
    log.close();
  }
}

async function readTail(
  ctx: ToolContext,
  job: string,
  build: number,
  skip: number,
  limit: number,
): Promise<BuildLogResponse> {
  const absLimit = Math.abs(limit);
  const theoretical = skip === 0 ? absLimit : limit > 0 ? -skip : -skip + absLimit;
  const capacity = Math.max(1, Math.min(theoretical, MAX_LIMIT));
  const log = await openLog(ctx, job, build, 0);
  if (!log) return emptyLog(null);
  const ring: { index: number; text: string }[] = [];
  let total = 0;
  try {
    for await (const raw of log.lines) {
      ring.push({ index: total++, text: clipLine(raw) });
      if (ring.length > capacity) ring.shift();
    }
  } finally {
    log.close();
  }
  let resolvedSkip: number;
  if (skip === 0) resolvedSkip = Math.max(0, total - absLimit);
  else if (limit > 0) resolvedSkip = Math.max(0, total + skip);
  else resolvedSkip = Math.max(0, total + skip - absLimit);
  const endExclusive = Math.min(resolvedSkip + absLimit, total);
  let window = ring.filter((e) => e.index >= resolvedSkip && e.index < endExclusive);

  const budget = charBudget(ctx);
  let used = window.reduce((n, e) => n + e.text.length + 4, 0);
  let dropped = 0;
  while (window.length > 1 && used > budget) {
    used -= (window[0] as { text: string }).text.length + 4;
    window = window.slice(1);
    dropped++;
  }
  const firstIndex = window[0]?.index ?? -1;
  if (dropped > 0) {
    ctx.notes.push(
      `Dropped the first ${dropped} lines of the requested window to stay under maxResultChars; ` +
        `read them with skip=${resolvedSkip} and limit=${dropped}.`,
    );
  }
  const more = endExclusive < total;
  const nextCursor = more
    ? encodeCursor(build, 0, endExclusive)
    : log.building && log.textSize >= 0
      ? encodeCursor(build, log.textSize, 0)
      : null;
  return {
    lines: window.map((e) => e.text),
    hasMoreContent: more,
    startLine: window.length ? firstIndex + 1 : -1,
    endLine: window.length ? endExclusive : -1,
    totalLines: total,
    nextCursor,
  };
}

function emptyLog(nextCursor: string | null): BuildLogResponse {
  return {
    lines: [],
    hasMoreContent: false,
    startLine: -1,
    endLine: -1,
    totalLines: -1,
    nextCursor,
  };
}

export const getBuildLog: ToolDef = {
  name: "getBuildLog",
  description:
    "Retrieves some log lines with pagination for a specific build or the last build of a Jenkins job," +
    " as well as a boolean value indicating whether there is more content to retrieve" +
    " For sequential pagination, pass the returned 'nextCursor' back as 'cursor' to resume" +
    " from the same spot without re-scanning. 'totalLines' is exact for end-relative reads" +
    " and -1 for forward reads (not computed)." +
    " If 'nextCursor' is set but 'hasMoreContent' is false, you've read everything written" +
    " so far but the build is still going; keep the cursor and call again later to pick up" +
    " whatever was appended in the meantime.",
  kind: "read",
  annotations: READ_ONLY,
  jobArg: "jobFullName",
  inputSchema: objectSchema(
    {
      jobFullName: s.string(JOB_FULL_NAME_DESC),
      buildNumber: s.integer(
        "The build number (optional, if not provided, returns the last build)",
      ),
      skip: s.integer(
        "The skip (optional, if not provided, returns from the first line). Negative values function as 'from the end', with -1 meaning starting with the last line",
      ),
      limit: s.integer(
        "The number of lines to return (optional; if neither limit nor skip is provided, returns the LAST 100 lines — for CI logs errors are usually at the end; with skip set, defaults to 100 lines forward), positive values return lines from the start, negative values return lines from the end",
      ),
      cursor: s.string(
        "Opaque cursor previously returned as 'nextCursor'. When set, reading resumes from that position; 'skip' is ignored and 'startLine', 'endLine' and 'totalLines' are reported as -1 (the cursor doesn't carry line numbers). The cursor is tied to the (job, buildNumber) it was issued for; passing it for a different build is rejected as invalid",
      ),
    },
    ["jobFullName"],
  ),
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const skipArg = int(args, "skip");
    let limit = int(args, "limit");
    const cursor = str(args, "cursor");
    if (limit === undefined || limit === 0) limit = skipArg === undefined ? -100 : 100;
    const skip = skipArg ?? 0;
    if (Math.abs(limit) > MAX_LIMIT) {
      ctx.notes.push(`limit capped at ${MAX_LIMIT} lines.`);
    }
    const absLimit = Math.min(Math.abs(limit), MAX_LIMIT);
    limit = limit < 0 ? -absLimit : absLimit;

    const build = await resolveBuildNumber(ctx, job, normalizeBuildRef(args.buildNumber));
    if (build === null) return null;
    if (cursor) {
      const { offset, skipLines } = decodeCursor(cursor, build);
      return readForward(ctx, job, build, offset, skipLines, absLimit, false);
    }
    if ((skip >= 0 && limit > 0) || (skip > 0 && limit < 0)) {
      const resolvedSkip = limit < 0 ? Math.max(0, skip - absLimit) : skip;
      return readForward(ctx, job, build, 0, resolvedSkip, absLimit, true);
    }
    return readTail(ctx, job, build, skip, limit);
  },
};

/** Patterns like `(a+)+` backtrack exponentially and JavaScript regexes can't be interrupted. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,\d*\})/;

export function compileMatcher(
  pattern: string,
  useRegex: boolean,
  ignoreCase: boolean,
): (line: string) => boolean {
  if (!useRegex) {
    if (!ignoreCase) return (line) => line.includes(pattern);
    const needle = pattern.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  let source = pattern;
  let flags = ignoreCase ? "i" : "";
  const inline = /^\(\?([imsx]+)\)/.exec(source);
  if (inline) {
    source = source.slice(inline[0].length);
    if (inline[1]!.includes("i")) flags += flags.includes("i") ? "" : "i";
    if (inline[1]!.includes("s")) flags += "s";
  }
  if (NESTED_QUANTIFIER.test(source)) {
    throw new ToolError(
      "Search pattern is too expensive: nested quantifiers like (a+)+ can take exponential time." +
        " Try a simpler pattern, or search for plain text with useRegex=false.",
    );
  }
  let re: RegExp;
  try {
    re = new RegExp(source, flags);
  } catch (err) {
    throw new ToolError(`Invalid regular expression: ${(err as Error).message}`);
  }
  return (line) => re.test(line.length > MAX_MATCH_CHARS ? line.slice(0, MAX_MATCH_CHARS) : line);
}

/** Line-by-line search with the plugin's semantics: context before/after, early stop once the budget is full. */
export class LogSearcher {
  readonly matches: SearchMatch[] = [];
  private readonly open: SearchMatch[] = [];
  private readonly window: string[] = [];
  hasMoreMatches = false;
  lineNumber = 0;
  private used = 0;

  constructor(
    private readonly matcher: (line: string) => boolean,
    private readonly maxMatches: number,
    private readonly contextLines: number,
    private readonly charBudget = Infinity,
  ) {}

  /** Returns false when nothing later in the log can change the result. */
  push(raw: string): boolean {
    this.lineNumber++;
    const line = clipLine(raw.trim());
    const full = this.matches.length >= this.maxMatches || this.used >= this.charBudget;
    if (full) {
      if (!this.hasMoreMatches) this.hasMoreMatches = this.matcher(line);
    } else if (this.matcher(line)) {
      const match: SearchMatch = {
        matchedLineNumber: this.lineNumber,
        matchedLine: line,
        contextLines: [...this.window],
        contextStartLine: this.lineNumber - this.window.length,
        contextEndLine: this.lineNumber,
      };
      this.matches.push(match);
      this.open.push(match);
      this.used += line.length * (this.contextLines * 2 + 2) + 120;
    }
    for (let i = this.open.length - 1; i >= 0; i--) {
      const m = this.open[i] as SearchMatch;
      m.contextLines.push(line);
      m.contextEndLine = this.lineNumber;
      if (this.lineNumber >= m.matchedLineNumber + this.contextLines) this.open.splice(i, 1);
    }
    if (this.contextLines > 0) {
      this.window.push(line);
      if (this.window.length > this.contextLines) this.window.shift();
    }
    return !(this.hasMoreMatches && this.open.length === 0);
  }

  get budgetHit(): boolean {
    return this.used >= this.charBudget && this.matches.length < this.maxMatches;
  }
}

export const searchBuildLog: ToolDef = {
  name: "searchBuildLog",
  description:
    "Search for log lines matching a pattern in a specific build or the last build of a Jenkins job. " +
    "Returns matching lines with their line numbers and context.",
  kind: "read",
  annotations: READ_ONLY,
  jobArg: "jobFullName",
  inputSchema: objectSchema(
    {
      jobFullName: s.string(JOB_FULL_NAME_DESC),
      buildNumber: s.integer(
        "The build number (optional, if not provided, searches the last build)",
      ),
      pattern: s.string("The search pattern (regex supported)"),
      useRegex: s.boolean(
        "Whether to use regex pattern matching (default: false, uses simple string contains)",
      ),
      ignoreCase: s.boolean("Whether the search should be case-insensitive (default: false)"),
      maxMatches: s.integer(
        "Maximum number of matches to return (optional, default: 100, max: 1000)",
      ),
      contextLines: s.integer(
        "Number of context lines to show before and after each match (default: 0)",
      ),
    },
    ["jobFullName", "pattern"],
  ),
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const pattern = str(args, "pattern");
    if (!pattern) throw new ToolError("Search pattern cannot be null or empty");
    const useRegex = bool(args, "useRegex") ?? false;
    if (useRegex && pattern.length > MAX_PATTERN_LENGTH) {
      throw new ToolError(
        `Search pattern is too long: ${pattern.length} characters, the maximum is ${MAX_PATTERN_LENGTH}`,
      );
    }
    const ignoreCase = bool(args, "ignoreCase") ?? false;
    const maxMatches = Math.min(int(args, "maxMatches") ?? 100, 1000);
    const contextLines = Math.min(Math.max(int(args, "contextLines") ?? 0, 0), 10);
    const matcher = compileMatcher(pattern, useRegex, ignoreCase);

    const build = await resolveBuildNumber(ctx, job, normalizeBuildRef(args.buildNumber));
    if (build === null) return null;
    const log = await openLog(ctx, job, build, 0);
    if (!log) return null;
    const searcher = new LogSearcher(matcher, maxMatches, contextLines, charBudget(ctx));
    try {
      for await (const line of log.lines) {
        if (!searcher.push(line)) break;
      }
    } finally {
      log.close();
    }
    if (searcher.budgetHit) {
      ctx.notes.push(
        `Stopped at ${searcher.matches.length} matches to stay under maxResultChars; narrow the pattern or lower contextLines.`,
      );
    }
    const result: SearchLogResponse = {
      pattern,
      useRegex,
      ignoreCase,
      matchCount: searcher.matches.length,
      hasMoreMatches: searcher.hasMoreMatches,
      totalLines: searcher.lineNumber,
      matches: searcher.matches,
    };
    return result;
  },
};

export const logTools = [getBuildLog, searchBuildLog];
