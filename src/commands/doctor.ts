import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { BasicAuth } from "../auth.js";
import { loadConfig, resolveProfile, type Env } from "../config.js";
import { resolveToken } from "../credentials.js";
import { describeError } from "../errors.js";
import { Redactor, type RedactionStats } from "../redact.js";
import { redactorFor, runTool, sessionFor } from "../runtime.js";
import type { CommandIO } from "./account.js";

/** PATH a GUI-launched app typically gets: launchd's default on macOS, the session default on Linux. */
const GUI_PATH: Record<string, string[]> = {
  darwin: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"],
  linux: ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"],
};

export function findOnPath(names: string[], pathVar: string | undefined): string | null {
  for (const dir of (pathVar ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const candidate = join(dir, n);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Warnings about MCP clients started from the Dock / Start menu not finding node or npx. */
export function guiPathWarnings(platform: NodeJS.Platform, env: Env, nodePath: string): string[] {
  if (platform === "win32") {
    return findOnPath(["npx.cmd", "npx.exe", "npx"], env.PATH ?? env.Path)
      ? []
      : [
          "npx is not on PATH. Install Node.js from nodejs.org (it adds npx to the system PATH) and restart the MCP client.",
        ];
  }
  const guiDirs = GUI_PATH[platform] ?? GUI_PATH.linux!;
  const npx = findOnPath(["npx"], env.PATH);
  const guiHasNode = guiDirs.some((d) => existsSync(join(d, "node")));
  const guiHasNpx = guiDirs.some((d) => existsSync(join(d, "npx")));
  const underHome = nodePath.startsWith(homedir());
  if (guiHasNode && guiHasNpx && !underHome) return [];
  const binDir = npx ? dirname(npx) : dirname(nodePath);
  return [
    `node (${nodePath}) and npx (${npx ?? "not found"}) are not in the PATH a GUI-launched MCP client gets ` +
      `(${guiDirs.join(delimiter)}). A client started from the Dock or app menu may fail with "npx: command not found".`,
    `Fix: use the absolute path as the command (${npx ?? join(dirname(nodePath), "npx")}) and add ` +
      `"env": { "PATH": "${binDir}${delimiter}${guiDirs.join(delimiter)}" } to the server entry.`,
  ];
}

/**
 * Runs the redactor of the selected profile (built-in rules only when none resolves) over a local
 * file and prints which rules fired and how often. Never prints a matched value.
 */
export function redactionSample(
  file: string,
  flags: Map<string, string | true>,
  io: CommandIO,
): number {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    io.err(`Cannot read ${file}: ${(err as Error).message}`);
    return 1;
  }
  let redactor: Redactor;
  try {
    const flag = flags.get("profile");
    const profile = resolveProfile(
      typeof flag === "string" ? flag : undefined,
      io.env,
      loadConfig(io.env).config,
    );
    redactor = redactorFor(profile);
    io.out(`Rules: built-in plus profile '${profile.name}' settings.`);
  } catch (err) {
    redactor = new Redactor();
    io.out(`Rules: built-in only (${describeError(err)}).`);
  }
  const stats: RedactionStats = new Map();
  redactor.text(text, stats);
  const lines = text.split("\n").length;
  if (!stats.size) {
    io.out(`No redactions in ${lines} line(s).`);
    return 0;
  }
  io.out(`Redactions in ${lines} line(s), by rule (counts only):`);
  for (const [rule, count] of [...stats].sort((a, b) => b[1] - a[1])) {
    io.out(`  ${String(count).padStart(6)}  ${rule}`);
  }
  return 0;
}

export async function doctor(flags: Map<string, string | true>, io: CommandIO): Promise<number> {
  const sample = flags.get("redaction-sample");
  if (sample !== undefined) {
    if (sample === true) {
      io.err("--redaction-sample needs a file path");
      return 2;
    }
    return redactionSample(sample, flags, io);
  }
  let failed = false;
  const ok = (m: string) => io.out(`ok    ${m}`);
  const warn = (m: string) => io.out(`warn  ${m}`);
  const fail = (m: string) => {
    failed = true;
    io.out(`FAIL  ${m}`);
  };

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major > 18 || (major === 18 && minor >= 17)) ok(`Node.js ${process.versions.node}`);
  else fail(`Node.js ${process.versions.node} is too old; butlerbridge needs 18.17 or newer`);

  const run = async (): Promise<void> => {
    let loaded;
    try {
      loaded = loadConfig(io.env);
      ok(
        `config file ${existsSync(loaded.path) ? loaded.path : `${loaded.path} (not created yet)`}`,
      );
    } catch (err) {
      return fail(`config: ${describeError(err)}`);
    }
    const flag = flags.get("profile");
    let profile;
    try {
      profile = resolveProfile(typeof flag === "string" ? flag : undefined, io.env, loaded.config);
      ok(`profile '${profile.name}' → ${profile.url} as ${profile.user} (from ${profile.source})`);
      if (profile.allowInsecureHttp && profile.url.startsWith("http://")) {
        warn(
          "plain HTTP is allowed for this profile: the API token travels in cleartext over this connection",
        );
      }
    } catch (err) {
      return fail(`profile: ${describeError(err)}`);
    }
    if (profile.transport === "bridge") {
      ok("transport: bridge (the ridealong extension signs in through your browser; no API token)");
      return;
    }
    let token;
    try {
      token = await resolveToken(profile.name, io.env, io.store);
      ok(
        io.env.JENKINS_TOKEN
          ? "API token from JENKINS_TOKEN"
          : "API token found in the OS credential store",
      );
    } catch (err) {
      return fail(`credential store: ${describeError(err)}`);
    }
    let session;
    try {
      session = sessionFor(profile, new BasicAuth(profile.user, token), io.fetch);
    } catch (err) {
      return fail(`client: ${describeError(err)}`);
    }
    try {
      const res = await session.client.request("/api/json", {
        query: { tree: "url" },
        acceptStatus: [401, 403, 404],
      });
      await res.body?.cancel();
      ok(`reached ${profile.url} (HTTP ${res.status})`);
    } catch (err) {
      return fail(`reachability: ${session.redactor.text(describeError(err))}`);
    }
    const who = await runTool(session, "whoAmI", {});
    const parsed = JSON.parse(who.text) as { message?: string; result?: { fullName?: string } };
    if (who.isError) return fail(`whoAmI: ${parsed.message}`);
    const name = parsed.result?.fullName;
    if (!name || name === "anonymous")
      return fail("whoAmI: Jenkins treated the token as anonymous");
    ok(`whoAmI: ${name}`);
  };
  await run();

  const pathWarnings = guiPathWarnings(process.platform, io.env, process.execPath);
  if (pathWarnings.length) pathWarnings.forEach(warn);
  else ok("node and npx are on the PATH GUI apps get");

  io.out(failed ? "Some checks failed." : "All checks passed.");
  return failed ? 1 : 0;
}
