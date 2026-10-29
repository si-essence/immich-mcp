import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ZodType } from "zod";
import type { BaseUrl, Secret } from "./brand.js";
import { TtlCache } from "./cache.js";
import { ConnectorError } from "./errors.js";
import type { Logger } from "./log.js";
import type { RateLimiter } from "./rate-limit.js";
import { redact, redactUnknown, stripUrls } from "./redact.js";

export const API_KEY_HEADER = "x-api-key";
const MAX_BODY = 1_000_000;
const MAX_TEXT_BYTES = 100_000;
const MAX_UPLOAD_BYTES = 50_000_000;
const MAX_SAVE_BYTES = 50_000_000;

export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];
export type QueryMap = Readonly<Record<string, QueryValue>>;

export interface JsonGet {
  path: string;
  query: QueryMap | undefined;
  ttlSec: number;
}

export interface JsonWrite {
  path: string;
  query: QueryMap | undefined;
  body: unknown;
}

export interface EmptyWrite {
  path: string;
  query: QueryMap | undefined;
}

export interface MultipartWrite {
  path: string;
  query: QueryMap | undefined;
  fields: Readonly<Record<string, string>>;
  file: { filename: string; bytes: Uint8Array; field: string };
  sidecar?: { filename: string; bytes: Uint8Array } | undefined;
  checksum?: string | undefined;
}

export interface DownloadPayload {
  contentType: string;
  contentLength: number | null;
  filename: string | null;
  includedText: string | null;
  includedBase64: string | null;
  omittedReason: "binary" | "too_large" | null;
  saved: boolean;
  bytesWritten: number | null;
}

export interface HttpClientOptions {
  baseUrl: BaseUrl;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  secrets: readonly string[];
  cache: TtlCache;
  limiter: RateLimiter;
  userAgent: string;
  logger: Logger;
  apiKey: Secret | undefined;
  label: string;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class HttpClient {
  private readonly baseUrl: BaseUrl;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly secrets: readonly string[];
  private readonly cache: TtlCache;
  private readonly limiter: RateLimiter;
  private readonly userAgent: string;
  private readonly logger: Logger;
  private readonly apiKey: Secret | undefined;
  private readonly label: string;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
    this.secrets = options.secrets;
    this.cache = options.cache;
    this.limiter = options.limiter;
    this.userAgent = options.userAgent;
    this.logger = options.logger;
    this.apiKey = options.apiKey;
    this.label = options.label;
  }

  async getJson<T>(request: JsonGet, schema: ZodType<T>): Promise<T> {
    const url = this.buildUrl(request.path, request.query);
    const cacheKey = `GET ${url.origin}${url.pathname}${url.search}`;
    if (request.ttlSec > 0) {
      const cached = this.readCache(cacheKey, schema);
      if (cached !== undefined) return cached;
    }
    const response = await this.dispatch(url, "GET", undefined, "application/json");
    const text = await readLimited(response, this.label);
    if (!response.ok) throw this.httpError(response, text);
    this.rejectHtml(text, response.status);
    const json = parseFlexibleBody(text, response.status);
    return this.accept(cacheKey, request.ttlSec, schema, json);
  }

  async postJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.sendJson("POST", request, schema);
  }

  async putJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.sendJson("PUT", request, schema);
  }

  async patchJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.sendJson("PATCH", request, schema);
  }

  async deleteJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.sendJson("DELETE", request, schema);
  }

  async postEmpty(request: EmptyWrite): Promise<{ status: number; body: unknown }> {
    return this.sendEmpty("POST", request);
  }

  async putEmpty(request: EmptyWrite): Promise<{ status: number; body: unknown }> {
    return this.sendEmpty("PUT", request);
  }

  async patchEmpty(request: EmptyWrite): Promise<{ status: number; body: unknown }> {
    return this.sendEmpty("PATCH", request);
  }

  async delete(request: EmptyWrite): Promise<{ status: number; body: unknown }> {
    return this.sendEmpty("DELETE", request);
  }

  async postMultipart(request: MultipartWrite): Promise<Record<string, unknown>> {
    if (request.file.bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new ConnectorError("input", "Upload file was too large.");
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(request.fields)) {
      this.assertNoSecret(value, "Refusing to place a secret in the request.");
      form.append(key, value);
    }
    form.append(request.file.field, bytesBlob(request.file.bytes), request.file.filename);
    if (request.sidecar !== undefined) {
      form.append("sidecarData", bytesBlob(request.sidecar.bytes), request.sidecar.filename);
    }
    const url = this.buildUrl(request.path, request.query);
    const extra: Record<string, string> = {};
    if (request.checksum !== undefined) extra["x-immich-checksum"] = request.checksum;
    const response = await this.dispatch(url, "POST", form, "application/json", undefined, extra);
    const text = await readLimited(response, this.label);
    if (!response.ok) throw this.httpError(response, text);
    this.cache.clear();
    return toObject(redactUnknown(parseFlexibleBody(text, response.status), this.secrets));
  }

  async download(request: {
    path: string;
    query?: QueryMap | undefined;
    savePath?: string | undefined;
    method?: Method;
    body?: unknown;
  }): Promise<DownloadPayload> {
    const method = request.method ?? "GET";
    const bodyText = method === "GET" ? undefined : this.serializeBody(request.body);
    const url = this.buildUrl(request.path, request.query);
    const response = await this.dispatch(
      url,
      method,
      bodyText,
      "*/*",
      bodyText === undefined ? undefined : "application/json",
    );
    if (!response.ok) {
      const text = await readLimited(response, this.label);
      throw this.httpError(response, text);
    }
    return readDownload(response, this.secrets, request.savePath);
  }

  private async sendJson<T>(method: Method, request: JsonWrite, schema: ZodType<T>): Promise<T> {
    const bodyText = this.serializeBody(request.body);
    const url = this.buildUrl(request.path, request.query);
    const response = await this.dispatch(
      url,
      method,
      bodyText,
      "application/json",
      bodyText === undefined ? undefined : "application/json",
    );
    const text = await readLimited(response, this.label);
    if (!response.ok) throw this.httpError(response, text);
    this.rejectHtml(text, response.status);
    const json = parseFlexibleBody(text, response.status);
    const accepted = this.accept(`${method} ${url.pathname}`, 0, schema, json);
    this.cache.clear();
    return accepted;
  }

  private async sendEmpty(
    method: Method,
    request: EmptyWrite,
  ): Promise<{ status: number; body: unknown }> {
    const url = this.buildUrl(request.path, request.query);
    const response = await this.dispatch(url, method, undefined, "*/*");
    const text = await readLimited(response, this.label);
    if (!response.ok) throw this.httpError(response, text);
    this.cache.clear();
    const body =
      text.trim().length === 0
        ? { ok: true }
        : redactUnknown(parseFlexibleBody(text, response.status), this.secrets);
    return { status: response.status, body };
  }

  private serializeBody(body: unknown): string | undefined {
    if (body === undefined) return undefined;
    let text: string;
    try {
      text = JSON.stringify(body);
    } catch {
      throw new ConnectorError("input", "Request body could not be serialized as JSON.");
    }
    if (text.length > MAX_BODY) {
      throw new ConnectorError("input", "Request body was too large.");
    }
    this.assertNoSecret(text, "Refusing to place a secret in the request.");
    return text;
  }

  private readCache<T>(cacheKey: string, schema: ZodType<T>): T | undefined {
    const cached = this.cache.get(cacheKey);
    if (cached === undefined) return undefined;
    const parsed = schema.safeParse(cached);
    if (parsed.success) return parsed.data;
    this.cache.delete(cacheKey);
    return undefined;
  }

  private accept<T>(cacheKey: string, ttlSec: number, schema: ZodType<T>, json: unknown): T {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ConnectorError(
        "upstream",
        `${this.label} response did not match the expected shape.`,
      );
    }
    const safe = schema.safeParse(redactUnknown(parsed.data, this.secrets));
    if (!safe.success) {
      throw new ConnectorError("upstream", `${this.label} response could not be returned safely.`);
    }
    if (ttlSec > 0) this.cache.set(cacheKey, safe.data, ttlSec);
    return safe.data;
  }

  private rejectHtml(text: string, status: number): void {
    if (/<!doctype html|<html[\s>]/i.test(text)) {
      throw new ConnectorError(
        "upstream",
        `${this.label} HTTP ${status}: the service returned an error page instead of JSON.`,
      );
    }
  }

  private buildUrl(path: string, query: QueryMap | undefined): URL {
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("?") ||
      path.includes("#") ||
      path.includes("\\") ||
      path.includes("..")
    ) {
      throw new ConnectorError("input", "Request path must be a relative path.");
    }
    this.assertNoSecret(path, "Refusing to place a secret in the request URL.");
    const base = new URL(`${this.baseUrl}/`);
    const url = new URL(path, base);
    if (url.origin !== base.origin) {
      throw new ConnectorError("input", "Request path must stay on the configured base URL.");
    }
    this.assertNoSecret(
      `${url.pathname}${url.search}`,
      "Refusing to place a secret in the request URL.",
    );
    if (query !== undefined) {
      for (const key of Object.keys(query).sort()) {
        const value = query[key];
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            const text = String(item);
            this.assertNoSecret(text, "Refusing to place a secret in the request URL.");
            url.searchParams.append(key, text);
          }
        } else {
          const text = String(value);
          this.assertNoSecret(text, "Refusing to place a secret in the request URL.");
          url.searchParams.set(key, text);
        }
      }
    }
    return url;
  }

  private assertNoSecret(value: string, message: string): void {
    for (const secret of this.secrets) {
      if (
        secret.length >= 8 &&
        (value.includes(secret) || value.includes(encodeURIComponent(secret)))
      ) {
        this.logger.error(message);
        throw new ConnectorError("config", message);
      }
    }
  }

  private requireKey(): void {
    if (this.apiKey === undefined) {
      throw new ConnectorError(
        "config",
        "IMMICH_API_KEY is not set. Add it to the environment before calling the upstream API.",
      );
    }
  }

  private async dispatch(
    url: URL,
    method: Method,
    body: BodyInit | undefined,
    accept: string,
    contentType?: string,
    extraHeaders?: Readonly<Record<string, string>>,
  ): Promise<Response> {
    this.requireKey();
    this.limiter.acquire();
    const headers = new Headers();
    headers.set("accept", accept);
    headers.set("user-agent", this.userAgent);
    if (this.apiKey !== undefined) headers.set(API_KEY_HEADER, this.apiKey);
    if (contentType !== undefined) headers.set("content-type", contentType);
    if (extraHeaders !== undefined) {
      for (const [name, value] of Object.entries(extraHeaders)) {
        this.assertNoSecret(value, "Refusing to place a secret in the request.");
        headers.set(name, value);
      }
    }
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        const seconds = Math.max(1, Math.round(this.timeoutMs / 1000));
        throw new ConnectorError("timeout", `${this.label} request timed out after ${seconds}s.`);
      }
      const raw = error instanceof Error ? error.message : "network error";
      const safe = publicSnippet(raw, this.secrets);
      this.logger.error(`${this.label} request failed: ${safe}`);
      throw new ConnectorError("upstream", `${this.label} request failed: ${safe}`);
    }
  }

  private httpError(response: Response, text: string): ConnectorError {
    const snippet = publicSnippet(text, this.secrets);
    const detail = snippet.length > 0 ? `: ${snippet}` : "";
    const status = response.status;
    if (status === 401) {
      return new ConnectorError(
        "config",
        `${this.label} HTTP 401: the API key was rejected${detail}`,
      );
    }
    if (status === 402) {
      return new ConnectorError(
        "upstream",
        `${this.label} HTTP 402 quota or payment limit${detail}`,
      );
    }
    if (status === 404) {
      return new ConnectorError("not_found", `${this.label} HTTP 404${detail}`);
    }
    if (status === 422) {
      return new ConnectorError("input", `${this.label} HTTP 422${detail}`);
    }
    if (status === 429) {
      return new ConnectorError(
        "rate_limit",
        `${this.label} HTTP 429${detail}`,
        retryAfterSeconds(response),
      );
    }
    this.logger.error(`${this.label} HTTP ${status}${detail}`);
    return new ConnectorError("upstream", `${this.label} HTTP ${status}${detail}`);
  }
}

function bytesBlob(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy]);
}

function toObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = entry;
    return out;
  }
  if (Array.isArray(value)) return { items: value };
  return { value };
}

function publicSnippet(text: string, secrets: readonly string[]): string {
  return stripUrls(redact(text, secrets)).replace(/\s+/g, " ").trim().slice(0, 180);
}

function parseFlexibleBody(text: string, status: number): unknown {
  if (text.trim().length === 0) {
    return { ok: true, status };
  }
  try {
    return parseJson(text);
  } catch {
    return { text: text.slice(0, MAX_TEXT_BYTES), status };
  }
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

async function readLimited(response: Response, label: string): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > MAX_BODY) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("upstream", `${label} response was too large to parse.`);
  }
  let text = "";
  try {
    text = await response.text();
  } catch {
    throw new ConnectorError("upstream", `${label} response could not be read.`);
  }
  if (text.length > MAX_BODY) {
    throw new ConnectorError("upstream", `${label} response was too large to parse.`);
  }
  return text;
}

function contentLengthOf(header: string | null): number | null {
  if (header === null || !/^[0-9]+$/.test(header)) return null;
  return Number(header);
}

function isTextual(contentType: string): boolean {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    base.startsWith("text/") ||
    base === "application/json" ||
    base === "application/xml" ||
    base === "application/yaml" ||
    base === "application/x-yaml" ||
    base.endsWith("+json") ||
    base.endsWith("+xml")
  );
}

function filenameFrom(header: string | null, secrets: readonly string[]): string | null {
  if (header === null) return null;
  const starred = /filename\*=(?:UTF-8''|utf-8'')([^;]+)/i.exec(header);
  const plain = /filename="([^"]+)"/i.exec(header) ?? /filename=([^;]+)/i.exec(header);
  const raw = starred?.[1] ?? plain?.[1];
  if (raw === undefined) return null;
  let name = raw.trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    name = raw.trim();
  }
  const cleaned = redact(name, secrets).slice(0, 200);
  return cleaned.length === 0 ? null : cleaned;
}

async function readDownload(
  response: Response,
  secrets: readonly string[],
  savePath: string | undefined,
): Promise<DownloadPayload> {
  const contentType = response.headers.get("content-type") ?? "";
  const declared = contentLengthOf(response.headers.get("content-length"));
  const filename = filenameFrom(response.headers.get("content-disposition"), secrets);
  const textual = isTextual(contentType);
  const cap = savePath !== undefined ? MAX_SAVE_BYTES : textual ? MAX_TEXT_BYTES : 0;
  if (
    declared !== null &&
    declared > (savePath !== undefined ? MAX_SAVE_BYTES : textual ? MAX_TEXT_BYTES : 0)
  ) {
    if (savePath === undefined) {
      await response.body?.cancel().catch(() => undefined);
      return {
        contentType,
        contentLength: declared,
        filename,
        includedText: null,
        includedBase64: null,
        omittedReason: textual ? "too_large" : "binary",
        saved: false,
        bytesWritten: null,
      };
    }
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (savePath !== undefined) {
    if (buffer.byteLength > MAX_SAVE_BYTES) {
      throw new ConnectorError("upstream", "Download was too large to save.");
    }
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(savePath, buffer);
    return {
      contentType,
      contentLength: declared ?? buffer.byteLength,
      filename: filename ?? basename(savePath),
      includedText: null,
      includedBase64: null,
      omittedReason: null,
      saved: true,
      bytesWritten: buffer.byteLength,
    };
  }
  if (!textual) {
    return {
      contentType,
      contentLength: declared ?? buffer.byteLength,
      filename,
      includedText: null,
      includedBase64: null,
      omittedReason: "binary",
      saved: false,
      bytesWritten: null,
    };
  }
  if (buffer.byteLength > cap) {
    return {
      contentType,
      contentLength: declared ?? buffer.byteLength,
      filename,
      includedText: null,
      includedBase64: null,
      omittedReason: "too_large",
      saved: false,
      bytesWritten: null,
    };
  }
  return {
    contentType,
    contentLength: declared ?? buffer.byteLength,
    filename,
    includedText: redact(buffer.toString("utf8"), secrets),
    includedBase64: null,
    omittedReason: null,
    saved: false,
    bytesWritten: null,
  };
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  if (/^[0-9]+$/.test(raw)) {
    const seconds = Number(raw);
    return seconds > 0 ? seconds : null;
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(1, Math.ceil((when - Date.now()) / 1000));
}
