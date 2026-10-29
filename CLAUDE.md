# @classytic/mcp-bridge — working notes for agents

Read `docs/DESIGN.md` before changing behaviour; it is the contract.

## Layout (one concern per file)
- `src/protocol` — wire contract. Runtime-agnostic. No `node:` imports, ever.
- `src/auth` — mutual HMAC over WebCrypto. One canonicaliser for both ends.
- `src/transport`, `src/endpoint`, `src/relay` — browser-safe too.
- `src/relay/node` — the only place `node:*` and `ws` may appear.
- `src/testing` — published conformance suites (repo-core rule: vitest comes
  from the consumer; never imported by runtime code).
- `tests/unit`, `tests/integration` (real sockets, port 0), `tests/support`.

## Rules
- Tools are never defined here. The relay forwards JSON-RPC; it is not a registry.
- Every security frame is strict (size cap, duplicate keys, exact keys).
- Wire changes are additive (`capabilities.ops`); a breaking change bumps
  `mcp-bridge.v1` → `v2` and both sides refuse the other.
- No legacy/plaintext auth mode. Ever.
- Delivery: never re-run a request the endpoint acked; answer "outcome unknown".
- stdout belongs to MCP in the stdio shim — log to stderr.

## Checks
`npm run check && npm run check:peers && npm run typecheck && npm run build && npm test`

After a build, browser subpaths (`protocol`, `auth`, `transport`, `endpoint`,
`relay`) must import nothing from `node:` or `ws` — see the walk in CHANGELOG 0.1.0.

TypeScript is pinned to 7.1 (with `overrides`, as arc-ai) — 7.0 lacks the API
tsdown's dts plugin needs.
