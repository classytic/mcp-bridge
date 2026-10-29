/**
 * Serve MCP from anything that can open a WebSocket — an extension page, a
 * mobile app, a device. Dials the relay, authenticates both ways, then runs one
 * MCP server per client session the relay opens.
 *
 * Each session is served through the MCP SDK's era-aware entry (`serveStdio`
 * over the session's transport), so one endpoint answers 2025-era clients
 * (`initialize`) and 2026-07-28 clients (`server/discover` + per-request
 * envelope) alike.
 *
 * Every socket gets a generation number, checked after every await: a socket
 * that was replaced can never answer (openclaw `isCurrent`). `mcp` frames that
 * carry a `seq` are acked on receipt; a seq seen before (its ack was lost) is
 * acked as a duplicate and not run again.
 */

import type { McpServer, Server, Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  type AuthClient,
  createAuthClient,
  importPairingKey,
  type PairingKey,
} from "../auth/index.js";
import {
  BRIDGE_SUBPROTOCOL,
  type Capabilities,
  CONTRACT_VERSION,
  type EndpointIdentity,
  encodeFrame,
  type Frame,
  type JsonRpcMessage,
  type PeerInfo,
  type ProtocolEra,
  parseFrame,
  TERMINAL_CLOSE_CODES,
} from "../protocol/index.js";
import { SessionTransport } from "../transport/index.js";
import { type BackoffOptions, createBackoff } from "./backoff.js";

/** The subset of WebSocket used — browser `WebSocket` and `ws` both fit. */
export interface WebSocketLike {
  readonly readyState: number;
  /** The negotiated subprotocol. */
  readonly protocol: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface SessionContext {
  session: string;
  /** The MCP client behind it, when it identified itself. */
  client: PeerInfo | undefined;
}

/** Context for building a server: the session plus the protocol era it will serve. */
export interface ServerContext extends SessionContext {
  era: "legacy" | "modern";
}

/** A running session server — what `serveSession` returns. */
export interface SessionServer {
  close(): Promise<void>;
}

export type EndpointState = "connecting" | "connected" | "disconnected" | "refused" | "closed";

export interface EndpointStatus {
  state: EndpointState;
  relay?: PeerInfo;
  sessions: SessionContext[];
  error?: string;
  closeCode?: number;
}

export interface EndpointOptions {
  serverName: string;
  info?: PeerInfo;
  /**
   * Which endpoint this is, when several can serve the server — e.g. the same
   * extension in several browser profiles. Keep `id` stable per install (a
   * random 8–64 char id in that profile's storage); `label` is what people
   * pick it by (`--endpoint <label>`). Absent = the single unnamed endpoint.
   */
  endpoint?: EndpointIdentity | (() => EndpointIdentity | Promise<EndpointIdentity>);
  /** `bridgeUrl(port, serverName)`, or several to try in turn. */
  url: string | readonly string[];
  /** The pairing secret (64 hex), or a function reading it (re-read on every connect). */
  secret: string | (() => string | undefined | Promise<string | undefined>);
  /**
   * A fresh server for one session. It may be called twice for one session (the
   * SDK probes the protocol era with a throwaway instance), so never reuse one.
   */
  createServer?: (ctx: ServerContext) => McpServer | Server | Promise<McpServer | Server>;
  /**
   * Take over serving a session's transport yourself (e.g. a framework with its
   * own MCP entry). Overrides `createServer`.
   */
  serveSession?: (
    transport: Transport,
    ctx: SessionContext,
  ) => SessionServer | Promise<SessionServer>;
  /**
   * MCP protocol eras this endpoint's server answers, told to the relay so its
   * offline answers match. Set `["modern"]` for a 2026-only server (arc-ai's
   * `serveAsMcp`). @default ["legacy", "modern"]
   */
  eras?: ProtocolEra[];
  onStatus?: (status: EndpointStatus) => void;
  onError?: (error: Error) => void;
  backoff?: BackoffOptions;
  /** @default (url, protocols) => new WebSocket(url, protocols) */
  createSocket?: (url: string, protocols: string[]) => WebSocketLike;
}

export interface EndpointHandle {
  status(): EndpointStatus;
  /** Connect again now — after a refusal (new secret) or to skip the wait. */
  reconnect(): void;
  close(): Promise<void>;
}

const OPEN = 1;
const ENDPOINT_CAPABILITIES: Capabilities = {
  contractVersion: CONTRACT_VERSION,
  ops: ["ack", "files"],
};
const textOf = (data: unknown): string =>
  typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer | Uint8Array);
const pathOf = (url: string): string => new URL(url).pathname;

interface Live {
  ctx: SessionContext;
  transport: SessionTransport;
  ready: Promise<SessionServer | undefined>;
  /** Seqs already received, for this relay epoch. */
  seen: Set<number>;
}

export function connectEndpoint(opts: EndpointOptions): EndpointHandle {
  const urls = typeof opts.url === "string" ? [opts.url] : [...opts.url];
  const createServer = opts.createServer;
  if (!createServer && !opts.serveSession) {
    throw new Error("connectEndpoint: give createServer (a server per session) or serveSession");
  }
  if (urls.length === 0) throw new Error("connectEndpoint: no relay url");
  const createSocket =
    opts.createSocket ??
    ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
  const backoff = createBackoff(opts.backoff);

  let generation = 0;
  let socket: WebSocketLike | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let urlIndex = 0;
  let epoch: string | undefined;
  const sessions = new Map<string, Live>();
  /** Seen-seq sets survive a reconnect to the same relay epoch. */
  const seenBySession = new Map<string, Set<number>>();
  let status: EndpointStatus = { state: "connecting", sessions: [] };

  const setStatus = (patch: Partial<EndpointStatus>) => {
    status = { ...status, ...patch, sessions: [...sessions.values()].map((s) => s.ctx) };
    opts.onStatus?.(status);
  };

  const sendFrame = (frame: Frame) => {
    if (socket && socket.readyState === OPEN) socket.send(encodeFrame(frame));
  };

  function endSessions() {
    for (const s of sessions.values()) {
      s.transport.end();
      void s.ready.then((srv) => srv?.close()).catch(() => {});
    }
    sessions.clear();
  }

  function openSession(ctx: SessionContext) {
    sessions.get(ctx.session)?.transport.end();
    const transport = new SessionTransport(
      ctx.session,
      (message) =>
        sendFrame({ type: "mcp", session: ctx.session, message: message as JsonRpcMessage }),
      () => {
        sendFrame({ type: "close", session: ctx.session });
        sessions.delete(ctx.session);
        setStatus({});
      },
    );
    const serve =
      opts.serveSession ??
      ((t: Transport, c: SessionContext): SessionServer =>
        serveStdio(
          (f) => (createServer as NonNullable<typeof createServer>)({ ...c, era: f.era }),
          {
            transport: t,
            onerror: (e) => opts.onError?.(e),
          },
        ));
    const ready = Promise.resolve()
      .then(() => serve(transport, ctx))
      .catch((e: unknown) => {
        opts.onError?.(e instanceof Error ? e : new Error(String(e)));
        void transport.close();
        return undefined;
      });
    const seen = seenBySession.get(ctx.session) ?? new Set<number>();
    seenBySession.set(ctx.session, seen);
    sessions.set(ctx.session, { ctx, transport, ready, seen });
    setStatus({});
  }

  function onAppFrame(frame: Frame) {
    switch (frame.type) {
      case "ready":
        if (epoch !== frame.epoch) seenBySession.clear(); // relay restarted: old seqs mean nothing
        epoch = frame.epoch;
        backoff.opened();
        return setStatus({
          state: "connected",
          relay: frame.relay,
          error: undefined,
          closeCode: undefined,
        });
      case "open":
        return openSession({ session: frame.session, client: frame.client });
      case "mcp": {
        const s = sessions.get(frame.session);
        if (!s) return;
        if (frame.seq !== undefined) {
          if (s.seen.has(frame.seq))
            return sendFrame({
              type: "ack",
              session: frame.session,
              seq: frame.seq,
              duplicate: true,
            });
          s.seen.add(frame.seq);
          sendFrame({ type: "ack", session: frame.session, seq: frame.seq });
        }
        void s.ready.then(() => s.transport.receive(frame.message as never));
        return;
      }
      case "close": {
        const s = sessions.get(frame.session);
        if (!s) return;
        sessions.delete(frame.session);
        seenBySession.delete(frame.session);
        s.transport.end();
        void s.ready.then((srv) => srv?.close()).catch(() => {});
        return setStatus({});
      }
      case "ping":
        return sendFrame({ type: "pong" });
      default:
        return;
    }
  }

  function schedule() {
    if (stopped) return;
    retry = setTimeout(() => void connect(), backoff.nextDelay());
  }

  async function connect() {
    retry = undefined;
    if (stopped) return;
    const gen = ++generation;
    const current = () => gen === generation && !stopped;
    setStatus({ state: "connecting" });

    const secret = typeof opts.secret === "function" ? await opts.secret() : opts.secret;
    const identity = typeof opts.endpoint === "function" ? await opts.endpoint() : opts.endpoint;
    if (!current()) return;
    let key: PairingKey;
    try {
      if (!secret) throw new Error("Not paired — no relay secret set.");
      key = await importPairingKey(secret);
    } catch (e) {
      return setStatus({ state: "refused", error: e instanceof Error ? e.message : String(e) });
    }
    if (!current()) return;

    const url = urls[urlIndex++ % urls.length] as string;
    let ws: WebSocketLike;
    try {
      ws = createSocket(url, [BRIDGE_SUBPROTOCOL]);
    } catch (e) {
      setStatus({ state: "disconnected", error: e instanceof Error ? e.message : String(e) });
      return schedule();
    }
    socket = ws;
    let auth: AuthClient | undefined;
    const queue: string[] = [];
    let busy = false;

    const step = async (data: string) => {
      if (!auth) return;
      if (auth.state === "waiting-challenge")
        return ws.send(JSON.stringify(await auth.answer(data)));
      if (auth.state === "waiting-ok") {
        await auth.confirm(data);
        if (!current()) return;
        return ws.send(
          encodeFrame({
            type: "hello",
            v: 1,
            role: "endpoint",
            server: opts.serverName,
            ...(opts.info ? { info: opts.info } : {}),
            ...(identity ? { endpoint: identity } : {}),
            capabilities: { ...ENDPOINT_CAPABILITIES, eras: opts.eras ?? ["legacy", "modern"] },
          }),
        );
      }
      const parsed = parseFrame(data);
      if (parsed.ok) onAppFrame(parsed.value);
    };
    const drain = async () => {
      if (busy) return;
      busy = true;
      try {
        while (queue.length && current()) await step(queue.shift() as string);
      } catch (e) {
        setStatus({ state: "disconnected", error: e instanceof Error ? e.message : String(e) });
        ws.close(4003, "Authentication failed");
      } finally {
        busy = false;
      }
    };

    ws.onopen = () => {
      if (!current()) return;
      if (ws.protocol !== BRIDGE_SUBPROTOCOL) return ws.close(4426, "Subprotocol not negotiated");
      auth = createAuthClient({ key, role: "endpoint", resource: pathOf(url) });
      ws.send(JSON.stringify(auth.hello()));
    };
    ws.onmessage = (ev) => {
      if (!current()) return;
      queue.push(textOf(ev.data));
      void drain();
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (socket === ws) socket = undefined;
      if (!current()) return;
      endSessions();
      if (TERMINAL_CLOSE_CODES.has(ev.code)) {
        return setStatus({
          state: "refused",
          error: ev.reason || `Refused (${ev.code})`,
          closeCode: ev.code,
        });
      }
      setStatus({ state: "disconnected", error: ev.reason || undefined, closeCode: ev.code });
      schedule();
    };
  }

  void connect();

  return {
    status: () => status,
    reconnect() {
      if (stopped) return;
      if (retry) clearTimeout(retry);
      backoff.reset();
      const old = socket;
      socket = undefined;
      generation++;
      endSessions();
      old?.close(1000, "Reconnecting");
      void connect();
    },
    async close() {
      stopped = true;
      generation++;
      if (retry) clearTimeout(retry);
      const servers = [...sessions.values()].map((s) => s.ready);
      endSessions();
      socket?.close(1000, "Endpoint closing");
      socket = undefined;
      await Promise.all(servers.map((p) => p.then((srv) => srv?.close()).catch(() => {})));
      setStatus({ state: "closed" });
    },
  };
}
