import { isHttpStatus, ToolError } from "../errors.js";
import { decodeHtml } from "./core.js";
import { int, objectSchema, str, type ToolDef } from "./types.js";

const SYSTEM_READ_DENIED = (tool: string) =>
  `Access denied: tool '${tool}' requires one of [hudson.model.Hudson.SystemRead]`;
const DEFAULT_LIMIT = 50;

/** java.util.logging levels by weight, for `level` filtering. */
const LEVELS: Record<string, number> = {
  OFF: Infinity,
  SEVERE: 1000,
  WARNING: 900,
  INFO: 800,
  CONFIG: 700,
  FINE: 500,
  FINER: 400,
  FINEST: 300,
  ALL: -Infinity,
};

export interface LogEntry {
  timestamp: string;
  level: string;
  logger: string | null;
  message: string;
  exception: string | null;
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  if (!m) return null;
  const inner = (m[1] as string).replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1");
  return decodeHtml(inner);
}

/**
 * Parses Jenkins' log feed. Each entry's content is `Functions.printLogRecord`: a first line with
 * the date and source, then `LEVEL: message`, then any stack trace.
 */
export function parseLogFeed(xml: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const body = m[1] as string;
    const content = tag(body, "content") ?? tag(body, "summary") ?? "";
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const header = lines[0] ?? "";
    const levelLine = /^([A-Z]+): ?([\s\S]*)$/.exec(lines[1] ?? "");
    const source = /\d{1,2}:\d{2}:\d{2}(?:\s*[AP]M)?\s+(.+)$/i.exec(header)?.[1]?.trim() ?? null;
    const rest = lines.slice(2).join("\n").trim();
    const published = tag(body, "published") ?? tag(body, "updated");
    entries.push({
      timestamp: published ? new Date(published).toISOString() : "",
      level: levelLine?.[1] ?? "INFO",
      logger: source,
      message: tag(body, "title") ?? levelLine?.[2] ?? "",
      exception: rest || null,
    });
  }
  return entries;
}

export const getSystemLog: ToolDef = {
  name: "getSystemLog",
  description:
    "Read recent Jenkins log entries, newest first. Reads the global system log, or a named Log Recorder when 'recorder' is set. Requires the Overall/SystemRead permission.",
  kind: "read",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  structured: true,
  inputSchema: objectSchema({
    limit: {
      type: "integer",
      description: "Maximum number of entries to return, newest first. Defaults to 50.",
    },
    level: {
      type: "string",
      description:
        "Minimum log level to include, e.g. SEVERE, WARNING, INFO. Defaults to all levels.",
    },
    recorder: {
      type: "string",
      description:
        "Name of a configured Log Recorder to read instead of the global system log. Use getLogRecorders to list them.",
    },
  }),
  outputSchema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            timestamp: { type: "string" },
            level: { type: "string" },
            logger: { type: ["string", "null"] },
            message: { type: "string" },
            exception: { type: ["string", "null"] },
          },
        },
      },
    },
  },
  async handler(args, ctx) {
    const limitArg = int(args, "limit");
    const max = limitArg === undefined || limitArg <= 0 ? DEFAULT_LIMIT : limitArg;
    const levelArg = str(args, "level")?.trim().toUpperCase();
    if (levelArg && !(levelArg in LEVELS)) throw new ToolError(`Bad level name: ${levelArg}`);
    const recorder = str(args, "recorder")?.trim();
    const path = recorder ? `/log/${encodeURIComponent(recorder)}/rss` : "/log/rss";
    let xml: string;
    try {
      xml = await ctx.client.text(path, { level: levelArg || undefined });
    } catch (err) {
      if (isHttpStatus(err, 403)) throw new ToolError(SYSTEM_READ_DENIED("getSystemLog"));
      if (recorder && isHttpStatus(err, 404))
        throw new ToolError(`No such Log Recorder: ${recorder}`);
      throw err;
    }
    const threshold = levelArg ? (LEVELS[levelArg] as number) : -Infinity;
    const entries = parseLogFeed(xml)
      .filter((e) => (LEVELS[e.level] ?? 0) >= threshold)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, max);
    return { entries };
  },
};

/** Recorder rows on `/log/` link to `<name>/configure`. */
export function parseRecorderNames(html: string): string[] {
  const names = new Set<string>();
  for (const m of html.matchAll(/href="(?:\.\/)?([^"/?#]+)\/configure"/g)) {
    names.add(decodeURIComponent(decodeHtml(m[1] as string)));
  }
  return [...names];
}

export const getLogRecorders: ToolDef = {
  name: "getLogRecorders",
  description:
    "List the names of configured Jenkins Log Recorders, for use with getSystemLog's 'recorder' parameter. Requires the Overall/SystemRead permission.",
  kind: "read",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: objectSchema({}),
  async handler(_args, ctx) {
    try {
      return parseRecorderNames(await ctx.client.text("/log/"));
    } catch (err) {
      if (isHttpStatus(err, 403)) throw new ToolError(SYSTEM_READ_DENIED("getLogRecorders"));
      throw err;
    }
  },
};

export const systemLogTools = [getSystemLog, getLogRecorders];
