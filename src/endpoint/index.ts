/**
 * `@classytic/mcp-bridge/endpoint` — serve MCP from anything that can open a
 * WebSocket (an extension page, an app, a device).
 *
 * ```ts
 * const bridge = connectEndpoint({
 *   serverName: 'xero',
 *   url: bridgeUrl(17345, 'xero'),
 *   secret: () => storage.get('bridgeSecret'),
 *   createServer: ({ client }) => buildServer(client),   // McpServer, arc-ai serveAsMcp, …
 *   onStatus: (s) => panelStatus.set(s),
 * });
 * ```
 *
 * No `chrome.*` import. For an MV3 extension, run it in an extension page
 * (side panel / pinned tab); answering the relay's pings keeps Chrome from
 * idling the extension while connected.
 */

export { type BackoffOptions, createBackoff } from "./backoff.js";
export {
  connectEndpoint,
  type EndpointHandle,
  type EndpointOptions,
  type EndpointState,
  type EndpointStatus,
  type ServerContext,
  type SessionContext,
  type SessionServer,
  type WebSocketLike,
} from "./connect.js";
