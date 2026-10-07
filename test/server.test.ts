// End-to-end through the real MCP protocol layer (in-memory transport):
// tool listing, SDK-side zod validation, outputSchema validation, error mapping.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { GutenbergClient } from "../src/gutenberg.js";
import { createServer } from "../src/server.js";
import { library, mockFetch, testClient } from "./helpers.js";

async function connect(client = library().client) {
  const server = createServer(client);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return mcp;
}

const text = (r: any) => r.content[0].text as string;
const TOOLS = ["book_stats", "find_in_book", "get_book", "quote_check", "read_passage", "search_books"];

describe("MCP server", () => {
  it("lists six read-only tools with input and output schemas and server instructions", async () => {
    const mcp = await connect();
    expect(mcp.getInstructions()).toMatch(/quote_check/);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(80);
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type).toBe("object");
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    }
    const read = tools.find((t) => t.name === "read_passage")!;
    expect(read.inputSchema.required).toEqual(["id"]);
    expect((read.inputSchema.properties as any).max_lines).toMatchObject({ maximum: 200, default: 80 });
    const find = tools.find((t) => t.name === "find_in_book")!;
    expect((find.inputSchema.properties as any).max_results).toMatchObject({ maximum: 20 });
  });

  it("returns text + structuredContent that passes the output schema", async () => {
    const mcp = await connect();
    for (const [name, args] of [
      ["search_books", { query: "moby dick" }],
      ["get_book", { id: 2701 }],
      ["read_passage", { id: 2701, chapter: 1, max_lines: 5 }],
      ["find_in_book", { id: 2701, query: "Ishmael" }],
      ["quote_check", { id: 2701, quote: "Call me Ishmael." }],
      ["book_stats", { id: 1342 }],
    ] as const) {
      const res: any = await mcp.callTool({ name, arguments: args });
      expect(res.isError, `${name}: ${text(res)}`).toBeFalsy();
      expect(JSON.parse(text(res))).toEqual(res.structuredContent);
    }
  });

  it("rejects invalid input before any HTTP request", async () => {
    const m = mockFetch([]);
    const mcp = await connect(testClient(m.fetch));

    const tooMany: any = await mcp.callTool({ name: "read_passage", arguments: { id: 2701, max_lines: 500 } });
    expect(tooMany.isError).toBe(true);
    expect(text(tooMany)).toMatch(/max_lines/);

    const badId: any = await mcp.callTool({ name: "get_book", arguments: { id: "moby" } });
    expect(badId.isError).toBe(true);

    const longQuote: any = await mcp.callTool({ name: "quote_check", arguments: { id: 1, quote: "x".repeat(2001) } });
    expect(longQuote.isError).toBe(true);

    const badLang: any = await mcp.callTool({ name: "search_books", arguments: { query: "x", language: "english" } });
    expect(text(badLang)).toMatch(/two-letter language codes/);

    expect(m.calls).toHaveLength(0);
  });

  it("surfaces upstream failures as readable tool errors", async () => {
    const mcp = await connect();
    const res: any = await mcp.callTool({ name: "read_passage", arguments: { id: 424242 } });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("No Project Gutenberg book has id 424242. (HTTP 404)\nHint: Use search_books to find the right id.");
  });

  it("hides unexpected errors from the caller", async () => {
    class Broken extends GutenbergClient {
      override async getBook(): Promise<never> {
        throw new TypeError("secret internal detail");
      }
    }
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const mcp = await connect(new Broken({ fetch: mockFetch([]).fetch }));
    const res: any = await mcp.callTool({ name: "book_stats", arguments: { id: 1 } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^Unexpected server error/);
    expect(text(res)).not.toMatch(/secret/);
    expect(log).toHaveBeenCalled(); // the details go to the server log instead
    log.mockRestore();
  });
});
