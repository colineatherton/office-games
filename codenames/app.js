// Codenames — static client, synced through Firebase Realtime Database.
// Spymasters give clues OUT LOUD on the video call; the app only manages the
// board, the key, turn order, and reveals. All state lives under rooms/{CODE};
// every transition goes through a transaction so simultaneous clicks are safe.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, onValue,
   runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { CODENAMES_WORDS } from "./words.js";

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
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;

const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const other = (t) => (t === "red" ? "blue" : "red");
const isSpymaster = (id) =>
  meta?.spymasters?.red === id || meta?.spymasters?.blue === id;

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
      game: "codenames",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      spymasters: { red: null, blue: null },
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
    if (snap.val().game !== "codenames") {
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
$("btn-leave-game").addEventListener("click", leaveRoom);

// ── Board generation ──────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildBoard(used = {}) {
  let pool = CODENAMES_WORDS.filter((w) => !used[w]);
  if (pool.length < 25) { pool = [...CODENAMES_WORDS]; used = {}; }
  const words = shuffle(pool).slice(0, 25);
  const startingTeam = Math.random() < 0.5 ? "red" : "blue";
  const key = shuffle([
    ...Array(9).fill(startingTeam),
    ...Array(8).fill(other(startingTeam)),
    ...Array(7).fill("neutral"),
    "assassin",
  ]);
  const newUsed = { ...used };
  for (const w of words) newUsed[w] = true;
  return { words, key, startingTeam, used: newUsed };
}

// ── State-machine transactions ────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function canStartMessage() {
  const conn = Object.entries(players).filter(([, p]) => p.connected);
  const red = conn.filter(([, p]) => p.team === "red");
  const blue = conn.filter(([, p]) => p.team === "blue");
  const sm = meta?.spymasters || {};
  if (red.length < 2) return "Red team needs at least 2 players (spymaster + guesser).";
  if (blue.length < 2) return "Blue team needs at least 2 players (spymaster + guesser).";
  if (!red.some(([id]) => id === sm.red)) return "Red team needs a spymaster.";
  if (!blue.some(([id]) => id === sm.blue)) return "Blue team needs a spymaster.";
  return null;
}

function startGame() {
  if (canStartMessage()) return;
  txMeta((m) => {
    if (m.state !== "lobby") return;
    const b = buildBoard(m.usedWords || {});
    return {
      ...m,
      state: "playing",
      board: { words: b.words, key: b.key, startingTeam: b.startingTeam },
      usedWords: b.used,
      turn: b.startingTeam,
      revealed: null,
      winner: null,
      winBy: null,
    };
  });
}

function playAgain() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    const b = buildBoard(m.usedWords || {});
    return {
      ...m,
      state: "playing",
      board: { words: b.words, key: b.key, startingTeam: b.startingTeam },
      usedWords: b.used,
      turn: b.startingTeam,
      revealed: null,
      winner: null,
      winBy: null,
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", board: null, revealed: null, turn: null, winner: null, winBy: null };
  });
}

function revealCard(i) {
  const myTeam = me()?.team;
  if (!meta || meta.state !== "playing" || !myTeam) return;
  if (meta.turn !== myTeam || isSpymaster(pid)) return;
  if (meta.revealed?.[i]) return;

  txMeta((m) => {
    if (m.state !== "playing" || m.turn !== myTeam) return;
    if (m.revealed?.[i] || !m.board?.key) return;
    const revealed = { ...(m.revealed || {}), [i]: true };
    const kind = m.board.key[i];
    const next = { ...m, revealed };
    if (kind === "assassin") {
      return { ...next, state: "gameEnd", winner: other(myTeam), winBy: "assassin" };
    }
    const remaining = (t) => m.board.key.filter((k, j) => k === t && !revealed[j]).length;
    if (remaining("red") === 0) return { ...next, state: "gameEnd", winner: "red", winBy: "cards" };
    if (remaining("blue") === 0) return { ...next, state: "gameEnd", winner: "blue", winBy: "cards" };
    if (kind !== myTeam) next.turn = other(myTeam);
    return next;
  });
}

function endTurn() {
  const myTeam = me()?.team;
  if (!meta || meta.state !== "playing" || meta.turn !== myTeam || isSpymaster(pid)) return;
  txMeta((m) => {
    if (m.state !== "playing" || m.turn !== myTeam) return;
    return { ...m, turn: other(myTeam) };
  });
}

// Claim toggles: claim if vacant (or the holder disconnected), unclaim if it's me.
function claimSpymaster(team) {
  if (me()?.team !== team) return;
  runTransaction(child(metaRef(), `spymasters/${team}`), (cur) => {
    if (cur === pid) return null;
    if (!cur || !players[cur]?.connected) return pid;
    return undefined;
  });
}

function switchTeam(team) {
  if (meta?.state !== "lobby" || me()?.team === team) return;
  update(child(playersRef(), pid), { team });
  // Dropping the old team's spymaster claim if it was mine.
  runTransaction(child(metaRef(), `spymasters/${other(team)}`), (cur) =>
    cur === pid ? null : undefined);
}

// ── Periodic tick: watchdogs only (no timers in codenames) ───────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  claimHostIfAbandoned();

  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (meta.state === "playing" && connCount < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => m.state === "playing"
        ? { ...m, state: "lobby", board: null, revealed: null, turn: null, winner: null, winBy: null }
        : undefined);
    }
  } else {
    lowPlayersSince = null;
  }
}, 500);

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
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
  const sm = meta.spymasters || {};
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    const li = document.createElement("li");
    const badge = (sm.red === id || sm.blue === id) ? " 🕵️" : "";
    li.textContent = `${p.name}${badge}${meta.hostId === id ? " 👑" : ""}`;
    if (id === pid) { li.classList.add("me"); li.textContent += " (you)"; }
    (lists[p.team] || lists.red).appendChild(li);
  }
  for (const team of ["red", "blue"]) {
    const btn = $(`claim-${team}`);
    const mine = me()?.team === team;
    btn.classList.toggle("hidden", !mine);
    if (mine) {
      btn.textContent = sm[team] === pid ? "Unclaim spymaster ✖" : "Claim spymaster 🕵️";
      const holder = sm[team];
      btn.disabled = !!holder && holder !== pid && players[holder]?.connected;
    }
  }
  const startMsg = canStartMessage();
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) {
    $("btn-start").disabled = !!startMsg;
    $("start-hint").textContent = startMsg || "Ready to go!";
  }
}

function renderGame() {
  const b = meta.board;
  if (!b?.key) return;
  const revealed = meta.revealed || {};
  const remaining = (t) => b.key.filter((k, j) => k === t && !revealed[j]).length;
  $("count-red").textContent = remaining("red");
  $("count-blue").textContent = remaining("blue");

  const ended = meta.state === "gameEnd";
  const myTeam = me()?.team;
  const iAmSm = isSpymaster(pid);
  const myTurn = !ended && meta.turn === myTeam;
  const canGuess = myTurn && !iAmSm && !!myTeam;

  // Banner
  const title = $("banner-title");
  const sub = $("banner-sub");
  if (ended) {
    title.textContent = meta.winner === "red" ? "🔴 Red Team wins!" : "🔵 Blue Team wins!";
    title.className = meta.winner;
    sub.textContent = meta.winBy === "assassin"
      ? "💀 The other team found the assassin."
      : "All their agents were contacted.";
  } else {
    title.textContent = meta.turn === "red" ? "🔴 Red's turn" : "🔵 Blue's turn";
    title.className = meta.turn;
    if (iAmSm && myTurn) sub.textContent = "You're the spymaster — give your clue out loud! 🤫";
    else if (iAmSm) sub.textContent = "Opposing spymaster is giving a clue…";
    else if (canGuess) sub.textContent = "Your spymaster gave a clue — click a card to guess!";
    else sub.textContent = "Spymaster, give your clue out loud on the call!";
  }

  // Spymaster-vanished notice (for teammates of a disconnected spymaster)
  const notice = $("sm-notice");
  const smId = meta.spymasters?.[myTeam];
  const smGone = !ended && meta.state === "playing" && myTeam &&
    (!smId || !players[smId]?.connected);
  notice.classList.toggle("hidden", !smGone);
  if (smGone) {
    $("sm-notice-text").textContent = "🕵️ Your spymaster vanished! Someone take over:";
    $("btn-claim-mid").classList.toggle("hidden", isSpymaster(pid));
  }

  // Board
  const grid = $("board-grid");
  grid.innerHTML = "";
  b.words.forEach((word, i) => {
    const card = document.createElement("button");
    card.className = "card";
    card.innerHTML = `<span class="word">${esc(word)}</span>`;
    if (revealed[i]) {
      card.classList.add("revealed", b.key[i]);
      if (b.key[i] === "assassin") card.innerHTML = `💀 <span class="word">${esc(word)}</span>`;
    } else if (iAmSm || ended) {
      card.classList.add(`hint-${b.key[i]}`);
      card.insertAdjacentHTML("beforeend", `<span class="dot"></span>`);
      if (ended) card.classList.add("endgame-unrevealed");
    }
    if (canGuess && !revealed[i]) {
      card.classList.add("clickable");
      card.addEventListener("click", () => revealCard(i));
    }
    grid.appendChild(card);
  });

  // Action bar
  $("btn-end-turn").classList.toggle("hidden", !canGuess);
  $("btn-again").classList.toggle("hidden", !(ended && isHost()));
  $("btn-to-lobby").classList.toggle("hidden", !(ended && isHost()));
}

// ── Wiring ────────────────────────────────────────────────────────────────────
$("lobby-team-red").addEventListener("click", () => switchTeam("red"));
$("lobby-team-blue").addEventListener("click", () => switchTeam("blue"));
$("claim-red").addEventListener("click", (e) => { e.stopPropagation(); claimSpymaster("red"); });
$("claim-blue").addEventListener("click", (e) => { e.stopPropagation(); claimSpymaster("blue"); });
$("btn-start").addEventListener("click", startGame);
$("btn-end-turn").addEventListener("click", endTurn);
$("btn-again").addEventListener("click", playAgain);
$("btn-to-lobby").addEventListener("click", backToLobby);
$("btn-claim-mid").addEventListener("click", () => claimSpymaster(me()?.team));

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
