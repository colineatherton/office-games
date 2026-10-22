// Minesweeper Duel — Red vs Blue push-your-luck on one shared board.
//
// The mine layout is never stored: it's derived from (seed, firstIdx) which are
// fixed by the first reveal's transaction (first-click-safe: the clicked cell
// and its 8 neighbours are mine-free). All reveals, scoring, turn passing and
// round-end detection happen in whole-meta transactions so simultaneous clicks
// serialize safely. Flags are cosmetic and live outside meta.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, onDisconnect, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { minesFromSeed, computeCounts, floodReveal } from "./mines.js";

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

const BOARDS = {
  small: { W: 12, H: 12, M: 25 },
  classic: { W: 16, H: 16, M: 40 },
};

let roomCode = null;
let meta = null;
let players = {};
let flags = {};
let serverOffset = 0;
let lowPlayersSince = null;
let builtBoardKey = null; // which board size the DOM grid was built for

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const flagsRef = () => ref(db, `rooms/${roomCode}/board/flags`);
const me = () => players[pid];
const myTeam = () => me()?.team;
const isHost = () => meta?.hostId === pid;
const other = (t) => (t === "red" ? "blue" : "red");
const boardDef = () => BOARDS[meta?.round?.boardKey] || BOARDS.classic;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// Mines/counts memoized per (seed, firstIdx) — same for every client.
let mineCache = { key: null, mines: null, counts: null };
function layout(r) {
  if (r?.seed == null) return null;
  const key = `${r.boardKey}:${r.seed}:${r.firstIdx}`;
  if (mineCache.key !== key) {
    const { W, H, M } = BOARDS[r.boardKey];
    const mines = minesFromSeed(r.seed, r.firstIdx, W, H, M);
    mineCache = { key, mines, counts: computeCounts(mines, W, H) };
  }
  return mineCache;
}

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
      game: "minesweeper",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { board: "classic", rounds: 3 },
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
    if (snap.val().game !== "minesweeper") {
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

  const existing = (await get(child(playersRef(), pid))).val();
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

  const meRef = child(playersRef(), pid);
  await update(meRef, {
    name, team,
    connected: true,
    joinedAt: existing?.joinedAt || serverTimestamp(),
  });
  onDisconnect(child(meRef, "connected")).set(false);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
  onValue(flagsRef(), (s) => { flags = s.val() || {}; renderBoard(); });
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

function freshRound(num, boardKey, startTeam) {
  return {
    num, boardKey, startTeam,
    turn: startTeam,
    seed: null, firstIdx: null,
    revealed: {}, exploded: {},
    cells: { red: 0, blue: 0 },
    minesHit: { red: 0, blue: 0 },
    turnStartedAt: nowSrv(),
  };
}

function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  const red = conn.filter((p) => p.team === "red").length;
  const blue = conn.filter((p) => p.team === "blue").length;
  if (!red || !blue) { $("start-hint").classList.remove("hidden"); return; }
  $("start-hint").classList.add("hidden");

  txMeta((m) => {
    if (m.state !== "lobby") return;
    const startTeam = Math.random() < 0.5 ? "red" : "blue";
    return {
      ...m,
      state: "playing",
      scores: { red: 0, blue: 0 },
      round: freshRound(1, m.settings.board, startTeam),
    };
  }).then((res) => { if (res.committed) remove(flagsRef()); });
}

// One transaction handles: first-click board generation, reveal + flood fill,
// scoring, mine hits (turn pass), and exact-once round end.
function revealCell(idx) {
  txMeta((m) => {
    if (m.state !== "playing" || !m.round) return;
    const r = m.round;
    const team = players[pid]?.team;
    if (!team || r.turn !== team) return;
    const def = BOARDS[r.boardKey];
    const key = "c" + idx;
    const revealed = r.revealed || {};
    const exploded = r.exploded || {};
    if (revealed[key] || exploded[key]) return; // no-op

    let { seed, firstIdx } = r;
    if (seed == null) {
      seed = (Math.random() * 2 ** 31) | 0;
      firstIdx = idx;
    }
    const mines = minesFromSeed(seed, firstIdx, def.W, def.H, def.M);
    const nr = {
      ...r, seed, firstIdx,
      revealed: { ...revealed }, exploded: { ...exploded },
      cells: { ...(r.cells || {}) }, minesHit: { ...(r.minesHit || {}) },
      turnStartedAt: nowSrv(),
      lastClick: { name: players[pid]?.name || "?", team, idx },
    };
    const scores = { ...m.scores };
    let state = m.state;

    if (mines.has(idx)) {
      nr.exploded[key] = team;
      nr.minesHit[team] = (nr.minesHit[team] || 0) + 1;
      scores[team] = (scores[team] || 0) - 10;
      nr.turn = other(team);
    } else {
      const counts = computeCounts(mines, def.W, def.H);
      const opened = floodReveal(idx, mines, counts, (i) => !!nr.revealed["c" + i], def.W, def.H);
      for (const i of opened) nr.revealed["c" + i] = team;
      scores[team] = (scores[team] || 0) + opened.length;
      nr.cells[team] = (nr.cells[team] || 0) + opened.length;
      if (Object.keys(nr.revealed).length >= def.W * def.H - def.M) {
        state = "roundEnd";
        nr.endsAt = nowSrv() + 8000;
      }
    }
    return { ...m, state, scores, round: nr };
  });
}

function passTurn() {
  txMeta((m) => {
    if (m.state !== "playing" || !m.round) return;
    const team = players[pid]?.team;
    if (!team || m.round.turn !== team) return;
    return { ...m, round: { ...m.round, turn: other(team), turnStartedAt: nowSrv() } };
  });
}

function forcePass() { // host watchdog for an empty team's turn
  txMeta((m) => {
    if (m.state !== "playing" || !m.round) return;
    return { ...m, round: { ...m.round, turn: other(m.round.turn), turnStartedAt: nowSrv() } };
  });
}

function nextRound() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "roundEnd" || m.round?.num !== expect) return;
    if (m.round.num >= m.settings.rounds) return { ...m, state: "gameEnd" };
    return {
      ...m,
      state: "playing",
      round: freshRound(m.round.num + 1, m.round.boardKey, other(m.round.startTeam)),
    };
  }).then((res) => { if (res.committed) remove(flagsRef()); });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null };
  }).then((res) => { if (res.committed) remove(flagsRef()); });
}

function abortToLobby() {
  txMeta((m) => {
    if (m.state === "lobby" || m.state === "gameEnd") return;
    return { ...m, state: "lobby", round: null };
  });
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  claimHostIfAbandoned();

  const active = meta.state === "playing" || meta.state === "roundEnd";
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) abortToLobby();
  } else {
    lowPlayersSince = null;
  }

  // An empty team forfeits its turn after 15s.
  if (meta.state === "playing" && meta.round && isHost()) {
    const turnTeam = meta.round.turn;
    const teamAlive = Object.values(players).some((p) => p.connected && p.team === turnTeam);
    if (!teamAlive && nowSrv() - (meta.round.turnStartedAt || 0) > 15000) {
      forcePass();
    }
  }

  if (meta.state === "roundEnd" && meta.round?.endsAt) {
    const n = nowSrv();
    if ((isHost() && n > meta.round.endsAt) || n > meta.round.endsAt + 3000) nextRound();
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
  } else {
    showScreen("game");
    renderGame();
  }
}

function renderLobby() {
  $("lobby-code").textContent = roomCode;
  const lists = { red: $("lobby-red-list"), blue: $("lobby-blue-list") };
  lists.red.innerHTML = "";
  lists.blue.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    const li = document.createElement("li");
    li.textContent = `${p.name}${meta.hostId === id ? " 👑" : ""}${id === pid ? " (you)" : ""}`;
    if (id === pid) li.classList.add("me");
    (lists[p.team] || lists.red).appendChild(li);
  }
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) {
    $("set-board").value = meta.settings.board;
    $("set-rounds").value = String(meta.settings.rounds);
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderGame() {
  const r = meta.round;
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;
  if (!r) return;
  const def = boardDef();

  $("round-info").textContent = `Round ${r.num}/${meta.settings.rounds}`;
  const flagCount = Object.keys(flags || {}).length;
  const boomCount = Object.keys(r.exploded || {}).length;
  $("mine-counter").textContent = `💣 ${Math.max(0, def.M - boomCount - flagCount)}`;
  $("last-click").textContent = r.lastClick
    ? `${r.lastClick.team === "red" ? "🔴" : "🔵"} ${r.lastClick.name} clicked last` : "";

  const banner = $("turn-banner");
  if (meta.state === "playing") {
    const mine = r.turn === myTeam();
    banner.textContent = mine
      ? `Your turn — dig in, ${me()?.name || ""}!`
      : `${r.turn === "red" ? "🔴 Red" : "🔵 Blue"} team's turn…`;
    banner.className = r.turn;
  } else {
    banner.textContent = "";
    banner.className = "";
  }

  const myGo = meta.state === "playing" && r.turn === myTeam();
  $("btn-pass").classList.toggle("hidden", !myGo);
  $("action-hint").textContent = myGo
    ? "+1 per safe square · mine = −10 and turn lost"
    : meta.state === "playing" ? "Right-click / long-press to flag" : "";

  renderBoard();
  renderOverlay();
}

function buildBoard() {
  const def = boardDef();
  const board = $("board");
  board.style.gridTemplateColumns = `repeat(${def.W}, 1fr)`;
  board.innerHTML = "";
  for (let i = 0; i < def.W * def.H; i++) {
    const b = document.createElement("button");
    b.className = "cell";
    b.dataset.idx = i;
    board.appendChild(b);
  }
  builtBoardKey = meta.round.boardKey;
}

function renderBoard() {
  const r = meta?.round;
  if (!r || meta.state === "lobby") return;
  if (builtBoardKey !== r.boardKey || $("board").children.length === 0) buildBoard();
  const def = boardDef();
  const lay = layout(r);
  const showMines = meta.state !== "playing"; // roundEnd/gameEnd: reveal leftovers
  const cells = $("board").children;
  const myGo = meta.state === "playing" && r.turn === myTeam();

  for (let i = 0; i < cells.length; i++) {
    const el = cells[i];
    const key = "c" + i;
    const openBy = r.revealed?.[key];
    const boomBy = r.exploded?.[key];
    const flagBy = flags?.[key]?.team;
    el.className = "cell";
    el.textContent = "";

    if (boomBy) {
      el.classList.add("open", "boom");
      el.textContent = "💥";
    } else if (openBy) {
      el.classList.add("open", `by-${openBy}`);
      const n = lay?.counts[i] || 0;
      if (n > 0) { el.textContent = n; el.classList.add(`n${n}`); }
    } else if (showMines && lay?.mines.has(i)) {
      el.classList.add("open", "mine-reveal");
      el.textContent = "💣";
    } else {
      if (flagBy) { el.textContent = "🚩"; el.classList.add(`flag-${flagBy}`); }
      if (!myGo) el.classList.add("locked");
    }
  }
}

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");
  const r = meta.round;

  if (meta.state === "roundEnd" && r) {
    ov.classList.remove("hidden");
    box.innerHTML = `
      <h2>Round ${r.num} swept! 🧹</h2>
      <table>
        <tr><td>🔴 Red</td><td>+${r.cells?.red || 0} squares</td><td>${r.minesHit?.red || 0} 💥</td></tr>
        <tr><td>🔵 Blue</td><td>+${r.cells?.blue || 0} squares</td><td>${r.minesHit?.blue || 0} 💥</td></tr>
      </table>
      <div class="big-score">${meta.scores?.red || 0} — ${meta.scores?.blue || 0}</div>
      <p class="hint">${r.num >= meta.settings.rounds ? "Final results coming up…" : "Next round starting…"}</p>`;
  } else if (meta.state === "gameEnd") {
    ov.classList.remove("hidden");
    const red = meta.scores?.red || 0, blue = meta.scores?.blue || 0;
    const result = red === blue
      ? `<h2>🤝 It's a tie!</h2>`
      : red > blue
        ? `<h2 class="winner-red">🔴 Red Team wins!</h2>`
        : `<h2 class="winner-blue">🔵 Blue Team wins!</h2>`;
    box.innerHTML = `
      ${result}
      <div class="big-score">${red} — ${blue}</div>
      ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
                 : `<p class="hint">Waiting for the host…</p>`}
      <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
    box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
    box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
  } else {
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
$("set-board").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { board: e.target.value }));
$("set-rounds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { rounds: Number(e.target.value) }));

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

$("btn-pass").addEventListener("click", passTurn);

// ── Board interactions (click = reveal, right-click/long-press = flag) ───────
let pressTimer = null;
let longPressed = false;

$("board").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const idx = cellIdx(e.target);
  if (idx != null) toggleFlag(idx);
});

$("board").addEventListener("pointerdown", (e) => {
  const idx = cellIdx(e.target);
  if (idx == null) return;
  longPressed = false;
  pressTimer = setTimeout(() => {
    longPressed = true;
    toggleFlag(idx);
  }, 450);
});

$("board").addEventListener("pointerup", (e) => {
  clearTimeout(pressTimer);
  if (longPressed) return;
  if (e.button !== 0) return;
  const idx = cellIdx(e.target);
  if (idx == null) return;
  handleCellClick(idx);
});
$("board").addEventListener("pointercancel", () => clearTimeout(pressTimer));
$("board").addEventListener("pointerleave", () => clearTimeout(pressTimer), true);

function cellIdx(target) {
  const el = target.closest?.(".cell");
  return el ? Number(el.dataset.idx) : null;
}

function handleCellClick(idx) {
  const r = meta?.round;
  if (!r || meta.state !== "playing") return;
  if (r.turn !== myTeam()) return;
  const key = "c" + idx;
  if (flags?.[key]) return;              // unflag before revealing (classic rule)
  if (r.revealed?.[key] || r.exploded?.[key]) return;
  revealCell(idx);
}

function toggleFlag(idx) {
  const r = meta?.round;
  if (!r || meta.state !== "playing") return;
  const key = "c" + idx;
  if (r.revealed?.[key] || r.exploded?.[key]) return;
  const fRef = child(flagsRef(), key);
  if (flags?.[key]) remove(fRef);
  else set(fRef, { team: myTeam() || "red" });
}
