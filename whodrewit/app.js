// Who Drew It? — everyone draws the same prompt, the gallery comes back
// anonymous, and players score by matching drawings to artists (+5 each) and
// judging the best (+10 to its artist) and worst (−5). Individual scores.
//
// Sync model follows telephone/: all state under rooms/{CODE}; whole-meta
// transactions for phase transitions; the host's client drives advancement.

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

// ── Identity & state ──────────────────────────────────────────────────────────
const pid = (() => {
  let v = localStorage.getItem("pg_pid");
  if (!v) { v = Math.random().toString(36).slice(2, 10); localStorage.setItem("pg_pid", v); }
  return v;
})();

let roomCode = null;
let meta = null;
let players = {};
let serverOffset = 0;
let advancing = false;
let lowPlayersSince = null;

// per-phase locals
let loadedKey = "";          // `${round}:${state}` guard for one-time phase setup
let drewLocal = false;
let linkedLocal = false;
let myAssign = {};           // drawingArtistPid -> guessedArtistPid
let myBest = null;
let myWorst = null;

// art cache for the current round
let artRound = -1;
let artCache = {};           // artistPid -> img dataURL
let artUnsub = null;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const artRef = (n) => ref(db, `rooms/${roomCode}/art/${n}`);
const linksRef = (n) => ref(db, `rooms/${roomCode}/links/${n}`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const inRound = () => (meta?.round?.order || []).includes(pid);

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

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

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── Screens & views ───────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["draw", "wait", "link", "results", "spectate"]) {
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
      game: "whodrewit",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 3, drawSeconds: 90 },
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
    if (snap.val().game !== "whodrewit") {
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
    worstWins: existing?.worstWins || 0,
    drewRound: existing?.drewRound || 0,
    linkedRound: existing?.linkedRound || 0,
  });
  onDisconnect(child(meRef, "connected")).set(false);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
}

function leaveRoom() {
  if (roomCode) set(ref(db, `rooms/${roomCode}/players/${pid}/connected`), false);
  location.hash = "";
  location.reload();
}
$("btn-leave-lobby").addEventListener("click", leaveRoom);

// ── State-machine transactions ────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function pickPrompt(used = {}) {
  const fresh = PROMPTS.filter((p) => !used[keyify(p)]);
  const pool = fresh.length ? fresh : PROMPTS;
  return pool[Math.floor(Math.random() * pool.length)];
}
const keyify = (p) => p.replace(/[.#$/\[\]]/g, "_").slice(0, 60);

const connectedIds = () =>
  Object.entries(players)
    .filter(([, p]) => p.connected)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
    .map(([id]) => id);

async function startGame() {
  const order = connectedIds();
  if (order.length < 3) { alert("Need at least 3 players."); return; }

  // Reset BEFORE flipping state so stale per-round markers can't skip phases.
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/score`] = 0;
    resets[`${id}/worstWins`] = 0;
    resets[`${id}/drewRound`] = 0;
    resets[`${id}/linkedRound`] = 0;
  }
  await update(playersRef(), resets);
  await remove(ref(db, `rooms/${roomCode}/art`));
  await remove(ref(db, `rooms/${roomCode}/links`));

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const prompt = pickPrompt({});
    return {
      ...m,
      state: "drawing",
      usedPrompts: { [keyify(prompt)]: true },
      round: {
        num: 1, prompt, order,
        seed: Math.floor(Math.random() * 2 ** 31),
        endsAt: nowSrv() + m.settings.drawSeconds * 1000,
      },
    };
  });
}

async function advanceToLinking() {
  if (advancing || !meta) return;
  advancing = true;
  try {
    const n = meta.round.num;
    const artSnap = await get(artRef(n));
    const count = artSnap.exists() ? Object.keys(artSnap.val()).length : 0;
    if (count < 2) {
      await computeAndCommitResults(n, true);
      return;
    }
    await txMeta((m) => {
      if (m.state !== "drawing" || m.round?.num !== n) return;
      return { ...m, state: "linking", round: { ...m.round, endsAt: nowSrv() + 60000 } };
    });
  } finally {
    advancing = false;
  }
}

async function advanceToResults() {
  if (advancing || !meta) return;
  advancing = true;
  try {
    await computeAndCommitResults(meta.round.num, false);
  } finally {
    advancing = false;
  }
}

async function computeAndCommitResults(n, skipped) {
  const [artSnap, linksSnap] = await Promise.all([get(artRef(n)), get(linksRef(n))]);
  const art = artSnap.val() || {};
  const links = linksSnap.val() || {};
  const artists = Object.keys(art);

  const deltas = {};
  const perDrawing = {};
  for (const a of artists) perDrawing[a] = { correct: [], bestVotes: 0, worstVotes: 0 };

  if (!skipped) {
    for (const [linker, l] of Object.entries(links)) {
      for (const a of artists) {
        if (a === linker) continue;
        if (l.assign?.[a] === a) {
          deltas[linker] = (deltas[linker] || 0) + 5;
          perDrawing[a].correct.push(linker);
        }
      }
      if (l.best && l.best !== linker && perDrawing[l.best]) perDrawing[l.best].bestVotes++;
      if (l.worst && l.worst !== linker && perDrawing[l.worst]) perDrawing[l.worst].worstVotes++;
    }
  }

  const maxBest = Math.max(0, ...artists.map((a) => perDrawing[a].bestVotes));
  const maxWorst = Math.max(0, ...artists.map((a) => perDrawing[a].worstVotes));
  const bestPids = maxBest > 0 ? artists.filter((a) => perDrawing[a].bestVotes === maxBest) : [];
  const worstPids = maxWorst > 0 ? artists.filter((a) => perDrawing[a].worstVotes === maxWorst) : [];
  for (const a of bestPids) deltas[a] = (deltas[a] || 0) + 10;
  for (const a of worstPids) deltas[a] = (deltas[a] || 0) - 5;

  const res = await txMeta((m) => {
    if (m.round?.num !== n) return;
    if (m.state !== "linking" && !(skipped && m.state === "drawing")) return;
    return {
      ...m,
      state: "results",
      round: {
        ...m.round,
        endsAt: nowSrv() + (skipped ? 6000 : 16000),
        results: { deltas, perDrawing, bestPids, worstPids, skipped },
      },
    };
  });

  // Only the committing client applies scores — exactly once.
  if (res.committed && res.snapshot.val()?.state === "results") {
    for (const [id, d] of Object.entries(deltas)) {
      runTransaction(ref(db, `rooms/${roomCode}/players/${id}/score`), (v) => (v || 0) + d);
    }
    for (const a of worstPids) {
      runTransaction(ref(db, `rooms/${roomCode}/players/${a}/worstWins`), (v) => (v || 0) + 1);
    }
  }
}

function nextRound() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "results" || m.round?.num !== expect) return;
    if (m.round.num >= m.settings.rounds) return { ...m, state: "gameEnd" };
    const order = connectedIds();
    if (order.length < 3) return { ...m, state: "gameEnd" };
    const used = m.usedPrompts || {};
    const prompt = pickPrompt(used);
    return {
      ...m,
      state: "drawing",
      usedPrompts: { ...used, [keyify(prompt)]: true },
      round: {
        num: m.round.num + 1, prompt, order,
        seed: Math.floor(Math.random() * 2 ** 31),
        endsAt: nowSrv() + m.settings.drawSeconds * 1000,
      },
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedPrompts: null };
  }).then((res) => {
    if (res.committed) {
      remove(ref(db, `rooms/${roomCode}/art`));
      remove(ref(db, `rooms/${roomCode}/links`));
    }
  });
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  // Low-players watchdog: the game needs 3; abort to lobby after a 10s grace.
  const conn = Object.values(players).filter((p) => p.connected).length;
  if (meta.state !== "lobby" && meta.state !== "gameEnd" && conn < 3) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) {
      txMeta((m) => (m.state !== "lobby" && m.state !== "gameEnd")
        ? { ...m, state: "lobby", round: null, usedPrompts: null } : undefined);
    }
  } else {
    lowPlayersSince = null;
  }

  const r = meta.round;
  if (!r) return;
  const n = nowSrv();

  // Auto-submit at phase timeouts.
  if (inRound()) {
    if (meta.state === "drawing" && !drewSubmitted() && r.endsAt && n > r.endsAt) submitDraw();
    if (meta.state === "linking" && !linkSubmitted() && r.endsAt && n > r.endsAt) submitLinks(true);
  }

  // Host drives phase advancement.
  if (!isHost()) return;
  if (meta.state === "drawing") {
    const allDone = r.order.every((id) => {
      const p = players[id];
      return !p?.connected || (p.drewRound || 0) >= r.num;
    });
    if (allDone || (r.endsAt && n > r.endsAt + 3000)) advanceToLinking();
  } else if (meta.state === "linking") {
    const allDone = r.order.every((id) => {
      const p = players[id];
      return !p?.connected || (p.linkedRound || 0) >= r.num;
    });
    if (allDone || (r.endsAt && n > r.endsAt + 3000)) advanceToResults();
  } else if (meta.state === "results") {
    if (r.endsAt && n > r.endsAt) nextRound();
  }
}, 400);

const drewSubmitted = () => drewLocal || (me()?.drewRound || 0) >= (meta?.round?.num || 1);
const linkSubmitted = () => linkedLocal || (me()?.linkedRound || 0) >= (meta?.round?.num || 1);

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

// ── Art subscription for the current round ───────────────────────────────────
function ensureArtSub() {
  const n = meta?.round?.num;
  if (!n || artRound === n) return;
  if (artUnsub) artUnsub();
  artRound = n;
  artCache = {};
  artUnsub = onValue(artRef(n), (s) => {
    artCache = s.val() || {};
    if (meta?.state === "linking" && !linkSubmitted()) buildLinkGallery();
    if (meta?.state === "results") renderResults();
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function render() {
  if (!meta) return;
  if (meta.state === "lobby") {
    loadedKey = "";
    showScreen("lobby");
    renderLobby();
    return;
  }
  showScreen("game");
  $("overlay").classList.toggle("hidden", meta.state !== "gameEnd");
  if (meta.state === "gameEnd") { renderGameEnd(); return; }

  const r = meta.round;
  if (!r) return;
  ensureArtSub();
  $("round-info").textContent = `Round ${r.num}/${meta.settings.rounds}`;
  $("phase-label").textContent =
    meta.state === "drawing" ? "🎨 Draw!" :
    meta.state === "linking" ? "🕵️ Who drew what?" : "📣 Results";

  const key = `${r.num}:${meta.state}`;
  if (key !== loadedKey) {
    loadedKey = key;
    if (meta.state === "drawing") { drewLocal = false; clearStrokes(); }
    if (meta.state === "linking") {
      linkedLocal = false;
      myAssign = {}; myBest = null; myWorst = null;
      buildLinkGallery();
    }
    if (meta.state === "results") renderResults();
  }

  if (!inRound()) { showView(meta.state === "results" ? "results" : "spectate"); return; }

  if (meta.state === "drawing") {
    if (drewSubmitted()) { renderWaitList("drewRound"); showView("wait"); }
    else { $("draw-prompt-text").textContent = r.prompt; showView("draw"); }
  } else if (meta.state === "linking") {
    if (linkSubmitted()) { renderWaitList("linkedRound"); showView("wait"); }
    else showView("link");
  } else {
    showView("results");
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
  if (isHost()) {
    $("set-rounds").value = String(meta.settings.rounds);
    $("set-draw-seconds").value = String(meta.settings.drawSeconds);
  }
}

function renderWaitList(field) {
  const ul = $("wait-list");
  ul.innerHTML = "";
  for (const id of meta.round.order) {
    const p = players[id];
    if (!p) continue;
    const done = (p[field] || 0) >= meta.round.num;
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : p.connected ? "✏️" : "💤"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || meta.state === "gameEnd" || meta.state === "lobby") {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", secs <= 10 && meta.state !== "results");
}

// ── Linking gallery ───────────────────────────────────────────────────────────
function buildLinkGallery() {
  const r = meta?.round;
  if (!r || meta.state !== "linking") return;
  $("link-prompt").textContent = r.prompt;
  const gallery = $("link-gallery");
  gallery.innerHTML = "";
  const artists = seededShuffle(Object.keys(artCache), r.seed);

  for (const a of artists) {
    const card = document.createElement("div");
    card.className = "art-card";
    const frame = document.createElement("div");
    frame.className = "frame";
    const img = document.createElement("img");
    img.src = artCache[a].img;
    img.alt = "a mystery drawing";
    frame.appendChild(img);
    card.appendChild(frame);

    if (a === pid) {
      card.classList.add("mine");
      const tag = document.createElement("div");
      tag.className = "mine-tag";
      tag.textContent = "Your masterpiece";
      card.appendChild(tag);
      myAssign[a] = pid;
    } else {
      const sel = document.createElement("select");
      sel.dataset.artist = a;
      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "Who drew this?";
      sel.appendChild(ph);
      for (const opt of artists) {
        if (opt === pid) continue; // my name is spoken for by my own locked card
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = players[opt]?.name || "?";
        sel.appendChild(o);
      }
      if (myAssign[a]) sel.value = myAssign[a];
      sel.addEventListener("change", () => {
        if (sel.value) myAssign[a] = sel.value; else delete myAssign[a];
        refreshLinkControls();
      });
      card.appendChild(sel);

      const votes = document.createElement("div");
      votes.className = "vote-row";
      const bb = document.createElement("button");
      bb.className = "btn";
      bb.textContent = "🏆 Best";
      bb.addEventListener("click", () => {
        myBest = myBest === a ? null : a;
        if (myWorst === a) myWorst = null;
        refreshLinkControls();
      });
      const wb = document.createElement("button");
      wb.className = "btn";
      wb.textContent = "💩 Worst";
      wb.addEventListener("click", () => {
        myWorst = myWorst === a ? null : a;
        if (myBest === a) myBest = null;
        refreshLinkControls();
      });
      votes.append(bb, wb);
      card.appendChild(votes);
      card.dataset.artist = a;
    }
    gallery.appendChild(card);
  }
  refreshLinkControls();
}

function refreshLinkControls() {
  const gallery = $("link-gallery");
  const selects = [...gallery.querySelectorAll("select")];
  const used = new Set(Object.values(myAssign));

  // Bijection: a name chosen on one card is unavailable on the others.
  for (const sel of selects) {
    const own = myAssign[sel.dataset.artist] || "";
    for (const o of sel.options) {
      if (!o.value) continue;
      o.disabled = used.has(o.value) && o.value !== own;
    }
    sel.value = own;
  }

  // Auto-fill the last remaining pairing.
  const empty = selects.filter((s) => !myAssign[s.dataset.artist]);
  if (empty.length === 1) {
    const names = [...empty[0].options].map((o) => o.value).filter(Boolean);
    const free = names.filter((v) => !used.has(v));
    if (free.length === 1) {
      myAssign[empty[0].dataset.artist] = free[0];
      refreshLinkControls();
      return;
    }
  }

  // Vote button highlights.
  for (const card of gallery.querySelectorAll(".art-card[data-artist]")) {
    const a = card.dataset.artist;
    const [bb, wb] = card.querySelectorAll(".vote-row .btn");
    bb.classList.toggle("sel-best", myBest === a);
    wb.classList.toggle("sel-worst", myWorst === a);
  }

  // Submit readiness.
  const artists = Object.keys(artCache);
  const others = artists.filter((a) => a !== pid);
  const allAssigned = artists.every((a) => myAssign[a]);
  const votesOk = others.length >= 2 ? (myBest && myWorst) : others.length === 1 ? !!myBest : true;
  const ready = allAssigned && votesOk;
  $("btn-submit-links").disabled = !ready;
  $("link-status").textContent = !allAssigned
    ? `${artists.filter((a) => myAssign[a]).length}/${artists.length} drawings matched`
    : !votesOk ? "Now crown a 🏆 best and a 💩 worst"
    : "All set — lock it in!";
}

function submitLinks(auto = false) {
  if (!meta || meta.state !== "linking" || !inRound() || linkSubmitted()) return;
  if (!auto && $("btn-submit-links").disabled) return;
  linkedLocal = true;
  const n = meta.round.num;
  const assign = {};
  for (const [a, g] of Object.entries(myAssign)) if (g) assign[a] = g;
  const payload = { assign };
  if (myBest) payload.best = myBest;
  if (myWorst) payload.worst = myWorst;
  set(child(linksRef(n), pid), payload);
  update(child(playersRef(), pid), { linkedRound: n });
  render();
}
$("btn-submit-links").addEventListener("click", () => submitLinks(false));

// ── Results ───────────────────────────────────────────────────────────────────
function renderResults() {
  const r = meta?.round;
  if (!r?.results) return;
  const { deltas = {}, perDrawing = {}, bestPids = [], worstPids = [], skipped } = r.results;
  $("results-note").textContent = skipped
    ? "Gallery closed early — not enough drawings this round."
    : `Prompt was: “${r.prompt}”`;

  const gallery = $("results-gallery");
  gallery.innerHTML = "";
  const artists = seededShuffle(Object.keys(artCache), r.seed);
  for (const a of artists) {
    const info = perDrawing[a] || { correct: [], bestVotes: 0, worstVotes: 0 };
    const card = document.createElement("div");
    card.className = "art-card";
    card.innerHTML = `
      <div class="frame"><img src="${artCache[a].img}" alt="drawing"></div>
      <div class="artist-line">${esc(players[a]?.name || "?")}${a === pid ? " (you)" : ""}</div>
      <div class="badge-row">
        ${bestPids.includes(a) ? `<span class="badge best">🏆 Best +10</span>` : ""}
        ${worstPids.includes(a) ? `<span class="badge worst">💩 Worst −5</span>` : ""}
        ${info.bestVotes ? `<span class="badge">👍 ${info.bestVotes}</span>` : ""}
        ${info.worstVotes ? `<span class="badge">👎 ${info.worstVotes}</span>` : ""}
      </div>
      <div class="guessers">${
        info.correct.length
          ? "Spotted by " + info.correct.map((p) => esc(players[p]?.name || "?")).join(", ")
          : "Nobody guessed the artist"
      }</div>`;
    gallery.appendChild(card);
  }

  const scores = $("results-scores");
  scores.innerHTML = "";
  const rows = Object.entries(players)
    .filter(([, p]) => (p.score || 0) !== 0 || p.connected)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  for (const [id, p] of rows) {
    const d = deltas[id] || 0;
    const row = document.createElement("div");
    row.className = "score-row" + (id === pid ? " me" : "");
    row.innerHTML = `<span>${esc(p.name)}</span>
      <span><span class="delta ${d > 0 ? "pos" : d < 0 ? "neg" : ""}">${d > 0 ? "+" + d : d || ""}</span>
      &nbsp; ${p.score || 0} pts</span>`;
    scores.appendChild(row);
  }
  $("btn-next-round").classList.toggle("hidden", !isHost());
}
$("btn-next-round").addEventListener("click", nextRound);

function renderGameEnd() {
  const box = $("overlay-content");
  const rows = Object.entries(players)
    .filter(([, p]) => (p.score || 0) !== 0 || p.connected)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  const topScore = rows[0]?.[1].score || 0;
  const boobie = Object.entries(players)
    .filter(([, p]) => (p.worstWins || 0) > 0)
    .sort((a, b) => (b[1].worstWins || 0) - (a[1].worstWins || 0))[0];

  box.innerHTML = `
    <h2>🖼️ Gallery closed!</h2>
    <div class="final-board">
      ${rows.map(([id, p], i) => `
        <div class="score-row ${id === pid ? "me" : ""}">
          <span>${i === 0 && (p.score || 0) === topScore ? "🏆 " : `${i + 1}. `}${esc(p.name)}</span>
          <span>${p.score || 0} pts</span>
        </div>`).join("")}
    </div>
    ${boobie ? `<p class="hint">💩 People's choice for worst artist: <strong>${esc(boobie[1].name)}</strong> (${boobie[1].worstWins}×) — frame their work anyway.</p>` : ""}
    ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
               : `<p class="hint">Waiting for the host…</p>`}
    <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
  box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
  box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
}

// ── Lobby interactions ────────────────────────────────────────────────────────
$("btn-start").addEventListener("click", startGame);
$("set-rounds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { rounds: Number(e.target.value) }));
$("set-draw-seconds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { drawSeconds: Number(e.target.value) }));

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

// ── Drawing submission ────────────────────────────────────────────────────────
function submitDraw() {
  if (!meta || meta.state !== "drawing" || !inRound() || drewSubmitted()) return;
  drewLocal = true;
  const n = meta.round.num;
  const out = document.createElement("canvas");
  out.width = 700; out.height = 490;
  const octx = out.getContext("2d");
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(board, 0, 0, out.width, out.height);
  set(child(artRef(n), pid), { img: out.toDataURL("image/png") });
  update(child(playersRef(), pid), { drewRound: n });
  render();
}
$("btn-submit-draw").addEventListener("click", submitDraw);

// ── Local canvas (same as telephone's — each player draws privately) ──────────
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
  strokes.push({
    c: erasing ? "#ffffff" : curColor,
    w: erasing ? curSize * 3 : curSize,
    p: [x, y, x + 1, y + 1],
  });
  redrawAll();
});

board.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  e.preventDefault();
  const stroke = strokes[strokes.length - 1];
  const [x, y] = getPos(e);
  const n = stroke.p.length;
  const dx = x - stroke.p[n - 2], dy = y - stroke.p[n - 1];
  if (dx * dx + dy * dy < 9) return;
  ctx.strokeStyle = stroke.c;
  ctx.lineWidth = stroke.w;
  ctx.beginPath();
  ctx.moveTo(stroke.p[n - 2], stroke.p[n - 1]);
  ctx.lineTo(x, y);
  ctx.stroke();
  stroke.p.push(x, y);
});

const stopStroke = () => { drawing = false; };
board.addEventListener("pointerup", stopStroke);
board.addEventListener("pointercancel", stopStroke);

function clearStrokes() {
  strokes = [];
  redrawAll();
}

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
