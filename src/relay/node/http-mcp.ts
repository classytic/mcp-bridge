/**
 * `/mcp` — MCP over Streamable HTTP for clients that speak it (Claude Code
 * `--transport http`, Gemini CLI `httpUrl`, Codex `url`). Each client session
 * gets the SDK's web-standard server transport, wired to a relay session; the
 * relay forwards to the endpoint. No `McpServer` here — tools live in the endpoint.
 *
 * Guarded by the client bearer token (derived from the pairing secret). Browser
 * requests (any `Origin`) are refused: no web page may call `/mcp`.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import {
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { safeEqual } from "../../internal/encoding.js";
import type { JsonRpcMessage } from "../../protocol/index.js";
import type { Relay, RelayLogger, RelaySession } from "../relay.js";
import { parseToolPatterns } from "../tool-filter.js";
import { serveModernRequest } from "./http-modern.js";

export const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 32 * 1024 * 1024;

interface Entry {
  transport: WebStandardStreamableHTTPServerTransport;
  session: RelaySession;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

/** True when the request carries `Authorization: Bearer <token>`. */
export function hasBearer(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") && safeEqual(header.slice(7), token);
}

async function readBody(req: IncomingMessage): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function toRequest(req: IncomingMessage, body: Uint8Array | undefined): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else if (v !== undefined) headers.set(k, v);
  }
  return new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? MCP_PATH}`, {
    method: req.method ?? "GET",
    headers,
    ...(body ? { body: body as BodyInit } : {}),
  });
}

async function writeResponse(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  const reader = response.body.getReader();
  req.on("close", () => void reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // client went away mid-stream
  }
  res.end();
}

export function createHttpMcp(opts: { relay: Relay; clientToken: string; logger: RelayLogger }) {
  const entries = new Map<string, Entry>();

  function newEntry(endpoint: string | undefined, tools: string[] | undefined): Entry {
    let entry: Entry;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => void entries.set(id, entry),
      onsessionclosed: (id) => {
        entries.delete(id);
        entry.session.close();
      },
    });
    const session = opts.relay.openSession(
      { send: (m) => void transport.send(m as JSONRPCMessage).catch(() => {}) },
      { ...(endpoint ? { endpoint } : {}), ...(tools ? { tools } : {}) },
    );
    transport.onmessage = (m) => void session.receive(m as unknown as JsonRpcMessage);
    transport.onclose = () => {
      if (transport.sessionId) entries.delete(transport.sessionId);
      session.close();
    };
    entry = { transport, session };
    return entry;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.origin !== undefined)
      return json(res, 403, { error: "Browser requests are not allowed" });
    if (!hasBearer(req, opts.clientToken))
      return json(res, 401, { error: "Missing or wrong bearer token" });

    let body: Uint8Array | undefined;
    if (req.method === "POST") {
      const read = await readBody(req);
      if (!read) return json(res, 413, { error: "Request too large" });
      body = read;
    }
    const request = toRequest(req, body);
    // `/mcp?endpoint=Acme` pins this client to one browser profile.
    const query = new URL(req.url ?? MCP_PATH, "http://127.0.0.1").searchParams;
    const pinned = query.get("endpoint") ?? undefined;
    // `/mcp?tools=payroll*,getOrganisation` — this client's tool profile.
    let tools: string[] | undefined;
    try {
      tools = parseToolPatterns(query.get("tools"));
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    const sessionId = req.headers["mcp-session-id"];
    if (req.method === "POST" && typeof sessionId !== "string") {
      let parsed: unknown;
      try {
        parsed = body?.length ? JSON.parse(new TextDecoder().decode(body)) : undefined;
      } catch {
        parsed = undefined;
      }
      // 2026-07-28 traffic is per-request; the SDK's classifier decides, as createMcpHandler does.
      if (parsed !== undefined && !(await isLegacyRequest(request, parsed))) {
        return serveModernRequest({
          relay: opts.relay,
          req,
          res,
          message: parsed,
          ...(pinned ? { endpoint: pinned } : {}),
          ...(tools ? { tools } : {}),
        });
      }
    }
    if (typeof sessionId === "string") {
      const entry = entries.get(sessionId);
      if (!entry)
        return json(res, 404, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        });
      return writeResponse(req, res, await entry.transport.handleRequest(request));
    }
    if (req.method !== "POST") return json(res, 400, { error: "No session" });
    const entry = newEntry(pinned, tools);
    await entry.transport.start();
    const response = await entry.transport.handleRequest(request);
    if (!entry.transport.sessionId) {
      // Not an initialize — nothing to keep.
      entry.session.close();
      void entry.transport.close();
    }
    await writeResponse(req, res, response);
  }

  return {
    handle,
    sessions: () => entries.size,
    async close() {
      await Promise.all([...entries.values()].map((e) => e.transport.close().catch(() => {})));
      entries.clear();
    },
  };
}
