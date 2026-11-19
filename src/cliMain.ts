import { parseArgv, toolArgsFromFlags } from "./args.js";
import { login, logout, profiles, type CommandIO } from "./commands/account.js";
import { doctor } from "./commands/doctor.js";
import {
  createSession,
  failureWithoutSession,
  runTool,
  type Session,
  type ToolOutcome,
} from "./runtime.js";
import { serve } from "./server.js";
import { findTool, TOOLS } from "./tools/index.js";
import { VERSION } from "./version.js";

const HELP = `butlerbridge ${VERSION} — MCP server and CLI for Jenkins (REST API)

Usage:
  butlerbridge serve [--profile <name>]          stdio MCP server
  butlerbridge <tool> [--profile <name>] [--pretty] [--verbose] [--<param> <value> ...]
  butlerbridge login [--profile <name>] [--url <url>] [--user <user>] [--token-stdin]
  butlerbridge logout [--profile <name>] [--forget]
  butlerbridge profiles
  butlerbridge doctor [--profile <name>] [--redaction-sample <file>]
  butlerbridge tools                               list tools and parameters

Tool parameters: --jobFullName folder/job --buildNumber 42 (or lastSuccessfulBuild),
  --parameters '{"KEY":"value"}' or --parameters.KEY value, --json '{...all args...}'.
Log tools in the CLI default to compact search matches and folded repeated lines.
--verbose prints every request with its timing to stderr.
Profile: --profile, else BUTLERBRIDGE_PROFILE, else the config's defaultProfile.
Env: JENKINS_URL, JENKINS_USER, JENKINS_TOKEN override the profile (for CI).
`;

function describeTools(): string {
  return TOOLS.map((t) => {
    const props = Object.entries(
      (t.inputSchema.properties as Record<string, { type?: unknown }>) ?? {},
    );
    const required = new Set((t.inputSchema.required as string[] | undefined) ?? []);
    const params = props.map(
      ([k, v]) =>
        `${required.has(k) ? "" : "["}--${k} <${String(v.type)}>${required.has(k) ? "" : "]"}`,
    );
    return `${t.name} (${t.kind})\n  ${params.join(" ") || "(no parameters)"}`;
  }).join("\n");
}

/**
 * Explains a result on stderr. Each request that led to a "no results" answer is listed (path
 * only, redacted, never headers); `--verbose` lists every request with its timing.
 */
function printDiagnostics(
  session: Session,
  outcome: ToolOutcome,
  verbose: boolean,
  io: CommandIO,
): void {
  if (verbose || outcome.noData) {
    for (const r of session.requests) {
      const timing = verbose ? ` (${r.ms} ms)` : "";
      io.err(`butlerbridge: ${r.method} ${session.redactor.text(r.path)} → ${r.status}${timing}`);
    }
  }
  for (const hint of outcome.hints ?? []) io.err(`butlerbridge: ${hint}`);
}

/** The whole CLI, minus process wiring. Returns the exit code, or -1 while serving. */
export async function runCli(argv: string[], io: CommandIO): Promise<number> {
  const { command, flags } = parseArgv(argv);
  const profileFlag =
    typeof flags.get("profile") === "string" ? (flags.get("profile") as string) : undefined;

  if (flags.get("version") === true && !command) {
    io.out(VERSION);
    return 0;
  }
  if (!command || command === "help" || (flags.get("help") === true && !findTool(command))) {
    io.out(HELP);
    return command ? 0 : 1;
  }
  switch (command) {
    case "version":
      io.out(VERSION);
      return 0;
    case "serve":
      await serve({ profileFlag, env: io.env, store: io.store, warn: io.err, fetch: io.fetch });
      return -1;
    case "login":
      return login(flags, io);
    case "logout":
      return logout(flags, io);
    case "profiles":
      return profiles(io);
    case "doctor":
      return doctor(flags, io);
    case "tools":
      io.out(describeTools());
      return 0;
  }

  const tool = findTool(command);
  if (!tool) {
    io.err(`Unknown command or tool '${command}'. Run \`butlerbridge tools\` for the tool list.`);
    return 2;
  }
  const pretty = flags.get("pretty") === true;
  const verbose = flags.get("verbose") === true;
  let outcome: ToolOutcome;
  try {
    const args = toolArgsFromFlags(tool, flags);
    const session = await createSession({
      profileFlag,
      env: io.env,
      store: io.store,
      warn: io.err,
      fetch: io.fetch,
      mode: "cli",
    });
    outcome = await runTool(session, tool.name, args);
    printDiagnostics(session, outcome, verbose, io);
  } catch (err) {
    outcome = failureWithoutSession(err);
  }
  io.out(pretty ? JSON.stringify(JSON.parse(outcome.text), null, 2) : outcome.text);
  return outcome.isError ? 1 : 0;
}
