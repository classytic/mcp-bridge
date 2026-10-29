import { request } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { clientTokenOf, generateSecret } from "../../src/auth/index.js";
import { connectEndpoint } from "../../src/endpoint/index.js";
import { bridgeUrl } from "../../src/protocol/index.js";
import { type Daemon, startDaemon } from "../../src/relay/node/index.js";
import { runRelayConformance, waitFor } from "../../src/testing/index.js";
import { makeEchoServer } from "../support/echo-server.js";
import {
  httpClientTransport,
  nodeDaemonHarness,
  startTestDaemon,
  wsDial,
} from "../support/node-harness.js";

runRelayConformance("node daemon (ws + Streamable HTTP)", nodeDaemonHarness, makeEchoServer);

const ORIGIN = "chrome-extension://test";

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });
}

describe("node daemon guards", () => {
  let daemon: Daemon | undefined;
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  it("answers /health only with the bearer token, from loopback Host, without Origin", async () => {
    const secret = generateSecret();
    daemon = await startTestDaemon({ serverName: "g", secret, allowedOrigins: [ORIGIN] });
    const auth = { authorization: `Bearer ${await clientTokenOf(secret)}` };
    expect(await rawGet(daemon.port, "/health", auth)).toBe(200);
    expect(await rawGet(daemon.port, "/health", {})).toBe(401);
    expect(await rawGet(daemon.port, "/health", { ...auth, origin: "https://evil.example" })).toBe(
      401,
    );
    expect(await rawGet(daemon.port, "/health", { ...auth, host: "evil.example" })).toBe(421);
    expect(await rawGet(daemon.port, "/mcp", { ...auth, origin: "https://evil.example" })).toBe(
      403,
    );
  });

  it("refuses WebSocket upgrades from other origins or without the subprotocol", async () => {
    const secret = generateSecret();
    daemon = await startTestDaemon({ serverName: "g", secret, allowedOrigins: [ORIGIN] });
    const url = bridgeUrl(daemon.port, "g");
    const outcome = (ws: ReturnType<typeof wsDial>) =>
      new Promise<string>((resolve) => {
        ws.onopen = () => resolve("open");
        ws.onerror = () => resolve("refused");
      });
    expect(await outcome(wsDial(url, "https://evil.example"))).toBe("refused");
    expect(await outcome(wsDial(url, ORIGIN, ["other.v1"]))).toBe("refused");
    expect(await outcome(wsDial(url, ORIGIN))).toBe("open");
  });

  it("cuts a socket that sends more than the pre-auth byte limit before authenticating", async () => {
    const secret = generateSecret();
    daemon = await startTestDaemon({ serverName: "g", secret, allowedOrigins: [ORIGIN] });
    const ws = wsDial(bridgeUrl(daemon.port, "g"), ORIGIN);
    const closed = new Promise<number>((resolve) => {
      ws.onclose = (ev) => resolve(ev.code);
    });
    ws.onopen = () => ws.send("x".repeat(64 * 1024));
    expect(await closed).toBe(1006); // destroyed on the wire, not answered
  });

  it("stops on an authenticated POST /shutdown", async () => {
    const secret = generateSecret();
    const d = await startTestDaemon({ serverName: "g", secret, allowedOrigins: [ORIGIN] });
    const post = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${d.port}/shutdown`, { method: "POST", headers }).then(
        (r) => r.status,
      );
    expect(await post({})).toBe(401);
    expect(await post({ authorization: `Bearer ${await clientTokenOf(secret)}` })).toBe(202);
    expect(await d.done).toBe("closed");
  });

  it("is single-instance: a second daemon on the same port reports port-in-use", async () => {
    const secret = generateSecret();
    daemon = await startTestDaemon({ serverName: "g", secret, allowedOrigins: [ORIGIN] });
    const second = await startDaemon({
      serverName: "g",
      secret,
      allowedOrigins: [ORIGIN],
      port: daemon.port,
    });
    expect(second).toEqual({ ok: false, reason: "port-in-use" });
  });

  it("exits when idle", async () => {
    const started = await startDaemon({
      serverName: "g",
      secret: generateSecret(),
      allowedOrigins: [ORIGIN],
      port: 0,
      idleExitMs: 1000,
    });
    if (!started.ok) throw new Error("did not start");
    expect(await started.daemon.done).toBe("idle");
  });

  it("serves an endpoint's tools to an HTTP client end to end", async () => {
    const secret = generateSecret();
    daemon = await startTestDaemon({ serverName: "g", secret, allowedOrigins: [ORIGIN] });
    const port = daemon.port;
    const ep = connectEndpoint({
      serverName: "g",
      url: bridgeUrl(port, "g"),
      secret,
      createSocket: (url) => wsDial(url, ORIGIN),
      createServer: makeEchoServer,
    });
    await waitFor(() => ep.status().state === "connected");
    const client = new Client({ name: "it", version: "1" });
    await client.connect(await httpClientTransport(port, secret));
    expect(
      (await client.callTool({ name: "echo", arguments: { text: "over http" } })).content,
    ).toEqual([{ type: "text", text: "over http" }]);
    await waitFor(() => ep.status().sessions.length === 1);
    await client.close();
    await ep.close();
  });
});
