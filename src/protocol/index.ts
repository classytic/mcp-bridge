/**
 * `@classytic/mcp-bridge/protocol` — the `mcp-bridge.v1` wire contract shared
 * by every relay and endpoint: application frames, close codes, capabilities,
 * strict JSON, the JSON-RPC facts a relay reads, and file conventions. The
 * authentication handshake lives in `./auth`. Runs anywhere.
 */

export {
  type BridgeOp,
  type Capabilities,
  CONTRACT_VERSION,
  type ProtocolEra,
  readCapabilities,
  supports,
} from "./capabilities.js";
export { CloseCode, TERMINAL_CLOSE_CODES } from "./close-codes.js";
export {
  containsFileRef,
  FILE_SCHEMA_MARKER,
  FILE_SCHEMA_MARKER_VALUE,
  type FilePayload,
  type FileRef,
  filePayloadJsonSchema,
  fileRefJsonSchema,
  isFileRef,
  resolveFileRefs,
  SAVE_URI_PREFIX,
  type SaveRequest,
  saveAsResource,
  saveFileUri,
  saveRequestOf,
  saveUri,
  toClientSchema,
} from "./files.js";
export {
  type AckFrame,
  BRIDGE_PROTOCOL,
  BRIDGE_SUBPROTOCOL,
  bridgePath,
  bridgeUrl,
  type CloseFrame,
  ENDPOINT_ID,
  type EndpointIdentity,
  encodeFrame,
  type Frame,
  type FrameError,
  type HelloFrame,
  isFrame,
  isJsonRpcMessage,
  type JsonRpcMessage,
  type McpFrame,
  type OpenFrame,
  type PeerInfo,
  type PingFrame,
  type PongFrame,
  parseFrame,
  type ReadyFrame,
  type Role,
} from "./frames.js";
export {
  CLIENT_INFO_META_KEY,
  clientInfoOf,
  errorResponse,
  idOf,
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcId,
  notification,
  resultResponse,
} from "./json-rpc.js";
export {
  hasDuplicateKeys,
  hasExactKeys,
  isPlainObject,
  type JsonObject,
  parseStrictJsonObject,
} from "./strict-json.js";
