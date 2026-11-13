/**
 * The pairing secret and the HMAC primitives. WebCrypto where the runtime has
 * it (browsers, Node ≥ 20); otherwise a built-in SHA-256 / HMAC (`./sha256`) —
 * some desktop plugin hosts have no `crypto.subtle`. Both make identical proofs.
 * A host can supply its own randomness or HMAC with {@link useCrypto}.
 *
 * The secret is 32 random bytes written as 64 lowercase hex characters and is
 * used directly as the HMAC-SHA256 key. That is sound only because it is 32
 * random bytes — so the format is enforced everywhere it is read.
 */

import { bytesToBase64Url, bytesToHex, hexToBytes } from "../internal/encoding.js";
import { constantTimeEqual, hmacSha256, sha256 } from "./sha256.js";

export const SECRET_PATTERN = /^[0-9a-f]{64}$/;

/** What a runtime without (complete) WebCrypto can supply. */
export interface CryptoProvider {
  /**
   * Cryptographically secure random bytes — fill `bytes` and return it. Needed
   * where `crypto.getRandomValues` is missing; never pass `Math.random`.
   */
  getRandomValues?(bytes: Uint8Array): Uint8Array;
  /** HMAC-SHA256 from the platform (e.g. a native module). Default: WebCrypto, else built-in. */
  hmacSha256?(key: Uint8Array, data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  /** Set false to never use `crypto.subtle` (tests, or a host whose WebCrypto misbehaves). */
  webCrypto?: boolean;
}

let provider: CryptoProvider = {};

/**
 * Configure the crypto this module uses — call once, before pairing or connecting.
 *
 * @example A plugin host without `crypto.getRandomValues`:
 * ```ts
 * useCrypto({ getRandomValues: (b) => host.secureRandom(b) });
 * ```
 */
export function useCrypto(next: CryptoProvider): void {
  provider = { ...provider, ...next };
}

const subtle = (): SubtleCrypto | undefined =>
  provider.webCrypto === false ? undefined : globalThis.crypto?.subtle;

export const isSecret = (v: unknown): v is string =>
  typeof v === "string" && SECRET_PATTERN.test(v);

/** A fresh pairing secret. */
export const generateSecret = (): string => bytesToHex(randomBytes(32));

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (provider.getRandomValues) return provider.getRandomValues(out);
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error(
      "mcp-bridge: no secure random source — pass one with useCrypto({ getRandomValues })",
    );
  }
  globalThis.crypto.getRandomValues(out);
  return out;
}

export const randomBase64Url = (n: number): string => bytesToBase64Url(randomBytes(n));

/** A paired secret, ready to sign and verify. */
export interface PairingKey {
  readonly keyId: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
  verify(signature: Uint8Array, data: Uint8Array): Promise<boolean>;
}

/** Import a secret. `keyId` = first 22 chars of base64url(SHA-256(secret bytes)). */
export async function importPairingKey(secret: string): Promise<PairingKey> {
  if (!isSecret(secret))
    throw new Error("mcp-bridge: the pairing secret must be 64 lowercase hex characters");
  const raw = hexToBytes(secret);
  const s = subtle();

  if (provider.hmacSha256 || !s) {
    // A supplied HMAC, or the built-in one where WebCrypto is missing.
    const hmac = provider.hmacSha256 ?? hmacSha256;
    const sign = async (data: Uint8Array) => new Uint8Array(await hmac(raw, data));
    return {
      keyId: bytesToBase64Url(sha256(raw)).slice(0, 22),
      sign,
      verify: async (signature, data) => constantTimeEqual(signature, await sign(data)),
    };
  }

  const key = await s.importKey(
    "raw",
    raw as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const digest = new Uint8Array(await s.digest("SHA-256", raw as BufferSource));
  return {
    keyId: bytesToBase64Url(digest).slice(0, 22),
    sign: async (data) => new Uint8Array(await s.sign("HMAC", key, data as BufferSource)),
    // subtle.verify compares in constant time.
    verify: (signature, data) =>
      s.verify("HMAC", key, signature as BufferSource, data as BufferSource),
  };
}

const CLIENT_TOKEN_LABEL = new TextEncoder().encode("mcp-bridge.client-token.v1");

/**
 * The bearer token HTTP MCP clients present to the relay, derived from the
 * pairing secret — one `pair` covers the extension and the CLIs.
 */
export async function clientTokenOf(secret: string): Promise<string> {
  const key = await importPairingKey(secret);
  return bytesToHex(await key.sign(CLIENT_TOKEN_LABEL));
}
