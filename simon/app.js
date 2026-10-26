// Simon League — everyone plays the SAME seeded sequence on their own pad,
// simultaneously. Each level a player fully completes adds 1 to their team's
// round total. The sequence is derived from meta.round.seed, so no sequence
// data ever syncs; only per-player progress {level, done, out} does.

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

const LEVEL_CAP = 20;

let roomCode = null;
let meta = null;
let players = {};
let serverOffset = 0;
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;
let emptyTeamSince = null;

// Local round state
let localRoundKey = null;
let seq = [];           // the full 20-step sequence for this round
let myLevel = 1;        // level currently being attempted
let myDone = 0;         // levels fully completed
let myOut = false;
let myCapped = false;
let spectating = false;
let inputEnabled = false;
let inputPos = 0;
let playToken = 0;      // bumping this cancels any in-flight playback/timeouts

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

const mulberry32 = (a) => function () {
  a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const genSeq = (seed) => {
  const rng = mulberry32(seed);
  return Array.from({ length: LEVEL_CAP }, () => Math.floor(rng() * 4));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      game: "simon",
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
    if (snap.val().game !== "simon") {
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
    best: existing?.best || 0,
  });
  trackPresence(db, meRef);

  onValue(metaRef(), (s) => {
    meta = s.val();
    if (!meta) return;
    if (meta.state !== "playing") { playToken++; inputEnabled = false; }
    maybeInitRound();
    render();
  });
  onValue(playersRef(), (s) => {
    players = s.val() || {};
    maybeInitRound();
    render();
  });
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

async function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  const red = conn.filter((p) => p.team === "red").length;
  const blue = conn.filter((p) => p.team === "blue").length;
  if (conn.length < 2 || !red || !blue) {
    const hint = $("start-hint");
    hint.textContent = "Need at least 2 players with someone on each team.";
    hint.classList.remove("hidden");
    return;
  }

  // Clear stale per-player state from a previous game BEFORE flipping state,
  // so a leftover simon.roundNum can't be mistaken for this game's round 1.
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/simon`] = null;
    resets[`${id}/best`] = 0;
  }
  await update(playersRef(), resets);

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    return {
      ...m,
      state: "playing",
      scores: { red: 0, blue: 0 },
      round: { num: 1, seed: Math.floor(Math.random() * 2 ** 31), startAt: nowSrv() },
    };
  });
}

function endRound() {
  const r = meta.round;
  const result = { red: 0, blue: 0 };
  for (const p of Object.values(players)) {
    if (p.simon?.roundNum === r.num) result[p.team === "blue" ? "blue" : "red"] += p.simon.done || 0;
  }
  txMeta((m) => {
    if (m.state !== "playing" || m.round?.num !== r.num) return;
    return {
      ...m,
      state: "roundEnd",
      scores: {
        red: (m.scores?.red || 0) + result.red,
        blue: (m.scores?.blue || 0) + result.blue,
      },
      round: { ...m.round, endsAt: nowSrv() + 8000, result },
    };
  });
}

function nextRound() {
  const expect = meta.round?.num;
  txMeta((m) => {
    if (m.state !== "roundEnd" || m.round?.num !== expect) return;
    if (m.round.num >= m.settings.rounds) return { ...m, state: "gameEnd" };
    return {
      ...m,
      round: { num: m.round.num + 1, seed: Math.floor(Math.random() * 2 ** 31), startAt: nowSrv() },
      state: "playing",
    };
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

// ── Per-round local init ──────────────────────────────────────────────────────
function maybeInitRound() {
  if (!meta || meta.state !== "playing" || !meta.round || !players[pid]) return;
  const r = meta.round;
  const key = `${r.num}:${r.seed}`;
  if (localRoundKey === key) return;
  localRoundKey = key;
  playToken++;
  inputEnabled = false;
  seq = genSeq(r.seed);
  myCapped = false;

  const mine = me().simon;
  if (mine?.roundNum === r.num) {
    // Rejoin mid-round: resume from synced progress.
    spectating = false;
    myLevel = mine.level || 1;
    myDone = mine.done || 0;
    myOut = !!mine.out;
    myCapped = !!mine.capped;
    if (!myOut) scheduleStart(1000);
  } else if ((me().joinedAt || 0) > (r.startAt || 0) + 4000) {
    // Joined mid-round: watch this one out.
    spectating = true;
    myOut = false;
  } else {
    spectating = false;
    myLevel = 1; myDone = 0; myOut = false;
    set(child(playersRef(), `${pid}/simon`), {
      level: 1, done: 0, out: false, roundNum: r.num, t: serverTimestamp(),
    });
    scheduleStart(1200);
  }
}

function syncSimon(extra = {}) {
  update(child(playersRef(), `${pid}/simon`), {
    level: myLevel, done: myDone, out: myOut,
    roundNum: meta.round.num, t: serverTimestamp(), ...extra,
  });
}

// ── Playback & input ──────────────────────────────────────────────────────────
function scheduleStart(delay) {
  const token = playToken;
  setTimeout(() => { if (token === playToken) playLevel(); }, delay);
}

async function playLevel() {
  if (!alive()) return;
  const token = ++playToken + 0; // claim a fresh token for this playback
  inputEnabled = false;
  setStatus(`👀 Watch — level ${myLevel}`);
  renderPadArea();
  const stepMs = Math.max(220, 600 - myLevel * 18);
  await sleep(600);
  for (let i = 0; i < myLevel; i++) {
    if (token !== playToken || !alive()) return;
    litPad(seq[i], stepMs * 0.62);
    tone(seq[i], stepMs * 0.62 / 1000);
    await sleep(stepMs);
  }
  if (token !== playToken || !alive()) return;
  inputPos = 0;
  inputEnabled = true;
  setStatus(`🎯 Your turn — ${myLevel} step${myLevel > 1 ? "s" : ""}`);
}

const alive = () =>
  meta?.state === "playing" && !myOut && !spectating &&
  localRoundKey === `${meta.round?.num}:${meta.round?.seed}`;

function pressPad(i) {
  if (!alive() || !inputEnabled) return;
  litPad(i, 170);
  tone(i, 0.18);
  if (seq[inputPos] === i) {
    inputPos++;
    if (inputPos >= myLevel) {
      // Level complete
      inputEnabled = false;
      myDone = myLevel;
      flashCenter(true);
      if (myLevel >= LEVEL_CAP) {
        myOut = true; myCapped = true;
        updateBest();
        syncSimon({ capped: true });
        render();
        return;
      }
      myLevel++;
      syncSimon();
      scheduleStart(800);
      render();
    }
  } else {
    inputEnabled = false;
    myOut = true;
    flashCenter(false);
    buzz();
    updateBest();
    syncSimon();
    render();
  }
}

function updateBest() {
  runTransaction(child(playersRef(), `${pid}/best`), (v) => Math.max(v || 0, myDone));
}

for (const b of document.querySelectorAll(".pad")) {
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    ensureAudio();
    pressPad(Number(b.dataset.pad));
  });
}
document.addEventListener("keydown", (e) => {
  if (["1", "2", "3", "4"].includes(e.key) && meta?.state === "playing") {
    ensureAudio();
    pressPad(Number(e.key) - 1);
  }
});
document.addEventListener("pointerdown", ensureAudio, { once: true });

// ── Audio ─────────────────────────────────────────────────────────────────────
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ }
  }
  if (audioCtx?.state === "suspended") audioCtx.resume();
}
const FREQS = [329.63, 277.18, 220.0, 164.81]; // E4 C#4 A3 E3 — classic Simon

function tone(padIdx, dur) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = FREQS[padIdx];
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.1, dur));
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + Math.max(0.12, dur) + 0.05);
}

function buzz() {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = "sawtooth";
  osc.frequency.value = 92;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.5);
}

// ── Pad visuals ───────────────────────────────────────────────────────────────
function litPad(i, ms) {
  const el = $(`pad-${i}`);
  el.classList.add("lit");
  setTimeout(() => el.classList.remove("lit"), ms);
}

function flashCenter(ok) {
  const c = $("pad-center");
  const cls = ok ? "flash-ok" : "flash-bad";
  c.classList.add(cls);
  setTimeout(() => c.classList.remove(cls), 600);
}

function setStatus(text) {
  $("status-line").textContent = text;
}

// ── Periodic tick: host state machine + watchdogs ────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  claimHostIfAbandoned();

  const active = meta.state === "playing" || meta.state === "roundEnd";
  const conn = Object.values(players).filter((p) => p.connected);

  // Low-players watchdog
  if (active && conn.length < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) abortToLobby();
  } else {
    lowPlayersSince = null;
  }
  // Empty-team watchdog
  const redConn = conn.some((p) => p.team === "red");
  const blueConn = conn.some((p) => p.team === "blue");
  if (active && (!redConn || !blueConn)) {
    emptyTeamSince ??= Date.now();
    if (isHost() && Date.now() - emptyTeamSince > 10000) abortToLobby();
  } else {
    emptyTeamSince = null;
  }

  if (!isHost()) return;

  if (meta.state === "playing" && meta.round) {
    const r = meta.round;
    const parts = Object.entries(players).filter(([, p]) => p.simon?.roundNum === r.num);
    // Idle watchdog: 60s with no progress → marked out so they can't stall forever.
    for (const [id, p] of parts) {
      if (p.connected && !p.simon.out && p.simon.t && nowSrv() - p.simon.t > 60000) {
        update(child(playersRef(), `${id}/simon`), { out: true });
      }
    }
    const stillIn = parts.filter(([, p]) => p.connected && !p.simon.out);
    const someoneCapped = parts.some(([, p]) => (p.simon.done || 0) >= LEVEL_CAP);
    if (parts.length && (someoneCapped || stillIn.length === 0)) endRound();
  } else if (meta.state === "roundEnd" && meta.round?.endsAt && nowSrv() > meta.round.endsAt) {
    nextRound();
  }
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
    localRoundKey = null;
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
    $("start-hint").classList.add("hidden");
  }
}

function renderGame() {
  const r = meta.round;
  $("round-info").textContent = r ? `Round ${r.num}/${meta.settings.rounds}` : "";
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;
  $("pad-level").textContent = myOut ? myDone : myLevel;
  renderStandings();
  renderPadArea();
  renderOverlay();
}

function renderPadArea() {
  const pad = $("simon-pad");
  const card = $("my-state");
  if (meta.state !== "playing") {
    pad.classList.add("dimmed");
    card.classList.add("hidden");
    return;
  }
  if (spectating) {
    pad.classList.add("dimmed");
    card.classList.remove("hidden");
    card.innerHTML = `<h2>🍿 Round in progress</h2><p class="hint">You'll be dealt in next round — enjoy the show.</p>`;
    setStatus("Spectating…");
  } else if (myOut) {
    pad.classList.add("dimmed");
    card.classList.remove("hidden");
    card.innerHTML = myCapped
      ? `<h2>🏁 Level ${LEVEL_CAP}!</h2><p class="hint">Sequence maxed. Show-off.</p>`
      : `<h2>💥 Knocked out at level ${myDone + 1}</h2><p class="hint">${myDone} level${myDone === 1 ? "" : "s"} banked for your team. 🍿 Enjoy the show.</p>`;
    setStatus(myCapped ? "🏁 Maxed out!" : `💥 Out — banked ${myDone}`);
  } else {
    pad.classList.remove("dimmed");
    card.classList.add("hidden");
    pad.classList.toggle("locked", !inputEnabled);
  }
}

function renderStandings() {
  const list = $("standings-list");
  list.innerHTML = "";
  const r = meta.round;
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected && p.simon?.roundNum !== r?.num) continue;
    const s = p.simon;
    const inRound = s?.roundNum === r?.num;
    const row = document.createElement("div");
    row.className = "stand-row";
    if (id === pid) row.classList.add("me");
    if (inRound && s.out) row.classList.add("out");
    let state;
    if (!inRound) state = "🍿";
    else if (s.capped) state = "🏁 20!";
    else if (s.out) state = `💥 out at ${(s.done || 0) + 1}`;
    else state = `lvl ${s.level || 1}`;
    const pct = inRound ? Math.min(100, ((s.done || 0) / LEVEL_CAP) * 100) : 0;
    row.innerHTML = `
      <div class="stand-label">
        <span class="pname">${esc(p.name)}${id === pid ? " (you)" : ""}</span>
        <span>${state}</span>
      </div>
      <div class="stand-bar"><div class="stand-fill ${p.team === "blue" ? "blue" : "red"}" style="width:${pct}%"></div></div>`;
    list.appendChild(row);
  }
}

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");
  if (meta.state === "roundEnd" && meta.round) {
    ov.classList.remove("hidden");
    const res = meta.round.result || { red: 0, blue: 0 };
    const rows = sortedPlayers()
      .filter(([, p]) => p.simon?.roundNum === meta.round.num)
      .sort((a, b) => (b[1].simon.done || 0) - (a[1].simon.done || 0))
      .map(([id, p]) => `<tr><td>${p.simon.capped ? "🏁" : "💥"} ${esc(p.name)}${id === pid ? " (you)" : ""}</td><td>${p.simon.done || 0}</td></tr>`)
      .join("");
    box.innerHTML = `
      <h2>Round ${meta.round.num} done!</h2>
      <div class="big-nums">🔴 +${res.red} — 🔵 +${res.blue}</div>
      <table>${rows}</table>
      <p class="hint">Totals: Red ${meta.scores?.red || 0} · Blue ${meta.scores?.blue || 0}</p>`;
  } else if (meta.state === "gameEnd") {
    ov.classList.remove("hidden");
    const red = meta.scores?.red || 0, blue = meta.scores?.blue || 0;
    const result = red === blue
      ? `<h2>🤝 It's a tie!</h2>`
      : red > blue
        ? `<h2 class="winner-red">🔴 Red Team wins!</h2>`
        : `<h2 class="winner-blue">🔵 Blue Team wins!</h2>`;
    const champ = sortedPlayers().reduce((acc, [, p]) =>
      (p.best || 0) > (acc?.best || 0) ? p : acc, null);
    box.innerHTML = `
      ${result}
      <div class="big-nums">${red} — ${blue}</div>
      ${champ?.best ? `<p>🧠 Deepest sequence: <strong>${esc(champ.name)}</strong> (level ${champ.best})</p>` : ""}
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
