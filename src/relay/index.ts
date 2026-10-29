/**
 * `@classytic/mcp-bridge/relay` — the relay core, with no runtime baked in.
 * Adapters (`./relay/node`, later Bun / hosted) supply sockets and clients.
 */

export {
  type AcceptContext,
  type Admission,
  type AdmissionLimits,
  createAdmissionGate,
  type RelaySocket,
  roleForOrigin,
} from "./admission.js";
export { clientToolsList, type RelayFiles, readCallFiles, saveCallFiles } from "./files.js";
export {
  type Era,
  eraOf,
  LEGACY_PROTOCOL_VERSION,
  listenAcknowledged,
  listenToolsChanged,
  MODERN_PROTOCOL_VERSION,
  type OfflineContext,
  offlineAnswer,
  PROTOCOL_VERSION_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
  subscriptionOf,
} from "./offline.js";
export {
  createRelay,
  type Relay,
  type RelayLogger,
  type RelayOptions,
  type RelaySession,
  type RelayStatus,
} from "./relay.js";
export {
  type EndpointLink,
  OUTCOME_UNKNOWN,
  Session,
  type SessionDeps,
  type Upstream,
} from "./session.js";
export {
  parseToolPatterns,
  TOOL_GROUP_META,
  type ToolFilter,
  toolFilter,
  toolGroupsOf,
} from "./tool-filter.js";
