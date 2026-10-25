// Validation for the emoji palette + keyword index. Run: node validate-palette.mjs
// Asserts: every palette emoji has a non-empty keyword string, no duplicate
// emoji, no duplicate prompts, and keywords are lowercase ascii words.

import { MOVIES, SONGS, THINGS, EMOJI_PALETTE, EMOJI_KEYWORDS } from "./prompts.js";

let failures = 0;
const fail = (msg) => { failures++; console.error("FAIL:", msg); };

// Palette coverage
for (const e of EMOJI_PALETTE) {
  const kw = EMOJI_KEYWORDS[e];
  if (kw === undefined) fail(`no keywords entry for ${e}`);
  else if (!kw.trim()) fail(`empty keywords for ${e}`);
  else if (!/^[a-z0-9 ]+$/.test(kw)) fail(`keywords for ${e} not lowercase ascii words: "${kw}"`);
}

// No stray keyword entries outside the palette
const paletteSet = new Set(EMOJI_PALETTE);
for (const e of Object.keys(EMOJI_KEYWORDS)) {
  if (!paletteSet.has(e)) fail(`keywords entry ${e} is not in the palette`);
}

// Duplicates
const dup = (arr, label) => {
  const seen = new Set();
  for (const x of arr) {
    if (seen.has(x)) fail(`duplicate in ${label}: ${x}`);
    seen.add(x);
  }
};
dup(EMOJI_PALETTE, "EMOJI_PALETTE");
dup(MOVIES, "MOVIES");
dup(SONGS, "SONGS");
dup(THINGS, "THINGS");

// Every palette entry should be a single emoji-ish token (no spaces, not ascii)
for (const e of EMOJI_PALETTE) {
  if (/\s/.test(e)) fail(`palette entry contains whitespace: "${e}"`);
  if (/^[\x20-\x7E]+$/.test(e)) fail(`palette entry is plain ascii: "${e}"`);
}

console.log(`palette: ${EMOJI_PALETTE.length} emoji, all with keywords`);
console.log(`prompts: ${MOVIES.length} movies, ${SONGS.length} songs, ${THINGS.length} sayings`);
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("OK");
