import { ToolError } from "./errors.js";
import type { Args, ToolDef } from "./tools/types.js";

export interface ParsedArgv {
  command: string | undefined;
  flags: Map<string, string | true>;
  positionals: string[];
}

/** `--name value`, `--name=value`, bare `--flag`. Repeated flags keep the last value. */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(a.slice(2), next);
          i++;
        } else {
          flags.set(a.slice(2), true);
        }
      }
    } else if (a === "-h") {
      flags.set("help", true);
    } else if (command === undefined) {
      command = a;
    } else {
      positionals.push(a);
    }
  }
  return { command, flags, positionals };
}

export const GLOBAL_FLAGS = new Set(["profile", "pretty", "help", "json"]);

function propType(tool: ToolDef, name: string): string | string[] | undefined {
  const props = tool.inputSchema.properties as
    Record<string, { type?: string | string[] }> | undefined;
  return props?.[name]?.type;
}

function convert(tool: ToolDef, name: string, value: string | true): unknown {
  const type = propType(tool, name);
  if (value === true) {
    if (type === "boolean") return true;
    throw new ToolError(`--${name} needs a value`);
  }
  switch (type) {
    case "integer":
      if (/^-?\d+$/.test(value)) return Number(value);
      if (name === "buildNumber") return value;
      throw new ToolError(`--${name} must be an integer`);
    case "boolean":
      if (value === "true" || value === "false") return value === "true";
      throw new ToolError(`--${name} must be true or false`);
    case "object":
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error();
        return parsed;
      } catch {
        throw new ToolError(`--${name} must be a JSON object, e.g. --${name} '{"KEY":"value"}'`);
      }
    default:
      return value;
  }
}

/**
 * Turns CLI flags into tool arguments using the tool's schema. `--json '{…}'` supplies them all at
 * once; `--parameters.KEY value` sets one key of an object parameter.
 */
export function toolArgsFromFlags(tool: ToolDef, flags: Map<string, string | true>): Args {
  const args: Args = {};
  const json = flags.get("json");
  if (typeof json === "string") {
    try {
      Object.assign(args, JSON.parse(json));
    } catch {
      throw new ToolError("--json must be a JSON object");
    }
  }
  const known = Object.keys((tool.inputSchema.properties as object | undefined) ?? {});
  for (const [flag, value] of flags) {
    if (GLOBAL_FLAGS.has(flag)) continue;
    const dot = flag.indexOf(".");
    if (dot > 0 && propType(tool, flag.slice(0, dot)) === "object") {
      const parent = flag.slice(0, dot);
      const target = (args[parent] ??= {}) as Record<string, unknown>;
      target[flag.slice(dot + 1)] = value === true ? true : value;
      continue;
    }
    if (!known.includes(flag)) {
      throw new ToolError(
        `Unknown parameter --${flag} for ${tool.name}. Parameters: ${known.map((k) => `--${k}`).join(", ") || "(none)"}`,
      );
    }
    args[flag] = convert(tool, flag, value);
  }
  return args;
}
