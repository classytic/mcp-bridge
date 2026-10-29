/**
 * Application frames of `mcp-bridge.v1` — what flows once a socket has
 * authenticated (see `../auth` for the handshake before it).
 *
 *   dialer → relay  hello { role, server, info, capabilities }
 *   relay  → dialer ready { relay, epoch, capabilities }
 *   both            open / mcp / ack / close  (per MCP client session)
 *   both            ping / pong
 *
 * MCP messages ride inside `mcp` frames untouched. Relay → endpoint `mcp`
 * frames carry a per-session `seq` the endpoint `ack`s on receipt, so a
 * reconnect redelivers only what never arrived (see the relay's delivery).
 */

import { err, ok, type Result } from "@classytic/primitives/result";
import type { Capabilities } from "./capabilities.js";
import { isPlainObject } from "./strict-json.js";

export const BRIDGE_PROTOCOL = "mcp-bridge.v1";
/** The WebSocket subprotocol both sides must negotiate. */
export const BRIDGE_SUBPROTOCOL = BRIDGE_PROTOCOL;

/** Name + version of a party (an MCP client, an endpoint, a relay). */
export interface PeerInfo {
  name: string;
  version?: string;
}

/** A JSON-RPC 2.0 message as it travels — structural; the MCP SDK owns its schema. */
export type JsonRpcMessage = { jsonrpc: "2.0" } & Record<string, unknown>;

/** `endpoint` serves MCP sessions (the extension); `client` forwards MCP clients' sessions (the stdio shim). */
export type Role = "endpoint" | "client";

/**
 * Which endpoint this is, when several can serve one server — e.g. the same
 * extension in several browser profiles. `id` is stable per install (a random
 * id kept in that profile's storage); `label` is what people pick it by.
 */
export interface EndpointIdentity {
  id: string;
  label: string;
}

export interface HelloFrame {
  type: "hello";
  v: 1;
  role: Role;
  server: string;
  info?: PeerInfo;
  capabilities?: Capabilities;
  /** Endpoints only. Absent = the single unnamed endpoint (`default`). */
  endpoint?: EndpointIdentity;
}
export interface ReadyFrame {
  type: "ready";
  v: 1;
  relay: PeerInfo;
  /** Changes when the relay restarts — an endpoint resets its delivery watermarks. */
  epoch: string;
  capabilities?: Capabilities;
}
export interface OpenFrame {
  type: "open";
  session: string;
  client?: PeerInfo;
  /** Client → relay: pin this session to an endpoint (id or label). */
  endpoint?: string;
  /** Client → relay: only the tools whose names match these patterns (`*` wildcard). */
  tools?: string[];
}
export interface McpFrame {
  type: "mcp";
  session: string;
  /** Present on relay → endpoint frames; the endpoint acks it. */
  seq?: number;
  message: JsonRpcMessage;
}
export interface AckFrame {
  type: "ack";
  session: string;
  seq: number;
  /**
   * The endpoint had already received this seq (its ack was lost) and did not
   * run it again; the relay tells the client the outcome is unknown.
   */
  duplicate?: boolean;
}
export interface CloseFrame {
  type: "close";
  session: string;
  reason?: string;
}
export interface PingFrame {
  type: "ping";
}
export interface PongFrame {
  type: "pong";
}

export type Frame =
  | HelloFrame
  | ReadyFrame
  | OpenFrame
  | McpFrame
  | AckFrame
  | CloseFrame
  | PingFrame
  | PongFrame;

export type FrameError = { code: "not_json" | "not_a_frame"; message: string };

/** Field caps — a frame past them is refused, not truncated. */
const MAX_NAME = 256;
const MAX_SESSION = 128;
const MAX_TOOL_PATTERNS = 64;

const str = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;
const optStr = (v: unknown, max: number) =>
  v === undefined || (typeof v === "string" && v.length <= max);
/** Endpoint ids: 8–64 url-safe characters. */
export const ENDPOINT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const isEndpointIdentity = (v: unknown): v is EndpointIdentity =>
  isPlainObject(v) && typeof v.id === "string" && ENDPOINT_ID.test(v.id) && str(v.label, MAX_NAME);
const isPeerInfo = (v: unknown): v is PeerInfo =>
  isPlainObject(v) && str(v.name, MAX_NAME) && optStr(v.version, MAX_NAME);
const optPeer = (v: unknown) => v === undefined || isPeerInfo(v);
const optCaps = (v: unknown) => v === undefined || isPlainObject(v);

/** Structural JSON-RPC check: an object with `jsonrpc: "2.0"`. */
export const isJsonRpcMessage = (v: unknown): v is JsonRpcMessage =>
  isPlainObject(v) && v.jsonrpc === "2.0";

/** Type guard for an application frame. Unknown frame types are not frames. */
export function isFrame(v: unknown): v is Frame {
  if (!isPlainObject(v)) return false;
  switch (v.type) {
    case "hello":
      return (
        v.v === 1 &&
        (v.role === "endpoint" || v.role === "client") &&
        str(v.server, MAX_NAME) &&
        optPeer(v.info) &&
        optCaps(v.capabilities) &&
        (v.endpoint === undefined || (v.role === "endpoint" && isEndpointIdentity(v.endpoint)))
      );
    case "ready":
      return v.v === 1 && isPeerInfo(v.relay) && str(v.epoch, MAX_NAME) && optCaps(v.capabilities);
    case "open":
      return (
        str(v.session, MAX_SESSION) &&
        optPeer(v.client) &&
        (v.endpoint === undefined || str(v.endpoint, MAX_NAME)) &&
        (v.tools === undefined ||
          (Array.isArray(v.tools) &&
            v.tools.length <= MAX_TOOL_PATTERNS &&
            v.tools.every((p) => str(p, MAX_NAME))))
      );
    case "mcp":
      return (
        str(v.session, MAX_SESSION) &&
        (v.seq === undefined || (Number.isSafeInteger(v.seq) && (v.seq as number) > 0)) &&
        isJsonRpcMessage(v.message)
      );
    case "ack":
      return (
        str(v.session, MAX_SESSION) &&
        Number.isSafeInteger(v.seq) &&
        (v.seq as number) > 0 &&
        (v.duplicate === undefined || typeof v.duplicate === "boolean")
      );
    case "close":
      return str(v.session, MAX_SESSION) && optStr(v.reason, 1024);
    case "ping":
    case "pong":
      return true;
    default:
      return false;
  }
}

/** Parse one WebSocket text message into an application frame. */
export function parseFrame(data: string): Result<Frame, FrameError> {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return err({ code: "not_json", message: "Frame is not valid JSON" });
  }
  if (!isFrame(value)) {
    const type =
      isPlainObject(value) && typeof value.type === "string"
        ? `"${value.type.slice(0, 32)}"`
        : "unknown";
    return err({ code: "not_a_frame", message: `Not a valid ${type} frame` });
  }
  return ok(value);
}

export const encodeFrame = (frame: Frame): string => JSON.stringify(frame);

/** The path a relay serves one server's bridge on. */
export const bridgePath = (serverName: string): string =>
  `/bridge/${encodeURIComponent(serverName)}`;

/** The relay URL for a server: `ws://127.0.0.1:<port>/bridge/<server>`. */
export const bridgeUrl = (port: number, serverName: string, host = "127.0.0.1"): string =>
  `ws://${host}:${port}${bridgePath(serverName)}`;
