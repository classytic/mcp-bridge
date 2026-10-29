/**
 * The few JSON-RPC facts a relay reads off an MCP message — its kind, its id,
 * and who the client is. Everything else passes through untouched.
 */

import type { JsonRpcMessage, PeerInfo } from "./frames.js";

export type JsonRpcId = string | number;

const isId = (v: unknown): v is JsonRpcId => typeof v === "string" || typeof v === "number";

export const isRequest = (m: JsonRpcMessage): boolean => typeof m.method === "string" && isId(m.id);
export const isNotification = (m: JsonRpcMessage): boolean =>
  typeof m.method === "string" && m.id === undefined;
export const isResponse = (m: JsonRpcMessage): boolean =>
  m.method === undefined && isId(m.id) && ("result" in m || "error" in m);
export const idOf = (m: JsonRpcMessage): JsonRpcId | undefined => (isId(m.id) ? m.id : undefined);

/** A JSON-RPC error response. `-32000` is the implementation-defined server error. */
export const errorResponse = (id: JsonRpcId, message: string, code = -32000): JsonRpcMessage => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

export const resultResponse = (id: JsonRpcId, result: Record<string, unknown>): JsonRpcMessage => ({
  jsonrpc: "2.0",
  id,
  result,
});

export const notification = (method: string, params?: Record<string, unknown>): JsonRpcMessage => ({
  jsonrpc: "2.0",
  method,
  ...(params ? { params } : {}),
});

/** The meta key a 2026-07-28 request carries the client's identity under. */
export const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";

const asPeer = (v: unknown): PeerInfo | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const { name, version } = v as Record<string, unknown>;
  if (typeof name !== "string" || !name) return undefined;
  return typeof version === "string" ? { name, version } : { name };
};

/**
 * The MCP client's identity when this message carries it: `initialize`'s
 * `params.clientInfo` (2025 era) or `params._meta[CLIENT_INFO_META_KEY]`
 * (2026-07-28 era, on any request).
 */
export function clientInfoOf(m: JsonRpcMessage): PeerInfo | undefined {
  const params = m.params as Record<string, unknown> | undefined;
  if (!params || typeof params !== "object") return undefined;
  if (m.method === "initialize") {
    const info = asPeer(params.clientInfo);
    if (info) return info;
  }
  const meta = params._meta as Record<string, unknown> | undefined;
  return meta && typeof meta === "object" ? asPeer(meta[CLIENT_INFO_META_KEY]) : undefined;
}
