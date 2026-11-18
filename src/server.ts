import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  failureWithoutSession,
  runTool,
  type Session,
  type SessionOptions,
  createSession,
} from "./runtime.js";
import { TOOLS } from "./tools/index.js";
import { VERSION } from "./version.js";

export function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as { type: "object"; [k: string]: unknown },
    ...(t.outputSchema && {
      outputSchema: t.outputSchema as { type: "object"; [k: string]: unknown },
    }),
    ...(t.annotations && { annotations: t.annotations }),
  }));
}

/**
 * Builds the MCP server. The low-level `Server` is used on purpose: the tool schemas are plain
 * JSON Schema copied from the plugin, which the high-level API (zod shapes) can't express exactly.
 */
export function buildServer(getSession: () => Promise<Session>): Server {
  const server = new Server(
    { name: "butlerbridge", version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    let outcome;
    try {
      outcome = await runTool(await getSession(), req.params.name, req.params.arguments ?? {});
    } catch (err) {
      outcome = failureWithoutSession(err);
    }
    return {
      isError: outcome.isError,
      content: [{ type: "text", text: outcome.text }],
      ...(outcome.structured && { structuredContent: outcome.structured }),
    };
  });
  return server;
}

/** Starts stdio serving. The session is created on the first call, so a missing login still lets the client list tools. */
export async function serve(opts: SessionOptions): Promise<void> {
  let pending: Promise<Session> | null = null;
  const getSession = () => {
    pending ??= createSession(opts).catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
  const server = buildServer(getSession);
  await server.connect(new StdioServerTransport());
}
