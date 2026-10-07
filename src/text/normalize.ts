/**
 * Text normalization that keeps a map back to the original line numbers, so a match
 * found in normalized text can be reported as "lines 846-847" of the book.
 *
 * Levels (each includes the ones before it):
 *   whitespace  line breaks and runs of spaces become one space (always on)
 *   typography  curly quotes -> straight, every dash -> "-", "…" -> "...", _italics_ markers removed,
 *               spaces around dashes removed ("ago — never" == "ago--never" == "ago-never")
 *   caseFold    lowercase
 *   punctuation everything that is not a letter or digit becomes a space
 */

export interface NormOptions {
  typography?: boolean;
  caseFold?: boolean;
  punctuation?: boolean;
}

export interface Normalized {
  text: string;
  /**
   * lineStarts[i] is the offset in `text` where source line i + 1 begins.
   * Non-decreasing; a blank line shares its offset with the next line. Map back with lineAt().
   * (One int per line instead of one per character keeps a 1 MB book's index small.)
   */
  lineStarts: Int32Array;
}

const SINGLE_QUOTES = new Set(["‘", "’", "‚", "‛", "′", "ʼ", "`", "´"]);
const DOUBLE_QUOTES = new Set(["“", "”", "„", "‟", "″", "«", "»"]);
const DASHES = new Set(["-", "‐", "‑", "‒", "–", "—", "―", "−", "⸺", "⸻"]);
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;

function mapChar(ch: string, o: NormOptions): string {
  if (SPACE.test(ch)) return " ";
  if (o.typography) {
    if (SINGLE_QUOTES.has(ch)) ch = "'";
    else if (DOUBLE_QUOTES.has(ch)) ch = '"';
    else if (DASHES.has(ch)) ch = "-";
    else if (ch === "…") ch = "...";
    else if (ch === "_") return "";
  }
  if (o.punctuation && !LETTER_OR_DIGIT.test(ch)) return " ";
  if (o.caseFold) ch = ch.toLowerCase();
  return ch;
}

class Builder {
  private out: string[] = [];
  constructor(private readonly o: NormOptions) {}

  get length() {
    return this.out.length;
  }

  push(c: string) {
    const out = this.out;
    const last = out[out.length - 1];
    if (c === " ") {
      if (out.length === 0 || last === " ") return;
      if (this.o.typography && last === "-") return;
    } else if (this.o.typography && c === "-") {
      if (last === " ") out.pop();
      if (out[out.length - 1] === "-") return;
    }
    out.push(c);
  }

  done(): string {
    if (this.out[this.out.length - 1] === " ") this.out.pop();
    return this.out.join("");
  }
}

export function normalizeLines(lines: string[], o: NormOptions): Normalized {
  const b = new Builder(o);
  const starts = new Int32Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    starts[i] = b.length;
    for (const ch of lines[i]!) for (const c of mapChar(ch, o)) b.push(c);
    b.push(" ");
  }
  const text = b.done();
  for (let i = 0; i < starts.length; i++) if (starts[i]! > text.length) starts[i] = text.length;
  return { text, lineStarts: starts };
}

/** 1-based source line holding offset `pos` of the normalized text. */
export function lineAt(n: Normalized, pos: number): number {
  const s = n.lineStarts;
  let lo = 0;
  let hi = s.length - 1;
  // Last line whose start is <= pos. Blank lines share an offset with the line after
  // them, so taking the last one lands on the line that holds the text.
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function normalizeString(s: string, o: NormOptions): string {
  return normalizeLines([s], o).text;
}

/** All start offsets of needle in haystack (non-overlapping), up to a cap. */
export function findAll(haystack: string, needle: string, cap = Number.POSITIVE_INFINITY): { positions: number[]; total: number } {
  const positions: number[] = [];
  let total = 0;
  if (!needle) return { positions, total };
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    total++;
    if (positions.length < cap) positions.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return { positions, total };
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

/** Lowercased word tokens with straight apostrophes, e.g. "Ishmael’s" -> "ishmael's". */
export function words(s: string): string[] {
  return (s.match(WORD_RE) ?? []).map((w) => w.toLowerCase().replace(/’/g, "'"));
}

export interface Tokens {
  words: string[];
  /** 1-based line of each word. */
  lineOf: Int32Array;
}

export function tokenizeLines(lines: string[]): Tokens {
  const out: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const w of words(lines[i]!.replace(/_/g, ""))) {
      out.push(w);
      map.push(i + 1);
    }
  }
  return { words: out, lineOf: Int32Array.from(map) };
}
