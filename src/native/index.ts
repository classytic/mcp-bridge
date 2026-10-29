/**
 * `@classytic/mcp-bridge/native` — the extension side of native-messaging
 * pairing: ask the locally installed bridge host for the relay URL and secret
 * (no copy-paste), or ask it to start the relay.
 *
 * ```ts
 * const r = await requestNativePairing({ serverName: 'xero' });
 * if (r.ok) await storage.set({ bridgeUrl: r.value.relayUrl, bridgeSecret: r.value.secret });
 * else if (r.error.retry) scheduleRetry(); else showManualPairing(r.error.code);
 * ```
 *
 * Needs the `nativeMessaging` permission and the host installed with
 * `mcp-relay install-native --server <name> --origin chrome-extension://<id>`.
 * Failures say whether a retry can help (`retry: true` — host missing, timed
 * out, relay down) or a person must act (`retry: false`) — openclaw's
 * `retrying` vs sticky `manual_required`.
 */

import { err, ok, type Result } from "@classytic/primitives/result";
import { randomBase64Url } from "../auth/crypto.js";
import {
  isNativeResponseFor,
  type NativeFailureCode,
  type NativeOp,
  type NativeRequest,
  nativeHostName,
} from "./protocol.js";

export {
  isNativeRequest,
  isNativeResponseFor,
  MAX_NATIVE_REQUEST_BYTES,
  MAX_NATIVE_RESPONSE_BYTES,
  NATIVE_VERSION,
  type NativeFailureCode,
  type NativeOp,
  type NativeRequest,
  type NativeResponse,
  nativeHostName,
} from "./protocol.js";

export interface NativePairing {
  relayUrl: string;
  secret: string;
}

export interface NativeFailure {
  code: NativeFailureCode | "host_not_found" | "timeout" | "invalid_response";
  /** Whether trying again later can help. */
  retry: boolean;
  message: string;
}

/** `chrome.runtime.sendNativeMessage`, injectable for tests and other browsers. */
export type SendNativeMessage = (host: string, message: NativeRequest) => Promise<unknown>;

export interface NativeOptions {
  serverName: string;
  /** Override the host name (default {@link nativeHostName}). */
  hostName?: string;
  /** @default chrome.runtime.sendNativeMessage */
  send?: SendNativeMessage;
  /** @default 30000 */
  timeoutMs?: number;
}

const RETRYABLE: ReadonlySet<string> = new Set(["host_not_found", "timeout", "relay_unavailable"]);

function defaultSend(): SendNativeMessage {
  const runtime = (
    globalThis as {
      chrome?: { runtime?: { sendNativeMessage?: (h: string, m: unknown) => Promise<unknown> } };
    }
  ).chrome?.runtime;
  if (!runtime?.sendNativeMessage) {
    throw new Error(
      "chrome.runtime.sendNativeMessage is unavailable — add the nativeMessaging permission",
    );
  }
  return (host, message) => runtime.sendNativeMessage?.(host, message) as Promise<unknown>;
}

async function call<T>(
  op: NativeOp,
  o: NativeOptions,
  pick: (r: Record<string, unknown>) => T,
): Promise<Result<T, NativeFailure>> {
  const request: NativeRequest = { v: 1, op, nonce: randomBase64Url(24) };
  const host = o.hostName ?? nativeHostName(o.serverName);
  const fail = (code: NativeFailure["code"], message: string) =>
    err<NativeFailure>({ code, retry: RETRYABLE.has(code), message });

  let response: unknown;
  try {
    const send = o.send ?? defaultSend();
    response = await Promise.race([
      send(host, request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), o.timeoutMs ?? 30_000),
      ),
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === "timeout") return fail("timeout", "The bridge host did not answer in time.");
    if (/not found|not installed|forbidden/i.test(message)) {
      return fail("host_not_found", `The bridge host "${host}" is not installed for this browser.`);
    }
    return fail("host_not_found", message);
  }
  if (!isNativeResponseFor(response, request)) {
    return fail("invalid_response", "The bridge host answered with something unexpected.");
  }
  if (response.ok === false)
    return fail(response.code, `The bridge host refused: ${response.code}.`);
  return ok(pick(response as unknown as Record<string, unknown>));
}

/** Ask the native host for the relay URL and pairing secret. */
export function requestNativePairing(
  o: NativeOptions,
): Promise<Result<NativePairing, NativeFailure>> {
  return call("pair", o, (r) => ({ relayUrl: r.relayUrl as string, secret: r.secret as string }));
}

/** Ask the native host to make sure the relay daemon is running. */
export function ensureRelayViaNative(
  o: NativeOptions,
): Promise<Result<"running" | "spawned", NativeFailure>> {
  return call("ensure", o, (r) => r.relay as "running" | "spawned");
}
