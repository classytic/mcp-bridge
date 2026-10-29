/**
 * Scenarios an app serving tools through the bridge must pass — run with the
 * host's own `createServer` or `serveSession` (e.g. an extension serving
 * through arc-ai's `serveAsMcp`). Uses the relay core in memory: no network,
 * no browser. The client negotiates (`auto`), so 2025, 2026 and 2026-only
 * hosts all run the same scenarios.
 */

import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { generateSecret, importPairingKey } from "../auth/index.js";
import { connectEndpoint, type EndpointOptions } from "../endpoint/index.js";
import { createRelay } from "../relay/index.js";
import { memoryDialer, relayClientTransport } from "./memory.js";
import { waitFor } from "./wait.js";

export interface EndpointConformanceOptions {
  createServer?: EndpointOptions["createServer"];
  serveSession?: EndpointOptions["serveSession"];
  /** The eras the host serves (as passed to `connectEndpoint`). */
  eras?: EndpointOptions["eras"];
  /** Tools that must be listed. */
  expectTools?: string[];
  /** Every tool must declare readOnlyHint or destructiveHint. @default true */
  requireBehaviourHints?: boolean;
  /** A read-only call that must succeed. */
  readCall?: { name: string; arguments?: Record<string, unknown> };
}

export function runEndpointConformance(name: string, o: EndpointConformanceOptions): void {
  const ORIGIN = "chrome-extension://host";
  const SERVER = "host";

  const setup = async () => {
    const secret = generateSecret();
    const relay = createRelay({
      serverName: SERVER,
      key: await importPairingKey(secret),
      waitForEndpointMs: 150,
      ...(o.eras ? { offlineEras: o.eras } : {}),
    });
    const ep = connectEndpoint({
      serverName: SERVER,
      url: `ws://127.0.0.1:1/bridge/${SERVER}`,
      secret,
      createSocket: memoryDialer(relay, SERVER, [ORIGIN], ORIGIN),
      ...(o.createServer ? { createServer: o.createServer } : {}),
      ...(o.serveSession ? { serveSession: o.serveSession } : {}),
      ...(o.eras ? { eras: o.eras } : {}),
    });
    await waitFor(() => ep.status().state === "connected");
    const client = new Client(
      { name: "conformance-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(relayClientTransport(relay));
    return {
      client,
      async close() {
        await client.close();
        await ep.close();
        relay.close();
      },
    };
  };

  describe(`mcp-bridge endpoint conformance: ${name}`, () => {
    it("lists its tools, each with a description and an object input schema", async () => {
      const { client, close } = await setup();
      const { tools } = await client.listTools();
      for (const want of o.expectTools ?? []) expect(tools.map((t) => t.name)).toContain(want);
      for (const t of tools) {
        expect(t.description, `${t.name} has no description`).toBeTruthy();
        expect(t.inputSchema.type, `${t.name} input schema`).toBe("object");
      }
      await close();
    });

    if (o.requireBehaviourHints ?? true) {
      it("says which tools are read-only and which change things", async () => {
        const { client, close } = await setup();
        const missing = (await client.listTools()).tools
          .filter(
            (t) =>
              t.annotations?.readOnlyHint === undefined &&
              t.annotations?.destructiveHint === undefined,
          )
          .map((t) => t.name);
        expect(missing, "tools without readOnlyHint / destructiveHint").toEqual([]);
        await close();
      });
    }

    it("shows file arguments to clients as { $file }", async () => {
      const { client, close } = await setup();
      expect(
        JSON.stringify((await client.listTools()).tools.map((t) => t.inputSchema)),
      ).not.toContain('"x-mcp-bridge"');
      await close();
    });

    if (o.readCall) {
      const call = o.readCall;
      it(`answers the read call ${call.name}`, async () => {
        const { client, close } = await setup();
        const res = await client.callTool({ name: call.name, arguments: call.arguments ?? {} });
        expect(res.isError ?? false).toBe(false);
        await close();
      });
    }
  });
}
