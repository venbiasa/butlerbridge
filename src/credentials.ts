import { ToolError } from "./errors.js";

export const KEYRING_SERVICE = "butlerbridge";

/** Where API tokens live. Account = profile name. */
export interface CredentialStore {
  get(profile: string): Promise<string | null>;
  set(profile: string, token: string): Promise<void>;
  delete(profile: string): Promise<boolean>;
}

interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

type EntryCtor = new (service: string, account: string) => KeyringEntry;

/** OS store (Keychain, Credential Manager, Secret Service). Loaded lazily so env-only use never needs it. */
export class KeyringStore implements CredentialStore {
  private ctor: Promise<EntryCtor> | null = null;

  private async entry(profile: string): Promise<KeyringEntry> {
    this.ctor ??= import("@napi-rs/keyring")
      .then((m) => m.Entry as unknown as EntryCtor)
      .catch((err: unknown) => {
        this.ctor = null;
        throw new ToolError(
          `The OS credential store is not available (${(err as Error).message}). ` +
            "Set JENKINS_TOKEN instead, or install a Secret Service provider on Linux.",
        );
      });
    const Entry = await this.ctor;
    return new Entry(KEYRING_SERVICE, profile);
  }

  async get(profile: string): Promise<string | null> {
    const entry = await this.entry(profile);
    try {
      return entry.getPassword() ?? null;
    } catch (err) {
      if (/no (matching )?entry|not found/i.test((err as Error).message)) return null;
      throw new ToolError(`Could not read the OS credential store: ${(err as Error).message}`);
    }
  }

  async set(profile: string, token: string): Promise<void> {
    const entry = await this.entry(profile);
    try {
      entry.setPassword(token);
    } catch (err) {
      throw new ToolError(`Could not write the OS credential store: ${(err as Error).message}`);
    }
  }

  async delete(profile: string): Promise<boolean> {
    const entry = await this.entry(profile);
    try {
      return entry.deletePassword();
    } catch (err) {
      if (/no (matching )?entry|not found/i.test((err as Error).message)) return false;
      throw new ToolError(
        `Could not delete from the OS credential store: ${(err as Error).message}`,
      );
    }
  }
}

export class MemoryStore implements CredentialStore {
  readonly tokens = new Map<string, string>();
  async get(profile: string): Promise<string | null> {
    return this.tokens.get(profile) ?? null;
  }
  async set(profile: string, token: string): Promise<void> {
    this.tokens.set(profile, token);
  }
  async delete(profile: string): Promise<boolean> {
    return this.tokens.delete(profile);
  }
}

/** `JENKINS_TOKEN` wins over the store, so CI never touches a keyring. */
export async function resolveToken(
  profile: string,
  env: Record<string, string | undefined>,
  store: CredentialStore,
): Promise<string> {
  if (env.JENKINS_TOKEN) return env.JENKINS_TOKEN;
  const token = await store.get(profile);
  if (!token) {
    throw new ToolError(
      `No API token for profile '${profile}'. Run \`butlerbridge login --profile ${profile}\` or set JENKINS_TOKEN.`,
    );
  }
  return token;
}
