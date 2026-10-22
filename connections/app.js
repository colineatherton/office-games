// Connections — two teams race on the same 16-word puzzle, synced through
// Firebase RTDB. Each team plays its own copy of the board; all submissions go
// through whole-meta transactions so teammates can't double-submit and the
// finish bonus is awarded exactly once.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update,
  onValue, onDisconnect, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { PUZZLES } from "./puzzles.js";

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
let selection = new Set();
let displayOrder = [];      // local tile order (shuffle is local-only)
let renderedRound = -1;
let lowPlayersSince = null;
let emptyTeamSince = null;
let toastTimer = null;

const GROUP_COLORS = ["var(--g0)", "var(--g1)", "var(--g2)", "var(--g3)"];

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const myTeam = () => me()?.team || "red";
const otherTeam = (t) => (t === "red" ? "blue" : "red");
const puzzleOf = (m) => PUZZLES[m.round.puzzleIdx];

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

function groupOfWord(m, word) {
  const groups = puzzleOf(m).groups;
  for (let i = 0; i < 4; i++) if (groups[i].words.includes(word)) return i;
  return -1;
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
      game: "connections",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 3 },
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
    if (snap.val().game !== "connections") {
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

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function freshRound(num, puzzleIdx) {
  const words = PUZZLES[puzzleIdx].groups.flatMap((g) => g.words);
  return {
    num, puzzleIdx,
    order: shuffle(words),
    teams: {
      red: { strikes: 0, seq: 0 },
      blue: { strikes: 0, seq: 0 },
    },
  };
}

function teamCounts() {
  let red = 0, blue = 0;
  for (const p of Object.values(players)) {
    if (!p.connected) continue;
    p.team === "red" ? red++ : blue++;
  }
  return { red, blue };
}

function startGame() {
  const { red, blue } = teamCounts();
  if (!red || !blue) {
    $("start-hint").classList.remove("hidden");
    return;
  }
  txMeta((m) => {
    if (m.state !== "lobby") return;
    const idx = Math.floor(Math.random() * PUZZLES.length);
    return {
      ...m,
      state: "playing",
      scores: { red: 0, blue: 0 },
      usedPuzzles: { [idx]: true },
      round: freshRound(1, idx),
    };
  });
}

function nextRound() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "roundEnd" || m.round?.num !== expect) return;
    if (m.round.num >= m.settings.rounds) return { ...m, state: "gameEnd" };
    const used = { ...(m.usedPuzzles || {}) };
    const avail = PUZZLES.map((_, i) => i).filter((i) => !used[i]);
    const idx = avail.length
      ? avail[Math.floor(Math.random() * avail.length)]
      : Math.floor(Math.random() * PUZZLES.length);
    used[idx] = true;
    return { ...m, state: "playing", usedPuzzles: used, round: freshRound(m.round.num + 1, idx) };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedPuzzles: null };
  });
}

function abortToLobby() {
  txMeta((m) => {
    if (m.state === "lobby" || m.state === "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedPuzzles: null };
  });
}

// ── Submitting a group ────────────────────────────────────────────────────────
function submitSelection() {
  if (!meta || meta.state !== "playing" || selection.size !== 4) return;
  const team = myTeam();
  const expectNum = meta.round.num;
  const seqAtSubmit = meta.round.teams?.[team]?.seq || 0;
  const sel = [...selection];
  let outcome = null;

  txMeta((m) => {
    outcome = null;
    if (m.state !== "playing" || m.round?.num !== expectNum) { outcome = { type: "over" }; return; }
    const t = m.round.teams[team] || {};
    if ((t.seq || 0) !== seqAtSubmit) { outcome = { type: "stale" }; return; }
    if (t.locked) { outcome = { type: "locked" }; return; }
    const found = t.foundOrder || [];

    const counts = {};
    for (const w of sel) {
      const g = groupOfWord(m, w);
      if (g === -1 || found.includes(g)) { outcome = { type: "stale" }; return; }
      counts[g] = (counts[g] || 0) + 1;
    }

    const t2 = { ...t, seq: seqAtSubmit + 1, foundOrder: found };
    const m2 = { ...m, scores: { ...m.scores } };
    const groupIds = Object.keys(counts);

    if (groupIds.length === 1) {
      const g = Number(groupIds[0]);
      t2.foundOrder = [...found, g];
      m2.scores[team] = (m2.scores[team] || 0) + 10;
      outcome = { type: "correct", g };
      if (t2.foundOrder.length === 4) {
        m2.scores[team] += 20;
        m2.state = "roundEnd";
        outcome = { type: "finished" };
      }
    } else {
      const maxIn = Math.max(...Object.values(counts));
      t2.strikes = (t.strikes || 0) + 1;
      outcome = { type: maxIn === 3 ? "oneaway" : "wrong", strikes: t2.strikes };
      if (t2.strikes >= 4) {
        t2.locked = true;
        outcome.locked = true;
        if (m.round.teams[otherTeam(team)]?.locked) m2.state = "roundEnd";
      }
    }

    m2.round = { ...m.round, teams: { ...m.round.teams, [team]: t2 } };
    if (m2.state === "roundEnd") {
      m2.round.endsAt = nowSrv() + 8000;
      if (outcome.type === "finished") m2.round.winner = team;
    }
    return m2;
  }).then((res) => {
    if (!outcome) return;
    if (!res.committed && !["over", "stale", "locked"].includes(outcome.type)) return;
    switch (outcome.type) {
      case "correct": toast("✅ Group found! +10"); selection.clear(); break;
      case "finished": toast("🏁 Puzzle solved! +20 bonus"); selection.clear(); break;
      case "oneaway": toast("😬 One away…"); shakeSelected(); break;
      case "wrong": toast(outcome.locked ? "💥 Fourth strike — locked out!" : "❌ Nope — strike!"); shakeSelected(); break;
      case "stale": toast("A teammate just submitted — board updated"); selection.clear(); break;
      case "locked": toast("Your team is locked out this round"); break;
      case "over": toast("Round is already over"); break;
    }
    render();
  });
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
}

function shakeSelected() {
  for (const el of document.querySelectorAll(".tile.selected")) {
    el.classList.add("shake");
    setTimeout(() => el.classList.remove("shake"), 350);
  }
}

$("btn-submit").addEventListener("click", submitSelection);
$("btn-deselect").addEventListener("click", () => { selection.clear(); render(); });
$("btn-shuffle").addEventListener("click", () => { displayOrder = shuffle(displayOrder); render(); });

// ── Periodic tick: watchdogs + round advancement ─────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  claimHostIfAbandoned();

  const active = meta.state === "playing" || meta.state === "roundEnd";
  const conn = Object.values(players).filter((p) => p.connected);
  if (active && conn.length < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) abortToLobby();
  } else {
    lowPlayersSince = null;
  }
  const { red, blue } = teamCounts();
  if (meta.state === "playing" && (!red || !blue)) {
    emptyTeamSince ??= Date.now();
    if (isHost() && Date.now() - emptyTeamSince > 10000) abortToLobby();
  } else {
    emptyTeamSince = null;
  }

  if (meta.state === "roundEnd" && meta.round?.endsAt) {
    const left = Math.max(0, Math.ceil((meta.round.endsAt - nowSrv()) / 1000));
    const span = $("overlay-countdown");
    if (span) span.textContent = left;
    if (isHost() && nowSrv() > meta.round.endsAt) nextRound();
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
    renderedRound = -1;
    showScreen("lobby");
    renderLobby();
  } else {
    showScreen("game");
    renderGame();
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
    $("set-rounds").value = String(meta.settings.rounds);
    const { red, blue } = teamCounts();
    $("start-hint").classList.toggle("hidden", !!(red && blue));
  }
}

$("lobby-team-red").addEventListener("click", () => switchTeam("red"));
$("lobby-team-blue").addEventListener("click", () => switchTeam("blue"));
function switchTeam(team) {
  if (meta?.state !== "lobby") return;
  update(child(playersRef(), pid), { team });
}
$("btn-start").addEventListener("click", startGame);
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

function renderGame() {
  const r = meta.round;
  if (!r) return;

  if (r.num !== renderedRound) {
    renderedRound = r.num;
    selection.clear();
    displayOrder = [...(r.order || [])];
  }

  $("round-info").textContent = `Puzzle ${r.num}/${meta.settings.rounds}`;
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;

  const team = myTeam();
  const opp = otherTeam(team);
  const oppState = r.teams?.[opp] || {};
  const oppFound = (oppState.foundOrder || []).length;
  $("opp-chip").textContent =
    `${opp === "red" ? "🔴 Red" : "🔵 Blue"}: ${oppFound}/4 groups · ✖${oppState.strikes || 0}` +
    (oppState.locked ? " · locked out" : "");

  const t = r.teams?.[team] || {};
  const found = t.foundOrder || [];
  const foundWords = new Set(found.flatMap((g) => puzzleOf(meta).groups[g].words));

  // Found-group bars (and, if locked out, the rest of the solution dimmed)
  const fg = $("found-groups");
  fg.innerHTML = "";
  for (const g of found) fg.appendChild(groupBar(g, false));
  if (t.locked) {
    for (let g = 0; g < 4; g++) if (!found.includes(g)) fg.appendChild(groupBar(g, true));
  }

  // Board tiles
  const board = $("board");
  board.innerHTML = "";
  const playable = meta.state === "playing" && !t.locked;
  if (!t.locked) {
    for (const w of displayOrder) {
      if (foundWords.has(w)) continue;
      const tile = document.createElement("div");
      tile.className = "tile" + (selection.has(w) ? " selected" : "");
      tile.textContent = w;
      if (playable) {
        tile.addEventListener("click", () => {
          if (selection.has(w)) selection.delete(w);
          else if (selection.size < 4) selection.add(w);
          render();
        });
      }
      board.appendChild(tile);
    }
  }

  $("locked-note").classList.toggle("hidden", !t.locked);
  $("controls").classList.toggle("hidden", !!t.locked);
  $("strike-dots").textContent = "●".repeat(Math.max(0, 4 - (t.strikes || 0))) + "○".repeat(Math.min(4, t.strikes || 0));
  $("btn-submit").disabled = !(playable && selection.size === 4);

  renderOverlay();
}

function groupBar(g, dim) {
  const grp = puzzleOf(meta).groups[g];
  const div = document.createElement("div");
  div.className = "group-bar" + (dim ? " dim" : "");
  div.style.background = GROUP_COLORS[g];
  div.innerHTML = `<div class="gtitle">${esc(grp.title)}</div><div class="gwords">${grp.words.map(esc).join(", ")}</div>`;
  return div;
}

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");

  if (meta.state === "roundEnd") {
    ov.classList.remove("hidden");
    const r = meta.round;
    const head = r.winner
      ? `<h2 class="winner-${r.winner}">${r.winner === "red" ? "🔴 Red" : "🔵 Blue"} solved it! +20</h2>`
      : `<h2>💥 Both teams struck out!</h2>`;
    const bars = [0, 1, 2, 3].map((g) => groupBar(g, false).outerHTML).join("");
    box.innerHTML = `
      ${head}
      <div class="solution">${bars}</div>
      <p class="hint">🔴 ${meta.scores?.red || 0} — ${meta.scores?.blue || 0} 🔵 ·
        next puzzle in <span id="overlay-countdown">8</span>s</p>`;
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
