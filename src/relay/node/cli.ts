/**
 * The relay CLI, shared by the generic `mcp-relay` bin and product bins. A
 * product bin is one call with its server name and extension id baked in:
 *
 *   #!/usr/bin/env node
 *   import { runRelayCli } from '@classytic/mcp-bridge/relay/node';
 *   await runRelayCli({ serverName: 'xero', allowedOrigins: ['chrome-extension://<id>'] });
 *
 * Commands:
 *   pair    [--origin <o>]... [--file-root <dir>]... [--downloads <dir>] [--port <n>]
 *           make the pairing secret; print it and the client setup lines
 *   stdio   run the stdio shim (what an MCP client launches); starts the daemon if needed
 *   daemon  run the relay daemon in the foreground
 *   status  is the daemon running, is the extension connected
 *   stop    stop the daemon
 *   install-native   --origin <o>...   install the native messaging host (pairing without copy-paste)
 *   uninstall-native                   remove it
 *   native-host      (what Chrome launches; not for people)
 */

import { clientTokenOf } from "../../auth/index.js";
import type { RelayLogger } from "../relay.js";
import { parseToolPatterns } from "../tool-filter.js";
import { ensureDaemon, probeDaemon, spawnDetached } from "./attach.js";
import { configPath, DEFAULT_PORT, loadConfig, pair, requireSecret, saveConfig } from "./config.js";
import { startDaemon } from "./daemon.js";
import { nodeFiles } from "./files.js";
import { runNativeHost } from "./native-host.js";
import { installNativeHost, uninstallNativeHost } from "./native-install.js";
import { runStdioShim } from "./stdio-shim.js";

export interface RelayCliOptions {
  /** Fixed by a product bin; otherwise `--server <name>` is required. */
  serverName?: string;
  /** Fixed by a product bin; merged with `--origin` and the config's origins. */
  allowedOrigins?: readonly string[];
  /** The package to name in printed setup lines (`npx -y <package> stdio`). */
  packageName?: string;
  /** Protocol eras the daemon answers offline — `["modern"]` for a 2026-only endpoint. */
  offlineEras?: readonly ("legacy" | "modern")[];
  argv?: readonly string[];
}

/** Logger that writes to stderr — stdout belongs to MCP in `stdio` mode. */
export const stderrLogger = (name: string): RelayLogger => ({
  info: (m, d) => process.stderr.write(`[${name}] ${m}${d ? ` ${JSON.stringify(d)}` : ""}\n`),
  warn: (m, d) => process.stderr.write(`[${name}] WARN ${m}${d ? ` ${JSON.stringify(d)}` : ""}\n`),
});

interface Args {
  command: string;
  server?: string;
  origins: string[];
  roots: string[];
  downloads?: string;
  port?: number;
  endpoint?: string;
  tools?: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = {
    command: argv[0] && !argv[0].startsWith("-") ? argv[0] : "help",
    origins: [],
    roots: [],
  };
  for (let i = a.command === "help" ? 0 : 1; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--server") a.server = value();
    else if (flag === "--origin") a.origins.push(value());
    else if (flag === "--file-root") a.roots.push(value());
    else if (flag === "--downloads") a.downloads = value();
    else if (flag === "--endpoint") a.endpoint = value();
    else if (flag === "--tools") a.tools = parseToolPatterns(value());
    else if (flag === "--port") {
      const port = Number(value());
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
        throw new Error(`invalid --port`);
      a.port = port;
    } else if (flag === "--help" || flag === "-h") a.command = "help";
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return a;
}

const HELP = `mcp-relay — expose an extension's MCP server to MCP clients

  pair    --server <name> [--origin chrome-extension://<id>]... [--file-root <dir>]... [--downloads <dir>] [--port <n>]
  stdio   --server <name> [--endpoint <profile label or id>] [--tools <name,pattern*,…>]   (what an MCP client launches)
  daemon  --server <name>     (foreground)
  status  --server <name>
  stop    --server <name>
  install-native    --server <name> --origin chrome-extension://<id>...
  uninstall-native  --server <name>
`;

/** Chrome launches the host with the caller origin (and on Windows `--parent-window=…`). */
async function nativeHostCommand(opts: RelayCliOptions, argv: readonly string[]): Promise<void> {
  let server = opts.serverName;
  const expected: string[] = [...(opts.allowedOrigins ?? [])];
  let caller: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--server") server = argv[++i];
    else if (a === "--expected-origin") expected.push(argv[++i] as string);
    else if (a.startsWith("chrome-extension://")) caller ??= a;
  }
  if (!server) throw new Error("native-host needs --server");
  const serverName = server;
  const port = (await loadConfig(serverName)).port ?? DEFAULT_PORT;
  const script = process.argv[1] as string;
  await runNativeHost({
    serverName,
    expectedOrigins: expected,
    callerOrigin: caller,
    port,
    async pairing(origin) {
      const config = await loadConfig(serverName);
      const allowed = [...new Set([...(config.allowedOrigins ?? []), origin])];
      if (config.secret) {
        if (allowed.length !== (config.allowedOrigins ?? []).length) {
          await saveConfig(serverName, { ...config, allowedOrigins: allowed });
        }
        return config.secret;
      }
      return (await pair(serverName, { allowedOrigins: allowed })).secret;
    },
    async ensureRelay() {
      const config = await loadConfig(serverName);
      const clientToken = await clientTokenOf(requireSecret(serverName, config));
      const probe = await probeDaemon({ host: "127.0.0.1", port, serverName, clientToken });
      if (probe.state === "ready") return "running";
      const daemonArgs = [script, "daemon", ...(opts.serverName ? [] : ["--server", serverName])];
      await ensureDaemon({
        host: "127.0.0.1",
        port,
        serverName,
        clientToken,
        spawnDaemon: () => spawnDetached(process.execPath, daemonArgs),
      });
      return "spawned";
    },
  });
}

export async function runRelayCli(opts: RelayCliOptions = {}): Promise<void> {
  const argv = opts.argv ?? process.argv.slice(2);
  if (argv[0] === "native-host") return nativeHostCommand(opts, argv);
  const args = parseArgs(argv);
  const serverName = opts.serverName ?? args.server;
  if (args.command === "help" || !serverName) {
    process.stderr.write(HELP);
    if (args.command !== "help") process.exitCode = 2;
    return;
  }
  const logger = stderrLogger(`${serverName}-relay`);

  if (args.command === "pair") {
    const { secret, path } = await pair(serverName, {
      ...(args.origins.length ? { allowedOrigins: args.origins } : {}),
      ...(args.roots.length ? { fileRoots: args.roots } : {}),
      ...(args.downloads ? { downloadsDir: args.downloads } : {}),
      ...(args.port ? { port: args.port } : {}),
    });
    const port = args.port ?? (await loadConfig(serverName)).port ?? DEFAULT_PORT;
    const token = await clientTokenOf(secret);
    const pkg = opts.packageName ?? "@classytic/mcp-bridge";
    const launch = opts.serverName
      ? `npx -y ${pkg} stdio`
      : `npx -y -p ${pkg} mcp-relay stdio --server ${serverName}`;
    process.stderr.write(
      [
        `Paired "${serverName}" (config: ${path}).`,
        "",
        "Extension — paste the pairing secret printed on the last line.",
        "",
        "Claude Code (stdio, starts the relay itself):",
        `  claude mcp add ${serverName} -- ${launch}`,
        "Claude Code (HTTP, relay already running):",
        `  claude mcp add --transport http ${serverName} http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`,
        "",
      ].join("\n"),
    );
    process.stdout.write(`${secret}\n`);
    return;
  }

  if (args.command === "install-native") {
    const origins = [...new Set([...(opts.allowedOrigins ?? []), ...args.origins])];
    const r = await installNativeHost({
      serverName,
      origins,
      command: { node: process.execPath, script: process.argv[1] as string },
    });
    const lines = [
      `Installed native host ${r.hostName}`,
      `  launcher: ${r.launcher}`,
      ...r.manifests.map((m) => `  manifest: ${m}`),
      ...r.registryKeys.map((k) => `  registry: HKCU\\${k}`),
      'The extension needs the "nativeMessaging" permission.',
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  if (args.command === "uninstall-native") {
    await uninstallNativeHost({ serverName });
    process.stdout.write(`${serverName}: native host removed\n`);
    return;
  }

  const config = await loadConfig(serverName);
  // The relay side may run before anything paired (Claude Code launches `stdio`
  // first): make the secret then — native pairing hands the extension the same one.
  const secret =
    args.command === "stdio" || args.command === "daemon"
      ? (config.secret ?? (await pair(serverName)).secret)
      : requireSecret(serverName, config);
  const port = args.port ?? config.port ?? DEFAULT_PORT;
  const allowedOrigins = [
    ...new Set([...(opts.allowedOrigins ?? []), ...(config.allowedOrigins ?? []), ...args.origins]),
  ];

  if (args.command === "daemon") {
    const roots = config.fileRoots ?? [];
    const started = await startDaemon({
      ...(opts.offlineEras ? { relay: { offlineEras: opts.offlineEras } } : {}),
      serverName,
      secret,
      allowedOrigins,
      port,
      logger,
      ...(roots.length || config.downloadsDir
        ? { files: nodeFiles({ roots, downloadsDir: config.downloadsDir }) }
        : {}),
    });
    if (!started.ok) {
      if (started.reason === "port-in-use")
        return logger.info(`port ${port} is in use — a relay is probably running already`);
      throw started.error ?? new Error("relay failed to start");
    }
    const stop = () => void started.daemon.close();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    logger.info(`stopped: ${await started.daemon.done}`);
    return;
  }

  if (args.command === "stdio") {
    // Restart this same program as the daemon: works for `mcp-relay` and product bins alike.
    const script = process.argv[1] as string;
    const daemonArgs = [
      script,
      "daemon",
      ...(opts.serverName ? [] : ["--server", serverName]),
      "--port",
      String(port),
    ];
    const { done } = await runStdioShim({
      serverName,
      ...(args.endpoint ? { endpoint: args.endpoint } : {}),
      ...(args.tools ? { tools: args.tools } : {}),
      secret,
      port,
      logger,
      spawnDaemon: () => spawnDetached(process.execPath, daemonArgs),
    });
    await done;
    return;
  }

  if (args.command === "status") {
    const probe = await probeDaemon({
      host: "127.0.0.1",
      port,
      serverName,
      clientToken: await clientTokenOf(secret),
    });
    const line =
      probe.state === "ready"
        ? `running on ${port} · ${probe.health.sessions} session(s) · ${
            probe.health.endpoints?.length
              ? `connected: ${probe.health.endpoints.map((e) => `"${e.label}" (${e.id}, ${e.sessions} session(s))`).join(", ")}`
              : probe.health.endpoint
                ? "extension connected"
                : "no extension connected"
          }`
        : probe.state === "absent"
          ? `not running (port ${port})`
          : probe.state === "foreign"
            ? `port ${port} is held by something else`
            : `incompatible relay on ${port}: ${probe.reason}`;
    process.stdout.write(`${serverName}: ${line}\nconfig: ${configPath(serverName)}\n`);
    return;
  }

  if (args.command === "stop") {
    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${await clientTokenOf(secret)}` },
    }).catch(() => null);
    const line =
      res?.status === 202
        ? "stopping"
        : res
          ? `port ${port} did not accept the stop (${res.status}) — not our relay?`
          : `not running (port ${port})`;
    process.stdout.write(`${serverName}: ${line}\n`);
    return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}
