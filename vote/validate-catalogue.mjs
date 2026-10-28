// Validation for games.js against the real site. Run: node validate-catalogue.mjs
//
// games.js is the machine-readable twin of the hand-written cards in index.html.
// Twins drift, so this asserts they're still the same games with the same
// emoji, titles, formats and badges — plus that every slug is a real folder and
// appears in the README table, and that the homepage game count is right.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GAMES, SECTIONS } from "../games.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");

let failures = 0;
const fail = (msg) => { failures++; console.error("FAIL:", msg); };
const unent = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const squash = (s) => unent(s).replace(/\s+/g, " ").trim();

// ── Parse the homepage cards ──────────────────────────────────────────────────
const sectionAt = [...html.matchAll(/<section id="([^"]+)">\s*<h2>([^<]+)<\/h2>/g)]
  .map((m) => ({ id: m[1], title: squash(m[2]), at: m.index }));

const cards = [...html.matchAll(/<div class="card" data-format="(\w+)">([\s\S]*?)<\/details>\s*<\/div>/g)]
  .map((m) => {
    const body = m[2];
    const badges = [...body.match(/<div class="badges">([\s\S]*?)<\/div>/)[1]
      .matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((b) => squash(b[1]));
    const pick = body.match(/<p class="pick">Pick this when: ([\s\S]*?)<\/p>/);
    return {
      format: m[1],
      slug: body.match(/href="([^"/]+)\/"/)[1],
      emoji: body.match(/<span class="emoji">([^<]+)<\/span>/)[1],
      title: squash(body.match(/<h3>([\s\S]*?)<\/h3>/)[1]),
      blurb: squash(body.match(/<p>([\s\S]*?)<\/p>/)[1]),
      players: (badges.find((b) => b.startsWith("👥")) || "").replace(/^👥\s*/, ""),
      time: (badges.find((b) => b.startsWith("⏱")) || "").replace(/^⏱\s*/, ""),
      extras: badges.filter((b) => !/^(👥|⏱)/.test(b) && !/Teams|Solo scores|Co-op|No scores/.test(b)),
      pick: pick ? squash(pick[1]).replace(/<\/?em>/g, "") : "",
      section: sectionAt.filter((s) => s.at < m.index).pop()?.id,
    };
  });

// ── games.js ↔ index.html ─────────────────────────────────────────────────────
const bySlug = new Map(GAMES.map((g) => [g.slug, g]));
if (bySlug.size !== GAMES.length) fail("duplicate slug in GAMES");

for (const card of cards) {
  const g = bySlug.get(card.slug);
  if (!g) { fail(`index.html has a card for "${card.slug}" that GAMES is missing`); continue; }
  for (const field of ["emoji", "title", "blurb", "format", "players", "time", "pick", "section"]) {
    if (g[field] !== card[field]) {
      fail(`${card.slug}.${field}: games.js has ${JSON.stringify(g[field])}, index.html has ${JSON.stringify(card[field])}`);
    }
  }
  const have = (g.extras || []).join("|");
  if (have !== card.extras.join("|")) {
    fail(`${card.slug}.extras: games.js has [${have}], index.html has [${card.extras.join("|")}]`);
  }
}
for (const g of GAMES) {
  if (!cards.some((c) => c.slug === g.slug)) fail(`GAMES has "${g.slug}" but index.html has no card for it`);
}

// ── Sections ──────────────────────────────────────────────────────────────────
for (const s of sectionAt) {
  if (SECTIONS[s.id] === undefined) fail(`index.html section "${s.id}" is missing from SECTIONS`);
  else if (SECTIONS[s.id] !== s.title) {
    fail(`SECTIONS.${s.id}: ${JSON.stringify(SECTIONS[s.id])} vs index.html ${JSON.stringify(s.title)}`);
  }
}
for (const id of Object.keys(SECTIONS)) {
  if (!sectionAt.some((s) => s.id === id)) fail(`SECTIONS.${id} is not a section in index.html`);
}

// ── Every game is a real, playable folder ─────────────────────────────────────
for (const g of GAMES) {
  if (!existsSync(join(root, g.slug, "index.html"))) fail(`${g.slug}/index.html does not exist`);
}

// ── README table ──────────────────────────────────────────────────────────────
const linked = new Set([...readme.matchAll(/^\| [^|]*\]\(([^)]+)\/\)/gm)].map((m) => m[1]));
for (const g of GAMES) {
  if (!linked.has(g.slug)) fail(`${g.slug} is missing from the README game table`);
}
for (const slug of linked) {
  if (!bySlug.has(slug)) fail(`README table links ${slug}/, which is not in GAMES`);
}

// ── The homepage brags about a game count ─────────────────────────────────────
const count = html.match(/(\d+) games, zero installs/);
if (!count) fail("couldn't find the \"N games, zero installs\" tagline in index.html");
else if (Number(count[1]) !== GAMES.length) {
  fail(`index.html says "${count[1]} games" but there are ${GAMES.length}`);
}

// ── Field sanity ──────────────────────────────────────────────────────────────
for (const g of GAMES) {
  if (!/^[a-z0-9]+$/.test(g.slug)) fail(`slug "${g.slug}" should be lowercase alphanumeric (it's a URL and a DB key)`);
  if (!["teams", "solo", "coop"].includes(g.format)) fail(`${g.slug}: unknown format "${g.format}"`);
  for (const field of ["emoji", "title", "blurb", "players", "time", "pick"]) {
    if (!String(g[field] || "").trim()) fail(`${g.slug}: empty ${field}`);
  }
}

console.log(failures
  ? `\n${failures} failure(s).`
  : `✅ ${GAMES.length} games: games.js matches index.html, the README and the folders on disk.`);
process.exit(failures ? 1 : 0);
