import { loadConfig } from "../src/config.js";
import { API_KEY_HEADER } from "../src/http.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

export const TOKEN = "super-secret/key+value=99";
export const BASE = "https://immich.test";

export function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    IMMICH_URL: BASE,
    IMMICH_API_KEY: TOKEN,
    IMMICH_CACHE_TTL_SEC: "0",
    IMMICH_ALLOW_WRITES: "true",
    IMMICH_TOOLSETS: "all",
    ...extra,
  };
}

export function runtimeFor(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv = {},
  now?: () => number,
): Runtime {
  return createRuntime(loadConfig(env(extra), []), {
    fetchImpl,
    ...(now === undefined ? {} : { now }),
  });
}

export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export interface CapturedRequest {
  method: string;
  url: string;
  apiKey: string | null;
  body: unknown;
  contentType: string | null;
}

export function capturedFrom(input: RequestInfo | URL, init?: RequestInit): CapturedRequest {
  const headers = new Headers(init?.headers);
  let body: unknown;
  if (init?.body === undefined) body = undefined;
  else if (typeof init.body === "string") {
    try {
      body = JSON.parse(init.body) as unknown;
    } catch {
      body = init.body;
    }
  } else body = init.body;
  return {
    method: init?.method ?? "GET",
    url: requestUrl(input),
    apiKey: headers.get(API_KEY_HEADER),
    body,
    contentType: headers.get("content-type"),
  };
}

export function jsonFetch(impl: (captured: CapturedRequest) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const captured = capturedFrom(input, init);
    calls.push(captured);
    return Promise.resolve(impl(captured));
  };
  return { fetchImpl, calls };
}

export function expectAuth(captured: CapturedRequest): void {
  if (captured.apiKey !== TOKEN) {
    throw new Error("missing x-api-key");
  }
  if (captured.url.includes(TOKEN)) {
    throw new Error("token leaked into the url");
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function textResponse(body: string, status = 200, contentType = "text/plain"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

export function bytesResponse(
  body: Uint8Array,
  contentType = "application/octet-stream",
): Response {
  return new Response(Buffer.from(body), {
    status: 200,
    headers: { "content-type": contentType },
  });
}
