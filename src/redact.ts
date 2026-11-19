export const REDACTED = "[REDACTED]";

/** Per-call tally: rule name → number of values replaced. Never holds the values themselves. */
export type RedactionStats = Map<string, number>;

export function countRedactions(stats: RedactionStats): number {
  let n = 0;
  for (const v of stats.values()) n += v;
  return n;
}

const SENSITIVE_NAME =
  /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key(?:[_-]?id)?|access[_-]?key|authorization|credentials?)$/i;

const KEY_WORDS = String.raw`[A-Za-z0-9_.-]*?(?:password|passwd|secret|token|api[_-]?key|private[_-]?key(?:[_-]?id)?|access[_-]?key)`;

interface Rule {
  name: string;
  re: RegExp;
  /** Returns the replacement, or the match itself to leave it alone. */
  replace: (match: string, ...groups: string[]) => string;
}

const BUILT_IN_RULES: Rule[] = [
  {
    name: "private-key-block",
    re: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END \1PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: () => REDACTED,
  },
  {
    name: "authorization-header",
    re: /\b((?:proxy-)?authorization)(\s*[:=]\s*)(?!\s*\[REDACTED\])[^\r\n"']+/gi,
    replace: (_m, key, sep) => `${key}${sep}${REDACTED}`,
  },
  {
    name: "bearer-token",
    re: /\b(bearer)\s+(?!\[REDACTED\])[A-Za-z0-9\-._~+/]{8,}=*/gi,
    replace: (_m, word) => `${word} ${REDACTED}`,
  },
  {
    name: "basic-credentials",
    re: /\b(basic)\s+([A-Za-z0-9+/]{6,}={0,2})(?![A-Za-z0-9+/=])/gi,
    replace: (m, word, b64) => (looksLikeBasicCredentials(b64) ? `${word} ${REDACTED}` : m),
  },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    replace: () => REDACTED,
  },
  {
    name: "aws-access-key-id",
    re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
    replace: () => REDACTED,
  },
  {
    // key=value / key: value / "key": "value"; the value stops at whitespace, quotes and separators.
    name: "secret-assignment",
    re: new RegExp(String.raw`\b(${KEY_WORDS})\b(["']?\s*[=:]\s*)(["']?)([^\s"'&,;]+)`, "gi"),
    replace: (m, key, sep, quote, value) =>
      value === REDACTED ? m : `${key}${sep}${quote}${REDACTED}`,
  },
  {
    // A long opaque string shortly after a secret-ish word, e.g. "token for deploy: 3fa9…".
    name: "secret-nearby-opaque-string",
    re: /\b(secrets?|tokens?|passwords?|passwd|credentials?|api[ _-]?keys?|private key|access key|auth|bearer)\b([^\n"]{0,40}?)([A-Za-z0-9+/_-]{32,}={0,2})/gi,
    replace: (_m, word, gap) => `${word}${gap}${REDACTED}`,
  },
];

const EMAIL_RULE: Rule = {
  name: "email",
  re: /\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g,
  replace: (m, first, domain) => `${first}***@${domain}`,
};

function looksLikeBasicCredentials(b64: string): boolean {
  try {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    return /^[\x20-\x7e]+:[\x20-\x7e]*$/.test(decoded);
  } catch {
    return false;
  }
}

function bump(stats: RedactionStats | undefined, name: string, by = 1): void {
  if (stats && by > 0) stats.set(name, (stats.get(name) ?? 0) + by);
}

export interface RedactorOptions {
  /** Profile `redactPatterns`, compiled with the `g` flag. Applied after the built-in rules. */
  customPatterns?: RegExp[];
  /** Profile `maskEmails`: `jane.doe@example.com` → `j***@example.com`. */
  maskEmails?: boolean;
}

export class Redactor {
  private readonly known: string[];
  private readonly rules: Rule[];

  /** `knownSecrets` (the token, the encoded basic credentials) are removed verbatim wherever they appear. */
  constructor(knownSecrets: readonly string[] = [], options: RedactorOptions = {}) {
    this.known = knownSecrets.filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
    this.rules = [
      ...BUILT_IN_RULES,
      ...(options.customPatterns ?? []).map((re, i): Rule => ({
        name: `redactPatterns[${i}]`,
        re,
        replace: (m) => (m === "" || m === REDACTED ? m : REDACTED),
      })),
      ...(options.maskEmails ? [EMAIL_RULE] : []),
    ];
  }

  /** Removes only the known secrets. Safe on serialized JSON, unlike the pattern rules. */
  literals(input: string, stats?: RedactionStats): string {
    let out = input;
    for (const literal of this.known) {
      const parts = out.split(literal);
      if (parts.length > 1) {
        bump(stats, "known-secret", parts.length - 1);
        out = parts.join(REDACTED);
      }
    }
    return out;
  }

  text(input: string, stats?: RedactionStats): string {
    let out = this.literals(input, stats);
    for (const rule of this.rules) {
      out = out.replace(rule.re, (...args: unknown[]) => {
        const match = args[0] as string;
        const groups = args
          .slice(1)
          .filter((a): a is string => typeof a === "string" || a === undefined) as string[];
        const replaced = rule.replace(match, ...groups);
        if (replaced !== match) bump(stats, rule.name);
        return replaced;
      });
    }
    return out;
  }

  /** Deep copy with secret-looking strings and values under secret-looking keys redacted. */
  value<T>(input: T, stats?: RedactionStats): T {
    return this.walk(input, stats) as T;
  }

  private walk(input: unknown, stats: RedactionStats | undefined): unknown {
    if (typeof input === "string") return this.text(input, stats);
    if (Array.isArray(input)) return input.map((v) => this.walk(v, stats));
    if (input === null || typeof input !== "object") return input;
    const obj = input as Record<string, unknown>;
    const nameIsSensitive = typeof obj.name === "string" && SENSITIVE_NAME.test(obj.name);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const byParameter = nameIsSensitive && key === "value";
      const sensitive = SENSITIVE_NAME.test(key) || byParameter;
      if (sensitive && typeof value === "string" && value !== "" && value !== REDACTED) {
        bump(stats, byParameter ? "secret-parameter" : "secret-field");
        out[key] = REDACTED;
      } else {
        out[key] = this.walk(value, stats);
      }
    }
    return out;
  }
}
