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
  /**
   * The roles this connection may take — see {@link rolesForOrigin}. The dialer
   * picks one in `auth.hello`; the relay binds it into the proofs.
   */
  roles?: readonly Role[];
  /** The one role this connection may take (as before 0.2). Ignored when `roles` is set. */
  role?: Role;
  /** The exact path connected to (`/bridge/<server>`); bound into the auth proofs. */
  resource: string;
}

export interface OriginPolicy {
  /**
   * Origins allowed to connect as an endpoint: a browser extension
   * (`chrome-extension://<id>`), a web app, or `"null"` — the opaque origin of a
   * sandboxed iframe or a `file:` page (Figma's plugin UI is one). Listing
   * `"null"` admits ANY such page that also proves the secret.
   */
  allowedOrigins: readonly string[];
  /**
   * Whether a connection with no Origin — a local process or a desktop app's
   * plugin runtime (Adobe UXP, a Node or Python app) — may be an endpoint as well
   * as a client. Either way it must prove the pairing secret. @default true
   */
  localEndpoints?: boolean;
}

/**
 * The roles a connection may take, from its Origin header, or null to refuse it:
 *   no Origin       → client, and endpoint unless `localEndpoints: false`
 *   allowed origin  → endpoint
 *   any other       → refused (a web page the user merely visited)
 * Every role must still prove the pairing secret; the Origin only narrows who may try.
 */
export function rolesForOrigin(origin: string | undefined, policy: OriginPolicy): Role[] | null {
  if (origin === undefined)
    return policy.localEndpoints === false ? ["client"] : ["client", "endpoint"];
  return policy.allowedOrigins.includes(origin) ? ["endpoint"] : null;
}

/**
 * @deprecated Use {@link rolesForOrigin} — a desktop plugin with no Origin can be an endpoint.
 * An allowed origin → `endpoint`; no Origin → `client`; anything else → null.
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
      opts.warn("relay: connection refused", {
        role: challenge?.fields.role ?? ctx.roles ?? ctx.role,
        reason,
      });
      socket.close(code, reason);
    };

    const onFrame = async (data: string) => {
      if (step === "done") return;
      if (step !== "hello" && data.length > MAX_AUTH_FRAME_BYTES)
        return reject(CloseCode.AuthRejected, "Frame too large");
      if (step === "auth.hello") {
        const r = await opts.authority.challenge(data, {
          ...(ctx.roles ? { roles: ctx.roles } : ctx.role ? { role: ctx.role } : {}),
          resource: ctx.resource,
        });
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
      if (hello.role !== (challenge as PendingChallenge).fields.role)
        return reject(CloseCode.BadHello, "Role does not match the one authenticated");
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
