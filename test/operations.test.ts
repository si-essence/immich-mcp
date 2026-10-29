import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALL_TOOLSETS,
  DEFAULT_TOOLSETS,
  OPERATIONS,
  openApiKeys,
  parseToolsets,
  toolNames,
  toolsForToolsets,
} from "../src/operations.js";

describe("OpenAPI coverage", () => {
  it("covers every path and operation in immich.openapi.json", () => {
    const spec = JSON.parse(
      readFileSync((existsSync(new URL("../immich.openapi.json", import.meta.url)) ? new URL("../immich.openapi.json", import.meta.url) : new URL("./fixtures/immich.routes.json", import.meta.url)), "utf8"),
    ) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const specKeys: string[] = [];
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const method of Object.keys(ops)) {
        if (["get", "post", "put", "patch", "delete"].includes(method)) {
          specKeys.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    specKeys.sort();
    expect(openApiKeys()).toEqual(specKeys);
    expect(Object.keys(spec.paths)).toHaveLength(199);
    expect(specKeys).toHaveLength(287);
    expect(OPERATIONS).toHaveLength(287);
    expect(toolNames()).toHaveLength(ALL_TOOLSETS.length);
    expect(DEFAULT_TOOLSETS).toEqual(["assets", "albums", "people", "search", "server"]);
  });

  it("keeps search and other read POSTs ungated", () => {
    const search = OPERATIONS.filter((row) => row.toolset === "search" && row.method === "POST");
    expect(search.length).toBeGreaterThan(0);
    expect(search.every((row) => !row.write)).toBe(true);
    const check = OPERATIONS.find((row) => row.operationId === "checkBulkUpload");
    expect(check?.write).toBe(false);
  });
});

describe("toolset scoping", () => {
  it("defaults to the read-focused subset and treats all as every toolset", () => {
    expect(parseToolsets(undefined)).toEqual([...DEFAULT_TOOLSETS]);
    expect(parseToolsets("all")).toEqual([...ALL_TOOLSETS]);
    expect(toolsForToolsets(parseToolsets(undefined))).toEqual([
      "immich_albums",
      "immich_assets",
      "immich_people",
      "immich_search",
      "immich_server",
    ]);
    expect(toolsForToolsets(parseToolsets("all"))).toEqual(toolNames());
    expect(parseToolsets("admin")).toEqual(["admin"]);
    expect(toolsForToolsets(["admin"])).toEqual(["immich_admin"]);
  });
});
