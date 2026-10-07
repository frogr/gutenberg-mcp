// Call one tool from the command line, through the real MCP protocol layer
// (in-memory transport), against live Gutendex and the Gutenberg mirror.
//
//   npm run build
//   node scripts/call.mjs quote_check '{"id":2701,"quote":"Call me Ishmael."}'
//   node scripts/call.mjs get_book '{"id":84}' --full
//
// Prints the elapsed time and the tool's JSON result (first 2,500 characters
// unless --full is passed).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";

const [name, json = "{}"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const full = process.argv.includes("--full");
if (!name) {
  console.error("usage: node scripts/call.mjs <tool> '<json args>' [--full]");
  process.exit(2);
}

const server = createServer();
const client = new Client({ name: "call", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);

const t0 = Date.now();
const res = await client.callTool({ name, arguments: JSON.parse(json) });
const text = res.content?.[0]?.text ?? "";
console.log(`${name} ${json} -> ${res.isError ? "ERROR" : "ok"} in ${Date.now() - t0} ms`);
console.log(full ? text : text.slice(0, 2500) + (text.length > 2500 ? `\n... (${text.length} chars total)` : ""));
await client.close();
process.exit(res.isError ? 1 : 0);
