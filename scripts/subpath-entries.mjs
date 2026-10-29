/**
 * subpath-entries — the ONE mapping from package.json `exports` to source
 * files. Consumed by `tsdown.config.ts` (build entries) and
 * `scripts/check-peer-bundle-parity.mjs` (exports ↔ entries parity), so a
 * subpath is declared exactly once: in package.json.
 *
 * Resolution for an export `./x`:
 *   1. `SOURCE_ALIASES[x]` when present (stores whose files carry a
 *      longer name than their subpath),
 *   2. else `src/x/index.ts` when it exists (a module),
 *   3. else `src/x.ts` (a single-file subpath).
 *   `.` resolves to `src/index.ts`.
 *
 * The tsdown entry key is the source path minus `src/` and `.ts`, so the
 * emitted file is `dist/<key>.mjs` — every export must point there.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Subpaths whose source file name differs from the subpath. */
export const SOURCE_ALIASES = {};

/**
 * Resolve one export subpath (`.`, `./agent`, …) to its source file,
 * relative to `root`. Returns `null` when no source file exists.
 */
export function sourceForSubpath(root, subpath) {
  if (subpath === ".") return existsSync(resolve(root, "src/index.ts")) ? "src/index.ts" : null;
  const bare = subpath.replace(/^\.\//, "");
  const candidates = [
    SOURCE_ALIASES[bare],
    `src/${bare}/index.ts`,
    `src/${bare}.ts`,
  ].filter(Boolean);
  for (const rel of candidates) {
    if (existsSync(resolve(root, rel))) return rel;
  }
  return null;
}

/**
 * Derive tsdown entries from `<root>/package.json` exports.
 *
 * @returns {{ entries: Record<string, string>, problems: string[] }}
 *   `entries` maps entry key → source path; `problems` lists every export
 *   that has no source file, points at a dist path other than the one
 *   tsdown emits for its source, or shares a source with another export.
 */
export function deriveEntries(root) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const entries = {};
  const problems = [];
  const owner = new Map();

  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (subpath === "./package.json") continue;
    const source = sourceForSubpath(root, subpath);
    if (!source) {
      problems.push(`${subpath}: no source file (tried alias, src/<x>/index.ts, src/<x>.ts)`);
      continue;
    }
    if (owner.has(source)) {
      problems.push(`${subpath}: same source as ${owner.get(source)} (${source})`);
      continue;
    }
    owner.set(source, subpath);

    const key = source.replace(/^src\//, "").replace(/\.ts$/, "");
    entries[key] = source;

    const expected = { import: `./dist/${key}.mjs`, types: `./dist/${key}.d.mts` };
    if (typeof target !== "object" || target === null) {
      problems.push(`${subpath}: expected { import, types }, got ${JSON.stringify(target)}`);
      continue;
    }
    for (const cond of ["import", "types"]) {
      if (target[cond] !== expected[cond]) {
        problems.push(
          `${subpath}: "${cond}" is ${JSON.stringify(target[cond])}, tsdown emits ${expected[cond]}`,
        );
      }
    }
  }

  return { entries, problems };
}
