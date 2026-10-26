// Finish the Line — fill the missing word in famous song titles.
// All game state lives under rooms/{CODE} in RTDB; every client renders from it.
// The host's client advances rounds (telephone-style submit pattern); scoring
// happens exactly once inside the answering→reveal transaction.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { SONGS } from "./songs.js";

const $ = (id) => document.getElementById(id);

const ANSWER_MS = 25000;
const REVEAL_MS = 7000;

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
let allAnswers = {};     // rooms/{code}/answers — {roundNum: {pid: {text, secsLeft}}}
let serverOffset = 0;
let submittedLocal = false;
let lastRenderedRound = -1;
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const answersRef = () => ref(db, `rooms/${roomCode}/answers`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const currentQ = () => meta?.deck?.[(meta.round?.num || 1) - 1];
const iAnswered = () =>
  submittedLocal || (me()?.answeredRound ?? -1) >= (meta?.round?.num ?? 1);

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// ── Screens ───────────────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["answer", "wait", "reveal"]) {
    $(`view-${v}`).classList.toggle("hidden", v !== name);
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
      game: "lyrics",
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
    if (snap.val().game !== "lyrics") {
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
    answeredRound: existing?.answeredRound ?? -1,
  });
  trackPresence(db, meRef);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
  onValue(answersRef(), (s) => { allAnswers = s.val() || {}; render(); });
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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function startGame() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < 2) { alert("Need at least 2 players to start."); return; }

  const customs = shuffle(parseCustom($("custom-input").value).ok);
  const builtins = shuffle(SONGS);

  // Reset submissions BEFORE flipping state so stale answeredRound values from
  // a previous game can't instantly auto-advance round 1.
  const resets = {};
  for (const id of Object.keys(players)) resets[`${id}/answeredRound`] = -1;
  await update(playersRef(), resets);
  await remove(answersRef());

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const deck = [...customs, ...builtins].slice(0, m.settings.rounds);
    return {
      ...m,
      state: "answering",
      scores: { red: 0, blue: 0 },
      deck,
      totalRounds: deck.length,
      round: { num: 1, endsAt: nowSrv() + ANSWER_MS },
    };
  });
}

function advanceToReveal() {
  const num = meta.round.num;
  const roundAnswers = allAnswers?.[num] || {};
  txMeta((m) => {
    if (m.state !== "answering" || m.round?.num !== num) return;
    const q = m.deck[num - 1];
    let red = 0, blue = 0;
    for (const [id, a] of Object.entries(roundAnswers)) {
      if (!isCorrect(a.text, q.answer)) continue;
      const pts = answerPoints(a);
      if (players[id]?.team === "blue") blue += pts; else red += pts;
    }
    return {
      ...m,
      state: "reveal",
      scores: { red: (m.scores?.red || 0) + red, blue: (m.scores?.blue || 0) + blue },
      round: { ...m.round, endsAt: nowSrv() + REVEAL_MS },
    };
  });
}

function nextRound() {
  const num = meta.round.num;
  txMeta((m) => {
    if (m.state !== "reveal" || m.round?.num !== num) return;
    if (num >= m.totalRounds) return { ...m, state: "gameEnd" };
    return { ...m, state: "answering", round: { num: num + 1, endsAt: nowSrv() + ANSWER_MS } };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, deck: null, totalRounds: null };
  }).then((res) => {
    if (res.committed) remove(answersRef());
  });
}

// ── Answering & scoring ───────────────────────────────────────────────────────
const normalize = (s) => String(s || "").toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9 ]/g, "")
  .replace(/\s+/g, " ").trim();

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function isCorrect(guess, answer) {
  const g = normalize(guess), a = normalize(answer);
  if (!g) return false;
  if (g === a) return true;
  // One-typo tolerance, but only for answers long enough that it can't collide.
  return a.length >= 4 && levenshtein(g, a) <= 1;
}

const answerPoints = (a) => 20 + Math.min(25, a.secsLeft || 0);

function submitAnswer(auto = false) {
  if (!meta || meta.state !== "answering" || iAnswered()) return;
  const text = $("answer-input").value.trim();
  if (!text && !auto) { $("answer-input").focus(); return; }
  submittedLocal = true;
  const num = meta.round.num;
  const secsLeft = Math.max(0, Math.ceil((meta.round.endsAt - nowSrv()) / 1000));
  set(ref(db, `rooms/${roomCode}/answers/${num}/${pid}`), { text, secsLeft });
  update(child(playersRef(), pid), { answeredRound: num });
  render();
}

$("btn-submit-answer").addEventListener("click", () => submitAnswer(false));
$("answer-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAnswer(false); });

// ── Custom questions (host, lobby) ────────────────────────────────────────────
function parseCustom(text) {
  const ok = [], bad = [];
  (text || "").split("\n").forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    const parts = t.split("|").map((p) => p.trim());
    const [prompt, answer, hint] = parts;
    const valid =
      parts.length >= 2 && parts.length <= 3 &&
      prompt && (prompt.match(/___/g) || []).length === 1 &&
      answer && answer.split(/\s+/).length <= 3;
    if (valid) ok.push({ prompt, answer, hint: hint || "" });
    else bad.push(i + 1);
  });
  return { ok, bad };
}

$("custom-input").value = localStorage.getItem("lyrics_custom") || "";
$("custom-input").addEventListener("input", () => {
  localStorage.setItem("lyrics_custom", $("custom-input").value);
  renderCustomFeedback();
});

function renderCustomFeedback() {
  const { ok, bad } = parseCustom($("custom-input").value);
  const el = $("custom-feedback");
  if (!ok.length && !bad.length) { el.textContent = ""; el.className = "hint small-hint"; return; }
  el.textContent = `${ok.length} custom question${ok.length === 1 ? "" : "s"} ready` +
    (bad.length ? ` — line${bad.length === 1 ? "" : "s"} ${bad.join(", ")} ignored (need: prompt with one ___ | answer | hint)` : "");
  el.className = "hint small-hint " + (bad.length ? "warn" : "ok");
}
renderCustomFeedback();

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  // Watchdog: a game can't run with fewer than 2 players — return everyone to
  // the lobby after a 10s grace (covers a player refreshing their browser).
  const active = meta.state === "answering" || meta.state === "reveal";
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => (m.state === "answering" || m.state === "reveal")
        ? { ...m, state: "lobby", round: null, deck: null, totalRounds: null }
        : undefined);
    }
  } else {
    lowPlayersSince = null;
  }

  const r = meta.round;
  if (!r?.endsAt) return;
  const n = nowSrv();

  // Auto-submit whatever is typed when time runs out.
  if (meta.state === "answering" && !iAnswered() && n > r.endsAt) submitAnswer(true);

  if (isHost()) {
    if (meta.state === "answering") {
      const allDone = Object.values(players).every((p) =>
        !p.connected || (p.answeredRound ?? -1) >= r.num);
      if (allDone || n > r.endsAt + 3000) advanceToReveal();
    } else if (meta.state === "reveal" && n > r.endsAt) {
      nextRound();
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
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function render() {
  if (!meta) return;
  if (meta.state === "lobby") {
    lastRenderedRound = -1;
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

function renderGame() {
  const r = meta.round;
  const q = currentQ();
  $("round-info").textContent = r ? `Round ${r.num}/${meta.totalRounds}` : "";
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;

  if (r && r.num !== lastRenderedRound) {
    lastRenderedRound = r.num;
    submittedLocal = false;
    $("answer-input").value = "";
  }

  if (meta.state === "answering" && q) {
    $("overlay").classList.add("hidden");
    if (iAnswered()) {
      renderWaitList();
      showView("wait");
    } else {
      $("prompt-hint").textContent = `🎵 ${q.hint || "mystery artist"}`;
      $("prompt-text").innerHTML = esc(q.prompt).replace("___", `<span class="blank">&nbsp;</span>`);
      showView("answer");
      $("answer-input").focus();
    }
  } else if (meta.state === "reveal" && q) {
    $("overlay").classList.add("hidden");
    renderReveal(q, r.num);
    showView("reveal");
  } else if (meta.state === "gameEnd") {
    renderGameEnd();
  }
  renderTimer();
}

function renderWaitList() {
  const ul = $("wait-list");
  ul.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    const done = (p.answeredRound ?? -1) >= meta.round.num;
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : "✏️"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
}

function renderReveal(q, num) {
  $("reveal-hint").textContent = `🎵 ${q.hint || ""}`;
  $("reveal-title").innerHTML =
    esc(q.prompt).replace("___", `<span class="filled">${esc(q.answer)}</span>`);

  const lists = { red: $("reveal-red"), blue: $("reveal-blue") };
  lists.red.innerHTML = "";
  lists.blue.innerHTML = "";
  const roundAnswers = allAnswers?.[num] || {};
  for (const [id, p] of sortedPlayers()) {
    const a = roundAnswers[id];
    if (!a && !p.connected) continue;
    const right = a && isCorrect(a.text, q.answer);
    const li = document.createElement("li");
    if (right) li.classList.add("right");
    li.innerHTML = `
      <span class="pname">${right ? "✓" : "✗"} ${esc(p.name)}</span>
      <span class="ans">${a?.text ? esc(a.text) : "—"}</span>
      <span class="pts">${right ? "+" + answerPoints(a) : ""}</span>`;
    (lists[p.team] || lists.red).appendChild(li);
  }
}

function renderGameEnd() {
  const ov = $("overlay");
  const box = $("overlay-content");
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
    ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
               : `<p class="hint">Waiting for the host…</p>`}
    <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
  box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
  box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || (meta.state !== "answering" && meta.state !== "reveal")) {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", meta.state === "answering" && secs <= 5);
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
