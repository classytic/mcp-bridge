/**
 * The relay: admits sockets, keeps the connected endpoints, routes MCP client
 * sessions to them, and drives heartbeats. No I/O of its own — adapters hand
 * it sockets (`accept`) and local clients (`openSession`).
 *
 * - Many endpoints, one per endpoint id (the same extension in several browser
 *   profiles). A newer connection takes over only its *own* id, once admitted
 *   (auth + hello); the old one is closed `4000 superseded`.
 * - Each session is bound to one endpoint — pinned at open, or chosen (see
 *   `./routing`) — and only that endpoint's frames reach it.
 * - `client` sockets (the stdio shim) carry any number of sessions via
 *   open / mcp / close frames.
 * - The relay pings every admitted socket; two missed pongs and it is closed —
 *   an open socket can outlive a dead extension service worker.
 */

import {
  type AuthAuthority,
  createAuthAuthority,
  type PairingKey,
  randomBase64Url,
} from "../auth/index.js";
import {
  type Capabilities,
  CloseCode,
  CONTRACT_VERSION,
  encodeFrame,
  type Frame,
  type HelloFrame,
  type PeerInfo,
  type ProtocolEra,
  parseFrame,
  readCapabilities,
  supports,
} from "../protocol/index.js";
import {
  type AcceptContext,
  type AdmissionLimits,
  createAdmissionGate,
  type RelaySocket,
} from "./admission.js";
import type { RelayFiles } from "./files.js";
import {
  CHOOSE_FIRST,
  type EndpointEntry,
  identityOf,
  LIST_ENDPOINTS,
  resolveEndpoint,
  SWITCH_TOOL_DEFINITIONS,
  USE_ENDPOINT,
} from "./routing.js";
import { type LocalTools, Session, type SessionDeps, type Upstream } from "./session.js";
import { toolFilter } from "./tool-filter.js";

export interface RelayLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface RelayOptions {
  /** The server this relay fronts (`xero`). Dialers must name the same one. */
  serverName: string;
  /** The imported pairing secret. */
  key: PairingKey;
  info?: PeerInfo;
  files?: RelayFiles;
  /** How long a client request waits for an endpoint before being answered offline. @default 3000 */
  waitForEndpointMs?: number;
  /** Error text for calls made while no endpoint is connected. */
  notConnectedMessage?: string;
  /**
   * Protocol eras to answer offline before any endpoint has said which it
   * serves. Set `["modern"]` for a 2026-only endpoint (e.g. arc-ai) so a client
   * never settles on 2025 while the extension is closed. @default both
   */
  offlineEras?: readonly ProtocolEra[];
  limits?: AdmissionLimits;
  /** @default { intervalMs: 20000, missedLimit: 2 } */
  heartbeat?: { intervalMs?: number; missedLimit?: number };
  logger?: RelayLogger;
  onStatus?: (status: RelayStatus) => void;
}

export interface RelayStatus {
  epoch: string;
  endpoints: Array<{ id: string; label: string; info: PeerInfo | undefined; sessions: number }>;
  sessions: Array<{
    id: string;
    client: PeerInfo | undefined;
    endpoint: string | undefined;
    pinned: boolean;
  }>;
  clients: number;
}

/** A session as a local adapter drives it (HTTP clients, in-process tests). */
export interface RelaySession {
  readonly id: string;
  receive(message: Parameters<Session["fromClient"]>[0]): Promise<void>;
  close(): void;
}

export interface OpenSessionOptions {
  client?: PeerInfo;
  /** Pin to an endpoint by id or label; it never switches. */
  endpoint?: string;
  /** Tool profile: only tools whose names match these patterns (`*` wildcard) — see `./tool-filter`. */
  tools?: readonly string[];
  /**
   * One request only (2026 HTTP): a `bridge_useEndpoint` choice could not
   * outlive it, so the tool tells the client to pin in the URL instead.
   */
  stateless?: boolean;
}

export interface Relay {
  readonly epoch: string;
  readonly authority: AuthAuthority;
  /** A socket the adapter has accepted (origin and path already checked). */
  accept(socket: RelaySocket, ctx: AcceptContext): void;
  /** A session for a local MCP client (HTTP, in-process). */
  openSession(upstream: Upstream, opts?: OpenSessionOptions): RelaySession;
  status(): RelayStatus;
  close(): void;
}

const NOT_CONNECTED =
  "The extension is not connected. Open it (and its side panel) in the browser, then try again.";
const RELAY_CAPABILITIES: Capabilities = {
  contractVersion: CONTRACT_VERSION,
  ops: ["ack", "files", "offline-handshake"],
};

type Endpoint = EndpointEntry & { socket: RelaySocket };

/** How a session finds its endpoint. */
interface Binding {
  /** Pinned selector (id or label) — never switches. */
  pinned: string | undefined;
  /** The endpoint id it is bound to, once known. */
  boundTo: string | undefined;
  /** Its label when bound, for messages while it is away. */
  boundLabel: string | undefined;
}

interface Live {
  socket: RelaySocket;
  missed: number;
  ping: ReturnType<typeof setInterval>;
}

export function createRelay(opts: RelayOptions): Relay {
  const logger: RelayLogger = opts.logger ?? { info() {}, warn() {} };
  const epoch = randomBase64Url(12);
  const relayInfo: PeerInfo = opts.info ?? { name: `${opts.serverName}-relay`, version: "0.1.0" };
  const authority = createAuthAuthority({ key: opts.key });
  const gate = createAdmissionGate({
    authority,
    serverName: opts.serverName,
    ...(opts.limits ? { limits: opts.limits } : {}),
    warn: logger.warn,
  });
  const intervalMs = opts.heartbeat?.intervalMs ?? 20_000;
  const missedLimit = opts.heartbeat?.missedLimit ?? 2;
  const notConnected = opts.notConnectedMessage ?? NOT_CONNECTED;

  const sessions = new Map<string, Session>();
  const bindings = new Map<string, Binding>();
  const endpoints = new Map<string, Endpoint>();
  const live = new Set<Live>();
  /** Eras each endpoint id said it serves, and the last any endpoint said — remembered across disconnects. */
  const erasById = new Map<string, readonly ProtocolEra[]>();
  let lastEras: readonly ProtocolEra[] = opts.offlineEras ?? ["legacy", "modern"];
  let generation = 0;
  let clientSockets = 0;
  let counter = 0;
  let closed = false;

  const status = (): RelayStatus => ({
    epoch,
    endpoints: [...endpoints.values()].map((e) => ({
      id: e.id,
      label: e.label,
      info: e.info,
      sessions: [...bindings.values()].filter((b) => b.boundTo === e.id).length,
    })),
    sessions: [...sessions.values()].map((s) => {
      const b = bindings.get(s.id);
      return { id: s.id, client: s.client, endpoint: b?.boundTo, pinned: !!b?.pinned };
    }),
    clients: clientSockets,
  });
  const emit = () => opts.onStatus?.(status());

  const send = (socket: RelaySocket, frame: Frame) => {
    try {
      socket.send(encodeFrame(frame));
    } catch (e) {
      logger.warn("relay: send failed", { error: String(e) });
    }
  };

  // ── bindings ─────────────────────────────────────────────────────────────

  /** The endpoint a session should talk to now, binding it when that is unambiguous. */
  function linkFor(b: Binding): Endpoint | undefined {
    if (b.boundTo) return endpoints.get(b.boundTo); // waits for *that* endpoint
    let entry: Endpoint | undefined;
    if (b.pinned) {
      const r = resolveEndpoint(endpoints.values(), b.pinned);
      entry = r.ok ? (r.entry as Endpoint) : undefined;
    } else if (endpoints.size === 1) {
      entry = endpoints.values().next().value;
    }
    if (entry) {
      b.boundTo = entry.id;
      b.boundLabel = entry.label;
    }
    return entry;
  }

  function notConnectedFor(b: Binding): string {
    if (!b.pinned && !b.boundTo && endpoints.size > 1) return CHOOSE_FIRST;
    if (b.boundTo) {
      return `The browser profile "${b.boundLabel ?? b.boundTo}" is not connected. Open the extension's side panel there, then try again.`;
    }
    if (b.pinned) {
      const r = resolveEndpoint(endpoints.values(), b.pinned);
      if (!r.ok) return r.message;
    }
    return notConnected;
  }

  function switchTools(sessionId: string, b: Binding, stateless: boolean): LocalTools {
    const names = new Set<string>([LIST_ENDPOINTS, USE_ENDPOINT]);
    return {
      visible: () => endpoints.size > 1,
      definitions: () => SWITCH_TOOL_DEFINITIONS as unknown as Record<string, unknown>[],
      handles: (name) => names.has(name),
      async call(name, args) {
        if (name === LIST_ENDPOINTS) {
          const list = [...endpoints.values()].map((e) => ({
            id: e.id,
            label: e.label,
            app: e.info?.name,
            current: e.id === b.boundTo,
          }));
          return { text: JSON.stringify({ endpoints: list, current: b.boundTo ?? null }) };
        }
        const selector = typeof args.endpoint === "string" ? args.endpoint : "";
        if (stateless) {
          return {
            text: `This connection is stateless (2026 HTTP), so a choice can't last beyond one call. Connect to /mcp?endpoint=${encodeURIComponent(selector)} instead.`,
            isError: true,
          };
        }
        const r = resolveEndpoint(endpoints.values(), selector);
        if (!r.ok) return { text: r.message, isError: true };
        const s = sessions.get(sessionId);
        if (s && b.boundTo !== r.entry.id) rebind(s, b, r.entry as Endpoint);
        return { text: `Now working in "${r.entry.label}" (${r.entry.id}).` };
      },
    };
  }

  /** Move an unpinned session to another endpoint (bridge_useEndpoint). */
  function rebind(s: Session, b: Binding, next: Endpoint) {
    const previous = b.boundTo ? endpoints.get(b.boundTo) : undefined;
    if (previous && s.isOpenOn(previous.generation))
      send(previous.socket, { type: "close", session: s.id });
    if (b.boundTo) s.detach("gone");
    b.boundTo = next.id;
    b.boundLabel = next.label;
    logger.info("relay: session switched endpoint", { session: s.id, endpoint: next.id });
    emit();
    s.attach(next);
  }

  /** Tool → groups, from any session's `tools/list` (tool profiles by `@group`). */
  const toolGroups = new Map<string, string[]>();

  function depsFor(
    sessionId: string,
    b: Binding,
    stateless: boolean,
    tools?: readonly string[],
  ): SessionDeps {
    const allowTool = toolFilter(tools);
    return {
      serverName: opts.serverName,
      relayVersion: relayInfo.version ?? "0.0.0",
      files: opts.files,
      waitMs: opts.waitForEndpointMs ?? 3000,
      get notConnected() {
        return notConnectedFor(b);
      },
      endpoint: () => linkFor(b),
      eras: () => {
        const id = b.boundTo;
        return (id && (endpoints.get(id)?.eras ?? erasById.get(id))) || lastEras;
      },
      choosing: () => !b.pinned && !b.boundTo && endpoints.size > 1,
      ...(b.pinned ? {} : { localTools: switchTools(sessionId, b, stateless) }),
      ...(allowTool ? { allowTool } : {}),
      toolGroups,
      warn: logger.warn,
    };
  }

  function newSession(id: string, upstream: Upstream, o: OpenSessionOptions = {}): Session {
    const b: Binding = {
      pinned: o.endpoint?.trim() || undefined,
      boundTo: undefined,
      boundLabel: undefined,
    };
    bindings.set(id, b);
    const s = new Session(id, upstream, depsFor(id, b, o.stateless === true, o.tools), o.client);
    sessions.set(id, s);
    emit();
    return s;
  }

  function closeSession(s: Session) {
    if (s.closed) return;
    const b = bindings.get(s.id);
    const ep = b?.boundTo ? endpoints.get(b.boundTo) : undefined;
    if (ep && s.isOpenOn(ep.generation)) send(ep.socket, { type: "close", session: s.id });
    s.close();
    sessions.delete(s.id);
    bindings.delete(s.id);
    emit();
  }

  // ── endpoints ────────────────────────────────────────────────────────────

  function dropEndpoint(socket: RelaySocket) {
    const entry = [...endpoints.values()].find((e) => e.socket === socket);
    if (!entry) return;
    endpoints.delete(entry.id);
    for (const s of sessions.values())
      if (bindings.get(s.id)?.boundTo === entry.id) s.detach("gone");
    logger.info("relay: endpoint disconnected", { endpoint: entry.id });
    emit();
  }

  function setEndpoint(socket: RelaySocket, hello: HelloFrame) {
    const { id, label } = identityOf(hello.endpoint);
    const caps = readCapabilities(hello.capabilities);
    const previous = endpoints.get(id);
    if (previous) {
      dropEndpoint(previous.socket);
      previous.socket.close(CloseCode.Superseded, "Superseded by a newer connection");
    }
    const entry: Endpoint = {
      id,
      label,
      info: hello.info,
      eras: caps.eras,
      socket,
      generation: ++generation,
      acks: supports(caps, "ack"),
      send: (frame: Frame) => send(socket, frame),
    };
    endpoints.set(id, entry);
    if (caps.eras?.length) {
      erasById.set(id, caps.eras);
      lastEras = caps.eras;
    }
    logger.info("relay: endpoint connected", {
      endpoint: id,
      label,
      app: hello.info?.name,
      eras: caps.eras,
    });
    emit();
    for (const s of sessions.values()) {
      const b = bindings.get(s.id);
      if (b && linkFor(b) === entry) s.attach(entry);
    }
  }

  function onEndpointFrame(socket: RelaySocket, frame: Frame) {
    const entry = [...endpoints.values()].find((e) => e.socket === socket);
    if (!entry) return; // a superseded endpoint's late frames
    const s = "session" in frame ? sessions.get(frame.session) : undefined;
    if (!s || bindings.get(s.id)?.boundTo !== entry.id) return;
    if (frame.type === "mcp") void s.fromEndpoint(frame.message);
    else if (frame.type === "ack") s.ack(frame.seq, frame.duplicate === true);
    else if (frame.type === "close") s.detach("closed");
  }

  // ── client sockets (stdio shims) ─────────────────────────────────────────

  function clientHandler(socket: RelaySocket) {
    const mine = new Map<string, Session>(); // the shim's session id → ours
    const prefix = `c${++counter}:`;
    return {
      frame(frame: Frame) {
        if (frame.type === "open") {
          const existing = mine.get(frame.session);
          if (existing) closeSession(existing);
          const upstream = {
            send: (message: Parameters<Upstream["send"]>[0]) =>
              send(socket, { type: "mcp", session: frame.session, message }),
          };
          mine.set(
            frame.session,
            newSession(prefix + frame.session, upstream, {
              ...(frame.client ? { client: frame.client } : {}),
              ...(frame.endpoint ? { endpoint: frame.endpoint } : {}),
              ...(frame.tools?.length ? { tools: frame.tools } : {}),
            }),
          );
        } else if (frame.type === "mcp") {
          void mine.get(frame.session)?.fromClient(frame.message);
        } else if (frame.type === "close") {
          const s = mine.get(frame.session);
          if (s) closeSession(s);
          mine.delete(frame.session);
        }
      },
      closed() {
        for (const s of mine.values()) closeSession(s);
        mine.clear();
      },
    };
  }

  // ── sockets ──────────────────────────────────────────────────────────────

  function startHeartbeat(socket: RelaySocket): Live {
    const entry: Live = {
      socket,
      missed: 0,
      ping: setInterval(() => {
        if (++entry.missed > missedLimit)
          return socket.close(CloseCode.Superseded, "Heartbeat timed out");
        send(socket, { type: "ping" });
      }, intervalMs),
    };
    live.add(entry);
    return entry;
  }

  function accept(socket: RelaySocket, ctx: AcceptContext) {
    if (closed) return socket.close(CloseCode.Normal, "Relay closing");
    let onFrame: ((frame: Frame) => void) | undefined;
    let onClosed: (() => void) | undefined;
    let beat: Live | undefined;

    const admission = gate.admit(socket, ctx, (hello) => {
      send(socket, {
        type: "ready",
        v: 1,
        relay: relayInfo,
        epoch,
        capabilities: RELAY_CAPABILITIES,
      });
      socket.admitted?.();
      beat = startHeartbeat(socket);
      if (hello.role === "endpoint") {
        onFrame = (f) => onEndpointFrame(socket, f);
        onClosed = () => dropEndpoint(socket);
        setEndpoint(socket, hello);
      } else {
        const handler = clientHandler(socket);
        clientSockets++;
        emit();
        onFrame = handler.frame;
        onClosed = () => {
          handler.closed();
          clientSockets--;
          emit();
        };
      }
    });
    if (!admission) return;

    socket.onMessage((data) => {
      if (!onFrame) return admission.handle(data);
      const parsed = parseFrame(data);
      if (!parsed.ok)
        return logger.warn("relay: dropped a malformed frame", { error: parsed.error.message });
      const frame = parsed.value;
      if (frame.type === "pong") {
        if (beat) beat.missed = 0;
        return;
      }
      if (frame.type === "ping") return send(socket, { type: "pong" });
      onFrame(frame);
    });
    socket.onClose(() => {
      admission.dispose();
      if (beat) {
        clearInterval(beat.ping);
        live.delete(beat);
      }
      onClosed?.();
    });
  }

  return {
    epoch,
    authority,
    accept,
    openSession(upstream, o = {}) {
      const s = newSession(`h${++counter}`, upstream, o);
      return {
        id: s.id,
        receive: (message) => s.fromClient(message),
        close: () => closeSession(s),
      };
    },
    status,
    close() {
      if (closed) return;
      closed = true;
      for (const s of [...sessions.values()]) s.close();
      sessions.clear();
      bindings.clear();
      for (const l of live) {
        clearInterval(l.ping);
        l.socket.close(CloseCode.Normal, "Relay closing");
      }
      live.clear();
      endpoints.clear();
    },
  };
}
