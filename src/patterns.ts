import { ToolError } from "./errors.js";

export const MAX_PATTERN_LENGTH = 1_000;

/** Patterns like `(a+)+` backtrack exponentially and JavaScript regexes can't be interrupted. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,\d*\})/;

/**
 * Compiles a regex that came from a user or a model. Accepts a leading Java-style `(?i)` / `(?s)`,
 * caps the length, and refuses nested quantifiers.
 */
export function compileUserRegex(pattern: string, what: string, extraFlags = ""): RegExp {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new ToolError(
      `${what} is too long: ${pattern.length} characters, the maximum is ${MAX_PATTERN_LENGTH}`,
    );
  }
  let source = pattern;
  let flags = extraFlags;
  const inline = /^\(\?([imsx]+)\)/.exec(source);
  if (inline) {
    source = source.slice(inline[0].length);
    for (const f of inline[1] as string)
      if ((f === "i" || f === "s") && !flags.includes(f)) flags += f;
  }
  if (NESTED_QUANTIFIER.test(source)) {
    throw new ToolError(
      `${what} is too expensive: nested quantifiers like (a+)+ can take exponential time.` +
        " Try a simpler pattern, or plain text.",
    );
  }
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new ToolError(`${what} is not a valid regular expression: ${(err as Error).message}`);
  }
}
