/**
 * Client for the two upstreams:
 *
 * - Gutendex (https://gutendex.com), a free JSON API over the Project Gutenberg
 *   catalog: search and per-book metadata.
 * - A Project Gutenberg mirror for the plain-text files. Project Gutenberg's robot
 *   policy (https://www.gutenberg.org/policy/robot_access.html) says www.gutenberg.org
 *   is for human visitors and may block automated access, so book downloads go to
 *   gutenberg.pglaf.org, the high-speed mirror Project Gutenberg runs itself and lists
 *   in https://www.gutenberg.org/MIRRORS.ALL. GUTENBERG_MIRROR picks another one.
 *
 * Every request has a timeout. 429 and 5xx are retried with backoff. Catalog
 * responses are cached with a TTL; parsed books sit in an LRU bounded by memory.
 * Two tools asking for the same book at once share one download.
 * Every failure becomes a GutenbergError with a hint the model can act on.
 */
import { Book } from "./book.js";
import { LruCache, TtlCache } from "./text/lru.js";

export const GUTENDEX_URL = "https://gutendex.com";
/** Project Gutenberg's own mirror. Same paths as www.gutenberg.org (main collection and cache/epub). */
export const DEFAULT_MIRROR_URL = "https://gutenberg.pglaf.org";
const USER_AGENT = "gutenberg-mcp (+https://github.com/frogr/gutenberg-mcp)";
/** Hosts the catalog may name for a text file. Downloads are rewritten to the mirror. */
const CATALOG_TEXT_HOSTS = new Set(["www.gutenberg.org", "gutenberg.org"]);

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GutenbergClientOptions {
  gutendexUrl?: string;
  /** Base URL of the Project Gutenberg mirror that book texts are downloaded from. */
  mirrorUrl?: string;
  /** Catalog (Gutendex) timeout. Gutendex is sometimes slow; a book's text does not depend on it. */
  catalogTimeoutMs?: number;
  textTimeoutMs?: number;
  maxRetries?: number;
  /** Largest book file accepted, in bytes. */
  maxTextBytes?: number;
  /** Memory budget for parsed books, in bytes (estimated). */
  bookCacheBytes?: number;
  catalogCacheTtlMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export class GutenbergError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly code: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "GutenbergError";
  }

  toToolMessage(): string {
    return `${this.message}${this.status ? ` (HTTP ${this.status})` : ""}\nHint: ${this.hint}`;
  }
}

export interface GutendexPerson {
  name: string;
  birth_year: number | null;
  death_year: number | null;
}

export interface GutendexBook {
  id: number;
  title: string;
  authors: GutendexPerson[];
  translators?: GutendexPerson[];
  summaries?: string[];
  subjects: string[];
  bookshelves: string[];
  languages: string[];
  copyright: boolean | null;
  media_type: string;
  formats: Record<string, string>;
  download_count: number;
}

export interface GutendexPage {
  count: number;
  next: string | null;
  previous: string | null;
  results: GutendexBook[];
}

export interface SearchParams {
  search?: string;
  languages?: string;
  topic?: string;
  page?: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 5_000;

export class GutenbergClient {
  private readonly gutendexUrl: string;
  readonly mirrorUrl: string;
  private readonly mirrorHost: string;
  private readonly catalogTimeoutMs: number;
  private readonly textTimeoutMs: number;
  private readonly maxRetries: number;
  readonly maxTextBytes: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly catalog: TtlCache<string, unknown>;
  private readonly books: LruCache<number, Book>;
  private readonly inflight = new Map<number, Promise<Book>>();

  constructor(opts: GutenbergClientOptions = {}) {
    this.gutendexUrl = (opts.gutendexUrl ?? GUTENDEX_URL).replace(/\/+$/, "");
    this.mirrorUrl = (opts.mirrorUrl ?? DEFAULT_MIRROR_URL).replace(/\/+$/, "");
    this.mirrorHost = new URL(this.mirrorUrl).host;
    this.catalogTimeoutMs = opts.catalogTimeoutMs ?? 20_000;
    this.textTimeoutMs = opts.textTimeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.maxTextBytes = opts.maxTextBytes ?? 16 * 1024 * 1024;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.catalog = new TtlCache(500, opts.catalogCacheTtlMs ?? 60 * 60_000);
    this.books = new LruCache<number, Book>(24, opts.bookCacheBytes ?? 160 * 1024 * 1024, (b) => b.approxBytes);
  }

  /** Books currently parsed and cached (for /health). */
  get cachedBooks(): number {
    return this.books.size;
  }

  async search(p: SearchParams): Promise<GutendexPage> {
    const url = new URL(`${this.gutendexUrl}/books/`);
    if (p.search) url.searchParams.set("search", p.search);
    if (p.languages) url.searchParams.set("languages", p.languages);
    if (p.topic) url.searchParams.set("topic", p.topic);
    if (p.page && p.page > 1) url.searchParams.set("page", String(p.page));
    const body = (await this.catalogJson(url.toString())) as GutendexPage;
    if (!body || !Array.isArray(body.results)) throw shapeError();
    return body;
  }

  /**
   * Fallback search on gutenberg.org's own OPDS (Atom) feed. Fast, but thinner than
   * Gutendex: id, title and author only, 25 per page, no language or topic filters.
   */
  async searchOpds(query: string, page = 1): Promise<OpdsPage> {
    const url = new URL("https://www.gutenberg.org/ebooks/search.opds/");
    url.searchParams.set("query", query);
    if (page > 1) url.searchParams.set("start_index", String((page - 1) * OPDS_PAGE_SIZE + 1));
    const cached = this.catalog.get(url.toString()) as OpdsPage | undefined;
    if (cached) return cached;
    const res = await this.request(url.toString(), this.textTimeoutMs, "application/atom+xml", "gutenberg.org");
    if (!res.ok) throw await httpError(res, "gutenberg.org");
    const value = parseOpds(new TextDecoder().decode(await readCapped(res, 2 * 1024 * 1024)));
    this.catalog.set(url.toString(), value);
    return value;
  }

  async getMeta(id: number): Promise<GutendexBook> {
    const body = (await this.catalogJson(`${this.gutendexUrl}/books/${id}/`, id)) as GutendexBook;
    if (!body || typeof body.id !== "number") throw shapeError();
    return body;
  }

  /** Download (or reuse) and parse a book's plain text. */
  async getBook(id: number): Promise<Book> {
    const hit = this.books.get(id);
    if (hit) return hit;
    let p = this.inflight.get(id);
    if (!p) {
      p = this.loadBook(id).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  private async loadBook(id: number): Promise<Book> {
    // Skip the catalog when we can: the canonical text URL works for almost every book,
    // and Gutendex can take many seconds to answer.
    const cachedMeta = this.catalog.get(`${this.gutendexUrl}/books/${id}/`) as GutendexBook | undefined;
    const picked = cachedMeta ? pickTextUrl(cachedMeta) : canonicalTextUrl(id, this.mirrorUrl);
    if (!picked) throw noPlainText(id, cachedMeta!);
    let url = this.toMirror(picked);

    let raw: string;
    try {
      raw = await this.fetchText(url);
    } catch (err) {
      if (!(err instanceof GutenbergError) || err.status !== 404 || cachedMeta) throw err;
      // No file at the canonical path: ask the catalog where the text lives.
      const meta = await this.getMeta(id);
      const fromCatalog = pickTextUrl(meta);
      if (!fromCatalog) throw noPlainText(id, meta);
      url = this.toMirror(fromCatalog);
      raw = await this.fetchText(url);
    }
    const book = new Book(id, raw, url);
    if (book.lines.length === 0) {
      throw new GutenbergError(`Book ${id} has no readable text.`, undefined, "empty", "Try a different edition from search_books.");
    }
    this.books.set(id, book);
    return book;
  }

  private async catalogJson(url: string, bookId?: number): Promise<unknown> {
    const cached = this.catalog.get(url);
    if (cached !== undefined) return cached;
    const res = await this.request(url, this.catalogTimeoutMs, "application/json", "Gutendex");
    if (!res.ok) throw await httpError(res, "Gutendex", bookId);
    let value: unknown;
    try {
      value = await res.json();
    } catch {
      throw shapeError();
    }
    this.catalog.set(url, value);
    return value;
  }

  /**
   * Map a text URL from the catalog (www.gutenberg.org) to the same file on the mirror.
   * Anything that is not a Project Gutenberg URL is refused.
   */
  private toMirror(url: string): string {
    const mapped = mirrorTextUrl(url, this.mirrorUrl);
    if (!mapped) {
      const host = new URL(url).hostname;
      throw new GutenbergError(`Refusing to download text from ${host}.`, undefined, "host", "Only Project Gutenberg text files are supported.");
    }
    return mapped;
  }

  private async fetchText(url: string): Promise<string> {
    const res = await this.request(url, this.textTimeoutMs, "text/plain", this.mirrorHost);
    if (!res.ok) throw await httpError(res, this.mirrorHost);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > this.maxTextBytes) {
      void res.body?.cancel().catch(() => {});
      throw tooLarge(this.maxTextBytes);
    }
    const bytes = await readCapped(res, this.maxTextBytes);
    return decode(bytes, res.headers.get("content-type"));
  }

  private async request(url: string, timeoutMs: number, accept: string, upstream: string): Promise<Response> {
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { Accept: accept, "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "follow",
        });
      } catch (err) {
        const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (!isTimeout && attempt < this.maxRetries) {
          await this.sleep(backoff(attempt++));
          continue;
        }
        throw isTimeout
          ? new GutenbergError(
              `${upstream} did not respond within ${Math.round(timeoutMs / 1000)}s.`,
              undefined,
              "timeout",
              upstream === "Gutendex"
                ? "Gutendex is sometimes slow. Retry in a moment. If you already know the book id, the reading tools (read_passage, find_in_book, quote_check, book_stats) do not need the catalog."
                : "Retry in a moment.",
            )
          : new GutenbergError(
              `Network error contacting ${upstream}: ${err instanceof Error ? err.message : String(err)}`,
              undefined,
              "network",
              "Check internet access or proxy settings, then retry.",
            );
      }
      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        void res.body?.cancel().catch(() => {});
        await this.sleep(retryAfterMs(res.headers.get("retry-after")) ?? backoff(attempt));
        attempt++;
        continue;
      }
      return res;
    }
  }
}

export const OPDS_PAGE_SIZE = 25;

export interface OpdsPage {
  books: Array<{ id: number; title: string; author?: string }>;
  has_next: boolean;
}

/** Book entries from a gutenberg.org OPDS search feed. Author/subject "folder" entries are skipped. */
export function parseOpds(xml: string): OpdsPage {
  const books: OpdsPage["books"] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1]!;
    const id = /<id>https?:\/\/www\.gutenberg\.org\/ebooks\/(\d+)\.opds<\/id>/.exec(entry)?.[1];
    if (!id) continue;
    const title = /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1];
    const author = /<content type="text">([\s\S]*?)<\/content>/.exec(entry)?.[1];
    books.push({ id: Number(id), title: unescapeXml(title ?? "").trim(), ...(author ? { author: unescapeXml(author).trim() } : {}) });
  }
  return { books, has_next: /<link rel="next"/.test(xml) };
}

function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function canonicalTextUrl(id: number, mirrorUrl = DEFAULT_MIRROR_URL): string {
  return `${mirrorUrl.replace(/\/+$/, "")}/cache/epub/${id}/pg${id}.txt`;
}

/**
 * The mirror URL for a Project Gutenberg text URL, or undefined if it isn't one.
 * - ebooks/1342.txt.utf-8 (a redirect on gutenberg.org) -> cache/epub/1342/pg1342.txt
 * - cache/epub/... -> same path on the mirror
 * - files/1342/1342-0.txt -> 1/3/4/1342/1342-0.txt (the mirror's main-collection layout)
 */
export function mirrorTextUrl(url: string, mirrorUrl = DEFAULT_MIRROR_URL): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const base = mirrorUrl.replace(/\/+$/, "");
  if (u.origin === new URL(base).origin) return u.toString();
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  if (!CATALOG_TEXT_HOSTS.has(u.hostname)) return undefined;
  let m = /^\/ebooks\/(\d+)\.txt(?:\.[\w-]+)?$/.exec(u.pathname);
  if (m) return canonicalTextUrl(Number(m[1]), base);
  if (/^\/cache\/epub\/\d+\/[\w.-]+\.txt$/.test(u.pathname)) return `${base}${u.pathname}`;
  m = /^\/files\/(\d+)\/([\w.-]+\.txt)$/.exec(u.pathname);
  if (m) return `${base}/${collectionDir(m[1]!)}/${m[2]}`;
  return undefined;
}

/** Main-collection directory for an ebook number: 1342 -> 1/3/4/1342, 5 -> 0/5. */
export function collectionDir(id: string): string {
  const parents = id.length === 1 ? ["0"] : id.slice(0, -1).split("");
  return [...parents, id].join("/");
}

/** Best plain-text format: UTF-8 first, then any text/plain. Zip archives are skipped. */
export function pickTextUrl(meta: Pick<GutendexBook, "formats">): string | undefined {
  const entries = Object.entries(meta.formats ?? {}).filter(([type, url]) => type.startsWith("text/plain") && !url.endsWith(".zip"));
  const rank = (type: string) => (/utf-8/i.test(type) ? 0 : /us-ascii/i.test(type) ? 1 : 2);
  entries.sort((a, b) => rank(a[0]) - rank(b[0]));
  return entries[0]?.[1];
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => {});
      throw tooLarge(max);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Decode with the charset the server declared, falling back to UTF-8 (Gutenberg's default). */
export function decode(bytes: Uint8Array, contentType: string | null): string {
  const charset = /charset=([\w-]+)/i.exec(contentType ?? "")?.[1]?.toLowerCase();
  try {
    return new TextDecoder(charset && charset !== "us-ascii" ? charset : "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function backoff(attempt: number): number {
  return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, MAX_BACKOFF_MS);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_BACKOFF_MS);
  return undefined;
}

async function httpError(res: Response, upstream: string, bookId?: number): Promise<GutenbergError> {
  void res.body?.cancel().catch(() => {});
  if (res.status === 404) {
    return bookId !== undefined
      ? new GutenbergError(`No Project Gutenberg book has id ${bookId}.`, 404, "not_found", "Use search_books to find the right id.")
      : new GutenbergError(`${upstream} has no file at that address.`, 404, "not_found", "Use search_books to check the book id, or try another edition.");
  }
  if (res.status === 429) {
    return new GutenbergError(`Rate limited by ${upstream}.`, 429, "rate_limited", "Wait a minute and retry.");
  }
  return new GutenbergError(
    `${upstream} returned an error.`,
    res.status,
    "upstream",
    res.status >= 500 ? `${upstream} is having trouble; retry shortly.` : "Check the request parameters.",
  );
}

function shapeError() {
  return new GutenbergError("Unexpected response from Gutendex.", undefined, "shape", "Retry in a moment.");
}

function tooLarge(max: number) {
  return new GutenbergError(
    `This book's text is larger than the ${Math.round(max / 1024 / 1024)} MB limit.`,
    undefined,
    "too_large",
    "Very large collections (complete works, encyclopedias) are not supported. Look for a single-volume edition with search_books.",
  );
}

function noPlainText(id: number, meta: GutendexBook) {
  const formats = Object.keys(meta.formats ?? {}).join(", ") || "none";
  return new GutenbergError(
    `Book ${id} ("${meta.title}") has no plain-text edition. Available formats: ${formats}.`,
    undefined,
    "no_text",
    meta.media_type && meta.media_type !== "Text" ? `This item is ${meta.media_type}, not a text.` : "Try another edition from search_books.",
  );
}
