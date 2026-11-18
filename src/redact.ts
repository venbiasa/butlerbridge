export const REDACTED = "[REDACTED]";

const SENSITIVE_NAME =
  /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key(?:[_-]?id)?|access[_-]?key|authorization|credentials?)$/i;

const KEY_WORDS = String.raw`[A-Za-z0-9_.-]*?(?:password|passwd|secret|token|api[_-]?key|private[_-]?key(?:[_-]?id)?|access[_-]?key)`;

interface Rule {
  re: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const RULES: Rule[] = [
  {
    re: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END \1PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: () => REDACTED,
  },
  {
    re: /\b((?:proxy-)?authorization)(\s*[:=]\s*)[^\r\n"']+/gi,
    replace: (_m, key, sep) => `${key}${sep}${REDACTED}`,
  },
  {
    re: /\b(bearer)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi,
    replace: (_m, word) => `${word} ${REDACTED}`,
  },
  {
    re: /\b(basic)\s+([A-Za-z0-9+/]{6,}={0,2})(?![A-Za-z0-9+/=])/gi,
    replace: (m, word, b64) => (looksLikeBasicCredentials(b64) ? `${word} ${REDACTED}` : m),
  },
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    replace: () => REDACTED,
  },
  {
    re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
    replace: () => REDACTED,
  },
  {
    // key=value / key: value / "key": "value"; the value stops at whitespace, quotes and separators.
    re: new RegExp(String.raw`\b(${KEY_WORDS})\b(["']?\s*[=:]\s*)(["']?)([^\s"'&,;]+)`, "gi"),
    replace: (m, key, sep, quote, value) =>
      value === REDACTED ? m : `${key}${sep}${quote}${REDACTED}`,
  },
  {
    // A long opaque string shortly after a secret-ish word, e.g. "token for deploy: 3fa9…".
    re: /\b(secrets?|tokens?|passwords?|passwd|credentials?|api[ _-]?keys?|private key|access key|auth|bearer)\b([^\n"]{0,40}?)([A-Za-z0-9+/_-]{32,}={0,2})/gi,
    replace: (_m, word, gap) => `${word}${gap}${REDACTED}`,
  },
];

function looksLikeBasicCredentials(b64: string): boolean {
  try {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    return /^[\x20-\x7e]+:[\x20-\x7e]*$/.test(decoded);
  } catch {
    return false;
  }
}

export class Redactor {
  private readonly known: string[];

  /** `knownSecrets` (the token, the encoded basic credentials) are removed verbatim wherever they appear. */
  constructor(knownSecrets: readonly string[] = []) {
    this.known = knownSecrets.filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  }

  /** Removes only the known secrets. Safe on serialized JSON, unlike the pattern rules. */
  literals(input: string): string {
    let out = input;
    for (const literal of this.known) out = out.split(literal).join(REDACTED);
    return out;
  }

  text(input: string): string {
    let out = this.literals(input);
    for (const rule of RULES) {
      out = out.replace(rule.re, rule.replace as (substring: string, ...args: unknown[]) => string);
    }
    return out;
  }

  /** Deep copy with secret-looking strings and values under secret-looking keys redacted. */
  value<T>(input: T): T {
    return this.walk(input) as T;
  }

  private walk(input: unknown): unknown {
    if (typeof input === "string") return this.text(input);
    if (Array.isArray(input)) return input.map((v) => this.walk(v));
    if (input === null || typeof input !== "object") return input;
    const obj = input as Record<string, unknown>;
    const nameIsSensitive = typeof obj.name === "string" && SENSITIVE_NAME.test(obj.name);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const sensitive = SENSITIVE_NAME.test(key) || (nameIsSensitive && key === "value");
      out[key] =
        sensitive && typeof value === "string" && value !== "" ? REDACTED : this.walk(value);
    }
    return out;
  }
}
