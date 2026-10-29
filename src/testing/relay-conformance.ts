/**
 * Scenarios every relay adapter must pass (Node, Bun, hosted…), the way every
 * repo-core kit runs the same repository suite. The adapter supplies a harness;
 * the scenarios drive real endpoints and real MCP clients through it.
 */

import { Client } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { generateSecret, importPairingKey } from "../auth/index.js";
import {
  connectEndpoint,
  type EndpointHandle,
  type EndpointOptions,
  type WebSocketLike,
} from "../endpoint/index.js";
import { CloseCode } from "../protocol/index.js";
import { createRelay } from "../relay/index.js";
import { memoryDialer, relayClientTransport } from "./memory.js";
import { waitFor } from "./wait.js";

export interface RelayUnderTest {
  /** An MCP client transport into a new session of this relay. */
  clientTransport(): Promise<Transport>;
  /** A socket into the relay as if opened from `origin` (undefined = no Origin header). */
  dial(origin: string | undefined): WebSocketLike;
  close(): Promise<void>;
}

export interface RelayHarness {
  start(opts: {
    serverName: string;
    secret: string;
    allowedOrigins: string[];
    waitForEndpointMs: number;
  }): Promise<RelayUnderTest>;
}

/** A server with one read-only tool `echo` returning its `text` as text content. */
export type EchoServerFactory = EndpointOptions["createServer"];

export function runRelayConformance(
  name: string,
  harness: RelayHarness,
  makeEchoServer: EchoServerFactory,
): void {
  const ORIGIN = "chrome-extension://conformance";
  const base = { serverName: "conf", allowedOrigins: [ORIGIN], waitForEndpointMs: 150 };

  const endpoint = (
    relay: RelayUnderTest,
    secret: string | undefined,
    o: { origin?: string | undefined } = {},
  ): EndpointHandle =>
    connectEndpoint({
      serverName: base.serverName,
      url: "ws://127.0.0.1:1/bridge/conf",
      secret: secret ?? "",
      createSocket: () => relay.dial("origin" in o ? o.origin : ORIGIN),
      createServer: makeEchoServer,
      backoff: { baseMs: 10, capMs: 40 },
    });
  const client = () => new Client({ name: "conformance-client", version: "1.0.0" });

  describe(`mcp-bridge relay conformance: ${name}`, () => {
    it("routes a client to the endpoint's tools", async () => {
      const secret = generateSecret();
      const relay = await harness.start({ ...base, secret });
      const ep = endpoint(relay, secret);
      await waitFor(() => ep.status().state === "connected");
      const c = client();
      await c.connect(await relay.clientTransport());
      expect((await c.listTools()).tools.map((t) => t.name)).toContain("echo");
      expect((await c.callTool({ name: "echo", arguments: { text: "hi" } })).content).toEqual([
        { type: "text", text: "hi" },
      ]);
      await c.close();
      await ep.close();
      await relay.close();
    });

    it("refuses a wrong secret and a foreign origin", async () => {
      const secret = generateSecret();
      const relay = await harness.start({ ...base, secret });
      const wrong = endpoint(relay, generateSecret());
      await waitFor(() => wrong.status().state === "refused");
      expect(wrong.status().closeCode).toBe(CloseCode.AuthRejected);
      const web = endpoint(relay, secret, { origin: "https://evil.example" });
      await waitFor(
        () => web.status().state === "refused" || web.status().state === "disconnected",
      );
      expect(web.status().state).not.toBe("connected");
      await Promise.all([wrong.close(), web.close()]);
      await relay.close();
    });

    it("lets a client start before the endpoint, then shows the tools", async () => {
      const secret = generateSecret();
      const relay = await harness.start({ ...base, secret });
      const c = client();
      let changed = 0;
      c.setNotificationHandler("notifications/tools/list_changed", async () => {
        changed++;
      });
      await c.connect(await relay.clientTransport());
      expect((await c.listTools()).tools).toEqual([]);
      await expect(c.callTool({ name: "echo", arguments: { text: "x" } })).rejects.toThrow();
      const ep = endpoint(relay, secret);
      await waitFor(() => changed > 0);
      expect((await c.listTools()).tools.map((t) => t.name)).toContain("echo");
      expect((await c.callTool({ name: "echo", arguments: { text: "late" } })).content).toEqual([
        { type: "text", text: "late" },
      ]);
      await c.close();
      await ep.close();
      await relay.close();
    });

    it("keeps a client working across an endpoint reconnect", async () => {
      const secret = generateSecret();
      const relay = await harness.start({ ...base, secret });
      const first = endpoint(relay, secret);
      await waitFor(() => first.status().state === "connected");
      const c = client();
      await c.connect(await relay.clientTransport());
      await c.callTool({ name: "echo", arguments: { text: "1" } });
      await first.close();
      const second = endpoint(relay, secret);
      await waitFor(() => second.status().state === "connected");
      expect((await c.callTool({ name: "echo", arguments: { text: "2" } })).content).toEqual([
        { type: "text", text: "2" },
      ]);
      await c.close();
      await second.close();
      await relay.close();
    });

    it("serves two clients at once", async () => {
      const secret = generateSecret();
      const relay = await harness.start({ ...base, secret });
      const ep = endpoint(relay, secret);
      await waitFor(() => ep.status().state === "connected");
      const [a, b] = [client(), client()];
      await a.connect(await relay.clientTransport());
      await b.connect(await relay.clientTransport());
      const [ra, rb] = await Promise.all([
        a.callTool({ name: "echo", arguments: { text: "a" } }),
        b.callTool({ name: "echo", arguments: { text: "b" } }),
      ]);
      expect(ra.content).toEqual([{ type: "text", text: "a" }]);
      expect(rb.content).toEqual([{ type: "text", text: "b" }]);
      await Promise.all([a.close(), b.close()]);
      await ep.close();
      await relay.close();
    });
  });
}

/** The relay core over in-memory sockets — the reference harness. */
export const memoryRelayHarness: RelayHarness = {
  async start(o) {
    const relay = createRelay({
      serverName: o.serverName,
      key: await importPairingKey(o.secret),
      waitForEndpointMs: o.waitForEndpointMs,
    });
    return {
      clientTransport: async () => relayClientTransport(relay),
      dial: (origin) => memoryDialer(relay, o.serverName, o.allowedOrigins, origin)(),
      close: async () => relay.close(),
    };
  },
};
