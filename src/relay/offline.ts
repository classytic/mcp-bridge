/**
 * What the relay answers while no endpoint is connected — per protocol era, and
 * only for eras the endpoint actually serves, so a client never settles on a
 * protocol the extension will later refuse.
 *
 *   2026-07-28 (modern)  `server/discover` → a cacheable result with `ttlMs: 0`
 *                        (re-discover once the extension is back);
 *                        `subscriptions/listen` → acknowledged and held open
 *                        (the session forwards it when the endpoint connects).
 *   2025 (legacy)        `initialize` → a synthetic handshake (`listChanged`);
 *                        the session replays the real one later.
 *   either               `tools/list` → no tools; anything else → "not connected".
 *
 * An era the endpoint doesn't serve is refused the way the SDK refuses it:
 * `initialize` with -32022 (unsupported protocol version, naming 2026-07-28),
 * `server/discover` with -32601 (so a negotiating client falls back).
 */

import {
  errorResponse,
  idOf,
  type JsonRpcId,
  type JsonRpcMessage,
  notification,
  resultResponse,
} from "../protocol/index.js";

export type Era = "legacy" | "modern";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";
export const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
export const SUBSCRIPTION_ID_META_KEY = "io.modelcontextprotocol/subscriptionId";
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
export const METHOD_NOT_FOUND = -32601;

const metaOf = (m: JsonRpcMessage): Record<string, unknown> | undefined => {
  const params = m.params as Record<string, unknown> | undefined;
  const meta = params?._meta;
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>) : undefined;
};

/** The era a message speaks, when it says: a 2026 envelope → modern; `initialize` → legacy. */
export function eraOf(m: JsonRpcMessage): Era | undefined {
  if (typeof metaOf(m)?.[PROTOCOL_VERSION_META_KEY] === "string") return "modern";
  if (m.method === "initialize") return "legacy";
  return undefined;
}

export interface OfflineContext {
  /** Eras the endpoint serves (last known, or configured). */
  eras: readonly Era[];
  serverName: string;
  relayVersion: string;
  notConnected: string;
}

/** The `notifications/subscriptions/acknowledged` a held listen stream starts with. */
export function listenAcknowledged(id: JsonRpcId, request: JsonRpcMessage): JsonRpcMessage {
  const params = (request.params ?? {}) as Record<string, unknown>;
  const wanted = (params.notifications ?? {}) as Record<string, unknown>;
  // Only tool list changes are promised while offline — that's what the relay can deliver.
  const honored = wanted.toolsListChanged === true ? { toolsListChanged: true } : {};
  return notification("notifications/subscriptions/acknowledged", {
    notifications: honored,
    _meta: { [SUBSCRIPTION_ID_META_KEY]: id },
  });
}

/** `tools/list_changed` delivered on a listen stream. */
export const listenToolsChanged = (id: JsonRpcId): JsonRpcMessage =>
  notification("notifications/tools/list_changed", { _meta: { [SUBSCRIPTION_ID_META_KEY]: id } });

/** The subscription a notification belongs to, if it was sent on a listen stream. */
export const subscriptionOf = (m: JsonRpcMessage): JsonRpcId | undefined => {
  const id = metaOf(m)?.[SUBSCRIPTION_ID_META_KEY];
  return typeof id === "string" || typeof id === "number" ? id : undefined;
};

/** Whether a listen request asked for tool list changes. */
export const wantsToolChanges = (request: JsonRpcMessage): boolean =>
  (
    (request.params as Record<string, unknown> | undefined)?.notifications as
      | Record<string, unknown>
      | undefined
  )?.toolsListChanged === true;

/** The offline answer to a request (not `subscriptions/listen`, which the session holds). */
export function offlineAnswer(m: JsonRpcMessage, ctx: OfflineContext): JsonRpcMessage {
  const id = idOf(m) as JsonRpcId;
  const params = (m.params ?? {}) as Record<string, unknown>;
  const modern = eraOf(m) === "modern";
  const instructions = `${ctx.notConnected} Tools appear once it connects.`;
  // 2026 results must say their type and how long they may be cached.
  const cacheable = { resultType: "complete", ttlMs: 0, cacheScope: "private" };

  if (m.method === "initialize") {
    if (!ctx.eras.includes("legacy")) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: UNSUPPORTED_PROTOCOL_VERSION,
          message: "Unsupported protocol version",
          data: {
            supported: [MODERN_PROTOCOL_VERSION],
            requested:
              typeof params.protocolVersion === "string" ? params.protocolVersion : "unknown",
          },
        },
      };
    }
    return resultResponse(id, {
      protocolVersion:
        typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : LEGACY_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: ctx.serverName, version: ctx.relayVersion },
      instructions,
    });
  }
  if (m.method === "server/discover") {
    if (!ctx.eras.includes("modern"))
      return errorResponse(id, "Method not found", METHOD_NOT_FOUND);
    return resultResponse(id, {
      supportedVersions: [MODERN_PROTOCOL_VERSION],
      capabilities: { tools: { listChanged: true } },
      instructions,
      ...cacheable,
    });
  }
  if (m.method === "tools/list")
    return resultResponse(id, { tools: [], ...(modern ? cacheable : {}) });
  if (m.method === "ping" && !modern) return resultResponse(id, {});
  return errorResponse(id, ctx.notConnected);
}
