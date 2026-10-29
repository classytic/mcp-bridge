/**
 * The four handshake frames and the bytes each proof signs. Shapes are exact —
 * a frame with an extra or missing key is refused (openclaw relay-auth v2).
 *
 *   1 dialer → relay  auth.hello     { v, keyId, clientNonce }
 *   2 relay → dialer  auth.challenge { v, keyId, instanceId, sessionId, clientNonce, serverNonce,
 *                                      issuedAtMs, expiresAtMs, role, resource, serverProof }
 *   3 dialer → relay  auth.response  { v, sessionId, clientProof }
 *   4 relay → dialer  auth.ok        { v, sessionId, acceptProof }
 */

import type { Role } from "../protocol/frames.js";
import { hasExactKeys, parseStrictJsonObject } from "../protocol/strict-json.js";

export const AUTH_VERSION = 1;
/** Auth frames are small; anything bigger is refused before parsing. */
export const MAX_AUTH_FRAME_BYTES = 16 * 1024;
export const NONCE_BYTES = 32;
export const ID_BYTES = 16;
export const PROOF_BYTES = 32;

export interface AuthHello {
  type: "auth.hello";
  v: 1;
  keyId: string;
  clientNonce: string;
}

/** What the relay commits to in a challenge — every field is signed into each proof. */
export interface ChallengeFields {
  keyId: string;
  instanceId: string;
  sessionId: string;
  clientNonce: string;
  serverNonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  role: Role;
  /** The exact path the socket connected to (`/bridge/xero`). */
  resource: string;
}

export interface AuthChallenge extends ChallengeFields {
  type: "auth.challenge";
  v: 1;
  serverProof: string;
}
export interface AuthResponse {
  type: "auth.response";
  v: 1;
  sessionId: string;
  clientProof: string;
}
export interface AuthOk {
  type: "auth.ok";
  v: 1;
  sessionId: string;
  acceptProof: string;
}

const HELLO_KEYS = ["type", "v", "keyId", "clientNonce"];
const CHALLENGE_KEYS = [
  "type",
  "v",
  "keyId",
  "instanceId",
  "sessionId",
  "clientNonce",
  "serverNonce",
  "issuedAtMs",
  "expiresAtMs",
  "role",
  "resource",
  "serverProof",
];
const RESPONSE_KEYS = ["type", "v", "sessionId", "clientProof"];
const OK_KEYS = ["type", "v", "sessionId", "acceptProof"];

const KEYS: Record<string, string[]> = {
  "auth.hello": HELLO_KEYS,
  "auth.challenge": CHALLENGE_KEYS,
  "auth.response": RESPONSE_KEYS,
  "auth.ok": OK_KEYS,
};

type AuthFrameByType = {
  "auth.hello": AuthHello;
  "auth.challenge": AuthChallenge;
  "auth.response": AuthResponse;
  "auth.ok": AuthOk;
};

/** Parse an auth frame of the expected type, or null. Strict: size cap, no duplicate keys, exact keys. */
export function parseAuthFrame<T extends keyof AuthFrameByType>(
  raw: string,
  type: T,
): AuthFrameByType[T] | null {
  const value = parseStrictJsonObject(raw, MAX_AUTH_FRAME_BYTES);
  if (!value || value.type !== type || value.v !== AUTH_VERSION) return null;
  if (!hasExactKeys(value, KEYS[type] as string[])) return null;
  for (const [k, v] of Object.entries(value)) {
    const numeric = k === "issuedAtMs" || k === "expiresAtMs" || k === "v";
    if (numeric ? !Number.isSafeInteger(v) : typeof v !== "string") return null;
  }
  if (type === "auth.challenge" && value.role !== "endpoint" && value.role !== "client")
    return null;
  return value as unknown as AuthFrameByType[T];
}

const encoder = new TextEncoder();
const PROOF_DOMAIN = "mcp-bridge.auth";

/**
 * The bytes a proof signs: a canonical JSON array (domain, version, kind, then
 * every challenge field in a fixed order; the accept proof also binds the
 * client proof it accepts).
 */
export function proofBytes(
  kind: "server" | "client" | "accept",
  f: ChallengeFields,
  clientProof?: string,
): Uint8Array {
  const fields: unknown[] = [
    PROOF_DOMAIN,
    AUTH_VERSION,
    kind,
    f.keyId,
    f.instanceId,
    f.sessionId,
    f.clientNonce,
    f.serverNonce,
    f.issuedAtMs,
    f.expiresAtMs,
    f.role,
    f.resource,
  ];
  if (kind === "accept") fields.push(clientProof ?? "");
  return encoder.encode(JSON.stringify(fields));
}
