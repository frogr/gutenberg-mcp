import { z } from "zod";
import { GutenbergError, OPDS_PAGE_SIZE, pickTextUrl, type GutenbergClient, type GutendexBook } from "../gutenberg.js";
import { displayName, ok, settle, truncate, withGrace } from "./common.js";

/** How long to wait for Gutendex before searching gutenberg.org directly. Uncached Gutendex searches can take 40+ seconds. */
export const SEARCH_GRACE_MS = 8_000;

export const PAGE_SIZE = 32; // fixed by Gutendex

export const searchBooksInput = {
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Words from the title and/or author name, e.g. "moby dick", "austen pride", "frankenstein".'),
  author: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe('Optional author name or part of it, e.g. "Dickens". Added to the search words.'),
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(,[a-z]{2})*$/i, "Use two-letter language codes, e.g. en or fr,de.")
    .optional()
    .describe('Optional two-letter language code(s), comma-separated, e.g. "en" or "fr,de".'),
  topic: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe('Optional subject or bookshelf keyword, e.g. "gothic", "detective", "poetry", "children".'),
  page: z.number().int().min(1).max(500).default(1).describe(`Results page (${PAGE_SIZE} books per page, most downloaded first).`),
};

const bookSummary = z.object({
  id: z.number().describe("Book id for get_book and the reading tools."),
  title: z.string(),
  authors: z.array(z.object({ name: z.string(), birth_year: z.number().nullable(), death_year: z.number().nullable() })),
  languages: z.array(z.string()),
  subjects: z.array(z.string()).describe("First few Library of Congress subjects."),
  download_count: z.number().optional().describe("Downloads from gutenberg.org in the last 30 days."),
  has_plain_text: z.boolean().optional().describe("False for audio books and items with no .txt edition; the reading tools need plain text."),
  summary: z.string().optional(),
});

export const searchBooksOutput = {
  source: z
    .enum(["gutendex", "gutenberg.org"])
    .describe("gutenberg.org means Gutendex was too slow and the simpler gutenberg.org search answered: ids, titles and authors only, no filters."),
  total: z.number().nullable().describe("Total matching books (null when the source does not report it)."),
  page: z.number(),
  next_page: z.number().nullable().describe("Pass as page for more results; null on the last page."),
  books: z.array(bookSummary),
  note: z.string().optional(),
};

type Args = { query: string; author?: string; language?: string; topic?: string; page: number };

export function summarizeBook(b: GutendexBook) {
  return {
    id: b.id,
    title: b.title,
    authors: (b.authors ?? []).map((a) => ({ name: displayName(a.name), birth_year: a.birth_year ?? null, death_year: a.death_year ?? null })),
    languages: b.languages ?? [],
    subjects: (b.subjects ?? []).slice(0, 4),
    download_count: b.download_count ?? 0,
    has_plain_text: Boolean(pickTextUrl(b)),
    ...(b.summaries?.[0] ? { summary: truncate(b.summaries[0].replace(/\s*\(This is an automatically generated summary\.\)\s*$/, ""), 240) } : {}),
  };
}

export async function searchBooks(client: GutenbergClient, args: Args, graceMs = SEARCH_GRACE_MS) {
  const search = [args.query, args.author].filter(Boolean).join(" ");
  const primary = client.search({ search, languages: args.language?.toLowerCase(), topic: args.topic, page: args.page });
  primary.catch(() => {}); // if it arrives late, it is cached for next time
  const r = await settle(withGrace(primary, graceMs));

  if (r.status === "fulfilled") {
    const res = r.value;
    return ok({
      source: "gutendex" as const,
      total: res.count,
      page: args.page,
      next_page: res.next ? args.page + 1 : null,
      books: res.results.map(summarizeBook),
      ...(res.count === 0 ? { note: NO_MATCH } : {}),
    });
  }

  // Gutendex is slow or down. A 4xx is a real answer about the request, so don't paper over it.
  const err = r.reason;
  if (err instanceof GutenbergError && err.status !== undefined && err.status < 500 && err.status !== 429) throw err;
  const opds = await client.searchOpds(search, args.page);
  const filters = [args.language && "language", args.topic && "topic"].filter(Boolean);
  return ok({
    source: "gutenberg.org" as const,
    total: null,
    page: args.page,
    next_page: opds.has_next ? args.page + 1 : null,
    books: opds.books.map((b) => ({
      id: b.id,
      title: b.title,
      authors: b.author ? [{ name: b.author, birth_year: null, death_year: null }] : [],
      languages: [],
      subjects: [],
    })),
    note: [
      `The Gutendex catalog did not answer within ${Math.round(graceMs / 1000)}s, so these results come from gutenberg.org's own search (${OPDS_PAGE_SIZE} per page, no subjects or download counts).`,
      filters.length ? `The ${filters.join(" and ")} filter was not applied.` : "",
      opds.books.length === 0 ? NO_MATCH : "",
    ]
      .filter(Boolean)
      .join(" "),
  });
}

const NO_MATCH = "No books matched. Search matches every word against titles and author names, so try fewer words, a surname only, or drop the topic filter.";

export const searchBooksDescription =
  "Search the Project Gutenberg catalog (more than 75,000 public-domain books) by title and author words, optionally filtered by language and topic. Returns book ids, titles, authors with life years, subjects and popularity. Use the id with get_book and the reading tools.";
