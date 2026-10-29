const MAX_DEPTH = 32;

const PATH_BEARING_KEYS = new Set([
  "filename",
  "datastore_path",
  "data_path",
  "data_dir",
  "snapshot_path",
  "snapshot_file",
  "uuid_file",
  "realpath",
  "realpath_cache",
  "script_filename",
  "document_root",
  "originalpath",
  "encodedvideopath",
  "previewpath",
  "thumbnailpath",
  "sidecarpath",
  "livephotovideopath",
  "filepath",
  "file_path",
  "save_path",
  "localpath",
]);

export function isAbsoluteFsPath(value: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) {
    return (
      /^\/(?:tmp|var|home|root|data|datastore|opt|usr|etc|mnt|srv|app|config)\b/i.test(value) ||
      /\.(?:txt|html|htm|json|png|ico|jpg|jpeg|gif|webp|bin|php|log)$/i.test(value)
    );
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("\\\\")) return true;
  return false;
}

export function stripPathsInText(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => (isAbsoluteFsPath(part) ? "[omitted-path]" : part))
    .join("");
}

export function stripServerPaths(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === "string") return isAbsoluteFsPath(value) ? undefined : value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const stripped = stripServerPaths(item, depth + 1);
      if (stripped !== undefined) items.push(stripped);
    }
    return items;
  }
  if (typeof value !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (PATH_BEARING_KEYS.has(key.toLowerCase())) {
      if (
        key.toLowerCase() === "filename" &&
        typeof entry === "string" &&
        !isAbsoluteFsPath(entry)
      ) {
        out["filename"] = entry;
      }
      continue;
    }
    const stripped = stripServerPaths(entry, depth + 1);
    if (stripped === undefined) continue;
    out[key] = stripped;
  }
  return out;
}

export function asJsonObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = entry;
    return out;
  }
  if (Array.isArray(value)) return { items: value };
  if (typeof value === "string") return { text: value };
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { value };
  }
  return { value: null };
}
