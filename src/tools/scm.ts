import { isHttpStatus, ToolError } from "../errors.js";
import { buildPath, jobPath, normalizeBuildRef } from "../jobPath.js";
import { decodeHtml } from "./core.js";
import { isFolderClass } from "./common.js";
import {
  int,
  JOB_FULL_PATH_DESC,
  objectSchema,
  READ_ONLY,
  reqStr,
  s,
  str,
  type ToolContext,
  type ToolDef,
} from "./types.js";

type Json = Record<string, unknown>;

export interface GitScmConfig {
  uris: string[];
  branches: string[];
  commit: string | null;
  name: "Git";
}

interface GitScmBlock {
  remotes: { url: string; name: string }[];
  branches: string[];
}

const GIT_SCM_CLASS = "hudson.plugins.git.GitSCM";
const BUILD_DATA_CLASS = "hudson.plugins.git.util.BuildData";
const BUILD_DATA_TREE = "actions[_class,remoteUrls,lastBuiltRevision[SHA1,branch[name]]]";
export const FIND_JOBS_SCAN_LIMIT = 500;
const SCAN_CONCURRENCY = 6;

function tagValues(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => decodeHtml((m[1] as string).trim()));
}

/** Pulls every `<scm class="hudson.plugins.git.GitSCM">` block out of a job's config.xml. */
export function parseGitScms(configXml: string): GitScmBlock[] {
  const blocks: GitScmBlock[] = [];
  const re = new RegExp(
    `<scm\\b[^>]*class="${GIT_SCM_CLASS.replace(/\./g, "\\.")}"[^>]*>([\\s\\S]*?)</scm>`,
    "g",
  );
  for (const m of configXml.matchAll(re)) {
    const body = m[1] as string;
    const remotes = [
      ...body.matchAll(
        /<hudson\.plugins\.git\.UserRemoteConfig>([\s\S]*?)<\/hudson\.plugins\.git\.UserRemoteConfig>/g,
      ),
    ].map((r) => {
      const remote = r[1] as string;
      return {
        url: tagValues(remote, "url")[0] ?? "",
        name: tagValues(remote, "name")[0] || "origin",
      };
    });
    const branches = [
      ...body.matchAll(
        /<hudson\.plugins\.git\.BranchSpec>([\s\S]*?)<\/hudson\.plugins\.git\.BranchSpec>/g,
      ),
    ].flatMap((b) => tagValues(b[1] as string, "name"));
    blocks.push({ remotes: remotes.filter((r) => r.url), branches });
  }
  return blocks;
}

function buildDataToConfig(action: Json): GitScmConfig {
  const revision = action.lastBuiltRevision as Json | undefined;
  const branches = ((revision?.branch as Json[] | undefined) ?? [])
    .map((b) => b.name)
    .filter((n): n is string => typeof n === "string");
  return {
    uris: ((action.remoteUrls as unknown[] | undefined) ?? []).map(String),
    branches,
    commit: typeof revision?.SHA1 === "string" ? revision.SHA1 : null,
    name: "Git",
  };
}

async function lastBuildGitData(ctx: ToolContext, path: string): Promise<GitScmConfig | null> {
  const build = await ctx.client.jsonOrNull<{ actions?: Json[] }>(`${path}/api/json`, {
    tree: BUILD_DATA_TREE,
  });
  const action = (build?.actions ?? []).find((a) => a?._class === BUILD_DATA_CLASS);
  return action ? buildDataToConfig(action) : null;
}

async function readConfigXml(ctx: ToolContext, job: string): Promise<string | null> {
  try {
    return await ctx.client.text(`${jobPath(job)}/config.xml`);
  } catch (err) {
    if (isHttpStatus(err, 403, 404)) return null;
    throw err;
  }
}

export const getJobScm: ToolDef = {
  name: "getJobScm",
  description: "Retrieves scm configurations of a Jenkins job",
  kind: "read",
  annotations: READ_ONLY,
  jobArg: "jobFullName",
  inputSchema: objectSchema({ jobFullName: s.string(JOB_FULL_PATH_DESC) }, ["jobFullName"]),
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const xml = await readConfigXml(ctx, job);
    if (xml === null) return [];
    const scms = parseGitScms(xml);
    if (scms.length) {
      return scms.map((b): GitScmConfig => ({
        uris: b.remotes.map((r) => r.url),
        branches: b.branches,
        commit: null,
        name: "Git",
      }));
    }
    if (!/<flow-definition\b/.test(xml)) return [];
    const fromBuild = await lastBuildGitData(ctx, `${jobPath(job)}/lastBuild`);
    return fromBuild ? [{ ...fromBuild, commit: null }] : [];
  },
};

export const getBuildScm: ToolDef = {
  name: "getBuildScm",
  description: "Retrieves scm configurations of a Jenkins build",
  kind: "read",
  annotations: READ_ONLY,
  jobArg: "jobFullName",
  inputSchema: objectSchema(
    {
      jobFullName: s.string(JOB_FULL_PATH_DESC),
      buildNumber: s.integer("Build number (optional, if not provided, updates the last build)"),
    },
    ["jobFullName"],
  ),
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const config = await lastBuildGitData(ctx, buildPath(job, normalizeBuildRef(args.buildNumber)));
    return config ? [config] : [];
  },
};

export const getBuildChangeSets: ToolDef = {
  name: "getBuildChangeSets",
  description: "Retrieves change log sets of a Jenkins build",
  kind: "read",
  annotations: READ_ONLY,
  jobArg: "jobFullName",
  inputSchema: objectSchema(
    {
      jobFullName: s.string(JOB_FULL_PATH_DESC),
      buildNumber: s.integer("Build number (optional, if not provided, updates the last build)"),
    },
    ["jobFullName"],
  ),
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const items = "items[*,author[fullName,absoluteUrl],paths[*]]";
    const build = await ctx.client.jsonOrNull<{ changeSets?: Json[]; changeSet?: Json }>(
      `${buildPath(job, normalizeBuildRef(args.buildNumber))}/api/json`,
      { tree: `changeSets[_class,kind,${items}],changeSet[_class,kind,${items}]` },
    );
    if (!build) return [];
    if (Array.isArray(build.changeSets)) return build.changeSets;
    return build.changeSet ? [build.changeSet] : [];
  },
};

interface UriParts {
  host: string | null;
  path: string;
}

/** Enough of JGit's URIish to compare host and path: scheme URLs, scp-like `user@host:path`, local paths. */
export function parseGitUri(uri: string): UriParts {
  const text = uri.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?(\/.*)?$/i.exec(text);
  if (scheme) return { host: (scheme[1] as string).toLowerCase(), path: scheme[2] ?? "" };
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.*)$/.exec(text);
  if (scp && !/^[a-z]$/i.test(scp[1] as string)) {
    return { host: (scp[1] as string).toLowerCase(), path: scp[2] as string };
  }
  return { host: null, path: text };
}

function normalizeGitPath(path: string): string {
  let p = path;
  if (p.startsWith("/")) p = p.slice(1);
  if (p.endsWith("/")) p = p.slice(0, -1);
  if (p.endsWith(".git")) p = p.slice(0, -4);
  return p;
}

/** GitStatus.looselyMatches: same host and same path once a leading `/` and trailing `.git` are dropped. */
export function looselyMatches(a: string, b: string): boolean {
  const l = parseGitUri(a);
  const r = parseGitUri(b);
  return l.host === r.host && normalizeGitPath(l.path) === normalizeGitPath(r.path);
}

function branchGlob(spec: string): RegExp {
  let out = "";
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i] as string;
    if (c === "*" && spec[i + 1] === "*") {
      out += ".*";
      i++;
    } else if (c === "*") {
      out += "[^/]*";
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** Approximates BranchSpec.matchesRepositoryBranch for the common spec forms. */
export function branchSpecMatches(spec: string, repoName: string, branch: string): boolean {
  if (spec.includes("$")) return true;
  const b = branch.replace(/^refs\/heads\//, "");
  if (spec.startsWith(":")) {
    try {
      const re = new RegExp(`^(?:${spec.slice(1)})$`);
      return re.test(b) || re.test(`${repoName}/${b}`);
    } catch {
      return false;
    }
  }
  let pattern = spec.replace(/^refs\/heads\//, "");
  if (!pattern.includes("/") && !pattern.includes("*")) pattern = `*/${pattern}`;
  const re = branchGlob(pattern);
  return re.test(b) || re.test(`${repoName}/${b}`) || re.test(`refs/heads/${b}`);
}

interface SimpleJob {
  name: string;
  displayName: string;
  fullDisplayName: string;
  fullName: string;
  url: string;
  lastResult: string;
}

const JOB_FIELDS = "_class,name,displayName,fullDisplayName,fullName,url,lastBuild[result]";

function nestedJobsTree(depth: number): string {
  return depth === 0 ? `jobs[${JOB_FIELDS}]` : `jobs[${JOB_FIELDS},${nestedJobsTree(depth - 1)}]`;
}

function flattenJobs(items: Json[], out: Json[]): void {
  for (const item of items) {
    if (Array.isArray(item.jobs)) flattenJobs(item.jobs as Json[], out);
    if (!isFolderClass(item._class)) out.push(item);
  }
}

async function jobMatches(
  ctx: ToolContext,
  job: Json,
  scmUrl: string,
  branch: string | undefined,
): Promise<boolean> {
  const fullName = String(job.fullName);
  const xml = await readConfigXml(ctx, fullName);
  let scms = xml ? parseGitScms(xml) : [];
  if (!scms.length && xml && /<flow-definition\b/.test(xml)) {
    const data = await lastBuildGitData(ctx, `${jobPath(fullName)}/lastBuild`);
    if (data) {
      scms = [
        { remotes: data.uris.map((url) => ({ url, name: "origin" })), branches: data.branches },
      ];
    }
  }
  return scms.some((scm) =>
    scm.remotes.some(
      (remote) =>
        looselyMatches(scmUrl, remote.url) &&
        (!branch || scm.branches.some((spec) => branchSpecMatches(spec, remote.name, branch))),
    ),
  );
}

export const findJobsWithScmUrl: ToolDef = {
  name: "findJobsWithScmUrl",
  description: "Get a paginated list of Jenkins jobs that use the specified git SCM URL",
  kind: "read",
  annotations: READ_ONLY,
  inputSchema: objectSchema(
    {
      scmUrl: s.string(
        "SCM URL to search for (e.g., 'git@github.com:jenkinsci/mcp-server-plugin.git')",
      ),
      branch: s.string("SCM Branch (e.g., 'feature/my-feature')"),
      skip: s.integer("The 0 based started index, if not specified, then start from the first (0)"),
      limit: s.integer(
        "The maximum number of items to return. If not specified, returns 10 items. Cannot exceed 10 items.",
      ),
    },
    ["scmUrl"],
  ),
  async handler(args, ctx) {
    const scmUrl = reqStr(args, "scmUrl");
    if (!scmUrl.trim()) throw new ToolError("scmUrl must not be empty");
    const branch = str(args, "branch") || undefined;
    let skip = int(args, "skip") ?? 0;
    if (skip < 0) skip = 0;
    let limit = int(args, "limit") ?? 10;
    if (limit < 0 || limit > 10) limit = 10;

    const root = await ctx.client.json<{ jobs?: Json[] }>("/api/json", { tree: nestedJobsTree(5) });
    const all: Json[] = [];
    flattenJobs(root.jobs ?? [], all);
    const candidates = all.filter((j) => ctx.isJobAllowed(String(j.fullName)));
    const scanned = candidates.slice(0, FIND_JOBS_SCAN_LIMIT);
    if (candidates.length > scanned.length) {
      ctx.notes.push(
        `Only the first ${FIND_JOBS_SCAN_LIMIT} of ${candidates.length} jobs were checked; results may be incomplete.`,
      );
    }

    const wanted = skip + limit;
    const matched: Json[] = [];
    for (let i = 0; i < scanned.length && matched.length < wanted; i += SCAN_CONCURRENCY) {
      const batch = scanned.slice(i, i + SCAN_CONCURRENCY);
      const results = await Promise.all(batch.map((j) => jobMatches(ctx, j, scmUrl, branch)));
      batch.forEach((j, k) => results[k] && matched.push(j));
    }
    return matched.slice(skip, wanted).map((j): SimpleJob => ({
      name: String(j.name ?? ""),
      displayName: String(j.displayName ?? j.name ?? ""),
      fullDisplayName: String(j.fullDisplayName ?? j.fullName ?? ""),
      fullName: String(j.fullName ?? ""),
      url: j.fullName ? `${jobPath(String(j.fullName)).slice(1)}/` : String(j.url ?? ""),
      lastResult: String((j.lastBuild as Json | null | undefined)?.result ?? "NOT_BUILT"),
    }));
  },
};

export const scmTools = [getJobScm, getBuildScm, getBuildChangeSets, findJobsWithScmUrl];
