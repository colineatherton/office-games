// Memory Duel — one shared Concentration board, Red vs Blue, synced via Firebase RTDB.
// All flips and turn changes go through whole-meta transactions so simultaneous
// teammate clicks serialize and every client agrees on the board.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update,
  onValue, runTransaction, serverTimestamp,
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
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;
let emptyTeamSince = null;
let emptyTurnSince = null;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const myTeam = () => me()?.team;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// 80-emoji pool for card faces — distinct at a glance, no near-twins.
const EMOJI_POOL = [
  "🐶","🐱","🦁","🐸","🐼","🦊","🐷","🐵","🐧","🦉","🐍","🐢","🐬","🦈","🐙","🦀",
  "🐝","🦋","🦖","🐘","🦒","🦄","🐉","🦇","🐺","🦓","🍎","🍌","🍇","🍉","🍒","🍍",
  "🥑","🌽","🥕","🍄","🍕","🍔","🌮","🍣","🍩","🎂","🍿","☕","🧀","🥨","🚗","🚲",
  "🚂","✈️","🚀","🛸","⛵","🚁","🏰","🗽","🗼","🌋","⛺","🎡","☀️","🌙","⭐","🌈",
  "🔥","❄️","🌊","🌵","🌻","🍀","🎸","🎺","🥁","🎲","⚽","🏀","🎯","🧩","👑","💎",
];

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
      game: "memory",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { board: "6x6", rounds: 3 },
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
    if (snap.val().game !== "memory") {
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
  });
  trackPresence(db, meRef);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
}

function leaveRoom() {
  if (roomCode) set(ref(db, `rooms/${roomCode}/players/${pid}/connected`), false);
  location.hash = "";
  location.reload();
}
$("btn-leave-lobby").addEventListener("click", leaveRoom);

// ── Board building ────────────────────────────────────────────────────────────
function boardDims(setting) {
  const [c, r] = (setting || "6x6").split("x").map(Number);
  return { cols: c || 6, rows: r || 6 };
}

function buildRound(num, turn) {
  const { cols, rows } = boardDims(meta.settings.board);
  const pairCount = (cols * rows) / 2;
  const pool = [...EMOJI_POOL];
  const faces = [];
  for (let i = 0; i < pairCount; i++) {
    faces.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  const cards = [...faces, ...faces];
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return {
    num, cards, matched: {}, turn,
    flipA: -1, flipB: -1, flipEndsAt: 0,
    lastFlipper: "", turnStartedAt: nowSrv(), endsAt: 0,
  };
}

// ── State-machine transactions ────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  const red = conn.filter((p) => p.team === "red").length;
  const blue = conn.length - red;
  if (conn.length < 2 || !red || !blue) return;
  const firstTurn = Math.random() < 0.5 ? "red" : "blue";
  txMeta((m) => {
    if (m.state !== "lobby") return;
    return {
      ...m,
      state: "playing",
      scores: { red: 0, blue: 0 },
      round: buildRound(1, firstTurn),
    };
  });
}

function flipCard(idx) {
  if (!meta || meta.state !== "playing") return;
  const r = meta.round;
  if (!r || r.turn !== myTeam()) return;
  if (r.flipEndsAt && nowSrv() < r.flipEndsAt + 1500) return; // miss window showing
  txMeta((m) => {
    if (m.state !== "playing") return;
    const rd = m.round;
    if (rd.num !== r.num || rd.turn !== myTeam()) return;
    if (rd.flipEndsAt) return;                         // miss pending — no flips
    if (rd.matched?.["c" + idx]) return;               // already matched
    if (rd.flipA === idx) return;                      // same card twice

    const name = me()?.name || "?";
    if (rd.flipA === -1) {
      return { ...m, round: { ...rd, flipA: idx, lastFlipper: name } };
    }
    if (rd.flipB !== -1) return;                       // someone beat us to card 2

    // Second card: evaluate match atomically.
    if (rd.cards[rd.flipA] === rd.cards[idx]) {
      const matched = { ...(rd.matched || {}) };
      matched["c" + rd.flipA] = rd.turn;
      matched["c" + idx] = rd.turn;
      const scores = { ...m.scores, [rd.turn]: (m.scores[rd.turn] || 0) + 10 };
      const allDone = Object.keys(matched).length === rd.cards.length;
      const round = {
        ...rd, matched, flipA: -1, flipB: -1, flipEndsAt: 0,
        lastFlipper: name, turnStartedAt: nowSrv(),
        endsAt: allDone ? nowSrv() + 8000 : 0,
      };
      return { ...m, scores, round, state: allDone ? "roundEnd" : "playing" };
    }
    // Miss: show both cards until flipEndsAt, then resolveMiss passes the turn.
    return {
      ...m,
      round: { ...rd, flipB: idx, flipEndsAt: nowSrv() + 2200, lastFlipper: name },
    };
  });
}

function resolveMiss() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "playing" || m.round?.num !== expect || !m.round.flipEndsAt) return;
    return {
      ...m,
      round: {
        ...m.round,
        flipA: -1, flipB: -1, flipEndsAt: 0,
        turn: m.round.turn === "red" ? "blue" : "red",
        turnStartedAt: nowSrv(),
      },
    };
  });
}

function passTurn() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "playing" || m.round?.num !== expect || m.round.flipEndsAt) return;
    return {
      ...m,
      round: {
        ...m.round, flipA: -1, flipB: -1,
        turn: m.round.turn === "red" ? "blue" : "red",
        turnStartedAt: nowSrv(),
      },
    };
  });
}

function nextRound() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "roundEnd" || m.round?.num !== expect) return;
    if (m.round.num >= m.settings.rounds) return { ...m, state: "gameEnd" };
    const loser = (m.scores.red || 0) <= (m.scores.blue || 0) ? "red" : "blue";
    return { ...m, state: "playing", round: buildRound(m.round.num + 1, loser) };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null };
  });
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
  const n = nowSrv();
  const r = meta.round;

  if (meta.state === "playing" && r?.flipEndsAt) {
    if (isHost() && n > r.flipEndsAt) resolveMiss();
    else if (n > r.flipEndsAt + 1500) resolveMiss(); // anyone, if the host stalls
  }
  if (meta.state === "roundEnd" && r?.endsAt) {
    if (isHost() && n > r.endsAt) nextRound();
    else if (n > r.endsAt + 2000) nextRound();
  }

  const active = ["playing", "roundEnd"].includes(meta.state);
  const conn = Object.values(players).filter((p) => p.connected);
  const red = conn.filter((p) => p.team === "red").length;
  const blue = conn.length - red;

  // Watchdog: game needs 2+ players and a member on each team.
  if (active && conn.length < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) abortToLobby();
  } else lowPlayersSince = null;
  if (active && (red === 0 || blue === 0)) {
    emptyTeamSince ??= Date.now();
    if (isHost() && Date.now() - emptyTeamSince > 10000) abortToLobby();
  } else emptyTeamSince = null;

  // Watchdog: the turn team has nobody connected — pass the turn after 15s.
  if (meta.state === "playing" && r && !r.flipEndsAt) {
    const turnTeamCount = r.turn === "red" ? red : blue;
    if (turnTeamCount === 0) {
      emptyTurnSince ??= Date.now();
      if (isHost() && Date.now() - emptyTurnSince > 15000) {
        emptyTurnSince = null;
        passTurn();
      }
    } else emptyTurnSince = null;
  } else emptyTurnSince = null;
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
    const conn = Object.values(players).filter((p) => p.connected);
    const red = conn.filter((p) => p.team === "red").length;
    const blue = conn.length - red;
    const ok = conn.length >= 2 && red && blue;
    $("btn-start").disabled = !ok;
    $("start-hint").classList.toggle("hidden", ok);
    $("start-hint").textContent = "Need at least 2 players with someone on each team.";
  }
}

function renderGame() {
  const r = meta.round;
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;

  const banner = $("turn-banner");
  if (meta.state === "playing" && r) {
    const mine = r.turn === myTeam();
    banner.textContent = r.turn === "red"
      ? (mine ? "🔴 Red's turn — that's you, flip!" : "🔴 Red's turn")
      : (mine ? "🔵 Blue's turn — that's you, flip!" : "🔵 Blue's turn");
    banner.className = r.turn + (mine ? " mine" : "");
  } else {
    banner.textContent = "";
    banner.className = "";
  }

  if (r) {
    $("round-info").textContent = `Round ${r.num}/${meta.settings.rounds}`;
    const pairsLeft = (r.cards.length - Object.keys(r.matched || {}).length) / 2;
    $("pairs-left").textContent = `${pairsLeft} pair${pairsLeft === 1 ? "" : "s"} left`;
    $("last-flipper").textContent = r.lastFlipper ? `Last flip: ${r.lastFlipper}` : "";
  }

  renderBoard();
  renderOverlay();
}

let boardBuiltFor = ""; // "roundNum:cardCount" — rebuild DOM only on new rounds
function renderBoard() {
  const r = meta.round;
  const grid = $("board-grid");
  if (!r?.cards) { grid.innerHTML = ""; boardBuiltFor = ""; return; }

  const { cols, rows } = boardDims(meta.settings.board);
  const key = `${r.num}:${r.cards.length}`;
  if (boardBuiltFor !== key) {
    boardBuiltFor = key;
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.setProperty("--aspect", cols / rows);
    grid.innerHTML = "";
    r.cards.forEach((face, i) => {
      const card = document.createElement("div");
      card.className = "card";
      card.dataset.idx = i;
      card.innerHTML = `<div class="card-inner">
        <div class="card-face card-back">🎴</div>
        <div class="card-face card-front">${face}</div>
      </div>`;
      card.addEventListener("click", () => flipCard(i));
      grid.appendChild(card);
    });
  }

  const missShowing = !!r.flipEndsAt;
  const canFlip = meta.state === "playing" && r.turn === myTeam() && !missShowing;
  [...grid.children].forEach((card, i) => {
    const team = r.matched?.["c" + i];
    const up = !!team || r.flipA === i || r.flipB === i || meta.state === "roundEnd";
    card.classList.toggle("up", up);
    card.classList.toggle("matched-red", team === "red");
    card.classList.toggle("matched-blue", team === "blue");
    card.classList.toggle("miss", missShowing && (r.flipA === i || r.flipB === i));
    card.classList.toggle("noclick", !canFlip || up);
  });
}

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");
  if (meta.state === "roundEnd") {
    ov.classList.remove("hidden");
    const r = meta.round;
    const counts = { red: 0, blue: 0 };
    for (const t of Object.values(r.matched || {})) counts[t]++;
    box.innerHTML = `
      <h2>Round ${r.num} done!</h2>
      <p>🔴 ${counts.red / 2} pairs &nbsp;·&nbsp; 🔵 ${counts.blue / 2} pairs</p>
      <div class="big">${meta.scores.red || 0} — ${meta.scores.blue || 0}</div>
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
      <div class="big">${red} — ${blue}</div>
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
