/**
 * The native messaging host Chrome launches when the extension calls
 * `requestNativePairing` / `ensureRelayViaNative`. One framed request in, one
 * framed response out, then exit.
 *
 * Validation comes first and is total (openclaw `extension-native-host.ts`):
 * the caller origin Chrome passes must be one this host was installed for, the
 * frame must be complete, within 4 KiB, valid UTF-8 and an exact request —
 * before any config is read or any relay touched.
 */

import { endianness } from "node:os";
import type { Readable, Writable } from "node:stream";
import {
  isNativeRequest,
  MAX_NATIVE_REQUEST_BYTES,
  MAX_NATIVE_RESPONSE_BYTES,
  NATIVE_VERSION,
  type NativeFailureCode,
  type NativeRequest,
  type NativeResponse,
} from "../../native/protocol.js";
import { bridgeUrl } from "../../protocol/index.js";
import { parseStrictJsonObject } from "../../protocol/strict-json.js";

const LE = endianness() === "LE";

/** Chrome's framing: 4-byte length in native byte order, then UTF-8 JSON. */
export function encodeNativeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_NATIVE_RESPONSE_BYTES) throw new Error("native response too large");
  const header = Buffer.alloc(4);
  if (LE) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/**
 * Read exactly one frame. Never allocates from the untrusted length: anything
 * over `maxBytes`, zero-length, invalid UTF-8 or followed by trailing bytes is null.
 */
export function readNativeFrame(
  input: Readable,
  maxBytes = MAX_NATIVE_REQUEST_BYTES,
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      input.off("data", onData);
      resolve(value);
    };
    const parse = (): string | null | undefined => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) return undefined;
      const length = LE ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
      if (length === 0 || length > maxBytes) return null;
      if (buf.length < 4 + length) return undefined;
      if (buf.length > 4 + length) return null; // trailing bytes
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(4));
      } catch {
        return null;
      }
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes + 4) return finish(null);
      chunks.push(chunk);
      const r = parse();
      if (r !== undefined) finish(r);
    };
    input.on("data", onData);
    input.once("end", () => finish(parse() ?? null));
  });
}

/** Chrome passes the caller as `chrome-extension://<id>/`; compare without the slash. */
const normalizeOrigin = (o: string) => o.replace(/\/+$/, "");

export interface NativeHostOptions {
  serverName: string;
  /** Origins this host was installed for (`chrome-extension://<id>`). */
  expectedOrigins: readonly string[];
  /** The origin Chrome passed on the command line. */
  callerOrigin: string | undefined;
  /** The relay port the URL should name. */
  port: number;
  /** The pairing secret for this server, creating it (and allowing `origin`) when needed. */
  pairing(origin: string): Promise<string>;
  /** Make sure the daemon runs; resolves to what was done. Throws if it can't. */
  ensureRelay(): Promise<"running" | "spawned">;
  stdin?: Readable;
  stdout?: Writable;
}

/** Handle one request; resolves to the response that was written. */
export async function runNativeHost(o: NativeHostOptions): Promise<NativeResponse> {
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
  const raw = await readNativeFrame(stdin);
  const value = raw === null ? null : parseStrictJsonObject(raw, MAX_NATIVE_REQUEST_BYTES);
  const nonce = typeof value?.nonce === "string" ? (value.nonce as string).slice(0, 64) : "";
  const reply = (response: NativeResponse) => {
    stdout.write(encodeNativeFrame(response));
    return response;
  };
  const refuse = (code: NativeFailureCode) => reply({ v: NATIVE_VERSION, ok: false, nonce, code });

  const origin = o.callerOrigin ? normalizeOrigin(o.callerOrigin) : undefined;
  if (!origin || !o.expectedOrigins.map(normalizeOrigin).includes(origin))
    return refuse("origin_forbidden");
  if (!isNativeRequest(value)) return refuse("invalid_request");
  const request: NativeRequest = value;

  try {
    if (request.op === "pair") {
      const secret = await o.pairing(origin);
      return reply({
        v: NATIVE_VERSION,
        ok: true,
        nonce: request.nonce,
        relayUrl: bridgeUrl(o.port, o.serverName),
        secret,
      });
    }
    return reply({
      v: NATIVE_VERSION,
      ok: true,
      nonce: request.nonce,
      relay: await o.ensureRelay(),
    });
  } catch {
    return refuse(request.op === "ensure" ? "relay_unavailable" : "host_error");
  }
}
