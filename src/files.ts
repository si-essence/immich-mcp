import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ConnectorError } from "./errors.js";

const MAX_UPLOAD_BYTES = 50_000_000;

export function readLocalUpload(path: string): { filename: string; bytes: Uint8Array } {
  const resolved = resolve(path);
  if (resolved.includes("\0")) {
    throw new ConnectorError("input", "file_path is not a valid local path.");
  }
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new ConnectorError("input", "file_path could not be read.");
  }
  if (!stat.isFile()) {
    throw new ConnectorError("input", "file_path must point at a file.");
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new ConnectorError("input", "Upload file was too large.");
  }
  const bytes = new Uint8Array(readFileSync(resolved));
  return { filename: basename(resolved), bytes };
}

export function assertSavePath(path: string): string {
  const resolved = resolve(path);
  if (resolved.includes("\0") || resolved.endsWith("/") || resolved.endsWith("\\")) {
    throw new ConnectorError("input", "save_path is not a valid local file path.");
  }
  return resolved;
}
