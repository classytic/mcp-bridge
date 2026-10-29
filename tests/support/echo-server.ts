/** A tiny MCP server for tests: `echo` (read-only) and `upload` (takes a file argument). */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FILE_SCHEMA_MARKER, FILE_SCHEMA_MARKER_VALUE } from "../../src/protocol/index.js";

export const fileArg = z
  .object({ name: z.string(), mediaType: z.string(), size: z.number(), base64: z.string() })
  .meta({ [FILE_SCHEMA_MARKER]: FILE_SCHEMA_MARKER_VALUE });

export function makeEchoServer(): McpServer {
  const server = new McpServer({ name: "echo", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Repeat the text back",
      inputSchema: z.object({ text: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  server.registerTool(
    "upload",
    {
      description: "Report the uploaded file's name and size",
      inputSchema: z.object({ file: fileArg }),
      annotations: { destructiveHint: false, readOnlyHint: false },
    },
    async ({ file }) => ({ content: [{ type: "text", text: `${file.name}:${file.size}` }] }),
  );
  return server;
}
