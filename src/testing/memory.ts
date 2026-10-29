/**
 * In-memory wiring — a relay core, endpoints and MCP clients in one process,
 * no network. What the conformance suites run on, and handy in any host's tests.
 */

import type { Transport } from "@modelcontextprotocol/server";
import type { WebSocketLike } from "../endpoint/index.js";
import { BRIDGE_SUBPROTOCOL, bridgePath, type JsonRpcMessage } from "../protocol/index.js";
import { type Relay, type RelaySocket, roleForOrigin } from "../relay/index.js";

/**
 * A linked socket pair: `client` is what an endpoint dials (return it from
 * `createSocket`), `server` is what the relay accepts.
 */
export function createMemorySocketPair(): { client: WebSocketLike; server: RelaySocket } {
  let toServer: ((d: string) => void) | undefined;
  const serverClosed: Array<() => void> = [];
  let open = true;
  const client = {
    readyState: 0,
    protocol: BRIDGE_SUBPROTOCOL,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data: string) {
      if (open) queueMicrotask(() => toServer?.(data));
    },
    close(code = 1000, reason = "") {
      shut(code, reason);
    },
  } as WebSocketLike & { readyState: number };
  const shut = (code: number, reason: string) => {
    if (!open) return;
    open = false;
    client.readyState = 3;
    queueMicrotask(() => {
      client.onclose?.({ code, reason });
      for (const h of serverClosed) h();
    });
  };
  const server: RelaySocket = {
    send(data) {
      if (open) queueMicrotask(() => client.onmessage?.({ data }));
    },
    close(code, reason = "") {
      shut(code, reason);
    },
    onMessage(h) {
      toServer = h;
    },
    onClose(h) {
      serverClosed.push(h);
    },
  };
  queueMicrotask(() => {
    client.readyState = 1;
    client.onopen?.({});
  });
  return { client, server };
}

/**
 * A `createSocket` for `connectEndpoint` that connects straight into `relay`,
 * as if from `origin` (an allowed origin → endpoint; else refused like a 403).
 */
export function memoryDialer(
  relay: Relay,
  serverName: string,
  allowedOrigins: readonly string[],
  origin: string | undefined,
) {
  return (): WebSocketLike => {
    const pair = createMemorySocketPair();
    const role = roleForOrigin(origin, allowedOrigins);
    if (!role) {
      pair.server.close(4003, "Origin not allowed");
      return pair.client;
    }
    relay.accept(pair.server, { role, resource: bridgePath(serverName) });
    return pair.client;
  };
}

/** An MCP client `Transport` into a new session of an in-process relay. */
export function relayClientTransport(relay: Relay): Transport {
  let session: ReturnType<Relay["openSession"]> | undefined;
  const t: Transport = {
    async start() {
      session = relay.openSession({
        send: (m) => queueMicrotask(() => t.onmessage?.(structuredClone(m) as never)),
      });
    },
    async send(message) {
      await session?.receive(structuredClone(message) as unknown as JsonRpcMessage);
    },
    async close() {
      session?.close();
      session = undefined;
      t.onclose?.();
    },
  };
  return t;
}
