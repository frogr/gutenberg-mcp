import { z } from "zod";
import type { Book } from "../book.js";
import type { GutenbergClient } from "../gutenberg.js";
import { chapterAt } from "../text/chapters.js";
import { lineAt, normalizeString, words, type NormOptions } from "../text/normalize.js";
import { STOPWORDS } from "../text/stats.js";
import { attributionOutput, bookIdInput, chapterRef, numberLines, ok, ToolInputError } from "./common.js";

/**
 * Levels from strictest to loosest. The first one that matches is reported, so the
 * answer says both "is it there" and "how faithful is your copy".
 */
const LEVELS = [
  { id: "exact", norm: {}, label: "Verbatim: the quote appears exactly as given (only line breaks and spacing differ)." },
  { id: "typography", norm: { typography: true }, label: "Verbatim apart from typography: quote marks, apostrophes, dashes or _italic_ markers differ." },
  { id: "case", norm: { typography: true, caseFold: true }, label: "Same text, different capitalization." },
  { id: "words", norm: { typography: true, caseFold: true, punctuation: true }, label: "Same words in the same order, but the punctuation differs (commas, periods, hyphens)." },
] as const satisfies ReadonlyArray<{ id: string; norm: NormOptions; label: string }>;

type LevelId = (typeof LEVELS)[number]["id"];

/** Parts of a quote joined by an ellipsis must appear in order, within this many characters of each other. */
const MAX_GAP = 1500;
const MAX_LOCATIONS = 5;
const MAX_EXCERPT_LINES = 12;
const MIN_CLOSEST_OVERLAP = 0.5;

export const quoteCheckInput = {
  id: bookIdInput,
  quote: z
    .string()
    .min(3)
    .max(2000)
    .describe('The quotation to verify, e.g. "Call me Ishmael." Surrounding quote marks are ignored. Use "..." for omitted words.'),
  case_sensitive: z.boolean().default(false).describe("Require matching capitalization. Default false."),
};

export const quoteCheckOutput = {
  id: z.number(),
  quote: z.string(),
  found: z.boolean(),
  match: z
    .enum(["exact", "typography", "case", "words", "none"])
    .describe("Strictest level that matched: exact > typography (quote/dash style) > case > words (punctuation differs) > none."),
  verdict: z.string().describe("One sentence explaining the result."),
  occurrences: z.number(),
  locations: z.array(
    z.object({
      start_line: z.number(),
      end_line: z.number(),
      chapter: chapterRef.optional(),
      text: z.string().describe("The book's actual lines, numbered. Quote from this, not from memory."),
    }),
  ),
  closest: z
    .object({
      start_line: z.number(),
      end_line: z.number(),
      chapter: chapterRef.optional(),
      shared_words: z.number(),
      quote_words: z.number(),
      missing_words: z.array(z.string()).describe("Quote words not present in this passage."),
      text: z.string(),
    })
    .optional()
    .describe("When not found: the passage sharing the most words with the quote (at least half), to show what the text really says."),
  attribution: attributionOutput,
};

type Args = { id: number; quote: string; case_sensitive: boolean };

/** Strip wrapping quote marks and whitespace: “Call me Ishmael.” -> Call me Ishmael. */
export function cleanQuote(q: string): string {
  return q.trim().replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "").trim();
}

/** Split on ellipses into the parts that must appear in order. */
export function quoteSegments(q: string): string[] {
  return q
    .split(/\s*(?:\.\s?\.\s?\.|…)\s*/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const isWordChar = (c: string | undefined) => c !== undefined && WORD_CHAR.test(c);

/**
 * Occurrences of all segments in order, each within MAX_GAP of the previous. Returns [start, end) offsets.
 * A match may not start or end in the middle of a word, so "all me Ishmael" does not match "Call me Ishmael".
 */
export function findSegments(hay: string, segs: string[], cap = Infinity): { spans: Array<[number, number]>; total: number } {
  const spans: Array<[number, number]> = [];
  let total = 0;
  const first = segs[0]!;
  const last = segs[segs.length - 1]!;
  let from = 0;
  for (let i = hay.indexOf(first); i !== -1; i = hay.indexOf(first, Math.max(i + 1, from))) {
    if (isWordChar(first[0]) && isWordChar(hay[i - 1])) continue;
    let end = i + first.length;
    let okAll = true;
    for (const seg of segs.slice(1)) {
      const j = hay.indexOf(seg, end);
      if (j === -1 || j - end > MAX_GAP) {
        okAll = false;
        break;
      }
      end = j + seg.length;
    }
    if (!okAll) continue;
    if (isWordChar(last[last.length - 1]) && isWordChar(hay[end])) continue;
    total++;
    if (spans.length < cap) spans.push([i, end]);
    from = end; // occurrences do not overlap
  }
  return { spans, total };
}

export async function quoteCheck(client: GutenbergClient, args: Args) {
  const quote = cleanQuote(args.quote);
  const rawSegs = quoteSegments(quote);
  if (rawSegs.length === 0) throw new ToolInputError("quote needs some letters or digits.");

  const book = await client.getBook(args.id);
  const levels = args.case_sensitive ? LEVELS.slice(0, 2) : LEVELS;

  for (const level of levels) {
    const segs = rawSegs.map((s) => normalizeString(s, level.norm)).filter((s) => s.trim());
    if (!segs.length) continue;
    const norm = book.normalized(level.norm);
    const { spans, total } = findSegments(norm.text, segs, MAX_LOCATIONS);
    if (total === 0) continue;
    const locations = spans.map(([s, e]) => locate(book, lineAt(norm, s), lineAt(norm, Math.max(s, e - 1))));
    return ok({
      id: book.id,
      quote: args.quote,
      found: true,
      match: level.id as LevelId,
      verdict: `${level.label}${total > 1 ? ` It appears ${total} times.` : ""}`,
      occurrences: total,
      locations,
      attribution: book.attribution(),
    });
  }

  const closest = closestPassage(book, quote);
  return ok({
    id: book.id,
    quote: args.quote,
    found: false,
    match: "none" as const,
    verdict: closest
      ? `Not in this book. The closest passage (${lineRange(closest.start_line, closest.end_line)}) shares ${closest.shared_words} of ${closest.quote_words} words.`
      : "Not in this book, and no passage shares even half of the quote's words. It may be from another work, a paraphrase, or a misattribution.",
    occurrences: 0,
    locations: [],
    ...(closest ? { closest } : {}),
    attribution: book.attribution(),
  });
}

const lineRange = (a: number, b: number) => (a === b ? `line ${a}` : `lines ${a}-${b}`);

function locate(book: Book, start: number, end: number) {
  const ch = chapterAt(book.chapters, start);
  const shownEnd = Math.min(end, start + MAX_EXCERPT_LINES - 1);
  return {
    start_line: start,
    end_line: end,
    ...(ch ? { chapter: { index: ch.index, label: ch.label, ...(ch.title ? { title: ch.title } : {}), ...(ch.part ? { part: ch.part } : {}) } } : {}),
    text: numberLines(book.lines.slice(start - 1, shownEnd), start),
  };
}

/**
 * Slide a window as long as the quote over the book's words and keep the window
 * that shares the most words with it (counting repeats), ranking content words
 * above function words so "it is" alone never wins. Linear in book length.
 */
export function closestPassage(book: Book, quote: string) {
  const q = words(quote.replace(/_/g, ""));
  const k = q.length;
  if (k < 3) return undefined;
  const need = new Map<string, number>();
  for (const w of q) need.set(w, (need.get(w) ?? 0) + 1);
  const contentTotal = q.filter((w) => !STOPWORDS.has(w)).length;
  if (contentTotal === 0) return undefined;

  const { words: bw, lineOf } = book.tokens();
  if (bw.length < k) return undefined;
  const have = new Map<string, number>();
  let shared = 0;
  let sharedContent = 0;
  const step = (w: string, delta: 1 | -1) => {
    const n = need.get(w);
    if (n === undefined) return;
    const before = have.get(w) ?? 0;
    const after = before + delta;
    have.set(w, after);
    // A word counts while the window holds no more copies than the quote does.
    const change = Math.min(after, n) - Math.min(before, n);
    shared += change;
    if (!STOPWORDS.has(w)) sharedContent += change;
  };

  let best = -1;
  let bestAt = 0;
  let bestShared = 0;
  let bestContent = 0;
  for (let i = 0; i < bw.length; i++) {
    step(bw[i]!, 1);
    if (i >= k) step(bw[i - k]!, -1);
    if (i < k - 1) continue;
    const score = sharedContent * 10 + shared;
    if (score > best) {
      best = score;
      bestAt = i - k + 1;
      bestShared = shared;
      bestContent = sharedContent;
    }
  }
  if (bestShared / k < MIN_CLOSEST_OVERLAP || bestContent / contentTotal < MIN_CLOSEST_OVERLAP) return undefined;

  const window = bw.slice(bestAt, bestAt + k);
  const left = new Map<string, number>();
  for (const w of window) left.set(w, (left.get(w) ?? 0) + 1);
  const missing: string[] = [];
  for (const w of q) {
    const n = left.get(w) ?? 0;
    if (n > 0) left.set(w, n - 1);
    else missing.push(w);
  }

  const loc = locate(book, lineOf[bestAt]!, lineOf[bestAt + k - 1]!);
  return {
    start_line: loc.start_line,
    end_line: loc.end_line,
    ...(loc.chapter ? { chapter: loc.chapter } : {}),
    shared_words: bestShared,
    quote_words: k,
    missing_words: missing,
    text: loc.text,
  };
}

export const quoteCheckDescription =
  "Check whether a quotation really appears in a Project Gutenberg book, and how exactly. Reports the strictest match (exact, typography-only differences, case, or punctuation), every location with the book's actual lines, and, when the quote is not there, the closest real passage. Use it before quoting a public-domain book.";
