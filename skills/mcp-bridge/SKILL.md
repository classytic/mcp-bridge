---
name: mcp-bridge
description: Expose a browser extension's (or app's) tools to MCP clients with @classytic/mcp-bridge — connectEndpoint in the extension, the mcp-relay daemon/stdio shim on the machine, pairing, files, conformance tests. Use when wiring an extension to Claude Code/Codex/Gemini CLI over MCP, adding tools to a bridged endpoint, or writing a relay adapter.
---

# @classytic/mcp-bridge

## Wire an extension
1. In an extension page (side panel / pinned tab — tools need DOM + chrome.tabs):
   `connectEndpoint({ serverName, url: bridgeUrl(17345, serverName), secret: () => stored, createServer })`.
2. `createServer({ session, client })` returns a fresh `McpServer` (or arc-ai `serveAsMcp`) per session.
   Give every tool `annotations.readOnlyHint` or `destructiveHint`.
3. Show `onStatus` in the UI (connecting / connected / refused + reason).

## Pair and connect a client
- `mcp-relay pair --server <name> --origin chrome-extension://<id>` → last line is the secret for the extension.
- `claude mcp add <name> -- npx -y -p @classytic/mcp-bridge mcp-relay stdio --server <name>`.
- Products: a bin calling `runRelayCli({ serverName, allowedOrigins, packageName })`.

## Files
- Argument: schema with `"x-mcp-bridge": "file"` (`filePayloadJsonSchema`, or zod `.meta(...)`) → tool gets `{ name, mediaType, size, base64 }`.
- Result: `saveAsResource(name, mediaType, base64)` → relay saves it to the downloads folder.

## Test
- `runEndpointConformance(name, { createServer, expectTools, readCall })` in the app's vitest suite.
- A new relay adapter: `runRelayConformance(name, harness, makeEchoServer)`.

## Don'ts
- Don't define tools in the relay. Don't add a plaintext auth mode. Don't log to stdout in the shim.
