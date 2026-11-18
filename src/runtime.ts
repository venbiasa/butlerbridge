import { BasicAuth, type AuthProvider } from "./auth.js";
import { loadConfig, resolveProfile, type Env, type ResolvedProfile } from "./config.js";
import { resolveToken, type CredentialStore } from "./credentials.js";
import { describeError, ToolError } from "./errors.js";
import { matchesAnyGlob } from "./glob.js";
import { JenkinsClient, type FetchFn } from "./http.js";
import { Redactor } from "./redact.js";
import { findTool } from "./tools/index.js";
import type { Args, ToolContext, ToolDef } from "./tools/types.js";
import { VERSION } from "./version.js";

export const NO_DATA_MSG =
  "Search completed, but no results were found for the specified criteria.";
export const DATA_MSG = "Data retrieved successfully.";

/** Everything a tool call needs; one per process in serve mode, one per command in CLI mode. */
export interface Session {
  profile: ResolvedProfile;
  client: JenkinsClient;
  redactor: Redactor;
}

export interface ToolOutcome {
  isError: boolean;
  text: string;
  structured?: Record<string, unknown>;
}

export interface SessionOptions {
  profileFlag?: string;
  env?: Env;
  store: CredentialStore;
  fetch?: FetchFn;
  warn?: (message: string) => void;
}

export async function createSession(opts: SessionOptions): Promise<Session> {
  const env = opts.env ?? process.env;
  const { config } = loadConfig(env);
  const profile = resolveProfile(opts.profileFlag, env, config);
  const token = await resolveToken(profile.name, env, opts.store);
  return sessionFor(profile, new BasicAuth(profile.user, token), opts.fetch, opts.warn);
}

export function sessionFor(
  profile: ResolvedProfile,
  auth: AuthProvider,
  fetchFn?: FetchFn,
  warn?: (message: string) => void,
): Session {
  const redactor = new Redactor(auth.secrets());
  const client = new JenkinsClient({
    baseUrl: profile.url,
    auth,
    timeoutMs: profile.timeoutMs,
    fetch: fetchFn,
    userAgent: `butlerbridge/${VERSION}`,
    allowInsecureHttp: profile.allowInsecureHttp,
    onWarning: (m) => warn?.(redactor.text(m)),
  });
  return { profile, client, redactor };
}

export function writeGateError(tool: ToolDef, profile: ResolvedProfile): string | null {
  if (tool.kind !== "write" || tool.name === "triggerBuild" || profile.allowWrite) return null;
  return (
    `${tool.name} changes Jenkins and is disabled for profile '${profile.name}'. ` +
    'Set "allowWrite": true in that profile to enable write tools (triggerBuild is always allowed).'
  );
}

function makeContext(session: Session): ToolContext {
  const allow = session.profile.jobAllowlist;
  const isJobAllowed = (fullName: string) =>
    !allow || matchesAnyGlob(fullName.replace(/^\/+|\/+$/g, ""), allow);
  return {
    client: session.client,
    profile: session.profile,
    notes: [],
    isJobAllowed,
    assertJobAllowed(fullName) {
      if (!isJobAllowed(fullName)) {
        throw new ToolError(
          `Job '${fullName}' is outside the jobAllowlist of profile '${session.profile.name}'.`,
        );
      }
    },
  };
}

/** One entry point for both modes: validation, gates, the call, then redaction and size caps. */
export async function runTool(
  session: Session,
  name: string,
  rawArgs: unknown,
): Promise<ToolOutcome> {
  const tool = findTool(name);
  if (!tool) return failure(session, `Unknown tool '${name}'`);
  const ctx = makeContext(session);
  try {
    const args = validateArgs(tool, rawArgs);
    const gate = writeGateError(tool, session.profile);
    if (gate) throw new ToolError(gate);
    const job = tool.jobArg ? args[tool.jobArg] : undefined;
    if (typeof job === "string" && job.trim()) ctx.assertJobAllowed(job);
    const result = await tool.handler(args, ctx);
    return success(session, tool, result, ctx.notes);
  } catch (err) {
    return failure(session, describeError(err));
  }
}

function validateArgs(tool: ToolDef, raw: unknown): Args {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new ToolError("Tool arguments must be an object");
  const args = raw as Args;
  for (const key of (tool.inputSchema.required as string[] | undefined) ?? []) {
    if (args[key] === undefined || args[key] === null) {
      throw new ToolError(`Missing required parameter '${key}'`);
    }
  }
  return args;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function success(session: Session, tool: ToolDef, result: unknown, notes: string[]): ToolOutcome {
  const safe = session.redactor.value(result);
  const empty = isEmpty(safe);
  const message = [empty ? NO_DATA_MSG : DATA_MSG, ...notes].join(" ");
  const body: Record<string, unknown> = { status: "COMPLETED", message };
  if (!empty) body.result = safe;
  let text = JSON.stringify(body);
  let structured =
    tool.structured && !empty && typeof safe === "object"
      ? (safe as Record<string, unknown>)
      : undefined;

  const max = session.profile.maxResultChars;
  if (max > 0 && text.length > max) {
    const json = JSON.stringify(safe);
    const room = Math.max(0, max - message.length - 400);
    text = JSON.stringify({
      status: "COMPLETED",
      message:
        `${message} TRUNCATED: the result is ${json.length} characters, over maxResultChars (${max}); ` +
        `'truncatedResult' holds its first ${room} characters as text. Ask for less with tree, skip/limit, ` +
        "summary, or a log cursor, or raise maxResultChars in the profile.",
      truncatedResult: json.slice(0, room),
    });
    structured = undefined;
  }
  return { isError: false, text: session.redactor.literals(text), structured };
}

function failure(session: Session | null, message: string): ToolOutcome {
  const safe = session ? session.redactor.text(message) : new Redactor().text(message);
  return { isError: true, text: JSON.stringify({ status: "FAILED", message: safe }) };
}

/** For errors before a session exists (bad config, missing token). */
export function failureWithoutSession(err: unknown): ToolOutcome {
  return failure(null, describeError(err));
}
