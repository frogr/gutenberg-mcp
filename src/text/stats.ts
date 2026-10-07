/**
 * Plain-arithmetic book statistics. No model, no network: the same text always
 * gives the same numbers.
 */
import type { ChapterEntry } from "./chapters.js";
import type { Tokens } from "./normalize.js";

/**
 * Common English function words, plus the archaic forms that crowd the top of
 * older books ("thee", "hath", "upon") and the honorifics that dominate novels of
 * manners ("mr", "mrs"). Character names and content words are kept.
 */
export const STOPWORDS = new Set(
  (
    "a about above after again against all almost also am among an and any are aren't as at " +
    "be because been before being below between both but by can can't cannot could couldn't " +
    "did didn't do does doesn't doing don't down during each either else ever every few for from further " +
    "had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's " +
    "i i'd i'll i'm i've if in into is isn't it it's its itself just let's like made make may me might more most much must mustn't my myself " +
    "neither never no nor not now o of off often oh on once one only or other ought our ours ourselves out over own " +
    "quite rather said same say says shall shan't she she'd she'll she's should shouldn't since so some such " +
    "than that that's the their theirs them themselves then there there's these they they'd they'll they're they've " +
    "this those though through thus till to too under until up upon us very was wasn't we we'd we'll we're we've were weren't " +
    "what what's when when's where where's whether which while who who's whom whose why why's will with within without won't would wouldn't " +
    "yet you you'd you'll you're you've your yours yourself yourselves " +
    "thee thou thy thine ye hath doth art shalt wilt hast dost unto 'tis whilst " +
    "mr mrs st chapter"
  ).split(" "),
);

const ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|St|Messrs|Mme|Mlle|Jr|Sr|Capt|Col|Gen|Lt|Rev|Prof|Hon|vol|viz|etc|i\.e|e\.g|No|[A-Z])\.$/;

/** Rough sentence count: terminal punctuation followed by a capital, a quote or the end. */
export function countSentences(text: string): number {
  let count = 0;
  const re = /[.!?]+["'’”)\]]*(?=\s+["'‘“(\[_]*[A-Z0-9]|\s*$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].startsWith(".") && ABBREVIATIONS.test(text.slice(Math.max(0, m.index - 8), m.index + 1))) continue;
    count++;
  }
  return count;
}

export interface BookStats {
  word_count: number;
  unique_words: number;
  /** unique_words / word_count, a rough measure of vocabulary range (falls as books get longer). */
  type_token_ratio: number;
  sentence_count: number;
  avg_sentence_length_words: number;
  avg_word_length_chars: number;
  /** At 238 words per minute, a commonly cited average for silent reading of English prose. */
  reading_time_minutes: number;
  top_words: Array<{ word: string; count: number }>;
  chapter_count: number;
  longest_chapter?: { index: number; label: string; title?: string; word_count: number };
  shortest_chapter?: { index: number; label: string; title?: string; word_count: number };
}

export const READING_WPM = 238;

export function computeStats(tokens: Tokens, flatText: string, chapters: ChapterEntry[], topN = 20): BookStats {
  const counts = new Map<string, number>();
  let chars = 0;
  for (const w of tokens.words) {
    counts.set(w, (counts.get(w) ?? 0) + 1);
    chars += w.length;
  }
  const wordCount = tokens.words.length;
  const top = [...counts.entries()]
    .filter(([w]) => !STOPWORDS.has(w) && !/^\d+$/.test(w) && w.length > 1)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, topN)
    .map(([word, count]) => ({ word, count }));

  const sentences = countSentences(flatText);

  const perChapter = new Map<number, number>();
  if (chapters.length) {
    // Walk the words in order; chapter boundaries are sorted, so this is linear.
    let ci = -1;
    for (let i = 0; i < tokens.lineOf.length; i++) {
      const line = tokens.lineOf[i]!;
      while (ci + 1 < chapters.length && chapters[ci + 1]!.start_line <= line) ci++;
      if (ci >= 0) perChapter.set(ci, (perChapter.get(ci) ?? 0) + 1);
    }
  }
  const ranked = chapters
    .map((c, i) => ({ index: c.index, label: c.label, ...(c.title ? { title: c.title } : {}), word_count: perChapter.get(i) ?? 0 }))
    .sort((a, b) => b.word_count - a.word_count);

  return {
    word_count: wordCount,
    unique_words: counts.size,
    type_token_ratio: wordCount ? round(counts.size / wordCount, 4) : 0,
    sentence_count: sentences,
    avg_sentence_length_words: sentences ? round(wordCount / sentences, 1) : 0,
    avg_word_length_chars: wordCount ? round(chars / wordCount, 2) : 0,
    reading_time_minutes: Math.round(wordCount / READING_WPM),
    top_words: top,
    chapter_count: chapters.length,
    ...(ranked.length ? { longest_chapter: ranked[0]!, shortest_chapter: ranked[ranked.length - 1]! } : {}),
  };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
