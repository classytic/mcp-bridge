// 2026-07-28 clients — pinned, so no fallback to 2025 — through the real daemon,
// over Streamable HTTP and over the stdio shim. The endpoint serves each session
// through the SDK's era-aware entry.

import { Client } from "@modelcontextprotocol/client";
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
const pinned = () =>
  new Client(
    { name: "modern", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );

describe("2026-07-28 clients", () => {
  let daemon: Daemon | undefined;
  let endpoint: EndpointHandle | undefined;
  let secret = "";

  afterEach(async () => {
    await endpoint?.close();
    await daemon?.close();
  });

  async function setup() {
    secret = generateSecret();
    daemon = await startTestDaemon({ serverName: "m", secret, allowedOrigins: [ORIGIN] });
    endpoint = connectEndpoint({
      serverName: "m",
      url: bridgeUrl(daemon.port, "m"),
      secret,
      createSocket: (url, p) => wsDial(url, ORIGIN, p),
      createServer: makeEchoServer,
    });
    await waitFor(() => endpoint?.status().state === "connected");
    return daemon.port;
  }

  it("are served over Streamable HTTP (stateless, per request)", async () => {
    const port = await setup();
    const client = pinned();
    await client.connect(await httpClientTransport(port, secret));
    expect(client.getProtocolEra()).toBe("modern");
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("echo");
    expect((await client.callTool({ name: "echo", arguments: { text: "2026" } })).content).toEqual([
      { type: "text", text: "2026" },
    ]);
    await client.close();
  });

  it("are served over the stdio shim", async () => {
    const port = await setup();
    const { transport, stdin, stdout } = streamClientTransport();
    await runStdioShim({ serverName: "m", secret, port, stdin, stdout, spawnDaemon: () => {} });
    const client = pinned();
    await client.connect(transport);
    expect(client.getProtocolEra()).toBe("modern");
    expect(
      (await client.callTool({ name: "echo", arguments: { text: "stdio 2026" } })).content,
    ).toEqual([{ type: "text", text: "stdio 2026" }]);
    await client.close();
  });
});
