#!/usr/bin/env node
/**
 * Entry point: a BridgeClient reading the per-install token from the config
 * directory, wired to the stdio MCP server. No arguments, no secrets on a command
 * line, and nothing but 127.0.0.1 is ever contacted.
 */

import { BridgeClient } from "../../adapter/src/index.js";
import { runStdio } from "./server.js";

try {
  const client = new BridgeClient();
  runStdio({ client });
} catch (error) {
  // A missing token or a bad host is fatal at startup, and stderr is where an MCP
  // host shows it.
  process.stderr.write(`gb-ava-browser-mcp: ${(error as Error).message}\n`);
  process.exit(1);
}
