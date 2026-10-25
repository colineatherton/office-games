// Fakeout Gallery — a Drawful-style draw-and-bluff party game.
// Everyone draws a different secret prompt; each drawing is then titled by the
// room (truth or decoy) and voted on. All state lives under rooms/{CODE} in
// Firebase RTDB; the host's client drives the state machine via whole-meta
// transactions, with host migration if they vanish.
//
// Big Screen: opening the page with location.hash "#CODE-screen" renders a
// pure spectator view (never joins the players list, never advances state) —
// screen-share it in the call, Jackbox-style.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, onDisconnect, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { PROMPTS } from "./prompts.js";

const $ = (id) => document.getElementById(id);

// ── Config check ──────────────────────────────────────────────────────────────
if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("PASTE")) {
  showScreen("setup");
  throw new Error("Firebase config not filled in — see firebase-config.js");
}

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ── Identity & mode ───────────────────────────────────────────────────────────
const rawHash = decodeURIComponent(location.hash.slice(1));
const isScreen = /-screen$/i.test(rawHash);
const hashCode = rawHash.replace(/-screen$/i, "").toUpperCase();

const pid = (() => {
  let v = localStorage.getItem("pg_pid");
  if (!v) { v = Math.random().toString(36).slice(2, 10); localStorage.setItem("pg_pid", v); }
  return v;
})();

let roomCode = null;
let meta = null;
let players = {};
let art = {};        // rooms/{code}/art  — {artKey: {pid, prompt, img}}
let turns = {};      // rooms/{code}/turns — {turnKey: {titles, votes, found}}
let serverOffset = 0;
let drawingSubmitted = false;
let loadedPhaseKey = "";
let advancing = false;
let lowPlayersSince = null;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const artRef = () => ref(db, `rooms/${roomCode}/art`);
const turnsRef = () => ref(db, `rooms/${roomCode}/turns`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const participating = () => (meta?.order || []).includes(pid);

const turnKey = (m = meta) => `c${m.cycle}_t${m.turn?.idx ?? 0}`;
const artKeyFor = (cycle, p) => `c${cycle}_${p}`;
const curTurn = () => turns[turnKey()] || {};
const curArt = () => art[meta?.turn?.artKey] || null;
const artistPid = () => curArt()?.pid;
const isArtist = () => artistPid() === pid;

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const seededShuffle = (arr, seed) => {
  const r = mulberry32(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// ── Screens ───────────────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game", "big"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["draw", "wait", "title", "vote", "reveal", "spectate"]) {
    $(`view-${v}`).classList.toggle("hidden", v !== name);
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const normalize = (s) => s.toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .replace(/^(a|an|the) /, "")
  .replace(/[^a-z0-9 ]/g, "")
  .replace(/\s+/g, " ").trim();

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
const tooClose = (guess, truth) =>
  guess === truth || (truth.length >= 5 && levenshtein(guess, truth) <= 2);

// ── Join / create ─────────────────────────────────────────────────────────────
$("name-input").value = localStorage.getItem("pg_name") || "";
if (hashCode.length === 4) $("code-input").value = hashCode;

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
      game: "fakeout",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { drawSeconds: 90, cycles: 1 },
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
    if (snap.val().game !== "fakeout") {
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
  await update(meRef, {
    name,
    connected: true,
    joinedAt: existing?.joinedAt || serverTimestamp(),
    score: existing?.score || 0,
    fooled: existing?.fooled || 0,
    guessed: existing?.guessed || 0,
  });
  onDisconnect(child(meRef, "connected")).set(false);
  subscribe();
}

// Big Screen: pure spectator — reads everything, writes nothing, counts for nothing.
async function enterAsScreen(code) {
  roomCode = code;
  const snap = await get(ref(db, `rooms/${code}/meta`));
  if (!snap.exists() || snap.val().game !== "fakeout") {
    showScreen("join");
    joinError(`Room ${code} not found — check the Big Screen link.`);
    return;
  }
  subscribe();
}

function subscribe() {
  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
  onValue(artRef(), (s) => { art = s.val() || {}; render(); });
  onValue(turnsRef(), (s) => { turns = s.val() || {}; render(); });
}

function leaveRoom() {
  if (roomCode && !isScreen) set(ref(db, `rooms/${roomCode}/players/${pid}/connected`), false);
  location.hash = "";
  location.reload();
}
$("btn-leave-lobby").addEventListener("click", leaveRoom);

$("btn-bigscreen").addEventListener("click", () => {
  window.open(`${location.origin}${location.pathname}#${roomCode}-screen`, "_blank");
});

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

// ── State machine ─────────────────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function dealPrompts(cycle, order, used) {
  const avail = PROMPTS.map((_, i) => i).filter((i) => !used[`p${i}`]);
  const pool = avail.length >= order.length ? avail : PROMPTS.map((_, i) => i);
  const picked = seededShuffle(pool, Math.floor(Math.random() * 1e9)).slice(0, order.length);
  const deal = {}, newUsed = { ...used };
  order.forEach((p, i) => {
    deal[artKeyFor(cycle, p)] = PROMPTS[picked[i]];
    newUsed[`p${picked[i]}`] = true;
  });
  return { deal, used: newUsed };
}

async function startGame() {
  const order = Object.entries(players)
    .filter(([, p]) => p.connected)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
    .map(([id]) => id);
  if (order.length < 3) { alert("Need at least 3 players (4+ is where the bluffing sings)."); return; }

  // Pre-reset before flipping state so stale data can't leak into the new game.
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/score`] = 0;
    resets[`${id}/fooled`] = 0;
    resets[`${id}/guessed`] = 0;
  }
  await update(playersRef(), resets);
  await remove(artRef());
  await remove(turnsRef());

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const { deal, used } = dealPrompts(0, order, {});
    return {
      ...m,
      state: "drawing",
      startedAt: nowSrv(),
      order,
      cycle: 0,
      deal,
      usedPrompts: used,
      turnOrder: null,
      turn: null,
      endsAt: nowSrv() + m.settings.drawSeconds * 1000,
    };
  });
}

// drawing → first titling turn
function startGallery() {
  txMeta((m) => {
    if (m.state !== "drawing") return;
    const keys = (m.order || [])
      .map((p) => artKeyFor(m.cycle, p))
      .filter((k) => art[k]?.img); // only drawings that actually exist
    if (!keys.length) return { ...m, state: "gameEnd" };
    const orderShuffled = seededShuffle(keys, Math.floor(Math.random() * 1e9));
    return {
      ...m,
      state: "titling",
      turnOrder: orderShuffled,
      turn: {
        idx: 0, artKey: orderShuffled[0],
        seed: Math.floor(Math.random() * 1e9),
        endsAt: nowSrv() + 45000,
      },
    };
  });
}

// titling → voting (cards built from the committing client's snapshot)
function toVoting() {
  const m0 = meta;
  const t = turns[turnKey()] || {};
  const truth = art[m0.turn.artKey]?.prompt || "?";
  const truthNorm = normalize(truth);

  // Merge duplicate titles; drop anything that IS the truth (defensive).
  const groups = new Map(); // norm -> {text, authors[]}
  for (const [p, text] of Object.entries(t.titles || {})) {
    const n = normalize(text);
    if (!n || n === truthNorm) continue;
    if (!groups.has(n)) groups.set(n, { text, authors: [] });
    groups.get(n).authors.push(p);
  }
  const cards = [...groups.values()].map((g, i) => ({
    key: `k${i}`, text: g.text, authors: g.authors, truth: false,
  }));
  cards.push({ key: "truth", text: truth, authors: [], truth: true });
  const shuffled = seededShuffle(cards, m0.turn.seed);

  // Too few voters? Skip voting entirely and reveal.
  const eligibleVoters = (m0.order || []).filter(
    (p) => p !== art[m0.turn.artKey]?.pid && players[p]?.connected);
  if (eligibleVoters.length < 2) { toReveal(shuffled); return; }

  txMeta((m) => {
    if (m.state !== "titling" || m.turn?.idx !== m0.turn.idx || m.cycle !== m0.cycle) return;
    return { ...m, state: "voting", turn: { ...m.turn, cards: shuffled, endsAt: nowSrv() + 30000 } };
  });
}

// voting → reveal, with exactly-once scoring by the committing client
function toReveal(prebuiltCards = null) {
  const m0 = meta;
  const t = turns[turnKey()] || {};
  const cards = prebuiltCards || m0.turn.cards || [];
  const theArtist = art[m0.turn.artKey]?.pid;
  const byKey = Object.fromEntries(cards.map((c) => [c.key, c]));

  const gains = {};  // pid -> {score, fooled, guessed}
  const bump = (p, f, n) => {
    if (!p) return;
    gains[p] = gains[p] || { score: 0, fooled: 0, guessed: 0 };
    gains[p][f] += n;
  };

  const truthVoters = [];
  const cardVoters = {}; // key -> [pids]
  for (const [p, key] of Object.entries(t.votes || {})) {
    const c = byKey[key];
    if (!c) continue;
    (cardVoters[key] = cardVoters[key] || []).push(p);
    if (c.truth) { truthVoters.push(p); bump(p, "score", 100); }
    else {
      const share = Math.floor(50 / c.authors.length);
      for (const a of c.authors) { bump(a, "score", share); bump(a, "fooled", 1); }
    }
  }
  const finders = Object.keys(t.found || {});
  for (const p of finders) bump(p, "score", 50);
  const seers = truthVoters.length + finders.length;
  if (seers) { bump(theArtist, "score", 50 * seers); bump(theArtist, "guessed", seers); }

  const results = { truthVoters, finders, cardVoters, artist: theArtist };

  txMeta((m) => {
    if ((m.state !== "voting" && m.state !== "titling") ||
        m.turn?.idx !== m0.turn.idx || m.cycle !== m0.cycle) return;
    return {
      ...m, state: "reveal",
      turn: { ...m.turn, cards, results, endsAt: nowSrv() + 10000 },
    };
  }).then((res) => {
    if (!res.committed || res.snapshot.val()?.state !== "reveal") return;
    for (const [p, g] of Object.entries(gains)) {
      runTransaction(child(playersRef(), p), (cur) => cur ? {
        ...cur,
        score: (cur.score || 0) + g.score,
        fooled: (cur.fooled || 0) + g.fooled,
        guessed: (cur.guessed || 0) + g.guessed,
      } : cur);
    }
  });
}

function nextTurn() {
  txMeta((m) => {
    if (m.state !== "reveal") return;
    const nextIdx = m.turn.idx + 1;
    if (nextIdx < (m.turnOrder || []).length) {
      return {
        ...m, state: "titling",
        turn: {
          idx: nextIdx, artKey: m.turnOrder[nextIdx],
          seed: Math.floor(Math.random() * 1e9),
          endsAt: nowSrv() + 45000,
        },
      };
    }
    if (m.cycle + 1 < Number(m.settings.cycles)) {
      const { deal, used } = dealPrompts(m.cycle + 1, m.order, m.usedPrompts || {});
      return {
        ...m, state: "drawing",
        cycle: m.cycle + 1,
        deal: { ...m.deal, ...deal },
        usedPrompts: used,
        turnOrder: null, turn: null,
        endsAt: nowSrv() + m.settings.drawSeconds * 1000,
      };
    }
    return { ...m, state: "gameEnd", turn: null };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return {
      ...m, state: "lobby",
      order: null, cycle: null, deal: null, usedPrompts: null,
      turnOrder: null, turn: null, endsAt: null, startedAt: null,
    };
  }).then((res) => {
    if (res.committed) { remove(artRef()); remove(turnsRef()); }
  });
}

// ── Submissions ───────────────────────────────────────────────────────────────
function submitDrawing() {
  if (!meta || meta.state !== "drawing" || !participating() || drawingSubmitted) return;
  drawingSubmitted = true;
  const out = document.createElement("canvas");
  out.width = 560; out.height = 416;
  const octx = out.getContext("2d");
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(board, 0, 0, out.width, out.height);
  const key = artKeyFor(meta.cycle, pid);
  set(child(artRef(), key), {
    pid, prompt: meta.deal?.[key] || "?", img: out.toDataURL("image/png"),
  });
  render();
}
$("btn-submit-draw").addEventListener("click", submitDrawing);

function submitTitle() {
  if (!meta || meta.state !== "titling" || !participating() || isArtist()) return;
  const input = $("title-input");
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  const truth = curArt()?.prompt || "";
  const tk = turnKey();
  if (tooClose(normalize(text), normalize(truth))) {
    // They basically guessed it: bank the find, demand a decoy.
    set(ref(db, `rooms/${roomCode}/turns/${tk}/found/${pid}`), true);
    input.value = "";
    const msg = $("title-msg");
    msg.textContent = "🎯 Too close — you've basically guessed it (+50 banked)! Now write a DECOY to fool the others.";
    msg.classList.add("close-call");
    input.focus();
    return;
  }
  set(ref(db, `rooms/${roomCode}/turns/${tk}/titles/${pid}`), text);
  render();
}
$("btn-submit-title").addEventListener("click", submitTitle);
$("title-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitTitle(); });

function castVote(card) {
  if (!meta || meta.state !== "voting" || !participating() || isArtist()) return;
  if (card.authors?.includes(pid)) return; // can't vote your own fake
  set(ref(db, `rooms/${roomCode}/turns/${turnKey()}/votes/${pid}`), card.key);
}

$("btn-next-turn").addEventListener("click", nextTurn);

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  if (isScreen) return; // the Big Screen never drives or claims anything

  claimHostIfAbandoned();

  // Low-players watchdog (min 3 during active play).
  const active = ["drawing", "titling", "voting"].includes(meta.state);
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 3) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) {
      txMeta((m) => (m.state === "lobby" || m.state === "gameEnd") ? undefined : {
        ...m, state: "lobby",
        order: null, cycle: null, deal: null, usedPrompts: null,
        turnOrder: null, turn: null, endsAt: null, startedAt: null,
      });
    }
  } else {
    lowPlayersSince = null;
  }

  if (!isHost() || advancing) return;
  const n = nowSrv();

  if (meta.state === "drawing") {
    const due = (meta.order || []).filter((p) => players[p]?.connected);
    const allDrawn = due.length && due.every((p) => art[artKeyFor(meta.cycle, p)]);
    if (allDrawn || (meta.endsAt && n > meta.endsAt + 3000)) guard(startGallery);
  } else if (meta.state === "titling" && meta.turn) {
    const t = curTurn();
    const eligible = (meta.order || []).filter((p) => p !== artistPid() && players[p]?.connected);
    const allTitled = eligible.length &&
      eligible.every((p) => t.titles?.[p] || t.found?.[p]);
    if (allTitled || n > meta.turn.endsAt + 3000) guard(toVoting);
  } else if (meta.state === "voting" && meta.turn) {
    const t = curTurn();
    const eligible = (meta.order || []).filter((p) => p !== artistPid() && players[p]?.connected);
    const allVoted = eligible.length && eligible.every((p) => t.votes?.[p]);
    if (allVoted || n > meta.turn.endsAt + 3000) guard(() => toReveal());
  } else if (meta.state === "reveal" && meta.turn) {
    if (n > meta.turn.endsAt) guard(nextTurn);
  }
}, 400);

async function guard(fn) {
  advancing = true;
  try { await fn(); } finally { advancing = false; }
}

function claimHostIfAbandoned() {
  if (!meta || !Object.keys(players).length) return;
  if (players[meta.hostId]?.connected) return;
  const conn = Object.entries(players)
    .filter(([, p]) => p.connected)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  if (conn[0]?.[0] === pid) {
    const oldHost = meta.hostId;
    runTransaction(child(metaRef(), "hostId"), (cur) => (cur === oldHost ? pid : undefined));
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function render() {
  if (!meta) return;
  if (isScreen) { showScreen("big"); renderBig(); return; }
  if (meta.state === "lobby") {
    loadedPhaseKey = "";
    drawingSubmitted = false;
    showScreen("lobby");
    renderLobby();
  } else {
    showScreen("game");
    renderGame();
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderLobby() {
  $("lobby-code").textContent = roomCode;
  const ul = $("lobby-player-list");
  ul.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    const li = document.createElement("li");
    li.textContent = `${p.name}${meta.hostId === id ? " 👑" : ""}${id === pid ? " (you)" : ""}`;
    if (id === pid) li.classList.add("me");
    ul.appendChild(li);
  }
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) {
    $("set-draw-seconds").value = String(meta.settings.drawSeconds);
    $("set-cycles").value = String(meta.settings.cycles);
  }
}

$("btn-start").addEventListener("click", startGame);
$("set-draw-seconds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { drawSeconds: Number(e.target.value) }));
$("set-cycles").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { cycles: Number(e.target.value) }));

function renderGame() {
  const total = (meta.turnOrder || []).length;
  $("turn-info").textContent =
    meta.state === "drawing"
      ? `Drawing ${meta.cycle + 1}/${meta.settings.cycles}`
      : meta.turn ? `Gallery ${meta.turn.idx + 1}/${total}` : "";
  $("phase-label").textContent = {
    drawing: "🎨 Draw your secret prompt",
    titling: "✍️ Title the mystery",
    voting: "🗳️ Find the truth",
    reveal: "💡 The reveal",
    gameEnd: "🏁 Final gallery",
  }[meta.state] || "";

  renderScores();
  renderOverlay();

  // Phase change housekeeping (reset local inputs once per phase).
  const phaseKey = `${meta.state}:${meta.cycle}:${meta.turn?.idx ?? "-"}`;
  if (phaseKey !== loadedPhaseKey) {
    loadedPhaseKey = phaseKey;
    if (meta.state === "drawing") { drawingSubmitted = !!art[artKeyFor(meta.cycle, pid)]; clearStrokes(); }
    if (meta.state === "titling") {
      $("title-input").value = "";
      const msg = $("title-msg");
      msg.textContent = "Write the real title — or a fake that fools everyone.";
      msg.classList.remove("close-call");
    }
  }

  if (meta.state === "gameEnd") return; // overlay handles it

  if (!participating()) { showView("spectate"); return; }

  if (meta.state === "drawing") {
    const mine = art[artKeyFor(meta.cycle, pid)];
    if (mine || drawingSubmitted) { renderWait("every artist to finish", (p) => !!art[artKeyFor(meta.cycle, p)]); return; }
    $("my-prompt").textContent = meta.deal?.[artKeyFor(meta.cycle, pid)] || "?";
    showView("draw");
  } else if (meta.state === "titling") {
    if (isArtist()) { renderWait("them to butcher your art 🎨", titledCheck()); return; }
    const t = curTurn();
    if (t.titles?.[pid]) { renderWait("the other critics", titledCheck()); return; }
    $("title-art").src = curArt()?.img || "";
    showView("title");
  } else if (meta.state === "voting") {
    renderVoting();
  } else if (meta.state === "reveal") {
    renderReveal();
  }
}

const titledCheck = () => (p) => {
  const t = curTurn();
  return p === artistPid() || !!t.titles?.[p] || !!t.found?.[p];
};

function renderWait(what, doneFn) {
  $("wait-title").textContent = "✅ Submitted!";
  $("wait-sub").textContent = `Waiting for ${what}…`;
  const ul = $("wait-list");
  ul.innerHTML = "";
  for (const p of meta.order || []) {
    const pl = players[p];
    if (!pl) continue;
    const done = doneFn(p);
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : pl.connected ? "✏️" : "💤"} ${pl.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
  showView("wait");
}

function renderVoting() {
  const t = curTurn();
  if (isArtist()) { renderWait("the jury", (p) => p === artistPid() || !!t.votes?.[p]); return; }
  $("vote-art").src = curArt()?.img || "";
  const wrap = $("vote-cards");
  wrap.innerHTML = "";
  const myVote = t.votes?.[pid];
  for (const c of meta.turn.cards || []) {
    const b = document.createElement("button");
    b.className = "card-title" + (myVote === c.key ? " selected" : "");
    b.textContent = c.text;
    if (c.authors?.includes(pid)) {
      b.disabled = true;
      b.innerHTML = `${esc(c.text)}<span class="meta-line">your fake — can't vote for it</span>`;
    } else {
      b.addEventListener("click", () => castVote(c));
    }
    wrap.appendChild(b);
  }
  showView("vote");
}

function renderReveal() {
  const t = meta.turn;
  const r = t.results || {};
  const theArtist = players[r.artist];
  $("reveal-heading").textContent = `🎨 ${theArtist?.name || "?"} drew it!`;
  $("reveal-art").src = curArt()?.img || "";
  const wrap = $("reveal-cards");
  wrap.innerHTML = "";
  for (const c of t.cards || []) {
    const div = document.createElement("div");
    div.className = "card-title " + (c.truth ? "truth" : "lie");
    const voters = (r.cardVoters?.[c.key] || []).map((p) => players[p]?.name || "?");
    const authors = c.authors.map((p) => players[p]?.name || "?").join(" & ");
    div.innerHTML = `${esc(c.text)}<span class="meta-line">${
      c.truth
        ? `✅ THE TRUTH${voters.length ? ` — found by ${esc(voters.join(", "))}` : " — fooled everyone!"}`
        : `by ${esc(authors)}${voters.length ? ` — fooled ${esc(voters.join(", "))}` : ""}`
    }</span>`;
    wrap.appendChild(div);
  }
  const lines = $("reveal-scores");
  lines.innerHTML = "";
  if (r.finders?.length) {
    const d = document.createElement("div");
    d.innerHTML = `🎯 Typed the truth outright: <span class="gain">${esc(r.finders.map((p) => players[p]?.name || "?").join(", "))} (+50)</span>`;
    lines.appendChild(d);
  }
  $("btn-next-turn").classList.toggle("hidden", !isHost());
  showView("reveal");
}

function renderScores() {
  const list = $("score-list");
  list.innerHTML = "";
  const rows = (meta.order || [])
    .map((p) => [p, players[p]])
    .filter(([, pl]) => pl)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  for (const [p, pl] of rows) {
    const div = document.createElement("div");
    div.className = "score-row" + (p === pid ? " me" : "") + (pl.connected ? "" : " offline");
    div.innerHTML = `<span>${esc(pl.name)}</span><span>${pl.score || 0}</span>`;
    list.appendChild(div);
  }
}

function renderOverlay() {
  const ov = $("overlay");
  if (meta.state !== "gameEnd") { ov.classList.add("hidden"); return; }
  ov.classList.remove("hidden");
  const box = $("overlay-content");
  const rows = (meta.order || [])
    .map((p) => [p, players[p]])
    .filter(([, pl]) => pl)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  const medal = ["🥇", "🥈", "🥉"];
  const best = (field, label, emoji) => {
    const top = [...rows].sort((a, b) => (b[1][field] || 0) - (a[1][field] || 0))[0];
    return top && (top[1][field] || 0) > 0
      ? `<p class="award">${emoji} ${label}: <strong>${esc(top[1].name)}</strong></p>` : "";
  };
  box.innerHTML = `
    <h2>🏁 Gallery closed!</h2>
    ${rows.map(([, pl], i) =>
      `<div class="final-row"><span>${medal[i] || "·"} ${esc(pl.name)}</span><span class="pts">${pl.score || 0}</span></div>`).join("")}
    ${best("fooled", "Best deceiver", "🦊")}
    ${best("guessed", "Most-guessable artist", "🎨")}
    ${isHost()
      ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
      : `<p class="hint">Waiting for the host…</p>`}
    <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
  box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
  box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
}

function renderTimer() {
  const el = isScreen ? null : $("timer");
  const endsAt = meta?.state === "drawing" ? meta.endsAt : meta?.turn?.endsAt;
  const show = ["drawing", "titling", "voting"].includes(meta?.state) && endsAt;
  const secs = show ? Math.max(0, Math.ceil((endsAt - nowSrv()) / 1000)) : null;
  if (el) {
    el.textContent = secs ?? "--";
    el.classList.toggle("low", secs !== null && secs <= 10);
  }
  const bigT = document.querySelector("#big-stage .big-timer");
  if (bigT && secs !== null) bigT.textContent = secs;
}

// ── Big Screen rendering ─────────────────────────────────────────────────────
function renderBig() {
  const stage = $("big-stage");
  const pills = (doneFn) => (meta.order || Object.keys(players))
    .filter((id) => players[id])
    .map((id) =>
      `<span class="${doneFn && doneFn(id) ? "done" : ""}">${esc(players[id].name)}</span>`)
    .join("");

  if (meta.state === "lobby") {
    stage.innerHTML = `
      <h1>🖼️ Fakeout Gallery</h1>
      <p class="big-sub">Join at <strong>${esc(location.host + location.pathname)}</strong> with code</p>
      <div class="big-code">${roomCode}</div>
      <div class="big-pills">${pills(null)}</div>
      <p class="big-sub">Waiting for the host to start…</p>`;
  } else if (meta.state === "drawing") {
    stage.innerHTML = `
      <h1>🎨 Artists at work…</h1>
      <div class="big-timer">--</div>
      <div class="big-pills">${pills((p) => !!art[artKeyFor(meta.cycle, p)])}</div>
      <p class="big-sub">Everyone is drawing a different secret prompt. No peeking.</p>`;
  } else if (meta.state === "titling" && meta.turn) {
    const t = curTurn();
    stage.innerHTML = `
      <h1>✍️ What IS this?</h1>
      <img class="gallery-art" src="${curArt()?.img || ""}" alt="mystery drawing">
      <div class="big-timer">--</div>
      <div class="big-pills">${pills((p) => p === artistPid() || !!t.titles?.[p] || !!t.found?.[p])}</div>`;
  } else if (meta.state === "voting" && meta.turn) {
    const t = curTurn();
    stage.innerHTML = `
      <h1>🗳️ One of these is the real prompt</h1>
      <img class="gallery-art small" src="${curArt()?.img || ""}" alt="the drawing">
      <div class="cards">${(meta.turn.cards || []).map((c) =>
        `<div class="card-title">${esc(c.text)}</div>`).join("")}</div>
      <div class="big-timer">--</div>
      <div class="big-pills">${pills((p) => p === artistPid() || !!t.votes?.[p])}</div>`;
  } else if (meta.state === "reveal" && meta.turn) {
    const r = meta.turn.results || {};
    stage.innerHTML = `
      <h1>🎨 ${esc(players[r.artist]?.name || "?")} drew it!</h1>
      <img class="gallery-art small" src="${curArt()?.img || ""}" alt="the drawing">
      <div class="cards">${(meta.turn.cards || []).map((c) => {
        const voters = (r.cardVoters?.[c.key] || []).map((p) => players[p]?.name || "?");
        const authors = c.authors.map((p) => players[p]?.name || "?").join(" & ");
        return `<div class="card-title ${c.truth ? "truth" : "lie"}">${esc(c.text)}
          <span class="meta-line">${c.truth
            ? `✅ THE TRUTH${voters.length ? ` — found by ${esc(voters.join(", "))}` : " — fooled the whole room!"}`
            : `by ${esc(authors)}${voters.length ? ` — fooled ${esc(voters.join(", "))}` : ""}`}</span></div>`;
      }).join("")}</div>`;
  } else if (meta.state === "gameEnd") {
    const rows = (meta.order || [])
      .map((p) => players[p]).filter(Boolean)
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    const medal = ["🥇", "🥈", "🥉"];
    stage.innerHTML = `
      <h1>🏁 Final scores</h1>
      <div class="big-scores">${rows.map((p, i) =>
        `<div class="final-row"><span>${medal[i] || "·"} ${esc(p.name)}</span><span class="pts">${p.score || 0}</span></div>`).join("")}</div>`;
  }
}

// ── Local canvas (telephone's, trimmed) ───────────────────────────────────────
const board = $("board");
const ctx = board.getContext("2d");
const CW = board.width, CH = board.height;
ctx.lineCap = "round";
ctx.lineJoin = "round";

const COLORS = ["#000000", "#868e96", "#e03131", "#f08c00", "#ffd43b",
                "#2f9e44", "#1971c2", "#9c36b5", "#e64980", "#795548"];
const SIZES = [4, 9, 18];
let curColor = COLORS[0];
let curSize = SIZES[1];
let erasing = false;
let strokes = [];
let drawing = false;

const colorRow = $("color-row");
for (const c of COLORS) {
  const b = document.createElement("button");
  b.className = "color-btn";
  b.style.background = c;
  b.title = c;
  b.addEventListener("click", () => { curColor = c; erasing = false; refreshTools(); });
  colorRow.appendChild(b);
}
const eraserBtn = document.createElement("button");
eraserBtn.className = "tool-btn";
eraserBtn.textContent = "🧽";
eraserBtn.title = "Eraser";
eraserBtn.addEventListener("click", () => { erasing = !erasing; refreshTools(); });
colorRow.appendChild(eraserBtn);

const sizeRow = $("size-row");
for (const s of SIZES) {
  const b = document.createElement("button");
  b.className = "size-btn";
  b.innerHTML = `<i style="width:${Math.min(s, 20)}px;height:${Math.min(s, 20)}px"></i>`;
  b.addEventListener("click", () => { curSize = s; refreshTools(); });
  sizeRow.appendChild(b);
}
function refreshTools() {
  [...colorRow.querySelectorAll(".color-btn")].forEach((b, i) =>
    b.classList.toggle("active", !erasing && COLORS[i] === curColor));
  eraserBtn.style.outline = erasing ? "2px solid #ffd43b" : "none";
  [...sizeRow.children].forEach((b, i) => b.classList.toggle("active", SIZES[i] === curSize));
}
refreshTools();

$("btn-clear").addEventListener("click", clearStrokes);
$("btn-undo").addEventListener("click", () => { strokes.pop(); redrawAll(); });

function getPos(e) {
  const rect = board.getBoundingClientRect();
  return [
    Math.round((e.clientX - rect.left) / rect.width * CW),
    Math.round((e.clientY - rect.top) / rect.height * CH),
  ];
}
board.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  board.setPointerCapture(e.pointerId);
  drawing = true;
  const [x, y] = getPos(e);
  strokes.push({ c: erasing ? "#ffffff" : curColor, w: erasing ? curSize * 3 : curSize, p: [x, y, x + 1, y + 1] });
  redrawAll();
});
board.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  e.preventDefault();
  const s = strokes[strokes.length - 1];
  const [x, y] = getPos(e);
  const n = s.p.length;
  const dx = x - s.p[n - 2], dy = y - s.p[n - 1];
  if (dx * dx + dy * dy < 9) return;
  ctx.strokeStyle = s.c;
  ctx.lineWidth = s.w;
  ctx.beginPath();
  ctx.moveTo(s.p[n - 2], s.p[n - 1]);
  ctx.lineTo(x, y);
  ctx.stroke();
  s.p.push(x, y);
});
const stopStroke = () => { drawing = false; };
board.addEventListener("pointerup", stopStroke);
board.addEventListener("pointercancel", stopStroke);

function clearStrokes() { strokes = []; redrawAll(); }
function redrawAll() {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CW, CH);
  for (const s of strokes) {
    if (s.p.length < 4) continue;
    ctx.strokeStyle = s.c;
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(s.p[0], s.p[1]);
    for (let i = 2; i < s.p.length; i += 2) ctx.lineTo(s.p[i], s.p[i + 1]);
    ctx.stroke();
  }
}
redrawAll();

// Auto-submit the drawing at timeout (own client drives it).
setInterval(() => {
  if (meta?.state === "drawing" && participating() && !drawingSubmitted &&
      meta.endsAt && nowSrv() > meta.endsAt && !art[artKeyFor(meta.cycle, pid)]) {
    submitDrawing();
  }
}, 500);

// ── Boot ──────────────────────────────────────────────────────────────────────
if (isScreen && hashCode.length === 4) {
  enterAsScreen(hashCode);
  showScreen("big");
  $("big-stage").innerHTML = `<h1>🖼️ Fakeout Gallery</h1><p class="big-sub">Connecting…</p>`;
} else {
  showScreen("join");
}
