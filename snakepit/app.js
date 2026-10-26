// Snake Pit — every snake in one arena, Red vs Blue, synced through Firebase RTDB.
//
// Architecture (same as Frogger Rush): THE WORLD IS DETERMINISTIC, ONLY SNAKES
// SYNC. The food sequence is a pure function of (round seed, food index): every
// client computes the same apple positions from the shared seed, and the only
// contested state is meta.round.foodIndex, claimed by transaction. Your own
// snake is locally authoritative — walls and your OWN body are the only things
// that can kill you, checked locally, so latency can't hurt you. Other players'
// snakes are non-colliding ghosts synced on a throttle.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";

const $ = (id) => document.getElementById(id);

// ── Config check ──────────────────────────────────────────────────────────────
if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("PASTE")) {
  showScreen("setup");
  throw new Error("Firebase config not filled in — see firebase-config.js");
}

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ── Identity & shared state ───────────────────────────────────────────────────
const pid = (() => {
  let v = localStorage.getItem("pg_pid");
  if (!v) { v = Math.random().toString(36).slice(2, 10); localStorage.setItem("pg_pid", v); }
  return v;
})();

let roomCode = null;
let meta = null;
let players = {};
let serverOffset = 0;
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// ── Arena geometry ────────────────────────────────────────────────────────────
const COLS = 36, ROWS = 24, CELL = 30;
const W = COLS * CELL, H = ROWS * CELL;
const TICK_MS = 130;
const cx = (x) => x * CELL + CELL / 2;
const cy = (y) => y * CELL + CELL / 2;

// ── Deterministic food ────────────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Apple #k for this round's seed — one cell margin from the walls.
function foodPos(seed, k) {
  const rng = mulberry32((seed + k * 2654435761) | 0);
  return [1 + Math.floor(rng() * (COLS - 2)), 1 + Math.floor(rng() * (ROWS - 2))];
}

// ── My snake (locally authoritative) ─────────────────────────────────────────
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const SPAWNS = [
  { x: 5, y: 5, d: "right" }, { x: 30, y: 5, d: "left" },
  { x: 5, y: 18, d: "right" }, { x: 30, y: 18, d: "left" },
  { x: 17, y: 4, d: "down" }, { x: 18, y: 19, d: "up" },
  { x: 8, y: 12, d: "right" }, { x: 27, y: 12, d: "left" },
];

function hashStr(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h >>> 0;
}

let snake = null;        // { body: [[x,y],...head first], dir, queuedDir, grow, dead, prevHead, prevTail }
let lastTickAt = 0;
let lastSnakeWrite = 0;
let claimInFlight = false;
let flashes = [];
let roundKey = "";

function spawnSnake() {
  const slot = SPAWNS[hashStr(pid) % SPAWNS.length];
  const [dx, dy] = DIRS[slot.d];
  const body = [
    [slot.x, slot.y],
    [slot.x - dx, slot.y - dy],
    [slot.x - 2 * dx, slot.y - 2 * dy],
  ];
  snake = {
    body, dir: slot.d, queuedDir: null, grow: 0, dead: false,
    prevHead: body[0], prevTail: body[body.length - 1],
  };
  lastTickAt = performance.now();
  writeSnake(true);
}

function writeSnake(immediate) {
  if (!roomCode || !snake || !me()) return;
  const now = performance.now();
  if (!immediate && now - lastSnakeWrite < 250) return;
  lastSnakeWrite = now;
  update(ref(db, `rooms/${roomCode}/players/${pid}/snake`), {
    b: snake.body.flat(),
    d: snake.dead ? 1 : 0,
  });
}

function die() {
  if (!snake || snake.dead) return;
  snake.dead = true;
  runTransaction(ref(db, `rooms/${roomCode}/players/${pid}/deaths`), (v) => (v || 0) + 1);
  writeSnake(true);
  setTimeout(() => { if (snake?.dead && meta?.state === "playing") spawnSnake(); }, 1500);
}

function tryClaimFood(k) {
  if (claimInFlight) return;
  claimInFlight = true;
  const team = me()?.team || "red";
  runTransaction(child(metaRef(), "round/foodIndex"), (v) =>
    (v === k || (v == null && k === 0)) ? k + 1 : undefined
  ).then((res) => {
    claimInFlight = false;
    if (!res.committed || !snake || snake.dead || !meta?.round?.seed) return;
    snake.grow += 2;
    runTransaction(child(metaRef(), `scores/${team}`), (v) => (v || 0) + 10);
    runTransaction(ref(db, `rooms/${roomCode}/players/${pid}/maxLen`),
      (v) => Math.max(v || 0, snake.body.length + 2));
    const [fx, fy] = foodPos(meta.round.seed, k);
    flashes.push({ x: cx(fx), y: cy(fy), t: performance.now(), txt: "🍎 +10" });
    writeSnake(true);
  }).catch(() => { claimInFlight = false; });
}

function tick() {
  if (!snake || snake.dead || meta?.state !== "playing") return;

  if (snake.queuedDir) {
    const [qx, qy] = DIRS[snake.queuedDir];
    const [dx, dy] = DIRS[snake.dir];
    if (qx + dx !== 0 || qy + dy !== 0) snake.dir = snake.queuedDir; // no 180° flips
    snake.queuedDir = null;
  }

  const [dx, dy] = DIRS[snake.dir];
  const [hx, hy] = snake.body[0];
  const nx = hx + dx, ny = hy + dy;

  if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) { die(); return; }
  // Own-body check: the tail cell is safe to follow unless we're growing into it.
  const check = snake.grow > 0 ? snake.body : snake.body.slice(0, -1);
  if (check.some(([bx, by]) => bx === nx && by === ny)) { die(); return; }

  snake.prevHead = snake.body[0];
  snake.prevTail = snake.body[snake.body.length - 1];
  snake.body.unshift([nx, ny]);
  if (snake.grow > 0) snake.grow--;
  else snake.body.pop();

  const k = meta.round?.foodIndex || 0;
  const [fx, fy] = foodPos(meta.round.seed, k);
  if (nx === fx && ny === fy) tryClaimFood(k);

  writeSnake(false);
}

function steer(dir) {
  if (!DIRS[dir] || meta?.state !== "playing" || !snake || snake.dead) return;
  snake.queuedDir = dir;
}

// ── Render loop ───────────────────────────────────────────────────────────────
const board = $("board");
const ctx = board.getContext("2d");
const ghosts = {}; // pid -> { pts: [[px,py],...], len }

function teamColor(team, alpha = 1) {
  return team === "blue" ? `rgba(77,171,247,${alpha})` : `rgba(255,107,107,${alpha})`;
}

function drawSnakePath(pts, width, color) {
  if (!pts.length) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.1, pts[0][1]);
  ctx.stroke();
}

function draw(now) {
  ctx.clearRect(0, 0, W, H);

  // Pit floor: subtle checkerboard + wall border.
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      ctx.fillStyle = (x + y) % 2 ? "#161927" : "#181b2b";
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }
  ctx.strokeStyle = "#2d3148";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, W - 6, H - 6);

  if (!meta || meta.state === "lobby" || !meta.round) return;

  // Apple (shared, deterministic).
  const k = meta.round.foodIndex || 0;
  const [fx, fy] = foodPos(meta.round.seed, k);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const pulse = 1 + Math.sin(now / 180) * 0.08;
  ctx.font = `${Math.round(26 * pulse)}px serif`;
  ctx.fillText("🍎", cx(fx), cy(fy) + 1);

  // Ghost snakes.
  for (const [id, p] of Object.entries(players)) {
    if (id === pid || !p.connected || !p.snake?.b?.length) continue;
    const target = [];
    for (let i = 0; i + 1 < p.snake.b.length; i += 2) {
      target.push([cx(p.snake.b[i]), cy(p.snake.b[i + 1])]);
    }
    const g = (ghosts[id] ||= { pts: target.map((pt) => [...pt]) });
    if (g.pts.length !== target.length) g.pts = target.map((pt) => [...pt]);
    else {
      for (let i = 0; i < target.length; i++) {
        g.pts[i][0] += (target[i][0] - g.pts[i][0]) * 0.3;
        g.pts[i][1] += (target[i][1] - g.pts[i][1]) * 0.3;
      }
    }
    const alpha = p.snake.d ? 0.18 : 0.42;
    drawSnakePath(g.pts, CELL - 10, teamColor(p.team, alpha));
    const head = g.pts[0];
    if (p.snake.d) {
      ctx.globalAlpha = 0.6;
      ctx.font = "20px serif";
      ctx.fillText("💀", head[0], head[1]);
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = 0.8;
    ctx.font = "600 11px system-ui";
    ctx.fillStyle = "#fff";
    ctx.fillText(p.name || "", head[0], head[1] - 20);
    ctx.globalAlpha = 1;
  }

  // My snake — head/tail interpolated between ticks for smooth gliding.
  if (snake && me()) {
    const prog = Math.min(1, (now - lastTickAt) / TICK_MS);
    const pts = snake.body.map(([x, y]) => [cx(x), cy(y)]);
    if (!snake.dead && pts.length > 1) {
      const [phx, phy] = snake.prevHead;
      pts[0] = [
        cx(phx) + (pts[0][0] - cx(phx)) * prog,
        cy(phy) + (pts[0][1] - cy(phy)) * prog,
      ];
      const last = pts.length - 1;
      const [ptx, pty] = snake.prevTail;
      pts[last] = [
        cx(ptx) + (pts[last][0] - cx(ptx)) * prog,
        cy(pty) + (pts[last][1] - cy(pty)) * prog,
      ];
    }
    const col = me().team === "blue" ? "#4dabf7" : "#ff6b6b";
    drawSnakePath(pts, CELL - 8, snake.dead ? teamColor(me().team, 0.3) : col);
    // Head: brighter cap + eyes (or a skull while dead).
    const head = pts[0];
    if (snake.dead) {
      ctx.font = "26px serif";
      ctx.fillText("💀", head[0], head[1]);
    } else {
      ctx.fillStyle = "#fff";
      const [dx, dy] = DIRS[snake.dir];
      const ex = dy !== 0 ? 5 : 0, ey = dx !== 0 ? 5 : 0;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(head[0] + dx * 5 + ex * s, head[1] + dy * 5 + ey * s, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Score flashes.
  flashes = flashes.filter((f) => now - f.t < 900);
  for (const f of flashes) {
    const p = (now - f.t) / 900;
    ctx.globalAlpha = 1 - p;
    ctx.font = "700 22px system-ui";
    ctx.fillStyle = "#ffd43b";
    ctx.fillText(f.txt, f.x, f.y - p * 30);
    ctx.globalAlpha = 1;
  }
}

let tickCarry = 0;
let lastFrame = performance.now();
function frame(now) {
  // Fixed-step movement: accumulate frame time, step every TICK_MS.
  tickCarry += now - lastFrame;
  lastFrame = now;
  if (tickCarry > TICK_MS * 4) tickCarry = TICK_MS; // tab was backgrounded
  while (tickCarry >= TICK_MS) {
    tickCarry -= TICK_MS;
    lastTickAt = now - tickCarry;
    tick();
  }
  if (!$("screen-game").classList.contains("hidden")) draw(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ── Screens ───────────────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
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
      game: "snakepit",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 3, roundSeconds: 90 },
      scores: { red: 0, blue: 0 },
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
    if (snap.val().game !== "snakepit") {
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
  let team = existing?.team;
  if (!team) {
    const all = (await get(playersRef())).val() || {};
    let red = 0, blue = 0;
    for (const p of Object.values(all)) {
      if (!p.connected) continue;
      p.team === "red" ? red++ : blue++;
    }
    team = red <= blue ? "red" : "blue";
  }
  await update(meRef, {
    name, team,
    connected: true,
    joinedAt: existing?.joinedAt || serverTimestamp(),
    deaths: existing?.deaths || 0,
    maxLen: existing?.maxLen || 3,
  });
  trackPresence(db, meRef);

  onValue(metaRef(), (s) => {
    meta = s.val();
    if (!meta) return;
    syncRound();
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

// Respawn fresh whenever a new round appears.
function syncRound() {
  const r = meta.round;
  if (!r?.seed) { snake = null; roundKey = ""; return; }
  const key = `${r.seed}:${r.num}`;
  if (key !== roundKey) {
    roundKey = key;
    flashes = [];
    claimInFlight = false;
    for (const k of Object.keys(ghosts)) delete ghosts[k];
    spawnSnake();
  }
}

// ── State machine (host-driven, transaction-guarded) ──────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

async function resetRoundStats() {
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/deaths`] = 0;
    resets[`${id}/maxLen`] = 3;
  }
  await update(playersRef(), resets);
}

async function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  if (conn.length < 2 || !conn.some((p) => p.team === "red") || !conn.some((p) => p.team === "blue")) {
    alert("Need at least 2 players with someone on each team.");
    return;
  }
  await resetRoundStats();
  const seed = Math.floor(Math.random() * 2 ** 31);
  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const start = nowSrv() + 3000;
    return {
      ...m,
      state: "countdown",
      scores: { red: 0, blue: 0 },
      round: { num: 1, seed, foodIndex: 0, startAt: start, endsAt: start + m.settings.roundSeconds * 1000 },
    };
  });
}

async function nextRound() {
  const expect = meta?.round?.num;
  if (meta.round.num >= meta.settings.rounds) {
    txMeta((m) => (m.state === "roundEnd" && m.round?.num === expect ? { ...m, state: "gameEnd" } : undefined));
    return;
  }
  await resetRoundStats();
  const seed = Math.floor(Math.random() * 2 ** 31);
  txMeta((m) => {
    if (m.state !== "roundEnd" || m.round?.num !== expect) return;
    const start = nowSrv() + 3000;
    return {
      ...m,
      state: "countdown",
      round: { num: m.round.num + 1, seed, foodIndex: 0, startAt: start, endsAt: start + m.settings.roundSeconds * 1000 },
    };
  });
}

function backToLobby() {
  txMeta((m) => (m.state === "gameEnd" ? { ...m, state: "lobby", round: null } : undefined));
}

setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  renderOverlay();
  claimHostIfAbandoned();

  // Watchdog: can't race with fewer than 2 players — lobby after a 10s grace.
  const active = ["countdown", "playing", "roundEnd"].includes(meta.state);
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => (m.state !== "lobby" && m.state !== "gameEnd"
        ? { ...m, state: "lobby", round: null } : undefined));
    }
  } else {
    lowPlayersSince = null;
  }

  if (!isHost() || !meta.round) return;
  const n = nowSrv();
  const num = meta.round.num;
  if (meta.state === "countdown" && n >= meta.round.startAt) {
    txMeta((m) => (m.state === "countdown" && m.round?.num === num ? { ...m, state: "playing" } : undefined));
  } else if (meta.state === "playing" && n > meta.round.endsAt) {
    txMeta((m) => (m.state === "playing" && m.round?.num === num
      ? { ...m, state: "roundEnd", round: { ...m.round, endsAt: nowSrv() + 8000 } } : undefined));
  } else if (meta.state === "roundEnd" && n > meta.round.endsAt) {
    nextRound();
  }
}, 300);

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

// ── Rendering (DOM) ───────────────────────────────────────────────────────────
function render() {
  if (!meta) return;
  if (meta.state === "lobby") {
    showScreen("lobby");
    renderLobby();
  } else {
    showScreen("game");
    renderHud();
    renderOverlay();
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderLobby() {
  $("lobby-code").textContent = roomCode;
  const lists = { red: $("lobby-red-list"), blue: $("lobby-blue-list") };
  lists.red.innerHTML = "";
  lists.blue.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    const li = document.createElement("li");
    li.textContent = `${p.name}${meta.hostId === id ? " 👑" : ""}`;
    if (id === pid) { li.classList.add("me"); li.textContent += " (you)"; }
    (lists[p.team] || lists.red).appendChild(li);
  }
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) {
    $("set-rounds").value = String(meta.settings.rounds);
    $("set-seconds").value = String(meta.settings.roundSeconds);
  }
}

function renderHud() {
  $("round-info").textContent = meta.round ? `Round ${meta.round.num}/${meta.settings.rounds}` : "";
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;
  $("apple-count").textContent = `🍎 ${meta.round?.foodIndex || 0}`;
  const p = me();
  $("personal-stats").textContent =
    `📏 ${snake?.body?.length ?? 3} · 💀 ${p?.deaths || 0}`;
  renderTimer();
}

function renderTimer() {
  const el = $("timer");
  if (meta?.state !== "playing" || !meta.round?.endsAt) {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((meta.round.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", secs <= 10);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let overlayState = "";
function renderOverlay() {
  if (!meta || meta.state === "lobby") return;
  const ov = $("overlay");
  const box = $("overlay-content");

  if (meta.state === "countdown" && meta.round) {
    const n = Math.max(1, Math.ceil((meta.round.startAt - nowSrv()) / 1000));
    ov.classList.remove("hidden");
    ov.classList.add("countdown");
    box.innerHTML = `<h2>Round ${meta.round.num} — heads up!</h2><div class="big-num">${n}</div><p class="hint">Arrows / WASD to steer. First to the 🍎 scores +10.</p>`;
    overlayState = "countdown";
    return;
  }
  ov.classList.remove("countdown");

  if (meta.state === "roundEnd") {
    if (overlayState !== `end${meta.round?.num}`) {
      overlayState = `end${meta.round?.num}`;
      const byLen = sortedPlayers()
        .filter(([, p]) => p.connected)
        .sort((a, b) => (b[1].maxLen || 0) - (a[1].maxLen || 0));
      const rows = byLen.slice(0, 5)
        .map(([, p]) => `<li>${p.team === "blue" ? "🔵" : "🔴"} ${esc(p.name)} — 📏 ${p.maxLen || 3} · 💀 ${p.deaths || 0}</li>`)
        .join("");
      const champ = byLen[0];
      const clumsy = [...byLen].sort((a, b) => (b[1].deaths || 0) - (a[1].deaths || 0))[0];
      box.innerHTML = `
        <h2>Round ${meta.round?.num} over!</h2>
        <div class="big-score">🔴 ${meta.scores?.red || 0} — ${meta.scores?.blue || 0} 🔵</div>
        <p>🏆 Longest snake: <strong>${esc(champ?.[1]?.name || "—")}</strong> (${champ?.[1]?.maxLen || 3})
           &nbsp;·&nbsp; 💀 Most deaths: <strong>${esc(clumsy?.[1]?.name || "—")}</strong> (${clumsy?.[1]?.deaths || 0})</p>
        <ul>${rows}</ul>`;
    }
    ov.classList.remove("hidden");
  } else if (meta.state === "gameEnd") {
    if (overlayState !== "gameEnd") {
      overlayState = "gameEnd";
      const red = meta.scores?.red || 0, blue = meta.scores?.blue || 0;
      const result = red === blue ? `<h2>🤝 It's a tie!</h2>`
        : red > blue ? `<h2 class="winner-red">🔴 Red Team wins!</h2>`
        : `<h2 class="winner-blue">🔵 Blue Team wins!</h2>`;
      box.innerHTML = `
        ${result}
        <div class="big-score">${red} — ${blue}</div>
        ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
                   : `<p class="hint">Waiting for the host…</p>`}
        <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
      box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
      box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
    }
    ov.classList.remove("hidden");
  } else {
    overlayState = "";
    ov.classList.add("hidden");
  }
}

// ── Lobby interactions ────────────────────────────────────────────────────────
$("lobby-team-red").addEventListener("click", () => switchTeam("red"));
$("lobby-team-blue").addEventListener("click", () => switchTeam("blue"));
function switchTeam(team) {
  if (meta?.state !== "lobby") return;
  update(child(playersRef(), pid), { team });
}

$("btn-start").addEventListener("click", startGame);
$("set-rounds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { rounds: Number(e.target.value) }));
$("set-seconds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { roundSeconds: Number(e.target.value) }));

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

// ── Controls ──────────────────────────────────────────────────────────────────
const KEYMAP = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  w: "up", s: "down", a: "left", d: "right",
  W: "up", S: "down", A: "left", D: "right",
};
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  const dir = KEYMAP[e.key];
  if (dir) { e.preventDefault(); steer(dir); }
  if (e.key === " ") e.preventDefault();
});

for (const btn of document.querySelectorAll(".dpad-btn")) {
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    steer(btn.dataset.dir);
  });
}
