const REDACTED = "[redacted]";
const MIN_SECRET_LENGTH = 8;
const MAX_DEPTH = 32;

const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|proxy|headers|password|secret|token|api[-_]?key|grocy-api-key|x-api-key|access_token|pin_?code|license_?key|session_?token|shared_?link_?key|immich_access_token)$/i;
const SENSITIVE_HEADER =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|grocy-api-key|x-immich-checksum)$/i;

/**
 * Replace known secrets, their URL-encoded forms, and common credential query params.
 * Secrets shorter than 8 characters are ignored so ordinary words are left alone.
 * Config rejects API keys shorter than that.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  const seen = new Set<string>();
  for (const secret of secrets) {
    const value = secret.trim();
    if (value.length < MIN_SECRET_LENGTH || seen.has(value)) continue;
    seen.add(value);
    out = out.split(value).join(REDACTED);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) out = out.split(encoded).join(REDACTED);
  }
  out = out.replace(
    /([?&#](?:api_key|apikey|api-key|access_token|token|key|secret|password|GROCY-API-KEY)=)[^&\s#]+/gi,
    `$1${REDACTED}`,
  );
  out = out.replace(/(authorization:\s*bearer\s+)\S+/gi, `$1${REDACTED}`);
  out = out.replace(/(authorization:\s*token\s+)\S+/gi, `$1${REDACTED}`);
  out = out.replace(/(x-api-key:\s*)\S+/gi, `$1${REDACTED}`);
  out = out.replace(/(grocy-api-key:\s*)\S+/gi, `$1${REDACTED}`);
  out = redactUserinfo(out);
  return out;
}

function redactUserinfo(text: string): string {
  return text.replace(/(https?:\/\/)([^/@\s:#]+:)([^/@\s]+)@/gi, `$1${REDACTED}:${REDACTED}@`);
}

export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "[url]");
}

export function redactUnknown(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === "string") return redact(value, secrets);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "bigint") return redact(value.toString(), secrets);
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, secrets, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const safeKey = redact(key, secrets);
      out[safeKey] = redactKeyed(safeKey, entry, secrets, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

function redactKeyed(
  key: string,
  value: unknown,
  secrets: readonly string[],
  depth: number,
): unknown {
  if (SENSITIVE_KEY.test(key)) {
    if (key.toLowerCase() === "headers" && value !== null && typeof value === "object") {
      return redactHeaders(value, secrets, depth);
    }
    if (typeof value === "string") return REDACTED;
    if (Array.isArray(value)) {
      return value.map((item) =>
        typeof item === "string" ? REDACTED : redactUnknown(item, secrets, depth),
      );
    }
  }
  return redactUnknown(value, secrets, depth);
}

function redactHeaders(value: object, secrets: readonly string[], depth: number): unknown {
  if (Array.isArray(value)) return redactUnknown(value, secrets, depth);
  const out: Record<string, unknown> = {};
  for (const [header, entry] of Object.entries(value)) {
    const safeHeader = redact(header, secrets);
    if (SENSITIVE_HEADER.test(header) || SENSITIVE_KEY.test(header)) {
      out[safeHeader] = REDACTED;
      continue;
    }
    out[safeHeader] =
      typeof entry === "string" ? redact(entry, secrets) : redactUnknown(entry, secrets, depth);
  }
  return out;
}

export function redactRecord(
  value: Readonly<Record<string, unknown>>,
  secrets: readonly string[],
): Record<string, unknown> {
  const redacted = redactUnknown(value, secrets);
  if (redacted === null || typeof redacted !== "object" || Array.isArray(redacted)) {
    return { error: "Tool result could not be redacted." };
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(redacted)) {
    out[key] = entry;
  }
  return out;
}
