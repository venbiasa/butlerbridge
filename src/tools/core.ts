import { describeError, isHttpStatus, ToolError } from "../errors.js";
import { couldContainMatch } from "../glob.js";
import { buildPath, jobPath, normalizeBuildRef, parentAndName } from "../jobPath.js";
import {
  assertQueueItemAllowed,
  getQueueItemJson,
  isFolderClass,
  resolveBuildNumber,
  scheduleBuild,
} from "./common.js";
import {
  int,
  JOB_FULL_NAME_DESC,
  JOB_FULL_PATH_DESC,
  obj,
  objectSchema,
  PLUGIN_DEFAULT_ANNOTATIONS,
  READ_ONLY,
  reqStr,
  resolveTree,
  s,
  str,
  type ToolContext,
  type ToolDef,
} from "./types.js";

type Json = Record<string, unknown>;

const BUILD_DEFAULT_TREE = "number,url,result,building,timestamp,duration,displayName,description";
const JOB_DEFAULT_TREE =
  "name,fullName,url,description,buildable,color,inQueue," +
  "lastBuild[number,url,result,building,timestamp]," +
  "lastCompletedBuild[number,url,result],healthReport[score,description]";
const JOBS_DEFAULT_TREE = "name,fullName,url,color,lastBuild[number,result,timestamp]";

const NOT_REPLAYABLE =
  "Not a replayable Pipeline build. Replay is only available for Pipeline jobs (workflow-cps).";

export const getBuild: ToolDef = {
  name: "getBuild",
  description: "Get a specific build or the last build of a Jenkins job",
  kind: "read",
  annotations: READ_ONLY,
  jobArg: "jobFullName",
  inputSchema: objectSchema(
    {
      jobFullName: s.string(JOB_FULL_NAME_DESC),
      buildNumber: s.integer("Build number (optional, if not provided, returns the last build)"),
      tree: s.tree(BUILD_DEFAULT_TREE),
    },
    ["jobFullName"],
  ),
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const ref = normalizeBuildRef(args.buildNumber);
    return ctx.client.jsonOrNull(`${buildPath(job, ref)}/api/json`, {
      tree: resolveTree(args, BUILD_DEFAULT_TREE),
    });
  },
};

export const getJob: ToolDef = {
  name: "getJob",
  description: "Get a Jenkins job by its full path",
  kind: "read",
  annotations: READ_ONLY,
  jobArg: "jobFullName",
  inputSchema: objectSchema(
    { jobFullName: s.string(JOB_FULL_NAME_DESC), tree: s.tree(JOB_DEFAULT_TREE) },
    ["jobFullName"],
  ),
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const tree = resolveTree(args, JOB_DEFAULT_TREE);
    const data = await ctx.client.jsonOrNull<Json>(`${jobPath(job)}/api/json`, { tree });
    if (!data || isFolderClass(data._class)) return null;
    return data;
  },
};

export const getJobs: ToolDef = {
  name: "getJobs",
  description:
    "Get a paginated list of Jenkins jobs, sorted by name. Returns up to 'limit' jobs starting from the 'skip' index. If no jobs are available in the requested range, returns an empty list.",
  kind: "read",
  annotations: READ_ONLY,
  inputSchema: objectSchema({
    parentFullName: s.string(
      "The full path of the Jenkins folder (e.g., 'folder'), if not specified, it returns the items under root",
    ),
    skip: s.integer("The 0 based started index, if not specified, then start from the first (0)"),
    limit: s.integer(
      "The maximum number of items to return. If not specified, returns 10 items. Cannot exceed 10 items.",
    ),
    tree: s.tree(JOBS_DEFAULT_TREE),
  }),
  async handler(args, ctx) {
    const parent = str(args, "parentFullName")?.trim() || null;
    let skip = int(args, "skip") ?? 0;
    if (skip < 0) skip = 0;
    let limit = int(args, "limit") ?? 10;
    if (limit < 0 || limit > 10) limit = 10;
    const allow = ctx.profile.jobAllowlist;
    if (parent && allow && !ctx.isJobAllowed(parent) && !couldContainMatch(parent, allow)) {
      ctx.assertJobAllowed(parent);
    }
    const itemTree = resolveTree(args, JOBS_DEFAULT_TREE);
    const fields = itemTree ? `name,fullName,${itemTree}` : "*";
    const base = parent ? jobPath(parent) : "";
    const data = await ctx.client.jsonOrNull<{ jobs?: Json[] }>(`${base}/api/json`, {
      tree: `jobs[${fields}]`,
    });
    let jobs = data?.jobs ?? [];
    if (allow) {
      jobs = jobs.filter((j) => {
        const name = String(j.fullName ?? (parent ? `${parent}/${j.name}` : j.name));
        return ctx.isJobAllowed(name) || couldContainMatch(name, allow);
      });
    }
    jobs.sort((a, b) => compareJava(String(a.name ?? ""), String(b.name ?? "")));
    const page = jobs.slice(skip, skip + limit);
    if (itemTree && !hasTopLevelField(itemTree, "name")) page.forEach((j) => delete j.name);
    if (itemTree && !hasTopLevelField(itemTree, "fullName")) page.forEach((j) => delete j.fullName);
    return page;
  },
};

/** Java `String.compareTo`: UTF-16 code unit order, which is what the plugin sorts by. */
function compareJava(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hasTopLevelField(tree: string, field: string): boolean {
  let depth = 0;
  let token = "";
  for (const c of `${tree},`) {
    if (c === "[") depth++;
    if (c === "]") depth--;
    if (depth === 0 && (c === "," || c === "[")) {
      if (token.trim() === field || token.trim() === "*") return true;
      token = "";
    } else if (depth === 0) {
      token += c;
    }
  }
  return false;
}

export const triggerBuild: ToolDef = {
  name: "triggerBuild",
  description: "Trigger a build for a Jenkins job",
  kind: "write",
  annotations: PLUGIN_DEFAULT_ANNOTATIONS,
  jobArg: "jobFullName",
  inputSchema: objectSchema(
    {
      jobFullName: s.string(JOB_FULL_PATH_DESC),
      parameters: {
        type: "object",
        description: "Build parameters (optional, e.g., {key1=value1,key2=value2})",
        additionalProperties: { type: ["string", "boolean", "integer", "number", "array"] },
      },
      tree: s.tree(),
      description: s.string(
        "butlerbridge extension: once the build starts, set its description to 'triggered via butlerbridge: <text>' (needs allowWrite in the profile)",
      ),
    },
    ["jobFullName"],
  ),
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const scheduled = await scheduleBuild(ctx, job, obj(args, "parameters"), resolveTree(args));
    const description = str(args, "description")?.trim();
    if (scheduled && description)
      await describeTriggeredBuild(ctx, job, scheduled.build, description);
    return scheduled?.item ?? null;
  },
};

/** Labels a build started by a tool. Never fails the trigger. */
async function describeTriggeredBuild(
  ctx: ToolContext,
  job: string,
  build: number | null,
  text: string,
): Promise<void> {
  if (!ctx.profile.allowWrite) {
    ctx.notes.push("Description not set: allowWrite is false for this profile.");
    return;
  }
  if (build === null) {
    ctx.notes.push("Description not set: the build had not started within triggerWaitMs.");
    return;
  }
  try {
    await ctx.client.post(
      `${buildPath(job, build)}/submitDescription`,
      new URLSearchParams({ description: `triggered via butlerbridge: ${text}` }),
      { redirect: "manual" },
    );
    ctx.notes.push("Build description set.");
  } catch (err) {
    ctx.notes.push(
      `Could not set the build description (${describeError(err)}); the build was still triggered.`,
    );
  }
}

export const updateBuild: ToolDef = {
  name: "updateBuild",
  description: "Update build display name and/or description",
  kind: "write",
  annotations: PLUGIN_DEFAULT_ANNOTATIONS,
  jobArg: "jobFullName",
  inputSchema: objectSchema(
    {
      jobFullName: s.string(JOB_FULL_PATH_DESC),
      buildNumber: s.integer("Build number (optional, if not provided, updates the last build)"),
      displayName: s.string("New display name for the build"),
      description: s.string("New description for the build"),
    },
    ["jobFullName"],
  ),
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const displayName = str(args, "displayName") || undefined;
    const description = str(args, "description") || undefined;
    const ref = normalizeBuildRef(args.buildNumber);
    const current = await ctx.client.jsonOrNull<Json>(`${buildPath(job, ref)}/api/json`, {
      tree: "number,displayName,description",
    });
    if (!current || typeof current.number !== "number") return false;
    if (!displayName && !description) return false;
    const path = buildPath(job, current.number);
    if (displayName) {
      const form = new URLSearchParams({
        json: JSON.stringify({
          displayName,
          description: description ?? (current.description as string | null) ?? "",
        }),
      });
      await ctx.client.post(`${path}/configSubmit`, form, { redirect: "manual" });
    } else {
      await ctx.client.post(
        `${path}/submitDescription`,
        new URLSearchParams({ description: description! }),
        {
          redirect: "manual",
        },
      );
    }
    return true;
  },
};

export const cancelBuild: ToolDef = {
  name: "cancelBuild",
  description:
    "Cancel a running build (give jobFullName and buildNumber) or an entry in the Jenkins queue " +
    "(give queueId only). Returns one of: " +
    "STOP_REQUESTED (the build was asked to stop, Jenkins may take some time to actually stop it, " +
    "e.g. while a Pipeline runs its cleanup, so use getBuild to check whether it is still building " +
    "and call this tool again if needed), CANCELLED (the queue item was removed), " +
    "NOT_RUNNING (the build has already finished), NOT_FOUND (no such job, build or queue item), " +
    "NO_PERMISSION (you are not allowed to cancel it), NOT_SUPPORTED (this kind of build cannot be stopped).",
  kind: "write",
  annotations: PLUGIN_DEFAULT_ANNOTATIONS,
  jobArg: "jobFullName",
  inputSchema: objectSchema({
    jobFullName: s.string(JOB_FULL_NAME_DESC),
    buildNumber: s.integer("Build number of the build to stop"),
    queueId: s.integer("Id of the queue item to cancel"),
  }),
  async handler(args, ctx) {
    const job = str(args, "jobFullName");
    const hasJob = Boolean(job);
    const buildNumber = int(args, "buildNumber");
    const queueId = int(args, "queueId");
    if (queueId !== undefined) {
      if (hasJob || buildNumber !== undefined) {
        throw new ToolError("Give either queueId, or jobFullName and buildNumber, not both");
      }
      if (!(await getQueueItemJson(ctx, queueId, "id"))) return "NOT_FOUND";
      await assertQueueItemAllowed(ctx, queueId);
      try {
        await ctx.client.post("/queue/cancelItem", new URLSearchParams({ id: String(queueId) }), {
          redirect: "manual",
        });
      } catch (err) {
        if (isHttpStatus(err, 404)) return "NOT_FOUND";
        if (isHttpStatus(err, 403)) return "NO_PERMISSION";
        throw err;
      }
      return "CANCELLED";
    }
    if (!hasJob || buildNumber === undefined) {
      throw new ToolError("Give either queueId, or jobFullName and buildNumber");
    }
    const path = buildPath(job!, buildNumber);
    const build = await ctx.client.jsonOrNull<Json>(`${path}/api/json`, { tree: "building" });
    if (!build) return "NOT_FOUND";
    if (build.building !== true) return "NOT_RUNNING";
    try {
      await ctx.client.post(`${path}/stop`, new URLSearchParams(), { redirect: "manual" });
    } catch (err) {
      if (isHttpStatus(err, 403)) return "NO_PERMISSION";
      if (isHttpStatus(err, 404)) return "NOT_FOUND";
      throw err;
    }
    return "STOP_REQUESTED";
  },
};

export const whoAmI: ToolDef = {
  name: "whoAmI",
  description:
    "Get information about the currently authenticated user/principal, including their full name or 'anonymous' if not authenticated",
  kind: "read",
  annotations: READ_ONLY,
  structured: true,
  inputSchema: objectSchema({}),
  outputSchema: {
    type: "object",
    properties: { fullName: { type: "string" } },
  },
  async handler(_args, ctx) {
    const me = await ctx.client.json<{ name?: string; anonymous?: boolean }>("/whoAmI/api/json");
    const name = me.name ?? "anonymous";
    if (me.anonymous || name === "anonymous") return { fullName: "anonymous" };
    const user = await ctx.client
      .jsonOrNull<{ fullName?: string }>(`/user/${encodeURIComponent(name)}/api/json`, {
        tree: "fullName",
      })
      .catch(() => null);
    return { fullName: user?.fullName ?? name };
  },
};

export const getStatus: ToolDef = {
  name: "getStatus",
  description:
    "Checks the health and readiness status of a Jenkins instance, including whether it's in quiet" +
    " mode, has active administrative monitors, current queue size, root URL Status, and available executor capacity." +
    " This tool provides a comprehensive overview of the controller's operational state to determine if" +
    " it's stable and ready to build. Use this tool to assess Jenkins instance health rather than" +
    " simple up/down status.",
  kind: "read",
  annotations: READ_ONLY,
  inputSchema: objectSchema({}),
  async handler(_args, ctx) {
    const [root, queue, computers] = await Promise.all([
      ctx.client.json<Json>("/api/json", { tree: "quietingDown,quietDownReason,url" }),
      ctx.client.json<{ items?: Json[] }>("/queue/api/json", { tree: "items[buildable]" }),
      ctx.client.json<{ computer?: Json[] }>("/computer/api/json", {
        tree: "computer[offline,numExecutors]",
      }),
    ]);
    const items = queue.items ?? [];
    const quiet = root.quietingDown === true;
    const status: Json = { "Quiet Mode": quiet };
    if (quiet) status["Quiet Mode reason"] = root.quietDownReason ?? "Unknown";
    status["Full Queue Size"] = items.length;
    status["Buildable Queue Size"] = items.filter((i) => i.buildable === true).length;
    status["Available executors (any label)"] = (computers.computer ?? [])
      .filter((c) => c.offline !== true)
      .reduce((sum, c) => sum + (typeof c.numExecutors === "number" ? c.numExecutors : 0), 0);
    status["Active administrative monitors"] = "Not available through the REST API";
    status["Root URL Status"] =
      typeof root.url === "string" && root.url
        ? "OK"
        : 'ERROR: Jenkins root URL is not configured. Please configure the Jenkins URL under "Manage Jenkins → Configure System → Jenkins Location" so tools like getJobs can work properly.\n ';
    return status;
  },
};

export const getQueueItem: ToolDef = {
  name: "getQueueItem",
  description:
    "Get the queue item details by its ID. The caller can check the queue item's status, build details, and other relevant information.",
  kind: "read",
  annotations: READ_ONLY,
  inputSchema: objectSchema({ id: s.integer("The queue item id"), tree: s.tree() }, ["id"]),
  async handler(args, ctx) {
    const id = int(args, "id");
    if (id === undefined) throw new ToolError("Missing required parameter 'id'");
    if (!(await assertQueueItemAllowed(ctx, id))) return null;
    return getQueueItemJson(ctx, id, resolveTree(args));
  },
};

export const rebuildBuild: ToolDef = {
  name: "rebuildBuild",
  description:
    "Rebuild a Jenkins build: re-run it with the same parameters and the same trigger causes (for example a GitLab or GitHub webhook), like the Rebuild button. To re-run the original Pipeline script, use getReplayScripts and replayBuild. Returns the queue item for the new build.",
  kind: "write",
  annotations: PLUGIN_DEFAULT_ANNOTATIONS,
  jobArg: "jobFullName",
  inputSchema: objectSchema(
    {
      jobFullName: s.string(JOB_FULL_PATH_DESC),
      buildNumber: s.integer("Build number (optional, if not provided, rebuilds the last build)"),
      tree: s.tree(),
    },
    ["jobFullName"],
  ),
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const ref = normalizeBuildRef(args.buildNumber);
    const build = await ctx.client.jsonOrNull<{ actions?: Json[] }>(
      `${buildPath(job, ref)}/api/json`,
      { tree: "number,actions[parameters[name,value]]" },
    );
    if (!build) return null;
    const params: Record<string, unknown> = {};
    for (const action of build.actions ?? []) {
      for (const p of (action?.parameters as Json[] | undefined) ?? []) {
        const v = p.value;
        if (typeof p.name !== "string") continue;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
          params[p.name] = v;
      }
    }
    ctx.notes.push(
      "Re-run with the original parameter values; trigger causes cannot be copied through the REST API.",
    );
    return (await scheduleBuild(ctx, job, params, resolveTree(args)))?.item ?? null;
  },
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Reads the replay form's textareas: `_.mainScript` and one `_.<name>` per loaded script. */
export function parseReplayPage(html: string): {
  mainScript: string;
  loadedScripts: Record<string, string>;
} {
  let mainScript = "";
  const loadedScripts: Record<string, string> = {};
  const re = /<textarea\b[^>]*\bname="(?:_\.)?([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/gi;
  for (const m of html.matchAll(re)) {
    const name = m[1] as string;
    const body = decodeHtml((m[2] as string).replace(/^\r?\n/, ""));
    if (name === "mainScript") mainScript = body;
    else loadedScripts[name] = body;
  }
  return { mainScript, loadedScripts };
}

export const getReplayScripts: ToolDef = {
  name: "getReplayScripts",
  description:
    "Get the pipeline script(s) of a build for replay. Returns the main script and loaded scripts. Only available for Pipeline (replayable) builds.",
  kind: "read",
  annotations: READ_ONLY,
  structured: true,
  jobArg: "jobFullName",
  inputSchema: objectSchema(
    {
      jobFullName: s.string(JOB_FULL_PATH_DESC),
      buildNumber: s.integer("Build number (optional, if not provided, uses the last build)"),
    },
    ["jobFullName"],
  ),
  outputSchema: {
    type: "object",
    properties: {
      mainScript: { type: "string" },
      loadedScripts: { type: "object", additionalProperties: { type: "string" } },
    },
  },
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const number = await resolveBuildNumber(ctx, job, normalizeBuildRef(args.buildNumber));
    if (number === null) throw new ToolError(`Build not found for job ${job}`);
    let html: string;
    try {
      html = await ctx.client.text(`${buildPath(job, number)}/replay/`);
    } catch (err) {
      if (isHttpStatus(err, 404)) throw new ToolError(NOT_REPLAYABLE);
      if (isHttpStatus(err, 403)) return { mainScript: "", loadedScripts: {} };
      throw err;
    }
    return parseReplayPage(html);
  },
};

export const replayBuild: ToolDef = {
  name: "replayBuild",
  description:
    "Replay a Pipeline build with optionally modified script(s). Runs the job again with the given main script and optional loaded scripts. Only available for Pipeline jobs.",
  kind: "write",
  annotations: PLUGIN_DEFAULT_ANNOTATIONS,
  jobArg: "jobFullName",
  inputSchema: objectSchema(
    {
      jobFullName: s.string(JOB_FULL_PATH_DESC),
      buildNumber: s.integer("Build number (optional, if not provided, uses the last build)"),
      mainScript: s.string("Main pipeline script content"),
      loadedScripts: {
        type: "object",
        description:
          "Loaded scripts map (optional): script name to content. If not provided, original loaded scripts are used.",
        additionalProperties: { type: "string" },
      },
      tree: s.tree(),
    },
    ["jobFullName", "mainScript"],
  ),
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const mainScript = reqStr(args, "mainScript");
    const loaded = obj(args, "loadedScripts") ?? {};
    const number = await resolveBuildNumber(ctx, job, normalizeBuildRef(args.buildNumber));
    if (number === null) return null;
    const form: Record<string, string> = { mainScript };
    for (const [name, script] of Object.entries(loaded)) {
      if (typeof script !== "string")
        throw new ToolError(`loadedScripts['${name}'] must be a string`);
      form[name.replace(/\./g, "_")] = script;
    }
    try {
      await ctx.client.post(
        `${buildPath(job, number)}/replay/run`,
        new URLSearchParams({ json: JSON.stringify(form) }),
        { redirect: "manual" },
      );
    } catch (err) {
      if (isHttpStatus(err, 404)) throw new ToolError(NOT_REPLAYABLE);
      if (isHttpStatus(err, 403)) {
        throw new ToolError("Replay not allowed for this build (permission or script approval).");
      }
      throw err;
    }
    const jobInfo = await ctx.client.jsonOrNull<{ queueItem?: Json | null }>(
      `${jobPath(job)}/api/json`,
      {
        tree: "queueItem[id]",
      },
    );
    const id = jobInfo?.queueItem?.id;
    if (typeof id !== "number") {
      ctx.notes.push(
        "The replay was scheduled, but it already left the queue; use getBuild to find it.",
      );
      return null;
    }
    return getQueueItemJson(ctx, id, resolveTree(args));
  },
};

export const createPipeline: ToolDef = {
  name: "createPipeline",
  description: "Create a new Jenkins pipeline job with the provided script",
  kind: "write",
  annotations: { readOnlyHint: false, destructiveHint: true },
  jobArg: "jobName",
  inputSchema: objectSchema(
    {
      jobName: s.string("Name (or full path) of the pipeline to create"),
      pipelineScript: s.string("The Jenkins Declarative or Scripted Pipeline script"),
    },
    ["jobName", "pipelineScript"],
  ),
  async handler(args, ctx) {
    const jobName = reqStr(args, "jobName");
    const script = reqStr(args, "pipelineScript");
    const { parent, name } = parentAndName(jobName);
    if (parent) {
      const p = await ctx.client.jsonOrNull<Json>(`${jobPath(parent)}/api/json`, {
        tree: "_class",
      });
      if (!p || !isFolderClass(p._class)) {
        throw new ToolError(`Parent folder '${parent}' does not exist or cannot contain jobs.`);
      }
    }
    if (await ctx.client.jsonOrNull(`${jobPath(jobName)}/api/json`, { tree: "name" })) {
      throw new ToolError(`A job with name '${jobName}' already exists.`);
    }
    try {
      await ctx.client.post(
        `${parent ? jobPath(parent) : ""}/createItem?name=${encodeURIComponent(name)}`,
        pipelineConfigXml(script),
        { contentType: "application/xml; charset=utf-8", redirect: "manual" },
      );
    } catch (err) {
      if (isHttpStatus(err, 500, 400)) {
        throw new ToolError(
          `createPipeline is not available on this server or the job could not be created: ${(err as Error).message}. ` +
            "It needs the workflow-job and workflow-cps plugins.",
        );
      }
      throw err;
    }
    return `${ctx.client.baseUrl}${jobPath(jobName)}/`;
  },
};

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function pipelineConfigXml(script: string): string {
  return [
    "<?xml version='1.1' encoding='UTF-8'?>",
    "<flow-definition>",
    '  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition">',
    `    <script>${xmlEscape(script)}</script>`,
    "    <sandbox>true</sandbox>",
    "  </definition>",
    "</flow-definition>",
    "",
  ].join("\n");
}

export const coreTools = [
  cancelBuild,
  getBuild,
  getJob,
  triggerBuild,
  getJobs,
  updateBuild,
  whoAmI,
  getStatus,
  getQueueItem,
  rebuildBuild,
  getReplayScripts,
  replayBuild,
  createPipeline,
];
