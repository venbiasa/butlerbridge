import { ToolError } from "../errors.js";
import { buildPath } from "../jobPath.js";
import { compileUserRegex } from "../patterns.js";
import { bool, s, str, type Args, type JsonSchema, type ToolContext } from "./types.js";

export const MAX_LIMIT = 10_000;
export const MAX_LINE_CHARS = 4_000;
export const LINE_TRUNCATED = "…[line truncated]";
/** Log streams may take longer than one ordinary request. */
const LOG_TIMEOUT_FACTOR = 4;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** CSI (`ESC [ … m`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`) and two-byte `ESC x` sequences. */
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
  "g",
);

export function stripAnsi(text: string): string {
  return text.includes(ESC) ? text.replace(ANSI, "") : text;
}

/** `[16:48:09]:`, `2026-01-02T03:04:05.123Z`, `[2026-01-02 03:04:05]`, `03:04:05.120` at the start of a line. */
const LEADING_TIMESTAMP =
  /^\s*\[?\s*(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s*\]?:?\s*/;

export function repeatKey(plain: string): string {
  return plain.replace(LEADING_TIMESTAMP, "");
}

export function clipLine(line: string, max = MAX_LINE_CHARS): string {
  return line.length <= max ? line : `${line.slice(0, max)}${LINE_TRUNCATED}`;
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

/**
 * One output line. `first`/`last` are 0-based raw line indexes from where the stream started, so a
 * folded run of repeats keeps the numbers of the lines it stands for.
 */
export interface Unit {
  first: number;
  last: number;
  /** As shown: ANSI stripped unless keepAnsi. */
  text: string;
  /** Always ANSI-free; patterns match against this. */
  plain: string;
  count: number;
}

export interface TextOptions {
  keepAnsi: boolean;
  collapse: boolean;
  exclude: RegExp | null;
}

export interface UnitStats {
  /** Raw lines read from the stream, including skipped ones. */
  raw: number;
  dropped: number;
  folded: number;
}

export function newStats(): UnitStats {
  return { raw: 0, dropped: 0, folded: 0 };
}

/** Raw lines → filtered (excludePattern) → folded (collapseRepeats) units. */
export async function* toUnits(
  lines: AsyncIterable<string>,
  opts: TextOptions,
  stats: UnitStats,
  skipRaw = 0,
): AsyncGenerator<Unit> {
  let index = -1;
  let run: (Unit & { key: string }) | null = null;
  for await (const raw of lines) {
    index++;
    stats.raw = index + 1;
    if (index < skipRaw) continue;
    const plain = stripAnsi(raw);
    if (opts.exclude && opts.exclude.test(plain)) {
      stats.dropped++;
      continue;
    }
    const text = opts.keepAnsi ? raw : plain;
    if (!opts.collapse) {
      yield { first: index, last: index, text, plain, count: 1 };
      continue;
    }
    const key = repeatKey(plain);
    if (run && run.key === key) {
      run.last = index;
      run.count++;
      stats.folded++;
      continue;
    }
    if (run) yield run;
    run = { first: index, last: index, text, plain, count: 1, key };
  }
  if (run) yield run;
}

/** `base` turns indexes into line numbers; null when they aren't known (cursor reads). */
export function renderUnit(unit: Unit, base: number | null, trim = false): string {
  const text = clipLine(trim ? unit.text.trim() : unit.text);
  if (unit.count === 1) return text;
  const range = base === null ? "" : ` (lines ${base + unit.first + 1}–${base + unit.last + 1})`;
  return `${text} … repeated ${unit.count}×${range}`;
}

export function textOptionsSchema(): Record<string, JsonSchema> {
  return {
    keepAnsi: s.boolean(
      "butlerbridge extension: keep ANSI colour codes in the returned text (default false: they are stripped; patterns always match the stripped text)",
    ),
    collapseRepeats: s.boolean(
      "butlerbridge extension: fold identical neighbouring lines (ignoring leading timestamps) into one line plus '… repeated N× (lines A–B)'",
    ),
    excludePattern: s.string(
      "butlerbridge extension: regex (max 1000 chars); matching lines are dropped before paging or searching",
    ),
  };
}

export function textOptions(args: Args, ctx: ToolContext): TextOptions {
  const exclude = str(args, "excludePattern");
  return {
    keepAnsi: bool(args, "keepAnsi") ?? false,
    collapse: bool(args, "collapseRepeats") ?? (ctx.mode === "cli" || ctx.profile.collapseRepeats),
    exclude: exclude ? compileUserRegex(exclude, "excludePattern") : null,
  };
}

export function noteStats(ctx: ToolContext, stats: UnitStats, partial: boolean): void {
  const where = partial ? " in the part read" : "";
  if (stats.dropped) {
    ctx.notes.push(`Dropped ${stats.dropped} line(s) matching excludePattern${where}.`);
  }
  if (stats.folded) ctx.notes.push(`Folded ${stats.folded} repeated line(s)${where}.`);
}

/** Characters a string costs inside the final JSON, after redaction. */
export function jsonCost(ctx: ToolContext, text: string): number {
  return JSON.stringify(ctx.redactPreview(text)).length + 1;
}

/** Cuts one line so it costs at most `budget` characters, marking the cut. */
export function fitText(ctx: ToolContext, text: string, budget: number): string {
  if (jsonCost(ctx, text) <= budget) return text;
  let n = Math.min(text.length, Math.max(0, budget));
  while (n > 0) {
    const candidate = `${text.slice(0, n)}${LINE_TRUNCATED}`;
    if (jsonCost(ctx, candidate) <= budget) return candidate;
    n = Math.floor(n * 0.75);
  }
  return LINE_TRUNCATED;
}

export interface OpenLog {
  lines: AsyncGenerator<string>;
  textSize: number;
  building: boolean;
  close(): void;
}

export async function openLog(
  ctx: ToolContext,
  job: string,
  build: number,
  start: number,
): Promise<OpenLog | null> {
  const controller = new AbortController();
  const limitMs = ctx.profile.timeoutMs * LOG_TIMEOUT_FACTOR;
  const timer = setTimeout(() => controller.abort(), limitMs);
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
            `Reading the log took longer than ${limitMs} ms; narrow the request or raise timeoutMs.`,
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
