/** Real-socket wiring for integration tests: the Node daemon, `ws` dialers, HTTP and stdio MCP clients. */

import { PassThrough } from "node:stream";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import WebSocket from "ws";
import { clientTokenOf } from "../../src/auth/index.js";
import type { WebSocketLike } from "../../src/endpoint/index.js";
import { BRIDGE_SUBPROTOCOL, bridgeUrl } from "../../src/protocol/index.js";
import { type Daemon, type DaemonOptions, startDaemon } from "../../src/relay/node/index.js";
import type { RelayHarness } from "../../src/testing/index.js";

/** A `ws` client as the endpoint's WebSocketLike, sending `origin` (or none). */
export function wsDial(
  url: string,
  origin: string | undefined,
  protocols = [BRIDGE_SUBPROTOCOL],
): WebSocketLike {
  return new WebSocket(url, protocols, origin ? { origin } : {}) as unknown as WebSocketLike;
}

export async function startTestDaemon(
  o: Omit<DaemonOptions, "port"> & { port?: number },
): Promise<Daemon> {
  const started = await startDaemon({ idleExitMs: 0, port: 0, ...o });
  if (!started.ok) throw new Error(`daemon did not start: ${started.reason}`);
  return started.daemon;
}

export async function httpClientTransport(
  port: number,
  secret: string,
  endpoint?: string,
): Promise<Transport> {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  if (endpoint) url.searchParams.set("endpoint", endpoint);
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${await clientTokenOf(secret)}` } },
  }) as unknown as Transport;
}

/** The relay conformance harness over a real daemon. */
export const nodeDaemonHarness: RelayHarness = {
  async start(o) {
    const daemon = await startTestDaemon({
      serverName: o.serverName,
      secret: o.secret,
      allowedOrigins: o.allowedOrigins,
      relay: { waitForEndpointMs: o.waitForEndpointMs },
    });
    return {
      clientTransport: () => httpClientTransport(daemon.port, o.secret),
      dial: (origin) => wsDial(bridgeUrl(daemon.port, o.serverName), origin),
      close: () => daemon.close(),
    };
  },
};

/** An MCP client Transport over a pair of streams (what an MCP client does with a child's stdio). */
export function streamClientTransport(): {
  transport: Transport;
  stdin: PassThrough;
  stdout: PassThrough;
} {
  const stdin = new PassThrough(); // client → shim
  const stdout = new PassThrough(); // shim → client
  let buffer = "";
  const transport: Transport = {
    async start() {
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        buffer += chunk;
        for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim()) transport.onmessage?.(JSON.parse(line) as JSONRPCMessage);
        }
      });
    },
    async send(message) {
      stdin.write(`${JSON.stringify(message)}\n`);
    },
    async close() {
      stdin.end();
      transport.onclose?.();
    },
  };
  return { transport, stdin, stdout };
}
