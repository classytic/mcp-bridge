/**
 * Attach-or-spawn: find the daemon for a server, start it if absent, refuse if
 * the port holds something else (hermes `runtime_contract.py`). Liveness is an
 * *authenticated* `/health` — a bare TCP connect would trust any squatter.
 */

import { spawn } from "node:child_process";
import { BRIDGE_PROTOCOL } from "../../protocol/index.js";

export interface DaemonHealth {
  protocol: string;
  server: string;
  epoch: string;
  endpoint: boolean;
  /** Connected endpoints (browser profiles). Absent from pre-0.4 relays. */
  endpoints?: Array<{ id: string; label: string; app?: string; sessions: number }>;
  sessions: number;
  clients: number;
  pid: number;
}

export type DaemonProbe =
  | { state: "ready"; health: DaemonHealth }
  | { state: "absent" }
  /** Something answers but rejects our token — another pairing, or not our relay. */
  | { state: "foreign" }
  /** Our relay, but a protocol or server we don't speak. */
  | { state: "incompatible"; reason: string };

export async function probeDaemon(o: {
  host: string;
  port: number;
  serverName: string;
  clientToken: string;
  timeoutMs?: number;
}): Promise<DaemonProbe> {
  let res: Response;
  try {
    res = await fetch(`http://${o.host}:${o.port}/health`, {
      headers: { authorization: `Bearer ${o.clientToken}` },
      signal: AbortSignal.timeout(o.timeoutMs ?? 1500),
    });
  } catch {
    return { state: "absent" };
  }
  if (res.status === 401 || res.status === 404) return { state: "foreign" };
  if (!res.ok) return { state: "incompatible", reason: `health answered ${res.status}` };
  const health = (await res.json().catch(() => null)) as DaemonHealth | null;
  if (!health || health.protocol !== BRIDGE_PROTOCOL)
    return { state: "incompatible", reason: `protocol ${health?.protocol ?? "unknown"}` };
  if (health.server !== o.serverName)
    return { state: "incompatible", reason: `serves "${health.server}"` };
  return { state: "ready", health };
}

/** Start a detached daemon process that outlives this one. */
export function spawnDetached(command: string, args: readonly string[]): void {
  spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/** Make sure a compatible daemon is running; start one with `spawnDaemon` if none is. */
export async function ensureDaemon(o: {
  host: string;
  port: number;
  serverName: string;
  clientToken: string;
  spawnDaemon: () => void;
  /** @default 10000 */
  startTimeoutMs?: number;
}): Promise<DaemonHealth> {
  let probe = await probeDaemon(o);
  if (probe.state === "absent") {
    o.spawnDaemon();
    const deadline = Date.now() + (o.startTimeoutMs ?? 10_000);
    while (probe.state === "absent" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      probe = await probeDaemon(o);
    }
  }
  switch (probe.state) {
    case "ready":
      return probe.health;
    case "absent":
      throw new Error(`The ${o.serverName} relay did not start on port ${o.port}.`);
    case "foreign":
      throw new Error(
        `Port ${o.port} is held by something that isn't the paired ${o.serverName} relay.`,
      );
    case "incompatible":
      throw new Error(`The relay on port ${o.port} is incompatible: ${probe.reason}.`);
  }
}
