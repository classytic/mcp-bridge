#!/usr/bin/env node
/** `mcp-relay` — the generic relay CLI. Products ship their own bin over `runRelayCli`. */

import { runRelayCli } from "../relay/node/index.js";

runRelayCli().catch((e: unknown) => {
  process.stderr.write(`mcp-relay: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
