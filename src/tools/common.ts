import { isHttpStatus, ToolError } from "../errors.js";
import { buildPath, jobPath, type BuildRef } from "../jobPath.js";
import type { ToolContext } from "./types.js";

type Json = Record<string, unknown>;

const FOLDER_CLASS = /(?:Folder|MultiBranchProject|OrganizationFolder|ComputedFolder)$/;

export function isFolderClass(cls: unknown): boolean {
  return typeof cls === "string" && FOLDER_CLASS.test(cls);
}

/** `https://ci/job/a/job/feature%252Fx/` → `a/feature%2Fx`. Null when the URL is not a job URL. */
export function jobNameFromUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url, "http://placeholder").pathname;
  } catch {
    return null;
  }
  const parts = pathname.split("/").filter(Boolean);
  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "job" && parts[i + 1] !== undefined) {
      names.push(decodeURIComponent(parts[i + 1] as string));
      i++;
    }
  }
  return names.length ? names.join("/") : null;
}

/** Turns a ref into a concrete build number, or null when the job or build doesn't exist. */
export async function resolveBuildNumber(
  ctx: ToolContext,
  job: string,
  ref: BuildRef,
): Promise<number | null> {
  if (typeof ref === "number") return ref;
  const data = await ctx.client.jsonOrNull<{ number?: number }>(`${buildPath(job, ref)}/api/json`, {
    tree: "number",
  });
  return typeof data?.number === "number" ? data.number : null;
}

export async function getQueueItemJson(
  ctx: ToolContext,
  id: number,
  tree: string | undefined,
): Promise<Json | null> {
  return ctx.client.jsonOrNull<Json>(`/queue/item/${id}/api/json`, { tree });
}

/** Rejects (as the allowlist requires) a queue item whose job is outside the allowlist. */
export async function assertQueueItemAllowed(ctx: ToolContext, id: number): Promise<boolean> {
  if (!ctx.profile.jobAllowlist) return true;
  const item = await getQueueItemJson(ctx, id, "task[url]");
  if (!item) return false;
  const url = (item.task as Json | undefined)?.url;
  const name = typeof url === "string" ? jobNameFromUrl(url) : null;
  if (!name)
    throw new ToolError(`Queue item ${id} is not a job, so the job allowlist cannot admit it`);
  ctx.assertJobAllowed(name);
  return true;
}

interface ParamDef {
  _class?: string;
  name?: string;
  type?: string;
  choices?: string[];
}

function toFormValue(def: ParamDef, value: unknown, ctx: ToolContext): string | undefined {
  const type = def.type ?? def._class ?? "";
  if (/File/.test(type)) {
    ctx.notes.push(`File parameter '${def.name}' is not supported via MCP; its default was used.`);
    return undefined;
  }
  if (/Boolean/.test(type)) {
    return String(typeof value === "boolean" ? value : String(value).toLowerCase() === "true");
  }
  const text = Array.isArray(value)
    ? value.map(String).join(",")
    : typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : String(value);
  if (/Choice/.test(type) && Array.isArray(def.choices) && !def.choices.includes(text)) {
    ctx.notes.push(
      `'${text}' is not a valid choice for '${def.name}' (valid: ${def.choices.join(", ")}); its default was used.`,
    );
    return undefined;
  }
  return text;
}

/**
 * Schedules a build the way the plugin does: every defined parameter gets the given value or its
 * default, unknown keys are ignored. Returns the queue item, or null when the job can't be built.
 */
export async function scheduleBuild(
  ctx: ToolContext,
  job: string,
  params: Record<string, unknown> | undefined,
  tree: string | undefined,
): Promise<Json | null> {
  const info = await ctx.client.jsonOrNull<Json>(`${jobPath(job)}/api/json`, {
    tree: "buildable,property[parameterDefinitions[name,type,choices]]",
  });
  if (!info || info.buildable !== true) return null;
  const defs = ((info.property as Json[] | undefined) ?? []).flatMap(
    (p) => (p.parameterDefinitions as ParamDef[] | undefined) ?? [],
  );

  let res: Response;
  try {
    if (defs.length) {
      const form = new URLSearchParams();
      for (const def of defs) {
        if (!def.name || !params || !(def.name in params)) continue;
        const value = params[def.name];
        if (value === undefined || value === null) continue;
        const formValue = toFormValue(def, value, ctx);
        if (formValue !== undefined) form.append(def.name, formValue);
      }
      res = await ctx.client.post(`${jobPath(job)}/buildWithParameters`, form, {
        redirect: "manual",
      });
    } else {
      res = await ctx.client.post(`${jobPath(job)}/build`, new URLSearchParams(), {
        redirect: "manual",
      });
    }
  } catch (err) {
    if (isHttpStatus(err, 404)) return null;
    throw err;
  }
  await res.body?.cancel();
  const id = queueIdFromLocation(res.headers.get("location"));
  if (id === null) {
    ctx.notes.push("Jenkins accepted the build but did not return a queue item location.");
    return null;
  }
  return waitForQueueItem(ctx, id, tree);
}

export function queueIdFromLocation(location: string | null): number | null {
  const m = location?.match(/\/queue\/item\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Optional bounded wait (`triggerWaitMs`) for the queue item to turn into a build. */
export async function waitForQueueItem(
  ctx: ToolContext,
  id: number,
  tree: string | undefined,
): Promise<Json> {
  const deadline = Date.now() + ctx.profile.triggerWaitMs;
  while (ctx.profile.triggerWaitMs > 0 && Date.now() < deadline) {
    const probe = await getQueueItemJson(ctx, id, "executable[number],cancelled");
    if (!probe || probe.executable || probe.cancelled) break;
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, deadline - Date.now()))));
  }
  const item = await getQueueItemJson(ctx, id, tree);
  if (item) return item;
  return { id, url: `queue/item/${id}/` };
}
