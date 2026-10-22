// Blind Canvas — draw the prompt without seeing your ink, then face the gallery.
//
// State machine (whole-meta transactions, host-client driven like telephone/):
//   lobby → drawing → reveal (one drawing at a time) → voting → results → next
//   round or gameEnd. Strokes are recorded but never rendered while drawing;
//   the PNG is produced at submit time from the recorded strokes.

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
let art = {};        // art/{round} for the current round: pid -> {img, name}
let votes = {};      // votes/{round} for the current round: pid -> {rec, fun}
let serverOffset = 0;
let loadedRound = -1;
let submittedLocal = false;
let lowPlayersSince = null;
let artUnsub = null;
let votesUnsub = null;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const keyify = (w) => w.replace(/[.#$/\[\]]/g, "_");
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// A participant joined before the current round started; later joiners spectate.
const isParticipant = () =>
  !!me() && !!meta?.round && (me().joinedAt || 0) <= (meta.round.startedAt || 0);
const iSubmitted = () =>
  submittedLocal || (me()?.submittedRound || 0) >= (meta?.round?.num || 1);
const iVoted = () => (me()?.votedRound || 0) >= (meta?.round?.num || 1);

// ── Screens & views ───────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["draw", "wait", "reveal", "vote", "results", "end", "spectate"]) {
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
      game: "blindcanvas",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 3, drawSeconds: 45 },
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
    if (snap.val().game !== "blindcanvas") {
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
    recVotes: existing?.recVotes || 0,
    funVotes: existing?.funVotes || 0,
    submittedRound: existing?.submittedRound || 0,
    votedRound: existing?.votedRound || 0,
  });
  onDisconnect(child(meRef, "connected")).set(false);

  onValue(metaRef(), (s) => {
    meta = s.val();
    if (!meta) return;
    syncRoundSubscriptions();
    render();
  });
  onValue(playersRef(), (s) => {
    players = s.val() || {};
    render();
  });
}

// Subscribe to the current round's art and votes only (PNGs are heavy).
function syncRoundSubscriptions() {
  const n = meta?.round?.num;
  if (!n || n === loadedRound) return;
  loadedRound = n;
  submittedLocal = false;
  resetCanvas();
  artUnsub?.(); votesUnsub?.();
  art = {}; votes = {};
  artUnsub = onValue(ref(db, `rooms/${roomCode}/art/${n}`), (s) => { art = s.val() || {}; render(); });
  votesUnsub = onValue(ref(db, `rooms/${roomCode}/votes/${n}`), (s) => { votes = s.val() || {}; render(); });
}

function leaveRoom() {
  if (roomCode) set(ref(db, `rooms/${roomCode}/players/${pid}/connected`), false);
  location.hash = "";
  location.reload();
}
$("btn-leave-lobby").addEventListener("click", leaveRoom);
$("btn-leave-end").addEventListener("click", leaveRoom);

// ── State-machine transactions ────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

async function startGame() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < 3) { alert("Need at least 3 players."); return; }

  // Pre-reset before flipping state so stale markers can't skip round 1.
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/score`] = 0;
    resets[`${id}/recVotes`] = 0;
    resets[`${id}/funVotes`] = 0;
    resets[`${id}/submittedRound`] = 0;
    resets[`${id}/votedRound`] = 0;
  }
  await update(playersRef(), resets);
  await remove(ref(db, `rooms/${roomCode}/art`));
  await remove(ref(db, `rooms/${roomCode}/votes`));

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const prompt = rand(PROMPTS);
    return {
      ...m,
      state: "drawing",
      usedPrompts: { [keyify(prompt)]: true },
      round: { num: 1, prompt, startedAt: nowSrv(), endsAt: nowSrv() + m.settings.drawSeconds * 1000 },
    };
  });
}

function toReveal() {
  const n = meta.round.num;
  const submitted = Object.keys(art);
  txMeta((m) => {
    if (m.state !== "drawing" || m.round?.num !== n) return;
    if (submitted.length < 2) {
      return {
        ...m, state: "results",
        round: { ...m.round, endsAt: nowSrv() + 8000, tally: null, skipNote: "Not enough drawings — gallery closed early." },
      };
    }
    const order = [...submitted].sort(() => Math.random() - 0.5);
    return { ...m, state: "reveal", round: { ...m.round, order, revealIdx: 0, endsAt: nowSrv() + 6000 } };
  });
}

function advanceReveal() {
  const n = meta.round.num;
  const idx = meta.round.revealIdx;
  txMeta((m) => {
    if (m.state !== "reveal" || m.round?.num !== n || m.round.revealIdx !== idx) return;
    if (idx + 1 < m.round.order.length) {
      return { ...m, round: { ...m.round, revealIdx: idx + 1, endsAt: nowSrv() + 6000 } };
    }
    return { ...m, state: "voting", round: { ...m.round, endsAt: nowSrv() + 30000 } };
  });
}

function toResults() {
  const n = meta.round.num;
  // Tally from the committing client's local snapshot (house caveat: a vote
  // that hasn't replicated here yet is missed — low stakes, same as siblings).
  const tally = {};
  for (const v of Object.values(votes)) {
    if (v.rec) { (tally[v.rec] ||= { rec: 0, fun: 0 }).rec++; }
    if (v.fun) { (tally[v.fun] ||= { rec: 0, fun: 0 }).fun++; }
  }
  txMeta((m) => {
    if (m.state !== "voting" || m.round?.num !== n) return;
    return { ...m, state: "results", round: { ...m.round, endsAt: nowSrv() + 8000, tally } };
  }).then((res) => {
    if (!res.committed || res.snapshot.val()?.state !== "results") return;
    // Exactly-once scoring by the committing client.
    for (const [id, t] of Object.entries(tally)) {
      runTransaction(ref(db, `rooms/${roomCode}/players/${id}/score`), (v) => (v || 0) + t.rec * 10 + t.fun * 5);
      runTransaction(ref(db, `rooms/${roomCode}/players/${id}/recVotes`), (v) => (v || 0) + t.rec);
      runTransaction(ref(db, `rooms/${roomCode}/players/${id}/funVotes`), (v) => (v || 0) + t.fun);
    }
  });
}

function nextRoundOrEnd() {
  const n = meta.round.num;
  txMeta((m) => {
    if (m.state !== "results" || m.round?.num !== n) return;
    if (n >= m.settings.rounds) return { ...m, state: "gameEnd" };
    const used = m.usedPrompts || {};
    const fresh = PROMPTS.filter((p) => !used[keyify(p)]);
    const prompt = rand(fresh.length ? fresh : PROMPTS);
    return {
      ...m,
      state: "drawing",
      usedPrompts: { ...used, [keyify(prompt)]: true },
      round: { num: n + 1, prompt, startedAt: nowSrv(), endsAt: nowSrv() + m.settings.drawSeconds * 1000 },
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
      remove(ref(db, `rooms/${roomCode}/votes`));
    }
  });
}
$("btn-again").addEventListener("click", backToLobby);
$("btn-reveal-next").addEventListener("click", () => { if (isHost()) advanceReveal(); });

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = ["drawing", "reveal", "voting", "results"].includes(meta.state);
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 3) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) {
      txMeta((m) => (["drawing", "reveal", "voting", "results"].includes(m.state)
        ? { ...m, state: "lobby", round: null, usedPrompts: null } : undefined));
    }
  } else {
    lowPlayersSince = null;
  }

  const r = meta.round;
  const n = nowSrv();

  // Auto-submit my drawing at the deadline.
  if (meta.state === "drawing" && isParticipant() && !iSubmitted() && r?.endsAt && n > r.endsAt) {
    submitDrawing();
  }

  if (!isHost() || !r?.endsAt) return;
  if (meta.state === "drawing") {
    const allIn = Object.entries(players)
      .filter(([, p]) => p.connected && (p.joinedAt || 0) <= (r.startedAt || 0))
      .every(([, p]) => (p.submittedRound || 0) >= r.num);
    if (allIn || n > r.endsAt + 3000) toReveal();
  } else if (meta.state === "reveal") {
    if (n > r.endsAt) advanceReveal();
  } else if (meta.state === "voting") {
    const allVoted = Object.entries(players)
      .filter(([, p]) => p.connected && (p.joinedAt || 0) <= (r.startedAt || 0))
      .every(([, p]) => (p.votedRound || 0) >= r.num);
    if (allVoted || n > r.endsAt + 3000) toResults();
  } else if (meta.state === "results") {
    if (n > r.endsAt) nextRoundOrEnd();
  }
}, 400);

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
  if (meta.state === "lobby") {
    showScreen("lobby");
    renderLobby();
    return;
  }
  showScreen("game");
  const r = meta.round;
  $("round-info").textContent = r ? `Round ${r.num}/${meta.settings.rounds}` : "";

  if (meta.state === "gameEnd") {
    $("phase-label").textContent = "🏁 Final results";
    renderEnd();
    showView("end");
    return;
  }
  if (!isParticipant()) {
    $("phase-label").textContent = "🍿 Spectating";
    if (meta.state === "reveal") { renderReveal(); showView("reveal"); return; }
    if (meta.state === "results") { renderResults(); showView("results"); return; }
    showView("spectate");
    return;
  }

  if (meta.state === "drawing") {
    $("phase-label").textContent = "🙈 Draw blind!";
    if (iSubmitted()) { renderWait(); showView("wait"); }
    else {
      $("prompt-text").textContent = r.prompt;
      showView("draw");
    }
  } else if (meta.state === "reveal") {
    $("phase-label").textContent = "🖼 The big reveal";
    renderReveal();
    showView("reveal");
  } else if (meta.state === "voting") {
    $("phase-label").textContent = "🗳️ Vote!";
    renderVoting();
    showView("vote");
  } else if (meta.state === "results") {
    $("phase-label").textContent = "🏅 Round results";
    renderResults();
    showView("results");
  }
  renderTimer();
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderLobby() {
  $("lobby-code").textContent = roomCode;
  const ul = $("lobby-player-list");
  ul.innerHTML = "";
  let count = 0;
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    count++;
    const li = document.createElement("li");
    li.textContent = `${p.name}${meta.hostId === id ? " 👑" : ""}${id === pid ? " (you)" : ""}`;
    if (id === pid) li.classList.add("me");
    ul.appendChild(li);
  }
  $("lobby-count").textContent = `(${count})`;
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) {
    $("set-rounds").value = String(meta.settings.rounds);
    $("set-seconds").value = String(meta.settings.drawSeconds);
    $("start-hint").classList.toggle("hidden", count >= 3);
  }
}

function renderWait() {
  const ul = $("wait-list");
  ul.innerHTML = "";
  const r = meta.round;
  for (const [, p] of sortedPlayers()) {
    if (!p.connected || (p.joinedAt || 0) > (r.startedAt || 0)) continue;
    const done = (p.submittedRound || 0) >= r.num;
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : "✏️"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  const timed = ["drawing", "voting"].includes(meta?.state);
  if (!r?.endsAt || !timed) { el.textContent = "--"; el.classList.remove("low"); return; }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", secs <= 10);
}

function renderReveal() {
  const r = meta.round;
  const artist = r.order?.[r.revealIdx];
  const entry = art[artist];
  $("reveal-counter").textContent = `🖼 Drawing ${r.revealIdx + 1} of ${r.order?.length || "?"}`;
  $("reveal-img").src = entry?.img || "";
  // Comedy timing: picture first, artist credit after a 3s beat.
  const showArtist = nowSrv() > (r.endsAt || 0) - 3000;
  $("reveal-artist").innerHTML = showArtist
    ? `by <strong>${esc(entry?.name || "?")}</strong>`
    : "by …?";
  $("btn-reveal-next").classList.toggle("hidden", !isHost());
}
setInterval(() => { if (meta?.state === "reveal") renderReveal(); }, 300);

function renderVoting() {
  const wrap = $("vote-gallery");
  wrap.innerHTML = "";
  const myVotes = votes[pid] || {};
  for (const artist of meta.round.order || []) {
    const entry = art[artist];
    if (!entry) continue;
    const card = document.createElement("div");
    card.className = "gallery-card" + (artist === pid ? " mine" : "");
    card.innerHTML = `
      <div class="frame"><img src="${entry.img}" alt="drawing"></div>
      <span class="who">by ???</span>
      <div class="vote-btns">
        <button class="btn vote-rec ${myVotes.rec === artist ? "picked" : ""}" ${artist === pid ? "disabled" : ""}>🏆</button>
        <button class="btn vote-fun ${myVotes.fun === artist ? "picked" : ""}" ${artist === pid ? "disabled" : ""}>😂</button>
      </div>`;
    card.querySelector(".vote-rec").addEventListener("click", () => castVote("rec", artist));
    card.querySelector(".vote-fun").addEventListener("click", () => castVote("fun", artist));
    wrap.appendChild(card);
  }
}

function castVote(kind, artist) {
  if (artist === pid || meta?.state !== "voting") return;
  const n = meta.round.num;
  update(ref(db, `rooms/${roomCode}/votes/${n}/${pid}`), { [kind]: artist }).then(() => {
    const v = votes[pid] || {};
    const merged = { ...v, [kind]: artist };
    if (merged.rec && merged.fun) update(child(playersRef(), pid), { votedRound: n });
  });
}

function renderResults() {
  const r = meta.round;
  const wrap = $("results-gallery");
  wrap.innerHTML = "";
  if (r.skipNote) {
    $("results-title").textContent = "😶 " + r.skipNote;
  } else {
    $("results-title").textContent = "🏅 Round results";
    const tally = r.tally || {};
    const maxRec = Math.max(0, ...Object.values(tally).map((t) => t.rec || 0));
    for (const artist of r.order || []) {
      const entry = art[artist];
      if (!entry) continue;
      const t = tally[artist] || { rec: 0, fun: 0 };
      const card = document.createElement("div");
      card.className = "gallery-card";
      card.innerHTML = `
        <div class="frame"><img src="${entry.img}" alt="drawing"></div>
        <span class="who">${esc(entry.name)}</span>
        <span class="vote-count ${t.rec && t.rec === maxRec ? "win" : ""}">🏆 ${t.rec} · 😂 ${t.fun}</span>`;
      wrap.appendChild(card);
    }
  }
  const board = $("results-board");
  board.innerHTML = "";
  const ranked = sortedPlayers()
    .filter(([, p]) => p.connected || (p.score || 0) > 0)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  for (const [id, p] of ranked) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span>${esc(p.name)}${id === pid ? " (you)" : ""}</span><span>${p.score || 0}</span>`;
    board.appendChild(row);
  }
}

function renderEnd() {
  const ranked = Object.entries(players)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  const ol = $("end-board");
  ol.innerHTML = "";
  ranked.forEach(([id, p], i) => {
    const li = document.createElement("li");
    const medal = ["🥇", "🥈", "🥉"][i] || "";
    li.innerHTML = `<span class="pname">${esc(p.name)}${id === pid ? " (you)" : ""} ${medal}</span><span>${p.score || 0}</span>`;
    ol.appendChild(li);
  });
  const topRec = [...ranked].sort((a, b) => (b[1].recVotes || 0) - (a[1].recVotes || 0))[0];
  const topFun = [...ranked].sort((a, b) => (b[1].funVotes || 0) - (a[1].funVotes || 0))[0];
  $("end-crowns").innerHTML =
    `🏆 Clearest visionary: <strong>${esc(topRec?.[1].name || "—")}</strong><br>` +
    `😂 Chaos champion: <strong>${esc(topFun?.[1].name || "—")}</strong>`;
  $("btn-again").classList.toggle("hidden", !isHost());
  $("end-waiting").classList.toggle("hidden", isHost());
}

// ── Lobby interactions ────────────────────────────────────────────────────────
$("btn-start").addEventListener("click", startGame);
$("set-rounds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { rounds: Number(e.target.value) }));
$("set-seconds").addEventListener("change", (e) =>
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

// ── The blind canvas ──────────────────────────────────────────────────────────
// Strokes are RECORDED but never rendered to the visible canvas — the only
// render path is renderStrokesToPng() at submit time.
const board = $("board");
const CW = board.width, CH = board.height;

const COLORS = ["#000000", "#868e96", "#e03131", "#f08c00", "#ffd43b",
                "#2f9e44", "#1971c2", "#9c36b5", "#e64980", "#795548"];
const SIZES = [4, 9, 18];
let curColor = COLORS[0];
let curSize = SIZES[1];
let strokes = [];      // [{c, w, p: [x,y,...]}]
let drawing = false;

const colorRow = $("color-row");
for (const c of COLORS) {
  const b = document.createElement("button");
  b.className = "color-btn";
  b.style.background = c;
  b.title = c;
  b.addEventListener("click", () => { curColor = c; refreshTools(); });
  colorRow.appendChild(b);
}
const sizeRow = $("size-row");
for (const s of SIZES) {
  const b = document.createElement("button");
  b.className = "size-btn";
  b.innerHTML = `<i style="width:${Math.min(s, 20)}px;height:${Math.min(s, 20)}px"></i>`;
  b.addEventListener("click", () => { curSize = s; refreshTools(); });
  sizeRow.appendChild(b);
}
function refreshTools() {
  [...colorRow.children].forEach((b, i) => b.classList.toggle("active", COLORS[i] === curColor));
  [...sizeRow.children].forEach((b, i) => b.classList.toggle("active", SIZES[i] === curSize));
}
refreshTools();

const canDraw = () =>
  meta?.state === "drawing" && isParticipant() && !iSubmitted();

function getPos(e) {
  const rect = board.getBoundingClientRect();
  return [
    Math.round((e.clientX - rect.left) / rect.width * CW),
    Math.round((e.clientY - rect.top) / rect.height * CH),
  ];
}

function moveCursorDot(e) {
  const wrap = $("canvas-wrap");
  const rect = wrap.getBoundingClientRect();
  const dot = $("cursor-dot");
  dot.style.left = `${e.clientX - rect.left}px`;
  dot.style.top = `${e.clientY - rect.top}px`;
}

board.addEventListener("pointerenter", () => $("cursor-dot").classList.remove("hidden"));
board.addEventListener("pointerleave", () => { if (!drawing) $("cursor-dot").classList.add("hidden"); });

board.addEventListener("pointerdown", (e) => {
  if (!canDraw()) return;
  e.preventDefault();
  board.setPointerCapture(e.pointerId);
  drawing = true;
  const [x, y] = getPos(e);
  strokes.push({ c: curColor, w: curSize, p: [x, y, x + 1, y + 1] });
  $("ink-badge").classList.remove("hidden");
  $("stroke-count").textContent = `✏️ ${strokes.length} strokes`;
  moveCursorDot(e);
});

board.addEventListener("pointermove", (e) => {
  moveCursorDot(e);
  if (!drawing) return;
  e.preventDefault();
  const stroke = strokes[strokes.length - 1];
  const [x, y] = getPos(e);
  const n = stroke.p.length;
  const dx = x - stroke.p[n - 2], dy = y - stroke.p[n - 1];
  if (dx * dx + dy * dy < 9) return;
  stroke.p.push(x, y);     // recorded — deliberately NOT drawn
});

function stopStroke() {
  drawing = false;
  $("ink-badge").classList.add("hidden");
}
board.addEventListener("pointerup", stopStroke);
board.addEventListener("pointercancel", stopStroke);

function resetCanvas() {
  strokes = [];
  drawing = false;
  const sc = $("stroke-count");
  if (sc) sc.textContent = "✏️ 0 strokes";
  $("ink-badge")?.classList.add("hidden");
}

function renderStrokesToPng() {
  const full = document.createElement("canvas");
  full.width = CW; full.height = CH;
  const ctx = full.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CW, CH);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    if (s.p.length < 4) continue;
    ctx.strokeStyle = s.c;
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(s.p[0], s.p[1]);
    for (let i = 2; i < s.p.length; i += 2) ctx.lineTo(s.p[i], s.p[i + 1]);
    ctx.stroke();
  }
  // Downscale for upload, telephone-style.
  const out = document.createElement("canvas");
  out.width = 700; out.height = 490;
  const octx = out.getContext("2d");
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(full, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

function submitDrawing() {
  if (!meta || meta.state !== "drawing" || !isParticipant() || iSubmitted()) return;
  submittedLocal = true;
  stopStroke();
  const n = meta.round.num;
  set(ref(db, `rooms/${roomCode}/art/${n}/${pid}`), {
    img: renderStrokesToPng(),
    name: me()?.name || "?",
  });
  update(child(playersRef(), pid), { submittedRound: n });
  render();
}
$("btn-submit-draw").addEventListener("click", submitDrawing);
