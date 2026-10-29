import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureRelayViaNative,
  type NativeRequest,
  nativeHostName,
  requestNativePairing,
} from "../../src/native/index.js";
import {
  encodeNativeFrame,
  installNativeHost,
  type NativeHostOptions,
  type Registry,
  readNativeFrame,
  runNativeHost,
  uninstallNativeHost,
} from "../../src/relay/node/index.js";

const ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const SECRET = "ab".repeat(32);

/** Run the host once on `request` (already encoded) and return the decoded response. */
async function host(raw: Buffer, o: Partial<NativeHostOptions> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out: Buffer[] = [];
  stdout.on("data", (c: Buffer) => out.push(c));
  stdin.end(raw);
  await runNativeHost({
    serverName: "xero",
    expectedOrigins: [ORIGIN],
    callerOrigin: `${ORIGIN}/`,
    port: 17345,
    pairing: async () => SECRET,
    ensureRelay: async () => "spawned",
    stdin,
    stdout,
    ...o,
  });
  const buf = Buffer.concat(out);
  return JSON.parse(buf.subarray(4).toString("utf8")) as Record<string, unknown>;
}

/** A `sendNativeMessage` that runs the real host in-process. */
const viaHost =
  (o: Partial<NativeHostOptions> = {}) =>
  (_host: string, message: NativeRequest) =>
    host(encodeNativeFrame(message), o);

describe("native framing", () => {
  const read = (bytes: Buffer, max?: number) => {
    const s = new PassThrough();
    s.end(bytes);
    return readNativeFrame(s, max);
  };

  it("round-trips one frame", async () => {
    expect(await read(encodeNativeFrame({ a: 1 }))).toBe('{"a":1}');
  });

  it("refuses zero length, oversized length, trailing bytes and invalid UTF-8", async () => {
    expect(await read(Buffer.from([0, 0, 0, 0]))).toBeNull();
    expect(await read(encodeNativeFrame({ big: "x".repeat(5000) }))).toBeNull();
    expect(
      await read(Buffer.concat([encodeNativeFrame({ a: 1 }), Buffer.from("junk")])),
    ).toBeNull();
    const bad = Buffer.from([2, 0, 0, 0, 0xc3, 0x28]);
    expect(await read(bad)).toBeNull();
  });
});

describe("native host", () => {
  const request = { v: 1, op: "pair", nonce: "n".repeat(24) };

  it("pairs a known extension", async () => {
    expect(await host(encodeNativeFrame(request))).toEqual({
      v: 1,
      ok: true,
      nonce: request.nonce,
      relayUrl: "ws://127.0.0.1:17345/bridge/xero",
      secret: SECRET,
    });
  });

  it("refuses an extension it wasn't installed for, before reading anything else", async () => {
    let paired = false;
    const r = await host(encodeNativeFrame(request), {
      callerOrigin: `chrome-extension://${"b".repeat(32)}/`,
      pairing: async () => {
        paired = true;
        return SECRET;
      },
    });
    expect(r).toMatchObject({ ok: false, code: "origin_forbidden" });
    expect(paired).toBe(false);
  });

  it("refuses a request with extra keys", async () => {
    expect(await host(encodeNativeFrame({ ...request, extra: 1 }))).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
  });

  it("reports relay_unavailable when the relay can't be started", async () => {
    const r = await host(encodeNativeFrame({ ...request, op: "ensure" }), {
      ensureRelay: async () => {
        throw new Error("no");
      },
    });
    expect(r).toMatchObject({ ok: false, code: "relay_unavailable" });
  });
});

describe("extension side", () => {
  it("gets the pairing from the real host", async () => {
    const r = await requestNativePairing({ serverName: "xero", send: viaHost() });
    expect(r).toEqual({
      ok: true,
      value: { relayUrl: "ws://127.0.0.1:17345/bridge/xero", secret: SECRET },
    });
  });

  it("asks the host to start the relay", async () => {
    expect(await ensureRelayViaNative({ serverName: "xero", send: viaHost() })).toEqual({
      ok: true,
      value: "spawned",
    });
  });

  it("says a missing host is worth retrying, a refusal is not", async () => {
    const missing = await requestNativePairing({
      serverName: "xero",
      send: async () => {
        throw new Error("Specified native messaging host not found.");
      },
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "host_not_found", retry: true } });
    const refused = await requestNativePairing({
      serverName: "xero",
      send: viaHost({ callerOrigin: `chrome-extension://${"c".repeat(32)}/` }),
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "origin_forbidden", retry: false } });
  });

  it("rejects a response that doesn't echo the nonce", async () => {
    const r = await requestNativePairing({
      serverName: "xero",
      send: async (_h, m) => ({
        v: 1,
        ok: true,
        nonce: `${m.nonce}x`,
        relayUrl: "ws://127.0.0.1:1/bridge/xero",
        secret: SECRET,
      }),
    });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_response" } });
  });
});

describe("install", () => {
  let previous: string | undefined;
  beforeEach(async () => {
    previous = process.env.MCP_BRIDGE_CONFIG_DIR;
    process.env.MCP_BRIDGE_CONFIG_DIR = await mkdtemp(join(tmpdir(), "mcpb-native-"));
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.MCP_BRIDGE_CONFIG_DIR;
    else process.env.MCP_BRIDGE_CONFIG_DIR = previous;
  });

  it("writes a launcher, a manifest and per-browser registry keys on Windows", async () => {
    const keys = new Map<string, string>();
    const registry: Registry = {
      set: async (k, v) => void keys.set(k, v),
      remove: async (k) => void keys.delete(k),
    };
    const r = await installNativeHost({
      serverName: "xero",
      origins: [ORIGIN],
      platform: "win32",
      registry,
      command: { node: "node.exe", script: "C:/bin/xero-mcp.mjs" },
    });
    expect(r.hostName).toBe(nativeHostName("xero"));
    const manifest = JSON.parse(await readFile(r.manifests[0] as string, "utf8"));
    expect(manifest).toEqual({
      name: "com.classytic.mcp_bridge.xero",
      description: "MCP bridge pairing for xero",
      path: r.launcher,
      type: "stdio",
      allowed_origins: [`${ORIGIN}/`],
    });
    const launcher = await readFile(r.launcher, "utf8");
    expect(launcher).toContain('"native-host" "--server" "xero" "--expected-origin"');
    expect([...keys.keys()]).toContain(
      "Software\\Google\\Chrome\\NativeMessagingHosts\\com.classytic.mcp_bridge.xero",
    );
    await uninstallNativeHost({ serverName: "xero", platform: "win32", registry });
    expect(keys.size).toBe(0);
  });

  it("copies the manifest into each browser's folder on Linux", async () => {
    const home = await mkdtemp(join(tmpdir(), "mcpb-home-"));
    const saved = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const r = await installNativeHost({
        serverName: "xero",
        origins: [ORIGIN],
        platform: "linux",
        home,
      });
      expect(r.manifests).toContain(
        join(
          home,
          ".config",
          "google-chrome",
          "NativeMessagingHosts",
          "com.classytic.mcp_bridge.xero.json",
        ),
      );
      expect(r.launcher.endsWith(".sh")).toBe(true);
    } finally {
      if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved;
    }
  });

  it("refuses an origin that isn't an extension id", async () => {
    await expect(
      installNativeHost({
        serverName: "xero",
        origins: ["https://evil.example"],
        platform: "linux",
      }),
    ).rejects.toThrow(/Not an extension origin/);
  });
});
