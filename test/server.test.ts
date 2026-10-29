import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CONNECTOR_NAME } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";
import { toolsForToolsets } from "../src/operations.js";
import { connectServer } from "./mcp.js";

describe("server", () => {
  it("publishes the default tool set", async () => {
    const runtime = createRuntime(loadConfig({}, []));
    const { client, close } = await connectServer(runtime);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
        toolsForToolsets(runtime.config.toolsets),
      );
    } finally {
      await close();
    }
  });

  it("keeps the package name aligned with package.json", () => {
    const pkg = z
      .object({ name: z.string() })
      .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
    expect(pkg.name).toBe(CONNECTOR_NAME);
  });
});
