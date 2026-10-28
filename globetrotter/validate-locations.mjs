// Validation for Globetrotter's location lists. Run: node validate-locations.mjs
//
// This is the offline half. It cannot tell you whether a coordinate has Street
// View coverage — that needs the Maps API and a browser, and every entry in
// STREETVIEW_SPOTS and OFFBEAT_SPOTS was checked that way when it was added
// (official Google outdoor imagery with walkable links within 300 m). What it
// does catch: duplicates, coordinates that are obviously wrong, clue packs
// that are the wrong shape, and the house rule that a clue must never contain
// the answer's own name.

import { STREETVIEW_SPOTS, OFFBEAT_SPOTS, CLUE_SPOTS } from "./locations.js";

let failures = 0;
const fail = (msg) => { failures++; console.error("FAIL:", msg); };

const lists = {
  STREETVIEW_SPOTS, OFFBEAT_SPOTS, CLUE_SPOTS,
};

for (const [name, list] of Object.entries(lists)) {
  if (list.length < 10) fail(`${name} has only ${list.length} entries — too few to avoid repeats`);

  const seenNames = new Set();
  const seenCoords = new Set();
  for (const spot of list) {
    const where = `${name} "${spot.name}"`;
    if (!spot.name?.trim()) fail(`${name}: an entry has no name`);
    if (seenNames.has(spot.name)) fail(`${where}: duplicate name`);
    seenNames.add(spot.name);

    if (typeof spot.lat !== "number" || typeof spot.lng !== "number") {
      fail(`${where}: lat/lng must be numbers`);
      continue;
    }
    if (spot.lat < -85 || spot.lat > 85) fail(`${where}: lat ${spot.lat} is off the map`);
    if (spot.lng < -180 || spot.lng > 180) fail(`${where}: lng ${spot.lng} is out of range`);
    if (spot.lat === 0 && spot.lng === 0) fail(`${where}: null island — coordinates never filled in`);
    // Four decimal places is ~11 m; more precision than that is noise, less
    // than two means the pin could be in the next town.
    const places = (n) => (String(n).split(".")[1] || "").length;
    if (places(spot.lat) < 2 || places(spot.lng) < 2) {
      fail(`${where}: coordinates look rounded (${spot.lat}, ${spot.lng})`);
    }

    const key = `${spot.lat.toFixed(3)},${spot.lng.toFixed(3)}`;
    if (seenCoords.has(key)) fail(`${where}: duplicate coordinates ${key}`);
    seenCoords.add(key);
  }
}

// Street View spots: the two pools must not overlap, or Normal (which draws
// from both) could show the same place twice in one game.
const svNames = new Set(STREETVIEW_SPOTS.map((s) => s.name));
for (const s of OFFBEAT_SPOTS) {
  if (svNames.has(s.name)) fail(`"${s.name}" is in both STREETVIEW_SPOTS and OFFBEAT_SPOTS`);
}
const near = (a, b) => Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lng - b.lng) < 0.01;
for (const a of OFFBEAT_SPOTS) {
  for (const b of STREETVIEW_SPOTS) {
    if (near(a, b)) fail(`"${a.name}" and "${b.name}" are the same place in different pools`);
  }
}

// Words that are part of a place name but give nothing away on their own
// ("City" in New York City, "Island" in Easter Island).
const GENERIC = new Set(["city", "island", "islands", "town", "port", "saint", "mount", "lake"]);

// Clue packs
for (const spot of CLUE_SPOTS) {
  const where = `CLUE_SPOTS "${spot.name}"`;
  if (!Array.isArray(spot.clues) || spot.clues.length !== 4) {
    fail(`${where}: needs exactly 4 clues, has ${spot.clues?.length ?? 0}`);
    continue;
  }
  spot.clues.forEach((clue, i) => {
    if (!clue?.trim()) fail(`${where}: clue ${i + 1} is empty`);
    // The house rule: a clue never contains the answer. Hard mode shows only
    // clues 1–2, so this matters most there, but it holds for all of them.
    for (const word of spot.name.split(/[\s,]+/)) {
      if (word.length < 4) continue;   // "York" in "New York" is fine to skip
      if (GENERIC.has(word.toLowerCase())) continue;
      if (new RegExp(`\\b${word}\\b`, "i").test(clue)) {
        fail(`${where}: clue ${i + 1} gives away the answer ("${word}")`);
      }
    }
  });
}

console.log(failures
  ? `\n${failures} failure(s).`
  : `✅ ${STREETVIEW_SPOTS.length} landmark + ${OFFBEAT_SPOTS.length} offbeat Street View spots, ` +
    `${CLUE_SPOTS.length} clue spots — all well-formed.`);
process.exit(failures ? 1 : 0);
