/**
 * `@classytic/mcp-bridge/testing` — conformance suites and in-memory wiring.
 *
 *  - {@link runRelayConformance}: for a relay adapter — routing, refusals, the
 *    offline handshake, reconnects, concurrent clients.
 *  - {@link runEndpointConformance}: for an app serving tools — listing,
 *    behaviour hints, file arguments, a read call — through the real relay core.
 *
 * Imports `vitest` and `@modelcontextprotocol/client` from the consumer's
 * install (repo-core's rule); import it from test files only.
 */

export { type EndpointConformanceOptions, runEndpointConformance } from "./endpoint-conformance.js";
export { createMemorySocketPair, memoryDialer, relayClientTransport } from "./memory.js";
export {
  type EchoServerFactory,
  memoryRelayHarness,
  type RelayHarness,
  type RelayUnderTest,
  runRelayConformance,
} from "./relay-conformance.js";
export { waitFor } from "./wait.js";
