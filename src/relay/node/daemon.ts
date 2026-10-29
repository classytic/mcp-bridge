/**
 * The relay daemon: one per user + server, on 127.0.0.1. Owns the port —
 * **binding it is the single-instance lock** (a second start gets
 * `port-in-use` and leaves quietly). Exits by itself after `idleExitMs` with
 * no endpoint and no clients (openclaw `relay-daemon.ts`).
 *
 *   ws  /bridge/<server>  endpoints (allowed Origin) and stdio shims (no Origin)
 *   POST|GET|DELETE /mcp  MCP Streamable HTTP clients (bearer)
 *   GET /health           liveness for shims and `mcp-relay status` (bearer)
 *   POST /shutdown        stop the daemon (bearer) — `mcp-relay stop`
 *
 * Every request must name a loopback Host (DNS-rebinding guard).
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { clientTokenOf, importPairingKey } from "../../auth/index.js";
import {
  BRIDGE_PROTOCOL,
  BRIDGE_SUBPROTOCOL,
  bridgePath,
  type PeerInfo,
} from "../../protocol/index.js";
import { roleForOrigin } from "../admission.js";
import type { RelayFiles } from "../files.js";
import {
  createRelay,
  type Relay,
  type RelayLogger,
  type RelayOptions,
  type RelayStatus,
} from "../relay.js";
import { DEFAULT_PORT } from "./config.js";
import { createHttpMcp, hasBearer, MCP_PATH } from "./http-mcp.js";

export interface DaemonOptions {
  serverName: string;
  secret: string;
  /** Origins an endpoint may connect from (`chrome-extension://<id>`). */
  allowedOrigins: readonly string[];
  /** @default 17345 — 0 picks a free port (tests). */
  port?: number;
  /** @default "127.0.0.1" — never bind wider: the socket fronts a logged-in session. */
  host?: string;
  files?: RelayFiles;
  info?: PeerInfo;
  /** @default 600000 (10 min). 0 = never. */
  idleExitMs?: number;
  logger?: RelayLogger;
  onStatus?: (status: RelayStatus) => void;
  relay?: Pick<
    RelayOptions,
    "waitForEndpointMs" | "notConnectedMessage" | "heartbeat" | "limits" | "offlineEras"
  >;
}

export interface Daemon {
  readonly port: number;
  readonly relay: Relay;
  /** Resolves when the daemon stops, with why. */
  readonly done: Promise<"idle" | "closed">;
  close(): Promise<void>;
}

export type DaemonStart =
  | { ok: true; daemon: Daemon }
  | { ok: false; reason: "port-in-use" | "error"; error?: Error };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** WebSocket frames past this are refused (files ride inside MCP messages). */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/**
 * Raw bytes a socket may send before it is admitted (the handshake is a few
 * hundred bytes). Counted on the TCP socket, so an oversized frame is cut off
 * before `ws` buffers it — `maxPayload` applies to the whole connection.
 */
export const PRE_AUTH_WIRE_BYTES = 17 * 1024;

const hostIsLoopback = (host: string | undefined): boolean => {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOOPBACK_HOSTS.has(name ?? "");
};

const refuseUpgrade = (socket: Duplex, status: string) => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

export async function startDaemon(opts: DaemonOptions): Promise<DaemonStart> {
  const logger: RelayLogger = opts.logger ?? { info() {}, warn() {} };
  const host = opts.host ?? "127.0.0.1";
  const path = bridgePath(opts.serverName);
  const key = await importPairingKey(opts.secret);
  const clientToken = await clientTokenOf(opts.secret);

  const relay = createRelay({
    serverName: opts.serverName,
    key,
    ...(opts.info ? { info: opts.info } : {}),
    ...(opts.files ? { files: opts.files } : {}),
    logger,
    ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
    ...opts.relay,
  });
  const http = createHttpMcp({ relay, clientToken, logger });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: (protocols) =>
      protocols.size === 1 && protocols.has(BRIDGE_SUBPROTOCOL) ? BRIDGE_SUBPROTOCOL : false,
  });

  const server: Server = createServer((req, res) => {
    if (!hostIsLoopback(req.headers.host)) return void res.writeHead(421).end();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === MCP_PATH) {
      return void http.handle(req, res).catch((e: unknown) => {
        logger.warn("relay: /mcp failed", { error: String(e) });
        if (!res.headersSent) res.writeHead(500).end();
      });
    }
    if (url.pathname === "/shutdown" && req.method === "POST") {
      if (req.headers.origin !== undefined || !hasBearer(req, clientToken))
        return void res.writeHead(401).end();
      logger.info("relay: shutdown requested");
      res.writeHead(202).end();
      return void setImmediate(() => void stop("closed"));
    }
    if (url.pathname === "/health" && req.method === "GET") {
      if (req.headers.origin !== undefined || !hasBearer(req, clientToken))
        return void res.writeHead(401).end();
      const s = relay.status();
      return void res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          protocol: BRIDGE_PROTOCOL,
          server: opts.serverName,
          epoch: s.epoch,
          endpoint: s.endpoints.length > 0,
          endpoints: s.endpoints.map((e) => ({
            id: e.id,
            label: e.label,
            app: e.info?.name,
            sessions: e.sessions,
          })),
          sessions: s.sessions.length,
          clients: s.clients,
          pid: process.pid,
        }),
      );
    }
    res.writeHead(404).end();
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== path || url.search) return refuseUpgrade(socket, "404 Not Found");
    if (!hostIsLoopback(req.headers.host)) return refuseUpgrade(socket, "421 Misdirected Request");
    const offered = (req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (offered.length !== 1 || offered[0] !== BRIDGE_SUBPROTOCOL)
      return refuseUpgrade(socket, "400 Bad Request");
    const role = roleForOrigin(req.headers.origin, opts.allowedOrigins);
    if (!role) {
      logger.warn("relay: origin refused", { origin: req.headers.origin });
      return refuseUpgrade(socket, "403 Forbidden");
    }
    let preAuthBytes = head.length;
    const guard = (chunk: Buffer) => {
      preAuthBytes += chunk.length;
      if (preAuthBytes > PRE_AUTH_WIRE_BYTES) {
        logger.warn("relay: pre-auth byte limit exceeded");
        socket.destroy();
      }
    };
    socket.on("data", guard);
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      relay.accept(
        {
          admitted: () => void socket.off("data", guard),
          send: (data) => ws.send(data),
          close: (code, reason) => ws.close(code, reason),
          onMessage: (h) =>
            ws.on("message", (data, isBinary) =>
              isBinary ? ws.close(1003, "Text frames only") : h(data.toString()),
            ),
          onClose: (h) => ws.on("close", h),
        },
        { role, resource: path },
      );
    });
  });

  const listening = await new Promise<{ ok: true } | { ok: false; error: NodeJS.ErrnoException }>(
    (resolve) => {
      server.once("error", (error: NodeJS.ErrnoException) => resolve({ ok: false, error }));
      server.listen(opts.port ?? DEFAULT_PORT, host, () => resolve({ ok: true }));
    },
  );
  if (!listening.ok) {
    relay.close();
    wss.close();
    return listening.error.code === "EADDRINUSE"
      ? { ok: false, reason: "port-in-use" }
      : { ok: false, reason: "error", error: listening.error };
  }
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? DEFAULT_PORT);
  logger.info(
    `relay: listening on ws://${host}:${port}${path} and http://${host}:${port}${MCP_PATH}`,
  );

  let resolveDone: (why: "idle" | "closed") => void = () => {};
  const done = new Promise<"idle" | "closed">((r) => (resolveDone = r));
  let stopped = false;
  const stop = async (why: "idle" | "closed") => {
    if (stopped) return;
    stopped = true;
    clearInterval(idleTimer);
    relay.close();
    await http.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise<void>((r) => server.close(() => r()));
    resolveDone(why);
  };

  const idleExitMs = opts.idleExitMs ?? 600_000;
  let idleSince = Date.now();
  const idleTimer = setInterval(
    () => {
      const s = relay.status();
      const busy =
        s.endpoints.length > 0 || s.clients > 0 || s.sessions.length > 0 || http.sessions() > 0;
      if (busy) idleSince = Date.now();
      else if (idleExitMs > 0 && Date.now() - idleSince >= idleExitMs) {
        logger.info("relay: idle — exiting");
        void stop("idle");
      }
    },
    Math.min(30_000, Math.max(1000, idleExitMs / 4)),
  );
  idleTimer.unref();

  return { ok: true, daemon: { port, relay, done, close: () => stop("closed") } };
}
