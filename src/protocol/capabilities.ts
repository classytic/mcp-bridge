/**
 * What a peer supports, sent once in `hello` / `ready`. Additive only: unknown
 * keys are ignored, missing keys take defaults, and an operation counts as
 * supported only when advertised — so an older peer degrades instead of
 * hanging (hermes `gateway/relay/descriptor.py`).
 */

import { isPlainObject } from "./strict-json.js";

export const CONTRACT_VERSION = 1;

/** Optional behaviours a peer may advertise. */
export type BridgeOp =
  /** Endpoint acks `mcp` frames that carry a `seq` (relay may redeliver unacked ones). */
  | "ack"
  /** Relay rewrites `$file` arguments and saves `mcp-bridge-save:` results. */
  | "files"
  /** Relay answers clients itself while no endpoint is connected. */
  | "offline-handshake";

/** MCP protocol eras a peer serves: `legacy` = 2025 (`initialize`), `modern` = 2026-07-28. */
export type ProtocolEra = "legacy" | "modern";

export interface Capabilities {
  contractVersion: number;
  ops: BridgeOp[];
  /** Eras the endpoint's MCP server answers. Absent = both (pre-0.3 endpoints). */
  eras?: ProtocolEra[];
}

const KNOWN_OPS: ReadonlySet<string> = new Set<BridgeOp>(["ack", "files", "offline-handshake"]);

/** Read a peer's capabilities leniently: defaults for anything missing, unknown ops dropped. */
export function readCapabilities(raw: unknown): Capabilities {
  if (!isPlainObject(raw)) return { contractVersion: CONTRACT_VERSION, ops: [] };
  const version = Number.isSafeInteger(raw.contractVersion)
    ? (raw.contractVersion as number)
    : CONTRACT_VERSION;
  const ops = Array.isArray(raw.ops)
    ? raw.ops.filter((o): o is BridgeOp => typeof o === "string" && KNOWN_OPS.has(o))
    : [];
  const eras = Array.isArray(raw.eras)
    ? [...new Set(raw.eras.filter((e): e is ProtocolEra => e === "legacy" || e === "modern"))]
    : undefined;
  return { contractVersion: version, ops: [...new Set(ops)], ...(eras?.length ? { eras } : {}) };
}

export const supports = (caps: Capabilities | undefined, op: BridgeOp): boolean =>
  !!caps?.ops.includes(op);
