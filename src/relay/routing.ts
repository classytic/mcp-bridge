/**
 * Several endpoints for one server — the same extension in several browser
 * profiles, each signed in to a different client's books. Each endpoint has a
 * stable `id` and a human `label`; MCP client sessions are bound to one:
 *
 *  - **pinned** (`--endpoint Acme`, `/mcp?endpoint=Acme`): bound by id or label
 *    at setup, never switches;
 *  - **unpinned**: binds automatically when exactly one endpoint is connected;
 *    with several, the session gets two relay tools —
 *    `bridge_listEndpoints` and `bridge_useEndpoint` — and nothing else until
 *    it picks one.
 *
 * Either way a bound session whose endpoint drops waits for *that* endpoint to
 * come back; it never moves to another one on its own (another profile is
 * another client's books).
 */

import type { EndpointIdentity, PeerInfo, ProtocolEra } from "../protocol/index.js";
import type { EndpointLink } from "./session.js";

export const DEFAULT_ENDPOINT_ID = "default";

/** A connected endpoint. */
export interface EndpointEntry extends EndpointLink {
  readonly id: string;
  readonly label: string;
  readonly info: PeerInfo | undefined;
  readonly eras: readonly ProtocolEra[] | undefined;
}

export const identityOf = (e: EndpointIdentity | undefined): EndpointIdentity =>
  e ?? { id: DEFAULT_ENDPOINT_ID, label: DEFAULT_ENDPOINT_ID };

export type Resolution =
  | { ok: true; entry: EndpointEntry }
  | { ok: false; reason: "none" | "ambiguous"; message: string };

/** Find an endpoint by id, else by label (case-insensitive). Ambiguous labels are refused. */
export function resolveEndpoint(endpoints: Iterable<EndpointEntry>, selector: string): Resolution {
  const all = [...endpoints];
  const byId = all.find((e) => e.id === selector);
  if (byId) return { ok: true, entry: byId };
  const wanted = selector.trim().toLowerCase();
  const byLabel = all.filter((e) => e.label.toLowerCase() === wanted);
  if (byLabel.length === 1) return { ok: true, entry: byLabel[0] as EndpointEntry };
  if (byLabel.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message: `Several browser profiles are labelled "${selector}" (${byLabel.map((e) => e.id).join(", ")}) — pick one by id.`,
    };
  }
  return {
    ok: false,
    reason: "none",
    message: `No browser profile "${selector}" is connected. Connected: ${all.map((e) => `"${e.label}"`).join(", ") || "none"}.`,
  };
}

export const LIST_ENDPOINTS = "bridge_listEndpoints";
export const USE_ENDPOINT = "bridge_useEndpoint";

/** The relay's own tools, offered to unpinned sessions when several endpoints are connected. */
export const SWITCH_TOOL_DEFINITIONS = [
  {
    name: LIST_ENDPOINTS,
    title: "List connected browser profiles",
    description:
      "List the browser profiles serving these tools (each usually signed in to a different client's books), " +
      "and which one this session is using.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: USE_ENDPOINT,
    title: "Work in a browser profile",
    description:
      "Use one connected browser profile (by label or id from bridge_listEndpoints) for the rest of this session. " +
      "Every later tool call acts in that profile — confirm with the operator which client's books they mean first.",
    inputSchema: {
      type: "object",
      properties: { endpoint: { type: "string", description: "The profile's label or id" } },
      required: ["endpoint"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const;

export const CHOOSE_FIRST = `Several browser profiles are connected. Call ${LIST_ENDPOINTS}, confirm which one the operator means, then ${USE_ENDPOINT}.`;
