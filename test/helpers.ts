import { BasicAuth } from "../src/auth.js";
import { DEFAULTS, type ResolvedProfile } from "../src/config.js";
import type { FetchFn } from "../src/http.js";
import { sessionFor, type Session } from "../src/runtime.js";

export const BASE = "https://ci.example.test";
export const USER = "alice";
export const TOKEN = "11aa22bb33cc44dd55ee66ff77889900ab";

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export type Reply =
  Response | object | string | number | ((call: Call) => Response | Promise<Response>);

/**
 * Fake Jenkins. Routes are `"METHOD /path"` (no query). A number answers with that status; an
 * object or string with a 200 JSON/text body; a function gets the call.
 */
export function mockJenkins(routes: Record<string, Reply>) {
  const calls: Call[] = [];
  const fetch: FetchFn = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined || init.body === null ? "" : String(init.body);
    const call = { method, url, headers, body };
    calls.push(call);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const reply = routes[`${method} ${url.pathname}`];
    if (reply === undefined) return new Response("not found", { status: 404 });
    if (typeof reply === "function") return reply(call);
    if (reply instanceof Response) return reply.clone();
    if (typeof reply === "number") {
      const noBody = reply === 204 || reply === 304;
      return new Response(noBody ? null : `status ${reply}`, { status: reply });
    }
    if (typeof reply === "string") return new Response(reply, { status: 200 });
    return json(reply);
  };
  return { fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function profile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    name: "test",
    url: BASE,
    user: USER,
    allowWrite: false,
    jobAllowlist: null,
    timeoutMs: 2_000,
    maxResultChars: DEFAULTS.maxResultChars,
    maxTestCases: DEFAULTS.maxTestCases,
    triggerWaitMs: 0,
    allowInsecureHttp: false,
    redactPatterns: [],
    maskEmails: false,
    collapseRepeats: false,
    compactSearch: false,
    source: "config",
    ...overrides,
  };
}

export function session(fetch: FetchFn, overrides: Partial<ResolvedProfile> = {}): Session {
  return sessionFor(profile(overrides), new BasicAuth(USER, TOKEN), fetch);
}

export function parse(text: string): {
  status: string;
  message: string;
  result?: unknown;
  truncatedResult?: string;
} {
  return JSON.parse(text);
}

/** A text body delivered in several chunks, with progressiveText headers. */
export function streamedLog(
  chunks: string[],
  opts: { textSize?: number; more?: boolean; onPull?: () => void } = {},
): Response {
  let i = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      opts.onPull?.();
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++] as string));
      else controller.close();
    },
  });
  const headers: Record<string, string> = {
    "Content-Type": "text/plain",
    "X-Text-Size": String(opts.textSize ?? chunks.join("").length),
  };
  if (opts.more) headers["X-More-Data"] = "true";
  return new Response(stream, { status: 200, headers });
}

export function logLines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
}
