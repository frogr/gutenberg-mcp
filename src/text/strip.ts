/**
 * Project Gutenberg plain-text files wrap the book in a license header and footer:
 *
 *   ...license header, Title:, Author:, Release date: ...
 *   *** START OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***
 *   ...the book...
 *   *** END OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***
 *   ...full license text...
 *
 * Older files use "THIS PROJECT GUTENBERG EBOOK", "E-BOOK", missing spaces, or an
 * "End of the Project Gutenberg EBook of ..." line with no asterisks.
 */

const START_RE = /^\s*\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG E-?BOOK\b.*$/i;
const END_RE = /^\s*\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG E-?BOOK\b.*$/i;
const OLD_END_RE = /^\s*End of (?:the )?Project Gutenberg(?:'s|’s)? (?:E-?Book|E-?text|Etext|work)\b/i;

export interface HeaderMeta {
  title?: string;
  author?: string;
  language?: string;
  release_date?: string;
}

export interface StrippedText {
  /** Book body, one entry per line, with leading/trailing blank lines removed. */
  lines: string[];
  /** True when both START and END markers were found and removed. */
  stripped: boolean;
  /** Fields parsed from the license header (useful when the catalog API is down). */
  header: HeaderMeta;
}

export function normalizeNewlines(raw: string): string {
  return raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

export function parseHeader(headerLines: string[]): HeaderMeta {
  const meta: HeaderMeta = {};
  const field = (name: string) => {
    const re = new RegExp(`^${name}:\\s*(.+)$`, "i");
    for (const line of headerLines) {
      const m = re.exec(line.trim());
      if (m) return m[1]!.trim();
    }
    return undefined;
  };
  meta.title = field("Title");
  meta.author = field("Author");
  meta.language = field("Language");
  meta.release_date = field("Release date")?.replace(/\s*\[.*$/, "");
  for (const k of Object.keys(meta) as (keyof HeaderMeta)[]) if (!meta[k]) delete meta[k];
  return meta;
}

export function stripBoilerplate(raw: string): StrippedText {
  const all = normalizeNewlines(raw).split("\n");
  const start = all.findIndex((l) => START_RE.test(l));
  let end = -1;
  for (let i = all.length - 1; i > start; i--) {
    if (END_RE.test(all[i]!)) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    for (let i = start + 1; i < all.length; i++) {
      if (OLD_END_RE.test(all[i]!)) {
        end = i;
        break;
      }
    }
  }

  const header = parseHeader(start > 0 ? all.slice(0, start) : all.slice(0, 60));
  const body = all.slice(start === -1 ? 0 : start + 1, end === -1 ? all.length : end);
  return { lines: trimBlankLines(body.map((l) => l.replace(/\s+$/, ""))), stripped: start !== -1 && end !== -1, header };
}

function trimBlankLines(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.trim() === "") a++;
  while (b > a && lines[b - 1]!.trim() === "") b--;
  return lines.slice(a, b);
}
