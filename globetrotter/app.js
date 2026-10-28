// Globetrotter — GeoGuessr for the office, synced through Firebase RTDB.
// Two modes: "streetview" (Google Street View walk-around, needs an API key in
// ../maps-config.js) and "clue" (progressive text clues, no key needed), each
// with three difficulties (see DIFFICULTY below). The guess map is always
// Leaflet (self-hosted in vendor/) over Esri's English-labelled basemap —
// see addBasemap. Leaflet's `L` comes from the <script> tag in index.html.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { mapsConfig } from "../maps-config.js";
import { STREETVIEW_SPOTS, OFFBEAT_SPOTS, CLUE_SPOTS } from "./locations.js";

const $ = (id) => document.getElementById(id);

// ── Config checks ─────────────────────────────────────────────────────────────
if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("PASTE")) {
  showScreen("setup");
  throw new Error("Firebase config not filled in — see firebase-config.js");
}
const hasKey = !!mapsConfig?.apiKey && !mapsConfig.apiKey.startsWith("PASTE");

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ── Identity & state ──────────────────────────────────────────────────────────
const pid = (() => {
  let v = localStorage.getItem("pg_pid");
  if (!v) { v = Math.random().toString(36).slice(2, 10); localStorage.setItem("pg_pid", v); }
  return v;
})();

let roomCode = null;
let meta = null;
let players = {};
let guessesAll = {};
let serverOffset = 0;
let loadedRound = -1;
let lockedLocal = false;
let pinLatLng = null;
let revealShownFor = -1;

// Maps machinery
let guessMap = null, guessPin = null;
let revealMap = null, revealLayer = null;
let gmapsPromise = null, pano = null, svService = null;
// Consecutive Street View lookups that came back with nothing. A couple is
// normal (coverage moves); a run of them means the key or its restrictions are
// wrong, and shuffling locations forever would hide that.
let panoFails = 0;
const MAX_PANO_FAILS = 3;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const guessesRef = () => ref(db, `rooms/${roomCode}/guesses`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const iLocked = () => lockedLocal || (me()?.lockedRound || 0) >= (meta?.round?.num || 1);

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const wrapLng = (lng) => ((lng + 180) % 360 + 360) % 360 - 180;

// ── Difficulty ────────────────────────────────────────────────────────────────
// One setting, read differently by each mode.
//
//   pools   which Street View lists the round is drawn from ("s" = famous
//           landmarks, "o" = offbeat towns — see locations.js)
//   frozen  no walking, no panning, no zooming: one fixed view, GeoGuessr's
//           NMPZ. Street View offers no option for "don't let them drag", so
//           the pano gets a transparent lid (#pano-lock) that eats the events.
//   clues / openClues  clue mode: how many of the four clues ever appear, and
//           how many are on screen at the start. Hard never reaches the
//           giveaway clue — you get the two cryptic ones and your wits.
const DIFFICULTY = {
  easy:   { label: "🙂 Easy",   pools: ["s"],      frozen: false, clues: 4, openClues: 2 },
  normal: { label: "😐 Normal", pools: ["s", "o"], frozen: false, clues: 4, openClues: 1 },
  hard:   { label: "💀 Hard",   pools: ["o"],      frozen: true,  clues: 2, openClues: 1 },
};
const diffOf = (m) => DIFFICULTY[m?.settings?.difficulty] || DIFFICULTY.normal;
const diff = () => diffOf(meta);

const POOL_LIST = { s: STREETVIEW_SPOTS, o: OFFBEAT_SPOTS, c: CLUE_SPOTS };

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const scoreFor = (km) => Math.round(5000 * Math.exp(-km / 1500));

function roundSpot(r) {
  // `pool` arrived with difficulty; rooms created before it only ever used the
  // famous list in Street View mode.
  const pool = r.pool || (r.mode === "streetview" ? "s" : "c");
  return POOL_LIST[pool]?.[r.locIdx];
}

// Pick an unused location for a mode; usedLocs keys are "s12"/"o3"/"c7", so a
// game can mix pools without the indices colliding.
function pickLocation(mode, settings, used) {
  const pools = mode === "streetview" ? diffOf({ settings }).pools : ["c"];
  let fresh = [];
  for (const p of pools) {
    POOL_LIST[p].forEach((_, i) => { if (!used[p + i]) fresh.push([p, i]); });
  }
  // Pool exhausted (a long night) — recycle rather than repeat the same spot.
  if (!fresh.length) for (const p of pools) POOL_LIST[p].forEach((_, i) => fresh.push([p, i]));
  const [pool, idx] = rand(fresh);
  return {
    pool, idx,
    used: { ...used, [pool + idx]: true },
    // Everyone starts facing the same way — and in frozen mode that's the only
    // way they'll ever face, so it must come from the room, not the client.
    heading: Math.floor(Math.random() * 360),
  };
}

// ── Screens ───────────────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["explore", "reveal"]) {
    $(`view-${v}`).classList.toggle("hidden", v !== name);
  }
}

// ── Join screen ───────────────────────────────────────────────────────────────
$("name-input").value = localStorage.getItem("pg_name") || "";
if (location.hash.length > 1) $("code-input").value = location.hash.slice(1).toUpperCase();
showScreen("join");

function joinError(msg) {
  const el = $("join-error");
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}
function myName() {
  const n = $("name-input").value.trim();
  if (!n) { joinError("Enter your name first."); return null; }
  localStorage.setItem("pg_name", n);
  return n;
}
const randCode = () => Array.from({ length: 4 }, () =>
  "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]).join("");

$("btn-create").addEventListener("click", async () => {
  const name = myName(); if (!name) return;
  joinError("");
  try {
    const code = randCode();
    await set(ref(db, `rooms/${code}/meta`), {
      game: "globetrotter",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 5, guessSeconds: 90, mode: "clue", difficulty: "normal" },
    });
    await enterRoom(code, name);
  } catch (e) {
    joinError("Couldn't reach the database. Check the Firebase config and your network. (" + e.message + ")");
  }
});

$("btn-join").addEventListener("click", async () => {
  const name = myName(); if (!name) return;
  const code = $("code-input").value.trim().toUpperCase();
  if (code.length !== 4) { joinError("Room codes are 4 letters."); return; }
  joinError("");
  try {
    const snap = await get(ref(db, `rooms/${code}/meta`));
    if (!snap.exists()) { joinError(`Room ${code} not found.`); return; }
    if (snap.val().game !== "globetrotter") {
      joinError(`Room ${code} is a ${snap.val().game || "different"} room — join it from that game's page.`);
      return;
    }
    await enterRoom(code, name);
  } catch (e) {
    joinError("Couldn't reach the database. Check the Firebase config and your network. (" + e.message + ")");
  }
});

async function enterRoom(code, name) {
  roomCode = code;
  location.hash = code;

  const meRef = child(playersRef(), pid);
  const existing = (await get(meRef)).val();
  // Joining mid-round? Pre-lock this round so we never stall the advance.
  const m = (await get(metaRef())).val();
  const midRoundLock = m?.state && m.state !== "lobby" ? (m.round?.num || 0) : 0;

  await update(meRef, {
    name,
    connected: true,
    joinedAt: existing?.joinedAt || serverTimestamp(),
    score: existing?.score || 0,
    lockedRound: Math.max(existing?.lockedRound || 0, midRoundLock),
  });
  trackPresence(db, meRef);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
  onValue(guessesRef(), (s) => { guessesAll = s.val() || {}; if (meta?.state === "reveal") renderRevealMap(); });
}

function leaveRoom() {
  if (roomCode) set(ref(db, `rooms/${roomCode}/players/${pid}/connected`), false);
  location.hash = "";
  location.reload();
}
$("btn-leave-lobby").addEventListener("click", leaveRoom);

// ── State machine ─────────────────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

async function startGame() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < 2) { alert("Need at least 2 players."); return; }

  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/score`] = 0;
    resets[`${id}/lockedRound`] = 0;
  }
  await update(playersRef(), resets);
  await remove(guessesRef());

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const mode = hasKey && m.settings.mode === "streetview" ? "streetview" : "clue";
    const pick = pickLocation(mode, m.settings, {});
    return {
      ...m, state: "exploring", usedLocs: pick.used,
      round: {
        num: 1, mode, locIdx: pick.idx, pool: pick.pool, heading: pick.heading,
        createdAt: nowSrv(),
        endsAt: nowSrv() + m.settings.guessSeconds * 1000,
      },
    };
  });
}

// Host replaces the current round's location (no Street View imagery found).
function repickLocation() {
  const n = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "exploring" || m.round?.num !== n) return;
    const pick = pickLocation(m.round.mode, m.settings, m.usedLocs || {});
    return {
      ...m, usedLocs: pick.used,
      round: {
        ...m.round, locIdx: pick.idx, pool: pick.pool, heading: pick.heading,
        createdAt: nowSrv(),
        endsAt: nowSrv() + m.settings.guessSeconds * 1000,
      },
    };
  });
}

function advanceToReveal() {
  const n = meta.round.num;
  const roundGuesses = guessesAll[n] || {};
  const spot = roundSpot(meta.round);
  const results = {};
  let bestPid = null, bestKm = Infinity;
  for (const [id, g] of Object.entries(roundGuesses)) {
    if (typeof g?.lat !== "number" || typeof g?.lng !== "number") continue;
    const km = haversineKm(spot.lat, spot.lng, g.lat, g.lng);
    const pts = scoreFor(km);
    results[id] = { km: Math.round(km), pts };
    if (km < bestKm) { bestKm = km; bestPid = id; }
  }
  txMeta((m) => {
    if (m.state !== "exploring" || m.round?.num !== n) return;
    return {
      ...m, state: "reveal",
      round: { ...m.round, endsAt: nowSrv() + 12000, results, bestPid: bestPid || null },
    };
  }).then((res) => {
    if (res.committed && res.snapshot.val()?.state === "reveal") {
      for (const [id, r] of Object.entries(results)) {
        runTransaction(ref(db, `rooms/${roomCode}/players/${id}/score`), (v) => (v || 0) + r.pts);
      }
    }
  });
}

function nextRound() {
  const n = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "reveal" || m.round?.num !== n) return;
    if (n >= m.settings.rounds) return { ...m, state: "gameEnd" };
    const mode = hasKey && m.settings.mode === "streetview" ? "streetview" : "clue";
    const pick = pickLocation(mode, m.settings, m.usedLocs || {});
    return {
      ...m, state: "exploring", usedLocs: pick.used,
      round: {
        num: n + 1, mode, locIdx: pick.idx, pool: pick.pool, heading: pick.heading,
        createdAt: nowSrv(),
        endsAt: nowSrv() + m.settings.guessSeconds * 1000,
        results: null, bestPid: null,
      },
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedLocs: null };
  }).then((res) => { if (res.committed) remove(guessesRef()); });
}

// ── Guessing ──────────────────────────────────────────────────────────────────
function lockGuess(auto = false) {
  if (!meta || meta.state !== "exploring" || iLocked()) return;
  if (!pinLatLng) {
    if (!auto) return;
    // Timed out with no pin: mark locked so the round can end; no guess = 0.
    lockedLocal = true;
    update(child(playersRef(), pid), { lockedRound: meta.round.num });
    render();
    return;
  }
  lockedLocal = true;
  set(ref(db, `rooms/${roomCode}/guesses/${meta.round.num}/${pid}`), {
    lat: pinLatLng.lat, lng: wrapLng(pinLatLng.lng), t: serverTimestamp(),
  });
  update(child(playersRef(), pid), { lockedRound: meta.round.num });
  render();
}
$("btn-lock").addEventListener("click", () => lockGuess(false));

// ── Basemap ───────────────────────────────────────────────────────────────────
// Esri's World Street Map rather than standard OSM tiles, for one reason: it
// labels the world in English. OSM renders each place in its *local* language,
// so at the zoom you actually drop a pin you're picking between 中国, ประเทศไทย
// and မြန်မာ — fine if you read them, useless otherwise. Esri labels the same
// tiles "CHINA", "MYANMAR (BURMA)", "Seoul City Hall", keeping the local name
// alongside. No API key, attribution required.
//
// If Esri is unreachable, fall back to OSM rather than showing a blank world.
const ESRI_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
const ESRI_ATTR = "Tiles &copy; Esri — Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, " +
  "NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom";

function addBasemap(map) {
  const esri = L.tileLayer(ESRI_URL, { attribution: ESRI_ATTR, maxZoom: 19 }).addTo(map);
  let errors = 0;
  esri.on("tileerror", () => {
    if (++errors < 6 || !map.hasLayer(esri)) return;
    map.removeLayer(esri);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors", maxZoom: 19,
    }).addTo(map);
  });
  return esri;
}

function ensureGuessMap() {
  if (guessMap) return;
  guessMap = L.map("guess-map", { worldCopyJump: true, minZoom: 1 }).setView([22, 10], 1);
  addBasemap(guessMap);
  guessMap.on("click", (e) => {
    if (iLocked() || meta?.state !== "exploring") return;
    placePin(e.latlng);
  });
}

function placePin(latlng) {
  pinLatLng = latlng;
  const icon = L.divIcon({ className: "pin-icon", html: "📍", iconSize: [30, 30], iconAnchor: [15, 28] });
  if (!guessPin) {
    guessPin = L.marker(latlng, { icon, draggable: true }).addTo(guessMap);
    guessPin.on("dragend", () => {
      if (iLocked()) { guessPin.setLatLng(pinLatLng); return; }
      pinLatLng = guessPin.getLatLng();
    });
  } else {
    guessPin.setLatLng(latlng);
  }
  renderLockButton();
}

function clearPin() {
  pinLatLng = null;
  if (guessPin) { guessPin.remove(); guessPin = null; }
}

// ── Street View ───────────────────────────────────────────────────────────────
// Google calls this when it rejects the key — almost always because the key's
// referrer restrictions don't list the site it's running on (see
// maps-config.js). Without it the game looks like it merely can't find
// imagery, and the host's client shuffles through locations forever.
let mapsAuthFailed = false;
window.gm_authFailure = () => { mapsAuthFailed = true; };

function loadGoogleMaps() {
  if (gmapsPromise) return gmapsPromise;
  gmapsPromise = new Promise((resolve, reject) => {
    window.__gmapsReady = () => resolve(window.google);
    const s = document.createElement("script");
    // language=en so any Google-rendered text matches the rest of the game.
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsConfig.apiKey)}&v=weekly&language=en&callback=__gmapsReady`;
    s.onerror = () => reject(new Error("Google Maps failed to load"));
    document.head.appendChild(s);
  });
  return gmapsPromise;
}

/**
 * Find a panorama to drop the room into.
 *
 * `source: OUTDOOR` alone is not enough: it still matches user-contributed
 * photospheres, and at a famous landmark those outnumber Google's own imagery
 * — an audit of this game's 61 spots found 54 resolving to somebody's personal
 * 360, often shot inside a lobby or gift shop and with no links to walk along.
 * That is the "why am I in a building?" bug. Asking for GOOGLE *and* OUTDOOR
 * (the sources are intersected) gets the real Street View car imagery.
 *
 * Falls back to a wider search before giving up — 1 km is nothing on a scale
 * where 1,500 km still scores points, and it rescues spots whose square the
 * camera car couldn't drive into.
 */
async function findPano(g, spot) {
  const S = g.maps.StreetViewSource;
  // `sources` (plural, intersected) is the modern field; keep a path for an
  // older Maps build that only knows `source`.
  const pick = S.GOOGLE ? { sources: [S.GOOGLE, S.OUTDOOR] } : { source: S.OUTDOOR };
  for (const radius of [spot.radius || 200, 1000]) {
    try {
      return await svService.getPanorama({
        location: { lat: spot.lat, lng: spot.lng }, radius, ...pick,
      });
    } catch { /* widen, then give up and let the host repick */ }
  }
  return null;
}

async function initPano(spot, forRound) {
  $("pano-wrap").classList.remove("hidden");
  $("pano").classList.remove("hidden");
  $("clue-card").classList.add("hidden");
  setPanoStatus("Loading imagery…");
  const frozen = diff().frozen;
  try {
    const g = await loadGoogleMaps();
    if (meta?.round?.num !== forRound || meta?.state !== "exploring") return;
    if (!pano) {
      pano = new g.maps.StreetViewPanorama($("pano"), {
        visible: true,
        addressControl: false,
        showRoadLabels: false,
        fullscreenControl: false,
        enableCloseButton: false,
        motionTracking: false,
        motionTrackingControl: false,
      });
    }
    // Hard mode: no walking, no zooming, and the lid below kills dragging.
    pano.setOptions({
      linksControl: !frozen,
      clickToGo: !frozen,
      scrollwheel: !frozen,
      panControl: !frozen,
      zoomControl: !frozen,
      disableDoubleClickZoom: frozen,
    });
    $("pano-lock").classList.toggle("hidden", !frozen);

    svService = svService || new g.maps.StreetViewService();
    const res = await findPano(g, spot);
    if (meta?.round?.num !== forRound || meta?.state !== "exploring") return;
    if (!res) throw new Error("no imagery");

    pano.setPano(res.data.location.pano);
    pano.setPov({ heading: meta.round.heading || 0, pitch: 0 });
    pano.setZoom(0);
    pano.setVisible(true);
    setPanoStatus("");
    panoFails = 0;
  } catch (e) {
    // A rejected key fails *every* location, so repicking just shuffles the
    // world forever. Say what's actually wrong and stop.
    if (mapsAuthFailed) {
      setPanoStatus("⚠️ Google rejected this site's Maps API key — add this site to the key's " +
        "website restrictions (see maps-config.js). Guess from the map, or play Clue mode.");
      return;
    }
    panoFails++;
    if (panoFails > MAX_PANO_FAILS) {
      setPanoStatus("⚠️ Street View keeps coming back empty — check the Maps API key and its " +
        "restrictions (maps-config.js). You can still drop a pin.");
      return;
    }
    setPanoStatus("No imagery at this spot — finding another…");
    if (isHost() && meta?.round?.num === forRound && meta?.state === "exploring") {
      setTimeout(() => {
        if (meta?.round?.num === forRound && meta?.state === "exploring") repickLocation();
      }, 1200);
    }
  }
}

function setPanoStatus(msg) {
  const el = $("pano-status");
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function render() {
  if (!meta) return;
  if (meta.state === "lobby") {
    loadedRound = -1;
    revealShownFor = -1;
    showScreen("lobby");
    renderLobby();
    return;
  }
  showScreen("game");
  $("overlay").classList.toggle("hidden", meta.state !== "gameEnd");

  const r = meta.round;
  $("round-info").textContent = r ? `Round ${r.num}/${meta.settings.rounds}` : "";

  if (meta.state === "exploring") {
    setupRound();
    showView("explore");
    $("mode-label").textContent =
      r.mode !== "streetview" ? "🕵️ Read the clues… where is it?"
      : diff().frozen ? "🧊 One frozen view — no moving, no looking around"
      : "🚶 Walk around… where are you?";
    renderClues();
    renderLockButton();
    renderLockedList();
  } else if (meta.state === "reveal") {
    showView("reveal");
    const spot = roundSpot(r);
    $("mode-label").textContent = "🌍 The reveal";
    $("reveal-title").textContent = `It was ${spot.name}!`;
    renderRevealMap();
    renderResultsList();
    $("btn-next-round").classList.toggle("hidden", !isHost());
    $("btn-next-round").textContent = r.num >= meta.settings.rounds ? "Final scores 🏁" : "Next ▶";
    $("reveal-waiting").classList.toggle("hidden", isHost());
  } else if (meta.state === "gameEnd") {
    renderGameEnd();
  }
  renderTimer();
}

function renderLobby() {
  $("lobby-code").textContent = roomCode;
  const ul = $("lobby-player-list");
  ul.innerHTML = "";
  for (const [id, p] of Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))) {
    if (!p.connected) continue;
    const li = document.createElement("li");
    li.textContent = `${p.name}${meta.hostId === id ? " 👑" : ""}${id === pid ? " (you)" : ""}`;
    if (id === pid) li.classList.add("me");
    ul.appendChild(li);
  }
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  $("key-note").classList.toggle("hidden", hasKey);
  if (isHost()) {
    const modeSel = $("set-mode");
    modeSel.value = meta.settings.mode;
    [...modeSel.options].forEach((o) => { if (o.value === "streetview") o.disabled = !hasKey; });
    if (!hasKey && meta.settings.mode === "streetview") {
      update(child(metaRef(), "settings"), { mode: "clue" });
    }
    $("set-rounds").value = String(meta.settings.rounds);
    $("set-seconds").value = String(meta.settings.guessSeconds);
    $("set-difficulty").value = meta.settings.difficulty || "normal";
  }
  $("difficulty-note").textContent = difficultyNote();
}

// What the chosen difficulty actually does, in the mode they've chosen.
function difficultyNote() {
  const key = meta.settings.difficulty || "normal";
  const sv = (meta.settings.mode === "streetview") && hasKey;
  const notes = {
    easy: sv ? "World-famous spots. Walk, look and zoom freely."
             : "Two clues up front, all four by halfway.",
    normal: sv ? "Famous landmarks mixed with ordinary towns. Walk, look and zoom freely."
               : "Four clues, revealing one by one — cryptic first, giveaway last.",
    hard: sv ? "Ordinary streets, no landmarks — and the view is frozen: no walking, no looking around, no zoom."
             : "Only the two cryptic clues. The giveaway ones never arrive.",
  };
  return `${DIFFICULTY[key].label} — ${notes[key]}`;
}

function setupRound() {
  const r = meta.round;
  if (loadedRound === r.num && setupRound.locIdx === r.locIdx) return;
  loadedRound = r.num;
  setupRound.locIdx = r.locIdx; // repickLocation changes location within the same round
  lockedLocal = (me()?.lockedRound || 0) >= r.num;
  clearPin();
  ensureGuessMap();
  guessMap.setView([22, 10], 1);
  setTimeout(() => guessMap.invalidateSize(), 60);

  const spectating = (me()?.lockedRound || 0) >= r.num && !((guessesAll[r.num] || {})[pid]) && joinedMidRound(r);
  $("spectate-card").classList.toggle("hidden", !spectating);

  if (r.mode === "streetview" && hasKey) {
    $("clue-card").classList.add("hidden");
    initPano(roundSpot(r), r.num);
  } else {
    // Clue mode — also the defensive fallback if meta says streetview but we
    // have no key (all clients share one deployment, so this shouldn't happen).
    $("pano-wrap").classList.add("hidden");
    $("pano").classList.add("hidden");
    $("pano-lock").classList.add("hidden");
    setPanoStatus("");
    if (r.mode === "streetview" && !hasKey) {
      $("clue-card").classList.remove("hidden");
      $("clue-list").innerHTML = `<li>⚠️ This round is Street View mode but no Maps key is configured here. Guess bravely!</li>`;
    } else {
      $("clue-card").classList.remove("hidden");
      renderClues();
    }
  }
}

function joinedMidRound(r) {
  const j = me()?.joinedAt || 0;
  return typeof j === "number" && j > (r.createdAt || 0);
}

function renderClues() {
  const r = meta?.round;
  if (!r || r.mode !== "clue" || meta.state !== "exploring") return;
  const spot = CLUE_SPOTS[r.locIdx];
  if (!spot) return;
  const d = diff();
  const dur = meta.settings.guessSeconds * 1000;
  // Clamp: a client whose clock reads a hair before the round started would
  // floor to -1 and show no clues at all for the first moment.
  const elapsed = Math.max(0, nowSrv() - (r.endsAt - dur));
  // Hard stops at clue 2 — the giveaway ones never arrive. Easy opens with two
  // already showing and has all four by halfway.
  const revealed = Math.min(d.clues, d.openClues + Math.floor((elapsed / dur) * d.clues));
  const ul = $("clue-list");
  const want = spot.clues.slice(0, d.clues).map((c, i) => (i < revealed ? c : null));
  const key = r.num + ":" + revealed + ":" + r.locIdx + ":" + d.clues;
  if (ul.dataset.key === key) return;
  ul.dataset.key = key;
  ul.innerHTML = "";
  want.forEach((c, i) => {
    const li = document.createElement("li");
    if (c) { li.textContent = `${i + 1}. ${c}`; }
    else { li.textContent = `${i + 1}. …`; li.classList.add("pending"); }
    ul.appendChild(li);
  });
}

function renderLockButton() {
  const btn = $("btn-lock");
  if (iLocked()) {
    btn.disabled = true;
    btn.textContent = "Locked ✔ waiting for the others…";
  } else if (!pinLatLng) {
    btn.disabled = true;
    btn.textContent = "Drop a pin on the map 📍";
  } else {
    btn.disabled = false;
    btn.textContent = "Lock guess 🔒";
  }
}

function renderLockedList() {
  const el = $("locked-list");
  const n = meta.round.num;
  el.innerHTML = "";
  for (const [id, p] of Object.entries(players)) {
    if (!p.connected) continue;
    const s = document.createElement("span");
    const done = (p.lockedRound || 0) >= n;
    s.textContent = `${done ? "✅" : "🌍"} ${p.name}`;
    if (done) s.classList.add("done");
    el.appendChild(s);
  }
}

function renderRevealMap() {
  const r = meta?.round;
  if (!r || meta.state !== "reveal") return;
  if (!revealMap) {
    revealMap = L.map("reveal-map", { worldCopyJump: true, minZoom: 1 }).setView([22, 10], 1);
    addBasemap(revealMap);
  }
  setTimeout(() => revealMap.invalidateSize(), 60);
  if (revealShownFor === r.num) return;
  revealShownFor = r.num;

  if (revealLayer) revealLayer.remove();
  revealLayer = L.layerGroup().addTo(revealMap);

  const spot = roundSpot(r);
  const pts = [[spot.lat, spot.lng]];
  L.marker([spot.lat, spot.lng], {
    icon: L.divIcon({ className: "target-icon", html: "⭐", iconSize: [30, 30], iconAnchor: [15, 15] }),
  }).addTo(revealLayer).bindTooltip(spot.name, { permanent: false });

  const roundGuesses = guessesAll[r.num] || {};
  for (const [id, g] of Object.entries(roundGuesses)) {
    if (typeof g?.lat !== "number") continue;
    const p = players[id];
    const initial = (p?.name || "?").trim().charAt(0).toUpperCase() || "?";
    L.marker([g.lat, g.lng], {
      icon: L.divIcon({ className: "", html: `<div class="player-dot">${initial}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
    }).addTo(revealLayer).bindTooltip(
      `${p?.name || "?"} — ${r.results?.[id]?.km ?? "?"} km`, { permanent: false });
    L.polyline([[spot.lat, spot.lng], [g.lat, g.lng]], {
      color: id === pid ? "#ffd43b" : "#9aa0b5", weight: 2, dashArray: "6 6", opacity: .8,
    }).addTo(revealLayer);
    pts.push([g.lat, g.lng]);
  }
  if (pts.length > 1) revealMap.fitBounds(L.latLngBounds(pts).pad(0.3));
  else revealMap.setView([spot.lat, spot.lng], 4);
}

function renderResultsList() {
  const r = meta.round;
  const el = $("results-list");
  el.innerHTML = "";
  const rows = Object.entries(r.results || {})
    .map(([id, res]) => ({ id, ...res, name: players[id]?.name || "?" }))
    .sort((a, b) => b.pts - a.pts);
  if (!rows.length) {
    el.innerHTML = `<div class="result-row"><span class="rname">Nobody guessed. The world remains a mystery. 🫠</span></div>`;
  }
  for (const row of rows) {
    const div = document.createElement("div");
    div.className = "result-row" + (row.id === r.bestPid ? " best" : "") + (row.id === pid ? " me" : "");
    div.innerHTML = `
      <span>${row.id === r.bestPid ? "🎯" : "📍"}</span>
      <span class="rname">${esc(row.name)}</span>
      <span class="rdist">${row.km.toLocaleString()} km</span>
      <span class="rpts">+${row.pts.toLocaleString()}</span>`;
    el.appendChild(div);
  }
  // Non-guessers
  for (const [id, p] of Object.entries(players)) {
    if (!p.connected || (r.results || {})[id]) continue;
    if ((p.lockedRound || 0) < r.num) continue;
    const div = document.createElement("div");
    div.className = "result-row";
    div.innerHTML = `<span>🤷</span><span class="rname">${esc(p.name)}</span><span class="rdist">no pin</span><span class="rpts">+0</span>`;
    el.appendChild(div);
  }
}

function renderGameEnd() {
  const box = $("overlay-content");
  const rows = Object.entries(players)
    .filter(([, p]) => (p.score || 0) > 0 || p.connected)
    .map(([id, p]) => ({ id, name: p.name, score: p.score || 0 }))
    .sort((a, b) => b.score - a.score);
  const medals = ["🥇", "🥈", "🥉"];
  box.innerHTML = `
    <h2>🌍 Final scores</h2>
    <div class="big">${esc(rows[0]?.name || "?")} is the Globetrotter!</div>
    ${rows.map((r, i) => `
      <div class="final-row"><span>${medals[i] || "📍"} ${esc(r.name)}</span><span class="pts">${r.score.toLocaleString()}</span></div>`).join("")}
    ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
               : `<p class="hint">Waiting for the host…</p>`}
    <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
  box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
  box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || meta.state === "gameEnd") { el.textContent = "--"; el.classList.remove("low"); return; }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", meta.state === "exploring" && secs <= 10);
}

// ── Lobby interactions ────────────────────────────────────────────────────────
$("btn-start").addEventListener("click", startGame);
$("set-mode").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { mode: e.target.value === "streetview" && hasKey ? "streetview" : "clue" }));
$("set-rounds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { rounds: Number(e.target.value) }));
$("set-seconds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { guessSeconds: Number(e.target.value) }));
$("set-difficulty").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { difficulty: DIFFICULTY[e.target.value] ? e.target.value : "normal" }));
$("btn-next-round").addEventListener("click", nextRound);

$("btn-copy-link").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#${roomCode}`;
  try {
    await navigator.clipboard.writeText(url);
    $("btn-copy-link").textContent = "Copied!";
  } catch {
    prompt("Copy this link:", url);
  }
  setTimeout(() => { $("btn-copy-link").textContent = "Copy invite link"; }, 1500);
});

// ── Tick: timers, clue reveals, auto-lock, host advances ─────────────────────
let lowSince = null;
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const r = meta.round;
  const n = nowSrv();

  // Watchdog: fewer than 2 connected players mid-game → back to lobby.
  const active = meta.state === "exploring" || meta.state === "reveal";
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 2) {
    lowSince ??= Date.now();
    if (isHost() && Date.now() - lowSince > 10000) {
      txMeta((m) => (m.state === "lobby" || m.state === "gameEnd") ? undefined
        : { ...m, state: "lobby", round: null, usedLocs: null });
    }
  } else {
    lowSince = null;
  }

  if (meta.state === "exploring" && r?.endsAt) {
    renderClues();
    if (!iLocked() && n > r.endsAt) lockGuess(true);
    if (isHost()) {
      const allLocked = Object.values(players)
        .filter((p) => p.connected)
        .every((p) => (p.lockedRound || 0) >= r.num);
      if (allLocked || n > r.endsAt + 3000) advanceToReveal();
    }
  } else if (meta.state === "reveal" && r?.endsAt) {
    if (isHost() && n > r.endsAt) nextRound();
  }
}, 400);

// How long the host may be unreachable before somebody else takes over. The
// whole state machine is host-gated, so during this window nothing advances and
// nothing aborts — which is exactly what we want while a host's wifi reconnects.
const HOST_GRACE_MS = 12000;
let hostGoneSince = null;

function claimHostIfAbandoned() {
  if (!meta || !Object.keys(players).length) return;
  if (players[meta.hostId]?.connected) { hostGoneSince = null; return; }
  // A host whose connection drops is almost always blipping, not leaving.
  // Grabbing the role straight away used to hand the next client a view of the
  // room in which the absent host had "finished" every pending submission or
  // vote, so the round advanced or the room reset out from under them.
  hostGoneSince ??= Date.now();
  if (Date.now() - hostGoneSince < HOST_GRACE_MS) return;
  const conn = Object.entries(players)
    .filter(([, p]) => p.connected)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  if (conn[0]?.[0] === pid) {
    const oldHost = meta.hostId;
    runTransaction(child(metaRef(), "hostId"), (cur) => (cur === oldHost ? pid : undefined));
  }
}
