// The package runs its own conformance suites: the relay core over in-memory
// sockets, and an endpoint serving the test echo server.

import {
  memoryRelayHarness,
  runEndpointConformance,
  runRelayConformance,
} from "../../src/testing/index.js";
import { makeEchoServer } from "../support/echo-server.js";

runRelayConformance("relay core (memory)", memoryRelayHarness, makeEchoServer);

runEndpointConformance("echo server", {
  createServer: makeEchoServer,
  expectTools: ["echo", "upload"],
  readCall: { name: "echo", arguments: { text: "ok" } },
});
