import { z } from "zod";
import { confirmField } from "./confirm.js";
import { fixedError } from "./zod-messages.js";

export { confirmField };

const actionError = fixedError("action must be a published Immich operation for this tool");
const pathError = fixedError("path must be 1 to 4096 characters");

export const stringMapField = z
  .record(z.string().min(1).max(100), z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .describe("Path or query parameters keyed by the OpenAPI name.");

export const bodyField = z
  .union([z.record(z.string().min(1).max(100), z.unknown()), z.array(z.unknown())])
  .optional()
  .describe("JSON body for the Immich operation. Secrets are redacted in output.");

export const filePathField = z
  .string()
  .trim()
  .min(1, { error: pathError })
  .max(4096, { error: pathError })
  .optional()
  .describe(
    "Local file to upload as multipart assetData. Confirm-gated. The path is omitted from output.",
  );

export const sidecarPathField = z
  .string()
  .trim()
  .min(1, { error: pathError })
  .max(4096, { error: pathError })
  .optional()
  .describe("Optional local XMP sidecar for asset upload. The path is omitted from output.");

export const savePathField = z
  .string()
  .trim()
  .min(1, { error: pathError })
  .max(4096, { error: pathError })
  .optional()
  .describe(
    "Local path to save a binary download. If omitted, only metadata is returned. The path is omitted from output.",
  );

export const checksumField = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .optional()
  .describe("Optional x-immich-checksum header for asset upload.");

export function actionField(actions: [string, ...string[]]): z.ZodType<string> {
  return z.enum(actions, { error: actionError }).describe("Immich operation to call.");
}

export function toolInputSchema(actions: [string, ...string[]], writes: boolean) {
  const shape = {
    action: actionField(actions),
    params: stringMapField.describe("OpenAPI path parameters, such as id."),
    query: stringMapField.describe("OpenAPI query parameters."),
    body: bodyField,
    file_path: filePathField,
    sidecar_path: sidecarPathField,
    save_path: savePathField,
    checksum: checksumField,
    ...(writes ? { confirm: confirmField } : {}),
  };
  return z.object(shape);
}

export type ToolInput = {
  action: string;
  params?: Readonly<Record<string, string | number | boolean>> | undefined;
  query?: Readonly<Record<string, string | number | boolean>> | undefined;
  body?: unknown;
  file_path?: string | undefined;
  sidecar_path?: string | undefined;
  save_path?: string | undefined;
  checksum?: string | undefined;
  confirm?: true | undefined;
};
