// Flag Zoom — a flag renders pixelated and slowly sharpens; first correct
// guess in chat wins the round for their team. Flags are drawn on canvas from
// declarative specs (see flags.js) — never emoji, which Windows can't render.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove, push,
  onValue, onChildAdded, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { FLAGS, drawFlag } from "./flags.js";

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

const GUESS_MS = 25000;
const REVEAL_MS = 5000;

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
const chatRef = () => ref(db, `rooms/${roomCode}/chat`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

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
      game: "flagzoom",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 15 },
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
    if (snap.val().game !== "flagzoom") {
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
  trackPresence(db, meRef);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
  onChildAdded(chatRef(), (s) => renderChatMsg(s.val()));
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

function pickFlag(used) {
  const free = FLAGS.map((_, i) => i).filter((i) => !used[`f${i}`]);
  const pool = free.length ? free : FLAGS.map((_, i) => i);
  return pool[Math.floor(Math.random() * pool.length)];
}

async function startGame() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < 2) { alert("Need at least 2 players to start."); return; }
  const res = await txMeta((m) => {
    if (m.state !== "lobby") return;
    const idx = pickFlag({});
    return {
      ...m,
      state: "playing",
      scores: { red: 0, blue: 0 },
      usedFlags: { [`f${idx}`]: true },
      round: { num: 1, flagIdx: idx, endsAt: nowSrv() + GUESS_MS },
    };
  });
  if (res.committed) {
    remove(chatRef());
    $("chat-log").innerHTML = "";
  }
}

function endRoundTimeout() {
  const expect = meta.round?.num;
  txMeta((m) => {
    if (m.state !== "playing" || m.round?.num !== expect || m.round.winner) return;
    return { ...m, state: "roundEnd", round: { ...m.round, endsAt: nowSrv() + REVEAL_MS } };
  });
}

function nextRound() {
  const expect = meta.round?.num;
  txMeta((m) => {
    if (m.state !== "roundEnd" || m.round?.num !== expect) return;
    if (m.round.num >= m.settings.rounds) return { ...m, state: "gameEnd" };
    const used = m.usedFlags || {};
    const idx = pickFlag(used);
    return {
      ...m,
      state: "playing",
      usedFlags: { ...used, [`f${idx}`]: true },
      round: { num: m.round.num + 1, flagIdx: idx, endsAt: nowSrv() + GUESS_MS },
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedFlags: null };
  });
}

function abortToLobby() {
  txMeta((m) => {
    if (m.state === "lobby" || m.state === "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedFlags: null };
  });
}

// ── Tick: timers + host fallbacks + watchdogs ────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = meta.state === "playing" || meta.state === "roundEnd";
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) abortToLobby();
  } else {
    lowPlayersSince = null;
  }

  const r = meta.round;
  if (!r?.endsAt || !isHost()) return;
  const n = nowSrv();
  if (meta.state === "playing" && n > r.endsAt) endRoundTimeout();
  else if (meta.state === "roundEnd" && n > r.endsAt) nextRound();
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

// ── Guessing ─────────────────────────────────────────────────────────────────
const normalize = (s) => s.toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z ]/g, "")
  .replace(/\s+/g, " ").trim();

function lev1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n] <= 1;
}

function matchesFlag(guess, flag) {
  const g = normalize(guess);
  if (!g) return false;
  const targets = [flag.name, ...(flag.aliases || [])].map(normalize);
  return targets.some((t) => (t.length >= 5 ? lev1(g, t) : g === t));
}

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text || !me() || !meta) return;
  input.value = "";

  if (meta.state === "playing" && meta.round && !meta.round.winner) {
    const flag = FLAGS[meta.round.flagIdx];
    if (flag && matchesFlag(text, flag)) {
      const team = me().team;
      const secs = Math.max(0, Math.ceil((meta.round.endsAt - nowSrv()) / 1000));
      const pts = 10 + secs;
      const expect = meta.round.num;
      txMeta((m) => {
        if (m.state !== "playing" || m.round?.num !== expect || m.round.winner) return;
        return {
          ...m,
          state: "roundEnd",
          scores: { ...m.scores, [team]: (m.scores?.[team] || 0) + pts },
          round: { ...m.round, winner: { pid, name: me().name, team, pts }, endsAt: nowSrv() + REVEAL_MS },
        };
      }).then((res) => {
        if (res.committed && res.snapshot.val()?.round?.winner?.pid === pid) {
          push(chatRef(), {
            system: true,
            text: `${me().name} got it — ${flag.name}! +${pts} for ${team === "red" ? "🔴 Red" : "🔵 Blue"}`,
            t: serverTimestamp(),
          });
        }
      });
      return;
    }
  }

  push(chatRef(), { pid, name: me().name, team: me().team, text, t: serverTimestamp() });
});

function renderChatMsg(m) {
  if (!m) return;
  const log = $("chat-log");
  const div = document.createElement("div");
  if (m.system) {
    div.className = "chat-msg system";
    div.textContent = m.text;
  } else {
    div.className = "chat-msg";
    div.innerHTML = `<span class="who ${m.team === "blue" ? "blue" : "red"}">${esc(m.name)}:</span> ${esc(m.text)}`;
  }
  log.appendChild(div);
  while (log.children.length > 250) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── Rendering ─────────────────────────────────────────────────────────────────
function render() {
  if (!meta) return;
  if (meta.state === "lobby") {
    showScreen("lobby");
    $("chat-log").innerHTML = "";
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
  if (isHost()) $("set-rounds").value = String(meta.settings.rounds);
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderGame() {
  const r = meta.round;
  $("round-info").textContent = r ? `Round ${r.num}/${meta.settings.rounds}` : "";
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;
  $("status-label").textContent =
    meta.state === "playing" ? "🔍 Which country is this?" :
    meta.state === "roundEnd" ? "Revealed!" : "Final scores";

  const pl = $("player-list");
  pl.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    const row = document.createElement("div");
    row.className = `player-row ${p.team}`;
    if (!p.connected) row.classList.add("offline");
    if (id === pid) row.classList.add("me");
    row.innerHTML = `<span class="pname">${esc(p.name)}${id === pid ? " (you)" : ""}</span>`;
    pl.appendChild(row);
  }

  renderOverlay();
  renderTimer();
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || meta.state !== "playing") {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", secs <= 7);
}

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");
  const r = meta.round;

  if (meta.state === "roundEnd" && r) {
    ov.classList.remove("hidden");
    const flag = FLAGS[r.flagIdx];
    const w = r.winner;
    box.innerHTML = `
      <h2>It was…</h2>
      <div class="big-word">${esc(flag.name)}</div>
      ${flag.note ? `<p class="hint">${esc(flag.note)}</p>` : ""}
      <canvas width="300" height="200"></canvas>
      <p>${w ? `🎉 ${esc(w.name)} +${w.pts} for ${w.team === "red" ? "🔴 Red" : "🔵 Blue"}` : "⏱️ Nobody got it!"}</p>`;
    const c = box.querySelector("canvas");
    drawFlag(c.getContext("2d"), flag.spec, c.width, c.height);
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
                 : `<p class="hint">Waiting for the host…</p>`}
      <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
    box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
    box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
  } else {
    ov.classList.add("hidden");
  }
}

// ── Lobby interactions ───────────────────────────────────────────────────────
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

// ── Canvas: progressive pixelation ───────────────────────────────────────────
const canvas = $("flag-canvas");
const ctx = canvas.getContext("2d");
const FW = canvas.width, FH = canvas.height;

// Sharp flag cached per round on an offscreen canvas.
const sharp = document.createElement("canvas");
sharp.width = FW; sharp.height = FH;
const sharpCtx = sharp.getContext("2d");
let cachedIdx = -1;

// Tiny canvas used as the pixelation intermediate.
const tiny = document.createElement("canvas");
const tinyCtx = tiny.getContext("2d");

function frame() {
  requestAnimationFrame(frame);
  if (!meta || !meta.round || meta.state === "lobby" || meta.state === "gameEnd") {
    canvas.style.filter = "none";
    ctx.fillStyle = "#0e101a";
    ctx.fillRect(0, 0, FW, FH);
    return;
  }
  const r = meta.round;
  if (r.flagIdx !== cachedIdx) {
    cachedIdx = r.flagIdx;
    sharpCtx.clearRect(0, 0, FW, FH);
    drawFlag(sharpCtx, FLAGS[r.flagIdx].spec, FW, FH);
  }

  if (meta.state === "roundEnd") {
    canvas.style.filter = "none";
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sharp, 0, 0);
    return;
  }

  // progress 0 → 1 across the guessing window
  const p = Math.min(1, Math.max(0, (GUESS_MS - (r.endsAt - nowSrv())) / GUESS_MS));
  // resolution eases from a 6px-wide mosaic to near-sharp
  const res = Math.round(6 + (160 - 6) * Math.pow(p, 1.7));
  tiny.width = res;
  tiny.height = Math.max(2, Math.round(res * FH / FW));
  tinyCtx.imageSmoothingEnabled = true;
  tinyCtx.drawImage(sharp, 0, 0, tiny.width, tiny.height);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, FW, FH);
  ctx.drawImage(tiny, 0, 0, FW, FH);
  canvas.style.filter = `blur(${(1 - p) * 6}px)`;
}
requestAnimationFrame(frame);
