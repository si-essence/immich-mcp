import { z } from "zod";
import { API_PREFIX } from "./constants.js";
import { ConnectorError } from "./errors.js";
import type { QueryMap, QueryValue } from "./http.js";

export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const jsonValueSchema = z.unknown();

export function toResult(value: unknown): Record<string, unknown> {
  const asObject = jsonObjectSchema.safeParse(value);
  if (asObject.success) return asObject.data;
  if (Array.isArray(value)) return { items: value };
  if (typeof value === "string") return { text: value };
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { value };
  }
  return { value: null };
}

export function definedQuery(
  record: Readonly<Record<string, QueryValue | undefined>>,
): QueryMap | undefined {
  const out: Record<string, QueryValue> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function definedBody(
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function apiPath(...parts: string[]): string {
  return [API_PREFIX, ...parts].join("/");
}

const PATH_PARAM = /\{([^}]+)\}/g;

export function fillOpenApiPath(
  openApiPath: string,
  params: Readonly<Record<string, string | number>>,
): string {
  if (!openApiPath.startsWith("/")) {
    throw new ConnectorError("input", "OpenAPI path must start with /.");
  }
  const filled = openApiPath.replace(PATH_PARAM, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") {
      throw new ConnectorError("input", `Missing path parameter ${name}.`);
    }
    return encodeURIComponent(String(value));
  });
  if (filled.includes("{") || filled.includes("}")) {
    throw new ConnectorError("input", "Request path still contains a template marker.");
  }
  return apiPath(...filled.slice(1).split("/"));
}
