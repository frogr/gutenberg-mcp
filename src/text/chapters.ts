/**
 * Heuristic table-of-contents detection for plain-text books.
 *
 * 1. Candidate headings: short lines, preceded by a blank line, that start with a
 *    structural keyword plus a number ("CHAPTER XII.", "Chapter 3: The Ball",
 *    "BOOK THE FIRST", "Stave One"), that are a Roman numeral plus an ALL CAPS
 *    title ("IV. THE BOSCOMBE VALLEY MYSTERY") or alone with a title on the next
 *    line ("I" / "The Old Sea-dog at the Admiral Benbow"), or that are a bare section word
 *    ("PREFACE", "Epilogue", "ETYMOLOGY.") followed by a blank line. (In plays,
 *    "PROLOGUE." with a speech right under it is a character name.)
 * 2. Printed contents lists are dropped: a run of 3+ candidates with no body text
 *    between them is a contents page, not the book's structure (except its last
 *    heading when real text follows it).
 * 3. Book, part, volume and act headings group what follows, so "CHAPTER I" in
 *    Book 2 is reported with part "BOOK THE SECOND" and is not a duplicate of
 *    "CHAPTER I" in Book 1.
 * 4. If the same heading appears twice, the later copy wins (the earlier one is a
 *    contents entry or a caption). If only the earlier copy had a title, the kept
 *    heading borrows it, so "CHAPTER I" becomes "CHAPTER I: Loomings".
 */

export interface ChapterEntry {
  /** 1-based position in the detected table of contents. Pass to read_passage as `chapter`. */
  index: number;
  /** Normalized heading, e.g. "CHAPTER XII". */
  label: string;
  /** Text after the number, if any, e.g. "Loomings". */
  title?: string;
  /** Enclosing book, part, volume or act, e.g. "BOOK THE SECOND". */
  part?: string;
  /** 1-based line of the heading in the stripped text. */
  start_line: number;
  /** Last non-blank line before the next heading (or the end of the book). */
  end_line: number;
}

const KEYWORD = "chapter|book|part|volume|act|scene|stave|letter|canto|section|chap\\.";
const GROUPING = new Set(["BOOK", "PART", "VOLUME", "ACT"]);
const NUMBER_WORDS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred";
const ORDINALS =
  "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|last|final";
const NUMBER = `(?:[IVXLCDM]+|\\d{1,4}|(?:the\\s+)?(?:${ORDINALS})|(?:${NUMBER_WORDS})(?:[-\\s](?:${NUMBER_WORDS}))?)`;

const NUMBERED_RE = new RegExp(`^\\s*(${KEYWORD})\\s+(${NUMBER})\\b(\\.?\\]?(?:\\s*[.:—–-]+\\s*|\\s+)?)(.*)$`, "i");
const ROMAN_TITLE_RE = /^\s*([IVXLC]+)\.\s+([A-Z][A-Z0-9 ,;:'’“”"!?&.—–-]{2,80})$/;
const BARE_ROMAN_RE = /^\s*([IVXLC]+)\.?\s*$/;
const STANDALONE_RE =
  /^\s*(?:the\s+)?(preface|prologue|epilogue|introduction|foreword|afterword|conclusion|appendix|etymology|extracts|dedication|postscript|finale)\b\.?\s*(\(.{0,60}\))?\.?\s*$/i;

const MAX_HEADING_LENGTH = 90;
/** A heading needs this many non-blank lines under it to count as the start of real text. */
const MIN_SECTION_LINES = 8;

interface Candidate {
  line: number; // 0-based
  label: string;
  title?: string;
  grouping: boolean;
  part?: string;
}

export function matchHeading(line: string): { label: string; title?: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_HEADING_LENGTH) return null;

  const m = NUMBERED_RE.exec(trimmed);
  if (m) {
    const keyword = m[1]!;
    // Mixed-case prose like "book two was..." is not a heading; require caps or Title Case keyword.
    if (keyword !== keyword.toUpperCase() && keyword[0] !== keyword[0]!.toUpperCase()) return null;
    const number = m[2]!.replace(/\s+/g, " ").toUpperCase();
    // Reject Roman-looking English words like "MIX", "DID".
    if (/^[IVXLCDM]+$/.test(number) && !isRoman(number)) return null;
    const separator = m[3] ?? "";
    const title = cleanTitle(m[4] ?? "");
    // "Chapter 3 he wrote" style prose: a lowercase word right after the number is a sentence.
    // ("Book the Second--the Golden Thread" is fine: the dashes mark a title.)
    if (title && /^[a-z]/.test(title) && !/[.:—–-]/.test(separator)) return null;
    // "BOOK I. (Folio), CHAPTER I. (Sperm Whale)": a parenthetical sub-section inside prose.
    if (title.startsWith("(")) return null;
    return { label: `${keyword.toUpperCase().replace(/\.$/, "")} ${number}`, ...(title ? { title } : {}) };
  }

  const r = ROMAN_TITLE_RE.exec(trimmed);
  if (r && isRoman(r[1]!) && /[A-Z]{2}/.test(r[2]!)) {
    return { label: r[1]!, title: cleanTitle(r[2]!) };
  }

  const s = STANDALONE_RE.exec(trimmed);
  if (s) {
    const word = s[1]!;
    if (word !== word.toUpperCase() && word[0] !== word[0]!.toUpperCase()) return null;
    const extra = s[2]?.replace(/^\(|\)$/g, "").trim();
    return { label: word.toUpperCase(), ...(extra ? { title: extra } : {}) };
  }
  return null;
}

/**
 * A Roman numeral alone on a line, with a short title on the very next line
 * ("I" / "The Old Sea-dog at the Admiral Benbow"). A numeral followed by a blank
 * line is usually a section break inside a chapter, so it is not counted.
 */
function bareRomanHeading(line: string, next: string | undefined): { label: string; title?: string } | null {
  const m = BARE_ROMAN_RE.exec(line);
  if (!m || !isRoman(m[1]!)) return null;
  const title = next?.trim() ?? "";
  if (title.length < 2 || title.length > 70 || !/^["“‘'A-Z]/.test(title) || /[,;]$/.test(title)) return null;
  return { label: m[1]!, title: cleanTitle(title) };
}

function romanSequence(lines: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i - 1]!.trim() !== "") continue;
    const m = BARE_ROMAN_RE.exec(lines[i]!);
    if (!m || !isRoman(m[1]!) || romanValue(m[1]!) !== out.length + 1) continue;
    const titled = bareRomanHeading(lines[i]!, lines[i + 1]);
    out.push({ line: i, label: m[1]!, ...(titled?.title ? { title: titled.title } : {}), grouping: false });
  }
  return out;
}

function romanValue(s: string): number {
  const v: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = v[s[i]!]!;
    const next = v[s[i + 1] ?? ""] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/[\][_*]/g, "")
    .replace(/\s+\d+\s*$/, "") // trailing page number in printed contents lists
    .replace(/^[.:—–\-\s]+|[.\s]+$/g, "")
    .trim();
}

function isRoman(s: string): boolean {
  return s.length > 0 && /^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(s);
}

export function detectChapters(lines: string[]): ChapterEntry[] {
  const candidates: Candidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const prevBlank = i === 0 || lines[i - 1]!.trim() === "";
    if (!prevBlank) continue;
    const h = matchHeading(lines[i]!) ?? bareRomanHeading(lines[i]!, lines[i + 1]);
    // A bare word like "PROLOGUE." with text right under it is a speaker in a play, not a heading.
    if (h && STANDALONE_RE.test(lines[i]!) && (lines[i + 1] ?? "").trim() !== "") continue;
    if (h) candidates.push({ line: i, ...h, grouping: GROUPING.has(h.label.split(" ")[0]!) });
  }

  const bodyLines = (a: number, b: number) => {
    let n = 0;
    for (let i = a + 1; i < b; i++) if (lines[i]!.trim() !== "") n++;
    return n;
  };

  // Attach each heading to the book/part/act above it.
  const assignParts = (list: Candidate[]) => {
    let part: string | undefined;
    for (const c of list) {
      if (c.grouping) part = c.label;
      else if (part) c.part = part;
      else delete c.part;
    }
  };
  assignParts(candidates);

  // Drop printed contents lists: runs of >= 3 headings with no body text between them.
  const keep = new Array(candidates.length).fill(true);
  let runStart = 0;
  for (let i = 1; i <= candidates.length; i++) {
    const continues = i < candidates.length && bodyLines(candidates[i - 1]!.line, candidates[i]!.line) === 0;
    if (!continues) {
      if (i - runStart >= 3) {
        for (let j = runStart; j < i; j++) keep[j] = false;
        // The run may end where the contents list meets the real text ("Book the First",
        // then "CHAPTER I." and its prose). Keep that last heading, plus the book/part
        // headings right above it; any contents copies are removed by the duplicate rule below.
        const last = i - 1;
        const nextLine = i < candidates.length ? candidates[i]!.line : lines.length;
        if (bodyLines(candidates[last]!.line, nextLine) >= MIN_SECTION_LINES) {
          keep[last] = true;
          for (let j = last - 1; j >= runStart && candidates[j]!.grouping; j--) keep[j] = true;
        }
      }
      runStart = i;
    }
  }
  // A heading with no title borrows one from an earlier copy of itself (often the
  // contents entry), matched by part and label.
  const key = (c: Candidate) => `${c.part ?? ""}|${c.label}`;
  const titles = new Map<string, string>();
  for (const c of candidates) {
    if (c.title) titles.set(key(c), c.title);
    else if (titles.has(key(c))) c.title = titles.get(key(c));
  }
  let kept = candidates.filter((_, i) => keep[i]);

  // A book/part/act heading printed twice: the later copy is the real one.
  const lastGroup = new Map<string, Candidate>();
  for (const c of kept) if (c.grouping) lastGroup.set(c.label, c);
  kept = kept.filter((c) => !c.grouping || lastGroup.get(c.label) === c);
  // Parts again, now without contents copies, so a contents page's "ACT V" does not
  // become the part of a prologue that comes before the real "ACT I".
  assignParts(kept);

  // Any other heading printed twice: the later copy wins. An earlier copy with no part
  // (a contents entry) also loses to a later one in a part.
  const seenKeys = new Set<string>();
  const seenLabels = new Set<string>();
  const keepLast: Candidate[] = [];
  for (let i = kept.length - 1; i >= 0; i--) {
    const c = kept[i]!;
    if (!c.grouping) {
      if (seenKeys.has(key(c)) || (!c.part && seenLabels.has(c.label))) continue;
      seenKeys.add(key(c));
      seenLabels.add(c.label);
    }
    keepLast.push(c);
  }
  kept = keepLast.reverse();

  // Short works often number their parts with a bare "I", "II", "III" and nothing else.
  // Those numerals are too common inside chapters to trust on their own, so they are
  // only used when nothing else was found, and only as an unbroken I, II, III... sequence.
  if (kept.length < 3) {
    const numerals = romanSequence(lines);
    if (numerals.length >= 2) kept = numerals;
  }

  return kept.map((c, i) => {
    const next = kept[i + 1];
    let end = next ? next.line - 1 : lines.length - 1;
    while (end > c.line && lines[end]!.trim() === "") end--;
    return {
      index: i + 1,
      label: c.label,
      ...(c.title ? { title: c.title } : {}),
      ...(c.part ? { part: c.part } : {}),
      start_line: c.line + 1,
      end_line: end + 1,
    };
  });
}

/** The chapter that contains a 1-based line, if any. */
export function chapterAt(chapters: ChapterEntry[], line: number): ChapterEntry | undefined {
  let found: ChapterEntry | undefined;
  for (const c of chapters) {
    if (c.start_line <= line) found = c;
    else break;
  }
  return found;
}
