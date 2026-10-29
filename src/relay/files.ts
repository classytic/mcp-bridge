/**
 * The relay's file rewriting (see `../protocol/files`): `$file` arguments in,
 * `mcp-bridge-save:` resources out, file schemas shown to clients as `$file`.
 */

import {
  containsFileRef,
  type FilePayload,
  type JsonRpcMessage,
  resolveFileRefs,
  type SaveRequest,
  saveRequestOf,
  toClientSchema,
} from "../protocol/index.js";

/** Local file access. Without it, file arguments are refused and save requests reported unsaved. */
export interface RelayFiles {
  /** Read a file a client named. Throw with a readable message to refuse it. */
  read(path: string): Promise<FilePayload>;
  /** Save a file a tool returned; resolves to where it was saved. */
  save(request: SaveRequest): Promise<string>;
}

type Params = Record<string, unknown>;

/** A `tools/call` request with its `$file` arguments read, or the message unchanged. */
export async function readCallFiles(
  m: JsonRpcMessage,
  files: RelayFiles | undefined,
): Promise<JsonRpcMessage> {
  const params = (m.params ?? {}) as Params;
  if (!containsFileRef(params.arguments)) return m;
  if (!files) throw new Error("This relay has no file access configured.");
  const args = await resolveFileRefs(params.arguments, (path) => files.read(path));
  return { ...m, params: { ...params, arguments: args } };
}

/** A `tools/list` result with file arguments shown as `{ $file }`. */
export function clientToolsList(result: Params): Params {
  if (!Array.isArray(result.tools)) return result;
  return {
    ...result,
    tools: result.tools.map((t: Params) => ({ ...t, inputSchema: toClientSchema(t.inputSchema) })),
  };
}

/** A `tools/call` result with save requests written out and replaced by where they went. */
export async function saveCallFiles(
  result: Params,
  files: RelayFiles | undefined,
): Promise<Params> {
  const content = result.content;
  if (!Array.isArray(content) || !content.some((c) => saveRequestOf(c))) return result;
  const out: unknown[] = [];
  for (const item of content) {
    const req = saveRequestOf(item);
    if (!req) out.push(item);
    else out.push({ type: "text", text: await describeSave(req, files) });
  }
  return { ...result, content: out };
}

async function describeSave(req: SaveRequest, files: RelayFiles | undefined): Promise<string> {
  if (!files) return `${req.name} was not saved — this relay has no downloads folder.`;
  try {
    return `Saved ${req.name} to ${await files.save(req)}`;
  } catch (e) {
    return `${req.name} could not be saved: ${e instanceof Error ? e.message : String(e)}`;
  }
}
