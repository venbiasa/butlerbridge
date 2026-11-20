import { BasicAuth } from "../auth.js";
import {
  loadConfig,
  normalizeUrl,
  resolveProfile,
  saveConfig,
  selectProfileName,
  type ConfigFile,
  type Env,
  type ProfileConfig,
  type ResolvedProfile,
} from "../config.js";
import type { CredentialStore } from "../credentials.js";
import { describeError, ToolError } from "../errors.js";
import type { FetchFn } from "../http.js";
import { runTool, sessionFor } from "../runtime.js";
import { ask, askHidden, confirm, readAllStdin } from "./prompt.js";

export interface CommandIO {
  env: Env;
  store: CredentialStore;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: FetchFn;
}

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

export async function login(flags: Map<string, string | true>, io: CommandIO): Promise<number> {
  const { path, config } = loadConfig(io.env);
  const { name } = selectProfileName(flagString(flags, "profile"), io.env, config);
  const existing = config.profiles[name];
  if (flags.get("bridge") === true) return loginBridge(name, existing, path, config, flags, io);
  io.err(`Configuring Jenkins profile '${name}' (config: ${path}).`);
  io.err(
    "Use a dedicated API token for this tool (Jenkins: your user > Security > API Token > Add new token),",
  );
  io.err("so you can revoke it on its own at any time.");

  const url = normalizeUrl(flagString(flags, "url") ?? (await ask("Jenkins URL", existing?.url)));
  let allowInsecureHttp = existing?.allowInsecureHttp ?? false;
  if (url.startsWith("http://")) {
    allowInsecureHttp =
      flags.get("allow-insecure-http") === true ||
      allowInsecureHttp ||
      (await confirm(
        "This URL is plain HTTP, so the token travels unencrypted. Allow it for this profile?",
      ));
    if (!allowInsecureHttp) throw new ToolError("Plain HTTP not allowed; use an https URL.");
  }
  const user = flagString(flags, "user") ?? (await ask("Jenkins username", existing?.user));
  if (!user) throw new ToolError("A username is required");
  const token =
    flags.get("token-stdin") === true
      ? await readAllStdin()
      : await askHidden("API token (hidden)");
  if (!token) throw new ToolError("An API token is required");

  const profileConfig: ProfileConfig = {
    ...existing,
    url,
    user,
    ...(allowInsecureHttp && { allowInsecureHttp }),
  };
  if (flags.get("no-verify") !== true) {
    const session = sessionFor(
      resolvedFrom(name, profileConfig),
      new BasicAuth(user, token),
      io.fetch,
      io.err,
    );
    const outcome = await runTool(session, "whoAmI", {});
    if (outcome.isError) {
      const message = (JSON.parse(outcome.text) as { message: string }).message;
      throw new ToolError(
        message.includes("browser sign-in gateway")
          ? message
          : `Jenkins did not accept these credentials: ${message}`,
      );
    }
    const fullName = (JSON.parse(outcome.text) as { result?: { fullName?: string } }).result
      ?.fullName;
    if (!fullName || fullName === "anonymous") {
      throw new ToolError(
        "Jenkins treated the request as anonymous; check the username and token.",
      );
    }
    io.err(`Authenticated as ${fullName}.`);
  }

  await io.store.set(name, token);
  config.profiles[name] = profileConfig;
  config.defaultProfile ??= name;
  saveConfig(path, config);
  io.out(
    `Saved profile '${name}'. The token is in the OS credential store (service "butlerbridge", account "${name}").`,
  );
  return 0;
}

/** A bridge profile: only the URL. The browser session is the credential, so nothing is stored. */
async function loginBridge(
  name: string,
  existing: ProfileConfig | undefined,
  path: string,
  config: ConfigFile,
  flags: Map<string, string | true>,
  io: CommandIO,
): Promise<number> {
  const url = normalizeUrl(flagString(flags, "url") ?? (await ask("Jenkins URL", existing?.url)));
  if (!url.startsWith("https://")) throw new ToolError("The bridge only reaches https URLs");
  const profileConfig: ProfileConfig = { ...existing, url, transport: "bridge" };
  delete profileConfig.allowInsecureHttp;
  config.profiles[name] = profileConfig;
  saveConfig(path, config);
  io.out(
    `Saved bridge profile '${name}'. No API token: requests run in your signed-in Chrome through ` +
      "the ridealong extension, which asks you to Pair and Allow the host on first use.",
  );
  const stale = await io.store.get(name).catch(() => null);
  if (stale) {
    io.out(
      `An API token from before is still stored for '${name}'; \`butlerbridge logout --profile ${name}\` removes it.`,
    );
  }
  return 0;
}

function resolvedFrom(name: string, p: ProfileConfig): ResolvedProfile {
  return { ...resolveProfile(name, {}, { profiles: { [name]: p } }), triggerWaitMs: 0 };
}

export async function logout(flags: Map<string, string | true>, io: CommandIO): Promise<number> {
  const { path, config } = loadConfig(io.env);
  const { name } = selectProfileName(flagString(flags, "profile"), io.env, config);
  const removed = await io.store.delete(name);
  io.out(
    removed
      ? `Removed the API token of profile '${name}'.`
      : `Profile '${name}' had no stored token.`,
  );
  if (flags.get("forget") === true && config.profiles[name]) {
    delete config.profiles[name];
    if (config.defaultProfile === name) delete config.defaultProfile;
    saveConfig(path, config);
    io.out(`Removed profile '${name}' from ${path}.`);
  }
  io.out("Revoke the token in Jenkins as well if you no longer need it.");
  return 0;
}

export async function profiles(io: CommandIO): Promise<number> {
  const { path, config } = loadConfig(io.env);
  const names = Object.keys(config.profiles);
  io.out(`Config: ${path}`);
  if (!names.length) io.out("No profiles. Run `butlerbridge login`.");
  for (const name of names) {
    const p = config.profiles[name] as ProfileConfig;
    let token: string;
    if (p.transport === "bridge") {
      token = "none needed (bridge)";
    } else {
      try {
        token = (await io.store.get(name)) ? "stored" : "missing";
      } catch (err) {
        token = `unknown (${describeError(err)})`;
      }
    }
    const marks = [
      config.defaultProfile === name ? "default" : null,
      p.allowWrite ? "allowWrite" : null,
      p.allowInsecureHttp ? "allowInsecureHttp" : null,
    ].filter(Boolean);
    io.out(`- ${name}${marks.length ? ` (${marks.join(", ")})` : ""}`);
    io.out(`    url: ${p.url}`);
    if (p.user) io.out(`    user: ${p.user}`);
    if (p.transport === "bridge") io.out("    transport: bridge");
    io.out(`    token: ${token}`);
    if (p.jobAllowlist?.length) io.out(`    jobAllowlist: ${p.jobAllowlist.join(", ")}`);
  }
  if (io.env.JENKINS_URL || io.env.JENKINS_USER || io.env.JENKINS_TOKEN) {
    io.out(
      "Note: JENKINS_URL / JENKINS_USER / JENKINS_TOKEN are set and override the selected profile.",
    );
  }
  return 0;
}
