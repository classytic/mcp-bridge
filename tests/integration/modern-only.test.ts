// A 2026-only endpoint — what arc-ai's serveAsMcp now is (`legacy: 'reject'`).
// Clients start before it, open `subscriptions/listen`, and must end up on the
// tools without a restart — over HTTP and stdio; a 2025 client is refused up
// front instead of settling on a protocol the endpoint would reject later.

import { Client } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { generateSecret } from "../../src/auth/index.js";
import { connectEndpoint, type EndpointHandle } from "../../src/endpoint/index.js";
import { bridgeUrl } from "../../src/protocol/index.js";
import { type Daemon, runStdioShim } from "../../src/relay/node/index.js";
import { waitFor } from "../../src/testing/index.js";
import { makeEchoServer } from "../support/echo-server.js";
import {
  httpClientTransport,
  startTestDaemon,
  streamClientTransport,
  wsDial,
} from "../support/node-harness.js";

const ORIGIN = "chrome-extension://test";

describe("2026-only endpoint (arc-ai style)", () => {
  let daemon: Daemon | undefined;
  const endpoints: EndpointHandle[] = [];
  let secret = "";

  afterEach(async () => {
    for (const e of endpoints.splice(0)) await e.close();
    await daemon?.close();
  });

  const startRelay = async () => {
    secret = generateSecret();
    daemon = await startTestDaemon({
      serverName: "x",
      secret,
      allowedOrigins: [ORIGIN],
      relay: { offlineEras: ["modern"], waitForEndpointMs: 150 },
    });
    return daemon.port;
  };

  const connectModernOnly = (port: number) => {
    const ep = connectEndpoint({
      serverName: "x",
      url: bridgeUrl(port, "x"),
      secret,
      eras: ["modern"],
      createSocket: (url, p) => wsDial(url, ORIGIN, p),
      serveSession: (transport) =>
        serveStdio(() => makeEchoServer(), { transport, legacy: "reject" }),
      backoff: { baseMs: 20, capMs: 100 },
    });
    endpoints.push(ep);
    return ep;
  };

  async function startsBeforeTheEndpoint(client: Client, port: number) {
    expect(client.getProtocolEra()).toBe("modern");
    let changed = 0;
    client.setNotificationHandler("notifications/tools/list_changed", async () => {
      changed++;
    });
    const subscription = await client.listen({ toolsListChanged: true });
    expect(subscription.honoredFilter).toEqual({ toolsListChanged: true });
    expect((await client.listTools()).tools).toEqual([]);

    const ep = connectModernOnly(port);
    await waitFor(() => ep.status().state === "connected" && changed > 0, 5000);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("echo");
    expect((await client.callTool({ name: "echo", arguments: { text: "hi" } })).content).toEqual([
      { type: "text", text: "hi" },
    ]);

    // The subscription survives the extension reloading.
    const before = changed;
    await ep.close();
    endpoints.splice(endpoints.indexOf(ep), 1);
    const again = connectModernOnly(port);
    await waitFor(() => again.status().state === "connected" && changed > before, 5000);
    expect(
      (await client.callTool({ name: "echo", arguments: { text: "after reload" } })).content,
    ).toEqual([{ type: "text", text: "after reload" }]);
    await subscription.close();
  }

  it("an auto-negotiating HTTP client starts first, discovers 2026, listens, then gets the tools", async () => {
    const port = await startRelay();
    const client = new Client(
      { name: "auto", version: "1" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(await httpClientTransport(port, secret));
    await startsBeforeTheEndpoint(client, port);
    await client.close();
  });

  it("a stdio client does the same through the shim", async () => {
    const port = await startRelay();
    const { transport, stdin, stdout } = streamClientTransport();
    await runStdioShim({ serverName: "x", secret, port, stdin, stdout, spawnDaemon: () => {} });
    const client = new Client(
      { name: "auto", version: "1" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    await startsBeforeTheEndpoint(client, port);
    await client.close();
  });

  it("refuses a 2025 client up front (unsupported protocol version)", async () => {
    const port = await startRelay();
    const legacy = new Client({ name: "old", version: "1" }); // default: 2025 initialize
    await expect(legacy.connect(await httpClientTransport(port, secret))).rejects.toThrow();
  });
});
