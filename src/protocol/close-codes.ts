/** WebSocket close codes the bridge uses (4000–4999 is the application range). */
export const CloseCode = {
  Normal: 1000,
  /** Something broke on our side after authentication. */
  Internal: 1011,
  /** A newer endpoint took over, or the peer stopped answering heartbeats. */
  Superseded: 4000,
  /** No valid application `hello` after authenticating. */
  BadHello: 4001,
  /** Authentication failed — wrong secret, bad proof, expired challenge. */
  AuthRejected: 4003,
  /** A deadline passed (authentication or hello). */
  Deadline: 4008,
  /** Too many connections waiting to authenticate. */
  Capacity: 4013,
  /** The peer speaks a different bridge protocol version. */
  ProtocolMismatch: 4426,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/** Codes a reconnect won't fix — an endpoint stops retrying and asks for attention. */
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  CloseCode.AuthRejected,
  CloseCode.ProtocolMismatch,
]);
