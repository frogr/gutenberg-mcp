import { z } from "zod";
import type { GutenbergClient } from "../gutenberg.js";
import { READING_WPM } from "../text/stats.js";
import { attributionOutput, bookIdInput, ok } from "./common.js";

export const bookStatsInput = {
  id: bookIdInput,
  top_n: z.number().int().min(5).max(50).default(20).describe("How many most-frequent words to list (5-50, default 20)."),
};

const chapterSize = z.object({ index: z.number(), label: z.string(), title: z.string().optional(), word_count: z.number() });

export const bookStatsOutput = {
  id: z.number(),
  title: z.string().optional(),
  line_count: z.number(),
  word_count: z.number(),
  unique_words: z.number().describe("Distinct lowercased word forms."),
  type_token_ratio: z.number().describe("unique_words / word_count. Falls naturally as books get longer, so compare books of similar length."),
  sentence_count: z.number().describe("Approximate: ends of sentences found by punctuation, skipping common abbreviations like Mr."),
  avg_sentence_length_words: z.number(),
  avg_word_length_chars: z.number(),
  reading_time_minutes: z.number().describe(`At ${READING_WPM} words per minute.`),
  top_words: z.array(z.object({ word: z.string(), count: z.number() })).describe("Most frequent words, excluding English function words, Mr/Mrs and numbers."),
  chapter_count: z.number(),
  longest_chapter: chapterSize.optional(),
  shortest_chapter: chapterSize.optional(),
  attribution: attributionOutput,
  note: z.string().optional(),
};

export async function bookStats(client: GutenbergClient, args: { id: number; top_n: number }) {
  const book = await client.getBook(args.id);
  const s = book.stats();
  const lang = book.header.language?.toLowerCase();
  return ok({
    id: book.id,
    ...(book.header.title ? { title: book.header.title } : {}),
    line_count: book.lineCount,
    ...s,
    top_words: s.top_words.slice(0, args.top_n),
    attribution: book.attribution(),
    ...(lang && lang !== "english"
      ? { note: `This book is in ${book.header.language}. The stopword list is English, so top_words will include common function words.` }
      : {}),
  });
}

export const bookStatsDescription =
  "Compute statistics for a Project Gutenberg book: word count, unique words, average sentence and word length, reading time, most frequent content words, and the longest and shortest chapters. Deterministic counting, no model involved.";
