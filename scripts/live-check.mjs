#!/usr/bin/env node
/**
 * Live check against a real Immich instance. Spawns dist/index.js over stdio.
 * Skips when IMMICH_URL or IMMICH_API_KEY is unset. Does not print the API key.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const token = process.env["IMMICH_API_KEY"] ?? "";
const baseUrl = process.env["IMMICH_URL"] ?? "";

/** @type {string[]} */
const secrets = [];
if (token.length >= 8) secrets.push(token);

/**
 * @param {string} text
 */
function redact(text) {
  let out = String(text);
  for (const secret of secrets) {
    out = out.split(secret).join("[redacted]");
    out = out.split(encodeURIComponent(secret)).join("[redacted]");
  }
  out = out.replace(/x-api-key:\s*\S+/gi, "x-api-key: [redacted]");
  return out;
}

/**
 * @param {string} text
 */
function clip(text) {
  let shortened = redact(text).replace(/\s+/g, " ").trim();
  if (shortened.length > 180) shortened = `${shortened.slice(0, 177)}...`;
  return shortened;
}

const writeLine = console.log.bind(console);
const writeError = console.error.bind(console);
console.log = (line) => writeLine(redact(String(line)));
console.error = (line) => writeError(redact(String(line)));

let failed = 0;
let stopped = false;
/** @type {string[]} */
const rows = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 */
function record(name, ok, detail) {
  if (!ok) failed += 1;
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}  ${clip(detail)}`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const block = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = block && typeof block === "object" && "text" in block ? String(block.text) : "";
  if (token.length >= 8 && text.includes(token)) {
    throw new Error("secret leaked into tool output");
  }
  if (/HTTP 402|quota or payment/i.test(text)) {
    stopped = true;
    throw new Error("quota-or-402");
  }
  /** @type {Record<string, unknown> | null} */
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: result.isError === true, text, json };
}

/**
 * @param {Record<string, unknown> | null} json
 */
function nestedId(json) {
  if (!isRecord(json)) return undefined;
  const result = json["result"];
  const from = isRecord(result) ? result : json;
  const id = from["id"];
  return typeof id === "string" ? id : undefined;
}

async function main() {
  if (baseUrl.trim().length === 0 || token.trim().length < 8) {
    writeLine("SKIP  live-check  IMMICH_URL and IMMICH_API_KEY are unset.");
    return;
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: root,
    env: {
      ...process.env,
      IMMICH_URL: baseUrl,
      IMMICH_API_KEY: token,
      IMMICH_ALLOW_WRITES: "true",
      IMMICH_TOOLSETS: "all",
      IMMICH_CACHE_TTL_SEC: "0",
      IMMICH_PER_MINUTE: "120",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "live-check", version: "0" });
  await client.connect(transport);

  const stamp = `mcp-live-${Date.now()}`;
  /** @type {string | undefined} */
  let albumId;
  /** @type {string | undefined} */
  let tagId;

  try {
    const listed = await client.listTools();
    record("list_tools", listed.tools.length > 0, `${listed.tools.length} tools`);

    const version = await call(client, "immich_server", { action: "get_server_version" });
    record("immich_server get_server_version", !version.isError, version.text);

    const about = await call(client, "immich_server", { action: "get_about_info" });
    record("immich_server get_about_info", !about.isError, about.text);

    const albums = await call(client, "immich_albums", { action: "get_all_albums" });
    record("immich_albums get_all_albums", !albums.isError, albums.text);

    const people = await call(client, "immich_people", { action: "get_all_people" });
    record("immich_people get_all_people", !people.isError, people.text);

    const search = await call(client, "immich_search", {
      action: "search_assets",
      body: {},
    });
    record("immich_search search_assets", !search.isError, search.text);

    const previewAlbum = await call(client, "immich_albums", {
      action: "create_album",
      body: { albumName: stamp },
    });
    record(
      "immich_albums create_album preview",
      previewAlbum.json?.["executed"] === false && previewAlbum.json?.["dry_run"] === true,
      previewAlbum.text,
    );

    const createdAlbum = await call(client, "immich_albums", {
      action: "create_album",
      body: { albumName: stamp },
      confirm: true,
    });
    albumId = nestedId(
      isRecord(createdAlbum.json) ? (createdAlbum.json["result"] ?? createdAlbum.json) : null,
    );
    if (albumId === undefined && isRecord(createdAlbum.json)) {
      albumId = nestedId(createdAlbum.json);
    }
    record(
      "immich_albums create_album confirm",
      Boolean(albumId) && !createdAlbum.isError,
      createdAlbum.text,
    );

    if (albumId !== undefined) {
      const patched = await call(client, "immich_albums", {
        action: "update_album_info",
        params: { id: albumId },
        body: { albumName: `${stamp}-renamed` },
        confirm: true,
      });
      record("immich_albums update_album_info confirm", !patched.isError, patched.text);
    } else {
      record("immich_albums update_album_info confirm", false, "no album id");
    }

    const previewTag = await call(client, "immich_tags", {
      action: "create_tag",
      body: { name: stamp },
    });
    record(
      "immich_tags create_tag preview",
      previewTag.json?.["executed"] === false,
      previewTag.text,
    );

    const createdTag = await call(client, "immich_tags", {
      action: "create_tag",
      body: { name: stamp },
      confirm: true,
    });
    tagId = nestedId(
      isRecord(createdTag.json) ? (createdTag.json["result"] ?? createdTag.json) : null,
    );
    if (tagId === undefined && isRecord(createdTag.json)) tagId = nestedId(createdTag.json);
    record(
      "immich_tags create_tag confirm",
      Boolean(tagId) && !createdTag.isError,
      createdTag.text,
    );

    if (tagId !== undefined) {
      const deletedTag = await call(client, "immich_tags", {
        action: "delete_tag",
        params: { id: tagId },
        confirm: true,
      });
      record("immich_tags delete_tag confirm", !deletedTag.isError, deletedTag.text);
    } else {
      record("immich_tags delete_tag confirm", false, "no tag id");
    }

    if (albumId !== undefined) {
      const deletedAlbum = await call(client, "immich_albums", {
        action: "delete_album",
        params: { id: albumId },
        confirm: true,
      });
      record("immich_albums delete_album confirm", !deletedAlbum.isError, deletedAlbum.text);
    } else {
      record("immich_albums delete_album confirm", false, "no album id");
    }

    // Phase 2: assets, downloads, shared links, api keys, memories, admin reads.
    const tmp = mkdtempSync(join(tmpdir(), "immich-live-"));
    const jpg = join(tmp, "live-check.jpg");
    const made = spawnSync(
      "ffmpeg",
      ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", "-y", jpg],
      { encoding: "utf8" },
    );
    if (made.status !== 0) {
      record("phase2 make test jpeg", false, "ffmpeg is required for phase 2");
    } else {
      const previewUp = await call(client, "immich_assets", {
        action: "upload_asset",
        params: {},
        file_path: jpg,
      });
      record(
        "immich_assets upload_asset preview",
        !previewUp.isError && previewUp.json?.["executed"] === false && !previewUp.text.includes(jpg),
        previewUp.text,
      );
      const up = await call(client, "immich_assets", {
        action: "upload_asset",
        params: {},
        body: { deviceAssetId: `live-${Date.now()}`, deviceId: "immich-mcp-live" },
        file_path: jpg,
        confirm: true,
      });
      record("immich_assets upload_asset confirm", !up.isError, up.text);
      const assetId = nestedId(up.json);
      if (assetId !== undefined) {
        const info = await call(client, "immich_assets", { action: "get_asset_info", params: { id: assetId } });
        record("immich_assets get_asset_info", !info.isError && !info.text.includes("originalPath"), info.text);
        const upd = await call(client, "immich_assets", {
          action: "update_asset",
          params: { id: assetId },
          body: { isFavorite: true },
          confirm: true,
        });
        record("immich_assets update_asset confirm", !upd.isError, upd.text);
        const out = join(tmp, "downloaded.jpg");
        const dl = await call(client, "immich_assets", {
          action: "download_asset",
          params: { id: assetId },
          save_path: out,
        });
        record("immich_assets download_asset save_path", !dl.isError && existsSync(out) && statSync(out).size > 0, dl.text);
        const stats = await call(client, "immich_assets", { action: "get_asset_statistics" });
        record("immich_assets get_asset_statistics", !stats.isError, stats.text);
        const mem = await call(client, "immich_memories", {
          action: "create_memory",
          body: {
            type: "on_this_day",
            data: { year: 2020 },
            memoryAt: new Date().toISOString(),
            assetIds: [assetId],
          },
          confirm: true,
        });
        record("immich_memories create_memory confirm", !mem.isError, mem.text);
        const memId = nestedId(mem.json);
        if (memId !== undefined) {
          const delMem = await call(client, "immich_memories", {
            action: "delete_memory",
            params: { id: memId },
            confirm: true,
          });
          record("immich_memories delete_memory confirm", !delMem.isError, delMem.text);
        }
        const link = await call(client, "immich_shared_links", {
          action: "create_shared_link",
          body: { type: "INDIVIDUAL", assetIds: [assetId] },
          confirm: true,
        });
        record("immich_shared_links create_shared_link confirm", !link.isError, link.text);
        const linkId = nestedId(link.json);
        if (linkId !== undefined) {
          const delLink = await call(client, "immich_shared_links", {
            action: "remove_shared_link",
            params: { id: linkId },
            confirm: true,
          });
          record("immich_shared_links remove_shared_link confirm", !delLink.isError, delLink.text);
        }
        const del = await call(client, "immich_assets", {
          action: "delete_assets",
          body: { ids: [assetId], force: true },
          confirm: true,
        });
        record("immich_assets delete_assets confirm", !del.isError, del.text);
      } else {
        record("immich_assets upload_asset id", false, "no asset id");
      }
    }
    const key = await call(client, "immich_api_keys", {
      action: "create_api_key",
      body: { name: "mcp-live-temp", permissions: ["asset.read"] },
      confirm: true,
    });
    record("immich_api_keys create_api_key confirm (secret redacted)", !key.isError, key.text);
    const keyId = nestedId(key.json);
    if (keyId !== undefined) {
      const delKey = await call(client, "immich_api_keys", {
        action: "delete_api_key",
        params: { id: keyId },
        confirm: true,
      });
      record("immich_api_keys delete_api_key confirm", !delKey.isError, delKey.text);
    }
    const cfg = await call(client, "immich_admin", { action: "get_config" });
    record("immich_admin get_config", !cfg.isError, cfg.text);
    const me = await call(client, "immich_users", { action: "get_my_user" });
    record("immich_users get_my_user", !me.isError, me.text);
  } finally {
    await client.close();
    await transport.close();
  }

  for (const row of rows) writeLine(row);
  writeLine(failed === 0 ? "failed=0" : `failed=${failed}`);
  if (stopped) process.exit(2);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  const text = redact(error instanceof Error ? error.message : "live-check failed");
  writeError(text);
  if (stopped || /quota-or-402/i.test(text)) process.exit(2);
  process.exit(1);
});
