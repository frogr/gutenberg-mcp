/**
 * A downloaded book, parsed once and shared by every tool:
 * license header/footer stripped, chapters detected, and search indexes built
 * lazily the first time a tool needs them.
 */
import { detectChapters, type ChapterEntry } from "./text/chapters.js";
import { normalizeLines, tokenizeLines, type NormOptions, type Normalized, type Tokens } from "./text/normalize.js";
import { computeStats, type BookStats } from "./text/stats.js";
import { stripBoilerplate, type HeaderMeta } from "./text/strip.js";

export class Book {
  readonly lines: string[];
  readonly chapters: ChapterEntry[];
  readonly header: HeaderMeta;
  /** False when the START/END markers were missing and the whole file was kept. */
  readonly stripped: boolean;
  private readonly norms = new Map<string, Normalized>();
  private tokenCache?: Tokens;
  private statsCache?: BookStats;

  constructor(
    readonly id: number,
    raw: string,
    /** Where the text came from, for the attribution line. */
    readonly sourceUrl: string,
  ) {
    const s = stripBoilerplate(raw);
    this.lines = s.lines;
    this.header = s.header;
    this.stripped = s.stripped;
    this.chapters = detectChapters(this.lines);
  }

  get lineCount(): number {
    return this.lines.length;
  }

  /** Rough memory cost in bytes, for the cache budget: UTF-16 text plus room for indexes. */
  get approxBytes(): number {
    let chars = 0;
    for (const l of this.lines) chars += l.length + 1;
    return chars * 2 * 3;
  }

  normalized(o: NormOptions): Normalized {
    const key = `${o.typography ? "t" : ""}${o.caseFold ? "c" : ""}${o.punctuation ? "p" : ""}`;
    let n = this.norms.get(key);
    if (!n) {
      n = normalizeLines(this.lines, o);
      this.norms.set(key, n);
    }
    return n;
  }

  tokens(): Tokens {
    return (this.tokenCache ??= tokenizeLines(this.lines));
  }

  stats(): BookStats {
    return (this.statsCache ??= computeStats(this.tokens(), this.normalized({ typography: true }).text, this.chapters, 50));
  }

  /** One line of credit to keep next to any quoted text. */
  attribution(meta?: { title?: string; author?: string }): string {
    const title = meta?.title ?? this.header.title;
    const author = meta?.author ?? this.header.author;
    const work = title ? `"${title}"${author ? ` by ${author}` : ""}` : `eBook #${this.id}`;
    return `${work}, from Project Gutenberg (https://www.gutenberg.org/ebooks/${this.id}). Public domain in the USA.`;
  }
}
