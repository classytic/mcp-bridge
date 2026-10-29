#!/usr/bin/env node
/**
 * check-peer-bundle-parity — CI-runnable guard.
 *
 * Pins the rule from `tsdown.config.ts`:
 *
 *   "Every peer dep listed in package.json MUST appear in
 *    tsdown.config.ts neverBundle."
 *
 * If a future PR adds a new peer dep but forgets to mark it neverBundle,
 * this script fails with a clear list.
 *
 * Second check — exports ↔ entries parity. tsdown derives its entries
 * from package.json `exports` (scripts/subpath-entries.mjs), so every
 * export must resolve to a source file AND point at the dist path tsdown
 * emits for it (`./dist/<key>.mjs` / `.d.mts`). A typo'd or stale export
 * fails here instead of shipping a 404 subpath.
 *
 * Usage:
 *   node scripts/check-peer-bundle-parity.mjs        # exits 1 on failure
 *   pnpm check:peers                                  # via npm script
 *
 * Wire as a `pretest` or `prebuild` script if you want it gated by CI.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { deriveEntries } from "./subpath-entries.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const tsdownSrc = readFileSync(resolve(root, "tsdown.config.ts"), "utf8");

const peers = Object.keys(pkg.peerDependencies ?? {});
const optional = new Set(Object.keys(pkg.peerDependenciesMeta ?? {}));

// Strings: literal entry in the array.
// Regex: e.g. /^@ai-sdk\//  → catches @ai-sdk/anthropic etc.
const literalEntries = new Set();
const regexEntries = [];

// Match `"foo"` literal entries inside the neverBundle array.
const literalMatches = tsdownSrc.matchAll(/"([^"]+)"/g);
for (const m of literalMatches) literalEntries.add(m[1]);

// Match `/<pattern>/` regex entries.
const regexMatches = tsdownSrc.matchAll(/\/\^([^/]+)\\\//g);
for (const m of regexMatches) regexEntries.push(new RegExp(`^${m[1]}/`));

const isCovered = (peer) => {
  if (literalEntries.has(peer)) return "literal";
  for (const re of regexEntries) {
    if (re.test(peer)) return `regex ${re.source}`;
  }
  return null;
};

let ok = true;
const rows = [];
for (const peer of peers.sort()) {
  const coverage = isCovered(peer);
  const optMark = optional.has(peer) ? "○ optional" : "● required";
  const sym = coverage ? "✓" : "✗";
  rows.push(`${sym}  ${optMark}  ${peer}${coverage ? `  (${coverage})` : ""}`);
  if (!coverage) ok = false;
}

console.log("\npeer ↔ neverBundle parity check");
console.log("─".repeat(60));
for (const row of rows) console.log(row);
console.log("─".repeat(60));

if (ok) {
  console.log(`✓ all ${peers.length} peers present in neverBundle\n`);
} else {
  const missing = peers.filter((p) => !isCovered(p));
  console.error(
    `\n✗ ${missing.length} peer dep(s) NOT in tsdown.config.ts neverBundle:`,
  );
  for (const p of missing) console.error(`    ${p}`);
  console.error(
    "\nFix: add each missing entry to the `neverBundle` array in tsdown.config.ts.",
  );
  console.error(
    "Rule: any peer dep MUST also appear in neverBundle so it isn't bundled.\n",
  );
}

// ── exports ↔ entries parity ──
const { entries, problems } = deriveEntries(root);
const exportCount = Object.keys(pkg.exports ?? {}).filter((k) => k !== "./package.json").length;

console.log("exports ↔ entries parity check");
console.log("─".repeat(60));
if (problems.length === 0) {
  console.log(
    `✓ all ${exportCount} exports resolve to a source file (${Object.keys(entries).length} entries)\n`,
  );
} else {
  ok = false;
  console.error(`✗ ${problems.length} export problem(s):`);
  for (const p of problems) console.error(`    ${p}`);
  console.error(
    "\nFix: point the export at an existing src/<x>/index.ts or src/<x>.ts (or add a",
  );
  console.error("SOURCE_ALIASES entry in scripts/subpath-entries.mjs), with dist paths");
  console.error("./dist/<key>.mjs + ./dist/<key>.d.mts where <key> is the source path.\n");
}

process.exit(ok ? 0 : 1);
