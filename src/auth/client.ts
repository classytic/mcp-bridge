/**
 * The dialer's side of the handshake (an endpoint, or the stdio shim):
 *
 *   new → waiting-challenge → waiting-ok → authenticated; any error → failed (final).
 *
 * The relay must prove it holds the secret *before* the dialer signs anything,
 * so a relay without the secret learns nothing. The challenge must be for the
 * role and path this dialer expects, fresh, and short-lived.
 */

import { base64UrlToBytes, bytesToBase64Url } from "../internal/encoding.js";
import type { Role } from "../protocol/frames.js";
import type { PairingKey } from "./crypto.js";
import { randomBase64Url } from "./crypto.js";
import {
  AUTH_VERSION,
  type AuthChallenge,
  type AuthHello,
  type AuthResponse,
  ID_BYTES,
  NONCE_BYTES,
  PROOF_BYTES,
  parseAuthFrame,
  proofBytes,
} from "./frames.js";

/** Longest challenge lifetime a dialer accepts. */
export const MAX_CHALLENGE_TTL_MS = 10_000;
/** How far the relay's clock may be from ours. */
export const MAX_CLOCK_SKEW_MS = 30_000;

export type AuthClientState =
  | "new"
  | "waiting-challenge"
  | "waiting-ok"
  | "authenticated"
  | "failed";

export interface AuthClient {
  readonly state: AuthClientState;
  /** Frame 1. */
  hello(): AuthHello;
  /** Frame 2 in, frame 3 out. Throws (and fails the client) on anything wrong. */
  answer(raw: string): Promise<AuthResponse>;
  /** Frame 4. Throws (and fails the client) unless it confirms our proof. */
  confirm(raw: string): Promise<void>;
}

export class AuthError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`mcp-bridge auth: ${reason}`);
    this.reason = reason;
  }
}

export function createAuthClient(opts: {
  key: PairingKey;
  role: Role;
  /** The path this dialer connected to; the challenge must name the same one. */
  resource: string;
  now?: () => number;
  clientNonce?: string;
}): AuthClient {
  const now = opts.now ?? Date.now;
  const clientNonce = opts.clientNonce ?? randomBase64Url(NONCE_BYTES);
  let state: AuthClientState = "new";
  let challenge: AuthChallenge | undefined;
  let clientProof: string | undefined;

  const fail = (reason: string): never => {
    state = "failed";
    throw new AuthError(reason);
  };
  const expect = (s: AuthClientState) => {
    if (state !== s) fail(`unexpected frame in state ${state}`);
  };

  return {
    get state() {
      return state;
    },
    hello() {
      expect("new");
      state = "waiting-challenge";
      return { type: "auth.hello", v: AUTH_VERSION, keyId: opts.key.keyId, clientNonce };
    },
    async answer(raw) {
      expect("waiting-challenge");
      const c = parseAuthFrame(raw, "auth.challenge") ?? fail("malformed challenge");
      if (c.keyId !== opts.key.keyId) fail("challenge for another key");
      if (c.clientNonce !== clientNonce) fail("challenge does not echo our nonce");
      if (c.role !== opts.role || c.resource !== opts.resource)
        fail("challenge bound to another role or path");
      if (!base64UrlToBytes(c.serverNonce, NONCE_BYTES)) fail("bad server nonce");
      if (!base64UrlToBytes(c.instanceId, ID_BYTES) || !base64UrlToBytes(c.sessionId, ID_BYTES))
        fail("bad ids");
      const t = now();
      const ttl = c.expiresAtMs - c.issuedAtMs;
      if (ttl <= 0 || ttl > MAX_CHALLENGE_TTL_MS) fail("challenge lifetime out of range");
      if (Math.abs(t - c.issuedAtMs) > MAX_CLOCK_SKEW_MS) fail("relay clock too far off");
      if (t > c.expiresAtMs) fail("challenge expired");
      const serverProof = base64UrlToBytes(c.serverProof, PROOF_BYTES) ?? fail("bad server proof");
      if (!(await opts.key.verify(serverProof, proofBytes("server", c))))
        fail("relay does not hold the secret");
      challenge = c;
      clientProof = bytesToBase64Url(await opts.key.sign(proofBytes("client", c)));
      state = "waiting-ok";
      return { type: "auth.response", v: AUTH_VERSION, sessionId: c.sessionId, clientProof };
    },
    async confirm(raw) {
      expect("waiting-ok");
      const okFrame = parseAuthFrame(raw, "auth.ok") ?? fail("malformed ok");
      const c = challenge as AuthChallenge;
      if (okFrame.sessionId !== c.sessionId) fail("ok for another session");
      const accept = base64UrlToBytes(okFrame.acceptProof, PROOF_BYTES) ?? fail("bad accept proof");
      if (!(await opts.key.verify(accept, proofBytes("accept", c, clientProof))))
        fail("relay did not accept our proof");
      state = "authenticated";
    },
  };
}
