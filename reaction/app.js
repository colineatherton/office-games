// Reaction Duel — static client, synced through Firebase Realtime Database.
//
// Timing model: each round stores {seed, startAt}. Every client derives the same
// go-moment (and any fake-out flash) from the seed using server-offset-corrected
// time, so screens flip together. Reaction time itself is measured LOCALLY with
// performance.now() between the local green flip and the click — network latency
// can't advantage or hurt anyone. Results sync afterwards; the host's client
// scores the round exactly once inside a whole-meta transaction.

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

// Per-round local state
let localRoundNum = -1;
let goPerf = null;       // performance.now() at the moment our screen flipped green
let clicked = false;
let falseStarted = false;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// Deterministic per-round timing derived from the seed.
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function roundTiming(r) {
  const rng = mulberry32(r.seed);
  const delay = 2000 + rng() * 4000;
  const fake = rng() < 0.25;
  const fakeAt = r.startAt + delay * (0.35 + rng() * 0.35);
  return { goAt: r.startAt + delay, fake, fakeAt, fakeDur: 260 };
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
      game: "reaction",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 10 },
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
    if (snap.val().game !== "reaction") {
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

const newSeed = () => Math.floor(Math.random() * 2 ** 31);

async function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  if (conn.length < 2 || !conn.some((p) => p.team === "red") || !conn.some((p) => p.team === "blue")) {
    $("start-hint").textContent = "Need at least one player on each team.";
    $("start-hint").classList.remove("hidden");
    return;
  }
  // Clear stale results before flipping state so old clicks can't end round 1.
  const resets = {};
  for (const id of Object.keys(players)) resets[`${id}/result`] = null;
  await update(playersRef(), resets);

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    return {
      ...m,
      state: "playing",
      scores: { red: 0, blue: 0 },
      stats: null,
      round: { num: 1, seed: newSeed(), startAt: nowSrv() + 2500, createdAt: nowSrv() },
    };
  });
}

// Score the round exactly once: compute rankings from the local players snapshot
// inside the transaction (same closure pattern as the other games).
function endRound() {
  const n = meta.round?.num;
  txMeta((m) => {
    if (m.state !== "playing" || m.round?.num !== n) return;
    const entries = [];
    for (const [id, p] of Object.entries(players)) {
      const r = p.result;
      if (r && r.n === n) entries.push({ pid: id, name: p.name, team: p.team, ms: r.ms, fs: !!r.fs });
    }
    const valid = entries.filter((e) => !e.fs).sort((a, b) => a.ms - b.ms);
    const fss = entries.filter((e) => e.fs);
    const N = entries.length;
    const results = [];
    const scores = { ...(m.scores || { red: 0, blue: 0 }) };
    const stats = { ...(m.stats || {}) };
    valid.forEach((e, i) => {
      const pts = N - i;
      scores[e.team] = (scores[e.team] || 0) + pts;
      const s = stats[e.pid] || { name: e.name, pts: 0, sum: 0, n: 0 };
      stats[e.pid] = { ...s, name: e.name, pts: s.pts + pts, sum: s.sum + e.ms, n: s.n + 1 };
      results.push({ ...e, pts });
    });
    for (const e of fss) {
      const s = stats[e.pid] || { name: e.name, pts: 0, sum: 0, n: 0 };
      stats[e.pid] = { ...s, name: e.name };
      results.push({ ...e, pts: 0 });
    }
    return {
      ...m,
      state: "results",
      scores, stats,
      round: { ...m.round, results, endsAt: nowSrv() + 6000 },
    };
  });
}

function nextRound() {
  const n = meta.round?.num;
  txMeta((m) => {
    if (m.state !== "results" || m.round?.num !== n) return;
    if (n >= m.settings.rounds) return { ...m, state: "gameEnd" };
    return {
      ...m,
      state: "playing",
      round: { num: n + 1, seed: newSeed(), startAt: nowSrv() + 2500, createdAt: nowSrv() },
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, stats: null };
  });
}

// ── Reacting ──────────────────────────────────────────────────────────────────
function eligibleThisRound() {
  const p = me();
  const r = meta?.round;
  return p?.connected && r && (p.joinedAt || 0) <= (r.createdAt || Infinity);
}

function react() {
  if (meta?.state !== "playing" || !eligibleThisRound()) return;
  if (clicked || falseStarted) return;
  const r = meta.round;
  const t = nowSrv();
  if (t < r.startAt) return; // stage not armed yet — ignore
  const tm = roundTiming(r);
  if (t < tm.goAt) {
    falseStarted = true;
    set(ref(db, `rooms/${roomCode}/players/${pid}/result`), { n: r.num, ms: 999, fs: true });
  } else {
    clicked = true;
    const ms = Math.max(1, Math.round(goPerf !== null ? performance.now() - goPerf : t - tm.goAt));
    set(ref(db, `rooms/${roomCode}/players/${pid}/result`), { n: r.num, ms, fs: false });
  }
  renderStage();
}

$("stage").addEventListener("pointerdown", (e) => { e.preventDefault(); react(); });
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat) return;
  if (meta?.state !== "playing") return;
  e.preventDefault(); // keep spacebar from scrolling the page
  react();
});

// ── Stage animation loop (rAF for crisp green flips) ─────────────────────────
function stageLoop() {
  renderStage();
  requestAnimationFrame(stageLoop);
}
requestAnimationFrame(stageLoop);

function renderStage() {
  if (!meta || meta.state !== "playing" || !meta.round) return;
  const stage = $("stage");
  const text = $("stage-text");
  const sub = $("stage-sub");
  const r = meta.round;

  if (r.num !== localRoundNum) {
    localRoundNum = r.num;
    goPerf = null;
    clicked = false;
    falseStarted = false;
  }

  if (falseStarted) {
    setStage(stage, "stage-locked");
    text.textContent = "🙈 FALSE START";
    sub.textContent = "Locked out this round. Everyone knows.";
    return;
  }
  if (clicked) {
    const myMs = me()?.result?.n === r.num ? me().result.ms : null;
    setStage(stage, "stage-clicked");
    text.textContent = myMs !== null ? `${myMs} ms` : "…";
    sub.textContent = "Waiting for the stragglers…";
    return;
  }

  const t = nowSrv();
  const tm = roundTiming(r);
  if (t < r.startAt) {
    setStage(stage, "stage-neutral");
    text.textContent = `ROUND ${r.num}`;
    sub.textContent = "Get ready…";
    goPerf = null;
  } else if (t >= tm.goAt) {
    if (goPerf === null) goPerf = performance.now();
    setStage(stage, "stage-go");
    text.textContent = "CLICK!";
    sub.textContent = "";
  } else if (tm.fake && t >= tm.fakeAt && t < tm.fakeAt + tm.fakeDur) {
    setStage(stage, "stage-fake");
    text.textContent = "🟡 …";
    sub.textContent = "";
  } else {
    setStage(stage, "stage-wait");
    text.textContent = "WAIT FOR GREEN…";
    sub.textContent = "Clicking now would be very embarrassing.";
  }
}

function setStage(stage, cls) {
  if (!stage.classList.contains(cls)) {
    stage.className = "";
    stage.id = "stage";
    stage.classList.add(cls);
  }
}

// ── Periodic tick: host state machine + watchdogs ─────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  claimHostIfAbandoned();

  // Low-players / empty-team watchdog (active states only).
  const active = meta.state === "playing" || meta.state === "results";
  const conn = Object.values(players).filter((p) => p.connected);
  const bothTeams = conn.some((p) => p.team === "red") && conn.some((p) => p.team === "blue");
  if (active && (conn.length < 2 || !bothTeams)) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) {
      txMeta((m) => (m.state === "lobby" || m.state === "gameEnd") ? undefined
        : { ...m, state: "lobby", round: null, stats: null });
    }
  } else {
    lowPlayersSince = null;
  }

  if (!isHost()) return;
  const r = meta.round;
  if (meta.state === "playing" && r) {
    const tm = roundTiming(r);
    const eligible = Object.values(players).filter((p) =>
      p.connected && (p.joinedAt || 0) <= (r.createdAt || Infinity));
    const allDone = eligible.length > 0 &&
      eligible.every((p) => p.result && p.result.n === r.num);
    if (allDone || nowSrv() > tm.goAt + 3000) endRound();
  } else if (meta.state === "results" && r?.endsAt && nowSrv() > r.endsAt) {
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
    $("set-rounds").value = String(meta.settings.rounds);
    $("start-hint").classList.add("hidden");
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderGame() {
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;
  $("round-info").textContent = meta.round
    ? `Round ${meta.round.num}/${meta.settings.rounds}` : "";

  const ov = $("overlay");
  const box = $("overlay-content");

  if (meta.state === "results" && meta.round?.results) {
    ov.classList.remove("hidden");
    const tm = roundTiming(meta.round);
    const rows = meta.round.results.map((e, i) => `
      <li class="${e.team} ${e.fs ? "fs" : ""}">
        <span>${e.fs ? "🙈" : i === 0 ? "🥇" : `${i + 1}.`}</span>
        <span class="rname">${esc(e.name)}</span>
        <span class="rms">${e.fs ? "false start" : e.ms + " ms"}</span>
        <span class="rpts">+${e.pts}</span>
      </li>`).join("");
    box.innerHTML = `
      <h2>Round ${meta.round.num} results</h2>
      ${tm.fake ? `<p class="fakeout-note">…that was a fake-out round 🟡</p>` : ""}
      <ul class="result-list">${rows || "<li>Nobody clicked. Impressive, honestly.</li>"}</ul>`;
  } else if (meta.state === "gameEnd") {
    ov.classList.remove("hidden");
    const red = meta.scores?.red || 0, blue = meta.scores?.blue || 0;
    const result = red === blue ? `<h2>🤝 It's a tie!</h2>`
      : red > blue ? `<h2 class="winner-red">🔴 Red Team wins!</h2>`
      : `<h2 class="winner-blue">🔵 Blue Team wins!</h2>`;
    let crown = "";
    const stats = Object.values(meta.stats || {}).filter((s) => s.n > 0);
    if (stats.length) {
      const best = stats.reduce((a, b) => (a.sum / a.n <= b.sum / b.n ? a : b));
      crown = `<p>⚡ Fastest fingers: <strong>${esc(best.name)}</strong> (${Math.round(best.sum / best.n)} ms avg)</p>`;
    }
    box.innerHTML = `
      ${result}
      <div class="big-score">${red} — ${blue}</div>
      ${crown}
      ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
                 : `<p class="hint">Waiting for the host…</p>`}
      <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
    box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
    box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
  } else {
    ov.classList.add("hidden");
    renderStage();
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
