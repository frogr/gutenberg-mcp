#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { clientOptionsFromEnv } from "./env.js";
import { GutenbergClient } from "./gutenberg.js";
import { createServer } from "./server.js";

async function main() {
  const server = createServer(new GutenbergClient(clientOptionsFromEnv()));
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; logs go to stderr.
  console.error("gutenberg-mcp running on stdio");
}

main().catch((err) => {
  console.error("gutenberg-mcp failed to start:", err);
  process.exit(1);
});
