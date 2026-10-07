import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GutenbergClient } from "./gutenberg.js";
import { bookStats, bookStatsDescription, bookStatsInput, bookStatsOutput } from "./tools/bookStats.js";
import { READ_ONLY_ANNOTATIONS, safe } from "./tools/common.js";
import { findInBook, findInBookDescription, findInBookInput, findInBookOutput } from "./tools/findInBook.js";
import { getBook, getBookDescription, getBookInput, getBookOutput } from "./tools/getBook.js";
import { quoteCheck, quoteCheckDescription, quoteCheckInput, quoteCheckOutput } from "./tools/quoteCheck.js";
import { readPassage, readPassageDescription, readPassageInput, readPassageOutput } from "./tools/readPassage.js";
import { searchBooks, searchBooksDescription, searchBooksInput, searchBooksOutput } from "./tools/searchBooks.js";

export const SERVER_NAME = "gutenberg";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS =
  "Tools for reading public-domain books from Project Gutenberg. Find a book id with search_books, see its chapters with get_book, then read with read_passage or search inside it with find_in_book. Before quoting a book, verify the wording with quote_check: it returns the book's actual lines. All tools are read-only. Line numbers are stable across tools.";

export function createServer(client: GutenbergClient = new GutenbergClient()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "search_books",
    { title: "Search Project Gutenberg", description: searchBooksDescription, inputSchema: searchBooksInput, outputSchema: searchBooksOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => searchBooks(client, args)),
  );
  server.registerTool(
    "get_book",
    { title: "Book details and chapters", description: getBookDescription, inputSchema: getBookInput, outputSchema: getBookOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => getBook(client, args)),
  );
  server.registerTool(
    "read_passage",
    { title: "Read a passage", description: readPassageDescription, inputSchema: readPassageInput, outputSchema: readPassageOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => readPassage(client, args)),
  );
  server.registerTool(
    "find_in_book",
    { title: "Find in book", description: findInBookDescription, inputSchema: findInBookInput, outputSchema: findInBookOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => findInBook(client, args)),
  );
  server.registerTool(
    "quote_check",
    { title: "Verify a quotation", description: quoteCheckDescription, inputSchema: quoteCheckInput, outputSchema: quoteCheckOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => quoteCheck(client, args)),
  );
  server.registerTool(
    "book_stats",
    { title: "Book statistics", description: bookStatsDescription, inputSchema: bookStatsInput, outputSchema: bookStatsOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => bookStats(client, args)),
  );

  return server;
}
