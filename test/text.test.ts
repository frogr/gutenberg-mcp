// Pure text processing: license stripping, chapter detection, normalization, stats.
import { describe, expect, it } from "vitest";
import { chapterAt, detectChapters, matchHeading } from "../src/text/chapters.js";
import { LruCache, TtlCache } from "../src/text/lru.js";
import { lineAt, normalizeLines, normalizeString, tokenizeLines, words } from "../src/text/normalize.js";
import { computeStats, countSentences } from "../src/text/stats.js";
import { stripBoilerplate } from "../src/text/strip.js";
import { fixtureText } from "./helpers.js";

describe("stripBoilerplate", () => {
  it("removes the license header and footer and parses the header fields", () => {
    const s = stripBoilerplate(fixtureText("pg2701-excerpt.txt"));
    expect(s.stripped).toBe(true);
    expect(s.header).toEqual({ title: "Moby Dick; Or, The Whale", author: "Herman Melville", language: "English", release_date: "July 1, 2001" });
    expect(s.lines[0]).toBe("MOBY-DICK;");
    expect(s.lines.at(-1)).toBe("feet, and see what sort of a place this “Spouter” may be.");
    const all = s.lines.join("\n");
    expect(all).not.toMatch(/PROJECT GUTENBERG|Project Gutenberg License|\*\*\*/);
  });

  it("handles CRLF, a BOM, old-style end lines and files with no markers", () => {
    const old = "﻿Title: Old Book\r\nAuthor: Someone\r\n\r\n*** START OF THIS PROJECT GUTENBERG EBOOK OLD BOOK ***\r\n\r\nText line.\r\n\r\nEnd of the Project Gutenberg EBook of Old Book\r\nlicense...";
    const s = stripBoilerplate(old);
    expect(s).toMatchObject({ stripped: true, lines: ["Text line."], header: { title: "Old Book", author: "Someone" } });

    const bare = stripBoilerplate("Just a text file.\n\nWith two paragraphs.\n");
    expect(bare.stripped).toBe(false);
    expect(bare.lines).toEqual(["Just a text file.", "", "With two paragraphs."]);
  });
});

describe("detectChapters", () => {
  it("finds Moby Dick's chapters and drops the printed contents list", () => {
    const { lines } = stripBoilerplate(fixtureText("pg2701-excerpt.txt"));
    const ch = detectChapters(lines);
    expect(ch).toEqual([
      { index: 1, label: "CHAPTER 1", title: "Loomings", start_line: 38, end_line: 236 },
      { index: 2, label: "CHAPTER 2", title: "The Carpet-Bag", start_line: 239, end_line: 370 },
    ]);
    expect(lines[37]).toBe("CHAPTER 1. Loomings.");
    expect(lines[39]).toMatch(/^Call me Ishmael\./);
  });

  it("reads headings inside illustration captions (Pride and Prejudice)", () => {
    const { lines } = stripBoilerplate(fixtureText("pg1342-excerpt.txt"));
    expect(detectChapters(lines).map((c) => [c.label, c.start_line])).toEqual([
      ["CHAPTER I", 13],
      ["CHAPTER II", 150],
      ["CHAPTER III", 271],
    ]);
  });

  it("groups chapters under books and acts, so repeated numbers are not duplicates", () => {
    const prose = (n: number) => Array.from({ length: n }, (_, i) => `Sentence ${i + 1} of the story goes on here.`);
    const book = [
      "CONTENTS", "",
      "Book the First--Recalled to Life", "",
      "CHAPTER I      The Period", "CHAPTER II     The Mail", "",
      "Book the Second--the Golden Thread", "",
      "CHAPTER I      Five Years Later", "",
      "", "Book the First--Recalled to Life", "", "",
      "CHAPTER I.", "", "The Period", "", ...prose(10), "",
      "CHAPTER II.", "", "The Mail", "", ...prose(10), "",
      "Book the Second--the Golden Thread", "",
      "CHAPTER I.", "", "Five Years Later", "", ...prose(10),
    ];
    const ch = detectChapters(book);
    expect(ch.map((c) => [c.part ?? "", c.label, c.title ?? ""])).toEqual([
      ["", "BOOK THE FIRST", "Recalled to Life"],
      ["BOOK THE FIRST", "CHAPTER I", "The Period"],
      ["BOOK THE FIRST", "CHAPTER II", ""],
      ["", "BOOK THE SECOND", "the Golden Thread"],
      ["BOOK THE SECOND", "CHAPTER I", "Five Years Later"], // title borrowed from the contents entry
    ]);
    // Every kept heading is in the body, not the contents page.
    expect(ch.every((c) => c.start_line > 12)).toBe(true);
    expect(ch.map((c) => book[c.start_line - 1]!.trim())).toEqual([
      "Book the First--Recalled to Life", "CHAPTER I.", "CHAPTER II.", "Book the Second--the Golden Thread", "CHAPTER I.",
    ]);
  });

  it("matches the heading styles found in common Gutenberg books", () => {
    expect(matchHeading("STAVE III: THE SECOND OF THE THREE SPIRITS")).toEqual({ label: "STAVE III", title: "THE SECOND OF THE THREE SPIRITS" });
    expect(matchHeading("Letter 4")).toEqual({ label: "LETTER 4" });
    expect(matchHeading("SCENE II. A Street.")).toEqual({ label: "SCENE II", title: "A Street" });
    expect(matchHeading("IV. THE BOSCOMBE VALLEY MYSTERY")).toEqual({ label: "IV", title: "THE BOSCOMBE VALLEY MYSTERY" });
    expect(matchHeading("Chapter Twenty-One")).toEqual({ label: "CHAPTER TWENTY-ONE" });
    expect(matchHeading("EXTRACTS (Supplied by a Sub-Sub-Librarian).")).toEqual({ label: "EXTRACTS", title: "Supplied by a Sub-Sub-Librarian" });
  });

  it("reads a bare numeral with its title on the next line, and THE PREFACE", () => {
    const prose = (n: number) => Array.from({ length: n }, () => "Some sentence of the story.");
    const book = ["THE PREFACE", "", ...prose(3), "", "PART ONE--The Old Buccaneer", "", "", "I", "The Old Sea-dog at the Admiral Benbow", "", ...prose(9), "", "II", "Black Dog Appears and Disappears", "", ...prose(9)];
    expect(detectChapters(book).map((c) => [c.part ?? "", c.label, c.title ?? ""])).toEqual([
      ["", "PREFACE", ""],
      ["", "PART ONE", "The Old Buccaneer"],
      ["PART ONE", "I", "The Old Sea-dog at the Admiral Benbow"],
      ["PART ONE", "II", "Black Dog Appears and Disappears"],
    ]);
  });

  it("falls back to a bare I, II, III sequence only when nothing else is found", () => {
    const prose = (n: number) => Array.from({ length: n }, () => "Some sentence of the story.");
    const short = ["I", "", ...prose(5), "", "II", "", ...prose(5), "", "IV", "", ...prose(2), "", "III", "", ...prose(5)];
    expect(detectChapters(short).map((c) => c.label)).toEqual(["I", "II", "III"]); // the stray IV is out of sequence
    // With real headings present, numbered breaks inside chapters are ignored.
    const titled = ["I. A SCANDAL IN BOHEMIA", "", "I.", "", ...prose(5), "", "II.", "", ...prose(5), "", "II. THE RED-HEADED LEAGUE", "", ...prose(5), "", "III. A CASE OF IDENTITY", "", ...prose(5)];
    expect(detectChapters(titled).map((c) => c.title)).toEqual(["A SCANDAL IN BOHEMIA", "THE RED-HEADED LEAGUE", "A CASE OF IDENTITY"]);
  });

  it("skips speaker names in plays and keeps a contents page's acts from leaking into the prologue", () => {
    const play = [
      "Contents", "", "THE PROLOGUE.", "", "ACT I", "Scene I. A public place.", "", "ACT II", "Scene I. A garden.", "", "",
      "THE PROLOGUE", "", "Two households, both alike in dignity,", "In fair Verona, where we lay our scene,", "",
      "ACT I", "", "SCENE I. A public place.", "", "SAMPSON.", "Gregory, on my word.", "", "PROLOGUE.", "For us, and for our tragedy,", "",
      "ACT II", "", "SCENE I. A garden.", "", "ROMEO.", "Can I go forward?",
    ];
    expect(detectChapters(play).map((c) => [c.part ?? "", c.label, c.start_line])).toEqual([
      ["", "PROLOGUE", 12],
      ["", "ACT I", 17],
      ["ACT I", "SCENE I", 19],
      ["", "ACT II", 27],
      ["ACT II", "SCENE I", 29],
    ]);
  });

  it("rejects prose that starts like a heading", () => {
    expect(matchHeading("Chapter 3 he wrote in a hurry")).toBeNull();
    expect(matchHeading("book two was never finished")).toBeNull();
    expect(matchHeading("BOOK I. (_Folio_), CHAPTER I. (_Sperm Whale_).—This whale, among the")).toBeNull();
    expect(matchHeading("Part MIX of the plan")).toBeNull();
    expect(matchHeading("I. went home")).toBeNull();
  });

  it("chapterAt finds the chapter holding a line", () => {
    const ch = [
      { index: 1, label: "A", start_line: 10, end_line: 19 },
      { index: 2, label: "B", start_line: 20, end_line: 40 },
    ];
    expect(chapterAt(ch, 5)).toBeUndefined();
    expect(chapterAt(ch, 10)?.label).toBe("A");
    expect(chapterAt(ch, 25)?.label).toBe("B");
  });
});

describe("normalize", () => {
  it("treats curly quotes, dash styles and italics markers as equal at the typography level", () => {
    const o = { typography: true };
    expect(normalizeString("“_You_ want to tell me,” she said—", o)).toBe('"You want to tell me," she said-');
    expect(normalizeString("ago — never", o)).toBe(normalizeString("ago--never", o));
    expect(normalizeString("ago—never", o)).toBe("ago-never");
    expect(normalizeString("It’s", o)).toBe("It's");
  });

  it("folds case and drops punctuation at the loosest level", () => {
    expect(normalizeString("A truth, universally   acknowledged!", { typography: true, caseFold: true, punctuation: true })).toBe("a truth universally acknowledged");
  });

  it("maps offsets back to source lines across blank lines and wraps", () => {
    const lines = ["First line here", "", "", "Call me", "Ishmael."];
    const n = normalizeLines(lines, { typography: true });
    expect(n.text).toBe("First line here Call me Ishmael.");
    expect(lineAt(n, n.text.indexOf("First"))).toBe(1);
    expect(lineAt(n, n.text.indexOf("Call"))).toBe(4);
    expect(lineAt(n, n.text.indexOf("Ishmael"))).toBe(5);
  });

  it("tokenizes words with apostrophes and line numbers", () => {
    expect(words("Ishmael’s hat, don't")).toEqual(["ishmael's", "hat", "don't"]);
    const t = tokenizeLines(["one _two_", "", "three"]);
    expect(t.words).toEqual(["one", "two", "three"]);
    expect([...t.lineOf]).toEqual([1, 1, 3]);
  });
});

describe("stats", () => {
  it("counts sentences without splitting on Mr. and Mrs.", () => {
    expect(countSentences("Mr. Bennet replied that he had not. “But it is,” returned she. Mrs. Long has just been here!")).toBe(3);
  });

  it("computes counts, top words and the longest chapter", () => {
    const lines = ["CHAPTER I.", "", "The whale. The whale swam.", "", "CHAPTER II.", "", "Ahab hunted the white whale for years and years."];
    const chapters = detectChapters(lines);
    const s = computeStats(tokenizeLines(lines), normalizeLines(lines, { typography: true }).text, chapters, 3);
    expect(s.word_count).toBe(18); // headings count too: "chapter i" is two words
    expect(s.top_words).toEqual([
      { word: "whale", count: 3 },
      { word: "years", count: 2 },
      { word: "ahab", count: 1 },
    ]);
    expect(s.longest_chapter).toMatchObject({ label: "CHAPTER II", word_count: 11 });
    expect(s.shortest_chapter).toMatchObject({ label: "CHAPTER I", word_count: 7 });
  });
});

describe("caches", () => {
  it("LruCache evicts least recently used entries by count and by size", () => {
    const c = new LruCache<string, string>(3, 10, (v) => v.length);
    c.set("a", "aaaa");
    c.set("b", "bbbb");
    c.get("a");
    c.set("c", "cccc"); // 12 > 10: evicts b (a was used more recently)
    expect([c.get("a"), c.get("b"), c.get("c")]).toEqual(["aaaa", undefined, "cccc"]);
    c.set("huge", "x".repeat(11)); // bigger than the whole budget: not cached
    expect(c.get("huge")).toBeUndefined();
    expect(c.totalSize).toBe(8);
  });

  it("TtlCache expires entries", () => {
    let t = 0;
    const c = new TtlCache<string, number>(10, 100, () => t);
    c.set("k", 1);
    t = 100;
    expect(c.get("k")).toBe(1);
    t = 101;
    expect(c.get("k")).toBeUndefined();
  });
});
