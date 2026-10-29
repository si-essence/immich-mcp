import { describe, expect, it } from "vitest";
import { isAbsoluteFsPath, stripPathsInText, stripServerPaths } from "../src/parse.js";

describe("stripServerPaths", () => {
  it("drops absolute filesystem paths and path-bearing keys", () => {
    expect(isAbsoluteFsPath("/usr/src/app/upload/a.jpg")).toBe(true);
    expect(isAbsoluteFsPath("photo.jpg")).toBe(false);
    const stripped = stripServerPaths({
      name: "Beach",
      leak: "/tmp/immich.db",
      originalPath: "/usr/src/app/upload/photo.jpg",
      filename: "/opt/immich/x.png",
      keep: "shelf.png",
    });
    expect(stripped).toEqual({ name: "Beach", keep: "shelf.png" });
    expect(stripPathsInText("see /tmp/secret.db here")).toContain("[omitted-path]");
  });
});
