// Prompts for Memory Sketch — things everyone has seen a thousand times and
// absolutely cannot draw. {text, cat, ref} where ref (optional) describes how
// to render "the real thing" beside the gallery:
//   {type:"flag", name}  — looked up in ../flagzoom/flags.js specs
//   {type:"glyph", char} — rendered as a huge text glyph
//   {type:"sym", id}     — tiny canvas drawing implemented in app.js
// Maps and landmarks deliberately have no reference — argue from memory.

export const PROMPTS = [
  // ── Flags ──────────────────────────────────────────────
  { text: "the flag of Japan", cat: "flag", ref: { type: "flag", name: "Japan" } },
  { text: "the flag of France", cat: "flag", ref: { type: "flag", name: "France" } },
  { text: "the flag of Germany", cat: "flag", ref: { type: "flag", name: "Germany" } },
  { text: "the flag of Italy", cat: "flag", ref: { type: "flag", name: "Italy" } },
  { text: "the Union Jack", cat: "flag", ref: { type: "flag", name: "United Kingdom" } },
  { text: "the flag of the United States", cat: "flag", ref: { type: "flag", name: "United States" } },
  { text: "the flag of Sweden", cat: "flag", ref: { type: "flag", name: "Sweden" } },
  { text: "the flag of Switzerland", cat: "flag", ref: { type: "flag", name: "Switzerland" } },
  { text: "the flag of Greece", cat: "flag", ref: { type: "flag", name: "Greece" } },
  { text: "the flag of Ireland", cat: "flag", ref: { type: "flag", name: "Ireland" } },
  { text: "the flag of Turkey", cat: "flag", ref: { type: "flag", name: "Turkey" } },
  { text: "the flag of Denmark", cat: "flag", ref: { type: "flag", name: "Denmark" } },
  { text: "the flag of the Netherlands", cat: "flag", ref: { type: "flag", name: "Netherlands" } },
  { text: "the flag of Argentina", cat: "flag", ref: { type: "flag", name: "Argentina" } },
  { text: "the flag of India", cat: "flag", ref: { type: "flag", name: "India" } },
  { text: "the flag of Vietnam", cat: "flag", ref: { type: "flag", name: "Vietnam" } },
  { text: "the flag of Poland", cat: "flag", ref: { type: "flag", name: "Poland" } },
  { text: "the flag of Ukraine", cat: "flag", ref: { type: "flag", name: "Ukraine" } },
  { text: "the flag of Czechia", cat: "flag", ref: { type: "flag", name: "Czechia" } },
  { text: "the flag of Canada", cat: "flag", ref: null },
  { text: "the flag of Brazil", cat: "flag", ref: null },
  { text: "the flag of Spain", cat: "flag", ref: null },
  { text: "the flag of Australia", cat: "flag", ref: null },
  { text: "the flag of South Korea", cat: "flag", ref: null },

  // ── Currency symbols ───────────────────────────────────
  { text: "the euro symbol", cat: "currency", ref: { type: "glyph", char: "€" } },
  { text: "the pound sterling symbol", cat: "currency", ref: { type: "glyph", char: "£" } },
  { text: "the yen symbol", cat: "currency", ref: { type: "glyph", char: "¥" } },
  { text: "the dollar symbol", cat: "currency", ref: { type: "glyph", char: "$" } },
  { text: "the cent symbol", cat: "currency", ref: { type: "glyph", char: "¢" } },
  { text: "the Indian rupee symbol", cat: "currency", ref: { type: "glyph", char: "₹" } },
  { text: "the South Korean won symbol", cat: "currency", ref: { type: "glyph", char: "₩" } },
  { text: "the Turkish lira symbol", cat: "currency", ref: { type: "glyph", char: "₺" } },
  { text: "the Russian ruble symbol", cat: "currency", ref: { type: "glyph", char: "₽" } },
  { text: "the Bitcoin symbol", cat: "currency", ref: { type: "glyph", char: "₿" } },

  // ── Symbols ────────────────────────────────────────────
  { text: "the yin-yang symbol", cat: "symbol", ref: { type: "sym", id: "yinyang" } },
  { text: "the power button symbol", cat: "symbol", ref: { type: "sym", id: "power" } },
  { text: "the peace symbol", cat: "symbol", ref: { type: "sym", id: "peace" } },
  { text: "the wifi symbol", cat: "symbol", ref: { type: "sym", id: "wifi" } },
  { text: "a no-entry road sign", cat: "symbol", ref: { type: "sym", id: "noentry" } },
  { text: "a classic smiley face", cat: "symbol", ref: { type: "sym", id: "smiley" } },
  { text: "the recycling symbol", cat: "symbol", ref: null },
  { text: "the Bluetooth symbol", cat: "symbol", ref: null },
  { text: "a treble clef", cat: "symbol", ref: null },
  { text: "the ampersand", cat: "symbol", ref: { type: "glyph", char: "&" } },
  { text: "the at sign", cat: "symbol", ref: { type: "glyph", char: "@" } },
  { text: "the infinity symbol", cat: "symbol", ref: { type: "glyph", char: "∞" } },
  { text: "the pi symbol", cat: "symbol", ref: { type: "glyph", char: "π" } },
  { text: "the copyright symbol", cat: "symbol", ref: { type: "glyph", char: "©" } },
  { text: "the female symbol", cat: "symbol", ref: { type: "glyph", char: "♀" } },
  { text: "the male symbol", cat: "symbol", ref: { type: "glyph", char: "♂" } },
  { text: "an anchor (the symbol)", cat: "symbol", ref: null },
  { text: "the radioactive warning symbol", cat: "symbol", ref: null },

  // ── Map outlines (no reference — argue from memory) ────
  { text: "the outline of Italy", cat: "map", ref: null },
  { text: "the outline of Africa", cat: "map", ref: null },
  { text: "the outline of Australia", cat: "map", ref: null },
  { text: "the outline of Great Britain", cat: "map", ref: null },
  { text: "the outline of India", cat: "map", ref: null },
  { text: "the outline of South America", cat: "map", ref: null },
  { text: "the outline of France", cat: "map", ref: null },
  { text: "the outline of Japan", cat: "map", ref: null },
  { text: "the outline of the mainland USA", cat: "map", ref: null },
  { text: "the outline of Scandinavia", cat: "map", ref: null },

  // ── Landmarks (no reference) ───────────────────────────
  { text: "the Eiffel Tower", cat: "landmark", ref: null },
  { text: "Stonehenge", cat: "landmark", ref: null },
  { text: "the Sydney Opera House", cat: "landmark", ref: null },
  { text: "Big Ben", cat: "landmark", ref: null },
  { text: "the Statue of Liberty", cat: "landmark", ref: null },
  { text: "the Pyramids of Giza", cat: "landmark", ref: null },
  { text: "the Leaning Tower of Pisa", cat: "landmark", ref: null },
  { text: "the Taj Mahal", cat: "landmark", ref: null },
  { text: "the Golden Gate Bridge", cat: "landmark", ref: null },
  { text: "the Colosseum", cat: "landmark", ref: null },
  { text: "Mount Rushmore", cat: "landmark", ref: null },
  { text: "the London Eye", cat: "landmark", ref: null },
];

export const CAT_LABELS = {
  flag: "🚩 Flag",
  currency: "💰 Currency symbol",
  symbol: "🔣 Symbol",
  map: "🗺️ Map outline",
  landmark: "🏛️ Landmark",
};
