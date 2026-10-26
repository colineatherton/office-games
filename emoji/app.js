// Emoji Guesser — static client, synced through Firebase Realtime Database.
// Pictionary with emoji instead of a canvas: one BUILDER translates a movie,
// song, or saying into an emoji string; everyone else races to guess in chat.
// All game state lives under rooms/{CODE}; the current builder's client
// advances the turn state machine, with the host as fallback.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove, push,
  onValue, onChildAdded, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { MOVIES, SONGS, THINGS, EMOJI_PALETTE, EMOJI_KEYWORDS } from "./prompts.js";

const $ = (id) => document.getElementById(id);

// ── Config check ──────────────────────────────────────────────────────────────
if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("PASTE")) {
  showScreen("setup");
  throw new Error("Firebase config not filled in — see firebase-config.js");
}

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ── Identity ──────────────────────────────────────────────────────────────────
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
let builderGoneSince = null;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const chatRef = () => ref(db, `rooms/${roomCode}/chat`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const isBuilder = () => meta?.round?.builderId === pid;
const iGuessed = () => (me()?.guessedRound || 0) >= (meta?.round?.num || 1);

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

const CATEGORIES = [
  { key: "movie", label: "🎬 Movie", list: MOVIES },
  { key: "song", label: "🎵 Song", list: SONGS },
  { key: "thing", label: "💬 Saying", list: THINGS },
];
const catLabel = (key) => CATEGORIES.find((c) => c.key === key)?.label || "";

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
      game: "emoji",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { roundSeconds: 75, turns: 12 },
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
    if (snap.val().game !== "emoji") {
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
    timesBuilt: existing?.timesBuilt || 0,
    guessedRound: existing?.guessedRound || 0,
  });
  trackPresence(db, meRef);

  onValue(metaRef(), (s) => {
    meta = s.val();
    if (!meta) return;
    render();
    maybeEndTurnEarly();
  });
  onValue(playersRef(), (s) => {
    players = s.val() || {};
    render();
    maybeEndTurnEarly();
  });
  onChildAdded(chatRef(), (s) => renderChatMsg(s.val()));
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

const keyify = (w) => w.replace(/[.#$/\[\]]/g, "_");

function pickOptions(used = {}) {
  const options = CATEGORIES.map(({ key, list }) => {
    const fresh = list.filter((t) => !used[keyify(t)]);
    const pool = fresh.length ? fresh : list;
    return { c: key, t: pool[Math.floor(Math.random() * pool.length)] };
  });
  const newUsed = { ...used };
  for (const o of options) newUsed[keyify(o.t)] = true;
  return { options, used: newUsed };
}

function pickNextBuilder(m) {
  const conn = Object.entries(players).filter(([, p]) => p.connected);
  if (!conn.length) return null;
  const lastTeam = m.round?.builderTeam;
  const prefTeam = lastTeam === "red" ? "blue" : "red";
  let pool = conn.filter(([, p]) => p.team === prefTeam);
  if (!pool.length) pool = conn;
  pool.sort((a, b) =>
    (a[1].timesBuilt || 0) - (b[1].timesBuilt || 0) ||
    (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  return pool[0][0];
}

async function startGame() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < 2) { alert("Need at least 2 players to start."); return; }

  const res = await txMeta((m) => {
    if (m.state !== "lobby") return;
    const builderId = pickNextBuilder(m);
    if (!builderId) return;
    const { options, used } = pickOptions({});
    return {
      ...m,
      state: "choosing",
      scores: { red: 0, blue: 0 },
      usedWords: used,
      round: {
        num: 1, builderId,
        builderTeam: players[builderId].team,
        options, endsAt: nowSrv() + 20000,
      },
    };
  });
  if (res.committed) {
    remove(chatRef());
    const resets = {};
    for (const id of Object.keys(players)) {
      resets[`${id}/timesBuilt`] = 0;
      resets[`${id}/guessedRound`] = 0;
    }
    update(playersRef(), resets);
    $("chat-log").innerHTML = "";
  }
}

function pickPrompt(opt) {
  txMeta((m) => {
    if (m.state !== "choosing" || m.round?.builderId !== pid) return;
    return {
      ...m,
      state: "playing",
      round: {
        ...m.round,
        answer: opt.t, category: opt.c, emojis: "",
        endsAt: nowSrv() + m.settings.roundSeconds * 1000,
      },
    };
  }).then((res) => {
    if (res.committed && res.snapshot.val()?.state === "playing") {
      runTransaction(ref(db, `rooms/${roomCode}/players/${pid}/timesBuilt`), (v) => (v || 0) + 1);
    }
  });
}

function endTurn() {
  txMeta((m) => {
    if (m.state !== "playing" || m.round?.num !== meta?.round?.num) return;
    return { ...m, state: "roundEnd", round: { ...m.round, endsAt: nowSrv() + 6000 } };
  });
}

function nextTurn() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if ((m.state !== "roundEnd" && m.state !== "choosing") || m.round?.num !== expect) return;
    if (m.round.num >= m.settings.turns) return { ...m, state: "gameEnd" };
    const builderId = pickNextBuilder(m);
    if (!builderId) return { ...m, state: "gameEnd" };
    const { options, used } = pickOptions(m.usedWords || {});
    return {
      ...m,
      state: "choosing",
      usedWords: used,
      round: {
        num: m.round.num + 1, builderId,
        builderTeam: players[builderId].team,
        options, endsAt: nowSrv() + 20000,
      },
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedWords: null };
  });
}

// Called when too few players remain mid-game.
function abortToLobby() {
  txMeta((m) => {
    if (m.state === "lobby" || m.state === "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedWords: null };
  });
}

// If every connected non-builder has guessed, the builder ends the turn early.
function maybeEndTurnEarly() {
  if (!meta || meta.state !== "playing" || !isBuilder()) return;
  const others = Object.entries(players)
    .filter(([id, p]) => id !== meta.round.builderId && p.connected);
  if (others.length && others.every(([, p]) => (p.guessedRound || 0) >= meta.round.num)) {
    endTurn();
  }
}

// ── Periodic tick: timer display + state-machine fallbacks ───────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  // Watchdog: a game can't run with fewer than 2 players — return everyone to
  // the lobby after a 10s grace (covers a player refreshing their browser).
  const active = ["choosing", "playing", "roundEnd"].includes(meta.state);
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) abortToLobby();
  } else {
    lowPlayersSince = null;
  }

  // Watchdog: if the current builder disconnects, don't make everyone sit out
  // the full timer — the host skips ahead after 5s.
  if ((meta.state === "choosing" || meta.state === "playing") &&
      isHost() && !isBuilder() && meta.round &&
      !players[meta.round.builderId]?.connected) {
    builderGoneSince ??= Date.now();
    if (Date.now() - builderGoneSince > 5000) {
      builderGoneSince = null;
      if (meta.state === "playing") endTurn(); else nextTurn();
    }
  } else {
    builderGoneSince = null;
  }

  const r = meta.round;
  if (!r?.endsAt) return;
  const n = nowSrv();

  if (meta.state === "playing") {
    if (isBuilder() && n > r.endsAt) endTurn();
    else if (isHost() && !isBuilder() && n > r.endsAt + 4000) endTurn();
  } else if (meta.state === "roundEnd") {
    if ((isBuilder() || isHost()) && n > r.endsAt) nextTurn();
  } else if (meta.state === "choosing") {
    if (isBuilder() && n > r.endsAt) {
      pickPrompt(r.options[Math.floor(Math.random() * r.options.length)]);
    } else if (isHost() && !isBuilder() && n > r.endsAt + 6000) {
      nextTurn(); // builder vanished mid-choice — skip their turn
    }
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
  if (isHost()) {
    $("set-seconds").value = String(meta.settings.roundSeconds);
    $("set-turns").value = String(meta.settings.turns);
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderGame() {
  const r = meta.round;
  $("turn-info").textContent = r ? `Turn ${r.num}/${meta.settings.turns}` : "";
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;

  // Answer display + category badge
  const wd = $("word-display");
  const badge = $("category-badge");
  const showCat = (meta.state === "playing" || meta.state === "roundEnd") && r?.category;
  badge.classList.toggle("hidden", !showCat);
  if (showCat) badge.textContent = catLabel(r.category);
  if (meta.state === "playing" && r?.answer) {
    wd.textContent = isBuilder() || iGuessed() ? r.answer : blanks(r.answer);
  } else if (meta.state === "choosing") {
    wd.textContent = isBuilder() ? "pick a prompt…" : "…";
  } else {
    wd.innerHTML = "&nbsp;";
  }

  // Player list
  const pl = $("player-list");
  pl.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    const row = document.createElement("div");
    row.className = `player-row ${p.team}`;
    if (!p.connected) row.classList.add("offline");
    if (id === pid) row.classList.add("me");
    const inRound = meta.state === "playing" || meta.state === "choosing";
    if (inRound && r && (p.guessedRound || 0) >= r.num && id !== r.builderId) row.classList.add("guessed");
    const icon = r?.builderId === id && inRound ? "🎬 " : "";
    const check = row.classList.contains("guessed") ? " ✓" : "";
    row.innerHTML = `<span class="pname">${icon}${esc(p.name)}${id === pid ? " (you)" : ""}</span><span>${check}</span>`;
    pl.appendChild(row);
  }

  renderStage();
  $("builder-panel").classList.toggle("hidden", !(meta.state === "playing" && isBuilder()));

  // Chat input hint
  const input = $("chat-input");
  if (meta.state === "playing" && isBuilder()) input.placeholder = "You're building! (chat hidden from guessers)";
  else if (meta.state === "playing" && iGuessed()) input.placeholder = "You got it! (chat hidden from guessers)";
  else input.placeholder = "Type your guess…";

  renderOverlay();
  renderTimer();
}

const blanks = (text) =>
  text.split("").map((ch) => (/[a-z0-9]/i.test(ch) ? "_" : ch)).join(" ");

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || (meta.state !== "playing" && meta.state !== "choosing")) {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", meta.state === "playing" && secs <= 10);
}

function renderStage() {
  const stage = $("emoji-stage");
  if (meta.state !== "playing" && meta.state !== "roundEnd") {
    stage.innerHTML = "&nbsp;";
    return;
  }
  // The builder renders their local composition for instant feedback;
  // everyone else renders the synced string.
  const str = (meta.state === "playing" && isBuilder()) ? compose.join("") : (meta.round?.emojis || "");
  if (str) {
    stage.textContent = str;
  } else {
    stage.innerHTML = `<span class="placeholder">${
      isBuilder() ? "click emoji below to build your clue…" : "🤔 waiting for the first emoji…"
    }</span>`;
  }
}

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");
  const r = meta.round;

  if (meta.state === "choosing" && r) {
    ov.classList.remove("hidden");
    if (isBuilder()) {
      box.innerHTML = `<h2>🎬 Your turn to build!</h2><p class="hint">Pick a prompt to translate into emoji</p><div class="word-options"></div>`;
      const wrap = box.querySelector(".word-options");
      (r.options || []).forEach((o, i) => {
        const b = document.createElement("button");
        b.className = "btn" + (i === 0 ? " primary" : "");
        b.innerHTML = `<span class="opt-cat">${catLabel(o.c)}</span>${esc(o.t)}`;
        b.addEventListener("click", () => pickPrompt(o));
        wrap.appendChild(b);
      });
    } else {
      const bn = players[r.builderId]?.name || "someone";
      box.innerHTML = `<h2>🎬 ${esc(bn)} is choosing a prompt…</h2>`;
    }
  } else if (meta.state === "roundEnd" && r) {
    ov.classList.remove("hidden");
    const guessers = Object.values(players)
      .filter((p) => (p.guessedRound || 0) >= r.num && p.connected)
      .map((p) => esc(p.name));
    box.innerHTML = `
      <div class="big-emojis">${esc(r.emojis || "🫥")}</div>
      <h2>${catLabel(r.category)} — the answer was</h2>
      <div class="big-word">${esc(r.answer || "?")}</div>
      <p>${guessers.length ? "✅ " + guessers.join(", ") : "😬 Nobody got it!"}</p>`;
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

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── Lobby interactions ───────────────────────────────────────────────────────
$("lobby-team-red").addEventListener("click", () => switchTeam("red"));
$("lobby-team-blue").addEventListener("click", () => switchTeam("blue"));
function switchTeam(team) {
  if (meta?.state !== "lobby") return;
  update(child(playersRef(), pid), { team });
}

$("btn-start").addEventListener("click", startGame);
$("set-seconds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { roundSeconds: Number(e.target.value) }));
$("set-turns").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { turns: Number(e.target.value) }));

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

// ── Chat & guessing ──────────────────────────────────────────────────────────
const normalize = (s) => s.toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9 ]/g, "")
  .replace(/\s+/g, " ").trim();

const stripThe = (s) => s.replace(/^the /, "");
const isMatch = (guess, answer) =>
  guess === answer || stripThe(guess) === stripThe(answer);

function closeGuess(guess, word) {
  if (!guess || !word) return false;
  if (Math.abs(guess.length - word.length) > 1) return false;
  const a = guess, b = word;
  if (a === b) return true;
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

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text || !me() || !meta) return;
  input.value = "";

  const guessing = meta.state === "playing" && !isBuilder() && !iGuessed();
  if (guessing && meta.round?.answer) {
    const g = normalize(text), w = normalize(meta.round.answer);
    if (isMatch(g, w)) { handleCorrectGuess(); return; }
    if (closeGuess(stripThe(g), stripThe(w))) addLocalHint("🔥 So close!");
  }

  // Messages from the builder or players who already guessed are hidden from
  // active guessers so the answer can't leak.
  const whisper = meta.state === "playing" && (isBuilder() || iGuessed());
  push(chatRef(), {
    pid, name: me().name, team: me().team, text,
    whisper, t: serverTimestamp(),
  });
});

function handleCorrectGuess() {
  const r = meta.round;
  const secsLeft = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  const pts = 20 + secsLeft;
  const team = me().team;
  runTransaction(ref(db, `rooms/${roomCode}/meta/scores/${team}`), (v) => (v || 0) + pts);
  update(child(playersRef(), pid), { guessedRound: r.num });
  push(chatRef(), {
    system: true, team,
    text: `${me().name} guessed it! +${pts} for ${team === "red" ? "🔴 Red" : "🔵 Blue"}`,
    t: serverTimestamp(),
  });
}

function renderChatMsg(m) {
  if (!m) return;
  if (m.whisper && meta?.state === "playing" && !isBuilder() && !iGuessed() && m.pid !== pid) return;
  const log = $("chat-log");
  const div = document.createElement("div");
  if (m.system) {
    div.className = "chat-msg system";
    div.textContent = m.text;
  } else {
    div.className = "chat-msg" + (m.whisper ? " whisper" : "");
    div.innerHTML = `<span class="who ${m.team === "blue" ? "blue" : "red"}">${esc(m.name)}:</span> ${esc(m.text)}`;
  }
  log.appendChild(div);
  while (log.children.length > 250) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function addLocalHint(text) {
  const log = $("chat-log");
  const div = document.createElement("div");
  div.className = "chat-msg local-hint";
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ── Emoji composition (builder only) ─────────────────────────────────────────
// `compose` is an array of complete emoji (each palette entry may be several
// code units), so "remove last" always removes one whole emoji.
let compose = [];
let composeRound = -1;
let emojiWriteTimer = null;

// Reset composition (and any leftover search) whenever a new round starts.
setInterval(() => {
  const n = meta?.round?.num ?? -1;
  if (n !== composeRound) {
    composeRound = n;
    compose = [];
    if (searchInput.value) { searchInput.value = ""; filterPalette(); }
  }
}, 200);

const palette = $("palette");
const paletteButtons = []; // [emoji, button] in palette order
for (const e of EMOJI_PALETTE) {
  const b = document.createElement("button");
  b.className = "emoji-btn";
  b.type = "button";
  b.textContent = e;
  b.title = EMOJI_KEYWORDS[e] || "";
  b.addEventListener("click", () => {
    if (!(meta?.state === "playing" && isBuilder())) return;
    if (compose.length >= 40) return;
    compose.push(e);
    renderStage();
    syncEmojis();
  });
  palette.appendChild(b);
  paletteButtons.push([e, b]);
}

// Search filters the grid live by keyword (e.g. "croc" → 🐊, "red" → 🔴❤️…).
// Hiding non-matches collapses the auto-fill grid into a flat list of matches;
// clearing (or Escape) restores the full category-ordered grid.
const searchInput = $("emoji-search");
function filterPalette() {
  const q = searchInput.value.trim().toLowerCase();
  let shown = 0;
  for (const [e, b] of paletteButtons) {
    // Word-prefix match: "king" hits "king" but not "thinking".
    const match = !q || EMOJI_KEYWORDS[e].split(" ").some((w) => w.startsWith(q));
    b.classList.toggle("hidden", !match);
    if (match) shown++;
  }
  $("no-matches").classList.toggle("hidden", shown > 0);
}
searchInput.addEventListener("input", filterPalette);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { searchInput.value = ""; filterPalette(); }
  if (e.key === "Enter") e.preventDefault(); // never submit/steal the guess flow
});

$("btn-backspace").addEventListener("click", () => {
  if (!(meta?.state === "playing" && isBuilder())) return;
  compose.pop();
  renderStage();
  syncEmojis();
});

$("btn-clear-emojis").addEventListener("click", () => {
  if (!(meta?.state === "playing" && isBuilder())) return;
  compose = [];
  renderStage();
  syncEmojis();
});

function syncEmojis() {
  if (emojiWriteTimer) return;
  emojiWriteTimer = setTimeout(() => {
    emojiWriteTimer = null;
    if (!(meta?.state === "playing" && isBuilder())) return;
    // Defensive: composition is click-only, but strip any ASCII that could
    // have snuck in so letters can never spell out the answer.
    const str = compose.join("").replace(/[\x20-\x7E]/g, "");
    set(ref(db, `rooms/${roomCode}/meta/round/emojis`), str);
  }, 200);
}
