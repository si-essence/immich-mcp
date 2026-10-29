import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { OPERATIONS, toolIsWrite, toolNames, type Operation } from "../src/operations.js";
import {
  BASE,
  TOKEN,
  bytesResponse,
  expectAuth,
  jsonFetch,
  jsonResponse,
  runtimeFor,
} from "./harness.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const TOOL_NAMES = toolNames();
const WRITE_OPS = OPERATIONS.filter((operation) => operation.write);
const READ_OPS = OPERATIONS.filter((operation) => !operation.write);

const uploadDir = mkdtempSync(join(tmpdir(), "immich-mcp-"));
const uploadFile = join(uploadDir, "photo.jpg");
writeFileSync(uploadFile, Buffer.from("fake-jpeg"));

function leakyResponse(captured: { url: string; method: string }): Response {
  if (
    captured.url.includes("/original") ||
    captured.url.includes("/thumbnail") ||
    captured.url.includes("/download") ||
    captured.url.includes("/profile-image") ||
    captured.url.includes("/video/") ||
    captured.url.includes("/archive")
  ) {
    return bytesResponse(Buffer.from("binary-bytes"), "application/octet-stream");
  }
  return jsonResponse({
    id: "00000000-0000-4000-a000-000000000001",
    name: `hello ${TOKEN}`,
    password: "hunter2-secret-value",
    apiKey: TOKEN,
    originalPath: "/usr/src/app/upload/photo.jpg",
    key: "shared-link-secret-key",
    albumName: "MCP",
  });
}

function argsFor(operation: Operation): Record<string, unknown> {
  const args: Record<string, unknown> = { action: operation.action };
  if (Object.keys(operation.sampleParams).length > 0) args["params"] = operation.sampleParams;
  if (Object.keys(operation.sampleQuery).length > 0) args["query"] = operation.sampleQuery;
  if (operation.sampleBody !== undefined) args["body"] = operation.sampleBody;
  if (operation.kind === "multipart") args["file_path"] = uploadFile;
  return args;
}

async function withClient(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const runtime = runtimeFor(fetchImpl, extra);
  const connected = await connectServer(runtime);
  try {
    await run(connected.client);
  } finally {
    await connected.close();
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; json: Record<string, unknown> | null }> {
  const result = readToolText(await client.callTool({ name, arguments: args }));
  expect(result.text).not.toContain(TOKEN);
  if (result.isError) return { ...result, json: null };
  return { ...result, json: JSON.parse(result.text) as Record<string, unknown> };
}

describe("immich tools", () => {
  it("publishes every tool with a description and confirm on writes", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({}));
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(TOOL_NAMES);
      for (const tool of listed.tools) {
        expect((tool.description ?? "").trim().length).toBeGreaterThan(20);
        const schema = JSON.stringify(tool.inputSchema);
        if (toolIsWrite(tool.name)) expect(schema).toContain("confirm");
        else expect(schema).not.toContain("confirm");
      }
    });
  });

  it("scopes the published set to IMMICH_TOOLSETS", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({}));
    await withClient(fetchImpl, { IMMICH_TOOLSETS: "albums,tags" }, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "immich_albums",
        "immich_tags",
      ]);
    });
    await withClient(fetchImpl, { IMMICH_TOOLSETS: undefined }, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "immich_albums",
        "immich_assets",
        "immich_people",
        "immich_search",
        "immich_server",
      ]);
      expect(listed.tools.some((tool) => tool.name === "immich_admin")).toBe(false);
    });
  });

  it("redacts secrets and filesystem paths on a read", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      expectAuth(captured);
      return leakyResponse(captured);
    });
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await call(client, "immich_albums", { action: "get_all_albums" });
      expect(listed.isError).toBe(false);
      const raw = JSON.stringify(listed.json);
      expect(raw).toContain("[redacted]");
      expect(raw).not.toContain("/usr/src");
      expect(raw).not.toContain(TOKEN);
      expect(calls[0]?.url).toBe(`${BASE}/api/albums`);
      expect(calls[0]?.apiKey).toBe(TOKEN);
    });
  });

  it("previews album create without calling upstream, then executes with confirm", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ id: "album-1" }));
    await withClient(fetchImpl, {}, async (client) => {
      const preview = await call(client, "immich_albums", {
        action: "create_album",
        body: { albumName: "MCP" },
      });
      expect(preview.json).toMatchObject({
        executed: false,
        dry_run: true,
        blocked: false,
        method: "POST",
        path: "api/albums",
      });
      expect(calls).toHaveLength(0);
      const created = await call(client, "immich_albums", {
        action: "create_album",
        body: { albumName: "MCP" },
        confirm: true,
      });
      expect(created.json).toMatchObject({ executed: true, dry_run: false });
      expect(calls[0]?.method).toBe("POST");
    });
  });

  it("blocks writes when IMMICH_ALLOW_WRITES is not true", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({}));
    await withClient(fetchImpl, { IMMICH_ALLOW_WRITES: "false" }, async (client) => {
      const result = await call(client, "immich_albums", {
        action: "delete_album",
        params: { id: "00000000-0000-4000-a000-000000000001" },
        confirm: true,
      });
      expect(result.json).toMatchObject({ executed: false, blocked: true, method: "DELETE" });
      expect(calls).toHaveLength(0);
    });
  });

  it("warns on irreversible deletes, trash empty, shared links, and admin config", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({}));
    await withClient(fetchImpl, {}, async (client) => {
      const trash = await call(client, "immich_trash", { action: "empty_trash" });
      expect(JSON.stringify(trash.json)).toContain("permanently deletes");
      const share = await call(client, "immich_shared_links", {
        action: "create_shared_link",
        body: {},
      });
      expect(JSON.stringify(share.json)).toContain("shared link");
      const admin = await call(client, "immich_admin", { action: "update_admin_config", body: {} });
      expect(JSON.stringify(admin.json)).toContain("admin or system configuration");
    });
  });

  it("does not gate metadata search POST", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ assets: { items: [] } }));
    await withClient(fetchImpl, { IMMICH_ALLOW_WRITES: "false" }, async (client) => {
      const result = await call(client, "immich_search", {
        action: "search_assets",
        body: { q: "cat" },
      });
      expect(result.isError).toBe(false);
      expect(result.json?.["executed"]).toBeUndefined();
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.url).toBe(`${BASE}/api/search/metadata`);
    });
  });
});

describe("every registered tool", () => {
  it("has a coverage case for each published name", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({}));
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
    });
    const covered = [...new Set(OPERATIONS.map((operation) => operation.tool))].sort();
    expect(covered).toEqual(TOOL_NAMES);
  });

  it("sends method, URL, and x-api-key on the happy path and never echoes the key", async () => {
    const invoked = new Set<string>();
    for (const operation of OPERATIONS) {
      const { fetchImpl, calls } = jsonFetch((captured) => {
        expectAuth(captured);
        if (operation.kind === "file") {
          return bytesResponse(Buffer.from("binary-bytes"), "application/octet-stream");
        }
        return leakyResponse(captured);
      });
      await withClient(fetchImpl, {}, async (client) => {
        const args = operation.write
          ? { ...argsFor(operation), confirm: true }
          : argsFor(operation);
        const result = await call(client, operation.tool, args);
        expect(result.isError, `${operation.tool} ${operation.action}`).toBe(false);
        expect(result.text).not.toContain(TOKEN);
        expect(result.text).not.toContain("x-api-key");
        expect(JSON.stringify(result.json)).not.toContain("/usr/src");
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0]?.apiKey).toBe(TOKEN);
        expect(calls[0]?.method).toBe(operation.method);
        expect(calls[0]?.url.startsWith(`${BASE}/api/`)).toBe(true);
        invoked.add(operation.tool);
      });
    }
    expect([...invoked].sort()).toEqual(TOOL_NAMES);
    expect(READ_OPS.length + WRITE_OPS.length).toBe(287);
  });

  it("previews every write without calling upstream, then executes with confirm true", async () => {
    for (const operation of WRITE_OPS) {
      const { fetchImpl, calls } = jsonFetch((captured) => leakyResponse(captured));
      await withClient(fetchImpl, {}, async (client) => {
        const preview = await call(client, operation.tool, argsFor(operation));
        expect(preview.isError, `${operation.tool} ${operation.action}`).toBe(false);
        expect(preview.json).toMatchObject({
          executed: false,
          dry_run: true,
          blocked: false,
          method: operation.method,
        });
        expect(typeof preview.json?.["path"]).toBe("string");
        expect(String(preview.json?.["path"]).startsWith("api/")).toBe(true);
        expect(calls).toHaveLength(0);
        expect(JSON.stringify(preview.json)).not.toContain(uploadFile);

        const executed = await call(client, operation.tool, {
          ...argsFor(operation),
          confirm: true,
        });
        expect(executed.isError, `${operation.tool} ${operation.action} confirm`).toBe(false);
        expect(executed.json).toMatchObject({ executed: true, dry_run: false });
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0]?.method).toBe(operation.method);
        expect(calls[0]?.apiKey).toBe(TOKEN);
      });
    }
  });

  it("rejects confirm false and the string true, and surfaces 401 404 422 429 safely", async () => {
    const { fetchImpl } = jsonFetch(
      () =>
        new Response(`quota ${TOKEN}`, {
          status: 402,
          headers: { "content-type": "text/plain" },
        }),
    );
    await withClient(fetchImpl, {}, async (client) => {
      const asFalse = await call(client, "immich_albums", {
        action: "delete_album",
        params: { id: "00000000-0000-4000-a000-000000000001" },
        confirm: false,
      });
      expect(asFalse.isError).toBe(true);
      const asString = await call(client, "immich_albums", {
        action: "delete_album",
        params: { id: "00000000-0000-4000-a000-000000000001" },
        confirm: "true",
      });
      expect(asString.isError).toBe(true);
      const quota = await call(client, "immich_server", { action: "get_server_version" });
      expect(quota.isError).toBe(true);
      expect(quota.text).toContain("402");
      expect(quota.text).not.toContain(TOKEN);
    });
  });
});

describe("error paths", () => {
  it("maps 401, 404, 422, and 429 with Retry-After", async () => {
    const cases: { status: number; body: unknown; needle: string; retry?: string }[] = [
      { status: 401, body: { message: `Unauthorized ${TOKEN}` }, needle: "401" },
      { status: 404, body: { message: "Album not found" }, needle: "404" },
      {
        status: 422,
        body: { message: ["albumName should not be empty"], statusCode: 422 },
        needle: "albumName should not be empty",
      },
      { status: 429, body: { message: "Slow down" }, needle: "429", retry: "12" },
    ];
    for (const testCase of cases) {
      const { fetchImpl } = jsonFetch(
        () =>
          new Response(JSON.stringify(testCase.body), {
            status: testCase.status,
            headers: {
              "content-type": "application/json",
              ...(testCase.retry === undefined ? {} : { "retry-after": testCase.retry }),
            },
          }),
      );
      await withClient(fetchImpl, {}, async (client) => {
        const result = await call(client, "immich_albums", { action: "get_all_albums" });
        expect(result.isError).toBe(true);
        expect(result.text).toContain(testCase.needle);
        expect(result.text).not.toContain(TOKEN);
        if (testCase.status === 429) expect(result.text.toLowerCase()).toContain("rate");
      });
    }
  });
});
