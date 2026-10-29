// Tool profiles: a client that asks for some tools sees only those in
// `tools/list`, and its calls to others are refused by the relay — the
// endpoint never hears about them. The relay's own `bridge_*` tools stay.

import { describe, expect, it } from "vitest";
import { type Frame, isFrame, type JsonRpcMessage } from "../../src/protocol/index.js";
import { parseToolPatterns, Session, toolFilter } from "../../src/relay/index.js";

describe("tool patterns", () => {
  it("parses a comma list and matches * wildcards", () => {
    const allow = toolFilter(parseToolPatterns(" payroll* , getOrganisation ,"));
    expect(allow?.("payrollLoad")).toBe(true);
    expect(allow?.("getOrganisation")).toBe(true);
    expect(allow?.("getOrganisationX")).toBe(false);
    expect(allow?.("codingReconcile")).toBe(false);
    expect(allow?.("bridge_listEndpoints")).toBe(true);
  });

  it("treats regex characters literally and means 'everything' when empty", () => {
    expect(toolFilter(["a.b"])?.("axb")).toBe(false);
    expect(toolFilter([])).toBeUndefined();
    expect(parseToolPatterns("")).toBeUndefined();
    expect(() =>
      parseToolPatterns(Array.from({ length: 65 }, (_, i) => `t${i}`).join(",")),
    ).toThrow(/At most/);
  });

  it("is carried by the open frame, validated", () => {
    expect(isFrame({ type: "open", session: "s", tools: ["payroll*"] })).toBe(true);
    expect(isFrame({ type: "open", session: "s", tools: "payroll*" })).toBe(false);
    expect(isFrame({ type: "open", session: "s", tools: [1] })).toBe(false);
  });
});

describe("a session with a tool profile", () => {
  function setup() {
    const toClient: JsonRpcMessage[] = [];
    const frames: Frame[] = [];
    const session = new Session(
      "s1",
      { send: (m) => toClient.push(m) },
      {
        serverName: "t",
        relayVersion: "0",
        files: undefined,
        waitMs: 10_000,
        notConnected: "offline",
        endpoint: () => ({ generation: 1, acks: false, send: (f) => frames.push(f) }),
        eras: () => ["modern"],
        allowTool: toolFilter(["payroll*"]),
        warn: () => {},
      },
    );
    return { session, toClient, frames };
  }

  it("lists only the profile's tools", async () => {
    const { session, toClient } = setup();
    await session.fromClient({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await session.fromEndpoint({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "payrollState", inputSchema: {} },
          { name: "codingReconcile", inputSchema: {} },
        ],
      },
    });
    expect(
      (toClient[0]?.result as { tools: Array<{ name: string }> } | undefined)?.tools.map(
        (t) => t.name,
      ),
    ).toEqual(["payrollState"]);
  });

  it("refuses a call outside the profile without reaching the endpoint", async () => {
    const { session, toClient, frames } = setup();
    await session.fromClient({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "codingReconcile", arguments: {} },
    });
    expect(frames.filter((f) => f.type === "mcp")).toEqual([]);
    expect(toClient[0]).toMatchObject({
      id: 2,
      error: { code: -32602, message: expect.stringMatching(/tool profile/) },
    });

    await session.fromClient({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "payrollState", arguments: {} },
    });
    expect(frames.some((f) => f.type === "mcp" && (f.message as { id?: unknown }).id === 3)).toBe(
      true,
    );
  });
});

describe("profiles by @group", () => {
  const groupsOf = new Map<string, string[]>();
  const listed = {
    tools: [
      { name: "payrollState", inputSchema: {}, _meta: { "classytic.io/group": ["payroll"] } },
      { name: "xeroGuide", inputSchema: {}, _meta: { "classytic.io/group": "ops" } },
      { name: "codingReconcile", inputSchema: {}, _meta: { "classytic.io/group": ["coding"] } },
    ],
  };

  it("matches a tool by any of its groups, with wildcards", () => {
    const allow = toolFilter(["@pay*", "getOrganisation"]);
    expect(allow?.("payrollState", ["payroll"])).toBe(true);
    expect(allow?.("codingReconcile", ["coding"])).toBe(false);
    expect(allow?.("getOrganisation")).toBe(true);
  });

  it("lists by group and lets calls through once groups are known", async () => {
    const toClient: JsonRpcMessage[] = [];
    const frames: Frame[] = [];
    const session = new Session(
      "s1",
      { send: (m) => toClient.push(m) },
      {
        serverName: "t",
        relayVersion: "0",
        files: undefined,
        waitMs: 10_000,
        notConnected: "offline",
        endpoint: () => ({ generation: 1, acks: false, send: (f) => frames.push(f) }),
        eras: () => ["modern"],
        allowTool: toolFilter(["@payroll", "@ops"]),
        toolGroups: groupsOf,
        warn: () => {},
      },
    );
    // Before any listing the groups are unknown: refused.
    await session.fromClient({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "payrollState", arguments: {} },
    });
    expect(toClient[0]).toMatchObject({ id: 1, error: { code: -32602 } });

    await session.fromClient({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await session.fromEndpoint({ jsonrpc: "2.0", id: 2, result: listed });
    const names = (
      toClient[1]?.result as { tools: Array<{ name: string }> } | undefined
    )?.tools.map((t) => t.name);
    expect(names).toEqual(["payrollState", "xeroGuide"]);

    await session.fromClient({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "payrollState", arguments: {} },
    });
    expect(frames.some((f) => f.type === "mcp" && (f.message as { id?: unknown }).id === 3)).toBe(
      true,
    );
  });
});
