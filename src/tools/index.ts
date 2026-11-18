import { coreTools } from "./core.js";
import { logTools } from "./logs.js";
import { scmTools } from "./scm.js";
import { systemLogTools } from "./systemLog.js";
import { testTools } from "./tests.js";
import type { ToolDef } from "./types.js";

export const TOOLS: readonly ToolDef[] = [
  ...coreTools,
  ...logTools,
  ...scmTools,
  ...testTools,
  ...systemLogTools,
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}
