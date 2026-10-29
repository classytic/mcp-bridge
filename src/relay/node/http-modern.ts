/**
 * 2026-07-28 requests over HTTP. That revision is per-request: one POST, one
 * JSON-RPC message carrying its `_meta` envelope, no `Mcp-Session-Id`. Each one
 * runs as a one-request relay session; the endpoint's era-aware server
 * (`serveStdio` per session) answers it.
 *
 * The answer streams as SSE when the client accepts `text/event-stream` —
 * progress, `input_required` rounds and `subscriptions/listen` streams pass
 * through as they come — otherwise it is the single JSON response.
 * Routing uses the SDK's own classifier (`isLegacyRequest`), so 2025 and 2026
 * traffic are split exactly as `createMcpHandler` would split them.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  idOf,
  isJsonRpcMessage,
  isRequest,
  isResponse,
  type JsonRpcMessage,
} from "../../protocol/index.js";
import type { Relay } from "../relay.js";

export async function serveModernRequest(o: {
  relay: Relay;
  req: IncomingMessage;
  res: ServerResponse;
  message: unknown;
  /** `?endpoint=` from the URL — pins the request to that endpoint. */
  endpoint?: string;
  /** `?tools=` from the URL — the client's tool profile. */
  tools?: string[];
}): Promise<void> {
  const { req, res } = o;
  if (!isJsonRpcMessage(o.message)) {
    res.writeHead(400, { "content-type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      }),
    );
    return;
  }
  const message = o.message;
  const sse = (req.headers.accept ?? "").includes("text/event-stream");

  // A notification: hand it over, nothing to wait for.
  if (!isRequest(message)) {
    const session = o.relay.openSession(
      { send: () => {} },
      {
        stateless: true,
        ...(o.endpoint ? { endpoint: o.endpoint } : {}),
        ...(o.tools ? { tools: o.tools } : {}),
      },
    );
    await session.receive(message);
    session.close();
    res.writeHead(202).end();
    return;
  }

  const id = idOf(message);
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      session.close();
      resolve();
    };
    if (sse) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
    }
    const session = o.relay.openSession(
      {
        send: (m: JsonRpcMessage) => {
          if (finished) return;
          const isAnswer = isResponse(m) && idOf(m) === id;
          if (sse) {
            res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
            if (isAnswer) {
              res.end();
              finish();
            }
          } else if (isAnswer) {
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(m));
            finish();
          }
        },
      },
      {
        stateless: true,
        ...(o.endpoint ? { endpoint: o.endpoint } : {}),
        ...(o.tools ? { tools: o.tools } : {}),
      },
    );
    // The client gave up (or closed a listen stream): end the session.
    res.on("close", finish);
    req.on("aborted", finish);
    void session.receive(message);
  });
}
