/**
 * `@classytic/mcp-bridge/auth` — mutual HMAC authentication between a relay and
 * whatever dials it, over WebCrypto where the runtime has it and a built-in
 * SHA-256 / HMAC where it doesn't (`useCrypto` to supply your own). The secret never
 * crosses the wire; the relay proves itself first; every proof is bound to
 * the connection's role and path, short-lived and single-use.
 */

export {
  type AuthClient,
  type AuthClientState,
  AuthError,
  createAuthClient,
  MAX_CHALLENGE_TTL_MS,
  MAX_CLOCK_SKEW_MS,
} from "./client.js";
export {
  type CryptoProvider,
  clientTokenOf,
  generateSecret,
  importPairingKey,
  isSecret,
  type PairingKey,
  randomBase64Url,
  SECRET_PATTERN,
  useCrypto,
} from "./crypto.js";
export {
  AUTH_VERSION,
  type AuthChallenge,
  type AuthHello,
  type AuthOk,
  type AuthResponse,
  type ChallengeFields,
  MAX_AUTH_FRAME_BYTES,
  parseAuthFrame,
  proofBytes,
} from "./frames.js";
export {
  type AuthAuthority,
  type AuthRefusal,
  CHALLENGE_TTL_MS,
  createAuthAuthority,
  type PendingChallenge,
} from "./server.js";
export { hmacSha256, sha256 } from "./sha256.js";
