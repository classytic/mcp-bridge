import { defineConfig } from "vitest/config";

/**
 * Two projects mirror tests/:
 *
 *   unit/         — pure functions: frames, guards, file rewriting, relay core
 *                   over in-memory sockets. No network. 10s timeout.
 *   integration/  — real sockets on 127.0.0.1 (arc's rule: exercise the
 *                   transport that ships, not an in-process shortcut): a real
 *                   MCP Client → relay → `ws` → endpoint → McpServer, plus the
 *                   conformance suite run against this package itself.
 */
export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], testTimeout: 10_000 },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
