/**
 * The relay's side of the handshake. One authority per relay process: it owns
 * the key, an instance id, and the replay guard. Per connection it issues a
 * challenge bound to that connection's role and path, then checks the answer.
 *
 * - Server proof first (the dialer checks it before signing anything).
 * - A challenge is single-use and consumed *before* the proof is checked, so a
 *   duplicate answer can't race a good one.
 * - `keyId:clientNonce` pairs are remembered until their challenge expires.
 */

import { err, ok, type Result } from "@classytic/primitives/result";
import { base64UrlToBytes, bytesToBase64Url } from "../internal/encoding.js";
import type { Role } from "../protocol/frames.js";
import { type PairingKey, randomBase64Url } from "./crypto.js";
import {
  AUTH_VERSION,
  type AuthChallenge,
  type AuthOk,
  type ChallengeFields,
  ID_BYTES,
  NONCE_BYTES,
  PROOF_BYTES,
  parseAuthFrame,
  proofBytes,
} from "./frames.js";

export const CHALLENGE_TTL_MS = 10_000;
const MAX_REPLAY_ENTRIES = 1024;

export type AuthRefusal =
  | "malformed"
  | "unknown_key"
  | "replay"
  | "capacity"
  | "expired"
  | "bad_proof";

/** An issued challenge, waiting for its answer. */
export interface PendingChallenge {
  readonly fields: ChallengeFields;
  /** Set once answered (right or wrong) — a challenge is single-use. */
  used: boolean;
}

export interface AuthAuthority {
  readonly instanceId: string;
  /** Frame 1 in, frame 2 out. */
  challenge(
    raw: string,
    binding: { role: Role; resource: string },
  ): Promise<Result<{ frame: AuthChallenge; pending: PendingChallenge }, AuthRefusal>>;
  /** Frame 3 in, frame 4 out. */
  accept(raw: string, pending: PendingChallenge): Promise<Result<AuthOk, AuthRefusal>>;
}

export function createAuthAuthority(opts: {
  key: PairingKey;
  now?: () => number;
  ttlMs?: number;
}): AuthAuthority {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? CHALLENGE_TTL_MS;
  const instanceId = randomBase64Url(ID_BYTES);
  /** `keyId:clientNonce` → expiry. */
  const seen = new Map<string, number>();

  const prune = (t: number) => {
    for (const [k, exp] of seen) if (exp < t) seen.delete(k);
  };

  return {
    instanceId,
    async challenge(raw, binding) {
      const hello = parseAuthFrame(raw, "auth.hello");
      if (!hello || !base64UrlToBytes(hello.clientNonce, NONCE_BYTES)) return err("malformed");
      if (hello.keyId !== opts.key.keyId) return err("unknown_key");
      const t = now();
      prune(t);
      const replayKey = `${hello.keyId}:${hello.clientNonce}`;
      if (seen.has(replayKey)) return err("replay");
      if (seen.size >= MAX_REPLAY_ENTRIES) return err("capacity");
      const fields: ChallengeFields = {
        keyId: opts.key.keyId,
        instanceId,
        sessionId: randomBase64Url(ID_BYTES),
        clientNonce: hello.clientNonce,
        serverNonce: randomBase64Url(NONCE_BYTES),
        issuedAtMs: t,
        expiresAtMs: t + ttlMs,
        role: binding.role,
        resource: binding.resource,
      };
      seen.set(replayKey, fields.expiresAtMs);
      const serverProof = bytesToBase64Url(await opts.key.sign(proofBytes("server", fields)));
      return ok({
        frame: { type: "auth.challenge", v: AUTH_VERSION, ...fields, serverProof },
        pending: { fields, used: false },
      });
    },
    async accept(raw, pending) {
      if (pending.used) return err("replay");
      pending.used = true; // consumed before checking — single use, even if wrong
      const response = parseAuthFrame(raw, "auth.response");
      if (!response || response.sessionId !== pending.fields.sessionId) return err("malformed");
      if (now() > pending.fields.expiresAtMs) return err("expired");
      const proof = base64UrlToBytes(response.clientProof, PROOF_BYTES);
      if (!proof || !(await opts.key.verify(proof, proofBytes("client", pending.fields))))
        return err("bad_proof");
      const acceptProof = bytesToBase64Url(
        await opts.key.sign(proofBytes("accept", pending.fields, response.clientProof)),
      );
      return ok({
        type: "auth.ok",
        v: AUTH_VERSION,
        sessionId: pending.fields.sessionId,
        acceptProof,
      });
    },
  };
}
