// Wavelength — static client, synced through Firebase Realtime Database.
// The psychic sees a hidden target on a spectrum and gives a clue OUT LOUD;
// their teammates drag a shared dial needle to their guess. The opposing team
// can steal a point by calling which side of the needle the target lies on.
// Turn state machine: lobby → clue → guessing → counter → reveal → (clue | gameEnd).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, onValue, onDisconnect,
  runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { SPECTRUMS } from "./spectrums.js";

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
let needleLocal = 50;      // the needle value this client currently displays
let dragging = false;
let lowPlayersSince = null;
let psychicGoneSince = null;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const needleRef = () => ref(db, `rooms/${roomCode}/needle`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const isPsychic = () => meta?.turn?.psychicId === pid;
const myTeam = () => me()?.team;
const otherTeam = (t) => (t === "red" ? "blue" : "red");
// Teammate of the psychic (but not the psychic) — the people allowed to drag.
const isGuesser = () =>
  meta?.turn && myTeam() === meta.turn.team && !isPsychic();
const isOpponent = () => meta?.turn && myTeam() && myTeam() !== meta.turn.team;

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
      game: "wavelength",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { targetPoints: 10 },
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
    if (snap.val().game !== "wavelength") {
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

  const meRefNode = child(playersRef(), pid);
  const existing = (await get(meRefNode)).val();
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
  await update(meRefNode, {
    name, team,
    connected: true,
    joinedAt: existing?.joinedAt || serverTimestamp(),
    timesPsychic: existing?.timesPsychic || 0,
  });
  onDisconnect(child(meRefNode, "connected")).set(false);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
  onValue(needleRef(), (s) => {
    const n = s.val();
    if (n && typeof n.v === "number" && !dragging && meta?.state === "guessing") {
      needleLocal = n.v;
      renderNeedle();
    }
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

function pickPsychic(team) {
  const pool = Object.entries(players)
    .filter(([, p]) => p.connected && p.team === team)
    .sort((a, b) =>
      (a[1].timesPsychic || 0) - (b[1].timesPsychic || 0) ||
      (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  return pool[0]?.[0] || null;
}

function pickSpectrum(used = {}) {
  let avail = SPECTRUMS.map((_, i) => i).filter((i) => !used["s" + i]);
  if (!avail.length) { used = {}; avail = SPECTRUMS.map((_, i) => i); }
  const idx = avail[Math.floor(Math.random() * avail.length)];
  return { idx, used: { ...used, ["s" + idx]: true } };
}

// Builds the next turn object, or null if the team has nobody connected.
function buildTurn(m, team) {
  const psychicId = pickPsychic(team);
  if (!psychicId) return null;
  const { idx, used } = pickSpectrum(m.usedSpectrums);
  return {
    used,
    turn: {
      num: (m.turn?.num || 0) + 1,
      team,
      psychicId,
      spectrumIdx: idx,
      target: 8 + Math.floor(Math.random() * 85), // 8..92 so bands fit sensibly
    },
  };
}

async function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  const reds = conn.filter((p) => p.team === "red").length;
  const blues = conn.filter((p) => p.team === "blue").length;
  if (!reds || !blues) {
    const hint = $("start-hint");
    hint.textContent = "Both teams need at least one player.";
    hint.classList.remove("hidden");
    return;
  }
  const res = await txMeta((m) => {
    if (m.state !== "lobby") return;
    const startTeam = Math.random() < 0.5 ? "red" : "blue";
    const built = buildTurn({ ...m, turn: null }, startTeam);
    if (!built) return;
    return {
      ...m,
      state: "clue",
      scores: { red: 0, blue: 0 },
      usedSpectrums: built.used,
      turn: built.turn,
    };
  });
  if (res.committed) set(needleRef(), { v: 50 });
}

function clueGiven() {
  const text = $("clue-input").value.trim().slice(0, 40);
  txMeta((m) => {
    if (m.state !== "clue" || m.turn?.psychicId !== pid) return;
    return {
      ...m,
      state: "guessing",
      turn: { ...m.turn, clueText: text || null, endsAt: nowSrv() + 90000 },
    };
  }).then((res) => {
    if (res.committed && res.snapshot.val()?.state === "guessing") {
      runTransaction(ref(db, `rooms/${roomCode}/players/${pid}/timesPsychic`), (v) => (v || 0) + 1);
    }
  });
}
$("btn-clue-given").addEventListener("click", clueGiven);

function lockNeedle(value) {
  const expect = meta?.turn?.num;
  txMeta((m) => {
    if (m.state !== "guessing" || m.turn?.num !== expect) return;
    return {
      ...m,
      state: "counter",
      turn: { ...m.turn, needle: Math.round(value), endsAt: nowSrv() + 30000 },
    };
  });
}
$("btn-lock").addEventListener("click", () => { if (isGuesser()) lockNeedle(needleLocal); });

// side: "left" | "right" | null (null = no call, no steal chance)
function resolveCounter(side) {
  const expect = meta?.turn?.num;
  txMeta((m) => {
    if (m.state !== "counter" || m.turn?.num !== expect) return;
    const t = m.turn;
    const diff = Math.abs(t.target - t.needle);
    const pts = diff <= 4 ? 4 : diff <= 9 ? 3 : diff <= 15 ? 2 : 0;
    let steal = 0;
    if (side && pts < 4) {
      const correct = t.target < t.needle ? "left" : t.target > t.needle ? "right" : null;
      if (correct && side === correct) steal = 1;
    }
    const scores = { ...m.scores };
    scores[t.team] = (scores[t.team] || 0) + pts;
    scores[otherTeam(t.team)] = (scores[otherTeam(t.team)] || 0) + steal;
    return {
      ...m,
      state: "reveal",
      scores,
      turn: { ...t, counterSide: side || null, result: { pts, steal }, endsAt: nowSrv() + 8000 },
    };
  });
}
$("btn-side-left").addEventListener("click", () => { if (isOpponent()) resolveCounter("left"); });
$("btn-side-right").addEventListener("click", () => { if (isOpponent()) resolveCounter("right"); });

function advanceFromReveal() {
  const expect = meta?.turn?.num;
  txMeta((m) => {
    if (m.state !== "reveal" || m.turn?.num !== expect) return;
    const target = m.settings?.targetPoints || 10;
    if ((m.scores?.red || 0) >= target || (m.scores?.blue || 0) >= target) {
      return { ...m, state: "gameEnd" };
    }
    const built = buildTurn(m, otherTeam(m.turn.team));
    if (!built) return { ...m, state: "gameEnd" };
    return { ...m, state: "clue", usedSpectrums: built.used, turn: built.turn };
  }).then((res) => {
    if (res.committed && res.snapshot.val()?.state === "clue") {
      set(needleRef(), { v: 50 });
      needleLocal = 50;
      $("clue-input").value = "";
    }
  });
}

// The psychic vanished — skip to the other team's turn, no points.
function skipTurn() {
  const expect = meta?.turn?.num;
  txMeta((m) => {
    if ((m.state !== "clue" && m.state !== "guessing") || m.turn?.num !== expect) return;
    const built = buildTurn(m, otherTeam(m.turn.team));
    if (!built) return;
    return { ...m, state: "clue", usedSpectrums: built.used, turn: built.turn };
  }).then((res) => {
    if (res.committed) { set(needleRef(), { v: 50 }); needleLocal = 50; }
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", turn: null, usedSpectrums: null };
  });
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = ["clue", "guessing", "counter", "reveal"].includes(meta.state);
  const conn = Object.values(players).filter((p) => p.connected);
  const emptyTeam = !conn.some((p) => p.team === "red") || !conn.some((p) => p.team === "blue");
  if (active && (conn.length < 2 || emptyTeam)) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) {
      txMeta((m) => (m.state === "lobby" || m.state === "gameEnd") ? undefined
        : { ...m, state: "lobby", turn: null, usedSpectrums: null });
    }
  } else {
    lowPlayersSince = null;
  }

  // Psychic disconnected mid-clue/guess → host skips the turn after 5s.
  if ((meta.state === "clue" || meta.state === "guessing") &&
      isHost() && meta.turn && !players[meta.turn.psychicId]?.connected) {
    psychicGoneSince ??= Date.now();
    if (Date.now() - psychicGoneSince > 5000) { psychicGoneSince = null; skipTurn(); }
  } else {
    psychicGoneSince = null;
  }

  const t = meta.turn;
  if (!t?.endsAt) return;
  const n = nowSrv();
  if (meta.state === "guessing" && n > t.endsAt) {
    // Auto-lock wherever the needle is: eligible teammate first, host as fallback.
    if (isGuesser() || (isHost() && n > t.endsAt + 2000)) lockNeedle(needleLocal);
  } else if (meta.state === "counter" && n > t.endsAt) {
    if (isOpponent() || (isHost() && n > t.endsAt + 2000)) resolveCounter(null);
  } else if (meta.state === "reveal" && n > t.endsAt) {
    if (isHost() || isPsychic()) advanceFromReveal();
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
    $("set-target").value = String(meta.settings.targetPoints);
    $("start-hint").classList.add("hidden");
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderGame() {
  const t = meta.turn;
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;

  // Turn banner
  const banner = $("turn-banner");
  banner.classList.remove("red-turn", "blue-turn");
  if (meta.state === "gameEnd") {
    banner.textContent = "Game over!";
  } else if (t) {
    banner.classList.add(t.team === "red" ? "red-turn" : "blue-turn");
    const psychicName = players[t.psychicId]?.name || "?";
    banner.textContent = `${t.team === "red" ? "🔴 Red" : "🔵 Blue"} turn — 🔮 ${psychicName}`;
  }

  // Spectrum card
  const spec = t ? SPECTRUMS[t.spectrumIdx] : null;
  $("pole-left-label").textContent = spec ? `⬅️ ${spec[0]}` : "?";
  $("pole-right-label").textContent = spec ? `${spec[1]} ➡️` : "?";
  $("svg-pole-left").textContent = spec ? spec[0] : "";
  $("svg-pole-right").textContent = spec ? spec[1] : "";

  // Clue chip
  const clue = $("clue-display");
  if (t?.clueText && meta.state !== "clue") {
    clue.textContent = `💬 "${t.clueText}"`;
    clue.classList.remove("hidden");
  } else {
    clue.classList.add("hidden");
  }

  // Controls per state
  $("controls-clue").classList.toggle("hidden", !(meta.state === "clue" && isPsychic()));
  $("controls-guess").classList.toggle("hidden", !(meta.state === "guessing" && isGuesser()));
  $("controls-counter").classList.toggle("hidden", !(meta.state === "counter" && isOpponent()));

  // Status line
  const status = $("status-line");
  const pn = t ? esc(players[t.psychicId]?.name || "?") : "";
  if (meta.state === "clue") {
    status.innerHTML = isPsychic()
      ? "You're the psychic! 🔮 Study the target, give your clue <strong>out loud</strong>, then start the guess."
      : `<strong>${pn}</strong> is studying the spectrum… clue incoming on the call.`;
  } else if (meta.state === "guessing") {
    status.innerHTML = isGuesser()
      ? "Drag the needle to where the clue lives. Argue first, lock in together."
      : isPsychic()
        ? "Poker face 🃏 — watch them wander."
        : "Their team is guessing… start planning your steal.";
  } else if (meta.state === "counter") {
    status.innerHTML = isOpponent()
      ? "Call it: is the real target LEFT or RIGHT of their needle?"
      : "The other team is calling which side you missed on…";
  } else if (meta.state === "reveal" && t?.result) {
    const stealTxt = t.result.steal ? ` · steal! +1 ${otherTeam(t.team)}` : "";
    status.innerHTML = `<strong>${t.result.pts} point${t.result.pts === 1 ? "" : "s"}</strong> for ${t.team}${stealTxt}`;
  } else {
    status.innerHTML = "&nbsp;";
  }

  // Needle value source: live during guessing, frozen after lock.
  if ((meta.state === "counter" || meta.state === "reveal") && typeof t?.needle === "number") {
    needleLocal = t.needle;
  } else if (meta.state === "clue") {
    needleLocal = 50;
  }

  renderDial();
  renderPlayerStrip();
  renderOverlay();
  renderTimer();
}

function renderPlayerStrip() {
  const strip = $("player-strip");
  strip.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    const chip = document.createElement("span");
    chip.className = `pchip ${p.team}`;
    if (!p.connected) chip.classList.add("offline");
    if (meta.turn?.psychicId === id && meta.state !== "gameEnd") chip.classList.add("psychic");
    chip.textContent = `${meta.turn?.psychicId === id ? "🔮 " : ""}${p.name}${id === pid ? " (you)" : ""}`;
    strip.appendChild(chip);
  }
}

function renderTimer() {
  const el = $("timer-chip");
  const t = meta?.turn;
  const timed = meta && ["guessing", "counter"].includes(meta.state) && t?.endsAt;
  el.classList.toggle("hidden", !timed);
  if (!timed) return;
  const secs = Math.max(0, Math.ceil((t.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", secs <= 10);
}

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");
  if (meta.state !== "gameEnd") { ov.classList.add("hidden"); return; }
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
    <p class="hint">Telepathy: confirmed (one team only).</p>
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
$("set-target").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { targetPoints: Number(e.target.value) }));

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

// ── Dial geometry & rendering ─────────────────────────────────────────────────
const dial = $("dial");
const CX = 300, CY = 310, R_OUT = 240;

// value 0..100 → point on an arc of radius rad (0 = left pole, 100 = right pole)
function dialPoint(v, rad) {
  const th = Math.PI * (1 - v / 100);
  return [CX + rad * Math.cos(th), CY - rad * Math.sin(th)];
}

function sectorPath(a, b, rad) {
  a = Math.max(0, Math.min(100, a));
  b = Math.max(0, Math.min(100, b));
  const [x1, y1] = dialPoint(a, rad);
  const [x2, y2] = dialPoint(b, rad);
  return `M ${CX} ${CY} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${rad} ${rad} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`;
}

// The target wedge renders ONLY for the psychic pre-reveal, and for everyone
// at reveal/gameEnd — never to guessers or opponents mid-turn.
function canSeeTarget() {
  if (!meta?.turn) return false;
  if (meta.state === "reveal" || meta.state === "gameEnd") return true;
  return isPsychic() && (meta.state === "clue" || meta.state === "guessing" || meta.state === "counter");
}

function renderDial() {
  const wedges = $("wedges");
  const t = meta?.turn;
  if (t && canSeeTarget()) {
    // Literal colors — CSS var() doesn't resolve in generated SVG attributes.
    const bands = [
      { w: 15, color: "#1098ad", label: "2" },
      { w: 9, color: "#74b816", label: "3" },
      { w: 4, color: "#f59f00", label: "4" },
    ];
    wedges.innerHTML = bands.map((b) =>
      `<path d="${sectorPath(t.target - b.w, t.target + b.w, R_OUT)}" fill="${b.color}" opacity="0.9"/>`
    ).join("") +
      // the little point-value labels along the target
      `<text x="${dialPoint(t.target, 180)[0].toFixed(0)}" y="${dialPoint(t.target, 180)[1].toFixed(0)}"
             fill="#1a1500" font-size="22" font-weight="800" text-anchor="middle">4</text>`;
    wedges.style.opacity = "1";
  } else {
    wedges.innerHTML = "";
  }
  renderNeedle();
  dial.classList.toggle("draggable", meta?.state === "guessing" && isGuesser());
}

function renderNeedle() {
  const show = meta && meta.state !== "clue" || isPsychic();
  const [x, y] = dialPoint(needleLocal, 230);
  const line = $("needle-line");
  line.setAttribute("x2", x.toFixed(1));
  line.setAttribute("y2", y.toFixed(1));
  $("needle-group").style.opacity = show ? "1" : "0.25";
}

// ── Needle dragging & sync ────────────────────────────────────────────────────
let lastNeedleWrite = 0;
let needleWriteTimer = null;

function valueFromEvent(e) {
  const r = dial.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width * 600;
  const y = (e.clientY - r.top) / r.height * 340;
  const dx = x - CX, dy = CY - y;
  let th = Math.atan2(Math.max(dy, 0.0001), dx);
  th = Math.max(0, Math.min(Math.PI, th));
  return Math.round((1 - th / Math.PI) * 100);
}

function pushNeedle(final) {
  const now = performance.now();
  const write = () => {
    lastNeedleWrite = performance.now();
    set(needleRef(), { v: needleLocal, by: pid, t: serverTimestamp() });
  };
  if (final || now - lastNeedleWrite > 100) {
    clearTimeout(needleWriteTimer);
    write();
  } else {
    clearTimeout(needleWriteTimer);
    needleWriteTimer = setTimeout(write, 110);
  }
}

dial.addEventListener("pointerdown", (e) => {
  if (!(meta?.state === "guessing" && isGuesser())) return;
  e.preventDefault();
  dial.setPointerCapture(e.pointerId);
  dragging = true;
  dial.classList.add("dragging");
  needleLocal = valueFromEvent(e);
  renderNeedle();
  pushNeedle(false);
});

dial.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  e.preventDefault();
  needleLocal = valueFromEvent(e);
  renderNeedle();
  pushNeedle(false);
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  dial.classList.remove("dragging");
  pushNeedle(true);
}
dial.addEventListener("pointerup", endDrag);
dial.addEventListener("pointercancel", endDrag);
