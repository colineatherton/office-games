// Typing Grand Prix — static client, synced through Firebase Realtime Database.
// Everyone types the same passage; progress bars race live. Only progress and
// finishes sync — the typing itself is local, and a wrong keystroke blocks
// further input until it's fixed. The host's client drives the state machine.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { TEXTS } from "./texts.js";

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
let advancing = false;

// Local race state
let curText = "";
let spans = [];
let typed = "";
let loadedRound = -1;
let myDoneLocal = false;
let lastSync = 0;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// A participant is anyone who was in the room when the current race was dealt.
function isParticipant() {
  const p = me();
  const r = meta?.round;
  return !!(p && r && (p.joinedAt || 0) <= (r.createdAt || Infinity));
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
      game: "typing",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { races: 5, length: "short" },
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
    if (snap.val().game !== "typing") {
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

// usedTexts keys are "t<idx>" so RTDB never coerces them into an array.
function pickText(m) {
  const eligible = TEXTS.map((t, i) => ({ t, i }))
    .filter(({ t }) => t.len === m.settings.length);
  let used = m.usedTexts || {};
  let fresh = eligible.filter(({ i }) => !used[`t${i}`]);
  if (!fresh.length) { used = {}; fresh = eligible; }
  const idx = fresh[Math.floor(Math.random() * fresh.length)].i;
  return { idx, used: { ...used, [`t${idx}`]: true } };
}

function newRound(m, num) {
  const pick = pickText(m);
  const created = nowSrv();
  return {
    ...m,
    state: "racing",
    usedTexts: pick.used,
    round: {
      num,
      textIdx: pick.idx,
      createdAt: created,
      startAt: created + 3500,
      hardEndsAt: created + 3500 + 180000,
    },
  };
}

async function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  const red = conn.filter((p) => p.team === "red").length;
  const blue = conn.filter((p) => p.team === "blue").length;
  const hint = $("start-hint");
  if (conn.length < 2 || !red || !blue) {
    hint.textContent = "Need at least 2 players with someone on each team.";
    hint.classList.remove("hidden");
    return;
  }
  hint.classList.add("hidden");

  // Reset BEFORE flipping state so stale race/stat data can't leak in.
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/race`] = null;
    resets[`${id}/stats`] = null;
  }
  await update(playersRef(), resets);

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    return newRound({ ...m, scores: { red: 0, blue: 0 }, usedTexts: null }, 1);
  });
}

// Host: close the race and score it, exactly once, inside the transaction.
function finishRound() {
  if (advancing) return;
  advancing = true;
  const n = meta.round.num;
  txMeta((m) => {
    if (m.state !== "racing" || m.round?.num !== n) return;

    const parts = Object.entries(players).filter(([, p]) =>
      p.connected && (p.joinedAt || 0) <= m.round.createdAt);
    const ranked = Object.entries(players)
      .filter(([, p]) => p.race?.done)
      .sort((a, b) => (a[1].race.ms - b[1].race.ms) || (a[0] < b[0] ? -1 : 1));
    const participants = Math.max(ranked.length, parts.length);

    let dRed = 0, dBlue = 0;
    const order = ranked.map(([id, p], i) => {
      const pts = Math.max(0, participants - i);
      p.team === "red" ? (dRed += pts) : (dBlue += pts);
      return { id, name: p.name, team: p.team, ms: p.race.ms, wpm: p.race.wpm || 0, pts };
    });
    const doneIds = new Set(ranked.map(([id]) => id));
    const partials = parts.filter(([id]) => !doneIds.has(id)).map(([id, p]) => {
      const pts = Math.min(3, Math.floor((p.race?.p || 0) * 4));
      p.team === "red" ? (dRed += pts) : (dBlue += pts);
      return { id, name: p.name, team: p.team, p: p.race?.p || 0, pts };
    });

    return {
      ...m,
      state: "results",
      scores: { red: (m.scores?.red || 0) + dRed, blue: (m.scores?.blue || 0) + dBlue },
      round: { ...m.round, results: { order, partials }, resultsEndsAt: nowSrv() + 10000 },
    };
  }).finally(() => { advancing = false; });
}

async function nextRace() {
  if (advancing) return;
  advancing = true;
  try {
    const n = meta.round.num;
    const resets = {};
    for (const id of Object.keys(players)) resets[`${id}/race`] = null;
    await update(playersRef(), resets);
    await txMeta((m) => {
      if (m.state !== "results" || m.round?.num !== n) return;
      if (n >= m.settings.races) return { ...m, state: "gameEnd" };
      return newRound(m, n + 1);
    });
  } finally {
    advancing = false;
  }
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedTexts: null };
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
  renderTimer();
  renderOverlay();
  claimHostIfAbandoned();

  const active = meta.state === "racing" || meta.state === "results";
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) abortToLobby();
  } else {
    lowPlayersSince = null;
  }

  if (!isHost()) return;
  const n = nowSrv();
  if (meta.state === "racing" && meta.round) {
    const r = meta.round;
    const parts = Object.entries(players).filter(([, p]) =>
      p.connected && (p.joinedAt || 0) <= r.createdAt);
    const allDone = parts.length > 0 && parts.every(([, p]) => p.race?.done);
    if ((n > r.startAt + 2000 && allDone) ||
        (r.graceEndsAt && n > r.graceEndsAt) ||
        n > r.hardEndsAt) {
      finishRound();
    }
  } else if (meta.state === "results" && meta.round?.resultsEndsAt && n > meta.round.resultsEndsAt) {
    nextRace();
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
    loadedRound = -1;
    showScreen("lobby");
    renderLobby();
    return;
  }
  showScreen("game");
  renderGame();
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
    $("set-races").value = String(meta.settings.races);
    $("set-length").value = meta.settings.length;
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) =>
    (a[1].team || "").localeCompare(b[1].team || "") ||
    (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderGame() {
  const r = meta.round;
  $("race-info").textContent = r ? `Race ${r.num}/${meta.settings.races}` : "";
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;

  if (meta.state === "racing" && r && r.num !== loadedRound) {
    loadedRound = r.num;
    initRaceLocal();
  }

  const racing = meta.state === "racing";
  const participant = isParticipant();
  $("spectate-banner").classList.toggle("hidden", !(racing && !participant));
  $("race-text").classList.toggle("locked", !(racing && participant && !myDoneLocal));
  $("focus-hint").classList.toggle("hidden", !(racing && participant && !myDoneLocal));
  $("done-banner").classList.toggle("hidden", !(racing && myDoneLocal));

  renderLanes();
  renderOverlay();
  renderTimer();
}

function initRaceLocal() {
  const r = meta.round;
  curText = TEXTS[r.textIdx]?.text || "";
  typed = "";
  myDoneLocal = false;
  const input = $("type-input");
  input.value = "";
  const el = $("race-text");
  el.innerHTML = "";
  spans = [];
  for (const ch of curText) {
    const s = document.createElement("span");
    s.textContent = ch;
    el.appendChild(s);
    spans.push(s);
  }
  paintText();
  focusTyping();
}

function paintText() {
  let lcp = 0;
  while (lcp < typed.length && lcp < curText.length && typed[lcp] === curText[lcp]) lcp++;
  const hasErr = typed.length > lcp;
  for (let i = 0; i < spans.length; i++) {
    spans[i].className = i < lcp ? "done" : i === lcp ? (hasErr ? "err" : "cur") : "";
  }
  return lcp;
}

function renderLanes() {
  const lanes = $("lanes");
  lanes.innerHTML = "";
  const r = meta.round;
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected && !p.race?.done) continue;
    if (r && (p.joinedAt || 0) > (r.createdAt || Infinity)) continue; // next-race joiner
    const lane = document.createElement("div");
    lane.className = `lane ${p.team}`;
    if (!p.connected) lane.classList.add("offline");
    if (id === pid) lane.classList.add("me");
    const prog = id === pid && meta.state === "racing" && curText
      ? (myDoneLocal ? 1 : paintLcpOnly() / curText.length)
      : (p.race?.done ? 1 : p.race?.p || 0);
    const pct = Math.round(prog * 100);
    const wpmTxt = p.race?.done ? `${p.race.wpm} wpm` : "";
    lane.innerHTML = `
      <div class="fill" style="width:${pct}%"></div>
      <div class="car" style="left:${pct}%">${p.team === "red" ? "🚗" : "🚙"}${p.race?.done ? "🏁" : ""}</div>
      <div class="who"><span class="name">${esc(p.name)}${id === pid ? " (you)" : ""}</span><span class="wpm">${wpmTxt}</span></div>`;
    lanes.appendChild(lane);
  }
}

function paintLcpOnly() {
  let lcp = 0;
  while (lcp < typed.length && lcp < curText.length && typed[lcp] === curText[lcp]) lcp++;
  return lcp;
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (meta?.state !== "racing" || !r) { el.textContent = "--"; el.classList.remove("low"); return; }
  const n = nowSrv();
  if (n < r.startAt) { el.textContent = Math.ceil((r.startAt - n) / 1000); el.classList.remove("low"); return; }
  if (r.graceEndsAt) {
    el.textContent = Math.max(0, Math.ceil((r.graceEndsAt - n) / 1000));
    el.classList.add("low");
  } else {
    el.textContent = Math.floor((n - r.startAt) / 1000);
    el.classList.remove("low");
  }
}

function renderOverlay() {
  if (!meta || meta.state === "lobby") return;
  const ov = $("overlay");
  const box = $("overlay-content");
  const r = meta.round;

  if (meta.state === "racing" && r && nowSrv() < r.startAt) {
    ov.classList.remove("hidden");
    const secs = Math.ceil((r.startAt - nowSrv()) / 1000);
    box.innerHTML = `<h2>Get ready to type…</h2><div class="big">${secs}</div>`;
    return;
  }

  if (meta.state === "results" && r?.results) {
    ov.classList.remove("hidden");
    const rows = r.results.order.map((o, i) => `
      <li><span class="pos">${["🥇", "🥈", "🥉"][i] || (i + 1)}</span>
        <span class="name ${o.team}">${esc(o.name)}</span>
        <span class="meta2">${o.wpm} wpm · ${(o.ms / 1000).toFixed(1)}s</span>
        <span class="pts">+${o.pts}</span></li>`).join("");
    const parts = r.results.partials.map((o) => `
      <li class="partial"><span class="pos">…</span>
        <span class="name ${o.team}">${esc(o.name)}</span>
        <span class="meta2">${Math.round(o.p * 100)}% typed</span>
        <span class="pts">+${o.pts}</span></li>`).join("");
    box.innerHTML = `<h2>🏁 Race ${r.num} results</h2>
      <ul class="results-list">${rows}${parts}</ul>
      <p class="hint">Next race in a moment…</p>`;
    return;
  }

  if (meta.state === "gameEnd") {
    ov.classList.remove("hidden");
    const red = meta.scores?.red || 0, blue = meta.scores?.blue || 0;
    const result = red === blue ? `<h2>🤝 It's a tie!</h2>`
      : red > blue ? `<h2 class="winner-red">🔴 Red Team wins!</h2>`
      : `<h2 class="winner-blue">🔵 Blue Team wins!</h2>`;
    let crown = "";
    let best = null;
    for (const [, p] of Object.entries(players)) {
      if (p.stats?.n) {
        const avg = p.stats.sum / p.stats.n;
        if (!best || avg > best.avg) best = { name: p.name, avg };
      }
    }
    if (best) crown = `<p>🏎️ Fastest fingers: <strong>${esc(best.name)}</strong> (${Math.round(best.avg)} wpm average)</p>`;
    box.innerHTML = `${result}<div class="big">${red} — ${blue}</div>${crown}
      ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
                 : `<p class="hint">Waiting for the host…</p>`}
      <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
    box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
    box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
    return;
  }

  ov.classList.add("hidden");
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
$("set-races").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { races: Number(e.target.value) }));
$("set-length").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { length: e.target.value }));

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

// ── Typing ────────────────────────────────────────────────────────────────────
const input = $("type-input");
const raceText = $("race-text");

function focusTyping() {
  if (canType()) input.focus({ preventScroll: true });
}
raceText.addEventListener("click", focusTyping);
raceText.addEventListener("focus", focusTyping);

function canType() {
  return meta?.state === "racing" && meta.round &&
    nowSrv() >= meta.round.startAt && isParticipant() && !myDoneLocal;
}

input.addEventListener("paste", (e) => e.preventDefault());
input.addEventListener("drop", (e) => e.preventDefault());

input.addEventListener("input", () => {
  if (!canType()) { input.value = typed; return; }
  const v = input.value;
  let lcp = 0;
  while (lcp < v.length && lcp < curText.length && v[lcp] === curText[lcp]) lcp++;
  // At most one pending wrong character; also swallows paste-sized jumps.
  if (v.length > lcp + 1) {
    input.value = typed;
    raceText.classList.remove("shake");
    void raceText.offsetWidth;
    raceText.classList.add("shake");
    return;
  }
  typed = v;
  paintText();
  renderLanes();
  if (typed === curText) {
    finishRace();
  } else {
    syncProgress(false, lcp);
  }
});

function syncProgress(force, lcp) {
  if (myDoneLocal) return;
  const now = performance.now();
  if (!force && now - lastSync < 400) return;
  lastSync = now;
  const p = Math.min(1, Math.round((lcp / Math.max(1, curText.length)) * 100) / 100);
  update(child(playersRef(), pid), { race: { p, done: false } });
}

function finishRace() {
  if (myDoneLocal) return;
  myDoneLocal = true;
  const r = meta.round;
  const ms = Math.max(1, nowSrv() - r.startAt);
  const wpm = Math.round((curText.length / 5) / (ms / 60000));
  $("done-stats").textContent = `✔ Finished! ${wpm} wpm in ${(ms / 1000).toFixed(1)}s`;
  update(child(playersRef(), pid), { race: { p: 1, done: true, ms, wpm } });
  runTransaction(ref(db, `rooms/${roomCode}/players/${pid}/stats`), (s) =>
    ({ sum: (s?.sum || 0) + wpm, n: (s?.n || 0) + 1 }));
  // First finisher opens the 25s grace window for everyone else.
  const n = r.num;
  txMeta((m) => (m.state === "racing" && m.round?.num === n && !m.round.graceEndsAt)
    ? { ...m, round: { ...m.round, graceEndsAt: nowSrv() + 25000 } }
    : undefined);
  render();
}

// Keep the hidden input focused while racing (clicks elsewhere steal it).
document.addEventListener("keydown", () => {
  if (canType() && document.activeElement !== input) focusTyping();
});
