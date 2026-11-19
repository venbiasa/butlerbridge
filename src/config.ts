import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ToolError } from "./errors.js";
import { compileUserRegex } from "./patterns.js";

export interface ProfileConfig {
  url: string;
  user: string;
  allowWrite?: boolean;
  jobAllowlist?: string[];
  timeoutMs?: number;
  maxResultChars?: number;
  maxTestCases?: number;
  triggerWaitMs?: number;
  allowInsecureHttp?: boolean;
  redactPatterns?: string[];
  maskEmails?: boolean;
  collapseRepeats?: boolean;
  compactSearch?: boolean;
}

export interface ConfigFile {
  defaultProfile?: string;
  profiles: Record<string, ProfileConfig>;
}

/** A profile with every setting filled in, ready to use. */
export interface ResolvedProfile {
  name: string;
  url: string;
  user: string;
  allowWrite: boolean;
  jobAllowlist: string[] | null;
  timeoutMs: number;
  maxResultChars: number;
  maxTestCases: number;
  triggerWaitMs: number;
  allowInsecureHttp: boolean;
  redactPatterns: string[];
  maskEmails: boolean;
  /** MCP default for `collapseRepeats`; the CLI always defaults to true. */
  collapseRepeats: boolean;
  /** MCP default for searchBuildLog `compact`; the CLI always defaults to true. */
  compactSearch: boolean;
  /** Where url/user came from, for `doctor` and `profiles`. */
  source: "config" | "env" | "config+env";
}

export const DEFAULTS = {
  timeoutMs: 30_000,
  maxResultChars: 40_000,
  maxTestCases: 200,
  triggerWaitMs: 15_000,
} as const;

/** Smaller caps can't hold even an empty log page with its envelope. */
export const MIN_RESULT_CHARS = 1_000;

export const DEFAULT_PROFILE = "default";

export type Env = Record<string, string | undefined>;

export function configPath(env: Env = process.env, platform = process.platform): string {
  if (env.BUTLERBRIDGE_CONFIG) return env.BUTLERBRIDGE_CONFIG;
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "butlerbridge", "config.json");
  }
  return join(homedir(), ".config", "butlerbridge", "config.json");
}

const SECRET_KEY = /token|password|passwd|secret|apikey|api_key/i;
const PROFILE_KEYS: Record<keyof ProfileConfig, "string" | "boolean" | "number" | "string[]"> = {
  url: "string",
  user: "string",
  allowWrite: "boolean",
  jobAllowlist: "string[]",
  timeoutMs: "number",
  maxResultChars: "number",
  maxTestCases: "number",
  triggerWaitMs: "number",
  allowInsecureHttp: "boolean",
  redactPatterns: "string[]",
  maskEmails: "boolean",
  collapseRepeats: "boolean",
  compactSearch: "boolean",
};

function findSecretKeys(value: unknown, path: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findSecretKeys(v, `${path}[${i}]`, found));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      const isProfileName = path === "profiles";
      if (!isProfileName && SECRET_KEY.test(k)) found.push(p);
      findSecretKeys(v, p, found);
    }
  }
}

/** Parses and validates the config file text. Refuses any file that holds a secret. */
export function parseConfig(text: string, file = "config file"): ConfigFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ToolError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ToolError(`${file} must hold a JSON object`);
  }
  const secrets: string[] = [];
  findSecretKeys(raw, "", secrets);
  if (secrets.length) {
    throw new ToolError(
      `${file} contains a secret-looking key (${secrets.join(", ")}). Tokens must never be stored in the config file: ` +
        "remove it, revoke that token in Jenkins, and run `butlerbridge login` to keep a new one in the OS credential store.",
    );
  }
  const obj = raw as Record<string, unknown>;
  const profilesRaw = obj.profiles ?? {};
  if (profilesRaw === null || typeof profilesRaw !== "object" || Array.isArray(profilesRaw)) {
    throw new ToolError(`${file}: "profiles" must be an object`);
  }
  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, p] of Object.entries(profilesRaw as Record<string, unknown>)) {
    profiles[name] = validateProfile(name, p, file);
  }
  if (obj.defaultProfile !== undefined && typeof obj.defaultProfile !== "string") {
    throw new ToolError(`${file}: "defaultProfile" must be a string`);
  }
  return { defaultProfile: obj.defaultProfile as string | undefined, profiles };
}

function validateProfile(name: string, p: unknown, file: string): ProfileConfig {
  if (p === null || typeof p !== "object" || Array.isArray(p)) {
    throw new ToolError(`${file}: profile '${name}' must be an object`);
  }
  for (const [key, value] of Object.entries(p)) {
    const expected = PROFILE_KEYS[key as keyof ProfileConfig];
    if (!expected) throw new ToolError(`${file}: profile '${name}' has unknown key '${key}'`);
    const ok =
      expected === "string[]"
        ? Array.isArray(value) && value.every((v) => typeof v === "string")
        : typeof value === expected;
    if (!ok) throw new ToolError(`${file}: profile '${name}' key '${key}' must be ${expected}`);
  }
  const profile = p as ProfileConfig;
  for (const key of ["timeoutMs", "maxResultChars", "maxTestCases", "triggerWaitMs"] as const) {
    const v = profile[key];
    if (v !== undefined && (!Number.isFinite(v) || v < 0)) {
      throw new ToolError(`${file}: profile '${name}' key '${key}' must be a non-negative number`);
    }
  }
  if (profile.maxResultChars !== undefined && profile.maxResultChars < MIN_RESULT_CHARS) {
    throw new ToolError(
      `${file}: profile '${name}' maxResultChars must be at least ${MIN_RESULT_CHARS}`,
    );
  }
  (profile.redactPatterns ?? []).forEach((pattern, i) => {
    try {
      compileUserRegex(pattern, `redactPatterns[${i}]`, "g");
    } catch (err) {
      throw new ToolError(`${file}: profile '${name}': ${(err as Error).message}`);
    }
  });
  return profile;
}

export function loadConfig(env: Env = process.env): { path: string; config: ConfigFile } {
  const path = configPath(env);
  if (!existsSync(path)) return { path, config: { profiles: {} } };
  return { path, config: parseConfig(readFileSync(path, "utf8"), path) };
}

export function saveConfig(path: string, config: ConfigFile): void {
  const secrets: string[] = [];
  findSecretKeys(config, "", secrets);
  if (secrets.length) throw new ToolError("Refusing to write a secret into the config file");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** `--profile`, then `BUTLERBRIDGE_PROFILE`, then the config's `defaultProfile`, then `default`. */
export function selectProfileName(
  flag: string | undefined,
  env: Env,
  config: ConfigFile,
): { name: string; explicit: boolean } {
  if (flag) return { name: flag, explicit: true };
  if (env.BUTLERBRIDGE_PROFILE) return { name: env.BUTLERBRIDGE_PROFILE, explicit: true };
  if (config.defaultProfile) return { name: config.defaultProfile, explicit: true };
  return { name: DEFAULT_PROFILE, explicit: false };
}

/**
 * Builds the effective profile. `JENKINS_URL` / `JENKINS_USER` override the file, which lets CI
 * and containers run without any config file at all.
 */
export function resolveProfile(
  flag: string | undefined,
  env: Env,
  config: ConfigFile,
): ResolvedProfile {
  const { name } = selectProfileName(flag, env, config);
  const fromFile = config.profiles[name];
  const url = env.JENKINS_URL || fromFile?.url;
  const user = env.JENKINS_USER || fromFile?.user;
  if (!fromFile && !env.JENKINS_URL) {
    const known = Object.keys(config.profiles);
    throw new ToolError(
      `No Jenkins profile '${name}' is configured. Run \`butlerbridge login --profile ${name}\`` +
        (known.length ? ` or pick one of: ${known.join(", ")}` : "") +
        ", or set JENKINS_URL, JENKINS_USER and JENKINS_TOKEN.",
    );
  }
  if (!url) throw new ToolError(`Profile '${name}' has no url`);
  if (!user)
    throw new ToolError(`Profile '${name}' has no user; set it in the profile or JENKINS_USER`);
  const envUsed = Boolean(env.JENKINS_URL || env.JENKINS_USER);
  return {
    name,
    url: normalizeUrl(url),
    user,
    allowWrite: fromFile?.allowWrite ?? false,
    jobAllowlist: fromFile?.jobAllowlist?.length ? fromFile.jobAllowlist : null,
    timeoutMs: fromFile?.timeoutMs ?? DEFAULTS.timeoutMs,
    maxResultChars: fromFile?.maxResultChars ?? DEFAULTS.maxResultChars,
    maxTestCases: fromFile?.maxTestCases ?? DEFAULTS.maxTestCases,
    triggerWaitMs: fromFile?.triggerWaitMs ?? DEFAULTS.triggerWaitMs,
    allowInsecureHttp: fromFile?.allowInsecureHttp ?? false,
    redactPatterns: fromFile?.redactPatterns ?? [],
    maskEmails: fromFile?.maskEmails ?? false,
    collapseRepeats: fromFile?.collapseRepeats ?? false,
    compactSearch: fromFile?.compactSearch ?? false,
    source: fromFile ? (envUsed ? "config+env" : "config") : "env",
  };
}

export function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new ToolError(`Invalid Jenkins URL '${url}'`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ToolError(`Jenkins URL must be http(s), got '${parsed.protocol}'`);
  }
  if (parsed.username || parsed.password) {
    throw new ToolError("Do not put credentials in the Jenkins URL");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}
