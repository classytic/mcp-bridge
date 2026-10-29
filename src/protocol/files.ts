/**
 * Local files across the bridge. An MCP tool can't take a file and an
 * extension can't read the disk, so the relay (on the user's machine) does both:
 *
 *  - **In.** An endpoint marks a tool argument with {@link filePayloadJsonSchema}
 *    (any schema node carrying `"x-mcp-bridge": "file"`). Clients see
 *    `{ "$file": "<path>" }` there instead, and on `tools/call` the relay swaps
 *    that for the file's bytes as a {@link FilePayload} — only under its roots.
 *  - **Out.** A result content item made with {@link saveAsResource} is written
 *    to the relay's downloads folder and replaced with the saved path.
 */

import { bytesToBase64 } from "../internal/encoding.js";

export const FILE_SCHEMA_MARKER = "x-mcp-bridge";
export const FILE_SCHEMA_MARKER_VALUE = "file";

/** What the endpoint's tool receives for a file argument. */
export interface FilePayload {
  name: string;
  mediaType: string;
  size: number;
  base64: string;
}

/** What the MCP client sends for a file argument. */
export interface FileRef {
  $file: string;
}

/** JSON Schema for a file argument, as the endpoint declares it. */
export const filePayloadJsonSchema = {
  type: "object",
  [FILE_SCHEMA_MARKER]: FILE_SCHEMA_MARKER_VALUE,
  properties: {
    name: { type: "string" },
    mediaType: { type: "string" },
    size: { type: "number" },
    base64: { type: "string" },
  },
  required: ["name", "mediaType", "size", "base64"],
} as const;

/** JSON Schema clients see in place of a file argument. */
export const fileRefJsonSchema = {
  type: "object",
  description: "A local file. Give its absolute path; the relay reads it.",
  properties: { $file: { type: "string", description: "Absolute path of a local file" } },
  required: ["$file"],
  additionalProperties: false,
} as const;

export const isFileRef = (v: unknown): v is FileRef =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.keys(v).length === 1 &&
  typeof (v as Record<string, unknown>).$file === "string";

/** Whether `v` holds a {@link FileRef} anywhere. */
export const containsFileRef = (v: unknown): boolean =>
  isFileRef(v) ||
  (Array.isArray(v)
    ? v.some(containsFileRef)
    : typeof v === "object" && v !== null && Object.values(v).some(containsFileRef));

const isFileSchema = (v: unknown): boolean =>
  typeof v === "object" &&
  v !== null &&
  (v as Record<string, unknown>)[FILE_SCHEMA_MARKER] === FILE_SCHEMA_MARKER_VALUE;

/** A copy of `schema` with every file-marked node replaced by {@link fileRefJsonSchema}. */
export function toClientSchema(schema: unknown): unknown {
  if (isFileSchema(schema)) return { ...fileRefJsonSchema };
  if (Array.isArray(schema)) return schema.map(toClientSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  return Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, toClientSchema(v)]));
}

/** A copy of `value` with every {@link FileRef} replaced by what `read` returns for its path. */
export async function resolveFileRefs(
  value: unknown,
  read: (path: string) => Promise<FilePayload>,
): Promise<unknown> {
  if (isFileRef(value)) return read(value.$file);
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveFileRefs(v, read)));
  if (typeof value !== "object" || value === null) return value;
  const entries = await Promise.all(
    Object.entries(value).map(async ([k, v]) => [k, await resolveFileRefs(v, read)] as const),
  );
  return Object.fromEntries(entries);
}

/** The URI scheme of an embedded resource the relay should save. */
export const SAVE_URI_PREFIX = "mcp-bridge-save:";

/** The URI that asks the relay to save an embedded resource as `name`. */
export const saveUri = (name: string): string => `${SAVE_URI_PREFIX}${encodeURIComponent(name)}`;

/**
 * A `fileUri` for servers that build embedded resources from file parts (e.g.
 * arc-ai's `serveAsMcp({ fileUri: saveFileUri })`): every file a tool returns
 * is saved by the relay under its filename.
 */
export const saveFileUri = (part: { filename?: string }, index: number): string =>
  saveUri(part.filename ?? `file-${index + 1}`);

/** A tool-result content item asking the relay to save `base64` as `name` (an MCP embedded resource). */
export const saveAsResource = (name: string, mediaType: string, base64: string) => ({
  type: "resource" as const,
  resource: {
    uri: saveUri(name),
    mimeType: mediaType,
    blob: base64,
  },
});

export interface SaveRequest {
  name: string;
  mediaType: string | undefined;
  base64: string;
}

/** The save request in a content item, or null when it isn't one. */
export function saveRequestOf(item: unknown): SaveRequest | null {
  if (typeof item !== "object" || item === null) return null;
  const { type, resource } = item as Record<string, unknown>;
  if (type !== "resource" || typeof resource !== "object" || resource === null) return null;
  const { uri, mimeType, blob, text } = resource as Record<string, unknown>;
  if (typeof uri !== "string" || !uri.startsWith(SAVE_URI_PREFIX)) return null;
  // Binary resources carry base64 `blob`; textual ones (JSON, CSV, JSONL) `text`.
  const base64 =
    typeof blob === "string"
      ? blob
      : typeof text === "string"
        ? bytesToBase64(new TextEncoder().encode(text))
        : null;
  if (base64 === null) return null;
  return {
    name: decodeURIComponent(uri.slice(SAVE_URI_PREFIX.length)),
    mediaType: typeof mimeType === "string" ? mimeType : undefined,
    base64,
  };
}
