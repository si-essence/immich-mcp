#!/usr/bin/env node
/**
 * Generate src/operations.ts from immich.openapi.json.
 * Run: node scripts/gen-operations.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(root, "immich.openapi.json"), "utf8"));

/** @type {Record<string, string>} */
const TAG_TO_TOOLSET = {
  Activities: "activities",
  Albums: "albums",
  "API keys": "api-keys",
  Assets: "assets",
  "Asset files": "assets",
  Authentication: "sessions",
  "Authentication (admin)": "admin",
  "Cluster groups": "cluster-groups",
  "Config (user)": "users",
  "Config (admin)": "admin",
  "Config (public)": "server",
  "Database Backups (admin)": "admin",
  Download: "assets",
  Duplicates: "assets",
  Faces: "people",
  "Integrity (admin)": "admin",
  Jobs: "jobs",
  Libraries: "libraries",
  "Maintenance (admin)": "admin",
  Map: "search",
  Memories: "memories",
  Notifications: "notifications",
  "Notifications (admin)": "admin",
  Partners: "partners",
  Passkeys: "sessions",
  People: "people",
  Plugins: "plugins",
  Queues: "jobs",
  Search: "search",
  Server: "server",
  Sessions: "sessions",
  "Shared links": "shared-links",
  Stacks: "assets",
  Sync: "sync",
  "System config": "admin",
  "System metadata": "admin",
  Tags: "tags",
  Timeline: "search",
  Trash: "trash",
  "Users (admin)": "admin",
  Users: "users",
  Views: "search",
  Workflows: "workflows",
};

const DEFAULT_TOOLSETS = ["assets", "albums", "people", "search", "server"];

const READ_ONLY_NON_GET = new Set([
  "searchLargeAssets",
  "searchAssets",
  "searchRandom",
  "searchSmart",
  "searchAssetStatistics",
  "checkBulkUpload",
  "getDownloadInfo",
  "getNotificationTemplateAdmin",
  "validate",
  "validateAccessToken",
  "getSyncStream",
  "downloadArchive",
]);

const HTTP = new Set(["get", "post", "put", "patch", "delete"]);

/**
 * @param {string} id
 */
function toAction(id) {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * @param {string} toolset
 */
function toolNameFor(toolset) {
  return `immich_${toolset.replace(/-/g, "_")}`;
}

/**
 * @param {string} operationId
 * @param {string} method
 * @param {string} path
 * @param {string} tag
 */
function warningsFor(operationId, method, path, tag) {
  /** @type {string[]} */
  const out = [];
  if (method === "DELETE") {
    out.push("This deletes data on the Immich server. It may be irreversible.");
  }
  if (operationId === "emptyTrash") {
    out.push("Emptying trash permanently deletes trashed assets.");
  }
  if (
    operationId === "deleteUserAdmin" ||
    operationId === "deletePeople" ||
    operationId === "deletePerson"
  ) {
    out.push("User or person deletion can remove access and associated records.");
  }
  if (operationId === "scanLibrary") {
    out.push("A library scan can take a long time and change which files Immich indexes.");
  }
  if (operationId === "deleteLibrary") {
    out.push(
      "Removing a library drops its index. External files on disk are not deleted by this API, but the library is gone.",
    );
  }
  if (
    operationId === "deleteApiKey" ||
    operationId === "rotateApiKey" ||
    operationId === "createApiKey"
  ) {
    out.push(
      "API key create, rotate, or revoke changes credentials. The new secret is redacted in output.",
    );
  }
  if (
    operationId === "deleteSession" ||
    operationId === "deleteAllSessions" ||
    operationId === "logout" ||
    operationId === "endSession"
  ) {
    out.push("Session revoke signs a client out. Active uploads or playback may stop.");
  }
  if (operationId === "createSharedLink") {
    out.push("Creating a shared link can expose albums or assets to anyone who has the link.");
  }
  if (
    operationId === "updateAdminConfig" ||
    operationId === "updateConfig" ||
    operationId === "setMaintenanceMode" ||
    operationId === "startDatabaseRestoreFlow" ||
    operationId === "uploadDatabaseBackup" ||
    operationId === "deleteDatabaseBackup" ||
    operationId === "unlinkAllOAuthAccountsAdmin"
  ) {
    out.push("This changes admin or system configuration. Misconfiguration can lock the instance.");
  }
  if (tag.includes("(admin)") && method !== "GET" && !READ_ONLY_NON_GET.has(operationId)) {
    if (!out.some((line) => line.includes("admin or system"))) {
      out.push("This is an admin write. It can affect every user on the server.");
    }
  }
  if (path.includes("/trash") && method !== "GET") {
    if (operationId !== "emptyTrash") {
      out.push("Trash operations change whether assets can be recovered.");
    }
  }
  return [...new Set(out)];
}

/**
 * @param {string} operationId
 * @param {string} method
 * @param {object} op
 */
function responseKind(operationId, method, op) {
  const content = op.requestBody?.content ?? {};
  if (Object.keys(content).some((key) => key.includes("multipart"))) return "multipart";
  const ok = op.responses?.["200"] ?? op.responses?.["201"] ?? op.responses?.["204"] ?? {};
  const out = ok.content ?? {};
  const keys = Object.keys(out);
  if (
    keys.some(
      (key) =>
        key.startsWith("image/") ||
        key.startsWith("video/") ||
        key.includes("octet") ||
        key.includes("zip") ||
        key.includes("binary"),
    )
  ) {
    return "file";
  }
  if (operationId === "downloadArchive") return "file";
  if (
    !keys.length &&
    (method === "DELETE" || method === "PUT" || method === "POST" || method === "PATCH")
  ) {
    return "empty";
  }
  return "json";
}

/**
 * @param {string} name
 */
function sampleForParam(name) {
  const lower = name.toLowerCase();
  if (lower === "filename") return "backup.sql";
  if (lower === "type") return "orphan";
  if (lower === "name") return "album-invite";
  if (lower === "variantindex") return "0";
  if (lower.includes("id") || lower === "key" || lower === "slug") {
    return "00000000-0000-4000-a000-000000000001";
  }
  return "sample";
}

/**
 * @param {unknown} schema
 * @returns {unknown}
 */
function sampleFromSchema(schema) {
  if (!schema || typeof schema !== "object") return {};
  const node = /** @type {Record<string, unknown>} */ (schema);
  if (typeof node.$ref === "string") {
    const name = node.$ref.split("/").pop();
    if (name && spec.components?.schemas?.[name]) {
      return sampleFromSchema(spec.components.schemas[name]);
    }
    return {};
  }
  if (Array.isArray(node.allOf) && node.allOf[0]) return sampleFromSchema(node.allOf[0]);
  if (Array.isArray(node.oneOf) && node.oneOf[0]) return sampleFromSchema(node.oneOf[0]);
  if (node.type === "array") return [sampleFromSchema(node.items ?? { type: "string" })];
  if (node.type === "integer" || node.type === "number") return 1;
  if (node.type === "boolean") return true;
  if (node.type === "string") {
    if (node.format === "uuid") return "00000000-0000-4000-a000-000000000001";
    if (node.format === "date-time") return "2026-01-01T00:00:00.000Z";
    if (node.enum && Array.isArray(node.enum) && typeof node.enum[0] === "string")
      return node.enum[0];
    return "sample";
  }
  if (node.type === "object" || node.properties) {
    const required = Array.isArray(node.required) ? node.required : [];
    const properties = /** @type {Record<string, unknown>} */ (node.properties ?? {});
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of required) {
      if (key === "assetData" || key === "sidecarData") continue;
      out[key] = sampleFromSchema(properties[key]);
    }
    if (required.includes("ids") && out.ids === undefined) {
      out.ids = ["00000000-0000-4000-a000-000000000001"];
    }
    if (required.includes("albumName") || properties.albumName) {
      out.albumName = out.albumName ?? "mcp-live-album";
    }
    if (required.includes("name") && out.name === undefined) out.name = "mcp-live";
    return out;
  }
  return {};
}

/**
 * @param {object} op
 */
function sampleBody(op) {
  const content = op.requestBody?.content;
  if (!content) return undefined;
  const json = content["application/json"]?.schema;
  if (json) return sampleFromSchema(json);
  return undefined;
}

const METHODS = ["get", "post", "put", "patch", "delete"];
/** @type {object[]} */
const rows = [];
const seenActions = new Map();

for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    if (!HTTP.has(method)) continue;
    const tag = (op.tags && op.tags[0]) || "untagged";
    const toolset = TAG_TO_TOOLSET[tag];
    if (!toolset) {
      throw new Error(`Unmapped Immich tag ${tag} on ${method.toUpperCase()} ${path}`);
    }
    const operationId = op.operationId;
    if (typeof operationId !== "string" || operationId.length === 0) {
      throw new Error(`Missing operationId for ${method.toUpperCase()} ${path}`);
    }
    let action = toAction(operationId);
    const actionKey = `${toolset}::${action}`;
    if (seenActions.has(actionKey)) {
      action = `${action}_${method}`;
    }
    seenActions.set(`${toolset}::${action}`, operationId);

    const allParams = [...(item.parameters || []), ...(op.parameters || [])];
    const pathParams = [];
    const queryParams = [];
    const headerParams = [];
    const sampleParams = {};
    const sampleQuery = {};
    for (const param of allParams) {
      if (!param || typeof param !== "object") continue;
      if (param.in === "path") {
        pathParams.push(param.name);
        sampleParams[param.name] = sampleForParam(param.name);
      } else if (param.in === "query") {
        queryParams.push(param.name);
        if (param.required) sampleQuery[param.name] = sampleForParam(param.name);
      } else if (param.in === "header") {
        headerParams.push(param.name);
      }
    }

    const write = method === "get" ? false : !READ_ONLY_NON_GET.has(operationId);
    const kind = responseKind(operationId, method, op);
    const destructive =
      method === "delete" ||
      operationId === "emptyTrash" ||
      operationId === "deleteLibrary" ||
      operationId === "deleteUserAdmin" ||
      operationId === "emptyQueue";
    const body = sampleBody(op);

    rows.push({
      method: method.toUpperCase(),
      path,
      operationId,
      action,
      tool: toolNameFor(toolset),
      toolset,
      tag,
      write,
      destructive,
      kind,
      summary: String(op.summary || operationId)
        .replace(/\s+/g, " ")
        .trim(),
      pathParams,
      queryParams,
      extraHeaders: headerParams,
      warnings: warningsFor(operationId, method.toUpperCase(), path, tag),
      sampleParams,
      sampleQuery,
      sampleBody: body,
    });
  }
}

rows.sort((a, b) => {
  const tool = a.tool.localeCompare(b.tool);
  if (tool !== 0) return tool;
  const action = a.action.localeCompare(b.action);
  if (action !== 0) return action;
  return `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`);
});

if (rows.length !== 287) {
  console.warn(`Expected 287 operations, generated ${rows.length}`);
}

const toolsets = [...new Set(rows.map((row) => row.toolset))].sort();
/** @type {Record<string, { operations: number, tags: string[] }>} */
const counts = {};
for (const toolset of toolsets) {
  const subset = rows.filter((row) => row.toolset === toolset);
  counts[toolset] = {
    operations: subset.length,
    tags: [...new Set(subset.map((row) => row.tag))].sort(),
  };
}

/**
 * @param {unknown} value
 */
function ts(value) {
  return JSON.stringify(value);
}

/**
 * @param {object} row
 */
function emitRow(row) {
  const options = [
    `action: ${ts(row.action)}`,
    `toolset: ${ts(row.toolset)}`,
    `tag: ${ts(row.tag)}`,
    `operationId: ${ts(row.operationId)}`,
    `write: ${row.write}`,
    `destructive: ${row.destructive}`,
    `kind: ${ts(row.kind)}`,
    `summary: ${ts(row.summary)}`,
    `pathParams: ${ts(row.pathParams)}`,
    `queryParams: ${ts(row.queryParams)}`,
    `extraHeaders: ${ts(row.extraHeaders)}`,
    `warnings: ${ts(row.warnings)}`,
    `sampleParams: ${ts(row.sampleParams)}`,
    `sampleQuery: ${ts(row.sampleQuery)}`,
  ];
  if (row.sampleBody !== undefined) options.push(`sampleBody: ${ts(row.sampleBody)}`);
  return `  row(${ts(row.method)}, ${ts(row.path)}, ${ts(row.tool)}, {\n    ${options.join(",\n    ")},\n  })`;
}

const header = `/** Generated by scripts/gen-operations.mjs from immich.openapi.json. Do not edit by hand. */

import { ConnectorError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ResponseKind = "json" | "empty" | "file" | "multipart";

export interface Operation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly tool: string;
  readonly action: string;
  readonly toolset: string;
  readonly tag: string;
  readonly operationId: string;
  readonly write: boolean;
  readonly destructive: boolean;
  readonly kind: ResponseKind;
  readonly summary: string;
  readonly pathParams: readonly string[];
  readonly queryParams: readonly string[];
  readonly extraHeaders: readonly string[];
  readonly warnings: readonly string[];
  readonly sampleParams: Readonly<Record<string, string>>;
  readonly sampleQuery: Readonly<Record<string, string>>;
  readonly sampleBody: unknown;
}

function row(
  method: HttpMethod,
  path: string,
  tool: string,
  options: {
    action: string;
    toolset: string;
    tag: string;
    operationId: string;
    write: boolean;
    destructive: boolean;
    kind: ResponseKind;
    summary: string;
    pathParams: readonly string[];
    queryParams: readonly string[];
    extraHeaders: readonly string[];
    warnings: readonly string[];
    sampleParams: Readonly<Record<string, string>>;
    sampleQuery: Readonly<Record<string, string>>;
    sampleBody?: unknown;
  },
): Operation {
  return {
    method,
    path,
    tool,
    action: options.action,
    toolset: options.toolset,
    tag: options.tag,
    operationId: options.operationId,
    write: options.write,
    destructive: options.destructive,
    kind: options.kind,
    summary: options.summary,
    pathParams: options.pathParams,
    queryParams: options.queryParams,
    extraHeaders: options.extraHeaders,
    warnings: options.warnings,
    sampleParams: options.sampleParams,
    sampleQuery: options.sampleQuery,
    sampleBody: options.sampleBody,
  };
}

export const DEFAULT_TOOLSETS = ${ts(DEFAULT_TOOLSETS)} as const;

export const ALL_TOOLSETS = ${ts(toolsets)} as const;

export const TOOLSET_COUNTS: Readonly<
  Record<string, { readonly operations: number; readonly tags: readonly string[] }>
> = ${ts(counts)};

export const OPERATIONS: readonly Operation[] = [
${rows.map(emitRow).join(",\n")},
];

export function toolNames(): string[] {
  return [...new Set(OPERATIONS.map((operation) => operation.tool))].sort();
}

export function operationsForTool(name: string): Operation[] {
  return OPERATIONS.filter((operation) => operation.tool === name);
}

export function toolIsWrite(name: string): boolean {
  return OPERATIONS.some((operation) => operation.tool === name && operation.write);
}

export function openApiKeys(): string[] {
  return OPERATIONS.map((operation) => \`\${operation.method} \${operation.path}\`).sort();
}

export function requireOp(tool: string, action: string): Operation {
  const found = OPERATIONS.find((operation) => operation.tool === tool && operation.action === action);
  if (found === undefined) {
    throw new ConnectorError("input", \`Unknown Immich operation \${tool} \${action}.\`);
  }
  return found;
}

export function parseToolsets(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_TOOLSETS];
  const trimmed = raw.trim();
  if (trimmed === "all") return [...ALL_TOOLSETS];
  const wanted = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const allowed = new Set<string>(ALL_TOOLSETS);
  const unknown = wanted.filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new ConnectorError("config", "Unknown IMMICH_TOOLSETS value.");
  }
  return [...new Set(wanted)];
}

export function toolsForToolsets(enabled: readonly string[]): string[] {
  const allow = new Set(enabled);
  return toolNames().filter((name) => {
    const operation = OPERATIONS.find((row) => row.tool === name);
    return operation !== undefined && allow.has(operation.toolset);
  });
}
`;

writeFileSync(join(root, "src/operations.ts"), header);
console.log(
  `wrote src/operations.ts (${rows.length} operations, ${toolsets.length} toolsets, default ${DEFAULT_TOOLSETS.length})`,
);
