/**
 * Pairing by code — for endpoints that can't use native messaging: a desktop
 * app's plugin (Adobe UXP, Figma, an Office add-in), a mobile app, a device.
 *
 *   1. The user runs `mcp-relay pair-code --server <name>`: the relay issues a
 *      short one-time code and the CLI prints it.
 *   2. The user types it into the plugin, which calls `pairWithCode` — a POST to
 *      the relay's `/pair` on 127.0.0.1 — and gets the relay URL and the secret.
 *
 * A code is single-use, lives `ttlMs` (5 min), and dies after `maxAttempts`
 * wrong guesses at it. Wrong codes are also throttled across the relay
 * (`maxFailuresPerMinute`), so guessing is hopeless: 8 characters from a
 * 30-symbol alphabet is ~39 bits, against a handful of tries.
 */

import { randomBytes } from "../auth/crypto.js";

/** Crockford-style: no 0/O, 1/I/L, U — easy to read aloud and type. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

export interface PairingCodeOptions {
  /** @default 300000 (5 min) */
  ttlMs?: number;
  /** Wrong guesses at the newest code before it is withdrawn. @default 5 */
  maxAttempts?: number;
  /** Wrong codes accepted per minute across the relay before all redeems pause. @default 20 */
  maxFailuresPerMinute?: number;
  now?: () => number;
}

export interface IssuedCode {
  /** As shown to the user: `ABCD-EFGH`. */
  code: string;
  expiresAt: number;
}

export type RedeemResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "expired" | "throttled" | "none_pending" };

export interface PairingCodes {
  issue(): IssuedCode;
  /** Spend `code` — true exactly once. Accepts any case, spaces and dashes. */
  redeem(code: string): RedeemResult;
  /** A code is waiting (keeps an idle relay alive). */
  pending(): boolean;
}

/** `abcd efgh`, `ABCD-EFGH`, `abcdefgh` → `ABCDEFGH`. */
export const normalizeCode = (code: string): string => code.toUpperCase().replace(/[\s-]/g, "");

export function createPairingCodes(opts: PairingCodeOptions = {}): PairingCodes {
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const maxAttempts = opts.maxAttempts ?? 5;
  const maxFailures = opts.maxFailuresPerMinute ?? 20;
  const now = opts.now ?? Date.now;
  /** Only the newest code is live — issuing again withdraws the last one. */
  let live: { code: string; expiresAt: number; attempts: number } | undefined;
  let failures: number[] = [];

  const fresh = (): string => {
    let out = "";
    // Rejection sampling keeps the alphabet uniform.
    while (out.length < CODE_LENGTH) {
      for (const b of randomBytes(16)) {
        if (b < 256 - (256 % ALPHABET.length) && out.length < CODE_LENGTH)
          out += ALPHABET[b % ALPHABET.length];
      }
    }
    return out;
  };

  return {
    issue() {
      const code = fresh();
      live = { code, expiresAt: now() + ttlMs, attempts: 0 };
      return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: live.expiresAt };
    },

    redeem(input) {
      const t = now();
      failures = failures.filter((at) => t - at < 60_000);
      if (failures.length >= maxFailures) return { ok: false, reason: "throttled" };
      if (!live) return { ok: false, reason: "none_pending" };
      if (t > live.expiresAt) {
        live = undefined;
        return { ok: false, reason: "expired" };
      }
      if (normalizeCode(input) !== live.code) {
        failures.push(t);
        if (++live.attempts >= maxAttempts) live = undefined;
        return { ok: false, reason: "invalid" };
      }
      live = undefined;
      return { ok: true };
    },

    pending: () => live !== undefined && now() <= live.expiresAt,
  };
}
