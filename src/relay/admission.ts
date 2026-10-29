/**
 * Admission — everything before a socket is trusted. Bounded on every axis
 * (openclaw `preauth-websocket-guard.ts` / `auth-v2.ts`):
 *   - frames over 16 KiB are refused before parsing;
 *   - authentication must finish within `authMs`, the app `hello` within `helloMs`;
 *   - only `maxPending` sockets may be mid-admission at once (all local
 *     connections are one source, so a local process can't fan out around it).
 * Then: auth.hello → auth.challenge → auth.response → auth.ok → hello.
 */

import type { AuthAuthority, PendingChallenge } from "../auth/index.js";
import { MAX_AUTH_FRAME_BYTES } from "../auth/index.js";
import { createSerialQueue } from "../internal/serial-queue.js";
import { CloseCode, type HelloFrame, parseFrame, type Role } from "../protocol/index.js";

/** A connected WebSocket, as the relay needs it. Adapters wrap their socket type. */
export interface RelaySocket {
  send(data: string): void;
  close(code: number, reason?: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  /**
   * Called once the socket has authenticated and sent a valid hello — an
   * adapter lifts its pre-auth limits here (e.g. a raw byte cap on the wire).
   */
  admitted?(): void;
}

/** What the adapter learned from the upgrade request. */
export interface AcceptContext {
  /** From the Origin header — see {@link roleForOrigin}. */
  role: Role;
  /** The exact path connected to (`/bridge/xero`); bound into the auth proofs. */
  resource: string;
}

/**
 * An allowed extension origin → `endpoint`; no Origin (a local process — browsers
 * always send one) → `client`; anything else → refused (null).
 */
export function roleForOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): Role | null {
  if (origin === undefined) return "client";
  return allowedOrigins.includes(origin) ? "endpoint" : null;
}

export interface AdmissionLimits {
  /** @default 10000 */
  authMs?: number;
  /** @default 10000 */
  helloMs?: number;
  /** @default 64 */
  maxPending?: number;
}

export interface Admission {
  /** Feed a message received before admission completed. */
  handle(data: string): void;
  dispose(): void;
}

export function createAdmissionGate(opts: {
  authority: AuthAuthority;
  serverName: string;
  limits?: AdmissionLimits;
  warn(message: string, data?: Record<string, unknown>): void;
}) {
  const authMs = opts.limits?.authMs ?? 10_000;
  const helloMs = opts.limits?.helloMs ?? 10_000;
  const maxPending = opts.limits?.maxPending ?? 64;
  let pending = 0;

  /** Start admitting `socket`; `onAdmitted` runs once with its hello. Null when over capacity (already closed). */
  function admit(
    socket: RelaySocket,
    ctx: AcceptContext,
    onAdmitted: (hello: HelloFrame) => void,
  ): Admission | null {
    if (pending >= maxPending) {
      socket.close(CloseCode.Capacity, "Too many pending connections");
      return null;
    }
    pending++;
    const queue = createSerialQueue();
    let step: "auth.hello" | "auth.response" | "hello" | "done" = "auth.hello";
    let challenge: PendingChallenge | undefined;
    let timer = setTimeout(() => reject(CloseCode.Deadline, "Authentication timed out"), authMs);

    const finish = () => {
      if (step === "done") return;
      step = "done";
      clearTimeout(timer);
      pending--;
    };
    const reject = (code: number, reason: string) => {
      if (step === "done") return;
      finish();
      opts.warn("relay: connection refused", { role: ctx.role, reason });
      socket.close(code, reason);
    };

    const onFrame = async (data: string) => {
      if (step === "done") return;
      if (step !== "hello" && data.length > MAX_AUTH_FRAME_BYTES)
        return reject(CloseCode.AuthRejected, "Frame too large");
      if (step === "auth.hello") {
        const r = await opts.authority.challenge(data, ctx);
        if (!r.ok) return reject(CloseCode.AuthRejected, r.error);
        challenge = r.value.pending;
        step = "auth.response";
        return socket.send(JSON.stringify(r.value.frame));
      }
      if (step === "auth.response") {
        const r = await opts.authority.accept(data, challenge as PendingChallenge);
        if (!r.ok) return reject(CloseCode.AuthRejected, r.error);
        step = "hello";
        clearTimeout(timer);
        timer = setTimeout(() => reject(CloseCode.Deadline, "No hello"), helloMs);
        return socket.send(JSON.stringify(r.value));
      }
      // step === "hello"
      const parsed = parseFrame(data);
      if (!parsed.ok || parsed.value.type !== "hello")
        return reject(CloseCode.BadHello, "Expected hello");
      const hello = parsed.value;
      if (hello.role !== ctx.role)
        return reject(CloseCode.BadHello, "Role does not match the connection");
      if (hello.server !== opts.serverName)
        return reject(CloseCode.BadHello, `This relay serves "${opts.serverName}"`);
      finish();
      onAdmitted(hello);
    };

    return {
      handle: (data) => void queue(() => onFrame(data)),
      dispose: () => {
        if (step !== "done") finish();
      },
    };
  }

  return { admit, pendingCount: () => pending };
}
