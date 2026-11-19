import { ToolError } from "../errors.js";
import { normalizeBuildRef } from "../jobPath.js";
import { resolveBuildNumber } from "./common.js";
import {
  fitText,
  jsonCost,
  MAX_LIMIT,
  newStats,
  noteStats,
  openLog,
  renderUnit,
  textOptions,
  textOptionsSchema,
  toUnits,
  type TextOptions,
  type Unit,
} from "./logText.js";
import { searchBuildLog } from "./search.js";
import {
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

export interface BuildLogResponse {
  lines: string[];
  hasMoreContent: boolean;
  startLine: number;
  endLine: number;
  totalLines: number;
  nextCursor: string | null;
}

/** Room for notes added after a page's line budget is fixed. */
const NOTE_ALLOWANCE = 400;

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

interface Page {
  units: Unit[];
  rendered: string[];
  hasMore: boolean;
  startLine: number;
  endLine: number;
  totalLines: number;
  nextCursor: string | null;
}

function toResponse(p: Page): BuildLogResponse {
  return {
    lines: p.rendered,
    hasMoreContent: p.hasMore,
    startLine: p.startLine,
    endLine: p.endLine,
    totalLines: p.totalLines,
    nextCursor: p.nextCursor,
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

/** Characters left for lines once an empty page and later notes are accounted for. */
function lineBudget(ctx: ToolContext): number {
  return ctx.profile.maxResultChars - ctx.measure(emptyLog("x".repeat(40))) - NOTE_ALLOWANCE;
}

async function readForward(
  ctx: ToolContext,
  job: string,
  build: number,
  startOffset: number,
  skipRaw: number,
  skipUnits: number,
  limit: number,
  knowLineNumbers: boolean,
  opts: TextOptions,
): Promise<BuildLogResponse> {
  const log = await openLog(ctx, job, build, startOffset);
  if (!log) return emptyLog(null);
  const stats = newStats();
  const base = knowLineNumbers ? 0 : null;
  const budget = lineBudget(ctx);
  const page: Unit[] = [];
  const rendered: string[] = [];
  let used = 0;
  let seen = 0;
  let hasMore = false;
  let shortened = false;
  try {
    if (startOffset > 0 && log.textSize >= 0 && log.textSize < startOffset) {
      throw new ToolError("Invalid cursor: it points past the end of this build's log");
    }
    for await (const unit of toUnits(log.lines, opts, stats, skipRaw)) {
      if (seen++ < skipUnits) continue;
      if (page.length >= limit) {
        hasMore = true;
        break;
      }
      let text = renderUnit(unit, base);
      const cost = jsonCost(ctx, text);
      if (used + cost > budget) {
        if (page.length > 0) {
          hasMore = true;
          shortened = true;
          break;
        }
        text = fitText(ctx, text, budget);
      }
      page.push(unit);
      rendered.push(text);
      used += cost;
    }
  } finally {
    log.close();
  }
  noteStats(ctx, stats, hasMore);
  const make = (): Page => {
    const last = page[page.length - 1];
    const more = hasMore && last !== undefined;
    return {
      units: page,
      rendered,
      hasMore: more,
      startLine: base !== null && page.length ? page[0]!.first + 1 : -1,
      endLine: base !== null && last ? last.last + 1 : -1,
      totalLines: -1,
      nextCursor: more
        ? encodeCursor(build, startOffset, last.last + 1)
        : log.building && log.textSize >= 0
          ? encodeCursor(build, log.textSize, 0)
          : null,
    };
  };
  let result = make();
  while (ctx.measure(toResponse(result)) > ctx.profile.maxResultChars && page.length > 1) {
    page.pop();
    rendered.pop();
    hasMore = true;
    shortened = true;
    result = make();
  }
  if (shortened) {
    ctx.notes.push(
      `Page shortened to ${page.length} line(s) to stay under maxResultChars; pass nextCursor as cursor to continue.`,
    );
  }
  shrinkSingleLine(ctx, result);
  return toResponse(result);
}

/** Last resort: one line alone is over the cap, so cut it until the envelope fits. */
function shrinkSingleLine(ctx: ToolContext, page: Page): void {
  const max = ctx.profile.maxResultChars;
  if (page.rendered.length !== 1) return;
  let over = ctx.measure(toResponse(page)) - max;
  while (over > 0) {
    const current = page.rendered[0] as string;
    page.rendered[0] = fitText(ctx, current, Math.max(0, jsonCost(ctx, current) - over - 20));
    if (page.rendered[0] === current) break;
    over = ctx.measure(toResponse(page)) - max;
  }
}

async function readTail(
  ctx: ToolContext,
  job: string,
  build: number,
  skip: number,
  limit: number,
  opts: TextOptions,
): Promise<BuildLogResponse> {
  const absLimit = Math.abs(limit);
  const theoretical = skip === 0 ? absLimit : limit > 0 ? -skip : -skip + absLimit;
  const capacity = Math.max(1, Math.min(theoretical, MAX_LIMIT));
  const log = await openLog(ctx, job, build, 0);
  if (!log) return emptyLog(null);
  const stats = newStats();
  const ring: Unit[] = [];
  let total = 0;
  try {
    for await (const unit of toUnits(log.lines, opts, stats)) {
      ring.push(unit);
      total++;
      if (ring.length > capacity) ring.shift();
    }
  } finally {
    log.close();
  }
  noteStats(ctx, stats, false);
  let resolvedSkip: number;
  if (skip === 0) resolvedSkip = Math.max(0, total - absLimit);
  else if (limit > 0) resolvedSkip = Math.max(0, total + skip);
  else resolvedSkip = Math.max(0, total + skip - absLimit);
  const endExclusive = Math.min(resolvedSkip + absLimit, total);
  const firstRingIndex = total - ring.length;
  const window = ring.slice(
    Math.max(0, resolvedSkip - firstRingIndex),
    Math.max(0, endExclusive - firstRingIndex),
  );

  const budget = lineBudget(ctx);
  let used = 0;
  let keepFrom = window.length;
  const rendered: string[] = [];
  for (let i = window.length - 1; i >= 0; i--) {
    const text = renderUnit(window[i]!, 0);
    const cost = jsonCost(ctx, text);
    if (used + cost > budget && rendered.length > 0) break;
    rendered.unshift(used + cost > budget ? fitText(ctx, text, budget) : text);
    used += cost;
    keepFrom = i;
  }
  const kept = window.slice(keepFrom);
  const more = endExclusive < total;
  const make = (): Page => ({
    units: kept,
    rendered,
    hasMore: more,
    startLine: kept.length ? kept[0]!.first + 1 : -1,
    endLine: kept.length ? kept[kept.length - 1]!.last + 1 : -1,
    totalLines: stats.raw,
    nextCursor: more
      ? encodeCursor(build, 0, (window[window.length - 1] as Unit).last + 1)
      : log.building && log.textSize >= 0
        ? encodeCursor(build, log.textSize, 0)
        : null,
  });
  let result = make();
  while (ctx.measure(toResponse(result)) > ctx.profile.maxResultChars && kept.length > 1) {
    kept.shift();
    rendered.shift();
    result = make();
  }
  const dropped = window.length - kept.length;
  if (dropped > 0 && kept.length) {
    ctx.notes.push(
      `Dropped the first ${dropped} line(s) of the requested window to stay under maxResultChars; ` +
        `they end before line ${kept[0]!.first + 1}.`,
    );
  }
  shrinkSingleLine(ctx, result);
  return toResponse(result);
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
      ...textOptionsSchema(),
    },
    ["jobFullName"],
  ),
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const skipArg = int(args, "skip");
    let limit = int(args, "limit");
    const cursor = str(args, "cursor");
    const opts = textOptions(args, ctx);
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
      return readForward(ctx, job, build, offset, skipLines, 0, absLimit, false, opts);
    }
    if ((skip >= 0 && limit > 0) || (skip > 0 && limit < 0)) {
      const resolvedSkip = limit < 0 ? Math.max(0, skip - absLimit) : skip;
      return readForward(ctx, job, build, 0, 0, resolvedSkip, absLimit, true, opts);
    }
    return readTail(ctx, job, build, skip, limit, opts);
  },
};

export const logTools = [getBuildLog, searchBuildLog];
