import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { generateSecret } from "../../src/auth/index.js";
import { connectEndpoint, type EndpointHandle } from "../../src/endpoint/index.js";
import { bridgeUrl } from "../../src/protocol/index.js";
import { type Daemon, runStdioShim } from "../../src/relay/node/index.js";
import { waitFor } from "../../src/testing/index.js";
import { makeEchoServer } from "../support/echo-server.js";
import { startTestDaemon, streamClientTransport, wsDial } from "../support/node-harness.js";

const ORIGIN = "chrome-extension://test";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

describe("stdio shim", () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  it("starts the daemon when absent, then carries an MCP session over stdio", async () => {
    const secret = generateSecret();
    const port = await freePort();
    let daemon: Daemon | undefined;
    let spawned = 0;
    const endpoint = connectEndpoint({
      serverName: "s",
      url: bridgeUrl(port, "s"),
      secret,
      createSocket: (url) => wsDial(url, ORIGIN),
      createServer: makeEchoServer,
      backoff: { baseMs: 20, capMs: 100 },
    });
    cleanup.push(() => endpoint.close());

    const { transport, stdin, stdout } = streamClientTransport();
    const shim = runStdioShim({
      serverName: "s",
      secret,
      port,
      stdin,
      stdout,
      spawnDaemon: () => {
        spawned++;
        void startTestDaemon({ serverName: "s", secret, allowedOrigins: [ORIGIN], port }).then(
          (d) => {
            daemon = d;
            cleanup.push(() => d.close());
          },
        );
      },
    });
    await shim;
    expect(spawned).toBe(1);
    await waitFor(() => endpoint.status().state === "connected");

    const client = new Client({ name: "stdio-it", version: "1" });
    await client.connect(transport);
    expect(
      (await client.callTool({ name: "echo", arguments: { text: "over stdio" } })).content,
    ).toEqual([{ type: "text", text: "over stdio" }]);
    expect(daemon).toBeDefined();
    await client.close();
  });

  it("survives a daemon restart: the client keeps its connection", async () => {
    const secret = generateSecret();
    const port = await freePort();
    let daemon: Daemon = await startTestDaemon({
      serverName: "s",
      secret,
      allowedOrigins: [ORIGIN],
      port,
    });
    cleanup.push(() => daemon.close());
    const endpoint: EndpointHandle = connectEndpoint({
      serverName: "s",
      url: bridgeUrl(port, "s"),
      secret,
      createSocket: (url) => wsDial(url, ORIGIN),
      createServer: makeEchoServer,
      backoff: { baseMs: 20, capMs: 100 },
    });
    cleanup.push(() => endpoint.close());
    await waitFor(() => endpoint.status().state === "connected");

    const { transport, stdin, stdout } = streamClientTransport();
    await runStdioShim({
      serverName: "s",
      secret,
      port,
      stdin,
      stdout,
      spawnDaemon: () =>
        void startTestDaemon({ serverName: "s", secret, allowedOrigins: [ORIGIN], port }).then(
          (d) => {
            daemon = d;
          },
        ),
    });
    const client = new Client({ name: "stdio-it", version: "1" });
    await client.connect(transport);
    await client.callTool({ name: "echo", arguments: { text: "before" } });

    await daemon.close(); // the shim notices, starts a new one, the endpoint reconnects
    let after: Awaited<ReturnType<typeof client.callTool>> | undefined;
    let attempts = 0;
    for (const deadline = Date.now() + 15_000; !after && Date.now() < deadline; attempts++) {
      after = await client
        .callTool({ name: "echo", arguments: { text: "after" } })
        .catch(() => undefined);
      if (!after) await new Promise((r) => setTimeout(r, 100));
    }
    expect(after?.content).toEqual([{ type: "text", text: "after" }]);
    expect(attempts).toBeGreaterThan(0);
    await client.close();
  }, 30_000);
});
