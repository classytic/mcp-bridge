# @classytic/mcp-bridge — design

> Status: implemented (0.1.0, unreleased), except where the last section says otherwise. Sources studied:
> openclaw's browser extension relay (`extensions/browser`), hermes-agent's
> gateway / ACP / relay connector, the MCP TypeScript SDK 2.4, arc and
> repo-core conventions. Where we copy, the source is named.

## 1. What it is

MCP clients (Claude Code, Codex, Gemini CLI, …) drive tools that live inside
something that can only *dial out* — a browser extension, a mobile app, a
device. The package gives both ends and the wire between them:

```
MCP clients ──Streamable HTTP /mcp──┐
MCP clients ──stdio shim────────────┤   relay daemon (127.0.0.1, one per user+server)
                                    │        │  WebSocket, mutual-HMAC auth, mcp-bridge.v1
                                    └────────┴──► endpoint (extension page / app) hosts McpServer
```

Rules that don't move:
- **Tools are defined once, in the endpoint.** The relay forwards JSON-RPC; it
  never becomes a second tool registry or execution engine.
- **The relay never holds app secrets** and never sees app data except to
  rewrite file references.
- **Every security frame is strict**, every limit explicit, every failure typed.

## 2. Wire contract `mcp-bridge.v1`

### 2.1 Transport
- WebSocket on `ws://127.0.0.1:<port>/bridge/<server>`; `wss://` required for
  anything not loopback (hosted relay, later).
- Subprotocol **`mcp-bridge.v1`**, exactly one offered; the endpoint refuses a
  socket whose negotiated `ws.protocol` differs (openclaw `relay-connection.js`).
- The relay checks `Host` is loopback (DNS-rebinding guard, hermes
  `web_server_boundary.py`) and `Origin` is in the allowlist for endpoints, or
  absent for local clients — never "empty means fine" (openclaw's gap).

### 2.2 Pre-auth phase (bounded)
- 16 KiB wire cap until authenticated, 10 s deadline, pending-connection
  limits global and per source with every loopback alias counted as one
  source (openclaw `preauth-websocket-guard.ts`, `auth-v2.ts`).
- Frames parsed with **strict JSON**: byte cap before parse, duplicate keys
  rejected at any depth, exact key sets (openclaw `strict-json.js`). One
  module, used by browser and Node alike.

### 2.3 Mutual authentication (openclaw relay-auth v2, adapted)
Pairing secret: 32 random bytes, stored as 64 lowercase hex. Used directly
as the HMAC-SHA256 key (no KDF — valid only because it is 32 random bytes;
enforced by format). `keyId = base64url(SHA-256(key))[0..22]`.

| # | Direction | Frame (exact keys) |
|---|---|---|
| 1 | dialer → relay | `auth.hello {v:1, keyId, clientNonce}` |
| 2 | relay → dialer | `auth.challenge {v:1, keyId, instanceId, sessionId, clientNonce, serverNonce, issuedAtMs, expiresAtMs, role, resource, serverProof}` |
| 3 | dialer → relay | `auth.response {v:1, sessionId, clientProof}` |
| 4 | relay → dialer | `auth.ok {v:1, sessionId, acceptProof}` |

- Proof input: canonical UTF-8 JSON array
  `["mcp-bridge.auth", 1, kind, keyId, instanceId, sessionId, clientNonce, serverNonce, issuedAtMs, expiresAtMs, role, resource(, clientProof)]`.
- **Server proves first**; the dialer verifies `serverProof` before computing
  anything (a relay without the key gets no oracle). `acceptProof` confirms the
  relay accepted *this* client proof.
- `role` (`endpoint` | `client`) and `resource` (the exact path) are bound in,
  so a proof for one route can't be replayed on another.
- Challenge TTL 10 s, clock skew ≤ 30 s; challenge consumed *before* the proof
  is checked; replay map keyed `keyId:clientNonce` until expiry.
- WebCrypto on both sides; one canonicaliser; **golden test vectors** plus a
  mutation test per bound field.
- No legacy/plaintext mode, ever (openclaw's `allowLegacyAuth ?? true` is the
  thing to avoid).

### 2.4 After auth: describe, then talk
- `hello {v:1, role, server, info, capabilities}` — additive-only capability
  descriptor: unknown keys ignored, missing ones defaulted, `supportedOps`
  advertises extras so old peers degrade instead of hanging (hermes
  `gateway/relay/descriptor.py`).
- A newer endpoint replaces the current one **only after its hello is valid**;
  the old one is closed `4000 superseded` (openclaw `relay-bridge.ts`).
- Session frames: `open {session, client}`, `mcp {session, seq, message}`,
  `ack {session, seq}`, `close {session, reason}`.
- Heartbeat is **relay-driven**: `ping` every 20 s, two missed `pong`s → close
  `4000 heartbeat` ("an open socket can outlive a dead service worker",
  openclaw). The extension side also arms a `chrome.alarms` watchdog.

### 2.5 Delivery while the endpoint sleeps or reloads (hermes ack-gated buffering)
- Relay → endpoint `mcp` frames carry a per-session `seq`; the endpoint `ack`s
  on receipt. On reconnect the endpoint's hello carries `resume {epoch, acked}`
  per session.
- **Never acked** → redelivered after reconnect.
- **Acked but unanswered** when the endpoint vanished → the client gets an
  error *"outcome unknown — check before retrying"*, never a silent re-run. A
  Xero write must not happen twice because a service worker restarted.
- Relay restart changes `epoch`; endpoints reset their watermarks.

### 2.6 Clients before the endpoint
Kept from the first draft: requests wait briefly, then the relay answers the
handshake itself (tools only, `listChanged`), lists no tools, errors calls with
a clear message; when the endpoint connects it replays the client's handshake
and sends `notifications/tools/list_changed`.

### 2.7 Files
Kept: endpoint marks file arguments with `x-mcp-bridge: "file"`; clients see
`{ "$file": path }`; the relay reads only under configured roots with a size
cap; results with `mcp-bridge-save:` resources are saved to the downloads
folder.

### 2.8 Close codes
`4000` superseded/heartbeat · `4001` bad hello · `4003` auth rejected ·
`4008` deadline · `4013` capacity · `4426` protocol mismatch · `1011` internal.

## 3. The relay daemon (Node adapter)

- **One daemon per user + server**, bound to 127.0.0.1. **The port bind is the
  single-instance lock**: `EADDRINUSE` → exit quietly (openclaw
  `relay-daemon.ts`). Idle exit after 10 min with no endpoint and no clients.
- **Streamable HTTP `/mcp`** for clients that support it (Claude Code
  `--transport http`, Gemini CLI `httpUrl`, Codex `url`). Requires
  `Authorization: Bearer <client token>` (derived from the pairing secret, so
  one `pair` covers both), plus the Host/Origin checks above.
- **stdio shim** (`mcp-relay stdio`) for clients that only launch processes:
  an attach-or-spawn state machine — `absent | starting | ready | incompatible`
  → `attach | wait | spawn | reject` (hermes `runtime_contract.py`). Liveness is
  an **authenticated** health check, not a bare TCP connect (openclaw's
  squatter gap). Spawns the daemon detached; then talks to it as a `client`.
- `GET /health` (authenticated): protocol, version, endpoint connected,
  sessions — used by the shim and by `mcp-relay status`.
- Pairing: `mcp-relay pair --server xero` writes the secret to the user config
  dir (0600) and prints it plus the ready-made `claude mcp add` / Codex /
  Gemini snippets.
- **Later (0.2): native messaging host** that hands the extension its pairing
  and ensures the daemon is running — no copy-paste (openclaw
  `native-bootstrap`, strict single framed request, origin + manifest checks
  before any privileged import, `retrying` vs sticky `manual_required`).

## 4. The endpoint

`connectEndpoint({ serverName, url, secret, createServer, onStatus, ... })`:
- negotiates the subprotocol, runs the auth client state machine
  (`new → waiting-challenge → verifying → waiting-ok → authenticated`, any
  error = failed), sends `hello` with capabilities + resume watermarks;
- one `McpServer` per session via `createServer({ session, client })`;
- **generation check at every await** so a replaced socket can never answer
  (openclaw `isCurrent`);
- full-jitter backoff (300 ms → 15 s), a socket that dies within 5 s counts as
  a failure (hermes `reconnect-backoff.ts` — stopped a reconnect storm);
- status for the UI: `connecting | connected | disconnected | refused`, with
  the relay's info and live sessions;
- no `chrome.*` import: secret via a getter, socket via `createSocket`, alarms
  via an optional `keepAlive` hook.

## 5. Package layout

```
src/
  protocol/   frames.ts  close-codes.ts  strict-json.ts  capabilities.ts  json-rpc.ts  files.ts  index.ts
  auth/       canonical.ts  crypto.ts (WebCrypto HMAC/SHA)  client.ts  server.ts  index.ts
  transport/  session-transport.ts  linked.ts  index.ts
  endpoint/   connect.ts  auth-client.ts  sessions.ts  backoff.ts  index.ts
  relay/      admission.ts (pre-auth guard, limits)  sessions.ts (offline, replay)  delivery.ts (seq/ack)
              files.ts  relay.ts  index.ts
  relay/node/ daemon.ts  http-mcp.ts  stdio-shim.ts  attach.ts  files.ts  config.ts  index.ts
  internal/   serial-queue.ts  timers.ts
  bin/        mcp-relay.ts   (daemon | stdio | pair | status)
  testing/    relay-conformance.ts  endpoint-conformance.ts  memory-socket.ts  index.ts
tests/
  unit/<module>.test.ts      golden vectors, strict JSON, admission limits
  integration/*.test.ts      real sockets, port 0, daemon lifecycle, HTTP + stdio clients
  e2e/*.chromium.test.ts     opt-in: real extension in Chromium (env-gated)
  support/*.test-support.ts  fake WebSocket, fixed keys, clock
```
- Files stay small (one concern each); entries are thin `*-entry`/bin files.
- `./testing` stays a published subpath (repo-core / arc precedent: other
  relays and hosts run the same conformance); test *files* live in `tests/`.
- Release tooling from `@classytic/dev-tools` (`classytic-push`,
  `classytic-release`); a package **contract test** pins exports and that no
  Node import reaches browser subpaths.

## 6. Out of the package (said so we don't drift)

- **Approvals** belong to the serving app / arc-ai `serveAsMcp`: scopes as
  stable ids (once / session / always / deny), fail closed on unknown, timeout
  reported apart from deny, user-configurable (hermes `acp_adapter/permissions.py`).
- **What tools exist** — the app.

## 7. Phases

- **0.1** — protocol, auth (+ vectors), transport, endpoint, relay core
  (admission, sessions, delivery, files), Node daemon (WS + HTTP `/mcp`),
  stdio shim with attach-or-spawn, `pair`/`status`, conformance suites.
- **0.2** — native messaging pairing + ensure-relay; Bun adapter.
- **0.3** — hosted relay (`wss://`, rotating secrets) for cloud agents.

## 8. Added after the first cut

- **Pre-auth wire cap.** The Node adapter counts raw TCP bytes from the upgrade
  until admission (17 KiB) and destroys the socket past it, before `ws` buffers
  a frame; the core calls `RelaySocket.admitted()` to lift it.
- **2026-07-28 everywhere.** The endpoint serves every session through the SDK's
  era-aware `serveStdio`; `/mcp` routes with the SDK's `isLegacyRequest` —
  2025 traffic keeps sessions, 2026 traffic runs as one-request sessions
  (JSON, or SSE when accepted, so progress and `subscriptions/listen` stream).
- **`mcp-relay stop`** — authenticated `POST /shutdown`.
- **Native-messaging pairing** — `./native` (`requestNativePairing`,
  `ensureRelayViaNative`), the `native-host` command, and
  `install-native` / `uninstall-native` for Chrome, Chrome for Testing,
  Chromium, Edge and Brave on Windows (per-user registry), macOS and Linux.
  Origins are baked into the launcher and checked before anything is read.

## 9. Protocol eras

The endpoint says which MCP eras its server answers (`hello.capabilities.eras`;
arc-ai's `serveAsMcp` is 2026-only). The relay remembers it, and before any
endpoint has connected uses `offlineEras`. Offline answers then match:

- **2026** — `server/discover` → `{ supportedVersions, capabilities, instructions,
  resultType: "complete", ttlMs: 0, cacheScope: "private" }`;
  `subscriptions/listen` → `notifications/subscriptions/acknowledged` (tool
  changes only) and the stream is **held**: forwarded to each endpoint that
  connects (its duplicate acknowledgement dropped), sent
  `tools/list_changed` (with the stream's subscription id) when tools may have
  changed, and never failed with "outcome unknown" — a subscription is read-only.
- **2025** — the synthetic `initialize` + handshake replay, only when the
  endpoint serves 2025; otherwise -32022 naming 2026-07-28, so a client never
  settles on a protocol the extension will refuse.
- The stdio shim holds listen streams across daemon restarts the same way.

## 10. Several endpoints — the same extension in several browser profiles

Each endpoint sends `hello.endpoint = { id, label }`: `id` stable per install
(random, in that profile's storage), `label` what people pick it by. The relay
keeps one endpoint **per id** — replacement happens only within an id (an
extension reload), so profiles never knock each other off. Sessions are bound:

- **Pinned** — `mcp-relay stdio --endpoint Acme`, `/mcp?endpoint=Acme` (id or
  label, case-insensitive; an ambiguous label is refused). Never switches; no
  switch tools listed.
- **Unpinned** — binds on its own when exactly one endpoint is connected. With
  several, it is offered only `bridge_listEndpoints` / `bridge_useEndpoint`
  (answered by the relay) until it chooses; it may switch later (old session
  closed on that endpoint, handshake replayed or listen re-forwarded on the new
  one, `tools/list_changed` sent). 2026 HTTP is stateless, so there the switch
  tool says to pin in the URL instead.
- **Safety** — a bound session whose endpoint drops waits for *that* endpoint
  (`"Acme" is not connected`); it never drifts to another — another profile is
  another client's books.

`/health` and `mcp-relay status` list the connected endpoints.

**Tool profiles.** A session may carry name patterns (`*` wildcard, or
`@group` matched against a listed tool's `_meta["classytic.io/group"]`; the
relay remembers each tool's groups from any session's `tools/list`, so a
stateless 2026 call can be checked) — `--tools`
on the stdio shim (sent in its `open` frame), `?tools=` on HTTP. The relay cuts
`tools/list` to the matching tools and answers a call to any other with -32602
without forwarding it; the relay's own `bridge_*` tools are always kept. It is
a context-size control, not a permission: the endpoint's own approvals still
decide what runs.

## 11. Still open

- **Hosted relay (`wss://`, rotating secrets)** and a **Bun adapter** — later.
- **WebMCP adapter** — serve a page's `document.modelContext` tools through the
  bridge, if sites adopt WebMCP.
