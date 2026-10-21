// Frogger Rush — everyone hops at once, Red vs Blue, synced through Firebase RTDB.
//
// Architecture: THE WORLD IS DETERMINISTIC, ONLY FROGS SYNC. Every lane's
// traffic is a pure function of (round seed, lane index, serverNow - startAt):
// a seeded PRNG derives per-lane direction/speed/obstacle pattern once, the
// pattern repeats every `period` pixels, and position = time * speed mod period.
// No obstacle data ever touches the database — all clients compute identical
// traffic from the shared seed and server-offset-corrected clocks, and all
// collision detection is local, so network latency can't kill you. Your own
// frog is locally authoritative; other players' frogs are non-colliding ghosts
// synced on hops (and throttled while riding logs).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, onValue, onDisconnect,
  runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";

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

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// ── Board geometry ────────────────────────────────────────────────────────────
const CELL = 60, COLS = 13, ROWS = 14;
const W = CELL * COLS, H = CELL * ROWS;
const GOAL_ROW = 0;
const RIVER_ROWS = [1, 2, 3, 4, 5];
const ROAD_ROWS = [7, 8, 9, 10, 11];
const START_ROW = 13;
const isRiver = (r) => r >= 1 && r <= 5;
const isRoad = (r) => r >= 7 && r <= 11;
const rowY = (r) => r * CELL + CELL / 2;

// ── Deterministic world ───────────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mod = (n, m) => ((n % m) + m) % m;

let lanes = null;     // row -> lane params for the current round
let laneKey = "";

function genLanes(seed, roundNum) {
  const out = {};
  const mult = 1 + (roundNum - 1) * 0.15;
  const laneRows = [...RIVER_ROWS, ...ROAD_ROWS];
  laneRows.forEach((row, li) => {
    const rng = mulberry32((seed + li * 2654435761) | 0);
    const river = isRiver(row);
    const dir = rng() < 0.5 ? 1 : -1;
    // First road lane (row 11, nearest the start) kept gentle.
    const base = river ? 55 + rng() * 85 : 80 + rng() * 130;
    const speed = (row === 11 ? Math.min(base, 95) : base) * mult;
    const items = [];
    let cursor = 0;
    while (cursor < 18) {
      const len = river ? (rng() < 0.5 ? 2 : 3) : (rng() < 0.25 ? 2 : 1);
      const gap = river ? 1.2 + rng() * 2.3 : 2.2 + rng() * 2.2;
      items.push({ off: cursor * CELL, lenPx: len * CELL, hue: Math.floor(rng() * 360), truck: !river && len === 2 });
      cursor += len + gap;
    }
    out[row] = { dir, speed, items, period: cursor * CELL, river };
  });
  return out;
}

// Both wrapped copies of an obstacle's x position at world-time t (seconds).
function itemXs(lane, item, t) {
  const x = mod(item.off + lane.dir * lane.speed * t, lane.period);
  return [x - lane.period, x];
}

const worldTime = () =>
  meta?.round?.startAt ? (nowSrv() - meta.round.startAt) / 1000 : 0;

function logVelocityUnder(row, px, t) {
  const lane = lanes?.[row];
  if (!lane) return null;
  for (const item of lane.items) {
    for (const x of itemXs(lane, item, t)) {
      if (px >= x + 4 && px <= x + item.lenPx - 4) return lane.dir * lane.speed;
    }
  }
  return null;
}

function carHit(row, px, t) {
  const lane = lanes?.[row];
  if (!lane) return false;
  for (const item of lane.items) {
    for (const x of itemXs(lane, item, t)) {
      if (px > x + 12 && px < x + item.lenPx - 12) return true;
    }
  }
  return false;
}

// ── My frog ───────────────────────────────────────────────────────────────────
const HOP_MS = 85;
let frog = { row: START_ROW, px: W / 2, dead: false, diedAt: 0, hop: null };
let flashes = [];
let lastRideWrite = 0;

function writeFrog() {
  if (!roomCode || !me()) return;
  update(ref(db, `rooms/${roomCode}/players/${pid}/frog`), {
    x: Math.round(frog.px), y: frog.row, t: serverTimestamp(),
  });
}

function resetFrog() {
  frog = { row: START_ROW, px: W / 2, dead: false, diedAt: 0, hop: null };
  writeFrog();
}

function die() {
  if (frog.dead) return;
  frog.dead = true;
  frog.diedAt = performance.now();
  frog.hop = null;
  runTransaction(ref(db, `rooms/${roomCode}/players/${pid}/deaths`), (v) => (v || 0) + 1);
  writeFrog();
  setTimeout(() => { if (frog.dead) resetFrog(); }, 800);
}

function crossed() {
  const team = me()?.team || "red";
  runTransaction(child(metaRef(), `scores/${team}`), (v) => (v || 0) + 10);
  runTransaction(ref(db, `rooms/${roomCode}/players/${pid}/crossings`), (v) => (v || 0) + 1);
  flashes.push({ x: frog.px, y: rowY(GOAL_ROW), t: performance.now(), txt: "🎉 +10" });
  resetFrog();
}

function hop(dir) {
  if (meta?.state !== "playing" || !me() || frog.dead || frog.hop) return;
  const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
  if (!d) return;
  const row1 = Math.min(ROWS - 1, Math.max(0, frog.row + d[1]));
  const x1 = Math.min(W - CELL / 2, Math.max(CELL / 2, frog.px + d[0] * CELL));
  if (row1 === frog.row && x1 === frog.px) return;
  frog.hop = { x0: frog.px, y0: rowY(frog.row), x1, row1, start: performance.now() };
}

// ── Simulation step (runs in the rAF loop) ────────────────────────────────────
let lastFrame = performance.now();

function step(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!meta || meta.state === "lobby" || !lanes) return;

  // Finish an in-flight hop.
  if (frog.hop && now - frog.hop.start >= HOP_MS) {
    frog.px = frog.hop.x1;
    frog.row = frog.hop.row1;
    frog.hop = null;
    writeFrog();
    if (frog.row === GOAL_ROW) { crossed(); return; }
  }

  if (meta.state !== "playing" || frog.dead || frog.hop) return;
  const t = worldTime();

  if (isRiver(frog.row)) {
    const v = logVelocityUnder(frog.row, frog.px, t);
    if (v === null) { die(); return; }            // splash
    frog.px += v * dt;
    if (frog.px < -15 || frog.px > W + 15) { die(); return; } // carried off the edge
    if (now - lastRideWrite > 200) { lastRideWrite = now; writeFrog(); }
  } else if (isRoad(frog.row)) {
    if (carHit(frog.row, frog.px, t)) { die(); return; } // squash
  }
}

// ── Drawing ───────────────────────────────────────────────────────────────────
const board = $("board");
const ctx = board.getContext("2d");
const ghostDisp = {}; // pid -> smoothed {x, y}

function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw(now) {
  ctx.clearRect(0, 0, W, H);
  const t = worldTime();

  // Terrain
  for (let r = 0; r < ROWS; r++) {
    const y = r * CELL;
    if (r === GOAL_ROW) {
      ctx.fillStyle = "#1e4620";
      ctx.fillRect(0, y, W, CELL);
      for (let c = 0; c < COLS; c += 2) {
        ctx.fillStyle = "#2f9e44";
        ctx.beginPath();
        ctx.ellipse(c * CELL + CELL / 2, y + CELL / 2, 22, 18, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#1e4620";
        ctx.beginPath();
        ctx.ellipse(c * CELL + CELL / 2, y + CELL / 2, 8, 6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (isRiver(r)) {
      ctx.fillStyle = r % 2 ? "#143a63" : "#16406e";
      ctx.fillRect(0, y, W, CELL);
      ctx.fillStyle = "rgba(255,255,255,0.05)";
      const drift = (t * 24 + r * 37) % 120;
      for (let x = -120; x < W + 120; x += 120) {
        ctx.fillRect(x + drift, y + 14 + (r % 3) * 12, 56, 3);
      }
    } else if (isRoad(r)) {
      ctx.fillStyle = r % 2 ? "#23252e" : "#262833";
      ctx.fillRect(0, y, W, CELL);
      if (r !== ROAD_ROWS[ROAD_ROWS.length - 1]) {
        ctx.fillStyle = "rgba(255,255,255,0.16)";
        for (let x = 10; x < W; x += 70) ctx.fillRect(x, y + CELL - 2, 34, 3);
      }
    } else {
      ctx.fillStyle = r === 6 ? "#2b5e2e" : "#275229";
      ctx.fillRect(0, y, W, CELL);
      ctx.fillStyle = "rgba(0,0,0,0.12)";
      for (let c = 0; c < COLS; c++) {
        if ((c * 31 + r * 17) % 5 === 0) {
          ctx.beginPath();
          ctx.arc(c * CELL + ((c * 23) % 40) + 10, y + ((c * 13) % 40) + 10, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // Obstacles
  if (lanes) {
    for (const rowStr of Object.keys(lanes)) {
      const row = Number(rowStr);
      const lane = lanes[row];
      const y = row * CELL;
      for (const item of lane.items) {
        for (const x of itemXs(lane, item, t)) {
          if (x + item.lenPx < -10 || x > W + 10) continue;
          if (lane.river) {
            ctx.fillStyle = "#7a4a21";
            rr(x + 2, y + 12, item.lenPx - 4, CELL - 24, 14);
            ctx.fill();
            ctx.fillStyle = "#5e3817";
            for (const ex of [x + 10, x + item.lenPx - 10]) {
              ctx.beginPath();
              ctx.ellipse(ex, y + CELL / 2, 6, CELL / 2 - 14, 0, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.strokeStyle = "rgba(0,0,0,0.25)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x + 16, y + CELL / 2);
            ctx.lineTo(x + item.lenPx - 16, y + CELL / 2);
            ctx.stroke();
          } else {
            const bodyY = y + 10, bodyH = CELL - 20;
            ctx.fillStyle = `hsl(${item.hue} 65% 55%)`;
            rr(x + 4, bodyY, item.lenPx - 8, bodyH, 8);
            ctx.fill();
            // windshield toward direction of travel
            ctx.fillStyle = "rgba(10,15,25,0.65)";
            const wsW = 12;
            const wsX = lane.dir > 0 ? x + item.lenPx - 8 - wsW - 4 : x + 12;
            rr(wsX, bodyY + 5, wsW, bodyH - 10, 3);
            ctx.fill();
            if (item.truck) {
              ctx.fillStyle = "rgba(255,255,255,0.25)";
              const cabX = lane.dir > 0 ? x + item.lenPx - 36 : x + 8;
              rr(cabX, bodyY + 3, 28, bodyH - 6, 5);
              ctx.fill();
            }
          }
        }
      }
    }
  }

  // Ghost frogs (other players)
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [id, p] of Object.entries(players)) {
    if (id === pid || !p.connected || !p.frog) continue;
    const g = (ghostDisp[id] ||= { x: p.frog.x, y: p.frog.y });
    g.x += (p.frog.x - g.x) * 0.25;
    g.y += (p.frog.y - g.y) * 0.25;
    const gx = g.x, gy = rowY(g.y);
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = p.team === "blue" ? "#4dabf7" : "#ff6b6b";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(gx, gy, 23, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = "34px serif";
    ctx.fillText("🐸", gx, gy + 2);
    ctx.globalAlpha = 0.8;
    ctx.font = "600 11px system-ui";
    ctx.fillStyle = "#fff";
    ctx.fillText(p.name || "", gx, gy - 30);
    ctx.globalAlpha = 1;
  }

  // My frog
  if (meta && meta.state !== "lobby" && me()) {
    let fx = frog.px, fy = rowY(frog.row);
    if (frog.hop) {
      const p = Math.min(1, (now - frog.hop.start) / HOP_MS);
      fx = frog.hop.x0 + (frog.hop.x1 - frog.hop.x0) * p;
      fy = frog.hop.y0 + (rowY(frog.hop.row1) - frog.hop.y0) * p - Math.sin(p * Math.PI) * 14;
    }
    ctx.strokeStyle = me().team === "blue" ? "#4dabf7" : "#ff6b6b";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(fx, fy, 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = "40px serif";
    ctx.fillText(frog.dead ? "💀" : "🐸", fx, fy + 2);
  }

  // Score flashes
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

function frame(now) {
  step(now);
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
      game: "frogger",
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
    if (snap.val().game !== "frogger") {
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
    crossings: existing?.crossings || 0,
    deaths: existing?.deaths || 0,
  });
  onDisconnect(child(meRef, "connected")).set(false);

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

// Rebuild lanes + reset my frog whenever a new round appears.
function syncRound() {
  const r = meta.round;
  if (!r?.seed) { lanes = null; laneKey = ""; return; }
  const key = `${r.seed}:${r.num}`;
  if (key !== laneKey) {
    laneKey = key;
    lanes = genLanes(r.seed, r.num);
    flashes = [];
    resetFrog();
  }
}

// ── State machine (host-driven, transaction-guarded) ──────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

async function resetRoundStats() {
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/crossings`] = 0;
    resets[`${id}/deaths`] = 0;
  }
  await update(playersRef(), resets);
}

async function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  if (conn.length < 2) { alert("Need at least 2 players."); return; }
  await resetRoundStats();
  const seed = Math.floor(Math.random() * 2 ** 31);
  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const start = nowSrv() + 3000;
    return {
      ...m,
      state: "countdown",
      scores: { red: 0, blue: 0 },
      round: { num: 1, seed, startAt: start, endsAt: start + m.settings.roundSeconds * 1000 },
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
      round: { num: m.round.num + 1, seed, startAt: start, endsAt: start + m.settings.roundSeconds * 1000 },
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
    if (isHost() && Date.now() - lowPlayersSince > 10000) {
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
  const p = me();
  $("personal-stats").textContent = p ? `🏁 ${p.crossings || 0} · 💀 ${p.deaths || 0}` : "";
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
    box.innerHTML = `<h2>Round ${meta.round.num} — get ready!</h2><div class="big-num">${n}</div><p class="hint">Arrows / WASD to hop. Top of the board = +10.</p>`;
    overlayState = "countdown";
    return;
  }
  ov.classList.remove("countdown");

  if (meta.state === "roundEnd") {
    if (overlayState !== `end${meta.round?.num}`) {
      overlayState = `end${meta.round?.num}`;
      const rows = sortedPlayers()
        .filter(([, p]) => p.connected)
        .sort((a, b) => (b[1].crossings || 0) - (a[1].crossings || 0))
        .slice(0, 5)
        .map(([, p]) => `<li>${p.team === "blue" ? "🔵" : "🔴"} ${esc(p.name)} — ${p.crossings || 0} 🏁 · ${p.deaths || 0} 💀</li>`)
        .join("");
      box.innerHTML = `
        <h2>Round ${meta.round?.num} over!</h2>
        <div class="big-score">🔴 ${meta.scores?.red || 0} — ${meta.scores?.blue || 0} 🔵</div>
        <h2>Top croakers</h2><ul>${rows || "<li>…nobody crossed 😬</li>"}</ul>`;
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
  if (dir) { e.preventDefault(); hop(dir); }
  if (e.key === " ") e.preventDefault();
});

for (const btn of document.querySelectorAll(".dpad-btn")) {
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    hop(btn.dataset.dir);
  });
}
