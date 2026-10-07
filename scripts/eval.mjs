// Accuracy check against live Project Gutenberg texts.
//
//   npm run build && node scripts/eval.mjs
//
// 1. quote_check on eval/quotes.json: real quotes, near-misses and famous misquotes.
//    A case passes when the reported match level equals the hand-written label.
// 2. get_book chapter detection on eval/chapters.json: detected entry count and
//    first heading against the book's printed structure.
// Needs network (downloads about a dozen books from gutenberg.org).
import { readFileSync } from "node:fs";
import { GutenbergClient } from "../dist/gutenberg.js";
import { quoteCheck } from "../dist/tools/quoteCheck.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../eval/${f}`, import.meta.url), "utf8"));
const client = new GutenbergClient();
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

console.log("quote_check");
let pass = 0;
const quotes = load("quotes.json").cases;
const t0 = Date.now();
for (const c of quotes) {
  const r = (await quoteCheck(client, { id: c.id, quote: c.quote, case_sensitive: false })).structuredContent;
  const ok = r.match === c.expect;
  if (ok) pass++;
  const where = r.locations[0] ? `line ${r.locations[0].start_line}` : r.closest ? `closest line ${r.closest.start_line}` : "";
  console.log(`  ${ok ? "PASS" : "FAIL"}  #${pad(c.id, 5)} ${pad(JSON.stringify(c.quote), 58)} expect ${pad(c.expect, 10)} got ${pad(r.match, 10)} ${where}`);
}
console.log(`  ${pass}/${quotes.length} correct (${Date.now() - t0} ms, includes downloads)\n`);

console.log("chapter detection");
let cpass = 0;
let heldPass = 0;
const books = load("chapters.json").books;
for (const b of books) {
  const book = await client.getBook(b.id);
  const n = book.chapters.length;
  const first = book.chapters[0]?.label;
  const ok = n === b.expect && first === b.first;
  if (ok) cpass++;
  if (ok && b.held_out) heldPass++;
  console.log(`  ${ok ? "PASS" : "FAIL"}${b.held_out ? "*" : " "} #${pad(b.id, 5)} ${pad(book.header.title ?? "", 34)} expect ${pad(b.expect, 4)} got ${pad(n, 4)} first ${pad(first, 15)} (${b.what})`);
}
const held = books.filter((b) => b.held_out);
console.log(`  ${cpass}/${books.length} books with the expected structure (* = held out, not used for tuning)`);
if (held.length) console.log(`  held out: ${heldPass}/${held.length}`);
process.exit(pass === quotes.length && cpass === books.length ? 0 : 1);
