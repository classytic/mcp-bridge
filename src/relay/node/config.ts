/**
 * Per-server relay config in the user's config folder — the pairing secret
 * (file mode 0600) plus allowed origins, port and file folders. One file per
 * server: `<config>/classytic-mcp/<server>.json`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateSecret, isSecret } from "../../auth/index.js";

export const DEFAULT_PORT = 17345;

export interface RelayConfig {
  secret?: string;
  allowedOrigins?: string[];
  port?: number;
  fileRoots?: string[];
  downloadsDir?: string;
}

/** `$MCP_BRIDGE_CONFIG_DIR`, else `%APPDATA%\classytic-mcp` / `$XDG_CONFIG_HOME/classytic-mcp`. */
export function configDir(): string {
  if (process.env.MCP_BRIDGE_CONFIG_DIR) return process.env.MCP_BRIDGE_CONFIG_DIR;
  if (process.platform === "win32")
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "classytic-mcp");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "classytic-mcp");
}

export const configPath = (serverName: string): string =>
  join(configDir(), `${serverName.replace(/[^\w.-]/g, "_")}.json`);

export async function loadConfig(serverName: string): Promise<RelayConfig> {
  try {
    return JSON.parse(await readFile(configPath(serverName), "utf8")) as RelayConfig;
  } catch {
    return {};
  }
}

export async function saveConfig(serverName: string, config: RelayConfig): Promise<string> {
  await mkdir(configDir(), { recursive: true });
  const path = configPath(serverName);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/** Make a new pairing secret for `serverName` (keeping the rest of its config) and save it. */
/** Where saved files go when pairing names no folder: the user's Downloads folder. */
export const defaultDownloadsDir = (): string => join(homedir(), "Downloads");

export async function pair(
  serverName: string,
  patch: Omit<RelayConfig, "secret"> = {},
): Promise<{ secret: string; path: string }> {
  const secret = generateSecret();
  const current = await loadConfig(serverName);
  // Without a downloads folder every file a tool hands back is dropped ("this relay
  // has no downloads folder"), so a fresh pairing gets one; a folder already
  // configured, or one passed with --downloads, wins.
  const downloadsDir = patch.downloadsDir ?? current.downloadsDir ?? defaultDownloadsDir();
  const path = await saveConfig(serverName, { ...current, ...patch, downloadsDir, secret });
  return { secret, path };
}

/** The config's secret, or a clear error telling the user how to pair. */
export function requireSecret(serverName: string, config: RelayConfig): string {
  if (isSecret(config.secret)) return config.secret;
  throw new Error(
    `"${serverName}" is not paired. Run: mcp-relay pair-code --server ${serverName} (a desktop app or device), ` +
      `or mcp-relay pair --server ${serverName} --origin chrome-extension://<id> (a browser extension)`,
  );
}
