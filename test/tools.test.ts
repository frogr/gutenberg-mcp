// Tool handlers against recorded Gutendex responses and two book excerpts
// (Moby Dick and Pride and Prejudice, header and footer included). No network.
import { describe, expect, it } from "vitest";
import { collectionDir, GutenbergClient, mirrorTextUrl, pickTextUrl } from "../src/gutenberg.js";
import { bookStats } from "../src/tools/bookStats.js";
import { findInBook } from "../src/tools/findInBook.js";
import { getBook } from "../src/tools/getBook.js";
import { cleanQuote, quoteCheck, quoteSegments } from "../src/tools/quoteCheck.js";
import { readPassage } from "../src/tools/readPassage.js";
import { searchBooks } from "../src/tools/searchBooks.js";
import { data, fixture, fixtureText, json, library, mockFetch, path, testClient, text } from "./helpers.js";

const qc = (client: GutenbergClient, quote: string, case_sensitive = false) => quoteCheck(client, { id: 2701, quote, case_sensitive }).then(data);

describe("quote_check", () => {
  it("finds 'Call me Ishmael.' verbatim, with its line and chapter", async () => {
    const { client } = library();
    const r = await qc(client, "Call me Ishmael.");
    expect(r).toMatchObject({ found: true, match: "exact", occurrences: 1 });
    expect(r.locations[0]).toMatchObject({ start_line: 40, end_line: 40, chapter: { index: 1, label: "CHAPTER 1", title: "Loomings" } });
    expect(r.locations[0].text).toMatch(/^40 {2}Call me Ishmael\. Some years ago/);
    expect(r.attribution).toBe('"Moby Dick; Or, The Whale" by Herman Melville. Public domain text (USA), eBook #2701: https://www.gutenberg.org/ebooks/2701');
    expect(r.attribution).not.toMatch(/Project Gutenberg/);
  });

  it("reports how faithful a copy is: typography, case, then punctuation", async () => {
    const { client } = library();
    // Straight apostrophe and hyphens instead of the book's ’ and em dashes, across a line break.
    expect(await qc(client, "Some years ago--never mind how long precisely--having little or no money")).toMatchObject({ found: true, match: "typography" });
    expect(await qc(client, "methodically knocking people's hats off")).toMatchObject({ found: true, match: "typography" });
    expect(await qc(client, "CALL ME ISHMAEL")).toMatchObject({ found: true, match: "case" });
    expect(await qc(client, "CALL ME ISHMAEL", true)).toMatchObject({ found: false, match: "none" });

    const austen = await quoteCheck(library().client, {
      id: 1342,
      quote: "It is a truth universally acknowledged that a single man in possession of a good fortune, must be in want of a wife",
      case_sensitive: false,
    }).then(data);
    expect(austen).toMatchObject({ found: true, match: "words", locations: [{ start_line: 16, end_line: 17 }] });
    expect(austen.locations[0].text).toContain("acknowledged, that a single man");
  });

  it("does not match inside words", async () => {
    const { client } = library();
    expect(await qc(client, "all me Ishmael")).toMatchObject({ found: false });
  });

  it("checks quotes with an ellipsis part by part, in order", async () => {
    const { client } = library();
    const ok = await qc(client, "Call me Ishmael... having little or no money in my purse");
    expect(ok).toMatchObject({ found: true, locations: [{ start_line: 40, end_line: 41 }] });
    expect(await qc(client, "having little or no money in my purse … Call me Ishmael")).toMatchObject({ found: false });
  });

  it("shows the closest real passage for a misquote", async () => {
    const { client } = library();
    const r = await qc(client, "Call me Ishmael. Many years ago, never mind how long exactly, having little money in my purse");
    expect(r.found).toBe(false);
    expect(r.closest).toMatchObject({ start_line: 40, chapter: { label: "CHAPTER 1" } });
    expect(r.closest.missing_words).toEqual(expect.arrayContaining(["many", "exactly"]));
    expect(r.verdict).toMatch(/closest passage \(lines 40-41\) shares \d+ of 17 words/);

    const nothing = await qc(client, "Elementary, my dear Watson");
    expect(nothing).toMatchObject({ found: false, locations: [] });
    expect(nothing.closest).toBeUndefined();
  });

  it("strips surrounding quote marks and splits on ellipses", () => {
    expect(cleanQuote(" “Call me Ishmael.” ")).toBe("Call me Ishmael.");
    expect(quoteSegments("a b... c d … e")).toEqual(["a b", "c d", "e"]);
  });
});

describe("find_in_book", () => {
  it("counts matches across line breaks and dash styles, with context and per-chapter counts", async () => {
    const { client } = library();
    const r = data(await findInBook(client, { id: 2701, query: "ishmael", whole_word: false, max_results: 2, context_lines: 1 }));
    expect(r.total_matches).toBe(6);
    expect(r.returned).toBe(2);
    expect(r.matches[0]).toMatchObject({ start_line: 40, end_line: 40, chapter: { label: "CHAPTER 1" } });
    expect(r.matches[0].excerpt.split("\n")).toHaveLength(3);
    expect(r.by_chapter).toEqual([
      { index: 1, label: "CHAPTER 1", title: "Loomings", count: 2 },
      { index: 2, label: "CHAPTER 2", title: "The Carpet-Bag", count: 4 },
    ]);
    expect(r.note).toMatch(/first 2 of 6/);

    const wrapped = data(await findInBook(client, { id: 2701, query: "precisely -- having little", whole_word: false, max_results: 5, context_lines: 0 }));
    expect(wrapped.matches[0]).toMatchObject({ start_line: 40, end_line: 41 });
  });

  it("respects whole_word", async () => {
    const { client } = library();
    const loose = data(await findInBook(client, { id: 2701, query: "whale", whole_word: false, max_results: 1, context_lines: 0 }));
    const strict = data(await findInBook(client, { id: 2701, query: "whale", whole_word: true, max_results: 1, context_lines: 0 }));
    expect(loose.total_matches).toBeGreaterThan(strict.total_matches);
  });
});

describe("read_passage", () => {
  it("reads a chapter from its heading, numbered, and pages with next_start_line", async () => {
    const { client } = library();
    const r = data(await readPassage(client, { id: 2701, chapter: 1, max_lines: 3 }));
    expect(r).toMatchObject({ start_line: 38, end_line: 40, next_start_line: 41, chapter_end_line: 236, chapter: { index: 1, title: "Loomings" } });
    expect(r.text).toBe("38  CHAPTER 1. Loomings.\n39  \n40  Call me Ishmael. Some years ago—never mind how long precisely—having");

    const next = data(await readPassage(client, { id: 2701, start_line: r.next_start_line, max_lines: 1 }));
    expect(next.text).toBe("41  little or no money in my purse, and nothing particular to interest me");
  });

  it("stops at the end of the chapter and the end of the book", async () => {
    const { client } = library();
    const ch = data(await readPassage(client, { id: 2701, chapter: 1, max_lines: 200 }));
    expect(ch.end_line).toBe(199 + 38 - 1 > 236 ? 236 : 199 + 38 - 1);
    const end = data(await readPassage(client, { id: 2701, start_line: 369, max_lines: 50 }));
    expect(end).toMatchObject({ start_line: 369, end_line: 370, next_start_line: null });
  });

  it("explains bad chapter and line arguments", async () => {
    const { client } = library();
    await expect(readPassage(client, { id: 2701, chapter: 9, max_lines: 10 })).rejects.toThrow(/2 detected chapters; chapter must be 1-2/);
    await expect(readPassage(client, { id: 2701, start_line: 999, max_lines: 10 })).rejects.toThrow(/past the end of the book \(370 lines\)/);
    await expect(readPassage(client, { id: 2701, chapter: 1, start_line: 5, max_lines: 10 })).rejects.toThrow(/not both/);
  });
});

describe("get_book", () => {
  it("combines catalog metadata with the detected table of contents", async () => {
    const { client } = library();
    const r = data(await getBook(client, { id: 2701 }));
    expect(r).toMatchObject({
      id: 2701,
      title: "Moby Dick; Or, The Whale",
      authors: ["Herman Melville"],
      languages: ["en"],
      metadata_source: "gutendex",
      line_count: 370,
      chapter_count: 2,
      release_date: "July 1, 2001",
      url: "https://www.gutenberg.org/ebooks/2701",
    });
    expect(r.bookshelves).toContain("Classics of Literature");
    expect(r.summary).not.toMatch(/automatically generated/);
    expect(r.chapters[0]).toEqual({ index: 1, label: "CHAPTER 1", title: "Loomings", start_line: 38, end_line: 236 });
  });

  it("falls back to the book's own header when Gutendex is down", async () => {
    const m = mockFetch([
      { match: path("/cache/epub/1342/pg1342.txt"), respond: () => text(fixtureText("pg1342-excerpt.txt")) },
      { match: (u) => u.hostname === "gutendex.com", respond: () => json({ detail: "boom" }, 503) },
    ]);
    const r = data(await getBook(testClient(m.fetch), { id: 1342 }));
    expect(r).toMatchObject({ title: "Pride and Prejudice", authors: ["Jane Austen"], metadata_source: "text_header", chapter_count: 3 });
    expect(r.note).toMatch(/catalog \(Gutendex\) did not answer/);
    expect(m.calls.filter((u) => u.hostname === "gutendex.com")).toHaveLength(3); // first try + 2 retries
  });

  it("does not wait long for a slow catalog once the text is in", async () => {
    const m = mockFetch([
      { match: path("/cache/epub/2701/pg2701.txt"), respond: () => text(fixtureText("pg2701-excerpt.txt")) },
      { match: (u) => u.hostname === "gutendex.com", respond: () => new Promise<Response>(() => {}) },
    ]);
    const t0 = Date.now();
    const r = data(await getBook(testClient(m.fetch), { id: 2701 }, 20));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r).toMatchObject({ title: "Moby Dick; Or, The Whale", metadata_source: "text_header", chapter_count: 2 });
  });

  it("says when an id does not exist", async () => {
    const { client } = library();
    await expect(getBook(client, { id: 99999999 })).rejects.toThrow(/No Project Gutenberg book has id 99999999/);
  });

  it("returns metadata with a note when a catalog entry has no plain text", async () => {
    const audio = { ...fixture<any>("gutendex-book-2701.json"), id: 555, title: "An Audio Book", media_type: "Sound", formats: { "audio/mpeg": "https://www.gutenberg.org/files/555/555.mp3" } };
    const m = mockFetch([
      { match: path("/books/555/"), respond: () => json(audio) },
      { match: path("/cache/epub/555/pg555.txt"), respond: () => text("Not Found", 404) },
    ]);
    const r = data(await getBook(testClient(m.fetch), { id: 555 }));
    expect(r).toMatchObject({ title: "An Audio Book", line_count: 0, chapters: [] });
    expect(r.note).toMatch(/no plain-text edition.*audio\/mpeg/);
  });
});

describe("search_books", () => {
  it("returns compact results with author names in reading order", async () => {
    const { client, calls } = library();
    const r = data(await searchBooks(client, { query: "pride", author: "austen", language: "EN", page: 1 }));
    expect(calls[0]!.searchParams.get("search")).toBe("pride austen");
    expect(calls[0]!.searchParams.get("languages")).toBe("en");
    expect(r).toMatchObject({ source: "gutendex", total: 6, page: 1, next_page: null });
    expect(r.books[0]).toMatchObject({ id: 1342, title: "Pride and Prejudice", authors: [{ name: "Jane Austen", birth_year: 1775, death_year: 1817 }], has_plain_text: true });
    expect(r.books[0].subjects.length).toBeLessThanOrEqual(4);
  });

  it("falls back to gutenberg.org's own search when Gutendex is slow", async () => {
    const m = mockFetch([
      { match: (u) => u.hostname === "gutendex.com", respond: () => new Promise<Response>(() => {}) },
      {
        match: path("/ebooks/search.opds/"),
        respond: () => new Response(fixtureText("gutenberg-opds-search-tolstoy.xml"), { headers: { "content-type": "application/atom+xml" } }),
      },
    ]);
    const r = data(await searchBooks(testClient(m.fetch), { query: "tolstoy", language: "en", page: 2 }, 20));
    expect(r).toMatchObject({ source: "gutenberg.org", total: null, page: 2, next_page: 3 });
    expect(r.books[0]).toEqual({ id: 2600, title: "War and Peace", authors: [{ name: "graf Leo Tolstoy", birth_year: null, death_year: null }], languages: [], subjects: [] });
    expect(r.books.map((b: any) => b.id)).not.toContain(NaN); // "Authors" and "Subjects" folder entries are skipped
    expect(r.books).toHaveLength(6);
    expect(r.note).toMatch(/language filter was not applied/);
    const opds = m.calls.find((u) => u.pathname === "/ebooks/search.opds/")!;
    expect(opds.searchParams.get("start_index")).toBe("26");
  });

  it("does not fall back when Gutendex rejects the request", async () => {
    const m = mockFetch([{ match: (u) => u.hostname === "gutendex.com", respond: () => json({ detail: "Invalid page." }, 404) }]);
    await expect(searchBooks(testClient(m.fetch), { query: "tolstoy", page: 400 })).rejects.toThrow(/no file at that address/);
    expect(m.calls.every((u) => u.hostname === "gutendex.com")).toBe(true);
  });

  it("explains an empty result", async () => {
    const { client } = library();
    const r = data(await searchBooks(client, { query: "zzzz qqqq", page: 1 }));
    expect(r.total).toBe(0);
    expect(r.note).toMatch(/fewer words/);
  });
});

describe("book_stats", () => {
  it("counts words and finds the longest chapter", async () => {
    const { client } = library();
    const r = data(await bookStats(client, { id: 2701, top_n: 5 }));
    expect(r.word_count).toBeGreaterThan(3000);
    expect(r.unique_words).toBeLessThan(r.word_count);
    expect(r.top_words).toHaveLength(5);
    expect(r.top_words.map((w: any) => w.word)).not.toContain("the");
    expect(r.longest_chapter).toMatchObject({ label: "CHAPTER 1" });
    expect(r.chapter_count).toBe(2);
  });
});

describe("GutenbergClient", () => {
  it("downloads a book once even when tools ask for it at the same time, then serves it from cache", async () => {
    const { client, calls } = library();
    await Promise.all([client.getBook(2701), client.getBook(2701), client.getBook(2701)]);
    await client.getBook(2701);
    expect(calls.filter((u) => u.pathname.endsWith("pg2701.txt"))).toHaveLength(1);
    expect(client.cachedBooks).toBe(1);
  });

  it("downloads from the Gutenberg mirror, not www.gutenberg.org, without waiting for the catalog", async () => {
    const { client, calls } = library();
    const book = await client.getBook(1342);
    expect(calls.map((u) => u.toString())).toEqual(["https://gutenberg.pglaf.org/cache/epub/1342/pg1342.txt"]);
    expect(book.sourceUrl).toBe("https://gutenberg.pglaf.org/cache/epub/1342/pg1342.txt");
  });

  it("uses the mirror set in options (GUTENBERG_MIRROR), also for catalog fallbacks", async () => {
    const meta = { ...fixture<any>("gutendex-book-2701.json"), id: 37431, formats: { "text/plain; charset=us-ascii": "https://www.gutenberg.org/files/37431/37431-8.txt" } };
    const m = mockFetch([
      { match: path("/gutenberg/cache/epub/37431/pg37431.txt"), respond: () => text("Not Found", 404) },
      { match: path("/books/37431/"), respond: () => json(meta) },
      { match: path("/gutenberg/3/7/4/3/37431/37431-8.txt"), respond: () => text(fixtureText("pg2701-excerpt.txt")) },
    ]);
    await testClient(m.fetch, { mirrorUrl: "https://mirror.example.org/gutenberg/" }).getBook(37431);
    const textCalls = m.calls.filter((u) => u.pathname.endsWith(".txt")).map((u) => u.toString());
    expect(textCalls).toEqual([
      "https://mirror.example.org/gutenberg/cache/epub/37431/pg37431.txt",
      "https://mirror.example.org/gutenberg/3/7/4/3/37431/37431-8.txt",
    ]);
    expect(m.calls.some((u) => u.hostname === "www.gutenberg.org")).toBe(false);
  });

  it("maps catalog text URLs onto the mirror's layout", () => {
    const mirror = "https://gutenberg.pglaf.org";
    expect(mirrorTextUrl("https://www.gutenberg.org/ebooks/1342.txt.utf-8", mirror)).toBe(`${mirror}/cache/epub/1342/pg1342.txt`);
    expect(mirrorTextUrl("https://www.gutenberg.org/cache/epub/84/pg84.txt", mirror)).toBe(`${mirror}/cache/epub/84/pg84.txt`);
    expect(mirrorTextUrl("https://www.gutenberg.org/files/2489/2489-0.txt", mirror)).toBe(`${mirror}/2/4/8/2489/2489-0.txt`);
    expect(mirrorTextUrl("https://www.gutenberg.org/files/5/5.txt", mirror)).toBe(`${mirror}/0/5/5.txt`);
    expect(mirrorTextUrl("https://evil.example/pg7.txt", mirror)).toBeUndefined();
    expect(mirrorTextUrl("https://www.gutenberg.org/ebooks/1342.html.images", mirror)).toBeUndefined();
    expect(collectionDir("1342")).toBe("1/3/4/1342");
  });

  it("refuses books over the size limit, before or while reading", async () => {
    const declared = mockFetch([{ match: () => true, respond: () => text("x", 200, { "content-length": "5000000" }) }]);
    await expect(testClient(declared.fetch, { maxTextBytes: 1000 }).getBook(1)).rejects.toThrow(/larger than the 0 MB limit/);
    const streamed = mockFetch([{ match: () => true, respond: () => text("x".repeat(5000)) }]);
    await expect(testClient(streamed.fetch, { maxTextBytes: 1000 }).getBook(1)).rejects.toThrow(/larger than/);
  });

  it("only downloads Project Gutenberg text files", async () => {
    const evil = { ...fixture<any>("gutendex-book-2701.json"), id: 7, formats: { "text/plain; charset=utf-8": "https://evil.example/pg7.txt" } };
    const m = mockFetch([
      { match: path("/cache/epub/7/pg7.txt"), respond: () => text("nope", 404) },
      { match: path("/books/7/"), respond: () => json(evil) },
    ]);
    await expect(testClient(m.fetch).getBook(7)).rejects.toThrow(/Refusing to download text from evil.example/);
    expect(m.calls.some((u) => u.hostname === "evil.example")).toBe(false);
  });

  it("retries 503s and gives up with a hint", async () => {
    let n = 0;
    const m = mockFetch([{ match: () => true, respond: () => (++n < 3 ? text("busy", 503) : text(fixtureText("pg2701-excerpt.txt"))) }]);
    const book = await testClient(m.fetch).getBook(2701);
    expect(book.lineCount).toBe(370);
    expect(n).toBe(3);

    const down = mockFetch([{ match: () => true, respond: () => text("busy", 503) }]);
    const err = await testClient(down.fetch).getBook(2701).catch((e) => e);
    expect(err.toToolMessage()).toBe("gutenberg.pglaf.org returned an error. (HTTP 503)\nHint: gutenberg.pglaf.org is having trouble; retry shortly.");
  });

  it("turns timeouts into a readable error", async () => {
    const slow = async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    };
    await expect(testClient(slow).search({ search: "x" })).rejects.toThrow(/Gutendex did not respond within 20s/);
  });

  it("picks the UTF-8 plain-text format", () => {
    expect(
      pickTextUrl({
        formats: {
          "text/plain; charset=us-ascii": "https://www.gutenberg.org/files/1/1.txt",
          "text/plain; charset=utf-8": "https://www.gutenberg.org/ebooks/1.txt.utf-8",
          "application/zip": "https://www.gutenberg.org/files/1/1.zip",
        },
      }),
    ).toBe("https://www.gutenberg.org/ebooks/1.txt.utf-8");
    expect(pickTextUrl({ formats: { "text/html": "x" } })).toBeUndefined();
  });
});
