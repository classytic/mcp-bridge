/**
 * The native-messaging contract between an extension and the bridge's native
 * host — one request, one response, then the host exits (openclaw
 * `extension-native-protocol.ts`). Chrome frames each message (4-byte length,
 * native byte order); both directions are strict: exact keys, size caps, and
 * the request's nonce echoed back.
 *
 *   { v:1, op:"pair",   nonce }  → { v:1, ok:true, nonce, relayUrl, secret }
 *   { v:1, op:"ensure", nonce }  → { v:1, ok:true, nonce, relay: "running" | "spawned" }
 *   any failure                  → { v:1, ok:false, nonce, code }
 */

import { hasExactKeys, isPlainObject } from "../protocol/strict-json.js";

export const NATIVE_VERSION = 1;
/** Requests are tiny; the host refuses anything bigger before parsing. */
export const MAX_NATIVE_REQUEST_BYTES = 4 * 1024;
/** Chrome's own cap on a host → extension message is 1 MiB. */
export const MAX_NATIVE_RESPONSE_BYTES = 1024 * 1024;

export type NativeOp = "pair" | "ensure";

export interface NativeRequest {
  v: 1;
  op: NativeOp;
  /** 16–64 base64url chars; echoed in the response. */
  nonce: string;
}

export type NativeFailureCode =
  /** Malformed frame or request. */
  | "invalid_request"
  /** The calling extension is not one this host was installed for. */
  | "origin_forbidden"
  /** The relay could not be found or started. */
  | "relay_unavailable"
  /** Something else went wrong in the host. */
  | "host_error";

export type NativeResponse =
  | { v: 1; ok: true; nonce: string; relayUrl: string; secret: string }
  | { v: 1; ok: true; nonce: string; relay: "running" | "spawned" }
  | { v: 1; ok: false; nonce: string; code: NativeFailureCode };

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const FAILURES: ReadonlySet<string> = new Set([
  "invalid_request",
  "origin_forbidden",
  "relay_unavailable",
  "host_error",
]);

export function isNativeRequest(v: unknown): v is NativeRequest {
  return (
    hasExactKeys(v, ["v", "op", "nonce"]) &&
    v.v === NATIVE_VERSION &&
    (v.op === "pair" || v.op === "ensure") &&
    typeof v.nonce === "string" &&
    NONCE.test(v.nonce)
  );
}

/** A response for `request`: exact shape for its op, and the same nonce. */
export function isNativeResponseFor(v: unknown, request: NativeRequest): v is NativeResponse {
  if (!isPlainObject(v) || v.v !== NATIVE_VERSION || v.nonce !== request.nonce) return false;
  if (v.ok === false) {
    return (
      hasExactKeys(v, ["v", "ok", "nonce", "code"]) &&
      typeof v.code === "string" &&
      FAILURES.has(v.code)
    );
  }
  if (v.ok !== true) return false;
  if (request.op === "pair") {
    return (
      hasExactKeys(v, ["v", "ok", "nonce", "relayUrl", "secret"]) &&
      typeof v.relayUrl === "string" &&
      /^ws:\/\/127\.0\.0\.1:\d+\/bridge\/[^/?#]+$/.test(v.relayUrl) &&
      typeof v.secret === "string" &&
      /^[0-9a-f]{64}$/.test(v.secret)
    );
  }
  return (
    hasExactKeys(v, ["v", "ok", "nonce", "relay"]) &&
    (v.relay === "running" || v.relay === "spawned")
  );
}

/**
 * The native host name for a server. Chrome allows lowercase letters, digits,
 * `_` and `.` (no leading/trailing dot, no `..`).
 */
export const nativeHostName = (serverName: string): string =>
  `com.classytic.mcp_bridge.${serverName.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
