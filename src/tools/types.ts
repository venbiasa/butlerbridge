import type { ResolvedProfile } from "../config.js";
import { ToolError } from "../errors.js";
import type { JenkinsClient } from "../http.js";

export type JsonSchema = Record<string, unknown>;

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolContext {
  client: JenkinsClient;
  profile: ResolvedProfile;
  /** Sentences appended to the result message, e.g. what a cap cut off. */
  notes: string[];
  isJobAllowed(fullName: string): boolean;
  assertJobAllowed(fullName: string): void;
}

export type Args = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  /** `write` tools other than triggerBuild need `allowWrite`. */
  kind: "read" | "write";
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  /** Mirror the result into `structuredContent`, as the plugin does for these tools. */
  structured?: boolean;
  /** Argument that names a job; checked against the allowlist before any request. */
  jobArg?: string;
  handler(args: Args, ctx: ToolContext): Promise<unknown>;
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };
/** The plugin's `@Tool.Annotations` defaults, used where it sets no annotations. */
export const PLUGIN_DEFAULT_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export const JOB_FULL_NAME_DESC = "Job full name of the Jenkins job (e.g., 'folder/job-name')";
export const JOB_FULL_PATH_DESC = "Full path of the Jenkins job (e.g., 'folder/job-name')";

const TREE_DESC =
  "Field selection expression using the Jenkins Remote REST API tree syntax.\n" +
  "Allows limiting returned fields and nested objects (for example executable[number,url]) to reduce response size, especially for polling workflows.";

export const s = {
  string: (description?: string): JsonSchema => ({
    type: "string",
    ...(description && { description }),
  }),
  integer: (description?: string): JsonSchema => ({
    type: "integer",
    ...(description && { description }),
  }),
  boolean: (description?: string): JsonSchema => ({
    type: "boolean",
    ...(description && { description }),
  }),
  tree(defaultTree?: string): JsonSchema {
    const description = defaultTree
      ? `${TREE_DESC}\nIf omitted, a compact default is used: ${defaultTree}\nPass "*" to get the full object with all fields.`
      : TREE_DESC;
    return { type: "string", description };
  },
};

export function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    required,
  };
}

export function str(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolError(`Parameter '${key}' must be a string`);
  return v;
}

export function reqStr(args: Args, key: string): string {
  const v = str(args, key);
  if (v === undefined) throw new ToolError(`Missing required parameter '${key}'`);
  return v;
}

export function int(args: Args, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new ToolError(`Parameter '${key}' must be an integer`);
  }
  return n;
}

export function bool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new ToolError(`Parameter '${key}' must be a boolean`);
}

export function obj(args: Args, key: string): Record<string, unknown> | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v))
    throw new ToolError(`Parameter '${key}' must be an object`);
  return v as Record<string, unknown>;
}

/** Plugin rule: the caller's tree, else the tool default; `*` means the full object. */
export function resolveTree(args: Args, defaultTree?: string): string | undefined {
  const tree = str(args, "tree")?.trim();
  if (!tree) return defaultTree;
  if (tree === "*") return undefined;
  return tree;
}
