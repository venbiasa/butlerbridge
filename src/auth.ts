/**
 * Adds credentials to outgoing requests. Several providers can be stacked, e.g. a future
 * proxy provider (`Proxy-Authorization: Bearer <id token>`) in front of Jenkins basic auth.
 */
export interface AuthProvider {
  apply(headers: Headers, url: URL): Promise<void>;
  /** Called after a 401 or 407. Return true when credentials were refreshed and a retry makes sense. */
  refresh?(status: number): Promise<boolean>;
  /** Values that must never appear in output; the redactor removes them verbatim. */
  secrets(): string[];
}

export class BasicAuth implements AuthProvider {
  private readonly header: string;
  private readonly encoded: string;

  constructor(
    user: string,
    private readonly token: string,
  ) {
    this.encoded = Buffer.from(`${user}:${token}`, "utf8").toString("base64");
    this.header = `Basic ${this.encoded}`;
  }

  async apply(headers: Headers): Promise<void> {
    headers.set("Authorization", this.header);
  }

  secrets(): string[] {
    return [this.token, this.encoded];
  }
}

export class ChainAuth implements AuthProvider {
  constructor(private readonly providers: AuthProvider[]) {}

  async apply(headers: Headers, url: URL): Promise<void> {
    for (const p of this.providers) await p.apply(headers, url);
  }

  async refresh(status: number): Promise<boolean> {
    let refreshed = false;
    for (const p of this.providers) {
      if (p.refresh && (await p.refresh(status))) refreshed = true;
    }
    return refreshed;
  }

  secrets(): string[] {
    return this.providers.flatMap((p) => p.secrets());
  }
}
