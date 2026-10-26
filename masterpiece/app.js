// Masterpiece — everyone draws the same prompt, then votes on the anonymous
// gallery. Individual scores: +10 per vote received.
//
// All game state lives under rooms/{CODE} in RTDB. The host's client advances
// phases via whole-meta transactions (exactly-once guards on state + round num);
// scoring is applied by whichever client commits the voting→results transition.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
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
let artCache = {};     // art for the current round {pid: {name, img}}
let votesCache = {};   // votes for the current round {voterPid: targetPid}
let serverOffset = 0;
let loadedRound = -1;
let submittedLocal = false;
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;
let artUnsub = null;
let votesUnsub = null;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const artRef = (n) => ref(db, `rooms/${roomCode}/art/${n}`);
const votesRef = (n) => ref(db, `rooms/${roomCode}/votes/${n}`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const inRoster = () => (meta?.round?.roster || []).includes(pid);
const iSubmitted = () =>
  submittedLocal || (me()?.submittedRound || 0) >= (meta?.round?.num || 1);
const iVoted = () => (me()?.votedRound || 0) >= (meta?.round?.num || 1);

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const keyify = (w) => w.replace(/[.#$/\[\]]/g, "_");

// ── Screens / views ───────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["draw", "wait", "gallery", "spectate"]) {
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
      game: "masterpiece",
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
    if (snap.val().game !== "masterpiece") {
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
    submittedRound: existing?.submittedRound || 0,
    votedRound: existing?.votedRound || 0,
  });
  trackPresence(db, meRef);

  onValue(metaRef(), (s) => {
    meta = s.val();
    if (!meta) return;
    render();
  });
  onValue(playersRef(), (s) => {
    players = s.val() || {};
    render();
  });
}

function leaveRoom() {
  if (roomCode) set(ref(db, `rooms/${roomCode}/players/${pid}/connected`), false);
  location.hash = "";
  location.reload();
}
$("btn-leave-lobby").addEventListener("click", leaveRoom);

// ── Per-round subscriptions ───────────────────────────────────────────────────
function subscribeRound(n) {
  artUnsub?.();
  votesUnsub?.();
  artCache = {};
  votesCache = {};
  artUnsub = onValue(artRef(n), (s) => { artCache = s.val() || {}; render(); });
  votesUnsub = onValue(votesRef(n), (s) => { votesCache = s.val() || {}; render(); });
}

// ── State-machine transactions ────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function buildRound(m, num) {
  const used = m.usedPrompts || {};
  const fresh = PROMPTS.filter((p) => !used[keyify(p)]);
  const prompt = rand(fresh.length ? fresh : PROMPTS);
  const roster = Object.entries(players)
    .filter(([, p]) => p.connected)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
    .map(([id]) => id);
  return {
    meta: {
      ...m,
      state: "drawing",
      usedPrompts: { ...used, [keyify(prompt)]: true },
      round: {
        num, prompt, roster,
        createdAt: nowSrv(),
        endsAt: nowSrv() + m.settings.drawSeconds * 1000,
      },
    },
    roster,
  };
}

async function startGame() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < 3) { alert("Masterpiece needs at least 3 artists."); return; }

  // Reset BEFORE flipping state so stale counters can't skip round 1.
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/score`] = 0;
    resets[`${id}/submittedRound`] = 0;
    resets[`${id}/votedRound`] = 0;
  }
  await update(playersRef(), resets);
  await remove(ref(db, `rooms/${roomCode}/art`));
  await remove(ref(db, `rooms/${roomCode}/votes`));

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    return buildRound({ ...m, usedPrompts: null }, 1).meta;
  });
}

function toVoting() {
  const n = meta.round.num;
  const artists = Object.keys(artCache);
  if (artists.length < 2) {
    // Not enough art to judge — skip straight to a consolation results card.
    txMeta((m) => {
      if (m.state !== "drawing" || m.round?.num !== n) return;
      return {
        ...m, state: "results",
        round: {
          ...m.round, order: artists,
          results: { counts: {}, winners: [], skipVoting: true },
          endsAt: nowSrv() + 8000,
        },
      };
    });
    return;
  }
  txMeta((m) => {
    if (m.state !== "drawing" || m.round?.num !== n) return;
    return {
      ...m, state: "voting",
      round: { ...m.round, order: shuffle(artists), endsAt: nowSrv() + 30000 },
    };
  });
}

function toResults() {
  const n = meta.round.num;
  const counts = {};
  for (const target of Object.values(votesCache)) {
    counts[target] = (counts[target] || 0) + 10;
  }
  const max = Math.max(0, ...Object.values(counts));
  const winners = max > 0
    ? Object.keys(counts).filter((id) => counts[id] === max)
    : [];
  txMeta((m) => {
    if (m.state !== "voting" || m.round?.num !== n) return;
    return {
      ...m, state: "results",
      round: { ...m.round, results: { counts, winners }, endsAt: nowSrv() + 10000 },
    };
  }).then((res) => {
    if (!res.committed || res.snapshot.val()?.state !== "results") return;
    // Exactly-once scoring by the committing client.
    for (const [artist, pts] of Object.entries(counts)) {
      runTransaction(ref(db, `rooms/${roomCode}/players/${artist}/score`), (v) => (v || 0) + pts);
    }
  });
}

function nextRound() {
  const n = meta.round.num;
  txMeta((m) => {
    if (m.state !== "results" || m.round?.num !== n) return;
    if (n >= m.settings.rounds) return { ...m, state: "gameEnd" };
    return buildRound(m, n + 1).meta;
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

// ── Submitting & voting ───────────────────────────────────────────────────────
function submitDrawing() {
  if (!meta || meta.state !== "drawing" || !inRoster() || iSubmitted()) return;
  submittedLocal = true;
  const n = meta.round.num;
  // Downscale before upload — line art survives it fine and keeps the DB light.
  const out = document.createElement("canvas");
  out.width = 700; out.height = 490;
  const octx = out.getContext("2d");
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(board, 0, 0, out.width, out.height);
  set(child(artRef(n), pid), { name: me()?.name || "?", img: out.toDataURL("image/png") });
  update(child(playersRef(), pid), { submittedRound: n });
  render();
}
$("btn-submit-draw").addEventListener("click", submitDrawing);

function setVote(target) {
  if (!meta || meta.state !== "voting" || !inRoster() || target === pid) return;
  if (!artCache[target]) return;
  const n = meta.round.num;
  set(child(votesRef(n), pid), target);
  update(child(playersRef(), pid), { votedRound: n });
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = ["drawing", "voting", "results"].includes(meta.state);
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 3) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => (["drawing", "voting", "results"].includes(m.state)
        ? { ...m, state: "lobby", round: null, usedPrompts: null }
        : undefined));
    }
  } else {
    lowPlayersSince = null;
  }

  const r = meta.round;
  if (!r?.endsAt) return;
  const n = nowSrv();

  // Auto-submit whatever is on the canvas when time runs out.
  if (meta.state === "drawing" && inRoster() && !iSubmitted() && n > r.endsAt) {
    submitDrawing();
  }

  if (!isHost()) return;
  if (meta.state === "drawing") {
    const allDone = (r.roster || []).every((id) => {
      const p = players[id];
      return !p?.connected || (p.submittedRound || 0) >= r.num;
    });
    if (allDone || n > r.endsAt + 3000) toVoting();
  } else if (meta.state === "voting") {
    const allVoted = (r.roster || []).every((id) => {
      const p = players[id];
      return !p?.connected || (p.votedRound || 0) >= r.num;
    });
    if (allVoted || n > r.endsAt + 3000) toResults();
  } else if (meta.state === "results") {
    if (n > r.endsAt) nextRound();
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

// ── Rendering ─────────────────────────────────────────────────────────────────
function render() {
  if (!meta) return;
  if (meta.state === "lobby") {
    loadedRound = -1;
    showScreen("lobby");
    renderLobby();
    return;
  }
  showScreen("game");

  const r = meta.round;
  if (r && r.num !== loadedRound) {
    loadedRound = r.num;
    submittedLocal = false;
    clearStrokes();
    subscribeRound(r.num);
  }
  renderGame();
}

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
    $("set-rounds").value = String(meta.settings.rounds);
    $("set-draw-seconds").value = String(meta.settings.drawSeconds);
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderGame() {
  const r = meta.round;
  $("round-info").textContent = r ? `Round ${r.num}/${meta.settings.rounds}` : "";
  $("task-label").textContent =
    meta.state === "drawing" ? "🎨 Draw the prompt!" :
    meta.state === "voting" ? "🗳️ Vote for your favourite" :
    meta.state === "results" ? "🏅 The results are in" : "";

  const overlayOn = meta.state === "gameEnd";
  $("overlay").classList.toggle("hidden", !overlayOn);
  if (overlayOn) { renderGameEnd(); return; }

  if (meta.state === "drawing") {
    if (!inRoster()) { showView("spectate"); return; }
    if (iSubmitted()) { renderWait(); showView("wait"); return; }
    $("draw-prompt-text").textContent = r.prompt;
    showView("draw");
  } else {
    renderGallery();
    showView("gallery");
  }
  renderTimer();
}

function renderWait() {
  const ul = $("wait-list");
  ul.innerHTML = "";
  for (const id of meta.round.roster || []) {
    const p = players[id];
    if (!p) continue;
    const done = (p.submittedRound || 0) >= meta.round.num;
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : p.connected ? "🎨" : "💤"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
}

function renderGallery() {
  const r = meta.round;
  const voting = meta.state === "voting";
  const results = meta.state === "results";
  const res = r.results || { counts: {}, winners: [] };

  $("gallery-title").textContent = results
    ? (res.skipVoting ? "🖼 Gallery closed early" : `🖼 "${r.prompt}" — results`)
    : `🖼 "${r.prompt}" — the gallery`;
  $("gallery-hint").textContent = results
    ? (res.skipVoting
        ? "Fewer than two artists submitted this round — no vote held."
        : "10 points per vote. Argue accordingly.")
    : (inRoster()
        ? "Vote for your favourite — not your own, obviously. You can change your mind until time's up."
        : "You're spectating this round — enjoy the art.");

  const grid = $("gallery-grid");
  grid.innerHTML = "";
  for (const artist of r.order || []) {
    const art = artCache[artist];
    if (!art) continue;
    const frame = document.createElement("div");
    frame.className = "frame";
    const img = document.createElement("img");
    img.src = art.img;
    img.alt = "a masterpiece";
    frame.appendChild(img);

    const label = document.createElement("div");
    label.className = "frame-label";
    if (voting) {
      if (artist === pid) {
        frame.classList.add("mine");
        label.textContent = "yours";
      } else if (inRoster()) {
        frame.classList.add("votable");
        if (votesCache[pid] === artist) frame.classList.add("selected");
        label.textContent = votesCache[pid] === artist ? "your pick ✔" : "";
        frame.addEventListener("click", () => setVote(artist));
      }
    } else if (results) {
      const pts = res.counts?.[artist] || 0;
      label.innerHTML = `<span class="artist"></span> <span class="votes-badge">+${pts}</span>`;
      label.querySelector(".artist").textContent = art.name;
      if ((res.winners || []).includes(artist)) {
        frame.classList.add("winner");
        const crown = document.createElement("div");
        crown.className = "crown";
        crown.textContent = "👑";
        frame.appendChild(crown);
      }
    }
    frame.appendChild(label);
    grid.appendChild(frame);
  }

  if (voting) {
    const voted = Object.keys(votesCache).length;
    const voters = (r.roster || []).filter((id) => players[id]?.connected).length;
    $("gallery-hint").textContent += `  (${voted}/${voters} votes in)`;
  }
}

function renderGameEnd() {
  const box = $("overlay-content");
  const ranked = sortedPlayers()
    .map(([id, p]) => ({ id, name: p.name, score: p.score || 0 }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0]?.score || 0;
  box.innerHTML = `
    <h2>🏆 Gallery closed!</h2>
    <ol class="leaderboard"></ol>
    ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
               : `<p class="hint">Waiting for the host…</p>`}
    <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
  const ol = box.querySelector(".leaderboard");
  ranked.forEach((p, i) => {
    const li = document.createElement("li");
    if (p.score === top && top > 0) li.classList.add("first");
    li.innerHTML = `<span>${i + 1}. ${p.score === top && top > 0 ? "🏆 " : ""}<span class="nm"></span></span><span>${p.score}</span>`;
    li.querySelector(".nm").textContent = p.name;
    ol.appendChild(li);
  });
  box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
  box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || !["drawing", "voting", "results"].includes(meta.state)) {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", meta.state !== "results" && secs <= 10);
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

// ── Local canvas (same as telephone's — each artist draws privately) ─────────
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
    p: [x, y, x + 1, y + 1], // duplicate so a tap renders a dot
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
