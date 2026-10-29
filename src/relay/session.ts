/**
 * One MCP client session as the relay holds it: what the client sent, what the
 * endpoint has acknowledged, and how to bring it back after the endpoint goes
 * away. The relay (`relay.ts`) owns sockets; a Session only sees "the current
 * endpoint" through {@link EndpointLink}.
 *
 * Delivery rules (hermes ack-gated buffering, adapted for tools that write):
 *  - every client message to the endpoint gets a `seq`; the endpoint acks it;
 *  - endpoint gone → never-acked messages wait and are redelivered;
 *    acked-but-unanswered requests get "outcome unknown", never a re-run;
 *  - a new endpoint gets `open`, then the client's handshake replayed (its
 *    answer swallowed), then the waiting messages; the client is told the tool
 *    list changed.
 * No endpoint for `waitMs` → the relay answers the client itself (`./offline`,
 * per protocol era and only for eras the endpoint serves).
 *
 * 2026 `subscriptions/listen` streams outlive the endpoint: acknowledged by
 * the relay when offline, re-forwarded to each new endpoint (its duplicate
 * acknowledgement dropped), and told `tools/list_changed` when tools may have
 * changed — never failed with "outcome unknown", since a subscription is read-only.
 */

import { createSerialQueue } from "../internal/serial-queue.js";
import {
  clientInfoOf,
  errorResponse,
  type Frame,
  idOf,
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  notification,
  type PeerInfo,
  resultResponse,
} from "../protocol/index.js";
import { clientToolsList, type RelayFiles, readCallFiles, saveCallFiles } from "./files.js";
import {
  type Era,
  eraOf,
  listenAcknowledged,
  listenToolsChanged,
  offlineAnswer,
  subscriptionOf,
  wantsToolChanges,
} from "./offline.js";
import { type ToolFilter, toolGroupsOf } from "./tool-filter.js";

/** Where a session's messages go back to — an HTTP client, a stdio shim's socket. */
export interface Upstream {
  send(message: JsonRpcMessage): void;
}

/** The current endpoint, as a session needs it. */
export interface EndpointLink {
  readonly generation: number;
  /** The endpoint advertised `ack`. Without it nothing is held for redelivery — every send counts as received. */
  readonly acks: boolean;
  send(frame: Frame): void;
}

/** Tools the relay answers itself (the profile switch tools) — see `./routing`. */
export interface LocalTools {
  /** Whether to list them now (several endpoints, unpinned session). */
  visible(): boolean;
  definitions(): readonly Record<string, unknown>[];
  handles(name: string): boolean;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
}

export interface SessionDeps {
  serverName: string;
  relayVersion: string;
  files: RelayFiles | undefined;
  waitMs: number;
  notConnected: string;
  endpoint(): EndpointLink | undefined;
  /** Protocol eras the endpoint serves — for offline answers. */
  eras(): readonly Era[];
  /** No endpoint chosen yet while several are connected: answer at once, offering only `localTools`. */
  choosing?(): boolean;
  localTools?: LocalTools;
  /** The client's tool profile: only these tools are listed and callable (see `./tool-filter`). */
  allowTool?: ToolFilter;
  /** Each tool's groups as last listed by the endpoint — shared across sessions (2026 HTTP is one request per session). */
  toolGroups?: Map<string, string[]>;
  warn(message: string, data?: Record<string, unknown>): void;
}

export const OUTCOME_UNKNOWN =
  "The extension went away after receiving this request, so whether it ran is unknown. Check before retrying.";
const ENDPOINT_CLOSED = "The extension closed this session before answering.";
const REPLAY_PREFIX = "mcp-bridge-replay:";
const LISTEN = "subscriptions/listen";

/** A client's `subscriptions/listen` stream. */
interface Listen {
  message: JsonRpcMessage;
  /** The client has had its `acknowledged` (from the relay or an endpoint). */
  acked: boolean;
  /** Endpoint generation it is live on; -1 while held by the relay. */
  liveOn: number;
}

interface Inflight {
  method: string;
  /** The seq it was sent with; undefined while still waiting for an endpoint. */
  seq: number | undefined;
  acked: boolean;
}

export class Session {
  readonly id: string;
  client: PeerInfo | undefined;
  closed = false;

  readonly #deps: SessionDeps;
  readonly #upstream: Upstream;
  readonly #inQueue = createSerialQueue();
  readonly #outQueue = createSerialQueue();
  readonly #inflight = new Map<JsonRpcId, Inflight>();
  /** Sent to the endpoint and not acked yet: seq → message. Redelivered on reconnect. */
  readonly #unacked = new Map<number, JsonRpcMessage>();
  /** Not sent yet (no endpoint). */
  #waiting: JsonRpcMessage[] = [];
  #nextSeq = 1;
  #openOn = -1;
  #initRequest: JsonRpcMessage | undefined;
  #initializedNote: JsonRpcMessage | undefined;
  #handshaken = false;
  #waitTimer: ReturnType<typeof setTimeout> | undefined;
  #replays = 0;
  readonly #listens = new Map<JsonRpcId, Listen>();
  #era: Era | undefined;

  constructor(id: string, upstream: Upstream, deps: SessionDeps, client?: PeerInfo) {
    this.id = id;
    this.#upstream = upstream;
    this.#deps = deps;
    this.client = client;
  }

  // ── client → endpoint ────────────────────────────────────────────────────

  /** A message from the MCP client. Resolves once it is sent, queued or answered. */
  fromClient(message: JsonRpcMessage): Promise<void> {
    return this.#inQueue(() => this.#fromClient(message)).catch((e: unknown) =>
      this.#deps.warn("relay: client message failed", { error: String(e) }),
    );
  }

  async #fromClient(message: JsonRpcMessage): Promise<void> {
    if (this.closed) return;
    let m = message;
    this.client ??= clientInfoOf(m);
    this.#era ??= eraOf(m);
    if (isRequest(m)) {
      const id = idOf(m) as JsonRpcId;
      const method = m.method as string;
      const local = this.#deps.localTools;
      const params = (m.params ?? {}) as Record<string, unknown>;
      if (
        method === "tools/call" &&
        typeof params.name === "string" &&
        local?.handles(params.name)
      ) {
        const r = await local.call(
          params.name,
          (params.arguments ?? {}) as Record<string, unknown>,
        );
        return this.#reply(
          resultResponse(id, {
            content: [{ type: "text", text: r.text }],
            ...(r.isError ? { isError: true } : {}),
            ...(this.#era === "modern" ? { resultType: "complete" } : {}),
          }),
        );
      }
      if (
        method === "tools/call" &&
        typeof params.name === "string" &&
        this.#deps.allowTool &&
        !this.#deps.allowTool(params.name, this.#deps.toolGroups?.get(params.name))
      ) {
        return this.#reply(
          errorResponse(
            id,
            `Tool "${params.name}" is not in this client's tool profile — add it (or its @group) to --tools / ?tools=, or list tools first.`,
            -32602,
          ),
        );
      }
      if (method === "initialize") this.#initRequest = m;
      if (method === LISTEN) this.#listens.set(id, { message: m, acked: false, liveOn: -1 });
      if (method === "tools/call") {
        try {
          m = await readCallFiles(m, this.#deps.files);
        } catch (e) {
          return this.#reply(errorResponse(id, e instanceof Error ? e.message : String(e)));
        }
      }
      this.#inflight.set(id, { method, seq: undefined, acked: false });
    } else if (isNotification(m) && m.method === "notifications/initialized") {
      this.#initializedNote = m;
    }
    this.#dispatch(m);
  }

  #dispatch(m: JsonRpcMessage): void {
    const ep = this.#deps.endpoint();
    if (!ep && this.#deps.choosing?.()) {
      if (isRequest(m)) this.#answerOffline(m);
      return;
    }
    if (!ep) {
      this.#waiting.push(m);
      this.#armOffline();
      return;
    }
    this.#ensureOpen(ep);
    this.#sendSeq(ep, m);
  }

  #sendSeq(ep: EndpointLink, m: JsonRpcMessage): void {
    const seq = this.#nextSeq++;
    if (ep.acks) this.#unacked.set(seq, m);
    const id = idOf(m);
    const entry = id !== undefined && isRequest(m) ? this.#inflight.get(id) : undefined;
    if (entry) {
      entry.seq = seq;
      entry.acked = !ep.acks;
    }
    const listen = id !== undefined ? this.#listens.get(id) : undefined;
    if (listen && m.method === LISTEN) listen.liveOn = ep.generation;
    ep.send({ type: "mcp", session: this.id, seq, message: m });
  }

  #ensureOpen(ep: EndpointLink): void {
    if (this.#openOn === ep.generation) return;
    this.#openOn = ep.generation;
    ep.send({ type: "open", session: this.id, ...(this.client ? { client: this.client } : {}) });
    if (!this.#handshaken || !this.#initRequest) return;
    // A fresh server on the endpoint: give it this client's handshake again.
    const replayId = `${REPLAY_PREFIX}${++this.#replays}`;
    ep.send({ type: "mcp", session: this.id, message: { ...this.#initRequest, id: replayId } });
    ep.send({
      type: "mcp",
      session: this.id,
      message: this.#initializedNote ?? notification("notifications/initialized"),
    });
    this.#reply(notification("notifications/tools/list_changed"));
  }

  // ── endpoint → client ────────────────────────────────────────────────────

  /** The endpoint acknowledged a seq. */
  ack(seq: number, duplicate: boolean): void {
    const m = this.#unacked.get(seq);
    this.#unacked.delete(seq);
    const id = m ? idOf(m) : undefined;
    const entry = id !== undefined ? this.#inflight.get(id) : undefined;
    if (!entry) return;
    entry.acked = true;
    if (duplicate && id !== undefined && entry.method !== LISTEN) {
      this.#inflight.delete(id);
      this.#reply(errorResponse(id, OUTCOME_UNKNOWN));
    }
  }

  fromEndpoint(message: JsonRpcMessage): Promise<void> {
    return this.#outQueue(() => this.#fromEndpoint(message)).catch((e: unknown) =>
      this.#deps.warn("relay: endpoint message failed", { error: String(e) }),
    );
  }

  async #fromEndpoint(message: JsonRpcMessage): Promise<void> {
    let m = message;
    if (m.method === "notifications/subscriptions/acknowledged") {
      const listen = this.#listens.get(subscriptionOf(m) as JsonRpcId);
      if (listen?.acked) return; // re-forwarded stream: the client already has its acknowledgement
      if (listen) listen.acked = true;
    }
    if (isResponse(m)) {
      const id = idOf(m) as JsonRpcId;
      if (typeof id === "string" && id.startsWith(REPLAY_PREFIX)) return; // our replay's answer
      const entry = this.#inflight.get(id);
      this.#inflight.delete(id);
      if (entry?.method === LISTEN) this.#listens.delete(id); // the stream ended gracefully
      if (entry?.seq !== undefined) this.#unacked.delete(entry.seq);
      const result = m.result as Record<string, unknown> | undefined;
      if (entry?.method === "initialize" && result) this.#handshaken = true;
      if (result && entry?.method === "tools/list")
        m = { ...m, result: this.#withLocalTools(this.#profiled(clientToolsList(result))) };
      if (result && entry?.method === "tools/call")
        m = { ...m, result: await saveCallFiles(result, this.#deps.files) };
    }
    this.#reply(m);
  }

  // ── endpoint lifecycle ───────────────────────────────────────────────────

  /** A (new) endpoint is connected: open on it, replay, redeliver, flush. */
  attach(ep: EndpointLink): void {
    if (this.closed) return;
    this.#clearOffline();
    const redeliver = [...this.#unacked.entries()].sort(([a], [b]) => a - b);
    const waiting = this.#waiting;
    this.#waiting = [];
    const held = [...this.#listens.entries()].filter(([, l]) => l.liveOn === -1);
    if (!this.#handshaken && redeliver.length === 0 && waiting.length === 0 && held.length === 0)
      return; // opens on first message
    this.#ensureOpen(ep);
    for (const [seq, m] of redeliver) ep.send({ type: "mcp", session: this.id, seq, message: m });
    for (const m of waiting) this.#sendSeq(ep, m);
    // Held listen streams: tools may have changed while the relay held them; then
    // hand each one to the new endpoint (its acknowledgement will be dropped).
    for (const [id, listen] of held) {
      if (listen.liveOn !== -1) continue; // went out with `waiting` above
      if (listen.acked && wantsToolChanges(listen.message)) this.#reply(listenToolsChanged(id));
      this.#inflight.set(id, { method: LISTEN, seq: undefined, acked: false });
      this.#sendSeq(ep, listen.message);
    }
  }

  /**
   * The endpoint went away (or closed this session). Acked requests can't be
   * known to have run or not — answer them; the rest wait for redelivery.
   */
  detach(reason: "gone" | "closed"): void {
    this.#openOn = -1;
    for (const [id, entry] of this.#inflight) {
      if (typeof id === "string" && id.startsWith(REPLAY_PREFIX)) continue;
      const listen = this.#listens.get(id);
      if (listen) {
        // A subscription is read-only: hold it for the next endpoint instead of failing it.
        listen.liveOn = -1;
        this.#inflight.delete(id);
        if (entry.seq !== undefined) this.#unacked.delete(entry.seq);
        continue;
      }
      if (entry.acked) {
        this.#inflight.delete(id);
        if (entry.seq !== undefined) this.#unacked.delete(entry.seq);
        this.#reply(errorResponse(id, reason === "closed" ? ENDPOINT_CLOSED : OUTCOME_UNKNOWN));
      }
    }
    if (
      this.#unacked.size ||
      this.#waiting.length ||
      [...this.#listens.values()].some((l) => !l.acked)
    ) {
      this.#armOffline();
    }
  }

  close(): void {
    this.closed = true;
    this.#clearOffline();
  }

  /** Whether the endpoint should be told this session closed. */
  isOpenOn(generation: number): boolean {
    return this.#openOn === generation;
  }

  // ── offline answers ──────────────────────────────────────────────────────

  #armOffline(): void {
    if (this.#waitTimer || this.closed) return;
    this.#waitTimer = setTimeout(() => {
      this.#waitTimer = undefined;
      if (this.#deps.endpoint() || this.closed) return;
      const pending = [
        ...[...this.#unacked.entries()].sort(([a], [b]) => a - b).map(([, m]) => m),
        ...this.#waiting,
      ];
      this.#unacked.clear();
      this.#waiting = [];
      for (const m of pending) if (isRequest(m)) this.#answerOffline(m);
      // Held listens the client hasn't had acknowledged yet.
      for (const [id, listen] of this.#listens) {
        if (listen.acked) continue;
        listen.acked = true;
        listen.liveOn = -1;
        this.#reply(listenAcknowledged(id, listen.message));
      }
    }, this.#deps.waitMs);
  }

  #clearOffline(): void {
    if (this.#waitTimer) clearTimeout(this.#waitTimer);
    this.#waitTimer = undefined;
  }

  #answerOffline(m: JsonRpcMessage): void {
    const id = idOf(m) as JsonRpcId;
    this.#inflight.delete(id);
    if (m.method === LISTEN) {
      // Held — forwarded on attach. Acknowledged now unless the offline timer will do it.
      const listen = this.#listens.get(id);
      if (listen && !listen.acked && this.#deps.choosing?.()) {
        listen.acked = true;
        this.#reply(listenAcknowledged(id, m));
      }
      return;
    }
    if (m.method === "initialize" && this.#deps.eras().includes("legacy")) this.#handshaken = true;
    const answer = offlineAnswer(m, {
      eras: this.#deps.eras(),
      serverName: this.#deps.serverName,
      relayVersion: this.#deps.relayVersion,
      notConnected: this.#deps.notConnected,
    });
    const result = answer.result as Record<string, unknown> | undefined;
    this.#reply(
      m.method === "tools/list" && result
        ? { ...answer, result: this.#withLocalTools(result) }
        : answer,
    );
  }

  /** A `tools/list` result cut to the client's tool profile, when it has one. */
  #profiled(result: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(result.tools)) return result;
    const named = result.tools.filter(
      (t: unknown): t is { name: string } => typeof (t as { name?: unknown }).name === "string",
    );
    for (const t of named) this.#deps.toolGroups?.set(t.name, toolGroupsOf(t));
    const allow = this.#deps.allowTool;
    if (!allow) return result;
    return { ...result, tools: named.filter((t) => allow(t.name, toolGroupsOf(t))) };
  }

  /** A `tools/list` result with the relay's own tools added when they apply. */
  #withLocalTools(result: Record<string, unknown>): Record<string, unknown> {
    const local = this.#deps.localTools;
    if (!local?.visible() || !Array.isArray(result.tools)) return result;
    return { ...result, tools: [...result.tools, ...local.definitions()] };
  }

  #reply(message: JsonRpcMessage): void {
    if (!this.closed) this.#upstream.send(message);
  }
}
