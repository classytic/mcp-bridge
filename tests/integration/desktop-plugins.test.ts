// Endpoints that aren't browser extensions — a desktop app's plugin (no Origin,
// maybe no WebCrypto), a sandboxed plugin UI (Origin "null"), a mobile app —
// pair by code and connect, against a real daemon.

import { webcrypto } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  clientTokenOf,
  generateSecret,
  hmacSha256,
  importPairingKey,
  sha256,
  useCrypto,
} from "../../src/auth/index.js";
import { connectEndpoint, type EndpointHandle, pairWithCode } from "../../src/endpoint/index.js";
import { bridgeUrl } from "../../src/protocol/index.js";
import { createPairingCodes } from "../../src/relay/index.js";
import type { Daemon } from "../../src/relay/node/index.js";
import { waitFor } from "../../src/testing/index.js";
import { makeEchoServer } from "../support/echo-server.js";
import { httpClientTransport, startTestDaemon, wsDial } from "../support/node-harness.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);

describe("built-in SHA-256 / HMAC (runtimes without WebCrypto)", () => {
  it("matches the standard test vectors", () => {
    expect(hex(sha256(utf8("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hex(sha256(utf8("")))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    // RFC 4231, test case 2.
    expect(hex(hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?")))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("agrees with WebCrypto on every length around the block boundaries", async () => {
    const key = webcrypto.getRandomValues(new Uint8Array(32));
    const k = await webcrypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000]) {
      const data = webcrypto.getRandomValues(new Uint8Array(n));
      expect(hex(sha256(data))).toBe(
        hex(new Uint8Array(await webcrypto.subtle.digest("SHA-256", data))),
      );
      expect(hex(hmacSha256(key, data))).toBe(
        hex(new Uint8Array(await webcrypto.subtle.sign("HMAC", k, data))),
      );
    }
  });

  it("a key imported without WebCrypto has the same id and makes the same proofs", async () => {
    const secret = generateSecret();
    const native = await importPairingKey(secret);
    useCrypto({ webCrypto: false });
    try {
      const builtIn = await importPairingKey(secret);
      expect(builtIn.keyId).toBe(native.keyId);
      const data = utf8("proof");
      expect(await native.verify(await builtIn.sign(data), data)).toBe(true);
      expect(await builtIn.verify(await native.sign(data), data)).toBe(true);
      expect(await builtIn.verify(new Uint8Array(32), data)).toBe(false);
    } finally {
      useCrypto({ webCrypto: true });
    }
  });
});

describe("pairing codes", () => {
  it("are single-use, case- and dash-insensitive", () => {
    const codes = createPairingCodes();
    const { code } = codes.issue();
    expect(code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    expect(codes.redeem(code.toLowerCase().replace("-", " "))).toEqual({ ok: true });
    expect(codes.redeem(code)).toEqual({ ok: false, reason: "none_pending" });
  });

  it("expire, and die after too many wrong guesses", () => {
    let t = 0;
    const codes = createPairingCodes({ ttlMs: 1000, maxAttempts: 2, now: () => t });
    codes.issue();
    t = 2000;
    expect(codes.redeem("AAAA-AAAA")).toEqual({ ok: false, reason: "expired" });
    const { code } = codes.issue();
    expect(codes.redeem("WRONG-ONE").ok).toBe(false);
    expect(codes.redeem("WRONG-TWO").ok).toBe(false);
    expect(codes.redeem(code)).toEqual({ ok: false, reason: "none_pending" });
  });

  it("throttle wrong codes across the relay", () => {
    const codes = createPairingCodes({ maxFailuresPerMinute: 3, maxAttempts: 100 });
    const { code } = codes.issue();
    for (let i = 0; i < 3; i++) codes.redeem("BAD");
    expect(codes.redeem(code)).toEqual({ ok: false, reason: "throttled" });
  });
});

describe("a desktop plugin against a real daemon", () => {
  let daemon: Daemon | undefined;
  let ep: EndpointHandle | undefined;
  afterEach(async () => {
    await ep?.close();
    await daemon?.close();
    ep = undefined;
    daemon = undefined;
    useCrypto({ webCrypto: true });
  });

  const issueCode = async (port: number, secret: string, body: Record<string, unknown> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/pair/code`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await clientTokenOf(secret)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { code: string }).code;
  };

  it("pairs by code, then connects with no Origin and no WebCrypto, and serves its tools", async () => {
    const secret = generateSecret();
    daemon = await startTestDaemon({ serverName: "app", secret, allowedOrigins: [] });
    const port = daemon.port;

    // Only the CLI's token may ask for a code — and never from a page.
    expect((await fetch(`http://127.0.0.1:${port}/pair/code`, { method: "POST" })).status).toBe(
      401,
    );
    const code = await issueCode(port, secret);

    // A plugin UI's CORS + Private Network Access preflight.
    const pre = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: "OPTIONS",
      headers: { origin: "null", "access-control-request-private-network": "true" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-private-network")).toBe("true");

    expect((await pairWithCode({ serverName: "other", code, port })).ok).toBe(false); // wrong server
    const paired = await pairWithCode({ serverName: "app", code, port });
    expect(paired).toEqual({ ok: true, value: { relayUrl: bridgeUrl(port, "app"), secret } });
    expect(await pairWithCode({ serverName: "app", code, port })).toEqual({
      ok: false,
      error: "invalid",
    });

    useCrypto({ webCrypto: false }); // the plugin host has no crypto.subtle
    if (!paired.ok) throw new Error("not paired");
    ep = connectEndpoint({
      serverName: "app",
      url: paired.value.relayUrl,
      secret: paired.value.secret,
      createSocket: (url) => wsDial(url, undefined), // a plugin runtime sends no Origin
      createServer: makeEchoServer,
    });
    await waitFor(() => ep?.status().state === "connected");

    const client = new Client({ name: "it", version: "1" });
    await client.connect(await httpClientTransport(port, secret));
    expect(
      (await client.callTool({ name: "echo", arguments: { text: "from the plugin" } })).content,
    ).toEqual([{ type: "text", text: "from the plugin" }]);
    await client.close();
  });

  it("a sandboxed plugin UI (Origin null) connects only once its origin is allowed", async () => {
    const secret = generateSecret();
    daemon = await startTestDaemon({ serverName: "app", secret, allowedOrigins: [] });
    const port = daemon.port;
    const dial = () =>
      connectEndpoint({
        serverName: "app",
        url: bridgeUrl(port, "app"),
        secret,
        createSocket: (url) => wsDial(url, "null"),
        createServer: makeEchoServer,
      });

    ep = dial();
    await waitFor(
      () => ep?.status().state === "refused" || ep?.status().state === "disconnected",
      5000,
    );
    expect(ep.status().state).not.toBe("connected");
    await ep.close();

    await issueCode(port, secret, { origin: "null" }); // `mcp-relay pair-code --origin null`
    ep = dial();
    await waitFor(() => ep?.status().state === "connected", 8000);
  });

  it("localEndpoints: false keeps no-Origin connections to the client role", async () => {
    const secret = generateSecret();
    daemon = await startTestDaemon({
      serverName: "app",
      secret,
      allowedOrigins: [],
      localEndpoints: false,
    });
    ep = connectEndpoint({
      serverName: "app",
      url: bridgeUrl(daemon.port, "app"),
      secret,
      createSocket: (url) => wsDial(url, undefined),
      createServer: makeEchoServer,
    });
    await waitFor(() => ep?.status().state !== "connecting", 5000);
    expect(ep.status().state).not.toBe("connected");
  });

  it("a browser extension can leave its role unannounced (what a 0.1 relay expects)", async () => {
    const secret = generateSecret();
    const origin = "chrome-extension://abc";
    daemon = await startTestDaemon({ serverName: "app", secret, allowedOrigins: [origin] });
    const sent: string[] = [];
    ep = connectEndpoint({
      serverName: "app",
      url: bridgeUrl(daemon.port, "app"),
      secret,
      announceRole: false,
      createSocket: (url) => {
        const ws = wsDial(url, origin);
        const send = ws.send.bind(ws);
        ws.send = (data: string) => {
          sent.push(data);
          send(data);
        };
        return ws;
      },
      createServer: makeEchoServer,
    });
    await waitFor(() => ep?.status().state === "connected");
    const hello = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    expect(hello.type).toBe("auth.hello");
    expect(hello).not.toHaveProperty("role");
  });
});
