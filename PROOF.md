# PROOF

What was checked for gutenberg-mcp, with the exact commands and their real output. Everything here was run on 2026-10-07 on Linux with Node 22.22.0. Live results depend on Gutendex and the Gutenberg mirror (gutenberg.pglaf.org) at the time; line numbers depend on the current Gutenberg edition of each file.

## Summary

| Check | Command | Result |
| --- | --- | --- |
| Unit and integration tests (no network) | `npm test` | 77 tests in 5 files, all pass |
| Types | `npm run typecheck` | clean |
| Dependencies | `npm audit` | `found 0 vulnerabilities` |
| stdio transport | `node scripts/smoke.mjs --live` | initialize, 6 tools listed, live `quote_check` ok |
| HTTP transport | `node scripts/smoke-http.mjs --live` | `/health`, CORS preflight, initialize, tools/list, playground, 3 live calls ok |
| Production build and start | `npm run build && PORT=3911 npm start`, then `curl` | `/health` 200, `/` 200 |
| quote_check accuracy (live) | `node scripts/eval.mjs` | 22/22 quotes classified as labeled |
| Chapter detection (live) | `node scripts/eval.mjs` | 21/21 books; 4/4 on books not used for tuning |
| Screenshots | `node scripts/screenshots.mjs` | 12 PNGs in `docs/screenshots/` |

## Tests

```
$ npm test
 Test Files  5 passed (5)
      Tests  77 passed (77)
```

Re-run on 2026-10-07: 77 tests pass (earlier runs showed 76).

`test/text.test.ts` covers license stripping (current and old marker styles, CRLF, BOM, files without markers), chapter detection (contents pages, illustration captions, books and acts, bare numerals, play speaker names), normalization levels and line mapping, sentence counting and the LRU/TTL caches. `test/tools.test.ts` covers each tool against two recorded book excerpts and recorded Gutendex and gutenberg.org search responses, including the search fallback, the slow-catalog path, 404s, size limits, the host allow list, mapping catalog URLs onto the mirror (and a custom `GUTENBERG_MIRROR`) and retries. `test/server.test.ts` runs the MCP protocol in memory (schemas, annotations, input validation before any request, error mapping, hidden internal errors). `test/http.test.ts` runs the official SDK client over a real socket and checks CORS, 405/406/400/413/429/504 handling, per-IP and daily limits, `X-Forwarded-For` trust and the playground's CSP. A mocked `fetch` throws on any unexpected request, so tests never touch the network.

## Smoke tests

```
$ node scripts/smoke.mjs --live
initialize -> {"name":"gutenberg","version":"0.1.0"} protocol 2025-06-18
tools/list -> 6 tools
  ...
live tools/call quote_check ->
  "match": "exact", "start_line": 815, chapter "CHAPTER 1" / "Loomings"
  "text": "815  Call me Ishmael. Some years ago—never mind how long precisely—having"
SMOKE OK

$ node scripts/smoke-http.mjs --live
GET /health -> {"status":"ok","name":"gutenberg","version":"0.1.0","transport":"streamable-http","endpoint":"/mcp","uptime_s":0,"cached_books":0,"text_mirror":"https://gutenberg.pglaf.org","limits":{"per_ip_per_minute":30,"daily_requests":5000,"daily_used":0}}
OPTIONS /mcp -> 204, allow-origin: *
POST /mcp initialize -> 200 {"name":"gutenberg","version":"0.1.0"} protocol 2025-06-18
POST /mcp tools/list -> 6 tools: search_books, get_book, read_passage, find_in_book, quote_check, book_stats
GET / -> 200, 42155 bytes, title: Gutenberg MCP
live tools/call search_books (350 ms) -> "source": "gutendex", "total": 5
live tools/call quote_check (13362 ms) -> "Verbatim: the quote appears exactly as given (only line breaks and spacing differ)."
live tools/call quote_check (9131 ms) -> "Not in this book. The closest passage (line 1113) shares 3 of 4 words."
HTTP SMOKE OK
```

(Output trimmed to the verdict lines; the script prints the first 900 characters of each result.) The two `quote_check` times include downloading Moby Dick (1.27 MB) and the Sherlock Holmes stories from gutenberg.pglaf.org on a cold cache. The mirror was slower than www.gutenberg.org in this run (the same calls took 536 ms and 748 ms against www.gutenberg.org in an earlier run); later calls for the same book come from memory.

## Live tool calls

Run with `node scripts/call.mjs <tool> '<json>'`, which goes through the real MCP protocol layer:

| Call | Result |
| --- | --- |
| `quote_check {"id":2701,"quote":"Call me Ishmael."}` | `found: true`, `match: "exact"`, line 815, CHAPTER 1 "Loomings", 951 ms including the 1.27 MB download |
| `quote_check {"id":1342,"quote":"It is a truth universally acknowledged that a single man in possession of a good fortune must be in want of a wife."}` | `match: "words"`, lines 673-674. The book has a comma after "acknowledged". |
| `quote_check {"id":1661,"quote":"Elementary, my dear Watson"}` | `found: false`. Closest passage line 1113 ("...my dear Watson," he), missing word: "elementary" |
| `quote_check {"id":2701,"quote":"to the last I grapple with thee; from hell's heart I stab at thee"}` | `match: "typography"` (straight vs curly apostrophe), lines 21852-21853 |
| `find_in_book {"id":2701,"query":"white whale"}` | 108 matches across 32 chapters; CHAPTER 36 "The Quarter-Deck" and CHAPTER 41 "Moby Dick" have 14 each |
| `get_book {"id":98}` | A Tale of Two Cities: 48 entries, 3 books with their chapters, 15,900 lines |
| `book_stats {"id":1342}` | 127,999 words, 6,926 unique, about 5,929 sentences, 21.6 words per sentence, top words elizabeth (605), darcy (385), miss (315) |
| `book_stats {"id":2701,"top_n":5}` | 216,978 words, 17,557 unique, about 9,209 sentences, 23.6 words per sentence, 912 minutes at 238 wpm |
| `search_books {"query":"kafka metamorphosis"}` | Gutendex did not answer within 8 s, so the gutenberg.org fallback answered: `source: "gutenberg.org"`, first result #5200 "Metamorphosis" by Franz Kafka, 8,949 ms total |

Word counts include headings and, for Pride and Prejudice, the edition's preface.

## Eval: quote_check and chapter detection

`eval/quotes.json` has 22 quotations: 15 real (some with deliberately changed punctuation, case or apostrophes) and 7 well-known misquotes or paraphrases. Each is labeled with the match level it should get, and each real quote was checked against the downloaded text. `eval/chapters.json` has 21 books, each labeled with the structure the book prints (chapters, letters, staves, books, acts, scenes, prefaces), checked against the text. One quote label and two book labels were corrected after early runs; see the notes below the output.

Re-run on 2026-10-07 after book downloads moved to the gutenberg.pglaf.org mirror. Same results as the earlier run against www.gutenberg.org; only the timing changed.

```
$ npm run build && node scripts/eval.mjs
quote_check
  PASS  #2701  "Call me Ishmael."                                         expect exact      got exact      line 815
  PASS  #2701  "From hell's heart I stab at thee"                         expect case       got case       line 21853
  PASS  #1342  "It is a truth universally acknowledged that a single man  expect words      got words      line 673
  PASS  #1342  "You must allow me to tell you how ardently I admire and l expect exact      got exact      line 7506
  PASS  #1524  "To be, or not to be, that is the question"                expect exact      got exact      line 2849
  PASS  #1524  "Something is rotten in the state of Denmark."             expect exact      got exact      line 1229
  PASS  #1524  "The rest is silence."                                     expect exact      got exact      line 6617
  PASS  #1513  "O Romeo, Romeo, wherefore art thou Romeo?"                expect exact      got exact      line 1540
  PASS  #1513  "Parting is such sweet sorrow"                             expect exact      got exact      line 1813
  PASS  #1533  "Out, damned spot! out, I say!"                            expect exact      got exact      line 3493
  PASS  #1533  "Lay on, Macduff"                                          expect case       got case       line 4076
  PASS  #46    "Marley was dead: to begin with."                          expect case       got case       line 37
  PASS  #11    "Curiouser and curiouser!"                                 expect exact      got exact      line 253
  PASS  #1661  "You see, but you do not observe."                         expect exact      got exact      line 133
  PASS  #84    "Beware; for I am fearless, and therefore powerful."       expect words      got words      line 5409
  PASS  #1661  "Elementary, my dear Watson"                               expect none       got none       closest line 1113
  PASS  #84    "It's alive! It's alive!"                                  expect none       got none       
  PASS  #1524  "Alas, poor Yorick! I knew him well."                      expect none       got none       closest line 5731
  PASS  #1533  "Lead on, Macduff"                                         expect none       got none       closest line 3153
  PASS  #151   "Water, water, everywhere, nor any drop to drink"          expect none       got none       closest line 170
  PASS  #78    "Me Tarzan, you Jane."                                     expect none       got none       closest line 7539
  PASS  #1513  "Romeo, Romeo, where are you, Romeo?"                      expect none       got none       closest line 1429
  22/22 correct (38227 ms, includes downloads)

chapter detection
  PASS  #11    Alice's Adventures in Wonderland   expect 12   got 12   first CHAPTER I       (12 chapters)
  PASS  #1342  Pride and Prejudice                expect 62   got 62   first PREFACE         (preface + 61 chapters)
  PASS  #2701  Moby Dick; Or, The Whale           expect 138  got 138  first ETYMOLOGY       (etymology, extracts, 135 chapters, epilogue)
  PASS  #84    Frankenstein; or, the modern prome expect 28   got 28   first LETTER 1        (4 letters + 24 chapters)
  PASS  #46    A Christmas Carol in Prose; Being  expect 6    got 6    first PREFACE         (preface + 5 staves)
  PASS  #98    A Tale of Two Cities               expect 48   got 48   first BOOK THE FIRST  (3 books + 45 chapters)
  PASS  #1661  The Adventures of Sherlock Holmes  expect 12   got 12   first I               (12 stories)
  PASS  #345   Dracula                            expect 27   got 27   first CHAPTER I       (27 chapters)
  PASS  #1513  Romeo and Juliet                   expect 30   got 30   first PROLOGUE        (prologue + 5 acts + 24 scenes)
  PASS  #1524  Hamlet                             expect 25   got 25   first ACT I           (5 acts + 20 scenes)
  PASS  #1533  Macbeth                            expect 33   got 33   first ACT I           (5 acts + 28 scenes)
  PASS  #1260  Jane Eyre: An Autobiography        expect 39   got 39   first PREFACE         (preface + 38 chapters)
  PASS* #1400  Great Expectations                 expect 59   got 59   first CHAPTER I       (59 chapters)
  PASS  #174   The Picture of Dorian Gray         expect 21   got 21   first PREFACE         (preface + 20 chapters)
  PASS  #120   Treasure Island                    expect 40   got 40   first PART ONE        (6 parts + 34 chapters)
  PASS* #76    Adventures of Huckleberry Finn     expect 43   got 43   first CHAPTER I       (42 chapters + CHAPTER THE LAST)
  PASS  #64317 The Great Gatsby                   expect 9    got 9    first I               (9 chapters)
  PASS  #219   Heart of Darkness                  expect 3    got 3    first I               (3 parts)
  PASS* #36    The war of the worlds              expect 29   got 29   first BOOK ONE        (2 books + 27 chapters)
  PASS  #5200  Metamorphosis                      expect 3    got 3    first I               (3 parts)
  PASS* #768   Wuthering Heights                  expect 34   got 34   first CHAPTER I       (34 chapters)
  21/21 books with the expected structure (* = held out, not used for tuning)
  held out: 4/4
```

How the numbers got here, honestly:

- The quote set and the first 11 books were written while building the server. Most of those books were used to develop the chapter heuristics, so their passing is expected.
- First full run: 21/22 quotes, 10/11 books. The quote miss was a labeling error: "From hell's heart I stab at thee" is mid-sentence in the book ("thee; from hell’s heart"), so `case` is correct and the label was changed. The book miss was real: Hamlet's play-within-a-play speaker `PROLOGUE.` was counted as a section. Fixed (a bare section word with a speech right under it is skipped) with a test.
- First held-out run, five books added after the heuristics were final: 2/5. Jane Eyre's label was wrong (the book prints a preface, so 39 not 38). The Picture of Dorian Gray (`THE PREFACE`) and Treasure Island (numeral on one line, title on the next) were real misses. Fixed with tests. Romeo and Juliet's label was also corrected from 29 to 30 when the fix started finding its opening prologue, which is a real printed section.
- Second held-out run, five more new books: War of the Worlds and Wuthering Heights passed; The Great Gatsby, Heart of Darkness and Metamorphosis failed for one shared reason (they number parts with a bare `I`, `II`, `III` and nothing else). Fixed with a fallback that only applies when nothing else is found, plus tests.
- So the only books never used for tuning are the four marked `*`: Great Expectations, Huckleberry Finn, War of the Worlds and Wuthering Heights. They pass 4/4. That is a small sample; expect misses on books with unusual heading styles (for example #1112, an old-spelling Romeo and Juliet with Latin act headings, gets no chapters and a note to read by line number).

## Gutendex latency

Gutendex is fast for searches it has cached and very slow otherwise. Measured with:

```
$ for q in "moby dick" "pride and prejudice" "dickens" "frankenstein" "sherlock holmes" "dracula" "alice wonderland" "tolstoy" "poe raven" "shakespeare hamlet"; do
    curl -sS -m 60 -o /dev/null -w "$q %{http_code} %{time_total}s\n" "https://gutendex.com/books/?search=..."; done
moby dick 200 0.762184s
pride and prejudice 200 0.781935s
dickens 200 0.416004s
frankenstein 200 0.455788s
sherlock holmes 200 49.841981s
dracula 200 1.426157s
alice wonderland 200 42.367531s
tolstoy 000 60.001210s   (timed out)
poe raven 200 44.257230s
shakespeare hamlet 000 60.001365s   (timed out)
```

gutenberg.org's OPDS search for three of the slow queries took 0.43 s, 0.78 s and 0.34 s (`curl "https://www.gutenberg.org/ebooks/search.opds/?query=tolstoy"` and similar). That is why `search_books` falls back to it after 8 seconds, and why the reading tools never wait for Gutendex. `GET https://gutendex.com/books/` reported `"count": 79546` catalog entries (this includes audio books), which is where "75,000+ books" comes from.

## Production build

```
$ rm -rf dist && npm run build && PORT=3911 npm start &
$ curl -sS localhost:3911/health
{"status":"ok","name":"gutenberg","version":"0.1.0","transport":"streamable-http","endpoint":"/mcp","uptime_s":2,"cached_books":0,"text_mirror":"https://gutenberg.pglaf.org","limits":{"per_ip_per_minute":30,"daily_requests":5000,"daily_used":0}}
$ curl -sS -o /dev/null -w "GET / %{http_code} %{size_download}\n" localhost:3911/
GET / 200 42185
```

## Screenshots

Taken with `node scripts/screenshots.mjs` (Playwright, Chromium from `/opt/pw-browsers`) against the live library, at 1280x800 and at phone width (390x844):

- `docs/screenshots/playground.png`: landing view
- `docs/screenshots/quote-verbatim.png`: "Call me Ishmael." found verbatim
- `docs/screenshots/quote-not-found.png`: "Elementary, my dear Watson" with the closest real passage
- `docs/screenshots/get-book-toc.png`: A Tale of Two Cities table of contents
- `docs/screenshots/read-passage.png`: A Christmas Carol, Stave I, numbered lines
- `docs/screenshots/find-in-book.png`: "white whale" counts per chapter
- `docs/screenshots/book-stats.png`: Pride and Prejudice statistics
- `docs/screenshots/search.png`: search results for "frankenstein"
- `docs/screenshots/raw-json.png`: the raw JSON toggle
- `docs/screenshots/connect.png`: client config snippets
- `docs/screenshots/phone.png`, `docs/screenshots/phone-results.png`: phone width

Re-taken on 2026-10-07 after the mirror and install changes.

## Install from GitHub without npm

The package is not on npm. The README installs it with `npx -y github:frogr/gutenberg-mcp`, which works because a `prepare` script runs `npm run build` when npm installs from git. The GitHub repo wasn't public when this was checked, so the same path was tested from a local git URL with an empty npx cache:

```
$ rm -rf ~/.npm/_npx
$ echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | npx -y git+file:///home/claude/gutenberg-mcp
gutenberg-mcp running on stdio
{"result":{"protocolVersion":"2025-06-18",...,"serverInfo":{"name":"gutenberg","version":"0.1.0"},...}
```

First start took 19 s (clone, install, TypeScript build). Not checked: the same command against github.com, which needs the repo to be public.

## Not verified

- No deploy to Render was done (no account was created). `render.yaml` follows the same shape as a working Blueprint, and the production start command was checked locally.
- Not tested inside Claude Desktop, Claude Code, Cursor or ChatGPT. The stdio and HTTP transports were tested with the official MCP SDK client and with raw JSON-RPC, which is what those clients speak.
- Docker image not built here (no Docker daemon). The Dockerfile mirrors one that is known to work for a sibling project.
- Memory use on a 512 MB instance under load was not measured. `BOOK_CACHE_MB` bounds the parsed-book cache by an estimate (three times the UTF-16 size of the text), not by measured heap.
- Chapter detection is heuristic. The eval above is small and mostly English novels and plays.
- There is no LLM in this server, so there is no API-key mode to test. Every tool is deterministic.
