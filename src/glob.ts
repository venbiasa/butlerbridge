/** `*` and `?` stay inside one path segment; `**` crosses segments. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesAnyGlob(value: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(value));
}

/**
 * Whether a folder may hold something an allowlist admits, so browsing into it is allowed.
 * Conservative: a pattern counts if its literal prefix (before the first wildcard) is compatible.
 */
export function couldContainMatch(folder: string, globs: readonly string[]): boolean {
  const prefix = `${folder}/`;
  return globs.some((g) => {
    if (globToRegExp(g).test(folder)) return true;
    const literal = g.split(/[*?]/, 1)[0] ?? "";
    return literal.startsWith(prefix) || prefix.startsWith(literal);
  });
}
