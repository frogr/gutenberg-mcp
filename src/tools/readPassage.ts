import { z } from "zod";
import type { GutenbergClient } from "../gutenberg.js";
import { chapterAt } from "../text/chapters.js";
import { attributionOutput, bookIdInput, chapterRef, numberLines, ok, ToolInputError } from "./common.js";

export const MAX_LINES = 200;

export const readPassageInput = {
  id: bookIdInput,
  chapter: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Chapter index from get_book's chapter list. Reading starts at its heading. Use this or start_line, not both."),
  start_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based line to start at (line numbers from get_book, find_in_book or a previous read_passage). Default 1."),
  max_lines: z
    .number()
    .int()
    .min(1)
    .max(MAX_LINES)
    .default(80)
    .describe(`Lines to return (1-${MAX_LINES}, default 80). Blank lines count. When a chapter is given, reading stops at its end.`),
};

export const readPassageOutput = {
  id: z.number(),
  title: z.string().optional(),
  chapter: chapterRef.optional().describe("Chapter containing start_line."),
  start_line: z.number(),
  end_line: z.number(),
  total_lines: z.number(),
  text: z.string().describe('The passage, one book line per row, each prefixed with its line number ("  813  CHAPTER 1. Loomings.").'),
  next_start_line: z.number().nullable().describe("Pass as start_line to keep reading; null at the end of the book."),
  chapter_end_line: z.number().optional().describe("Last line of the current chapter."),
  attribution: attributionOutput,
};

type Args = { id: number; chapter?: number; start_line?: number; max_lines: number };

export async function readPassage(client: GutenbergClient, args: Args) {
  if (args.chapter !== undefined && args.start_line !== undefined) {
    throw new ToolInputError("Pass chapter or start_line, not both. To continue inside a chapter, use start_line = the previous next_start_line.");
  }
  const book = await client.getBook(args.id);
  const total = book.lineCount;

  let start: number;
  let stop: number;
  if (args.chapter !== undefined) {
    const ch = book.chapters[args.chapter - 1];
    if (!ch) {
      throw new ToolInputError(
        book.chapters.length
          ? `This book has ${book.chapters.length} detected chapters; chapter must be 1-${book.chapters.length}. Call get_book to see them.`
          : "No chapters were detected in this book. Use start_line instead (the book has " + total + " lines).",
      );
    }
    start = ch.start_line;
    stop = Math.min(ch.end_line, start + args.max_lines - 1);
  } else {
    start = args.start_line ?? 1;
    if (start > total) throw new ToolInputError(`start_line ${start} is past the end of the book (${total} lines).`);
    stop = Math.min(total, start + args.max_lines - 1);
  }

  const chapter = chapterAt(book.chapters, start);
  const next = stop < total ? stop + 1 : null;
  return ok({
    id: book.id,
    ...(book.header.title ? { title: book.header.title } : {}),
    ...(chapter ? { chapter: { index: chapter.index, label: chapter.label, ...(chapter.title ? { title: chapter.title } : {}), ...(chapter.part ? { part: chapter.part } : {}) } } : {}),
    start_line: start,
    end_line: stop,
    total_lines: total,
    text: numberLines(book.lines.slice(start - 1, stop), start),
    next_start_line: next,
    ...(chapter ? { chapter_end_line: chapter.end_line } : {}),
    attribution: book.attribution(),
  });
}

export const readPassageDescription =
  `Read a Project Gutenberg book by chapter or by line number, up to ${MAX_LINES} lines per call. Lines come back numbered so you can cite them, with next_start_line for paging. The license header and footer are already removed.`;
