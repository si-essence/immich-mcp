import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolDescription, toolName } from "./brand.js";
import { callImmich } from "./call.js";
import { CONNECTOR_NAME, CONNECTOR_TITLE, CONNECTOR_VERSION } from "./constants.js";
import { ConnectorError } from "./errors.js";
import { toolInputSchema, type ToolInput } from "./fields.js";
import { operationsForTool, toolsForToolsets, type Operation } from "./operations.js";
import type { Runtime } from "./runtime.js";
import {
  READ_ONLY_REMOTE,
  WRITE_DESTRUCTIVE,
  WRITE_NON_IDEMPOTENT,
  registerConnectorTool,
  type ToolAnnotations,
  type ToolContext,
} from "./tools.js";

export function createServer(runtime: Runtime): McpServer {
  const server = new McpServer({
    name: CONNECTOR_NAME,
    title: CONNECTOR_TITLE,
    version: CONNECTOR_VERSION,
  });
  const ctx: ToolContext = { secrets: runtime.secrets, logger: runtime.logger };
  for (const name of toolsForToolsets(runtime.config.toolsets)) {
    publishTool(server, ctx, runtime, name);
  }
  return server;
}

function publishTool(server: McpServer, ctx: ToolContext, runtime: Runtime, name: string): void {
  const operations = operationsForTool(name);
  const first = operations[0];
  if (first === undefined) return;
  const actions = operations.map((operation) => operation.action);
  const head = actions[0];
  if (head === undefined) return;
  const writes = operations.some((operation) => operation.write);
  const destructive = operations.some((operation) => operation.destructive);
  const annotations: ToolAnnotations = writes
    ? destructive
      ? WRITE_DESTRUCTIVE
      : WRITE_NON_IDEMPOTENT
    : READ_ONLY_REMOTE;
  const inputSchema = toolInputSchema([head, ...actions.slice(1)], writes);
  const description = describeTool(name, first.toolset, operations, writes);
  registerConnectorTool(
    server,
    {
      name: toolName(name),
      description: toolDescription(description),
      inputSchema,
      annotations,
      handler: (args) => handleTool(runtime, name, toInput({ ...args })),
    },
    ctx,
  );
}

async function handleTool(
  runtime: Runtime,
  tool: string,
  args: ToolInput,
): Promise<Record<string, unknown>> {
  const operation = operationsForTool(tool).find((row) => row.action === args.action);
  if (operation === undefined) {
    throw new ConnectorError("input", `Unknown Immich action ${args.action}.`);
  }
  return callImmich(runtime, operation, {
    params: args.params,
    query: args.query,
    body: args.body,
    filePath: args.file_path,
    sidecarPath: args.sidecar_path,
    savePath: args.save_path,
    checksum: args.checksum,
    confirm: args.confirm,
  });
}

function toInput(args: Record<string, unknown>): ToolInput {
  const action = args["action"];
  if (typeof action !== "string") {
    throw new ConnectorError("input", "action is required.");
  }
  const confirm = args["confirm"];
  return {
    action,
    params: asStringMap(args["params"]),
    query: asStringMap(args["query"]),
    body: args["body"],
    file_path: asOptionalString(args["file_path"]),
    sidecar_path: asOptionalString(args["sidecar_path"]),
    save_path: asOptionalString(args["save_path"]),
    checksum: asOptionalString(args["checksum"]),
    confirm: confirm === true ? true : undefined,
  };
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringMap(
  value: unknown,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      out[key] = entry;
    }
  }
  return out;
}

function describeTool(
  name: string,
  toolset: string,
  operations: readonly Operation[],
  writes: boolean,
): string {
  const lines = operations.map(
    (operation) =>
      `${operation.action}: ${operation.method} ${operation.path}. ${operation.summary}`,
  );
  const gate = writes
    ? " Writes need confirm:true and IMMICH_ALLOW_WRITES=true. Omit confirm for a dry-run preview."
    : "";
  const listed = lines.join(" ");
  return `${name} covers the ${toolset} toolset (${operations.length} operations). Auth header x-api-key.${gate} Actions: ${listed}`;
}
