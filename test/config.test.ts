import { describe, expect, it } from "vitest";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { DEFAULT_TOOLSETS } from "../src/operations.js";

const KEY = "super-secret/key+value=99";

function messageOf(error: unknown): string {
  expect(error).toBeInstanceOf(ConnectorError);
  if (!(error instanceof ConnectorError)) throw error;
  return error.message;
}

function catchError(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return error;
  }
}

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({}, []);
    expect(config.apiKey).toBeUndefined();
    expect(config.baseUrl).toBe("https://example.invalid");
    expect(config.allowWrites).toBe(false);
    expect(config.toolsets).toEqual([...DEFAULT_TOOLSETS]);
    expect(config.perMinute).toBe(30);
    expect(config.timeoutMs).toBe(20_000);
    expect(config.contact).toBe("contact@example.com");
    expect(config.transport).toBe("stdio");
    expect(config.port).toBe(3000);
    expect(config.cacheTtlSec).toBe(60);
    expect(config.userAgent).toBe(`${CONNECTOR_NAME}/${CONNECTOR_VERSION} (contact@example.com)`);
  });

  it("lets --http override the transport", () => {
    expect(loadConfig({ MCP_TRANSPORT: "stdio" }, ["node", "app", "--http"]).transport).toBe(
      "http",
    );
    expect(loadConfig({ MCP_TRANSPORT: "http" }, []).transport).toBe("http");
  });

  it("strips a trailing /api from the base url", () => {
    const config = loadConfig({ IMMICH_URL: "http://127.0.0.1:2283/api/" }, []);
    expect(config.baseUrl).toBe("http://127.0.0.1:2283");
  });

  it("enables writes only when IMMICH_ALLOW_WRITES is the literal true", () => {
    expect(loadConfig({ IMMICH_ALLOW_WRITES: "true" }, []).allowWrites).toBe(true);
    expect(loadConfig({ IMMICH_ALLOW_WRITES: "yes" }, []).allowWrites).toBe(false);
  });

  it("parses IMMICH_TOOLSETS", () => {
    expect(loadConfig({ IMMICH_TOOLSETS: "albums,tags" }, []).toolsets).toEqual(["albums", "tags"]);
    expect(loadConfig({ IMMICH_TOOLSETS: "all" }, []).toolsets).toContain("admin");
  });

  it("rejects an unknown toolset", () => {
    const message = messageOf(catchError(() => loadConfig({ IMMICH_TOOLSETS: "nope" }, [])));
    expect(message).toContain("IMMICH_TOOLSETS");
    expect(message).not.toContain("nope");
  });

  it("reports invalid fields without the rejected value or the api key", () => {
    const message = messageOf(
      catchError(() => loadConfig({ IMMICH_API_KEY: KEY, PORT: "nope", MCP_TRANSPORT: "sse" }, [])),
    );
    expect(message).toContain("PORT");
    expect(message).toContain("MCP_TRANSPORT");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("nope");
    expect(message).not.toContain("sse");
  });

  it("rejects a short api key without echoing it", () => {
    const message = messageOf(catchError(() => loadConfig({ IMMICH_API_KEY: "short" }, [])));
    expect(message).toContain("IMMICH_API_KEY");
    expect(message).not.toContain("short");
  });

  it("rejects a base url or contact that contains the api key", () => {
    const inUrl = messageOf(
      catchError(() =>
        loadConfig({ IMMICH_API_KEY: KEY, IMMICH_URL: `https://example.invalid/${KEY}` }, []),
      ),
    );
    expect(inUrl).toContain("contains_secret");
    expect(inUrl).not.toContain(KEY);

    const inContact = messageOf(
      catchError(() =>
        loadConfig({ IMMICH_API_KEY: KEY, IMMICH_CONTACT: `me+${KEY}@example.com` }, []),
      ),
    );
    expect(inContact).toContain("contains_secret");
    expect(inContact).not.toContain(KEY);
  });
});
