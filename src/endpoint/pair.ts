/**
 * `pairWithCode` — pair an endpoint that can't use native messaging (a desktop
 * app's plugin, a mobile app, a device on the same machine) with the code the
 * user got from `mcp-relay pair-code --server <name>`.
 *
 * ```ts
 * const r = await pairWithCode({ serverName: 'my-app', code: userTyped });
 * if (r.ok) await storage.set('bridge', r.value);          // { relayUrl, secret }
 * connectEndpoint({ serverName: 'my-app', url: r.value.relayUrl, secret: r.value.secret, … });
 * ```
 *
 * Needs only `fetch` to 127.0.0.1 — allow it in your plugin's manifest (Adobe
 * UXP: `requiredPermissions.network.domains`; Figma: `networkAccess`).
 */

import { err, ok, type Result } from "@classytic/primitives/result";
import { isSecret } from "../auth/crypto.js";

export interface PairWithCodeOptions {
  serverName: string;
  /** As the user typed it — case, spaces and dashes don't matter. */
  code: string;
  /** @default 17345 */
  port?: number;
  /** @default "127.0.0.1" */
  host?: string;
  /** @default 10000 */
  timeoutMs?: number;
  /** For tests, or a host whose `fetch` lives elsewhere. */
  fetch?: typeof fetch;
}

export interface PairedRelay {
  relayUrl: string;
  secret: string;
}

export type PairWithCodeError =
  /** No relay answered — start one: `mcp-relay pair-code --server <name>` does. */
  | "relay_unreachable"
  /** Wrong code, or none issued. */
  | "invalid"
  | "expired"
  /** Too many wrong codes lately — wait a minute. */
  | "throttled"
  /** The relay on that port serves another server. */
  | "wrong_server"
  | "bad_response";

export async function pairWithCode(
  opts: PairWithCodeOptions,
): Promise<Result<PairedRelay, PairWithCodeError>> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const url = `http://${opts.host ?? "127.0.0.1"}:${opts.port ?? 17345}/pair`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server: opts.serverName, code: opts.code }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch {
    return err("relay_unreachable");
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 404) return err("wrong_server");
  if (res.status === 429) return err("throttled");
  if (!res.ok) return err(body?.error === "expired" ? "expired" : "invalid");
  if (
    body?.server !== opts.serverName ||
    typeof body.relayUrl !== "string" ||
    !isSecret(body.secret)
  )
    return err("bad_response");
  return ok({ relayUrl: body.relayUrl, secret: body.secret });
}
