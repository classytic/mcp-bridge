/**
 * One MCP session carried over a shared bridge socket, as an MCP SDK
 * `Transport`: hand it to `server.connect(t)` (endpoint) or `client.connect(t)`.
 *
 * Outbound messages go to `sendMessage`; the channel delivers inbound ones with
 * {@link SessionTransport.receive}. Two ways to end it, kept apart so a
 * session is never closed twice on the wire:
 *  - `close()` — this side ends it: `onClosed` runs (tell the other side), then `onclose`.
 *  - `end()` — the other side or the channel ended it: only `onclose`.
 */

import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";

export class SessionTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: (<T extends JSONRPCMessage>(message: T) => void) | undefined;

  readonly sessionId: string;
  readonly #send: (message: JSONRPCMessage) => void | Promise<void>;
  readonly #onClosed: (() => void) | undefined;
  #closed = false;

  constructor(
    sessionId: string,
    send: (message: JSONRPCMessage) => void | Promise<void>,
    onClosed?: () => void,
  ) {
    this.sessionId = sessionId;
    this.#send = send;
    this.#onClosed = onClosed;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.#closed) throw new Error(`MCP session ${this.sessionId} is closed`);
    await this.#send(message);
  }

  /** Deliver a message that arrived for this session. */
  receive(message: JSONRPCMessage): void {
    if (!this.#closed) this.onmessage?.(message);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClosed?.();
    this.onclose?.();
  }

  /** The session ended from the other side — nothing is sent back. */
  end(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onclose?.();
  }
}
