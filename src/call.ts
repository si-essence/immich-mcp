import { ConnectorError } from "./errors.js";
import { definedQuery, fillOpenApiPath, jsonValueSchema, toResult } from "./json.js";
import { assertSavePath, readLocalUpload } from "./files.js";
import { stripPathsInText } from "./parse.js";
import type { QueryMap } from "./http.js";
import type { Operation } from "./operations.js";
import type { Runtime } from "./runtime.js";
import { withWrite } from "./write-gate.js";

export interface CallArgs {
  readonly params?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly query?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly body?: unknown;
  readonly filePath?: string | undefined;
  readonly sidecarPath?: string | undefined;
  readonly savePath?: string | undefined;
  readonly checksum?: string | undefined;
  readonly confirm?: true | undefined;
}

function asQuery(
  record: Readonly<Record<string, string | number | boolean>> | undefined,
): QueryMap | undefined {
  if (record === undefined) return undefined;
  const mapped: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(record)) mapped[key] = value;
  return definedQuery(mapped);
}

function asParams(
  record: Readonly<Record<string, string | number | boolean>> | undefined,
): Record<string, string | number> {
  if (record === undefined) return {};
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "boolean") out[key] = String(value);
    else out[key] = value;
  }
  return out;
}

export async function callImmich(
  runtime: Runtime,
  operation: Operation,
  args: CallArgs = {},
): Promise<Record<string, unknown>> {
  const path = fillOpenApiPath(operation.path, asParams(args.params));
  const query = asQuery(args.query);
  const ttlSec = operation.write ? 0 : runtime.cacheTtlSec;

  const run = async (): Promise<Record<string, unknown>> => {
    return execute(runtime, operation, path, query, args, ttlSec);
  };

  if (!operation.write) return run();

  const previewBody =
    operation.kind === "multipart"
      ? {
          multipart: true,
          filename: args.filePath === undefined ? null : "omitted-local-file",
          sidecar: args.sidecarPath !== undefined,
        }
      : args.body;

  return withWrite(
    runtime,
    args.confirm,
    {
      method: operation.method,
      path,
      query,
      body: previewBody,
      summary: operation.summary,
      warnings: operation.warnings,
    },
    run,
  );
}

async function execute(
  runtime: Runtime,
  operation: Operation,
  path: string,
  query: QueryMap | undefined,
  args: CallArgs,
  ttlSec: number,
): Promise<Record<string, unknown>> {
  if (operation.kind === "file") {
    const savePath = args.savePath === undefined ? undefined : assertSavePath(args.savePath);
    const file = await runtime.client.download({
      path,
      query,
      savePath,
      method: operation.method,
      body: operation.method === "GET" ? undefined : (args.body ?? {}),
    });
    return {
      content_type: file.contentType,
      content_length: file.contentLength,
      filename: file.filename,
      included_text: file.includedText === null ? null : stripPathsInText(file.includedText),
      omitted_reason: file.omittedReason,
      saved: file.saved,
      bytes_written: file.bytesWritten,
    };
  }

  if (operation.kind === "multipart") {
    if (args.filePath === undefined) {
      throw new ConnectorError("input", "file_path is required for this upload.");
    }
    const file = readLocalUpload(args.filePath);
    const sidecar = args.sidecarPath === undefined ? undefined : readLocalUpload(args.sidecarPath);
    const fields: Record<string, string> = {};
    if (args.body !== null && typeof args.body === "object" && !Array.isArray(args.body)) {
      for (const [key, value] of Object.entries(args.body)) {
        if (value === undefined || key === "assetData" || key === "sidecarData") continue;
        fields[key] = typeof value === "string" ? value : JSON.stringify(value);
      }
    }
    if (fields["fileCreatedAt"] === undefined) {
      fields["fileCreatedAt"] = new Date().toISOString();
    }
    if (fields["fileModifiedAt"] === undefined) {
      fields["fileModifiedAt"] = new Date().toISOString();
    }
    if (fields["filename"] === undefined) fields["filename"] = file.filename;
    const sent = await runtime.client.postMultipart({
      path,
      query,
      fields,
      file: { filename: file.filename, bytes: file.bytes, field: fileFieldFor(operation) },
      sidecar:
        sidecar === undefined ? undefined : { filename: sidecar.filename, bytes: sidecar.bytes },
      checksum: args.checksum,
    });
    return sent;
  }

  if (operation.kind === "empty") {
    if (operation.method === "POST") {
      if (args.body === undefined) {
        const sent = await runtime.client.postEmpty({ path, query });
        return { status: sent.status, body: sent.body };
      }
      const json = await runtime.client.postJson({ path, query, body: args.body }, jsonValueSchema);
      return toResult(json);
    }
    if (operation.method === "PUT") {
      if (args.body === undefined) {
        const sent = await runtime.client.putEmpty({ path, query });
        return { status: sent.status, body: sent.body };
      }
      const json = await runtime.client.putJson({ path, query, body: args.body }, jsonValueSchema);
      return toResult(json);
    }
    if (operation.method === "PATCH") {
      if (args.body === undefined) {
        const sent = await runtime.client.patchEmpty({ path, query });
        return { status: sent.status, body: sent.body };
      }
      const json = await runtime.client.patchJson(
        { path, query, body: args.body },
        jsonValueSchema,
      );
      return toResult(json);
    }
    if (args.body === undefined) {
      const sent = await runtime.client.delete({ path, query });
      return { status: sent.status, body: sent.body };
    }
    const json = await runtime.client.deleteJson({ path, query, body: args.body }, jsonValueSchema);
    return toResult(json);
  }

  if (operation.method === "GET") {
    const json = await runtime.client.getJson({ path, query, ttlSec }, jsonValueSchema);
    return toResult(json);
  }
  if (operation.method === "POST") {
    const json = await runtime.client.postJson(
      { path, query, body: args.body ?? {} },
      jsonValueSchema,
    );
    return toResult(json);
  }
  if (operation.method === "PUT") {
    const json = await runtime.client.putJson(
      { path, query, body: args.body ?? {} },
      jsonValueSchema,
    );
    return toResult(json);
  }
  if (operation.method === "PATCH") {
    const json = await runtime.client.patchJson(
      { path, query, body: args.body ?? {} },
      jsonValueSchema,
    );
    return toResult(json);
  }
  const json = await runtime.client.deleteJson(
    { path, query, body: args.body ?? {} },
    jsonValueSchema,
  );
  return toResult(json);
}

function fileFieldFor(operation: Operation): string {
  if (operation.operationId === "uploadDatabaseBackup") return "file";
  if (operation.operationId === "createProfileImage") return "file";
  return "assetData";
}
