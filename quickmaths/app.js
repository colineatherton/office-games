// Quick Maths — Red vs Blue speed arithmetic, synced through Firebase RTDB.
// Every player races to type the answer; the first correct submission claims
// the question in a whole-meta transaction. Wrong answers lock YOU out for 3s.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update,
  onValue, onDisconnect, runTransaction, serverTimestamp,
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
let lockedUntil = 0;     // local wrong-answer lockout
let lowPlayersSince = null;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// ── Question generator (pure; also exercised by the unit-test harness) ───────
// GEN-START
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tierFor(num, baseQ) {
  if (num <= Math.ceil(baseQ / 3)) return 1;
  if (num <= Math.ceil((2 * baseQ) / 3)) return 2;
  return 3;
}

// Returns {expr, answer}. Display operators: − × ÷. Answers are always
// non-negative integers by construction.
function genQuestion(seed, tier) {
  const rng = mulberry32(seed);
  const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  if (tier === 1) {
    const a = ri(4, 50), b = ri(4, 50);
    if (rng() < 0.5) return { expr: `${a} + ${b}`, answer: a + b };
    const [x, y] = a >= b ? [a, b] : [b, a];
    return { expr: `${x} − ${y}`, answer: x - y };
  }
  if (tier === 2) {
    const pick = rng();
    if (pick < 0.45) {
      const a = ri(3, 12), b = ri(3, 12);
      return { expr: `${a} × ${b}`, answer: a * b };
    }
    const b = ri(2, 9), c = ri(2, 9);
    if (rng() < 0.5) {
      const a = ri(10, 60);
      return { expr: `${a} + ${b} × ${c}`, answer: a + b * c };
    }
    const a = b * c + ri(1, 60);
    return { expr: `${a} − ${b} × ${c}`, answer: a - b * c };
  }
  // tier 3
  const pick = rng();
  if (pick < 0.34) {
    const a = ri(5, 30), b = ri(2, 20), c = ri(2, 9);
    if (rng() < 0.5) return { expr: `(${a} + ${b}) × ${c}`, answer: (a + b) * c };
    const [x, y] = a >= b ? [a, b] : [b, a];
    return { expr: `(${x} − ${y}) × ${c}`, answer: (x - y) * c };
  }
  if (pick < 0.67) {
    const a = ri(3, 12), b = ri(3, 12), c = ri(2, 9), d = ri(2, 9);
    const p1 = a * b, p2 = c * d;
    if (rng() < 0.5) return { expr: `${a} × ${b} + ${c} × ${d}`, answer: p1 + p2 };
    if (p1 >= p2) return { expr: `${a} × ${b} − ${c} × ${d}`, answer: p1 - p2 };
    return { expr: `${c} × ${d} − ${a} × ${b}`, answer: p2 - p1 };
  }
  const b = ri(3, 12), q = ri(3, 15), a = b * q;
  if (rng() < 0.5) return { expr: `${a} ÷ ${b}`, answer: q };
  const c = ri(2, 30);
  return { expr: `${a} ÷ ${b} + ${c}`, answer: q + c };
}
// GEN-END

function makeRound(num, baseQ, sudden) {
  const seed = Math.floor(Math.random() * 2147483647);
  const tier = sudden ? 3 : tierFor(num, baseQ);
  const q = genQuestion(seed, tier);
  return {
    num, seed, tier, sudden: !!sudden,
    expr: q.expr, answer: q.answer,
    endsAt: nowSrv() + 20000,
  };
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
      game: "quickmaths",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { questions: 20 },
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
    if (snap.val().game !== "quickmaths") {
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
    wins: existing?.wins || 0,
    streak: existing?.streak || 0,
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

// ── State machine ─────────────────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

async function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  const reds = conn.filter((p) => p.team === "red").length;
  const blues = conn.filter((p) => p.team === "blue").length;
  if (conn.length < 2 || !reds || !blues) {
    alert("Need at least 1 player on each team.");
    return;
  }
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/wins`] = 0;
    resets[`${id}/streak`] = 0;
  }
  await update(playersRef(), resets);
  await txMeta((m) => {
    if (m.state !== "lobby") return;
    return {
      ...m,
      state: "answering",
      scores: { red: 0, blue: 0 },
      suddenDeath: false,
      baseQ: m.settings.questions,
      totalQ: m.settings.questions,
      round: makeRound(1, m.settings.questions, false),
    };
  });
}

// Timeout with no winner → reveal, no points.
function timeoutQuestion() {
  const num = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "answering" || m.round?.num !== num || m.round.winner) return;
    return { ...m, state: "reveal", round: { ...m.round, endsAt: nowSrv() + 2500 } };
  });
}

function nextQuestion() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "reveal" || m.round?.num !== expect) return;
    const last = m.round.num >= m.totalQ;
    if (last) {
      if ((m.scores.red || 0) !== (m.scores.blue || 0)) return { ...m, state: "gameEnd" };
      // Tied — sudden death until one team wins a question.
      return {
        ...m,
        suddenDeath: true,
        totalQ: m.totalQ + 1,
        state: "answering",
        round: makeRound(m.round.num + 1, m.baseQ, true),
      };
    }
    return { ...m, state: "answering", round: makeRound(m.round.num + 1, m.baseQ, false) };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, suddenDeath: false };
  });
}

function abortToLobby() {
  txMeta((m) => {
    if (m.state === "lobby" || m.state === "gameEnd") return;
    return { ...m, state: "lobby", round: null, suddenDeath: false };
  });
}

// ── Answering ─────────────────────────────────────────────────────────────────
$("answer-form").addEventListener("submit", (e) => {
  e.preventDefault();
  submitAnswer();
});

function submitAnswer() {
  if (!meta || meta.state !== "answering" || !meta.round || !me()) return;
  if (Date.now() < lockedUntil) return;
  const input = $("answer-input");
  const raw = input.value.trim();
  if (!raw || !/^-?\d+$/.test(raw)) { flashShake(); return; }
  const val = parseInt(raw, 10);
  const r = meta.round;
  input.value = "";

  if (val !== r.answer) {
    lockedUntil = Date.now() + 3000;
    flashShake();
    return;
  }

  const num = r.num;
  const myTeam = me().team;
  const newStreak = (me().streak || 0) + 1;
  txMeta((m) => {
    if (m.state !== "answering" || m.round?.num !== num || m.round.winner) return;
    return {
      ...m,
      state: "reveal",
      scores: { ...m.scores, [myTeam]: (m.scores[myTeam] || 0) + 10 },
      round: {
        ...m.round,
        winner: { pid, name: me().name, team: myTeam, streak: newStreak },
        endsAt: nowSrv() + 2500,
      },
    };
  }).then((res) => {
    if (res.committed && res.snapshot.val()?.round?.winner?.pid === pid) {
      const upd = { [`${pid}/wins`]: (me().wins || 0) + 1, [`${pid}/streak`]: newStreak };
      for (const id of Object.keys(players)) if (id !== pid) upd[`${id}/streak`] = 0;
      update(playersRef(), upd);
    }
  });
}

function flashShake() {
  const form = $("answer-form");
  form.classList.remove("shake");
  void form.offsetWidth; // restart the animation
  form.classList.add("shake");
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  renderLock();
  claimHostIfAbandoned();

  // Watchdog: need 2+ players with both teams populated.
  const active = meta.state === "answering" || meta.state === "reveal";
  const conn = Object.values(players).filter((p) => p.connected);
  const teamsOk = conn.some((p) => p.team === "red") && conn.some((p) => p.team === "blue");
  if (active && (conn.length < 2 || !teamsOk)) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) abortToLobby();
  } else {
    lowPlayersSince = null;
  }

  const r = meta.round;
  if (!r?.endsAt) return;
  const n = nowSrv();
  if (meta.state === "answering" && !r.winner) {
    if (isHost() && n > r.endsAt) timeoutQuestion();
    else if (!isHost() && n > r.endsAt + 4000) timeoutQuestion(); // fallback
  } else if (meta.state === "reveal") {
    if (isHost() && n > r.endsAt) nextQuestion();
    else if (!isHost() && n > r.endsAt + 4000) nextQuestion(); // fallback
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
  if (isHost()) $("set-questions").value = String(meta.settings.questions);
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderGame() {
  const r = meta.round;
  $("q-info").textContent = r
    ? (r.sudden ? `Sudden death — Q${r.num}` : `Q ${r.num}/${meta.totalQ}`)
    : "";
  $("sd-banner").classList.toggle("hidden", !meta.suddenDeath || meta.state === "gameEnd");
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;

  const revealLine = $("reveal-line");
  if (meta.state === "answering" && r) {
    $("expr").textContent = `${r.expr} = ?`;
    revealLine.classList.add("hidden");
  } else if (meta.state === "reveal" && r) {
    $("expr").textContent = `${r.expr} = ${r.answer}`;
    const w = r.winner;
    revealLine.textContent = w
      ? `${w.name} got it! ${w.team === "red" ? "🔴" : "🔵"} +10${w.streak >= 3 ? ` · 🔥 ${w.streak} in a row!` : ""}`
      : "⏱ Nobody got it";
    revealLine.classList.toggle("hidden", false);
    revealLine.style.color = w ? "#69db7c" : "#ff8787";
  }

  const answering = meta.state === "answering" && Date.now() >= lockedUntil;
  $("answer-input").disabled = !answering;
  $("btn-answer").disabled = !answering;
  if (answering && document.activeElement !== $("answer-input")) $("answer-input").focus();

  // Player strip
  const strip = $("player-strip");
  strip.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    const chip = document.createElement("div");
    chip.className = `pchip ${p.team}`;
    if (!p.connected) chip.classList.add("offline");
    const fire = (p.streak || 0) >= 3 ? " 🔥" : "";
    chip.innerHTML = `<span>${esc(p.name)}${id === pid ? " (you)" : ""}${fire}</span><span class="wins">${p.wins || 0}</span>`;
    strip.appendChild(chip);
  }

  renderOverlay();
  renderTimer();
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || meta.state !== "answering") {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", secs <= 5);
}

function renderLock() {
  const msg = $("lock-msg");
  const left = lockedUntil - Date.now();
  if (left > 0 && meta?.state === "answering") {
    msg.textContent = `❌ Wrong — locked for ${Math.ceil(left / 1000)}s`;
    msg.classList.remove("hidden");
    $("answer-input").disabled = true;
    $("btn-answer").disabled = true;
  } else if (!msg.classList.contains("hidden")) {
    msg.classList.add("hidden");
    if (meta?.state === "answering") {
      $("answer-input").disabled = false;
      $("btn-answer").disabled = false;
      $("answer-input").focus();
    }
  }
}

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");
  if (meta.state !== "gameEnd") {
    ov.classList.add("hidden");
    return;
  }
  ov.classList.remove("hidden");
  const red = meta.scores?.red || 0, blue = meta.scores?.blue || 0;
  const result = red === blue
    ? `<h2>🤝 It's a tie!</h2>`
    : red > blue
      ? `<h2 class="winner-red">🔴 Red Team wins!</h2>`
      : `<h2 class="winner-blue">🔵 Blue Team wins!</h2>`;
  const best = Math.max(0, ...Object.values(players).map((p) => p.wins || 0));
  const minds = Object.values(players)
    .filter((p) => (p.wins || 0) === best && best > 0)
    .map((p) => esc(p.name));
  box.innerHTML = `
    ${result}
    <div class="big-word">${red} — ${blue}</div>
    ${minds.length ? `<p>🧮 Sharpest mind: <strong>${minds.join(" & ")}</strong> (${best} win${best === 1 ? "" : "s"})</p>` : ""}
    ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
               : `<p class="hint">Waiting for the host…</p>`}
    <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
  box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
  box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
}

// ── Lobby interactions ────────────────────────────────────────────────────────
$("lobby-team-red").addEventListener("click", () => switchTeam("red"));
$("lobby-team-blue").addEventListener("click", () => switchTeam("blue"));
function switchTeam(team) {
  if (meta?.state !== "lobby") return;
  update(child(playersRef(), pid), { team });
}

$("btn-start").addEventListener("click", startGame);
$("set-questions").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { questions: Number(e.target.value) }));

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
