// ─── OPTIONAL: Google Maps API key (unlocks Street View mode in Globetrotter) ──
// Globetrotter works out of the box in "Clue mode" with no key at all.
// To unlock the GeoGuessr-style Street View mode:
//
// 1. Go to https://console.cloud.google.com and create a project (any name).
// 2. Enable billing on the project (required by Google; the free monthly cap
//    covers office-social usage many times over, so it shouldn't cost anything).
// 3. APIs & Services → Library → enable "Maps JavaScript API".
// 4. APIs & Services → Credentials → Create credentials → API key.
// 5. IMPORTANT — restrict the key (Edit key → Application restrictions →
//    Websites) to:
//        https://colineatherton.github.io/*
//        http://localhost:*/*
//    The key is safe to publish in this repo BECAUSE it is referrer-restricted:
//    it only works from your own site.
// 6. Paste the key below. Done — the host can now pick Street View mode in the
//    Globetrotter lobby.
// ──────────────────────────────────────────────────────────────────────────────

export const mapsConfig = {
  apiKey: "PASTE_OPTIONAL_GOOGLE_MAPS_KEY",
};
