# @classytic/mcp-bridge

Let MCP clients — Claude Code, Codex, Gemini CLI, any MCP client — use the tools
inside something that can only **dial out**: a browser extension, a desktop app's
plugin (Adobe UXP, Figma, an Office add-in), a mobile app, a device. The tools stay
where they live; the bridge carries MCP to them.

```
Claude Code ──Streamable HTTP /mcp──┐
Codex       ──stdio shim────────────┤   relay daemon  (127.0.0.1, one per user + server)
                                    │        │  WebSocket · mutual HMAC auth · mcp-bridge.v1
                                    └────────┴──► endpoint (extension page / app) — hosts the McpServer
```

- **Tools are defined once, in the endpoint.** The relay forwards JSON-RPC; it is
  never a second tool registry.
- **The secret never crosses the wire.** Both sides prove they hold it (HMAC,
  relay first, bound to role and path, single-use, 10 s), and the relay checks
  `Origin` and `Host` so no web page can drive it.
- **Clients may start first.** The relay answers the handshake while the extension
  is closed and tells the client when the tools arrive — no restart.
- **No double execution.** A request the extension received but never answered
  comes back as "outcome unknown", never re-run; one it never received is
  redelivered after a reconnect.
- **Local files** by path (`{ "$file": "/abs/path" }`) in, downloads out.

## Install

```sh
npm i @classytic/mcp-bridge @classytic/primitives @modelcontextprotocol/server
npm i ws   # only where the relay runs (Node)
```

## 1. In the extension (or app): serve tools

```ts
import { connectEndpoint } from '@classytic/mcp-bridge/endpoint';
import { bridgeUrl } from '@classytic/mcp-bridge/protocol';
import { McpServer } from '@modelcontextprotocol/server';

const bridge = connectEndpoint({
  serverName: 'my-app',
  url: bridgeUrl(17345, 'my-app'),
  secret: () => settings.get('bridgeSecret'),          // pasted once from `pair`
  createServer: ({ client, era }) => {                   // a fresh server per call (era-aware)
    const server = new McpServer({ name: 'my-app', version: '1.0.0' });
    server.registerTool('lines.list', { description: '…', annotations: { readOnlyHint: true } }, …);
    return server;                                       // or `serveSession` to drive the transport yourself
  },
  onStatus: (s) => panel.setBridgeStatus(s),            // connecting / connected / refused …
});
```

Using arc-ai (2026-only)? Hand it the session and say so:

```ts
connectEndpoint({
  serverName: 'my-app', url, secret,
  eras: ['modern'],                                     // relay answers offline in 2026 only
  serveSession: (transport) => serveAsMcp({ name: 'my-app', tools, approval, transport }),
});
```

Run it in an extension *page* (side panel, pinned tab): tools usually need both
DOM APIs and `chrome.tabs`. Answering the relay's pings keeps MV3 awake.

## 2. On the machine: pair and connect a client

**One-time install, no copy-paste** (native messaging; the extension needs the
`nativeMessaging` permission):

```sh
npx -p @classytic/mcp-bridge mcp-relay install-native --server my-app --origin chrome-extension://<id>
```
```ts
import { requestNativePairing, ensureRelayViaNative } from '@classytic/mcp-bridge/native';
const r = await requestNativePairing({ serverName: 'my-app' });   // { relayUrl, secret }
await ensureRelayViaNative({ serverName: 'my-app' });             // starts the daemon if needed
```

**Or pair by hand:**

```sh
npx -p @classytic/mcp-bridge mcp-relay pair --server my-app --origin chrome-extension://<id>
# prints the client setup lines; the pairing secret is the last line → paste into the extension

claude mcp add my-app -- npx -y -p @classytic/mcp-bridge mcp-relay stdio --server my-app
```

### Desktop apps, mobile apps and devices

A plugin runtime can open a WebSocket but can't listen, and can't use native
messaging. It pairs by **code** instead:

```sh
npx -p @classytic/mcp-bridge mcp-relay pair-code --server my-app
# Pairing code for "my-app":   K7QM-2XRD   (one-time, 5 minutes)
```
```ts
import { connectEndpoint, pairWithCode } from '@classytic/mcp-bridge/endpoint';

const r = await pairWithCode({ serverName: 'my-app', code: typedByTheUser }); // POST 127.0.0.1:17345/pair
if (r.ok) {
  await store.save(r.value);                       // { relayUrl, secret } — keep it, pair once
  connectEndpoint({ serverName: 'my-app', url: r.value.relayUrl, secret: r.value.secret, createServer });
}
```

- **No Origin needed.** A plugin runtime's socket carries no `Origin`; the endpoint
  names its role in the handshake and proves the secret like any other. (A relay
  can refuse that with `localEndpoints: false`.)
- **Sandboxed plugin UIs** (an iframe with Origin `null`, as Figma's is): allow it
  once — `mcp-relay pair-code --server my-app --origin null`. Any `null`-origin page
  may then *try*; it still needs the secret.
- **No WebCrypto?** Some plugin hosts lack `crypto.subtle`; the bridge falls back to
  a built-in SHA-256 / HMAC that makes identical proofs. A host without
  `crypto.getRandomValues` supplies a secure source:
  `useCrypto({ getRandomValues: (bytes) => host.secureRandom(bytes) })` (from `./auth`).
- **Allow the address in the plugin's manifest:** Adobe UXP lists WebSocket and HTTP
  hosts in `requiredPermissions.network.domains`; Figma uses `networkAccess`
  (`devAllowedDomains` while developing). The relay is `127.0.0.1:17345` by default.
- Codes are single-use, live 5 minutes, die after 5 wrong tries, and wrong codes
  are throttled across the relay.

Apps that can already run a server (Node, Python, a desktop app with a scripting
host) don't *need* the bridge — they can serve MCP over stdio themselves. They still
get pairing, several instances, safe delivery and tool profiles from it.

**Several browser profiles** (one per client company, say): give each install an
identity — `connectEndpoint({ endpoint: { id, label: 'Acme' } })` — and pin a
client to one with `--endpoint Acme` (or `/mcp?endpoint=Acme`). An unpinned
client gets `bridge_listEndpoints` / `bridge_useEndpoint` and must choose.

**Tool profiles** — a server with many tools costs every client their schemas on
every session. A client that needs only some asks for them by name pattern:
`--tools "orders*,getAccount"` (or `/mcp?tools=orders*,getAccount`).
The relay lists only those and refuses calls to the rest; `bridge_*` tools stay.
`@group` selects by group instead — a listed tool's `_meta["classytic.io/group"]`,
which arc-ai's `serveAsMcp` sets from each tool's `group` annotation:
`--tools "@orders,@ops"`.

**Files out** — a tool result's embedded resource whose URI is `saveUri(name)`
is saved to the relay's downloads folder (binary `blob` or textual `text`); `pair`
sets it to your Downloads folder unless you pass `--downloads <dir>`. With
arc-ai, pass `serveAsMcp({ fileUri: saveFileUri })` and every file part a tool
returns is saved.

The stdio shim starts the daemon if none is running. Clients that speak HTTP can
use `http://127.0.0.1:17345/mcp` with the bearer token `pair` prints. Both the
2025 (`initialize`) and 2026-07-28 (`server/discover`, stateless) protocol
revisions are served. `mcp-relay status` / `stop` manage the daemon.

Products ship a ten-line bin instead, with the server name and extension id baked in:

```js
#!/usr/bin/env node
import { runRelayCli } from '@classytic/mcp-bridge/relay/node';
await runRelayCli({ serverName: 'my-app', allowedOrigins: ['chrome-extension://<id>'], packageName: '@acme/my-app-mcp' });
```

## Files

```ts
import { filePayloadJsonSchema, saveAsResource } from '@classytic/mcp-bridge/protocol';
// a tool argument declared with the file schema receives { name, mediaType, size, base64 };
// clients see { "$file": "<absolute path>" } — the relay reads it (configured roots only).
// return saveAsResource('pack.zip', 'application/zip', base64) → saved to the downloads folder.
```

## Subpaths

| Subpath | Runs on | What |
|---|---|---|
| `./protocol` | anywhere | wire contract: frames, close codes, capabilities, strict JSON, files |
| `./auth` | anywhere (WebCrypto, or built-in SHA-256 / HMAC) | mutual HMAC handshake, pairing secret, client token, `useCrypto` |
| `./transport` | anywhere | `SessionTransport`, `createLinkedTransports` (MCP SDK `Transport`s) |
| `./endpoint` | anything with `WebSocket` | `connectEndpoint` — dial, authenticate, serve sessions (2025 + 2026); `pairWithCode` |
| `./native` | extension | native-messaging pairing and relay start |
| `./relay` | anywhere | relay core: admission, sessions, delivery, files — no I/O |
| `./relay/node` | Node ≥ 22 | daemon (ws + Streamable HTTP), stdio shim, pairing (secret, code, native), native host + installer, CLI |
| `./testing` | vitest | conformance suites + in-memory wiring |

No root import; browser bundles never reach `ws` or `node:*`.

## Conformance

Another relay (Bun, hosted) or an app serving tools proves itself with the same
scenarios this package runs on itself:

```ts
import { runRelayConformance, runEndpointConformance } from '@classytic/mcp-bridge/testing';
runEndpointConformance('my extension', { createServer, expectTools: ['lines.list'], readCall: { name: 'lines.list' } });
```

## Design

[`docs/DESIGN.md`](docs/DESIGN.md) — the wire contract, the auth handshake, delivery
rules, and where each idea came from (openclaw's extension relay, hermes-agent's
gateway, the MCP SDK).

MIT © Classytic LLC — see [TRADEMARK.md](TRADEMARK.md).
