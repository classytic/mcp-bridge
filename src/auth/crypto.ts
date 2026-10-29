/**
 * The pairing secret and the HMAC primitives over WebCrypto (browsers and
 * Node ≥ 20 alike — one implementation, so proofs can't drift between ends).
 *
 * The secret is 32 random bytes written as 64 lowercase hex characters and is
 * used directly as the HMAC-SHA256 key. That is sound only because it is 32
 * random bytes — so the format is enforced everywhere it is read.
 */

import { bytesToBase64Url, bytesToHex, hexToBytes } from "../internal/encoding.js";

export const SECRET_PATTERN = /^[0-9a-f]{64}$/;

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("mcp-bridge: WebCrypto (crypto.subtle) is not available in this runtime");
  return s;
};

export const isSecret = (v: unknown): v is string =>
  typeof v === "string" && SECRET_PATTERN.test(v);

/** A fresh pairing secret. */
export const generateSecret = (): string => bytesToHex(randomBytes(32));

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
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
  const key = await subtle().importKey(
    "raw",
    raw as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const digest = new Uint8Array(await subtle().digest("SHA-256", raw as BufferSource));
  return {
    keyId: bytesToBase64Url(digest).slice(0, 22),
    sign: async (data) => new Uint8Array(await subtle().sign("HMAC", key, data as BufferSource)),
    // subtle.verify compares in constant time.
    verify: (signature, data) =>
      subtle().verify("HMAC", key, signature as BufferSource, data as BufferSource),
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
