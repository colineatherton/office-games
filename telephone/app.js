// Drawing Telephone — static client, synced through Firebase Realtime Database.
//
// Game model: with N players there are N chains, one started by each player.
// At step s, chain c is worked on by order[(c + s) % N] — so each step, every
// player works on a different chain, and no player sees the same chain twice
// (chain length is capped at N). Step 0 is "write a prompt", odd steps are
// "draw what you received", even steps are "describe the drawing you received".
// The host's client advances steps once everyone has submitted (or time's up).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, onDisconnect, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { FALLBACK_PROMPTS, FALLBACK_DESCRIPTIONS } from "./prompts.js";

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
let chains = {};
let serverOffset = 0;
let prevContent = null;   // what I'm drawing/describing this step
let loadedStep = -1;
let submittedLocal = false;
let advancing = false;
let chainsSubscribed = false;
let lowPlayersSince = null;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const chainsRef = () => ref(db, `rooms/${roomCode}/chains`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

const myOrderIdx = () => (meta?.order || []).indexOf(pid);
const participating = () => myOrderIdx() >= 0;
const stepType = (s) => (s === 0 ? "write" : s % 2 === 1 ? "draw" : "describe");
const myChain = (s) => {
  const N = meta.order.length;
  return ((myOrderIdx() - s) % N + N) % N;
};
const iSubmitted = () =>
  submittedLocal || (me()?.submittedStep ?? -1) >= (meta?.step ?? 0);

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ── Screens ───────────────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game", "reveal"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["write", "draw", "describe", "wait", "spectate"]) {
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
      game: "telephone",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { drawSeconds: 90, writeSeconds: 45, chainLen: "auto" },
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
    if (snap.val().game !== "telephone") {
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
    submittedStep: existing?.submittedStep ?? -1,
  });
  onDisconnect(child(meRef, "connected")).set(false);

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

// ── State-machine transactions ────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

async function startGame() {
  const order = Object.entries(players)
    .filter(([, p]) => p.connected)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
    .map(([id]) => id);
  if (order.length < 2) { alert("Need at least 2 players (4+ is where it gets good)."); return; }

  // Reset submissions BEFORE flipping state, so stale submittedStep values from
  // a previous game can't instantly auto-advance step 0.
  const resets = {};
  for (const id of Object.keys(players)) resets[`${id}/submittedStep`] = -1;
  await update(playersRef(), resets);
  await remove(chainsRef());

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const N = order.length;
    const len = m.settings.chainLen === "auto"
      ? Math.min(N, 10)
      : Math.min(Number(m.settings.chainLen), N);
    return {
      ...m,
      state: "playing",
      order,
      totalSteps: Math.max(2, len),
      step: 0,
      endsAt: nowSrv() + m.settings.writeSeconds * 1000,
    };
  });
}

async function advanceStep() {
  if (advancing || !meta) return;
  advancing = true;
  try {
    const s = meta.step;
    const N = meta.order.length;

    // Fill a placeholder for anyone who didn't submit, so the next player in
    // each chain always has something to work from. Transaction so we never
    // clobber a submission that lands at the same moment.
    const fills = meta.order.map((id, idx) => {
      const p = players[id];
      if ((p?.submittedStep ?? -1) >= s) return null;
      const c = ((idx - s) % N + N) % N;
      const node = ref(db, `rooms/${roomCode}/chains/${c}/${s}`);
      const placeholder = stepType(s) === "draw"
        ? { type: "draw", img: null, by: id, name: p?.name || "?" }
        : {
            type: "text", by: id, name: p?.name || "?",
            text: s === 0 ? rand(FALLBACK_PROMPTS) : rand(FALLBACK_DESCRIPTIONS),
          };
      return runTransaction(node, (cur) => (cur === null ? placeholder : undefined));
    });
    await Promise.all(fills.filter(Boolean));

    await txMeta((m) => {
      if (m.state !== "playing" || m.step !== s) return;
      if (s + 1 >= m.totalSteps) {
        return { ...m, state: "reveal", reveal: { chain: 0, upto: 0 }, endsAt: null };
      }
      const dur = stepType(s + 1) === "draw" ? m.settings.drawSeconds : m.settings.writeSeconds;
      return { ...m, step: s + 1, endsAt: nowSrv() + dur * 1000 };
    });
  } finally {
    advancing = false;
  }
}

function hostRevealNext() {
  txMeta((m) => {
    if (m.state !== "reveal") return;
    const { chain, upto } = m.reveal;
    if (upto + 1 < m.totalSteps) return { ...m, reveal: { chain, upto: upto + 1 } };
    if (chain + 1 < m.order.length) return { ...m, reveal: { chain: chain + 1, upto: 0 } };
    return { ...m, state: "done" };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "done" && m.state !== "reveal") return;
    return {
      ...m, state: "lobby",
      order: null, step: null, totalSteps: null, endsAt: null, reveal: null,
    };
  }).then((res) => {
    if (res.committed) remove(chainsRef());
  });
}

// ── Submitting ────────────────────────────────────────────────────────────────
function submitContent(content) {
  if (!meta || meta.state !== "playing" || !participating() || iSubmitted()) return;
  submittedLocal = true;
  const s = meta.step;
  const node = ref(db, `rooms/${roomCode}/chains/${myChain(s)}/${s}`);
  set(node, { ...content, by: pid, name: me()?.name || "?" });
  update(child(playersRef(), pid), { submittedStep: s });
  render();
}

function submitWrite(auto = false) {
  let text = $("write-input").value.trim();
  if (!text) {
    if (!auto) { $("write-input").focus(); return; }
    text = rand(FALLBACK_PROMPTS);
  }
  submitContent({ type: "text", text });
}

function submitDescribe(auto = false) {
  let text = $("describe-input").value.trim();
  if (!text) {
    if (!auto) { $("describe-input").focus(); return; }
    text = rand(FALLBACK_DESCRIPTIONS);
  }
  submitContent({ type: "text", text });
}

function submitDraw() {
  // Downscale before upload — line art survives it fine and it keeps the DB light.
  const out = document.createElement("canvas");
  out.width = 700; out.height = 490;
  const octx = out.getContext("2d");
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(board, 0, 0, out.width, out.height);
  submitContent({ type: "draw", img: out.toDataURL("image/png") });
}

$("btn-submit-write").addEventListener("click", () => submitWrite(false));
$("btn-submit-describe").addEventListener("click", () => submitDescribe(false));
$("btn-submit-draw").addEventListener("click", submitDraw);
$("write-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitWrite(false); });
$("describe-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitDescribe(false); });

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  if (meta.state !== "playing") { lowPlayersSince = null; return; }
  const n = nowSrv();

  // Watchdog: a game can't run with fewer than 2 players — return everyone to
  // the lobby after a 10s grace (covers a player refreshing their browser).
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (connCount < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) {
      txMeta((m) => m.state === "playing"
        ? { ...m, state: "lobby", order: null, step: null, totalSteps: null, endsAt: null, reveal: null }
        : undefined);
      return;
    }
  } else {
    lowPlayersSince = null;
  }

  // Auto-submit whatever I have when time runs out.
  if (participating() && !iSubmitted() && meta.endsAt && n > meta.endsAt) {
    const t = stepType(meta.step);
    if (t === "write") submitWrite(true);
    else if (t === "describe") submitDescribe(true);
    else submitDraw();
  }

  // Host advances once everyone (still connected) has submitted, or on timeout
  // with a grace period for the auto-submits to land.
  if (isHost()) {
    const allDone = (meta.order || []).every((id) => {
      const p = players[id];
      return !p?.connected || (p.submittedStep ?? -1) >= meta.step;
    });
    if (allDone || (meta.endsAt && n > meta.endsAt + 3000)) advanceStep();
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
    loadedStep = -1;
    showScreen("lobby");
    renderLobby();
  } else if (meta.state === "playing") {
    showScreen("game");
    renderGame();
  } else { // reveal | done
    showScreen("reveal");
    subscribeChains();
    renderReveal();
  }
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
    $("set-draw-seconds").value = String(meta.settings.drawSeconds);
    $("set-write-seconds").value = String(meta.settings.writeSeconds);
    $("set-chain-len").value = String(meta.settings.chainLen);
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderGame() {
  const s = meta.step;
  const t = stepType(s);
  $("step-info").textContent = `Step ${s + 1}/${meta.totalSteps}`;
  $("task-label").textContent =
    t === "write" ? "✍️ Write something drawable" :
    t === "draw" ? "🎨 Draw it!" : "🔍 Describe it!";

  if (s !== loadedStep) {
    loadedStep = s;
    submittedLocal = false;
    prevContent = null;
    $("write-input").value = "";
    $("describe-input").value = "";
    clearStrokes();
    if (t !== "write" && participating()) loadPrevContent(s);
  }

  if (!participating()) { showView("spectate"); return; }
  if (iSubmitted()) { renderWait(); showView("wait"); return; }

  if (t === "write") {
    showView("write");
  } else if (t === "draw") {
    $("draw-prompt-text").textContent = prevContent?.text || "…";
    showView("draw");
  } else {
    const img = $("describe-img");
    const missing = $("describe-missing");
    if (prevContent?.img) {
      img.src = prevContent.img;
      img.classList.remove("hidden");
      missing.classList.add("hidden");
    } else {
      img.classList.add("hidden");
      missing.classList.remove("hidden");
    }
    showView("describe");
  }
  renderTimer();
}

async function loadPrevContent(s) {
  const snap = await get(ref(db, `rooms/${roomCode}/chains/${myChain(s)}/${s - 1}`));
  if (meta?.step !== s) return; // step moved on while we were fetching
  prevContent = snap.val();
  render();
}

function renderWait() {
  const ul = $("wait-list");
  ul.innerHTML = "";
  for (const id of meta.order || []) {
    const p = players[id];
    if (!p) continue;
    const done = (p.submittedStep ?? -1) >= meta.step;
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : p.connected ? "✏️" : "💤"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
}

function renderTimer() {
  const el = $("timer");
  if (meta?.state !== "playing" || !meta.endsAt) {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((meta.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", secs <= 10);
}

// ── Reveal ────────────────────────────────────────────────────────────────────
function subscribeChains() {
  if (chainsSubscribed) return;
  chainsSubscribed = true;
  onValue(chainsRef(), (s) => {
    chains = s.val() || {};
    if (meta?.state === "reveal" || meta?.state === "done") renderReveal();
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderReveal() {
  const feed = $("reveal-feed");
  const nextBtn = $("btn-reveal-next");
  const waiting = $("reveal-waiting");

  if (meta.state === "done") {
    $("reveal-title").textContent = "🎬 That's a wrap!";
    feed.innerHTML = `<p class="hint">Hope somebody screenshotted the good ones.</p>`;
    nextBtn.classList.add("hidden");
    waiting.classList.add("hidden");
    renderDoneControls();
    return;
  }

  const { chain, upto } = meta.reveal || { chain: 0, upto: 0 };
  const starter = players[meta.order?.[chain]]?.name || "someone";
  $("reveal-title").textContent =
    `📖 Chain ${chain + 1} of ${meta.order?.length || "?"} — started by ${starter}`;

  feed.innerHTML = "";
  const chainData = chains[chain] || {};
  for (let s = 0; s <= upto; s++) {
    const entry = chainData[s];
    const div = document.createElement("div");
    div.className = "reveal-entry" + (s === 0 ? " first" : "");
    if (!entry) {
      div.innerHTML = `<span class="author">…</span><div class="missing">loading…</div>`;
    } else if (entry.type === "text") {
      div.innerHTML = `
        <span class="author">${esc(entry.name)} ${s === 0 ? "started with" : "saw the drawing and said"}:</span>
        <div class="bubble">${esc(entry.text)}</div>`;
    } else {
      div.innerHTML = entry.img
        ? `<span class="author">${esc(entry.name)} drew:</span><img src="${entry.img}" alt="drawing">`
        : `<span class="author">${esc(entry.name)}</span><div class="missing">🎨 ran out of time — no drawing 😢</div>`;
    }
    feed.appendChild(div);
  }
  feed.scrollTop = feed.scrollHeight;

  nextBtn.classList.toggle("hidden", !isHost());
  waiting.classList.toggle("hidden", isHost());
  const lastChain = chain + 1 >= (meta.order?.length || 0);
  const lastStep = upto + 1 >= meta.totalSteps;
  nextBtn.textContent = !lastStep ? "Next ▶" : !lastChain ? "Next chain ▶▶" : "Finish 🎬";
  renderDoneControls(false);
}

function renderDoneControls(showEnd = true) {
  let bar = $("reveal-end-bar");
  if (!showEnd) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "reveal-end-bar";
    bar.className = "btn-row";
    $("reveal-controls").after(bar);
  }
  bar.innerHTML = "";
  if (isHost()) {
    const again = document.createElement("button");
    again.className = "btn primary big";
    again.textContent = "Back to lobby";
    again.addEventListener("click", backToLobby);
    bar.appendChild(again);
  } else {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Waiting for the host…";
    bar.appendChild(p);
  }
  const leave = document.createElement("button");
  leave.className = "btn small ghost";
  leave.textContent = "Leave room";
  leave.addEventListener("click", leaveRoom);
  bar.appendChild(leave);
}

$("btn-reveal-next").addEventListener("click", hostRevealNext);

// ── Lobby interactions ────────────────────────────────────────────────────────
$("btn-start").addEventListener("click", startGame);
$("set-draw-seconds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { drawSeconds: Number(e.target.value) }));
$("set-write-seconds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { writeSeconds: Number(e.target.value) }));
$("set-chain-len").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { chainLen: e.target.value }));

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

// ── Local canvas (not live-synced — each player draws privately) ─────────────
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
let strokes = [];       // [{c, w, p: [x,y,x,y,...]}]
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
  // Draw just the new segment — no full redraw needed mid-stroke.
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
