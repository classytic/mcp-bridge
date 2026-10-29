/**
 * Install / remove the native messaging host for a server, for every
 * Chromium-family browser on this machine:
 *   - a launcher (`.cmd` on Windows, `sh` elsewhere) that runs this CLI's
 *     `native-host` command with the server name baked in;
 *   - the host manifest (`allowed_origins` = the extension origins);
 *   - Windows: a per-user registry key per browser pointing at the manifest;
 *     macOS / Linux: the manifest copied into each browser's
 *     `NativeMessagingHosts` folder.
 * Per-user only — nothing needs admin rights.
 */

import { execFile } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { nativeHostName } from "../../native/protocol.js";
import { configDir } from "./config.js";

const run = promisify(execFile);

/** Registry keys (under HKCU) per browser on Windows. */
const WINDOWS_KEYS = [
  "Software\\Google\\Chrome\\NativeMessagingHosts",
  "Software\\Google\\Chrome for Testing\\NativeMessagingHosts",
  "Software\\Chromium\\NativeMessagingHosts",
  "Software\\Microsoft\\Edge\\NativeMessagingHosts",
  "Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
];

/** `NativeMessagingHosts` folders per browser on macOS / Linux. */
export function manifestDirs(platform = process.platform, home = homedir()): string[] {
  if (platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    return [
      "Google/Chrome",
      "Google/Chrome for Testing",
      "Chromium",
      "Microsoft Edge",
      "BraveSoftware/Brave-Browser",
    ].map((b) => join(base, b, "NativeMessagingHosts"));
  }
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [
    "google-chrome",
    "google-chrome-for-testing",
    "chromium",
    "microsoft-edge",
    "BraveSoftware/Brave-Browser",
  ].map((b) => join(config, b, "NativeMessagingHosts"));
}

/** Writes and deletes registry values — injectable so tests never touch the real registry. */
export interface Registry {
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const windowsRegistry: Registry = {
  async set(key, value) {
    await run("reg", ["add", `HKCU\\${key}`, "/ve", "/t", "REG_SZ", "/d", value, "/f"], {
      windowsHide: true,
    });
  },
  async remove(key) {
    await run("reg", ["delete", `HKCU\\${key}`, "/f"], { windowsHide: true }).catch(() => {});
  },
};

export interface NativeInstallOptions {
  serverName: string;
  /** Extension origins allowed to launch the host (`chrome-extension://<id>`). */
  origins: readonly string[];
  /** The command that runs this CLI — default: this Node and the running script. */
  command?: { node: string; script: string; args?: readonly string[] };
  /** Override the host name (default `com.classytic.mcp_bridge.<server>`). */
  hostName?: string;
  platform?: NodeJS.Platform;
  home?: string;
  registry?: Registry;
}

export interface NativeInstallResult {
  hostName: string;
  launcher: string;
  manifests: string[];
  registryKeys: string[];
}

const toAllowedOrigin = (o: string) => `${o.replace(/\/+$/, "")}/`;

export async function installNativeHost(o: NativeInstallOptions): Promise<NativeInstallResult> {
  if (o.origins.length === 0) throw new Error("Give at least one --origin chrome-extension://<id>");
  for (const origin of o.origins) {
    if (!/^chrome-extension:\/\/[a-p]{32}\/?$/.test(origin))
      throw new Error(`Not an extension origin: ${origin}`);
  }
  const platform = o.platform ?? process.platform;
  const hostName = o.hostName ?? nativeHostName(o.serverName);
  const dir = join(configDir(), "native");
  await mkdir(dir, { recursive: true });

  const node = o.command?.node ?? process.execPath;
  const script = o.command?.script ?? (process.argv[1] as string);
  const args = [
    ...(o.command?.args ?? []),
    "native-host",
    "--server",
    o.serverName,
    ...o.origins.flatMap((origin) => ["--expected-origin", origin.replace(/\/+$/, "")]),
  ];
  const quoted = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  let launcher: string;
  if (platform === "win32") {
    launcher = join(dir, `${hostName}.cmd`);
    await writeFile(
      launcher,
      `@echo off\r\n${[node, script, ...args].map(quoted).join(" ")} %*\r\n`,
    );
  } else {
    launcher = join(dir, `${hostName}.sh`);
    await writeFile(
      launcher,
      `#!/bin/sh\nexec ${[node, script, ...args].map(quoted).join(" ")} "$@"\n`,
    );
    await chmod(launcher, 0o755);
  }

  const manifest = `${JSON.stringify(
    {
      name: hostName,
      description: `MCP bridge pairing for ${o.serverName}`,
      path: launcher,
      type: "stdio",
      allowed_origins: o.origins.map(toAllowedOrigin),
    },
    null,
    2,
  )}\n`;

  const manifests: string[] = [];
  const registryKeys: string[] = [];
  if (platform === "win32") {
    const path = join(dir, `${hostName}.json`);
    await writeFile(path, manifest);
    manifests.push(path);
    const registry = o.registry ?? windowsRegistry;
    for (const base of WINDOWS_KEYS) {
      const key = `${base}\\${hostName}`;
      await registry.set(key, path);
      registryKeys.push(key);
    }
  } else {
    for (const d of manifestDirs(platform, o.home)) {
      await mkdir(d, { recursive: true });
      const path = join(d, `${hostName}.json`);
      await writeFile(path, manifest);
      manifests.push(path);
    }
  }
  return { hostName, launcher, manifests, registryKeys };
}

export async function uninstallNativeHost(
  o: Pick<NativeInstallOptions, "serverName" | "hostName" | "platform" | "home" | "registry">,
): Promise<void> {
  const platform = o.platform ?? process.platform;
  const hostName = o.hostName ?? nativeHostName(o.serverName);
  const dir = join(configDir(), "native");
  await rm(join(dir, `${hostName}.cmd`), { force: true });
  await rm(join(dir, `${hostName}.sh`), { force: true });
  if (platform === "win32") {
    await rm(join(dir, `${hostName}.json`), { force: true });
    const registry = o.registry ?? windowsRegistry;
    for (const base of WINDOWS_KEYS) await registry.remove(`${base}\\${hostName}`);
  } else {
    for (const d of manifestDirs(platform, o.home))
      await rm(join(d, `${hostName}.json`), { force: true });
  }
}
