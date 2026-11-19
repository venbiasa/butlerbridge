import { BasicAuth, type AuthProvider } from "./auth.js";
import { loadConfig, resolveProfile, type Env, type ResolvedProfile } from "./config.js";
import { resolveToken, type CredentialStore } from "./credentials.js";
import { describeError, ToolError } from "./errors.js";
import { matchesAnyGlob } from "./glob.js";
import { JenkinsClient, type FetchFn, type RequestRecord } from "./http.js";
import { compileUserRegex } from "./patterns.js";
import { countRedactions, Redactor, type RedactionStats } from "./redact.js";
import { findTool } from "./tools/index.js";
import type { Args, ToolContext, ToolDef } from "./tools/types.js";
import { VERSION } from "./version.js";

export const NO_DATA_MSG =
  "Search completed, but no results were found for the specified criteria.";
export const DATA_MSG = "Data retrieved successfully.";
/** Room kept for "(N values redacted)" when a tool sizes its own result. */
const REDACTION_NOTE_ALLOWANCE = 40;

export type Mode = "mcp" | "cli";

/** Everything a tool call needs; one per process in serve mode, one per command in CLI mode. */
export interface Session {
  profile: ResolvedProfile;
  client: JenkinsClient;
  redactor: Redactor;
  mode: Mode;
  /** Requests of the current call, for CLI diagnostics. Reset by every runTool. */
  requests: RequestRecord[];
}

export interface ToolOutcome {
  isError: boolean;
  text: string;
  structured?: Record<string, unknown>;
  /** True when the plugin's "no results" envelope was returned. */
  noData?: boolean;
  /** CLI-only explanations for stderr; never part of the MCP result. */
  hints?: string[];
  redactions?: number;
}

export interface SessionOptions {
  profileFlag?: string;
  env?: Env;
  store: CredentialStore;
  fetch?: FetchFn;
  warn?: (message: string) => void;
  mode?: Mode;
}

export async function createSession(opts: SessionOptions): Promise<Session> {
  const env = opts.env ?? process.env;
  const { config } = loadConfig(env);
  const profile = resolveProfile(opts.profileFlag, env, config);
  const token = await resolveToken(profile.name, env, opts.store);
  return sessionFor(
    profile,
    new BasicAuth(profile.user, token),
    opts.fetch,
    opts.warn,
    opts.mode ?? "mcp",
  );
}

export function redactorFor(profile: ResolvedProfile, secrets: string[] = []): Redactor {
  return new Redactor(secrets, {
    customPatterns: profile.redactPatterns.map((p, i) =>
      compileUserRegex(p, `redactPatterns[${i}]`, "g"),
    ),
    maskEmails: profile.maskEmails,
  });
}

export function sessionFor(
  profile: ResolvedProfile,
  auth: AuthProvider,
  fetchFn?: FetchFn,
  warn?: (message: string) => void,
  mode: Mode = "mcp",
): Session {
  const redactor = redactorFor(profile, auth.secrets());
  const requests: RequestRecord[] = [];
  const client = new JenkinsClient({
    baseUrl: profile.url,
    auth,
    timeoutMs: profile.timeoutMs,
    fetch: fetchFn,
    userAgent: `butlerbridge/${VERSION}`,
    allowInsecureHttp: profile.allowInsecureHttp,
    onWarning: (m) => warn?.(redactor.text(m)),
    onRequest: (r) => {
      if (mode === "cli") requests.push(r);
    },
  });
  return { profile, client, redactor, mode, requests };
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
  const ctx: ToolContext = {
    client: session.client,
    profile: session.profile,
    mode: session.mode,
    notes: [],
    hints: [],
    isJobAllowed,
    assertJobAllowed(fullName) {
      if (!isJobAllowed(fullName)) {
        throw new ToolError(
          `Job '${fullName}' is outside the jobAllowlist of profile '${session.profile.name}'.`,
        );
      }
    },
    redactPreview: (text) => session.redactor.text(text),
    measure: (result) =>
      renderSuccess(session, result, ctx.notes, undefined).text.length + REDACTION_NOTE_ALLOWANCE,
  };
  return ctx;
}

/** One entry point for both modes: validation, gates, the call, then redaction and size caps. */
export async function runTool(
  session: Session,
  name: string,
  rawArgs: unknown,
): Promise<ToolOutcome> {
  session.requests.length = 0;
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
    return success(session, tool, result, ctx);
  } catch (err) {
    return { ...failure(session, describeError(err)), hints: redactHints(session, ctx.hints) };
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

interface Rendered {
  text: string;
  safe: unknown;
  empty: boolean;
}

/** The success envelope exactly as a client sees it, before the size cap. */
function renderSuccess(
  session: Session,
  result: unknown,
  notes: string[],
  stats: RedactionStats | undefined,
): Rendered {
  const safe = session.redactor.value(result, stats);
  const empty = isEmpty(safe);
  const redacted = stats ? countRedactions(stats) : 0;
  const head = empty
    ? NO_DATA_MSG
    : redacted > 0
      ? `Data retrieved successfully (${redacted} value${redacted === 1 ? "" : "s"} redacted).`
      : DATA_MSG;
  const message = [head, ...notes].join(" ");
  const body: Record<string, unknown> = { status: "COMPLETED", message };
  if (!empty) body.result = safe;
  return { text: JSON.stringify(body), safe, empty };
}

function success(session: Session, tool: ToolDef, result: unknown, ctx: ToolContext): ToolOutcome {
  const stats: RedactionStats = new Map();
  const rendered = renderSuccess(session, result, ctx.notes, stats);
  const { safe, empty } = rendered;
  let text = rendered.text;
  let structured =
    tool.structured && !empty && typeof safe === "object"
      ? (safe as Record<string, unknown>)
      : undefined;

  const max = session.profile.maxResultChars;
  if (max > 0 && text.length > max) {
    const message = (JSON.parse(text) as { message: string }).message;
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
  return {
    isError: false,
    text: session.redactor.literals(text, stats),
    structured,
    noData: empty,
    hints: redactHints(session, ctx.hints),
    redactions: countRedactions(stats),
  };
}

function redactHints(session: Session, hints: string[]): string[] {
  return hints.map((h) => session.redactor.text(h));
}

function failure(session: Session | null, message: string): ToolOutcome {
  const safe = session ? session.redactor.text(message) : new Redactor().text(message);
  return { isError: true, text: JSON.stringify({ status: "FAILED", message: safe }) };
}

/** For errors before a session exists (bad config, missing token). */
export function failureWithoutSession(err: unknown): ToolOutcome {
  return failure(null, describeError(err));
}
