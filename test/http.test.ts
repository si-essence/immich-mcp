import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { API_KEY_HEADER } from "../src/http.js";
import { createRuntime } from "../src/runtime.js";
import { z } from "zod";

const KEY = "super-secret/key+value=99";
const recordSchema = z.object({ id: z.string(), name: z.string() });

function runtimeFor(options: {
  fetchImpl: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}) {
  return createRuntime(
    loadConfig(
      {
        IMMICH_API_KEY: KEY,
        IMMICH_URL: "https://immich.test",
        IMMICH_TOOLSETS: "all",
        ...options.env,
      },
      [],
    ),
    {
      fetchImpl: options.fetchImpl,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe("HttpClient", () => {
  it("sends x-api-key as a header, caches the parsed body, and does not put the key in the url", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      urls.push(requestUrl(input));
      return Promise.resolve(Response.json({ id: "1", name: "Album" }));
    });
    let now = 0;
    const runtime = runtimeFor({
      fetchImpl,
      env: { IMMICH_CACHE_TTL_SEC: "30" },
      now: () => now,
    });
    const first = await runtime.client.getJson(
      { path: "api/albums", query: { take: 1 }, ttlSec: 30 },
      recordSchema,
    );
    const second = await runtime.client.getJson(
      { path: "api/albums", query: { take: 1 }, ttlSec: 30 },
      recordSchema,
    );
    expect(first).toEqual({ id: "1", name: "Album" });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get(API_KEY_HEADER)).toBe(KEY);
    expect(urls.join("\n")).not.toContain(KEY);
    expect(urls[0]).toContain("/api/albums?take=1");
    now = 31_000;
    await runtime.client.getJson(
      { path: "api/albums", query: { take: 1 }, ttlSec: 30 },
      recordSchema,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not spend the rate limit on a cache hit and blocks the next miss", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ id: "1", name: "A" })),
    );
    const runtime = runtimeFor({
      fetchImpl,
      env: { IMMICH_PER_MINUTE: "1", IMMICH_CACHE_TTL_SEC: "60" },
      now: () => 0,
    });
    await runtime.client.getJson(
      { path: "api/albums", query: undefined, ttlSec: 60 },
      recordSchema,
    );
    await runtime.client.getJson(
      { path: "api/albums", query: undefined, ttlSec: 60 },
      recordSchema,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(
      runtime.client.getJson({ path: "api/users/me", query: undefined, ttlSec: 0 }, recordSchema),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it("surfaces 429 Retry-After", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response("slow", {
          status: 429,
          headers: { "retry-after": "7" },
        }),
      ),
    );
    const runtime = runtimeFor({ fetchImpl, env: { IMMICH_CACHE_TTL_SEC: "0" } });
    try {
      await runtime.client.getJson(
        { path: "api/albums", query: undefined, ttlSec: 0 },
        recordSchema,
      );
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.code).toBe("rate_limit");
      expect(error.retryAfterSeconds).toBe(7);
      expect(error.message).toContain("429");
    }
  });
});
