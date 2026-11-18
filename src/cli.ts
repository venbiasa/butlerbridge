#!/usr/bin/env node
import { parseArgv, toolArgsFromFlags } from "./args.js";
import { doctor } from "./commands/doctor.js";
import { login, logout, profiles, type CommandIO } from "./commands/account.js";
import { KeyringStore } from "./credentials.js";
import { describeError } from "./errors.js";
import { createSession, failureWithoutSession, runTool, type ToolOutcome } from "./runtime.js";
import { serve } from "./server.js";
import { findTool, TOOLS } from "./tools/index.js";
import { VERSION } from "./version.js";

const HELP = `butlerbridge ${VERSION} — MCP server and CLI for Jenkins (REST API)

Usage:
  butlerbridge serve [--profile <name>]          stdio MCP server
  butlerbridge <tool> [--profile <name>] [--pretty] [--<param> <value> ...]
  butlerbridge login [--profile <name>] [--url <url>] [--user <user>] [--token-stdin]
  butlerbridge logout [--profile <name>] [--forget]
  butlerbridge profiles
  butlerbridge doctor [--profile <name>]
  butlerbridge tools                               list tools and parameters

Tool parameters: --jobFullName folder/job --buildNumber 42 (or lastSuccessfulBuild),
  --parameters '{"KEY":"value"}' or --parameters.KEY value, --json '{...all args...}'.
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

function printOutcome(outcome: ToolOutcome, pretty: boolean, io: CommandIO): number {
  io.out(pretty ? JSON.stringify(JSON.parse(outcome.text), null, 2) : outcome.text);
  return outcome.isError ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgv(argv);
  const io: CommandIO = {
    env: process.env,
    store: new KeyringStore(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
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
      await serve({ profileFlag, env: io.env, store: io.store, warn: io.err });
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
  let outcome: ToolOutcome;
  try {
    const args = toolArgsFromFlags(tool, flags);
    const session = await createSession({
      profileFlag,
      env: io.env,
      store: io.store,
      warn: io.err,
    });
    outcome = await runTool(session, tool.name, args);
  } catch (err) {
    outcome = failureWithoutSession(err);
  }
  return printOutcome(outcome, pretty, io);
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`butlerbridge: ${describeError(err)}\n`);
    process.exitCode = 1;
  },
);
