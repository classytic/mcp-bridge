/**
 * Two in-process transports wired to each other — for tests, and for running a
 * client and server in the same page. Built on the SDK's public `Transport`
 * contract (the SDK's own in-memory pair is in an unpublished package).
 * Messages are structured-cloned so the ends never share an object.
 */

import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";

class LinkedTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: (<T extends JSONRPCMessage>(message: T) => void) | undefined;
  peer: LinkedTransport | undefined;
  #closed = false;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    const peer = this.peer;
    if (this.#closed || !peer) throw new Error("Linked transport is closed");
    const copy = structuredClone(message);
    queueMicrotask(() => peer.onmessage?.(copy));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const peer = this.peer;
    this.peer = undefined;
    this.onclose?.();
    await peer?.close();
  }
}

/** What one end sends, the other receives. Closing either closes both. */
export function createLinkedTransports(): [Transport, Transport] {
  const a = new LinkedTransport();
  const b = new LinkedTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
