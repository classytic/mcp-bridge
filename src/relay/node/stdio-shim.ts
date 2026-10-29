/**
 * The stdio shim — what an MCP client launches when it only speaks stdio. It
 * makes sure the daemon runs (attach-or-spawn), dials it as a `client`
 * (mutual auth, no Origin), and carries one MCP session between stdin/stdout
 * and the daemon. If the daemon goes away it starts/finds one again and replays
 * the client's handshake (2025) and re-opens its `subscriptions/listen`
 * streams (2026, the duplicate acknowledgement dropped), so the client keeps
 * its connection.
 *
 * stdout carries MCP only — logs go to stderr.
 */

import type { Readable, Writable } from "node:stream";
import WebSocket from "ws";
import { clientTokenOf, createAuthClient, importPairingKey } from "../../auth/index.js";
import {
  BRIDGE_SUBPROTOCOL,
  bridgePath,
  clientInfoOf,
  encodeFrame,
  errorResponse,
  type Frame,
  idOf,
  isJsonRpcMessage,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  notification,
  type PeerInfo,
  parseFrame,
} from "../../protocol/index.js";
import { listenToolsChanged, subscriptionOf, wantsToolChanges } from "../offline.js";
import type { RelayLogger } from "../relay.js";
import { ensureDaemon } from "./attach.js";

export interface StdioShimOptions {
  serverName: string;
  /** Pin this client to one endpoint (browser profile) by id or label. */
  endpoint?: string;
  /** Tool profile: only these tools (name patterns, `*` wildcard). */
  tools?: string[];
  secret: string;
  port: number;
  host?: string;
  /** Starts the daemon when none is running. */
  spawnDaemon: () => void;
  stdin?: Readable;
  stdout?: Writable;
  logger?: RelayLogger;
}

const SESSION = "stdio";
const REPLAY_PREFIX = "mcp-bridge-shim-replay:";
const DAEMON_GONE = "The relay restarted before answering; try again.";

/** Newline-delimited JSON-RPC (MCP's stdio framing). */
function readLines(
  input: Readable,
  onMessage: (m: JsonRpcMessage) => void,
  onEnd: () => void,
  warn: RelayLogger["warn"],
) {
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isJsonRpcMessage(value)) onMessage(value);
        else warn("shim: stdin line is not JSON-RPC");
      } catch {
        warn("shim: stdin line is not JSON");
      }
    }
  });
  input.once("end", onEnd);
  input.once("close", onEnd);
}

export async function runStdioShim(opts: StdioShimOptions): Promise<{ done: Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const logger: RelayLogger = opts.logger ?? { info() {}, warn() {} };
  const key = await importPairingKey(opts.secret);
  const clientToken = await clientTokenOf(opts.secret);
  const resource = bridgePath(opts.serverName);

  const out = (m: JsonRpcMessage) => stdout.write(`${JSON.stringify(m)}\n`);
  let ws: WebSocket | undefined;
  let ready = false;
  let opened = false;
  let stopping = false;
  let client: PeerInfo | undefined;
  let initRequest: JsonRpcMessage | undefined;
  let initializedNote: JsonRpcMessage | undefined;
  let handshaken = false;
  let replays = 0;
  const inflight = new Map<JsonRpcId, string>();
  /** The client's listen streams; `held` while the daemon is away. */
  const listens = new Map<JsonRpcId, { message: JsonRpcMessage; acked: boolean; held: boolean }>();
  const waiting: JsonRpcMessage[] = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => (resolveDone = r));

  const send = (frame: Frame) => ws?.send(encodeFrame(frame));

  function forward(m: JsonRpcMessage) {
    if (!ready) return void waiting.push(m);
    if (!opened) {
      opened = true;
      send({
        type: "open",
        session: SESSION,
        ...(client ? { client } : {}),
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        ...(opts.tools?.length ? { tools: opts.tools } : {}),
      });
      if (handshaken && initRequest) {
        // A reconnect: the new session needs the client's handshake again.
        send({
          type: "mcp",
          session: SESSION,
          message: { ...initRequest, id: `${REPLAY_PREFIX}${++replays}` },
        });
        send({
          type: "mcp",
          session: SESSION,
          message: initializedNote ?? notification("notifications/initialized"),
        });
        out(notification("notifications/tools/list_changed"));
      }
    }
    send({ type: "mcp", session: SESSION, message: m });
  }

  function fromClient(m: JsonRpcMessage) {
    client ??= clientInfoOf(m);
    if (isRequest(m)) {
      inflight.set(idOf(m) as JsonRpcId, m.method as string);
      if (m.method === "initialize") initRequest = m;
      if (m.method === "subscriptions/listen") {
        listens.set(idOf(m) as JsonRpcId, { message: m, acked: false, held: false });
      }
    } else if (m.method === "notifications/initialized") {
      initializedNote = m;
    }
    forward(m);
  }

  function fromDaemon(m: JsonRpcMessage) {
    if (m.method === "notifications/subscriptions/acknowledged") {
      const listen = listens.get(subscriptionOf(m) as JsonRpcId);
      if (listen?.acked) return; // re-opened stream: the client has its acknowledgement
      if (listen) listen.acked = true;
    }
    if (isResponse(m)) {
      const id = idOf(m) as JsonRpcId;
      if (typeof id === "string" && id.startsWith(REPLAY_PREFIX)) return;
      if (inflight.get(id) === "initialize" && "result" in m) handshaken = true;
      inflight.delete(id);
      listens.delete(id);
    }
    out(m);
  }

  async function connect(): Promise<void> {
    await ensureDaemon({
      host,
      port: opts.port,
      serverName: opts.serverName,
      clientToken,
      spawnDaemon: opts.spawnDaemon,
    });
    const socket = new WebSocket(`ws://${host}:${opts.port}${resource}`, [BRIDGE_SUBPROTOCOL]);
    ws = socket;
    const auth = createAuthClient({ key, role: "client", resource });
    socket.on("open", () => socket.send(JSON.stringify(auth.hello())));
    socket.on("message", async (data) => {
      const text = data.toString();
      try {
        if (auth.state === "waiting-challenge")
          return socket.send(JSON.stringify(await auth.answer(text)));
        if (auth.state === "waiting-ok") {
          await auth.confirm(text);
          return socket.send(
            encodeFrame({ type: "hello", v: 1, role: "client", server: opts.serverName }),
          );
        }
      } catch (e) {
        logger.warn("shim: authentication failed", { error: String(e) });
        return socket.close(4003, "Authentication failed");
      }
      const parsed = parseFrame(text);
      if (!parsed.ok) return;
      const frame = parsed.value;
      if (frame.type === "ready") {
        ready = true;
        for (const m of waiting.splice(0)) forward(m);
        for (const [id, listen] of listens) {
          if (!listen.held) continue;
          listen.held = false;
          if (listen.acked && wantsToolChanges(listen.message)) out(listenToolsChanged(id));
          inflight.set(id, "subscriptions/listen");
          forward(listen.message);
        }
      } else if (frame.type === "mcp" && frame.session === SESSION) {
        fromDaemon(frame.message);
      } else if (frame.type === "ping") {
        send({ type: "pong" });
      }
    });
    socket.on("close", () => {
      if (ws !== socket) return;
      ws = undefined;
      ready = false;
      opened = false;
      for (const [id] of inflight) {
        const listen = listens.get(id);
        if (listen)
          listen.held = true; // a subscription survives — re-opened on reconnect
        else out(errorResponse(id, DAEMON_GONE));
      }
      inflight.clear();
      if (!stopping) void reconnect();
    });
    socket.on("error", (e) => logger.warn("shim: socket error", { error: e.message }));
  }

  async function reconnect(delay = 200): Promise<void> {
    while (!stopping) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        return await connect();
      } catch (e) {
        logger.warn("shim: relay unavailable", { error: String(e) });
        delay = Math.min(delay * 2, 5000);
      }
    }
  }

  readLines(
    stdin,
    fromClient,
    () => {
      stopping = true;
      ws?.close(1000, "Client exited");
      resolveDone();
    },
    logger.warn,
  );
  await connect();
  return { done };
}
