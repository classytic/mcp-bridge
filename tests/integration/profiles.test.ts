// The same extension in two browser profiles (two endpoints, one server name):
// they must coexist, pinned clients must reach only their profile, an unpinned
// client must choose explicitly, and a bound session must never drift to the
// other profile when its own goes away.

import { Client } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { generateSecret } from "../../src/auth/index.js";
import { connectEndpoint, type EndpointHandle } from "../../src/endpoint/index.js";
import { bridgeUrl } from "../../src/protocol/index.js";
import { type Daemon, runStdioShim } from "../../src/relay/node/index.js";
import { waitFor } from "../../src/testing/index.js";
import {
  httpClientTransport,
  startTestDaemon,
  streamClientTransport,
  wsDial,
} from "../support/node-harness.js";

const ORIGIN = "chrome-extension://test";

/** A server whose `whoami` names the profile it runs in. */
const profileServer = (label: string) => () => {
  const s = new McpServer({ name: "ext", version: "1" });
  s.registerTool(
    "whoami",
    {
      description: "Which profile answers",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: "text", text: label }] }),
  );
  return s;
};
const text = (r: { content: unknown }) => (r.content as Array<{ text: string }>)[0]?.text;

describe("several browser profiles", () => {
  let daemon: Daemon | undefined;
  const endpoints: EndpointHandle[] = [];
  let secret = "";

  afterEach(async () => {
    for (const e of endpoints.splice(0)) await e.close();
    await daemon?.close();
  });

  async function twoProfiles() {
    secret = generateSecret();
    daemon = await startTestDaemon({
      serverName: "x",
      secret,
      allowedOrigins: [ORIGIN],
      relay: { waitForEndpointMs: 150 },
    });
    const port = daemon.port;
    const profile = (id: string, label: string) => {
      const ep = connectEndpoint({
        serverName: "x",
        url: bridgeUrl(port, "x"),
        secret,
        endpoint: { id, label },
        createSocket: (url, p) => wsDial(url, ORIGIN, p),
        createServer: profileServer(label),
        backoff: { baseMs: 20, capMs: 100 },
      });
      endpoints.push(ep);
      return ep;
    };
    const acme = profile("profile-acme-0001", "Acme");
    const globex = profile("profile-globex-002", "Globex");
    await waitFor(
      () => acme.status().state === "connected" && globex.status().state === "connected",
    );
    return { port, acme, globex };
  }

  it("coexist: neither profile knocks the other off", async () => {
    const { acme, globex } = await twoProfiles();
    await new Promise((r) => setTimeout(r, 400));
    expect(acme.status().state).toBe("connected");
    expect(globex.status().state).toBe("connected");
    expect(
      daemon?.relay
        .status()
        .endpoints.map((e) => e.label)
        .sort(),
    ).toEqual(["Acme", "Globex"]);
  });

  it("a pinned client reaches only its profile — by label over HTTP, by id over stdio", async () => {
    const { port } = await twoProfiles();
    const http = new Client({ name: "pinned", version: "1" });
    await http.connect(await httpClientTransport(port, secret, "globex"));
    expect(text(await http.callTool({ name: "whoami", arguments: {} }))).toBe("Globex");
    expect((await http.listTools()).tools.map((t) => t.name)).toEqual(["whoami"]); // no switch tools when pinned

    const { transport, stdin, stdout } = streamClientTransport();
    await runStdioShim({
      serverName: "x",
      secret,
      port,
      stdin,
      stdout,
      endpoint: "profile-acme-0001",
      spawnDaemon: () => {},
    });
    const stdio = new Client({ name: "pinned-stdio", version: "1" });
    await stdio.connect(transport);
    expect(text(await stdio.callTool({ name: "whoami", arguments: {} }))).toBe("Acme");
    await Promise.all([http.close(), stdio.close()]);
  });

  it("an unpinned client must choose, then can switch", async () => {
    const { port } = await twoProfiles();
    const { transport, stdin, stdout } = streamClientTransport();
    await runStdioShim({ serverName: "x", secret, port, stdin, stdout, spawnDaemon: () => {} });
    const c = new Client({ name: "ops", version: "1" });
    let changed = 0;
    c.setNotificationHandler("notifications/tools/list_changed", async () => {
      changed++;
    });
    await c.connect(transport);

    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "bridge_listEndpoints",
      "bridge_useEndpoint",
    ]);
    const blocked = await c.callTool({ name: "whoami", arguments: {} }).catch((e: Error) => e);
    expect(String(blocked)).toMatch(/Several browser profiles/);

    const listed = JSON.parse(
      text(await c.callTool({ name: "bridge_listEndpoints", arguments: {} })) as string,
    );
    expect(listed.endpoints.map((e: { label: string }) => e.label).sort()).toEqual([
      "Acme",
      "Globex",
    ]);

    await c.callTool({ name: "bridge_useEndpoint", arguments: { endpoint: "Acme" } });
    await waitFor(() => changed > 0);
    expect(text(await c.callTool({ name: "whoami", arguments: {} }))).toBe("Acme");
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("bridge_useEndpoint"); // can still switch

    await c.callTool({ name: "bridge_useEndpoint", arguments: { endpoint: "globex" } });
    expect(text(await c.callTool({ name: "whoami", arguments: {} }))).toBe("Globex");
    await c.close();
  });

  it("a bound session waits for its own profile and never drifts to the other", async () => {
    const { port, acme } = await twoProfiles();
    const c = new Client({ name: "pinned", version: "1" });
    await c.connect(await httpClientTransport(port, secret, "Acme"));
    expect(text(await c.callTool({ name: "whoami", arguments: {} }))).toBe("Acme");

    await acme.close();
    endpoints.splice(endpoints.indexOf(acme), 1);
    const offline = await c.callTool({ name: "whoami", arguments: {} }).catch((e: Error) => e);
    expect(String(offline)).toMatch(/"Acme" is not connected/);
    await c.close();
  });
});
