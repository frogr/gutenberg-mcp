import { z } from "zod";
import { creditLine, type Book } from "../book.js";
import { GutenbergError, type GutenbergClient, type GutendexBook } from "../gutenberg.js";
import { attributionOutput, bookIdInput, displayName, ok, settle, truncate, withGrace } from "./common.js";

export const MAX_TOC_ENTRIES = 300;

export const getBookInput = {
  id: bookIdInput,
};

export const getBookOutput = {
  id: z.number(),
  title: z.string(),
  authors: z.array(z.string()),
  languages: z.array(z.string()),
  subjects: z.array(z.string()),
  bookshelves: z.array(z.string()),
  summary: z.string().optional(),
  download_count: z.number().optional(),
  release_date: z.string().optional().describe("Project Gutenberg release date, from the file header."),
  metadata_source: z.enum(["gutendex", "text_header"]).describe("text_header means the catalog was unavailable and title/author come from the book file."),
  line_count: z.number().describe("Lines in the book text after the license header and footer are removed. All line numbers refer to this text."),
  chapter_count: z.number(),
  chapters: z
    .array(
      z.object({
        index: z.number().describe("Pass as read_passage's chapter."),
        label: z.string().describe('Heading as printed, normalized, e.g. "CHAPTER 12" or "STAVE III".'),
        title: z.string().optional(),
        part: z.string().optional().describe('Enclosing book, part or act, e.g. "BOOK THE SECOND".'),
        start_line: z.number(),
        end_line: z.number(),
      }),
    )
    .describe("Detected table of contents with line offsets. Empty when the book has no recognizable headings."),
  url: z.string(),
  attribution: attributionOutput,
  note: z.string().optional(),
};

/** Once the text is in, wait at most this long for the catalog before answering from the file header. */
export const META_GRACE_MS = 3_000;

export async function getBook(client: GutenbergClient, args: { id: number }, graceMs = META_GRACE_MS) {
  const metaP = client.getMeta(args.id);
  metaP.catch(() => {}); // a late failure is fine; the result is cached on success
  const bookR = await settle(client.getBook(args.id));
  const metaR = await settle(bookR.status === "fulfilled" ? withGrace(metaP, graceMs) : metaP);
  const meta = metaR.status === "fulfilled" ? metaR.value : undefined;
  const book = bookR.status === "fulfilled" ? bookR.value : undefined;

  if (!book) {
    const textErr = (bookR as PromiseRejectedResult).reason;
    // A real catalog entry with no usable text: still worth returning the metadata.
    if (meta && textErr instanceof GutenbergError && ["no_text", "not_found", "too_large"].includes(textErr.code)) {
      return ok({ ...metaFields(args.id, meta), line_count: 0, chapter_count: 0, chapters: [], url: bookUrl(args.id), attribution: credit(args.id, meta), note: textErr.message });
    }
    const metaErr = metaR.status === "rejected" ? metaR.reason : undefined;
    throw metaErr instanceof GutenbergError && metaErr.status === 404 ? metaErr : textErr;
  }

  const fields = meta ? metaFields(args.id, meta) : headerFields(book);
  const notes: string[] = [];
  if (!meta) notes.push("The catalog (Gutendex) did not answer in time, so title and author come from the book file and subjects are missing. Calling get_book again later may fill them in.");
  if (!book.stripped) notes.push("License markers were not found, so the text may include some Project Gutenberg boilerplate.");
  if (book.chapters.length === 0) notes.push("No chapter headings were detected. Use read_passage with start_line, or find_in_book.");
  if (book.chapters.length > MAX_TOC_ENTRIES) notes.push(`Showing the first ${MAX_TOC_ENTRIES} of ${book.chapters.length} headings.`);

  return ok({
    ...fields,
    ...(book.header.release_date ? { release_date: book.header.release_date } : {}),
    line_count: book.lineCount,
    chapter_count: book.chapters.length,
    chapters: book.chapters.slice(0, MAX_TOC_ENTRIES),
    url: bookUrl(args.id),
    attribution: book.attribution({ title: fields.title, author: fields.authors[0] }),
    ...(notes.length ? { note: notes.join(" ") } : {}),
  });
}

function metaFields(id: number, m: GutendexBook) {
  return {
    id,
    title: m.title,
    authors: (m.authors ?? []).map((a) => displayName(a.name)),
    languages: m.languages ?? [],
    subjects: m.subjects ?? [],
    bookshelves: (m.bookshelves ?? []).map((s) => s.replace(/^Category: /, "")),
    ...(m.summaries?.[0] ? { summary: truncate(m.summaries[0].replace(/\s*\(This is an automatically generated summary\.\)\s*$/, ""), 600) } : {}),
    download_count: m.download_count,
    metadata_source: "gutendex" as const,
  };
}

function headerFields(book: Book) {
  return {
    id: book.id,
    title: book.header.title ?? `eBook #${book.id}`,
    authors: book.header.author ? [book.header.author] : [],
    languages: book.header.language ? [book.header.language] : [],
    subjects: [],
    bookshelves: [],
    metadata_source: "text_header" as const,
  };
}

function credit(id: number, m: GutendexBook) {
  const author = m.authors?.[0] ? displayName(m.authors[0].name) : undefined;
  return creditLine(id, m.title, author);
}

const bookUrl = (id: number) => `https://www.gutenberg.org/ebooks/${id}`;

export const getBookDescription =
  "Get one Project Gutenberg book's metadata (title, authors, languages, subjects, summary) and its table of contents: every detected chapter, letter, stave, act or scene with start and end line numbers. Call this before read_passage to pick a chapter.";
