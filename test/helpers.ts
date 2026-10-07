import { readFileSync } from "node:fs";
import { GutenbergClient, type GutenbergClientOptions } from "../src/gutenberg.js";

export function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
}

type Route = { match: (url: URL) => boolean; respond: (url: URL) => Response | Promise<Response> };

/**
 * A fetch stand-in that routes by URL and records every call.
 * Unmatched requests fail loudly so tests can never hit the network.
 */
export function mockFetch(routes: Route[]) {
  const calls: URL[] = [];
  const fn = async (input: string) => {
    const url = new URL(input);
    calls.push(url);
    const route = routes.find((r) => r.match(url));
    if (!route) throw new Error(`Unmocked request: ${url.toString()}`);
    return route.respond(url);
  };
  return { fetch: fn, calls };
}

export const path = (p: string) => (u: URL) => u.pathname === p;

/** Routes for the two recorded books and the recorded searches. */
export function libraryRoutes(): Route[] {
  return [
    { match: path("/cache/epub/2701/pg2701.txt"), respond: () => text(fixtureText("pg2701-excerpt.txt")) },
    { match: path("/cache/epub/1342/pg1342.txt"), respond: () => text(fixtureText("pg1342-excerpt.txt")) },
    { match: path("/books/2701/"), respond: () => json(fixture("gutendex-book-2701.json")) },
    { match: path("/books/1342/"), respond: () => json(fixture("gutendex-book-1342.json")) },
    { match: (u) => u.pathname === "/books/" && /moby/i.test(u.searchParams.get("search") ?? ""), respond: () => json(fixture("gutendex-search-moby-dick.json")) },
    { match: (u) => u.pathname === "/books/" && /austen|pride/i.test(u.searchParams.get("search") ?? ""), respond: () => json(fixture("gutendex-search-austen-pride.json")) },
    { match: (u) => u.pathname === "/books/", respond: () => json({ count: 0, next: null, previous: null, results: [] }) },
    { match: (u) => u.pathname.startsWith("/books/"), respond: () => json(fixture("gutendex-404.json"), 404) },
    { match: (u) => u.pathname.startsWith("/cache/epub/"), respond: () => text("Not Found", 404) },
  ];
}

export function testClient(fetch: ReturnType<typeof mockFetch>["fetch"], extra: Partial<GutenbergClientOptions> = {}) {
  return new GutenbergClient({ fetch, sleep: async () => {}, catalogCacheTtlMs: 0, ...extra });
}

export function library(extra: Partial<GutenbergClientOptions> = {}) {
  const m = mockFetch(libraryRoutes());
  return { ...m, client: testClient(m.fetch, extra) };
}

/** Pull the structured payload out of a tool result. */
export function data<T = any>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}
