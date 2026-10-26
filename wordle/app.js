// Wordle Race — static client, synced through Firebase Realtime Database.
//
// Red and Blue race to solve the SAME hidden 5-letter word. Each team has its
// own 6-row board; everyone sees the opponent's tile colors but not their
// letters. All state transitions (including guesses) go through a transaction
// on the whole meta node so simultaneous guesses serialize cleanly.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { ANSWERS, VALID_EXTRA } from "./words.js";

const GUESSABLE = new Set([...ANSWERS, ...VALID_EXTRA]);
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
const myTeam = () => me()?.team || "red";
const oppTeam = () => (myTeam() === "red" ? "blue" : "red");
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
      game: "wordle",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { bestOf: 5 },
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
    if (snap.val().game !== "wordle") {
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

function pickAnswer(used = {}) {
  const fresh = ANSWERS.filter((w) => !used[w]);
  const pool = fresh.length ? fresh : ANSWERS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  const red = conn.filter((p) => p.team === "red").length;
  const blue = conn.filter((p) => p.team !== "red").length;
  if (!red || !blue) { alert("Need at least 1 player on each team."); return; }

  txMeta((m) => {
    if (m.state !== "lobby") return;
    const answer = pickAnswer({});
    return {
      ...m,
      state: "playing",
      scores: { red: 0, blue: 0 },
      roundNum: 1,
      usedWords: { [answer]: true },
      round: { answer },
    };
  });
}

function nextRound() {
  const expect = meta?.roundNum;
  txMeta((m) => {
    if (m.state !== "roundEnd" || m.roundNum !== expect) return;
    const need = Math.ceil(m.settings.bestOf / 2);
    if ((m.scores.red || 0) >= need || (m.scores.blue || 0) >= need) {
      return { ...m, state: "gameEnd", round: null };
    }
    const used = { ...(m.usedWords || {}) };
    const answer = pickAnswer(used);
    used[answer] = true;
    return {
      ...m, state: "playing", roundNum: m.roundNum + 1,
      usedWords: used, round: { answer },
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedWords: null, roundNum: null };
  });
}

function abortToLobby() {
  txMeta((m) => {
    if (m.state === "lobby" || m.state === "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedWords: null, roundNum: null };
  });
}

// Host can end a stalled round (e.g. a team gives up with guesses left).
$("btn-giveup").addEventListener("click", () => {
  txMeta((m) => {
    if (m.state !== "playing") return;
    return { ...m, state: "roundEnd", round: { ...m.round, endsAt: nowSrv() + 6000 } };
  });
});

// ── Guessing ──────────────────────────────────────────────────────────────────
// Standard Wordle coloring with duplicate-letter handling: greens first, then
// yellows limited by remaining letter counts.
function colorize(guess, answer) {
  const res = Array(5).fill("absent");
  const counts = {};
  for (let i = 0; i < 5; i++) {
    if (guess[i] === answer[i]) res[i] = "correct";
    else counts[answer[i]] = (counts[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < 5; i++) {
    if (res[i] !== "correct" && counts[guess[i]] > 0) {
      res[i] = "present";
      counts[guess[i]]--;
    }
  }
  return res;
}

function teamBoard(team) {
  return meta?.round?.boards?.[team] || {};
}
function teamConnCount(team) {
  return Object.values(players).filter((p) => p.connected && p.team === team).length;
}
// You can't submit your team's next guess if you submitted the last one
// (unless you're alone on the team).
function turnLocked(team) {
  const b = teamBoard(team);
  return teamConnCount(team) > 1 && b.lastGuesser === pid;
}

function rejectInput(msg) {
  const el = $("guess-msg");
  el.textContent = msg;
  el.classList.remove("hidden");
  const row = document.querySelector("#my-board .brow.current");
  row?.classList.add("shake");
  setTimeout(() => {
    row?.classList.remove("shake");
    el.classList.add("hidden");
  }, 1600);
}

$("guess-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!meta || meta.state !== "playing" || !me()) return;
  const team = myTeam();
  const word = $("guess-input").value.trim().toLowerCase();
  if (!/^[a-z]{5}$/.test(word)) { rejectInput("Need exactly 5 letters."); return; }
  if (!GUESSABLE.has(word)) { rejectInput("Not in the word list."); return; }
  const b = teamBoard(team);
  if (b.solved || (b.guesses || []).length >= 6) return;
  if (turnLocked(team)) { rejectInput("Let a teammate take this one."); return; }

  txMeta((m) => {
    if (m.state !== "playing") return;
    const r = m.round;
    const boards = r.boards || {};
    const mine = boards[team] || {};
    const guesses = mine.guesses ? [...mine.guesses] : [];
    if (mine.solved || guesses.length >= 6) return;
    if (teamConnCount(team) > 1 && mine.lastGuesser === pid) return;

    guesses.push({ word, by: pid, name: me()?.name || "?" });
    const solved = word === r.answer;
    const newBoards = { ...boards, [team]: { guesses, lastGuesser: pid, solved } };
    let next = { ...m, round: { ...r, boards: newBoards } };

    const other = newBoards[team === "red" ? "blue" : "red"] || {};
    if (solved) {
      next.scores = { ...m.scores, [team]: (m.scores?.[team] || 0) + 1 };
      next.state = "roundEnd";
      next.round = { ...next.round, winner: team, endsAt: nowSrv() + 6000 };
    } else if (guesses.length >= 6 && !other.solved && (other.guesses || []).length >= 6) {
      next.state = "roundEnd";
      next.round = { ...next.round, endsAt: nowSrv() + 6000 };
    }
    return next;
  }).then((res) => {
    if (res.committed) {
      $("guess-input").value = "";
      render();
    } else if (meta?.state === "playing") {
      rejectInput("Too slow — board changed, try again.");
    }
  });
});

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  claimHostIfAbandoned();

  // Watchdog: abort to lobby if fewer than 2 players, or a whole team is gone,
  // for more than 10s (grace covers a refresh).
  if (meta.state === "playing" || meta.state === "roundEnd") {
    const conn = Object.values(players).filter((p) => p.connected);
    const teamsOk = conn.some((p) => p.team === "red") && conn.some((p) => p.team !== "red");
    if (conn.length < 2 || !teamsOk) {
      lowPlayersSince ??= Date.now();
      if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) abortToLobby();
    } else {
      lowPlayersSince = null;
    }
  } else {
    lowPlayersSince = null;
  }

  // Advance past the round-end reveal: host at endsAt, anyone 4s later.
  if (meta.state === "roundEnd" && meta.round?.endsAt) {
    const n = nowSrv();
    if ((isHost() && n > meta.round.endsAt) || n > meta.round.endsAt + 4000) nextRound();
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
  if (isHost()) $("set-bestof").value = String(meta.settings.bestOf);
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderGame() {
  $("round-info").textContent = `Round ${meta.roundNum || 1} · Best of ${meta.settings.bestOf}`;
  $("score-display").innerHTML =
    `<span class="sc-red">🔴 ${meta.scores?.red || 0}</span> — ` +
    `<span class="sc-blue">${meta.scores?.blue || 0} 🔵</span>`;
  $("btn-giveup").classList.toggle("hidden", !(isHost() && meta.state === "playing"));

  const mine = myTeam(), opp = oppTeam();
  const myTitle = $("my-title"), oppTitle = $("opp-title");
  myTitle.textContent = mine === "red" ? "🔴 Red (your team)" : "🔵 Blue (your team)";
  myTitle.className = mine;
  oppTitle.textContent = opp === "red" ? "🔴 Red" : "🔵 Blue";
  oppTitle.className = opp;

  const reveal = meta.state !== "playing";
  renderBoard($("my-board"), mine, true, reveal);
  renderBoard($("opp-board"), opp, false, reveal);
  renderKeyboard();
  renderStatus();
  renderOverlay();
}

function renderBoard(el, team, isMine, revealLetters) {
  el.innerHTML = "";
  const answer = meta.round?.answer || "";
  const b = teamBoard(team);
  const guesses = b.guesses || [];
  const showLetters = isMine || revealLetters;
  const typing = $("guess-input").value.trim().toLowerCase();

  for (let row = 0; row < 6; row++) {
    const div = document.createElement("div");
    div.className = "brow";
    const g = guesses[row];
    if (g) {
      const colors = colorize(g.word, answer);
      for (let i = 0; i < 5; i++) {
        const t = document.createElement("div");
        t.className = `tile ${colors[i]}`;
        t.textContent = showLetters ? g.word[i] : "";
        div.appendChild(t);
      }
      if (showLetters && g.name) {
        const by = document.createElement("span");
        by.className = "by";
        by.textContent = g.name;
        div.appendChild(by);
      }
    } else {
      const isCurrent = isMine && meta.state === "playing" && !b.solved && row === guesses.length;
      if (isCurrent) div.classList.add("current");
      for (let i = 0; i < 5; i++) {
        const t = document.createElement("div");
        t.className = "tile" + (isCurrent && typing[i] ? " pending" : "");
        t.textContent = isCurrent ? (typing[i] || "") : "";
        div.appendChild(t);
      }
    }
    el.appendChild(div);
  }
}

function renderStatus() {
  const el = $("my-status");
  const form = $("guess-form");
  const input = $("guess-input");
  const b = teamBoard(myTeam());
  const guesses = b.guesses || [];
  let msg = " ", disabled = false;

  if (meta.state !== "playing") {
    disabled = true;
  } else if (b.solved) {
    msg = "🎉 Your team got it!";
    disabled = true;
  } else if (guesses.length >= 6) {
    msg = "Out of guesses — hoping the other team blows it too…";
    disabled = true;
  } else if (turnLocked(myTeam())) {
    msg = "You guessed last — let a teammate go.";
    disabled = true;
  } else {
    msg = `${6 - guesses.length} ${6 - guesses.length === 1 ? "guess" : "guesses"} left — anyone on your team can submit.`;
  }
  el.textContent = msg;
  input.disabled = disabled;
  form.querySelector("button").disabled = disabled;
}

const KB_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
function renderKeyboard() {
  const kb = $("kb");
  kb.innerHTML = "";
  const answer = meta.round?.answer || "";
  // Best-known state per letter from my team's guesses.
  const states = {};
  const rank = { absent: 1, present: 2, correct: 3 };
  for (const g of teamBoard(myTeam()).guesses || []) {
    const colors = colorize(g.word, answer);
    for (let i = 0; i < 5; i++) {
      const ch = g.word[i];
      if (!states[ch] || rank[colors[i]] > rank[states[ch]]) states[ch] = colors[i];
    }
  }
  KB_ROWS.forEach((row, ri) => {
    const div = document.createElement("div");
    div.className = "kb-row";
    if (ri === 2) div.appendChild(kbKey("⏎", "wide", () => $("guess-form").requestSubmit()));
    for (const ch of row) {
      div.appendChild(kbKey(ch, states[ch] || "", () => {
        const input = $("guess-input");
        if (!input.disabled && input.value.length < 5) {
          input.value += ch;
          render();
        }
      }));
    }
    if (ri === 2) div.appendChild(kbKey("⌫", "wide", () => {
      const input = $("guess-input");
      input.value = input.value.slice(0, -1);
      render();
    }));
    kb.appendChild(div);
  });
}
function kbKey(label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `kb-key ${cls}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

$("guess-input").addEventListener("input", () => {
  const input = $("guess-input");
  input.value = input.value.replace(/[^a-zA-Z]/g, "").slice(0, 5);
  render();
});

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");

  if (meta.state === "roundEnd") {
    ov.classList.remove("hidden");
    const w = meta.round?.winner;
    const head = w === "red" ? `<h2 class="winner-red">🔴 Red cracks it!</h2>`
      : w === "blue" ? `<h2 class="winner-blue">🔵 Blue cracks it!</h2>`
      : `<h2>😬 Nobody got it!</h2>`;
    box.innerHTML = `${head}
      <p>The word was</p>
      <div class="big-word">${esc(meta.round?.answer || "?")}</div>
      <p class="hint">Next round in a moment…</p>`;
  } else if (meta.state === "gameEnd") {
    ov.classList.remove("hidden");
    const red = meta.scores?.red || 0, blue = meta.scores?.blue || 0;
    const result = red === blue ? `<h2>🤝 It's a tie!</h2>`
      : red > blue ? `<h2 class="winner-red">🔴 Red Team wins!</h2>`
      : `<h2 class="winner-blue">🔵 Blue Team wins!</h2>`;
    box.innerHTML = `${result}
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

// ── Lobby interactions ────────────────────────────────────────────────────────
$("lobby-team-red").addEventListener("click", () => switchTeam("red"));
$("lobby-team-blue").addEventListener("click", () => switchTeam("blue"));
function switchTeam(team) {
  if (meta?.state !== "lobby") return;
  update(child(playersRef(), pid), { team });
}

$("btn-start").addEventListener("click", startGame);
$("set-bestof").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { bestOf: Number(e.target.value) }));

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
