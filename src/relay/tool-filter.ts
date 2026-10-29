/**
 * Tool profiles: which of an endpoint's tools one client session sees.
 *
 * A server with many tools costs every client their schemas on every session.
 * A client that only needs some asks for them — `--tools "@payroll,getOrganisation"`
 * (stdio) or `/mcp?tools=@payroll,getOrganisation` (HTTP) — and the relay lists
 * only those and refuses calls to the rest. The relay's own tools (`bridge_*`)
 * are always available.
 *
 * Patterns, comma-separated, `*` matching any run of characters:
 *   `name`    a tool name (`payroll*`)
 *   `@group`  every tool in that group — read from the listed tool's
 *             `_meta["classytic.io/group"]` (string or array; arc-ai's
 *             `serveAsMcp` sets it from each tool's `group` annotation)
 */

/** Where a listed tool carries its group(s). */
export const TOOL_GROUP_META = "classytic.io/group";

/** Whether a tool (by name, and its groups when known) is in the profile. */
export type ToolFilter = (name: string, groups?: readonly string[]) => boolean;

const MAX_PATTERNS = 64;

/** Split a `--tools` / `?tools=` value into patterns. */
export function parseToolPatterns(value: string | undefined | null): string[] | undefined {
  if (!value) return undefined;
  const patterns = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (patterns.length > MAX_PATTERNS) throw new Error(`At most ${MAX_PATTERNS} tool patterns.`);
  return patterns.length ? patterns : undefined;
}

const literal = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const glob = (p: string) => new RegExp(`^${p.split("*").map(literal).join(".*")}$`);

/** A filter for these patterns; everything passes when there are none. */
export function toolFilter(patterns: readonly string[] | undefined): ToolFilter | undefined {
  if (!patterns?.length) return undefined;
  const names = patterns.filter((p) => !p.startsWith("@")).map(glob);
  const groups = patterns.filter((p) => p.startsWith("@")).map((p) => glob(p.slice(1)));
  return (name, toolGroups = []) =>
    name.startsWith("bridge_") ||
    names.some((r) => r.test(name)) ||
    groups.some((r) => toolGroups.some((g) => r.test(g)));
}

/** A listed tool's groups (`_meta["classytic.io/group"]`). */
export function toolGroupsOf(tool: unknown): string[] {
  const meta = (tool as { _meta?: Record<string, unknown> } | null)?._meta;
  const g = meta?.[TOOL_GROUP_META];
  if (typeof g === "string") return [g];
  return Array.isArray(g) ? g.filter((x): x is string => typeof x === "string") : [];
}
