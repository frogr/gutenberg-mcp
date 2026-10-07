import { z } from "zod";
import type { GutenbergClient } from "../gutenberg.js";
import { chapterAt } from "../text/chapters.js";
import { lineAt, normalizeString, type NormOptions } from "../text/normalize.js";
import { attributionOutput, bookIdInput, chapterRef, numberLines, ok, ToolInputError } from "./common.js";

const SEARCH_NORM: NormOptions = { typography: true, caseFold: true };
const WORD_CHAR = /[\p{L}\p{N}]/u;

export const findInBookInput = {
  id: bookIdInput,
  query: z
    .string()
    .min(2)
    .max(300)
    .describe('Word or phrase to find, e.g. "white whale". Case, curly vs straight quotes, dash style and line breaks are ignored.'),
  whole_word: z.boolean().default(false).describe('Only match whole words ("whale" will not match "whales"). Default false.'),
  max_results: z.number().int().min(1).max(20).default(10).describe("Matches to return with context (1-20, default 10). total_matches always counts all of them."),
  context_lines: z.number().int().min(0).max(5).default(1).describe("Lines of context before and after each match (0-5, default 1)."),
};

export const findInBookOutput = {
  id: z.number(),
  query: z.string(),
  total_matches: z.number(),
  returned: z.number(),
  matches: z.array(
    z.object({
      start_line: z.number(),
      end_line: z.number().describe("Differs from start_line when the phrase wraps across lines."),
      chapter: chapterRef.optional(),
      excerpt: z.string().describe("Numbered lines around the match."),
    }),
  ),
  by_chapter: z
    .array(z.object({ index: z.number(), label: z.string(), title: z.string().optional(), count: z.number() }))
    .describe("Match counts per chapter, in book order (chapters with no matches left out)."),
  attribution: attributionOutput,
  note: z.string().optional(),
};

type Args = { id: number; query: string; whole_word: boolean; max_results: number; context_lines: number };

export async function findInBook(client: GutenbergClient, args: Args) {
  const needle = normalizeString(args.query, SEARCH_NORM);
  if (needle.replace(/[^\p{L}\p{N}]/gu, "").length < 2) throw new ToolInputError("query needs at least two letters or digits.");

  const book = await client.getBook(args.id);
  const norm = book.normalized(SEARCH_NORM);
  const hay = norm.text;

  const hits: number[] = [];
  let total = 0;
  const perChapter = new Map<number, number>();
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
    if (args.whole_word && (isWordChar(hay[i - 1]) || isWordChar(hay[i + needle.length]))) continue;
    total++;
    if (hits.length < args.max_results) hits.push(i);
    const ch = chapterAt(book.chapters, lineAt(norm, i));
    if (ch) perChapter.set(ch.index, (perChapter.get(ch.index) ?? 0) + 1);
  }

  const matches = hits.map((pos) => {
    const start = lineAt(norm, pos);
    const end = lineAt(norm, pos + needle.length - 1);
    const from = Math.max(1, start - args.context_lines);
    const to = Math.min(book.lineCount, end + args.context_lines);
    const ch = chapterAt(book.chapters, start);
    return {
      start_line: start,
      end_line: end,
      ...(ch ? { chapter: { index: ch.index, label: ch.label, ...(ch.title ? { title: ch.title } : {}), ...(ch.part ? { part: ch.part } : {}) } } : {}),
      excerpt: numberLines(book.lines.slice(from - 1, to), from),
    };
  });

  const byChapter = book.chapters
    .filter((c) => perChapter.has(c.index))
    .map((c) => ({ index: c.index, label: c.label, ...(c.title ? { title: c.title } : {}), count: perChapter.get(c.index)! }));

  return ok({
    id: book.id,
    query: args.query,
    total_matches: total,
    returned: matches.length,
    matches,
    by_chapter: byChapter,
    attribution: book.attribution(),
    ...(total === 0
      ? { note: "No matches. Try a shorter phrase or a single distinctive word; spelling in older books can differ (e.g. \"connexion\", \"shew\")." }
      : total > matches.length
        ? { note: `Showing the first ${matches.length} of ${total} matches, in book order. Use by_chapter to see where the rest are.` }
        : {}),
  });
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && WORD_CHAR.test(c);
}

export const findInBookDescription =
  "Find every occurrence of a word or phrase in a Project Gutenberg book. Returns the total count, per-chapter counts, and the first matches with line numbers and surrounding lines. Ignores case, quote style, dash style and line breaks.";
