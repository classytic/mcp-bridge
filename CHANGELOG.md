# Changelog

## 0.1.0 — 2026-10-29

First version of the `mcp-bridge.v1` contract.

- `./protocol` — frames, close codes, additive capabilities (incl. protocol
  eras), strict JSON, JSON-RPC helpers, file conventions.
- `./auth` — mutual HMAC-SHA256 handshake over WebCrypto: relay proves first,
  proofs bound to role + path, 10 s single-use challenges, replay guard.
- `./transport` — `SessionTransport`, `createLinkedTransports`.
- `./endpoint` — `connectEndpoint`: subprotocol check, auth, per-session MCP
  servers through the SDK's era-aware `serveStdio` (or `serveSession`), seq
  acks with duplicate detection, full-jitter backoff, endpoint identity
  (`{ id, label }`) for several browser profiles.
- `./native` — native-messaging pairing and relay start.
- `./relay` — admission (pre-auth caps, deadlines, capacity), sessions
  (offline answers per era, handshake replay, held `subscriptions/listen`,
  ack-gated redelivery, "outcome unknown"), several endpoints with pinned or
  chosen sessions that never drift, tool profiles (`--tools` / `?tools=`
  name patterns or `@group` — `_meta["classytic.io/group"]` — cut `tools/list`
  and refuse other calls), file rewriting (saves `blob` and `text` resources;
  `saveUri` / `saveFileUri` for servers that build resources from file parts),
  heartbeats.
- `./relay/node` — daemon (ws + Streamable HTTP `/mcp` for 2025 and 2026,
  loopback Host, Origin policy, bearer, pre-auth wire cap, single instance by
  port bind, idle exit, `/shutdown`), stdio shim with attach-or-spawn, pairing
  config, `fs` files, native host + installer, `mcp-relay` CLI.
- `./testing` — `runRelayConformance`, `runEndpointConformance`, in-memory wiring.

### Peers

`@classytic/primitives >=0.35.0`, `@modelcontextprotocol/client >=2.4.0` and `server >=2.4.0` (both optional), `ws >=8.22.0` (optional): all at the latest published. Dev toolchain: TypeScript `~7.0.2`, tsdown `^0.23.3`.
