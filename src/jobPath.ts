import { ToolError } from "./errors.js";

export const PERMALINKS = [
  "lastBuild",
  "lastSuccessfulBuild",
  "lastFailedBuild",
  "lastCompletedBuild",
] as const;
export type Permalink = (typeof PERMALINKS)[number];
export type BuildRef = number | Permalink;

/** Splits a Jenkins full name (`folder/job`) into item names. Segments stay as Jenkins names them. */
export function jobSegments(fullName: string): string[] {
  const trimmed = fullName.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "") throw new ToolError("jobFullName must not be empty");
  const segments = trimmed.split("/");
  if (segments.some((s) => s === "")) {
    throw new ToolError(`Invalid job name '${fullName}': empty path segment`);
  }
  return segments;
}

/**
 * `folder/multibranch/feature%2Fx` → `/job/folder/job/multibranch/job/feature%252Fx`.
 * Each item name is percent-encoded as one segment, so a `%2F` already inside a multibranch
 * branch name survives as part of that name instead of becoming a path separator.
 */
export function jobPath(fullName: string): string {
  return jobSegments(fullName)
    .map((s) => `/job/${encodeURIComponent(s)}`)
    .join("");
}

export function parentAndName(fullName: string): { parent: string | null; name: string } {
  const segments = jobSegments(fullName);
  const name = segments.pop() as string;
  return { parent: segments.length ? segments.join("/") : null, name };
}

/** Plugin semantics: absent or `<= 0` means the last build. Permalink names are an extension. */
export function normalizeBuildRef(value: unknown): BuildRef {
  if (value === undefined || value === null || value === "") return "lastBuild";
  if (typeof value === "string") {
    if ((PERMALINKS as readonly string[]).includes(value)) return value as Permalink;
    if (/^-?\d+$/.test(value.trim())) return normalizeBuildRef(Number(value));
    throw new ToolError(
      `Invalid buildNumber '${value}': use a number or one of ${PERMALINKS.join(", ")}`,
    );
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return value <= 0 ? "lastBuild" : value;
  }
  throw new ToolError(`Invalid buildNumber: ${JSON.stringify(value)}`);
}

export function buildPath(fullName: string, ref: BuildRef): string {
  return `${jobPath(fullName)}/${typeof ref === "number" ? String(ref) : ref}`;
}
