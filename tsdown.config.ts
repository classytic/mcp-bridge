import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";
import { deriveEntries } from "./scripts/subpath-entries.mjs";

// ──────────────────────────────────────────────────────────────
// Entries are DERIVED from package.json `exports` (one subpath per
// module, src/<x>/index.ts or src/<x>.ts) — the arc-ai convention.
// The `mcp-relay` bin is the one entry that isn't an export.
// `npm run check:peers` fails when an export has no source file or a
// peer is missing from `neverBundle`.
// ──────────────────────────────────────────────────────────────
const root = fileURLToPath(new URL(".", import.meta.url));
const { entries, problems } = deriveEntries(root);
if (problems.length > 0) {
  throw new Error(`package.json exports ↔ tsdown entries mismatch:\n  ${problems.join("\n  ")}`);
}

export default defineConfig({
  entry: { ...entries, "bin/mcp-relay": "src/bin/mcp-relay.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: false,
  clean: true,

  treeshake: true,
  // Browser endpoints and Node relays share most subpaths; es2022 runs in
  // both (MV3 Chrome 116+, Node 22).
  target: "es2022",
  platform: "neutral",
  fixedExtension: true,
  outDir: "dist",

  publint: "ci-only",
  attw: "ci-only",
  failOnWarn: "ci-only",
  deps: {
    // Zero runtime `dependencies` — every import from node_modules is a
    // peer, never inlined.
    skipNodeModulesBundle: true,
    neverBundle: [
      /^@classytic\//,
      /^@modelcontextprotocol\//,
      "ws",
      /^node:/,
      // Dev-only — never reachable from src/ outside ./testing.
      "vitest",
    ],
  },
});
