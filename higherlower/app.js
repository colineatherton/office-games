// Higher or Lower — streak-and-bank comparisons, Red vs Blue.
// Teams alternate turns; any teammate answers; correct answers build a streak
// that the team can bank for points or push on and risk. All state transitions
// run through whole-meta transactions so simultaneous clicks serialize.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update,
  onValue, onDisconnect, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { POOLS } from "./data.js";

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
let teamGoneSince = null;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const myTurn = () => meta?.state === "playing" && me()?.team === meta.turn?.team;
const otherTeam = (t) => (t === "red" ? "blue" : "red");

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

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
      game: "higherlower",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { target: 15 },
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
    if (snap.val().game !== "higherlower") {
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
  onDisconnect(child(meRef, "connected")).set(false);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; if (meta) render(); });
}

function leaveRoom() {
  if (roomCode) set(ref(db, `rooms/${roomCode}/players/${pid}/connected`), false);
  location.hash = "";
  location.reload();
}
$("btn-leave-lobby").addEventListener("click", leaveRoom);

// ── Question generation ───────────────────────────────────────────────────────
// Pairs only compare within one pool and must be well separated (>20% apart,
// or ≥15 years for events) so the answer is never a coin flip over sources.
const pairKey = (pool, a, b) => `${pool}:${[a.n, b.n].sort().join("|")}`.replace(/[.#$/\[\]]/g, "_");

function separated(pool, a, b) {
  if (pool === "year") return Math.abs(a.v - b.v) >= 15;
  const hi = Math.max(a.v, b.v), lo = Math.min(a.v, b.v);
  return lo > 0 && hi / lo >= 1.2;
}

function genQuestion(used) {
  const poolNames = Object.keys(POOLS).sort(() => Math.random() - 0.5);
  for (const dropUsed of [false, true]) {
    for (const poolName of poolNames) {
      const items = POOLS[poolName].items;
      for (let i = 0; i < 90; i++) {
        const a = items[Math.floor(Math.random() * items.length)];
        const b = items[Math.floor(Math.random() * items.length)];
        if (a.n === b.n || !separated(poolName, a, b)) continue;
        const key = pairKey(poolName, a, b);
        if (!dropUsed && used[key]) continue;
        return {
          q: {
            pool: poolName,
            prompt: POOLS[poolName].prompt,
            unit: POOLS[poolName].unit,
            pick: POOLS[poolName].pick,
            a: { n: a.n, v: a.v },
            b: { n: b.n, v: b.v },
          },
          used: { ...used, [key]: true },
        };
      }
    }
  }
  return null; // unreachable in practice
}

const correctSide = (t) =>
  t.pick === "smaller" ? (t.a.v < t.b.v ? "a" : "b") : (t.a.v > t.b.v ? "a" : "b");

function newTurnPatch(m, team, streak) {
  const gen = genQuestion(m.usedPairs || {});
  if (!gen) return null;
  return {
    usedPairs: gen.used,
    turn: {
      ...gen.q,
      team, streak,
      phase: "question",
      seq: (m.turn?.seq || 0) + 1,
      picked: null, pickedBy: null, endsAt: null,
    },
  };
}

// ── State-machine transactions ────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  const red = conn.filter((p) => p.team === "red").length;
  const blue = conn.filter((p) => p.team === "blue").length;
  if (!red || !blue) { $("start-hint").classList.remove("hidden"); return; }
  txMeta((m) => {
    if (m.state !== "lobby") return;
    const patch = newTurnPatch({ ...m, usedPairs: {} }, Math.random() < 0.5 ? "red" : "blue", 0);
    if (!patch) return;
    return { ...m, state: "playing", scores: { red: 0, blue: 0 }, winner: null, ...patch };
  });
}

function answer(side) {
  if (!myTurn() || meta.turn.phase !== "question") return;
  const seq = meta.turn.seq;
  txMeta((m) => {
    if (m.state !== "playing" || m.turn?.phase !== "question" || m.turn.seq !== seq) return;
    if (players[pid]?.team !== m.turn.team) return;
    const right = side === correctSide(m.turn);
    return {
      ...m,
      turn: {
        ...m.turn,
        phase: right ? "decide" : "wrong",
        streak: right ? m.turn.streak + 1 : m.turn.streak,
        picked: side,
        pickedBy: me()?.name || "?",
        endsAt: nowSrv() + (right ? 30000 : 4500),
      },
    };
  });
}

function bank() {
  if (!meta || meta.turn?.phase !== "decide") return;
  const seq = meta.turn.seq;
  txMeta((m) => {
    if (m.state !== "playing" || m.turn?.phase !== "decide" || m.turn.seq !== seq) return;
    const team = m.turn.team;
    const scores = { ...m.scores, [team]: (m.scores[team] || 0) + m.turn.streak };
    if (scores[team] >= m.settings.target) {
      return { ...m, scores, state: "gameEnd", winner: team };
    }
    const patch = newTurnPatch(m, otherTeam(team), 0);
    if (!patch) return { ...m, scores, state: "gameEnd", winner: scores.red === scores.blue ? null : (scores.red > scores.blue ? "red" : "blue") };
    return { ...m, scores, ...patch };
  });
}

function pushOn() {
  if (!meta || meta.turn?.phase !== "decide") return;
  const seq = meta.turn.seq;
  txMeta((m) => {
    if (m.state !== "playing" || m.turn?.phase !== "decide" || m.turn.seq !== seq) return;
    const patch = newTurnPatch(m, m.turn.team, m.turn.streak);
    if (!patch) return;
    return { ...m, ...patch };
  });
}

function passTurn(reason) {
  const seq = meta?.turn?.seq;
  txMeta((m) => {
    if (m.state !== "playing" || m.turn?.seq !== seq) return;
    const patch = newTurnPatch(m, otherTeam(m.turn.team), 0);
    if (!patch) return;
    return { ...m, ...patch };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", turn: null, usedPairs: null, winner: null };
  });
}

// ── Periodic tick: timers + fallbacks ─────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  claimHostIfAbandoned();
  renderCountdown();

  if (meta.state !== "playing") { lowPlayersSince = null; teamGoneSince = null; return; }
  const n = nowSrv();

  // Too few players → lobby after 10s grace.
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (connCount < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) {
      txMeta((m) => (m.state === "playing" ? { ...m, state: "lobby", turn: null, usedPairs: null } : undefined));
      return;
    }
  } else lowPlayersSince = null;

  // Turn team has nobody connected → auto-pass after 15s (streak is lost).
  const turnTeamAlive = Object.values(players).some((p) => p.connected && p.team === meta.turn?.team);
  if (!turnTeamAlive) {
    teamGoneSince ??= Date.now();
    if (isHost() && Date.now() - teamGoneSince > 15000) { teamGoneSince = null; passTurn("team gone"); }
  } else teamGoneSince = null;

  // Phase timers (host drives).
  if (!isHost() || !meta.turn?.endsAt || n <= meta.turn.endsAt) return;
  if (meta.turn.phase === "wrong") passTurn("wrong timeout");
  else if (meta.turn.phase === "decide") bank(); // kind default: auto-bank the streak
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
    li.textContent = `${p.name}${meta.hostId === id ? " 👑" : ""}`;
    if (id === pid) { li.classList.add("me"); li.textContent += " (you)"; }
    (lists[p.team] || lists.red).appendChild(li);
  }
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) {
    $("set-target").value = String(meta.settings.target);
    const conn = Object.values(players).filter((p) => p.connected);
    const ok = conn.some((p) => p.team === "red") && conn.some((p) => p.team === "blue");
    $("start-hint").classList.toggle("hidden", ok);
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

const fmt = (v, unit, pool) =>
  pool === "year" ? String(v) : `${v.toLocaleString("en-GB")} ${unit}`;

function renderGame() {
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;
  $("target-display").textContent = `first to ${meta.settings.target}`;

  if (meta.state === "gameEnd") { renderEndOverlay(); return; }
  $("overlay").classList.add("hidden");

  const t = meta.turn;
  if (!t) return;

  const banner = $("turn-banner");
  banner.textContent = `${t.team === "red" ? "🔴 Red" : "🔵 Blue"} Team's turn`;
  banner.className = t.team;

  $("streak-display").textContent = `🔥 Streak: ${t.streak}`;
  const tension = $("tension-line");
  const spectating = !myTurn();
  tension.classList.toggle("hidden", !(spectating && t.streak >= 2));
  tension.textContent = t.streak >= 4 ? `they're on a streak of ${t.streak} 😱` : `they're on a streak of ${t.streak} 😬`;

  $("question-text").textContent = t.prompt;

  const revealed = t.phase !== "question";
  const right = revealed ? correctSide(t) : null;
  for (const side of ["a", "b"]) {
    const card = $(`card-${side}`);
    card.querySelector(".fact-name").textContent = t[side].n;
    const val = card.querySelector(".fact-value");
    val.classList.toggle("hidden", !revealed);
    if (revealed) val.textContent = fmt(t[side].v, t.unit, t.pool);
    card.classList.toggle("correct", revealed && side === right);
    card.classList.toggle("wrong-pick", revealed && side === t.picked && side !== right);
    card.disabled = !(t.phase === "question" && myTurn());
  }

  const verdict = $("verdict");
  if (t.phase === "decide") {
    verdict.className = "good";
    verdict.textContent = `✅ ${t.pickedBy} got it!`;
  } else if (t.phase === "wrong") {
    verdict.className = "bad";
    verdict.textContent = `❌ ${t.pickedBy} picked wrong — streak lost!`;
  }
  verdict.classList.toggle("hidden", t.phase === "question");

  const deciding = t.phase === "decide" && myTurn();
  $("decide-row").classList.toggle("hidden", !deciding);
  if (deciding) $("bank-amount").textContent = `${t.streak} point${t.streak === 1 ? "" : "s"}`;

  const note = $("wait-note");
  if (t.phase === "question" && !myTurn()) {
    note.textContent = "The other team is deliberating…";
    note.classList.remove("hidden");
  } else if (t.phase === "decide" && !myTurn()) {
    note.textContent = "They're deciding: bank it, or push their luck?";
    note.classList.remove("hidden");
  } else if (t.phase === "question" && myTurn()) {
    note.textContent = "Anyone on your team can answer — click a card!";
    note.classList.remove("hidden");
  } else {
    note.classList.add("hidden");
  }
  renderCountdown();
}

function renderCountdown() {
  const t = meta?.turn;
  if (!t || t.phase !== "decide" || !t.endsAt) return;
  const secs = Math.max(0, Math.ceil((t.endsAt - nowSrv()) / 1000));
  $("decide-countdown").textContent = secs;
}

function renderEndOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");
  ov.classList.remove("hidden");
  const red = meta.scores?.red || 0, blue = meta.scores?.blue || 0;
  const headline = meta.winner === "red"
    ? `<h2 class="winner-red">🔴 Red Team wins!</h2>`
    : meta.winner === "blue"
      ? `<h2 class="winner-blue">🔵 Blue Team wins!</h2>`
      : `<h2>🤝 It's a tie!</h2>`;
  box.innerHTML = `
    ${headline}
    <div class="big-score">${red} — ${blue}</div>
    ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
               : `<p class="hint">Waiting for the host…</p>`}
    <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
  box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
  box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
}

// ── Interactions ──────────────────────────────────────────────────────────────
$("lobby-team-red").addEventListener("click", () => switchTeam("red"));
$("lobby-team-blue").addEventListener("click", () => switchTeam("blue"));
function switchTeam(team) {
  if (meta?.state !== "lobby") return;
  update(child(playersRef(), pid), { team });
}

$("btn-start").addEventListener("click", startGame);
$("set-target").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { target: Number(e.target.value) }));

$("card-a").addEventListener("click", () => answer("a"));
$("card-b").addEventListener("click", () => answer("b"));
$("btn-bank").addEventListener("click", bank);
$("btn-push").addEventListener("click", pushOn);

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
