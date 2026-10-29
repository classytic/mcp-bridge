import { describe, expect, it } from "vitest";
import type { JsonRpcMessage } from "../../src/protocol/index.js";
import {
  eraOf,
  listenAcknowledged,
  type OfflineContext,
  offlineAnswer,
} from "../../src/relay/index.js";

const ctx = (eras: OfflineContext["eras"]): OfflineContext => ({
  eras,
  serverName: "x",
  relayVersion: "1",
  notConnected: "offline",
});
const envelope = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
const discover: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "server/discover",
  params: envelope,
};
const initialize: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: 2,
  method: "initialize",
  params: { protocolVersion: "2025-11-25" },
};

describe("offline answers", () => {
  it("reads the era off a message", () => {
    expect(eraOf(discover)).toBe("modern");
    expect(eraOf(initialize)).toBe("legacy");
    expect(eraOf({ jsonrpc: "2.0", id: 3, method: "tools/list" })).toBeUndefined();
  });

  it("answers server/discover with a complete, uncached 2026 result", () => {
    expect(offlineAnswer(discover, ctx(["modern"]))).toMatchObject({
      result: {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: { listChanged: true } },
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
      },
    });
  });

  it("refuses the era the endpoint doesn't serve, the way the SDK does", () => {
    expect(offlineAnswer(initialize, ctx(["modern"]))).toMatchObject({
      error: { code: -32022, data: { supported: ["2026-07-28"], requested: "2025-11-25" } },
    });
    expect(offlineAnswer(discover, ctx(["legacy"]))).toMatchObject({ error: { code: -32601 } });
  });

  it("acknowledges only tool changes on a held listen stream", () => {
    const listen: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 9,
      method: "subscriptions/listen",
      params: { ...envelope, notifications: { toolsListChanged: true, promptsListChanged: true } },
    };
    expect(listenAcknowledged(9, listen)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: { toolsListChanged: true },
        _meta: { "io.modelcontextprotocol/subscriptionId": 9 },
      },
    });
  });
});
