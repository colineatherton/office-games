// Quiz Buzzer — static client, synced through Firebase Realtime Database.
//
// The room creator is the quizmaster (host): they see the answers, judge spoken
// answers, and drive the game. Players race to claim meta/buzz — a transaction
// resolves simultaneous buzzes atomically. Per question: 3-2-1 countdown
// ("countdown") → open buzzing ("reading") → optional answer reveal ("reveal")
// → next question, until the pack runs out ("gameEnd").

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { QUESTIONS } from "./questions.js";

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

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

const curQuestion = () =>
  meta?.qOrder != null && meta.qIdx != null ? QUESTIONS[meta.qOrder[meta.qIdx]] : null;

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
      game: "quiz",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { numQuestions: 15 },
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
    if (snap.val().game !== "quiz") {
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

  // Auto-assign to the smaller team (keep existing team on rejoin).
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

// ── State-machine transactions ────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function shuffledIndices(n) {
  const a = [...Array(n).keys()];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Fields that move the game to question `idx` (or end it).
function nextQuestionMeta(m, idx) {
  if (idx >= (m.qOrder?.length || 0)) {
    return { ...m, state: "gameEnd", buzz: null, lockedOut: null, endsAt: null };
  }
  return {
    ...m, state: "countdown", qIdx: idx,
    buzz: null, lockedOut: null,
    endsAt: nowSrv() + 3000, qStartedAt: nowSrv(),
  };
}

function startGame() {
  const nonHost = Object.entries(players)
    .filter(([id, p]) => p.connected && id !== meta.hostId);
  if (nonHost.length < 1) {
    alert("Need at least one player besides you — you're the quizmaster, you don't buzz.");
    return;
  }
  txMeta((m) => {
    if (m.state !== "lobby") return;
    const qOrder = shuffledIndices(QUESTIONS.length)
      .slice(0, Math.min(Number(m.settings.numQuestions), QUESTIONS.length));
    return {
      ...nextQuestionMeta({ ...m, qOrder }, 0),
      scores: { red: 0, blue: 0 },
    };
  });
}

function buzz() {
  if (!canBuzz()) return;
  runTransaction(child(metaRef(), "buzz"), (cur) =>
    cur === null
      ? { pid, name: me().name, team: me().team, at: serverTimestamp() }
      : undefined);
}

function canBuzz() {
  if (!meta || meta.state !== "reading" || meta.buzz || isHost()) return false;
  const p = me();
  if (!p?.connected) return false;
  if (meta.lockedOut?.[pid]) return false;
  // Joined after this question started → wait for the next one.
  if ((p.joinedAt || 0) > (meta.qStartedAt || Infinity)) return false;
  return true;
}

function markCorrect() {
  txMeta((m) => {
    if (m.state !== "reading" || !m.buzz) return;
    const scores = { ...m.scores, [m.buzz.team]: (m.scores?.[m.buzz.team] || 0) + 10 };
    return { ...nextQuestionMeta(m, (m.qIdx ?? 0) + 1), scores };
  });
}

function markWrong() {
  txMeta((m) => {
    if (m.state !== "reading" || !m.buzz) return;
    const scores = { ...m.scores, [m.buzz.team]: (m.scores?.[m.buzz.team] || 0) - 5 };
    const lockedOut = { ...(m.lockedOut || {}), [m.buzz.pid]: true };
    const anyoneLeft = Object.entries(players).some(([id, p]) =>
      p.connected && id !== m.hostId && !lockedOut[id] &&
      (p.joinedAt || 0) <= (m.qStartedAt || Infinity));
    if (!anyoneLeft) {
      return { ...m, scores, lockedOut, buzz: null, state: "reveal", endsAt: nowSrv() + 4000 };
    }
    return { ...m, scores, lockedOut, buzz: null };
  });
}

function revealAndSkip() {
  txMeta((m) => {
    if (m.state !== "reading" && m.state !== "countdown") return;
    return { ...m, buzz: null, state: "reveal", endsAt: nowSrv() + 4000 };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return {
      ...m, state: "lobby",
      qOrder: null, qIdx: null, buzz: null, lockedOut: null,
      endsAt: null, qStartedAt: null,
    };
  });
}

// ── Periodic tick: timers + host-driven transitions + watchdogs ──────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  // Watchdog: a quiz can't run with fewer than 2 connected people — return to
  // the lobby after a 10s grace (covers someone refreshing their browser).
  const active = ["countdown", "reading", "reveal"].includes(meta.state);
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => ["countdown", "reading", "reveal"].includes(m.state)
        ? { ...m, state: "lobby", qOrder: null, qIdx: null, buzz: null, lockedOut: null, endsAt: null, qStartedAt: null }
        : undefined);
    }
  } else {
    lowPlayersSince = null;
  }

  if (!isHost() || !meta.endsAt) return;
  const n = nowSrv();
  if (meta.state === "countdown" && n > meta.endsAt) {
    txMeta((m) => (m.state === "countdown" && nowSrv() > m.endsAt)
      ? { ...m, state: "reading", endsAt: null }
      : undefined);
  } else if (meta.state === "reveal" && n > meta.endsAt) {
    txMeta((m) => m.state === "reveal"
      ? nextQuestionMeta(m, (m.qIdx ?? 0) + 1)
      : undefined);
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
  let hostName = "?";
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    if (meta.hostId === id) { hostName = p.name; continue; } // quizmaster isn't on a team
    const li = document.createElement("li");
    li.textContent = p.name;
    if (id === pid) { li.classList.add("me"); li.textContent += " (you)"; }
    (lists[p.team] || lists.red).appendChild(li);
  }
  $("quizmaster-line").textContent = `🎙️ Quizmaster: ${hostName}${isHost() ? " (you)" : ""}`;
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) $("set-questions").value = String(meta.settings.numQuestions);
}

function renderGame() {
  const q = curQuestion();
  const total = meta.qOrder?.length || 0;
  $("q-info").textContent = meta.state === "gameEnd" ? "Done!" : `Q ${(meta.qIdx ?? 0) + 1}/${total}`;
  $("q-category").textContent = q?.category || "";
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;

  // Question (hidden during countdown so fast readers don't get a head start)
  $("question-text").textContent = meta.state === "reading" && q ? q.question : " ";

  // Host-only answer
  const showAnswer = isHost() && meta.state === "reading" && q;
  $("answer-box").classList.toggle("hidden", !showAnswer);
  if (showAnswer) $("answer-text").textContent = q.answer;

  // Player list with lockouts
  const pl = $("player-list");
  pl.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    const row = document.createElement("div");
    const isQm = meta.hostId === id;
    row.className = `player-row ${isQm ? "" : p.team}`;
    if (!p.connected) row.classList.add("offline");
    if (id === pid) row.classList.add("me");
    if (meta.lockedOut?.[id]) row.classList.add("locked");
    const icon = isQm ? "🎙️ " : "";
    const nameEl = document.createElement("span");
    nameEl.className = "pname";
    nameEl.textContent = `${icon}${p.name}${id === pid ? " (you)" : ""}`;
    row.appendChild(nameEl);
    pl.appendChild(row);
  }

  // Buzz banner
  const banner = $("buzz-banner");
  if (meta.state === "reading" && meta.buzz) {
    banner.className = meta.buzz.team;
    banner.textContent = meta.buzz.pid === pid
      ? "🔔 YOU buzzed — answer out loud!"
      : `🔔 ${meta.buzz.name} (${meta.buzz.team === "red" ? "Red" : "Blue"}) buzzed!`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }

  // Buzz button (players only)
  const buzzBtn = $("buzz-btn");
  const note = $("buzz-note");
  if (isHost()) {
    buzzBtn.classList.add("hidden");
    note.classList.add("hidden");
  } else {
    buzzBtn.classList.remove("hidden");
    buzzBtn.disabled = !canBuzz();
    if (meta.lockedOut?.[pid] && meta.state === "reading") {
      note.textContent = "You're locked out of this question.";
      note.classList.remove("hidden");
    } else if ((me()?.joinedAt || 0) > (meta.qStartedAt || Infinity)) {
      note.textContent = "You joined mid-question — you can buzz from the next one.";
      note.classList.remove("hidden");
    } else {
      note.classList.add("hidden");
    }
  }

  // Host controls
  $("host-controls").classList.toggle("hidden",
    !isHost() || (meta.state !== "reading" && meta.state !== "countdown"));
  const buzzed = meta.state === "reading" && !!meta.buzz;
  $("btn-correct").classList.toggle("hidden", !buzzed);
  $("btn-wrong").classList.toggle("hidden", !buzzed);

  renderOverlay();
  renderTimer();
}

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");
  const q = curQuestion();

  if (meta.state === "countdown") {
    ov.classList.remove("hidden");
    box.innerHTML = `
      <h2>${esc(q?.category || "")}</h2>
      <div class="countdown-num" id="countdown-num">3</div>
      <p class="hint">Get ready to buzz…</p>`;
    renderTimer();
  } else if (meta.state === "reveal") {
    ov.classList.remove("hidden");
    box.innerHTML = `
      <h2>The answer was</h2>
      <div class="big-word">${esc(q?.answer || "?")}</div>`;
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
      <div class="big-word">${red} — ${blue}</div>
      ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
                 : `<p class="hint">Waiting for the quizmaster…</p>`}
      <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
    box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
    box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
  } else {
    ov.classList.add("hidden");
  }
}

function renderTimer() {
  const el = $("timer");
  if (!meta?.endsAt || (meta.state !== "countdown" && meta.state !== "reveal")) {
    el.textContent = "--";
    return;
  }
  const secs = Math.max(0, Math.ceil((meta.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  if (meta.state === "countdown") {
    const num = $("countdown-num");
    if (num) num.textContent = String(Math.max(1, secs));
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── Interactions ──────────────────────────────────────────────────────────────
$("lobby-team-red").addEventListener("click", () => switchTeam("red"));
$("lobby-team-blue").addEventListener("click", () => switchTeam("blue"));
function switchTeam(team) {
  if (meta?.state !== "lobby" || isHost()) return;
  update(child(playersRef(), pid), { team });
}

$("btn-start").addEventListener("click", startGame);
$("set-questions").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { numQuestions: Number(e.target.value) }));

$("buzz-btn").addEventListener("click", buzz);
window.addEventListener("keydown", (e) => {
  // Spacebar buzzes too — but not while typing in an input.
  if (e.code === "Space" && document.activeElement?.tagName !== "INPUT" &&
      meta?.state === "reading") {
    e.preventDefault();
    buzz();
  }
});

$("btn-correct").addEventListener("click", () => { if (isHost()) markCorrect(); });
$("btn-wrong").addEventListener("click", () => { if (isHost()) markWrong(); });
$("btn-skip").addEventListener("click", () => { if (isHost()) revealAndSkip(); });

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
