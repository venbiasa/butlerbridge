import { ToolError } from "../errors.js";
import { normalizeBuildRef } from "../jobPath.js";
import { compileUserRegex, MAX_PATTERN_LENGTH } from "../patterns.js";
import { resolveBuildNumber } from "./common.js";
import {
  fitText,
  newStats,
  noteStats,
  openLog,
  renderUnit,
  textOptions,
  textOptionsSchema,
  toUnits,
  type Unit,
} from "./logText.js";
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

/** Regexes only see this much of a line, which bounds the work one line can cost. */
const MAX_MATCH_CHARS = 10_000;

/** The plugin's match shape. */
export interface SearchMatch {
  matchedLineNumber: number;
  matchedLine: string;
  contextLines: string[];
  contextStartLine: number;
  contextEndLine: number;
}

/** `compact: true` shapes: `{line, text}` without context, `{startLine, text}` with it. */
export type CompactMatch = { line: number; text: string } | { startLine: number; text: string };

export interface SearchLogResponse {
  pattern: string;
  useRegex: boolean;
  ignoreCase: boolean;
  matchCount: number;
  hasMoreMatches: boolean;
  totalLines: number;
  matches: (SearchMatch | CompactMatch)[];
  nextCursor: string | null;
}

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
  const re = compileUserRegex(pattern, "Search pattern", ignoreCase ? "i" : "");
  return (line) => re.test(line.length > MAX_MATCH_CHARS ? line.slice(0, MAX_MATCH_CHARS) : line);
}

/** base64url of `s:<build>:<f|b>:<startLine>`; `f` resumes at startLine, `b` searches up to it. */
export function encodeSearchCursor(build: number, fromEnd: boolean, startLine: number): string {
  return Buffer.from(`s:${build}:${fromEnd ? "b" : "f"}:${startLine}`, "ascii").toString(
    "base64url",
  );
}

export function decodeSearchCursor(
  cursor: string,
  expectedBuild: number,
): { fromEnd: boolean; startLine: number } {
  const m = /^s:(\d+):([fb]):(\d+)$/.exec(Buffer.from(cursor, "base64url").toString("ascii"));
  if (!m) throw new ToolError("Invalid cursor");
  if (Number(m[1]) !== expectedBuild) {
    throw new ToolError(
      `Cursor was issued for build #${m[1]}, but build #${expectedBuild} was requested`,
    );
  }
  return { fromEnd: m[2] === "b", startLine: Number(m[3]) };
}

export interface Hit {
  unit: Unit;
  before: Unit[];
  after: Unit[];
  approx: number;
}

export interface SearchOptions {
  fromEnd: boolean;
  /** 1-based. Forward: match only at or after it. fromEnd: match only at or before it. */
  startLine?: number;
  /** Rough character budget; matches past it are not collected. */
  approxBudget?: number;
}

/**
 * Unit-by-unit search. Forward mode keeps the plugin's semantics: stop once the budget is full
 * and one more match proves there are more. fromEnd keeps the newest matches in a ring.
 */
export class LogSearcher {
  readonly hits: Hit[] = [];
  private readonly open: Hit[] = [];
  private readonly window: Unit[] = [];
  hasMoreMatches = false;
  private used = 0;

  constructor(
    private readonly matcher: (line: string) => boolean,
    private readonly maxMatches: number,
    private readonly contextLines: number,
    private readonly opts: SearchOptions = { fromEnd: false },
  ) {}

  private eligible(unit: Unit): boolean {
    const line = unit.first + 1;
    if (this.opts.startLine === undefined) return true;
    return this.opts.fromEnd ? line <= this.opts.startLine : line >= this.opts.startLine;
  }

  private approxCost(unit: Unit): number {
    return Math.min(unit.text.length, 4_000) + 12;
  }

  /** Returns false when nothing later in the log can change the result. */
  push(unit: Unit): boolean {
    const budget = this.opts.approxBudget ?? Infinity;
    if (!this.opts.fromEnd) {
      const full = this.hits.length >= this.maxMatches || this.used >= budget;
      if (full) {
        if (!this.hasMoreMatches && this.eligible(unit)) {
          this.hasMoreMatches = this.matcher(unit.plain.trim());
        }
      } else if (this.eligible(unit) && this.matcher(unit.plain.trim())) {
        this.addHit(unit);
      }
    } else if (this.eligible(unit) && this.matcher(unit.plain.trim())) {
      this.addHit(unit);
      while (this.hits.length > this.maxMatches || (this.used > budget && this.hits.length > 1)) {
        const old = this.hits.shift() as Hit;
        this.used -= old.approx;
        const i = this.open.indexOf(old);
        if (i >= 0) this.open.splice(i, 1);
        this.hasMoreMatches = true;
      }
    }
    for (let i = this.open.length - 1; i >= 0; i--) {
      const hit = this.open[i] as Hit;
      if (hit.unit !== unit) {
        hit.after.push(unit);
        const cost = this.approxCost(unit);
        hit.approx += cost;
        this.used += cost;
      }
      if (hit.after.length >= this.contextLines) this.open.splice(i, 1);
    }
    if (this.contextLines > 0) {
      this.window.push(unit);
      if (this.window.length > this.contextLines) this.window.shift();
    }
    if (!this.opts.fromEnd) return !(this.hasMoreMatches && this.open.length === 0);
    const past = this.opts.startLine !== undefined && unit.first + 1 > this.opts.startLine;
    return !(past && this.open.length === 0);
  }

  private addHit(unit: Unit): void {
    const before = [...this.window];
    const approx = [...before, unit].reduce((n, u) => n + this.approxCost(u), 60);
    const hit: Hit = { unit, before, after: [], approx };
    this.hits.push(hit);
    this.open.push(hit);
    this.used += approx;
  }

  /** Matches in result order: oldest first, or newest first for fromEnd. */
  ordered(): Hit[] {
    return this.opts.fromEnd ? [...this.hits].reverse() : [...this.hits];
  }
}

export function renderHit(
  hit: Hit,
  compact: boolean,
  contextLines: number,
): SearchMatch | CompactMatch {
  const all = [...hit.before, hit.unit, ...hit.after];
  const texts = all.map((u) => renderUnit(u, 0, true));
  const startLine = (all[0] as Unit).first + 1;
  if (compact) {
    return contextLines === 0
      ? { line: hit.unit.first + 1, text: renderUnit(hit.unit, 0, true) }
      : { startLine, text: texts.join("\n") };
  }
  return {
    matchedLineNumber: hit.unit.first + 1,
    matchedLine: renderUnit(hit.unit, 0, true),
    contextLines: texts,
    contextStartLine: startLine,
    contextEndLine: (all[all.length - 1] as Unit).last + 1,
  };
}

/** Shrinks every text in one match so it fits `budget` characters. */
function fitMatch(
  ctx: ToolContext,
  match: SearchMatch | CompactMatch,
  budget: number,
): SearchMatch | CompactMatch {
  if ("contextLines" in match) {
    const per = Math.max(40, Math.floor(budget / (match.contextLines.length + 2)));
    return {
      ...match,
      matchedLine: fitText(ctx, match.matchedLine, per),
      contextLines: match.contextLines.map((l) => fitText(ctx, l, per)),
    };
  }
  return { ...match, text: fitText(ctx, match.text, Math.max(40, budget - 40)) };
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
      fromEnd: s.boolean(
        "butlerbridge extension: return the LAST matches, newest first (default false). CI failures are usually near the end.",
      ),
      cursor: s.string(
        "butlerbridge extension: 'nextCursor' from a previous search of the same build; continues after (or, with fromEnd, before) the last match returned",
      ),
      startLine: s.integer(
        "butlerbridge extension: 1-based line to start at; with fromEnd, the line to search backwards from",
      ),
      compact: s.boolean(
        "butlerbridge extension: return matches as {line, text} (no context) or {startLine, text} (context joined by newlines) instead of the plugin's shape",
      ),
      ...textOptionsSchema(),
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
    const maxMatches = Math.max(1, Math.min(int(args, "maxMatches") ?? 100, 1000));
    const contextLines = Math.min(Math.max(int(args, "contextLines") ?? 0, 0), 10);
    const compact = bool(args, "compact") ?? (ctx.mode === "cli" || ctx.profile.compactSearch);
    const opts = textOptions(args, ctx);
    const matcher = compileMatcher(pattern, useRegex, ignoreCase);

    const build = await resolveBuildNumber(ctx, job, normalizeBuildRef(args.buildNumber));
    if (build === null) return null;
    const cursor = str(args, "cursor");
    let fromEnd = bool(args, "fromEnd") ?? false;
    let startLine = int(args, "startLine");
    if (cursor) ({ fromEnd, startLine } = decodeSearchCursor(cursor, build));

    const log = await openLog(ctx, job, build, 0);
    if (!log) return null;
    const max = ctx.profile.maxResultChars;
    const searcher = new LogSearcher(matcher, maxMatches, contextLines, {
      fromEnd,
      startLine,
      approxBudget: Math.floor(max * 1.2),
    });
    const stats = newStats();
    let stoppedEarly = false;
    try {
      for await (const unit of toUnits(log.lines, opts, stats)) {
        if (!searcher.push(unit)) {
          stoppedEarly = true;
          break;
        }
      }
    } finally {
      log.close();
    }
    noteStats(ctx, stats, stoppedEarly);

    const hits = searcher.ordered();
    let hasMore = searcher.hasMoreMatches;
    const kept: Hit[] = [];
    const matches: (SearchMatch | CompactMatch)[] = [];
    const make = (): SearchLogResponse => {
      const last = kept[kept.length - 1];
      const next = !hasMore || !last ? null : fromEnd ? last.unit.first : last.unit.last + 2;
      return {
        pattern,
        useRegex,
        ignoreCase,
        matchCount: matches.length,
        hasMoreMatches: hasMore,
        totalLines: stats.raw,
        matches,
        nextCursor: next !== null && next >= 1 ? encodeSearchCursor(build, fromEnd, next) : null,
      };
    };
    let sizeCut = false;
    for (const hit of hits) {
      let match = renderHit(hit, compact, contextLines);
      kept.push(hit);
      matches.push(match);
      const over = ctx.measure(make()) - max;
      if (over <= 0) continue;
      if (matches.length > 1) {
        kept.pop();
        matches.pop();
        sizeCut = true;
        break;
      }
      let budget = Math.max(200, JSON.stringify(match).length - over - 50);
      for (let i = 0; i < 6 && ctx.measure(make()) > max; i++) {
        match = fitMatch(ctx, match, budget);
        matches[0] = match;
        budget = Math.floor(budget * 0.7);
      }
      if (hits.length > 1) {
        sizeCut = true;
        break;
      }
    }
    if (sizeCut) {
      hasMore = true;
      ctx.notes.push(
        `Stopped at ${matches.length} match(es) to stay under maxResultChars; pass nextCursor as cursor to continue.`,
      );
    }
    return make();
  },
};
