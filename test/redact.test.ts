import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { redact, redactUnknown } from "../src/redact.js";
import { createRuntime } from "../src/runtime.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const KEY = "super-secret/key+value=99";
const ENCODED = encodeURIComponent(KEY);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function assertNoKey(label: string, text: string): void {
  expect(text, label).not.toContain(KEY);
  expect(text, label).not.toContain(ENCODED);
}

describe("redact", () => {
  it("strips the secret, its url encoding, query params, and x-api-key headers", () => {
    const raw = [
      `key=${KEY}`,
      `encoded=${ENCODED}`,
      `https://upstream.test/lookup?api_key=${KEY}&x=1`,
      `x-api-key: ${KEY}`,
    ].join("\n");
    const cleaned = redact(raw, [KEY]);
    assertNoKey("redact", cleaned);
    expect(cleaned).toContain("api_key=[redacted]");
    expect(cleaned).toContain("x-api-key: [redacted]");
  });

  it("redacts nested password and api key fields", () => {
    const cleaned = JSON.stringify(
      redactUnknown({ password: "hunter2-secret-value", apiKey: KEY, title: `see ${KEY}` }, [KEY]),
    );
    assertNoKey("nested", cleaned);
    expect(cleaned).toContain("[redacted]");
    expect(cleaned).not.toContain("hunter2-secret-value");
  });

  it("redacts secrets in tool errors and never logs the raw key", async () => {
    const lines: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      expect(requestUrl(input)).not.toContain(KEY);
      return Promise.resolve(new Response(`fail ${KEY}`, { status: 500 }));
    };
    const runtime = createRuntime(
      loadConfig(
        {
          IMMICH_API_KEY: KEY,
          IMMICH_URL: "https://immich.test",
          IMMICH_CACHE_TTL_SEC: "0",
          IMMICH_TOOLSETS: "server",
        },
        [],
      ),
      { fetchImpl, logger: createLogger([KEY], (line) => lines.push(line)) },
    );
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({
          name: "immich_server",
          arguments: { action: "get_server_version" },
        }),
      );
      expect(result.isError).toBe(true);
      assertNoKey("tool error", result.text);
      for (const line of lines) assertNoKey("log", line);
    } finally {
      await close();
    }
  });
});
