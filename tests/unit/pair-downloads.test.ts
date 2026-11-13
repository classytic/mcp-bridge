// A fresh pairing gets a downloads folder, so files a tool hands back are saved, not dropped.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultDownloadsDir, loadConfig, pair, saveConfig } from "../../src/relay/node/config.js";

let saved: string | undefined;
beforeEach(async () => {
  saved = process.env.MCP_BRIDGE_CONFIG_DIR;
  process.env.MCP_BRIDGE_CONFIG_DIR = await mkdtemp(join(tmpdir(), "relay-pair-"));
});
afterEach(() => {
  if (saved === undefined) delete process.env.MCP_BRIDGE_CONFIG_DIR;
  else process.env.MCP_BRIDGE_CONFIG_DIR = saved;
});

describe("pair — downloads folder", () => {
  it("defaults to the user's Downloads folder", async () => {
    await pair("app");
    expect((await loadConfig("app")).downloadsDir).toBe(defaultDownloadsDir());
  });

  it("--downloads wins, and a folder already configured is kept on re-pair", async () => {
    await pair("app", { downloadsDir: "/x/out" });
    expect((await loadConfig("app")).downloadsDir).toBe("/x/out");
    await pair("app");
    expect((await loadConfig("app")).downloadsDir).toBe("/x/out");
    await saveConfig("other", { allowedOrigins: ["chrome-extension://abc"] });
    await pair("other");
    expect(await loadConfig("other")).toMatchObject({
      allowedOrigins: ["chrome-extension://abc"],
      downloadsDir: defaultDownloadsDir(),
    });
  });
});
