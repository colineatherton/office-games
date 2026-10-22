// One Line Wonder — Pictionary with exactly one continuous stroke per drawing.
// Individual scores, no teams. Architecture mirrors pictionary/: all game state
// lives under rooms/{CODE} in RTDB; the drawer's client advances the turn state
// machine with the host as fallback.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove, push,
  onValue, onChildAdded, onChildRemoved, onDisconnect, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { WORDS_EASY, WORDS_MEDIUM, WORDS_HARD } from "../pictionary/words.js";

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
let drawerGoneSince = null;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const strokesRef = () => ref(db, `rooms/${roomCode}/strokes`);
const chatRef = () => ref(db, `rooms/${roomCode}/chat`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const isDrawer = () => meta?.round?.drawerId === pid;
const iGuessed = () => (me()?.guessedRound || 0) >= (meta?.round?.num || 1);

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
      game: "oneline",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { drawSeconds: 60, turns: 12 },
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
    if (snap.val().game !== "oneline") {
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
  await update(meRef, {
    name,
    connected: true,
    joinedAt: existing?.joinedAt || serverTimestamp(),
    timesDrawn: existing?.timesDrawn || 0,
    guessedRound: existing?.guessedRound || 0,
    score: existing?.score || 0,
    guessersEarned: existing?.guessersEarned || 0,
  });
  onDisconnect(child(meRef, "connected")).set(false);

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
  onChildAdded(strokesRef(), (s) => addStroke(s.key, s.val()));
  onChildRemoved(strokesRef(), (s) => removeStroke(s.key));
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

function pickOptions(used = {}) {
  const pickFrom = (list) => {
    const fresh = list.filter((w) => !used[keyify(w)]);
    const pool = fresh.length ? fresh : list;
    return pool[Math.floor(Math.random() * pool.length)];
  };
  const options = [pickFrom(WORDS_EASY), pickFrom(WORDS_MEDIUM), pickFrom(WORDS_HARD)];
  const newUsed = { ...used };
  for (const w of options) newUsed[keyify(w)] = true;
  return { options, used: newUsed };
}
const keyify = (w) => w.replace(/[.#$/\[\]]/g, "_");

function pickNextDrawer() {
  const conn = Object.entries(players).filter(([, p]) => p.connected);
  if (!conn.length) return null;
  conn.sort((a, b) =>
    (a[1].timesDrawn || 0) - (b[1].timesDrawn || 0) ||
    (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  return conn[0][0];
}

async function startGame() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < 2) { alert("Need at least 2 players to start."); return; }

  const res = await txMeta((m) => {
    if (m.state !== "lobby") return;
    const drawerId = pickNextDrawer();
    if (!drawerId) return;
    const { options, used } = pickOptions({});
    return {
      ...m,
      state: "choosing",
      usedWords: used,
      round: { num: 1, drawerId, options, endsAt: nowSrv() + 20000 },
    };
  });
  if (res.committed) {
    remove(strokesRef());
    remove(chatRef());
    const resets = {};
    for (const id of Object.keys(players)) {
      resets[`${id}/timesDrawn`] = 0;
      resets[`${id}/guessedRound`] = 0;
      resets[`${id}/score`] = 0;
      resets[`${id}/guessersEarned`] = 0;
    }
    update(playersRef(), resets);
    $("chat-log").innerHTML = "";
  }
}

function pickWord(word) {
  txMeta((m) => {
    if (m.state !== "choosing" || m.round?.drawerId !== pid) return;
    return {
      ...m,
      state: "drawing",
      round: { ...m.round, word, endsAt: nowSrv() + m.settings.drawSeconds * 1000 },
    };
  }).then((res) => {
    if (res.committed && res.snapshot.val()?.state === "drawing") {
      runTransaction(ref(db, `rooms/${roomCode}/players/${pid}/timesDrawn`), (v) => (v || 0) + 1);
    }
  });
}

function endTurn() {
  const roundNum = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "drawing" || m.round?.num !== roundNum) return;
    return { ...m, state: "roundEnd", round: { ...m.round, endsAt: nowSrv() + 6000 } };
  }).then((res) => {
    if (!res.committed || res.snapshot.val()?.state !== "roundEnd") return;
    // Exactly-once drawer bonus: only the committing client runs this.
    const r = res.snapshot.val().round;
    const guessers = Object.entries(players)
      .filter(([id, p]) => id !== r.drawerId && (p.guessedRound || 0) >= r.num).length;
    if (guessers > 0 && r.drawerId) {
      const bonus = Math.min(25, 5 * guessers);
      runTransaction(ref(db, `rooms/${roomCode}/players/${r.drawerId}/score`), (v) => (v || 0) + bonus);
      runTransaction(ref(db, `rooms/${roomCode}/players/${r.drawerId}/guessersEarned`), (v) => (v || 0) + guessers);
      push(chatRef(), {
        system: true,
        text: `✒️ ${players[r.drawerId]?.name || "The artist"} earns +${bonus} for ${guessers} correct guess${guessers > 1 ? "es" : ""}`,
        t: serverTimestamp(),
      });
    }
  });
}

function nextTurn() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if ((m.state !== "roundEnd" && m.state !== "choosing") || m.round?.num !== expect) return;
    if (m.round.num >= m.settings.turns) return { ...m, state: "gameEnd" };
    const drawerId = pickNextDrawer();
    if (!drawerId) return { ...m, state: "gameEnd" };
    const { options, used } = pickOptions(m.usedWords || {});
    return {
      ...m,
      state: "choosing",
      usedWords: used,
      round: { num: m.round.num + 1, drawerId, options, endsAt: nowSrv() + 20000 },
    };
  }).then((res) => {
    if (res.committed) remove(strokesRef());
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedWords: null };
  });
}

function abortToLobby() {
  txMeta((m) => {
    if (m.state === "lobby" || m.state === "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedWords: null };
  });
}

function maybeEndTurnEarly() {
  if (!meta || meta.state !== "drawing" || !isDrawer()) return;
  const others = Object.entries(players)
    .filter(([id, p]) => id !== meta.round.drawerId && p.connected);
  if (others.length && others.every(([, p]) => (p.guessedRound || 0) >= meta.round.num)) {
    endTurn();
  }
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = ["choosing", "drawing", "roundEnd"].includes(meta.state);
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) abortToLobby();
  } else {
    lowPlayersSince = null;
  }

  if ((meta.state === "choosing" || meta.state === "drawing") &&
      isHost() && !isDrawer() && meta.round &&
      !players[meta.round.drawerId]?.connected) {
    drawerGoneSince ??= Date.now();
    if (Date.now() - drawerGoneSince > 5000) {
      drawerGoneSince = null;
      if (meta.state === "drawing") endTurn(); else nextTurn();
    }
  } else {
    drawerGoneSince = null;
  }

  const r = meta.round;
  if (!r?.endsAt) return;
  const n = nowSrv();

  if (meta.state === "drawing") {
    if (isDrawer() && n > r.endsAt) endTurn();
    else if (isHost() && !isDrawer() && n > r.endsAt + 4000) endTurn();
  } else if (meta.state === "roundEnd") {
    if ((isDrawer() || isHost()) && n > r.endsAt) nextTurn();
  } else if (meta.state === "choosing") {
    if (isDrawer() && n > r.endsAt) {
      pickWord(r.options[Math.floor(Math.random() * r.options.length)]);
    } else if (isHost() && !isDrawer() && n > r.endsAt + 6000) {
      nextTurn();
    }
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
let strokeRound = 0;

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
  const ul = $("lobby-player-list");
  ul.innerHTML = "";
  for (const [id, p] of sortedByJoin()) {
    if (!p.connected) continue;
    const li = document.createElement("li");
    li.textContent = `${p.name}${meta.hostId === id ? " 👑" : ""}${id === pid ? " (you)" : ""}`;
    if (id === pid) li.classList.add("me");
    ul.appendChild(li);
  }
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) {
    $("set-seconds").value = String(meta.settings.drawSeconds);
    $("set-turns").value = String(meta.settings.turns);
  }
}

const sortedByJoin = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
const sortedByScore = () =>
  Object.entries(players).sort((a, b) =>
    (b[1].score || 0) - (a[1].score || 0) || (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderGame() {
  const r = meta.round;

  // New round → unlock the pen.
  if (r && r.num !== strokeRound) {
    strokeRound = r.num;
    strokeUsed = false;
    penDown = false;
  }

  $("turn-info").textContent = r ? `Turn ${r.num}/${meta.settings.turns}` : "";

  const wd = $("word-display");
  if (meta.state === "drawing" && r?.word) {
    wd.textContent = isDrawer() || iGuessed() ? r.word : blanks(r.word);
  } else if (meta.state === "choosing") {
    wd.textContent = isDrawer() ? "pick a word…" : "…";
  } else {
    wd.innerHTML = "&nbsp;";
  }

  // Leaderboard
  const pl = $("player-list");
  pl.innerHTML = "";
  const inRound = meta.state === "drawing" || meta.state === "choosing";
  for (const [id, p] of sortedByScore()) {
    const row = document.createElement("div");
    row.className = "player-row";
    if (!p.connected) row.classList.add("offline");
    if (id === pid) row.classList.add("me");
    if (inRound && r?.drawerId === id) row.classList.add("drawer");
    if (inRound && r && (p.guessedRound || 0) >= r.num && id !== r.drawerId) row.classList.add("guessed");
    const icon = inRound && r?.drawerId === id ? "✒️ " : "";
    const check = row.classList.contains("guessed") ? "✓ " : "";
    row.innerHTML = `<span class="pname">${icon}${esc(p.name)}${id === pid ? " (you)" : ""}</span>` +
      `<span>${check}</span><span class="pscore">${p.score || 0}</span>`;
    pl.appendChild(row);
  }

  // Drawer tools + canvas lock
  const showTools = meta.state === "drawing" && isDrawer();
  $("tools").classList.toggle("hidden", !showTools);
  $("board").classList.toggle("locked", !canDraw());
  if (showTools) {
    const ps = $("pen-state");
    ps.textContent = strokeUsed ? "✒️ line used — pen is down for good" : penDown ? "drawing…" : "ONE line. Make it count.";
    ps.classList.toggle("used", strokeUsed);
    [...$("color-row").children].forEach((b) => { b.disabled = penDown || strokeUsed; });
  }

  const input = $("chat-input");
  if (meta.state === "drawing" && isDrawer()) input.placeholder = "You're drawing! (chat hidden from guessers)";
  else if (meta.state === "drawing" && iGuessed()) input.placeholder = "You got it! (chat hidden from guessers)";
  else input.placeholder = "Type your guess…";

  renderOverlay();
  renderTimer();
}

const blanks = (word) =>
  word.split("").map((ch) => (/[a-z0-9]/i.test(ch) ? "_" : ch)).join(" ");

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || (meta.state !== "drawing" && meta.state !== "choosing")) {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", meta.state === "drawing" && secs <= 10);
}

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");
  const r = meta.round;

  if (meta.state === "choosing" && r) {
    ov.classList.remove("hidden");
    if (isDrawer()) {
      box.innerHTML = `<h2>✒️ Your turn — ONE continuous line!</h2><p class="hint">The moment your pen lifts, the drawing is final.</p><div class="word-options"></div>`;
      const wrap = box.querySelector(".word-options");
      const tiers = ["easy", "medium", "hard"];
      (r.options || []).forEach((w, i) => {
        const b = document.createElement("button");
        b.className = "btn" + (i === 0 ? " primary" : "");
        b.textContent = `${w}  ·  ${tiers[i] || ""}`;
        b.addEventListener("click", () => pickWord(w));
        wrap.appendChild(b);
      });
    } else {
      const dn = players[r.drawerId]?.name || "someone";
      box.innerHTML = `<h2>✒️ ${esc(dn)} is choosing a word…</h2><p class="hint">They get one line. No lifting the pen.</p>`;
    }
  } else if (meta.state === "roundEnd" && r) {
    ov.classList.remove("hidden");
    const guessers = Object.entries(players)
      .filter(([id, p]) => (p.guessedRound || 0) >= r.num && id !== r.drawerId && p.connected)
      .map(([, p]) => esc(p.name));
    box.innerHTML = `
      <h2>The word was</h2>
      <div class="big-word">${esc(r.word || "?")}</div>
      <p>${guessers.length ? "✅ " + guessers.join(", ") : "😬 Nobody got it!"}</p>`;
  } else if (meta.state === "gameEnd") {
    ov.classList.remove("hidden");
    const ranked = sortedByScore();
    const medals = ["🥇", "🥈", "🥉"];
    let smoothest = null;
    for (const [id, p] of ranked) {
      if ((p.guessersEarned || 0) > (smoothest?.[1].guessersEarned || 0)) smoothest = [id, p];
    }
    box.innerHTML = `
      <h2>🏆 ${esc(ranked[0]?.[1].name || "?")} wins!</h2>
      ${smoothest ? `<p class="hint">✒️ Smoothest operator: ${esc(smoothest[1].name)} (${smoothest[1].guessersEarned} guessers charmed)</p>` : ""}
      <ul class="final-list">
        ${ranked.map(([id, p], i) =>
          `<li class="${id === pid ? "me" : ""}"><span>${medals[i] || "·"} ${esc(p.name)}</span><strong>${p.score || 0}</strong></li>`).join("")}
      </ul>
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
$("btn-start").addEventListener("click", startGame);
$("set-seconds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { drawSeconds: Number(e.target.value) }));
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

  const guessing = meta.state === "drawing" && !isDrawer() && !iGuessed();
  if (guessing && meta.round?.word) {
    const g = normalize(text), w = normalize(meta.round.word);
    if (g === w) { handleCorrectGuess(); return; }
    if (closeGuess(g, w)) addLocalHint("🔥 So close!");
  }

  const whisper = meta.state === "drawing" && (isDrawer() || iGuessed());
  push(chatRef(), {
    pid, name: me().name, text,
    whisper, t: serverTimestamp(),
  });
});

function handleCorrectGuess() {
  const r = meta.round;
  const secsLeft = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  const pts = 15 + secsLeft;
  runTransaction(ref(db, `rooms/${roomCode}/players/${pid}/score`), (v) => (v || 0) + pts);
  update(child(playersRef(), pid), { guessedRound: r.num });
  push(chatRef(), {
    system: true,
    text: `${me().name} guessed the word! +${pts}`,
    t: serverTimestamp(),
  });
}

function renderChatMsg(m) {
  if (!m) return;
  if (m.whisper && meta?.state === "drawing" && !isDrawer() && !iGuessed() && m.pid !== pid) return;
  const log = $("chat-log");
  const div = document.createElement("div");
  if (m.system) {
    div.className = "chat-msg system";
    div.textContent = m.text;
  } else {
    div.className = "chat-msg" + (m.whisper ? " whisper" : "");
    div.innerHTML = `<span class="who">${esc(m.name)}:</span> ${esc(m.text)}`;
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

// ── Canvas: one continuous line ───────────────────────────────────────────────
const board = $("board");
const ctx = board.getContext("2d");
const CW = board.width, CH = board.height;
ctx.lineCap = "round";
ctx.lineJoin = "round";
clearCanvas();

const COLORS = ["#000000", "#e03131", "#f08c00", "#2f9e44", "#1971c2", "#9c36b5", "#795548"];
const PEN_WIDTH = 7;
let curColor = COLORS[0];
let penDown = false;     // pointer currently down
let strokeUsed = false;  // the one line has been spent this round

const colorRow = $("color-row");
for (const c of COLORS) {
  const b = document.createElement("button");
  b.className = "color-btn";
  b.style.background = c;
  b.title = c;
  b.addEventListener("click", () => {
    if (penDown || strokeUsed) return;
    curColor = c;
    refreshColors();
  });
  colorRow.appendChild(b);
}
function refreshColors() {
  [...colorRow.children].forEach((b, i) => b.classList.toggle("active", COLORS[i] === curColor));
}
refreshColors();

const canDraw = () => meta?.state === "drawing" && isDrawer() && !strokeUsed;

const strokeMap = new Map();
let pendingPts = [];
let lastFlush = 0;
let inkLen = 0;

function getPos(e) {
  const rect = board.getBoundingClientRect();
  return [
    Math.round((e.clientX - rect.left) / rect.width * CW),
    Math.round((e.clientY - rect.top) / rect.height * CH),
  ];
}

board.addEventListener("pointerdown", (e) => {
  if (!canDraw() || penDown) return;
  e.preventDefault();
  board.setPointerCapture(e.pointerId);
  penDown = true;
  pendingPts = getPos(e);
  lastFlush = performance.now();
  render();
});

board.addEventListener("pointermove", (e) => {
  if (!penDown) return;
  e.preventDefault();
  const [x, y] = getPos(e);
  const n = pendingPts.length;
  const dx = x - pendingPts[n - 2], dy = y - pendingPts[n - 1];
  if (dx * dx + dy * dy < 9) return;
  pendingPts.push(x, y);
  if (pendingPts.length >= 32 || performance.now() - lastFlush > 80) flushSegment(false);
});

// Pen up OR cancel = the line is spent. Forever.
function penUp() {
  if (!penDown) return;
  penDown = false;
  flushSegment(true);
  strokeUsed = true;
  render();
}
board.addEventListener("pointerup", penUp);
board.addEventListener("pointercancel", penUp);

function flushSegment(final) {
  if (pendingPts.length < 2) { pendingPts = []; return; }
  const pts = pendingPts.length === 2
    ? [...pendingPts, pendingPts[0] + 1, pendingPts[1] + 1]
    : pendingPts;
  const seg = { c: curColor, w: PEN_WIDTH, p: pts };
  push(strokesRef(), seg);
  pendingPts = final ? [] : pts.slice(-2);
  lastFlush = performance.now();
}

function addStroke(key, seg) {
  strokeMap.set(key, seg);
  drawSegment(seg);
  inkLen += segLength(seg);
  $("ink-len").textContent = Math.round(inkLen);
}

function removeStroke(key) {
  if (!strokeMap.delete(key)) return;
  redrawAll();
}

function segLength(seg) {
  const p = seg.p || [];
  let len = 0;
  for (let i = 2; i < p.length; i += 2) {
    len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  }
  return len;
}

function drawSegment(seg) {
  const p = seg.p || [];
  if (p.length < 4) return;
  ctx.strokeStyle = seg.c;
  ctx.lineWidth = seg.w;
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
  ctx.stroke();
}

function redrawAll() {
  clearCanvas();
  inkLen = 0;
  for (const seg of strokeMap.values()) {
    drawSegment(seg);
    inkLen += segLength(seg);
  }
  $("ink-len").textContent = Math.round(inkLen);
}

function clearCanvas() {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CW, CH);
}
