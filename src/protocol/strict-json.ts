/**
 * Strict JSON for security-relevant frames (the auth handshake). `JSON.parse`
 * silently keeps the last of two duplicate keys, so a frame could carry one
 * value to a validator and another to the code that acts on it. Here:
 *   1. size is capped before parsing (characters and UTF-8 bytes),
 *   2. it must parse as a plain object,
 *   3. no object at any depth may repeat a key (after JSON-decoding the key,
 *      so `"v"` and `"v"` collide).
 * Pattern from openclaw's `strict-json.js`.
 */

const encoder = new TextEncoder();

export type JsonObject = Record<string, unknown>;

export const isPlainObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** True when `value` has exactly these own keys — no more, no fewer. */
export function hasExactKeys(value: unknown, keys: readonly string[]): value is JsonObject {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((k) => Object.hasOwn(value, k))
  );
}

/** Whether any object in `text` repeats a key. `text` must already be valid JSON. */
export function hasDuplicateKeys(text: string): boolean {
  const stack: Array<Set<string> | null> = []; // a Set per open object, null per array
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (expectKey && top) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(key)) return true;
        top.add(key);
      }
      expectKey = false;
      i = j;
    } else if (c === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (c === "[") {
      stack.push(null);
      expectKey = false;
    } else if (c === "}" || c === "]") {
      stack.pop();
      expectKey = false;
    } else if (c === ",") {
      expectKey = stack[stack.length - 1] instanceof Set;
    }
  }
  return false;
}

/** Parse `raw` as a strict JSON object, or null when it is oversized, invalid, not an object or has duplicate keys. */
export function parseStrictJsonObject(raw: string, maxBytes: number): JsonObject | null {
  if (raw.length > maxBytes || encoder.encode(raw).byteLength > maxBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;
  return hasDuplicateKeys(raw) ? null : value;
}
