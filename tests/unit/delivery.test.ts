// The relay's delivery rules, at the Session level: a request the endpoint
// received but never answered is reported "outcome unknown", never re-run;
// one it never received is redelivered to the next endpoint.

import { describe, expect, it } from "vitest";
import type { Frame, JsonRpcMessage } from "../../src/protocol/index.js";
import { type EndpointLink, OUTCOME_UNKNOWN, Session } from "../../src/relay/index.js";

function setup() {
  const toClient: JsonRpcMessage[] = [];
  let current: (EndpointLink & { frames: Frame[] }) | undefined;
  const link = (generation: number): EndpointLink & { frames: Frame[] } => {
    const frames: Frame[] = [];
    return { generation, acks: true, frames, send: (f) => frames.push(f) };
  };
  const session = new Session(
    "s1",
    { send: (m) => toClient.push(m) },
    {
      serverName: "t",
      relayVersion: "0",
      files: undefined,
      waitMs: 10_000,
      notConnected: "offline",
      endpoint: () => current,
      eras: () => ["legacy", "modern"],
      warn: () => {},
    },
  );
  return {
    session,
    toClient,
    connect(generation: number) {
      current = link(generation);
      session.attach(current);
      return current;
    },
    disconnect() {
      current = undefined;
      session.detach("gone");
    },
  };
}

const call = (id: number): JsonRpcMessage => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "write" },
});
const mcpFrames = (frames: Frame[]) =>
  frames.filter((f): f is Extract<Frame, { type: "mcp" }> => f.type === "mcp");

describe("delivery", () => {
  it("reports an acked-but-unanswered request as outcome unknown and never resends it", async () => {
    const t = setup();
    const ep1 = t.connect(1);
    await t.session.fromClient(call(1));
    const sent = mcpFrames(ep1.frames)[0];
    t.session.ack(sent?.seq as number, false);
    t.disconnect();
    expect(t.toClient).toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32000, message: OUTCOME_UNKNOWN } },
    ]);
    const ep2 = t.connect(2);
    expect(mcpFrames(ep2.frames)).toEqual([]);
  });

  it("redelivers a request the endpoint never acked, with the same seq", async () => {
    const t = setup();
    const ep1 = t.connect(1);
    await t.session.fromClient(call(7));
    const seq = mcpFrames(ep1.frames)[0]?.seq;
    t.disconnect();
    expect(t.toClient).toEqual([]);
    const ep2 = t.connect(2);
    expect(ep2.frames[0]).toMatchObject({ type: "open", session: "s1" });
    expect(mcpFrames(ep2.frames)).toEqual([{ type: "mcp", session: "s1", seq, message: call(7) }]);
  });

  it("answers outcome unknown when the endpoint acks a redelivered seq as a duplicate", async () => {
    const t = setup();
    const ep1 = t.connect(1);
    await t.session.fromClient(call(3));
    const seq = mcpFrames(ep1.frames)[0]?.seq as number;
    t.disconnect(); // ack was lost
    t.connect(2);
    t.session.ack(seq, true);
    expect(t.toClient).toEqual([
      { jsonrpc: "2.0", id: 3, error: { code: -32000, message: OUTCOME_UNKNOWN } },
    ]);
  });

  it("replays the client's handshake on a new endpoint and swallows its answer", async () => {
    const t = setup();
    const ep1 = t.connect(1);
    await t.session.fromClient({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    await t.session.fromEndpoint({ jsonrpc: "2.0", id: 0, result: { capabilities: {} } });
    t.session.ack(mcpFrames(ep1.frames)[0]?.seq as number, false);
    t.disconnect();
    const ep2 = t.connect(2);
    const replay = mcpFrames(ep2.frames)[0];
    expect(replay?.message.method).toBe("initialize");
    expect(String(replay?.message.id)).toMatch(/^mcp-bridge-replay:/);
    const before = t.toClient.length;
    await t.session.fromEndpoint({ jsonrpc: "2.0", id: replay?.message.id as string, result: {} });
    expect(t.toClient.slice(before)).toEqual([]); // swallowed
    expect(t.toClient.some((m) => m.method === "notifications/tools/list_changed")).toBe(true);
  });
});
