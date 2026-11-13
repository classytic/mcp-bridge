# Changelog

## 0.2.0 — 2026-11-13

Endpoints beyond browser extensions — a desktop app's plugin (Adobe UXP, Figma,
an Office add-in), a mobile app, a device.

### Added
- **Pairing by code.** `mcp-relay pair-code --server <name> [--origin null]` prints a
  one-time code (single-use, 5 min, 5 tries, throttled relay-wide); the app redeems it
  with `pairWithCode` (`./endpoint`) and gets `{ relayUrl, secret }`. The daemon serves
  `POST /pair/code` (client token, no Origin) and `POST /pair` (any origin; CORS and
  Private Network Access preflights). `createPairingCodes` (`./relay`) for other adapters.
- **Endpoints without an Origin.** `auth.hello` may name the dialer's `role`; endpoints
  always do. A socket with no Origin may be a client or an endpoint (it still proves the
  secret); `localEndpoints: false` on the daemon keeps it to clients. `rolesForOrigin` /
  `OriginPolicy` (`./relay`); `AcceptContext.roles`. Origin `"null"` (a sandboxed plugin
  UI) may be allowlisted.
- **No-WebCrypto runtimes.** A built-in SHA-256 / HMAC-SHA256 (`sha256`, `hmacSha256`
  from `./auth`) is used where `crypto.subtle` is missing; `useCrypto({ getRandomValues,
  hmacSha256, webCrypto })` lets a host supply its own.

### Changed
- The relay saves files to your `Downloads` folder when none is configured — at `daemon`
  start too, so earlier pairings are covered without re-pairing; `mcp-relay pair` also
  writes it into a new pairing's config. Pass `--downloads <dir>` for another folder. (Was: when none is
  configured, files a tool handed back were dropped with "this relay has no downloads folder".)
- `roleForOrigin` is deprecated (no-Origin sockets were clients only); adapters use
  `rolesForOrigin`. `AcceptContext.role` still works.

### Compatibility
- A client (`stdio` shim) still speaks to a 0.1 relay. An endpoint on this version
  announces its role, which a 0.1 relay refuses — run the relay from this version too
  (`npx -p @classytic/mcp-bridge` fetches the latest; a 0.1 daemon still running exits
  after 10 idle minutes, or `mcp-relay stop`). A browser extension (allowlisted Origin)
  can pass `connectEndpoint({ announceRole: false })` to work with both.

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
