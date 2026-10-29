/**
 * `@classytic/mcp-bridge/relay/node` — the Node adapter for the relay core:
 * the daemon (`ws` + Streamable HTTP `/mcp` on 127.0.0.1), the stdio shim,
 * attach-or-spawn, pairing config, `fs` files, and the CLI. Needs the optional
 * peer `ws`.
 */

export {
  type DaemonHealth,
  type DaemonProbe,
  ensureDaemon,
  probeDaemon,
  spawnDetached,
} from "./attach.js";
export { type RelayCliOptions, runRelayCli, stderrLogger } from "./cli.js";
export {
  configDir,
  configPath,
  DEFAULT_PORT,
  loadConfig,
  pair,
  type RelayConfig,
  requireSecret,
  saveConfig,
} from "./config.js";
export { type Daemon, type DaemonOptions, type DaemonStart, startDaemon } from "./daemon.js";
export { mediaTypeOf, nodeFiles } from "./files.js";
export { createHttpMcp, hasBearer, MCP_PATH } from "./http-mcp.js";
export {
  encodeNativeFrame,
  type NativeHostOptions,
  readNativeFrame,
  runNativeHost,
} from "./native-host.js";
export {
  installNativeHost,
  manifestDirs,
  type NativeInstallOptions,
  type NativeInstallResult,
  type Registry,
  uninstallNativeHost,
  windowsRegistry,
} from "./native-install.js";
export { runStdioShim, type StdioShimOptions } from "./stdio-shim.js";
