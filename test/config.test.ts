import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configPath,
  loadConfig,
  parseConfig,
  resolveProfile,
  saveConfig,
  selectProfileName,
  type ConfigFile,
} from "../src/config.js";
import { MemoryStore, resolveToken } from "../src/credentials.js";

const config: ConfigFile = {
  defaultProfile: "prod",
  profiles: {
    prod: { url: "https://prod.example.test/", user: "bob" },
    staging: {
      url: "https://staging.example.test",
      user: "carol",
      allowWrite: true,
      jobAllowlist: ["team/*"],
    },
  },
};

describe("config location", () => {
  it("uses ~/.config on macOS and Linux", () => {
    expect(configPath({}, "darwin")).toMatch(/\.config[\\/]butlerbridge[\\/]config\.json$/);
    expect(configPath({}, "linux")).toMatch(/\.config[\\/]butlerbridge[\\/]config\.json$/);
  });

  it("uses %APPDATA% on Windows", () => {
    expect(configPath({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "win32")).toMatch(
      /AppData[\\/]Roaming[\\/]butlerbridge[\\/]config\.json$/,
    );
  });

  it("honours BUTLERBRIDGE_CONFIG", () => {
    expect(configPath({ BUTLERBRIDGE_CONFIG: "/tmp/x.json" }, "linux")).toBe("/tmp/x.json");
  });
});

describe("profile selection order", () => {
  it("prefers --profile", () => {
    expect(selectProfileName("staging", { BUTLERBRIDGE_PROFILE: "x" }, config).name).toBe(
      "staging",
    );
  });

  it("then BUTLERBRIDGE_PROFILE", () => {
    expect(selectProfileName(undefined, { BUTLERBRIDGE_PROFILE: "staging" }, config).name).toBe(
      "staging",
    );
  });

  it("then defaultProfile", () => {
    expect(selectProfileName(undefined, {}, config).name).toBe("prod");
  });

  it("then 'default'", () => {
    expect(selectProfileName(undefined, {}, { profiles: {} }).name).toBe("default");
  });
});

describe("resolveProfile", () => {
  it("fills defaults and normalizes the URL", () => {
    const p = resolveProfile(undefined, {}, config);
    expect(p).toMatchObject({
      name: "prod",
      url: "https://prod.example.test",
      user: "bob",
      allowWrite: false,
      jobAllowlist: null,
      allowInsecureHttp: false,
      source: "config",
    });
  });

  it("lets environment variables override the selected profile", () => {
    const p = resolveProfile(
      "staging",
      { JENKINS_URL: "https://env.example.test", JENKINS_USER: "ci" },
      config,
    );
    expect(p).toMatchObject({
      name: "staging",
      url: "https://env.example.test",
      user: "ci",
      allowWrite: true,
      jobAllowlist: ["team/*"],
      source: "config+env",
    });
  });

  it("works from the environment alone", () => {
    const p = resolveProfile(
      undefined,
      { JENKINS_URL: "https://env.example.test", JENKINS_USER: "ci" },
      { profiles: {} },
    );
    expect(p).toMatchObject({ name: "default", source: "env", allowWrite: false });
  });

  it("explains a missing profile", () => {
    expect(() => resolveProfile("nope", {}, config)).toThrow(
      /No Jenkins profile 'nope'.*prod, staging/,
    );
  });

  it("rejects credentials in the URL", () => {
    expect(() =>
      resolveProfile(
        undefined,
        {},
        { profiles: { default: { url: "https://u:p@x.test", user: "u" } } },
      ),
    ).toThrow(/credentials in the Jenkins URL/);
  });
});

describe("parseConfig", () => {
  it("accepts a valid file", () => {
    expect(parseConfig(JSON.stringify(config))).toEqual(config);
  });

  it.each([
    [{ profiles: { prod: { url: "https://x", user: "u", token: "abc" } } }, "profiles.prod.token"],
    [{ profiles: { prod: { url: "https://x", user: "u", apiToken: "abc" } } }, "apiToken"],
    [{ profiles: { prod: { url: "https://x", user: "u", password: "abc" } } }, "password"],
    [{ token: "abc", profiles: {} }, "token"],
  ])("refuses a file holding a token (%#)", (raw, key) => {
    expect(() => parseConfig(JSON.stringify(raw))).toThrow(
      new RegExp(`secret-looking key.*${key}`),
    );
  });

  it("allows a profile whose name merely contains 'token'", () => {
    const raw = { profiles: { "token-service": { url: "https://x.test", user: "u" } } };
    expect(parseConfig(JSON.stringify(raw)).profiles["token-service"]).toBeDefined();
  });

  it("rejects unknown keys and wrong types", () => {
    expect(() =>
      parseConfig(JSON.stringify({ profiles: { p: { url: "x", user: "u", foo: 1 } } })),
    ).toThrow(/unknown key 'foo'/);
    expect(() =>
      parseConfig(JSON.stringify({ profiles: { p: { url: "x", user: "u", allowWrite: "yes" } } })),
    ).toThrow(/must be boolean/);
  });

  it("reports invalid JSON", () => {
    expect(() => parseConfig("{")).toThrow(/not valid JSON/);
  });
});

describe("config file round trip", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("saves and loads, and refuses to load a file with a token", () => {
    dir = mkdtempSync(join(tmpdir(), "bb-"));
    const path = join(dir, "nested", "config.json");
    const env = { BUTLERBRIDGE_CONFIG: path };
    expect(loadConfig(env).config).toEqual({ profiles: {} });
    saveConfig(path, config);
    expect(loadConfig(env).config).toEqual(config);
    writeFileSync(
      path,
      JSON.stringify({ profiles: { a: { url: "https://x", user: "u", token: "t" } } }),
    );
    expect(() => loadConfig(env)).toThrow(/Tokens must never be stored/);
    expect(readFileSync(path, "utf8")).toContain("token");
  });

  it("never writes a token", () => {
    dir = mkdtempSync(join(tmpdir(), "bb-"));
    const bad = {
      profiles: { a: { url: "https://x", user: "u", token: "t" } },
    } as unknown as ConfigFile;
    expect(() => saveConfig(join(dir as string, "c.json"), bad)).toThrow(/Refusing/);
  });
});

describe("token lookup", () => {
  it("prefers JENKINS_TOKEN over the credential store", async () => {
    const store = new MemoryStore();
    await store.set("prod", "from-store");
    expect(await resolveToken("prod", { JENKINS_TOKEN: "from-env" }, store)).toBe("from-env");
    expect(await resolveToken("prod", {}, store)).toBe("from-store");
  });

  it("explains a missing token", async () => {
    await expect(resolveToken("prod", {}, new MemoryStore())).rejects.toThrow(
      /butlerbridge login --profile prod/,
    );
  });
});

describe("bridge transport", () => {
  const iap: ConfigFile = {
    profiles: { iap: { url: "https://iap.example.test", transport: "bridge" } },
  };

  it("needs no user and waits longer by default", () => {
    expect(resolveProfile("iap", {}, iap)).toMatchObject({
      transport: "bridge",
      user: "browser-session",
      timeoutMs: 90_000,
    });
  });

  it("defaults to the token transport, which still needs a user", () => {
    expect(resolveProfile("prod", {}, config).transport).toBe("token");
    const noUser: ConfigFile = { profiles: { x: { url: "https://x.example.test" } } };
    expect(() => resolveProfile("x", {}, noUser)).toThrow(/no user/);
  });

  it("is forced by serve --bridge whatever the profile says", () => {
    expect(resolveProfile("prod", {}, config, { bridge: true }).transport).toBe("bridge");
  });

  it("accepts only token or bridge in the config file", () => {
    expect(
      parseConfig('{"profiles":{"a":{"url":"https://a.example.test","transport":"bridge"}}}')
        .profiles.a?.transport,
    ).toBe("bridge");
    expect(() =>
      parseConfig('{"profiles":{"a":{"url":"https://a.example.test","transport":"ssh"}}}'),
    ).toThrow(/transport/);
  });
});
