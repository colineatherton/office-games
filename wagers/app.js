// Wits & Wagers — estimate a number, then bet on whose estimate is closest
// without going over. Static client synced through Firebase Realtime Database.
// Phase flow (lobby → estimating → betting → results → … → gameEnd) is driven
// by the host's client via whole-meta transactions, telephone-style: clients
// auto-submit on timeout, the host advances when everyone has submitted or
// after a grace period.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, onDisconnect, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { QUESTIONS } from "./questions.js";

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
let roundsData = {};
let serverOffset = 0;
let loadedRound = -1;
let submittedLocal = false;
let lowPlayersSince = null;
let animatedRound = -1;

const MIN_PLAYERS = 3;
const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const roundsRef = () => ref(db, `rooms/${roomCode}/rounds`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// ── Screens / views ───────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["estimate", "bet", "results", "end"]) {
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
      game: "wagers",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 7 },
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
    if (snap.val().game !== "wagers") {
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
    score: existing?.score ?? 0,
    estRound: existing?.estRound ?? -1,
    betRound: existing?.betRound ?? -1,
  });
  onDisconnect(child(meRef, "connected")).set(false);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
  onValue(roundsRef(), (s) => { roundsData = s.val() || {}; render(); });
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

function pickQuestion(used = {}) {
  let pool = QUESTIONS.map((_, i) => i).filter((i) => !used[i]);
  if (!pool.length) { used = {}; pool = QUESTIONS.map((_, i) => i); }
  const qIdx = pool[Math.floor(Math.random() * pool.length)];
  return { qIdx, used: { ...used, [qIdx]: true } };
}

async function startGame() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < MIN_PLAYERS) return;

  // Reset BEFORE flipping state so stale markers can't instantly advance round 1.
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/score`] = 0;
    resets[`${id}/estRound`] = -1;
    resets[`${id}/betRound`] = -1;
  }
  await update(playersRef(), resets);
  await remove(roundsRef());

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const { qIdx, used } = pickQuestion({});
    return {
      ...m,
      state: "estimating",
      usedQ: used,
      round: { num: 1, qIdx, endsAt: nowSrv() + 45000 },
    };
  });
}

function advanceToBetting() {
  const n = meta.round?.num;
  txMeta((m) => {
    if (m.state !== "estimating" || m.round?.num !== n) return;
    return { ...m, state: "betting", round: { ...m.round, endsAt: nowSrv() + 30000 } };
  });
}

function advanceToResults() {
  const n = meta.round?.num;
  const qIdx = meta.round?.qIdx;
  txMeta((m) => {
    if (m.state !== "betting" || m.round?.num !== n) return;
    return { ...m, state: "results", round: { ...m.round, endsAt: nowSrv() + 10000 } };
  }).then((res) => {
    // Exactly-once scoring: only the client whose transaction committed applies it.
    if (res.committed && res.snapshot.val()?.state === "results") applyScores(n, qIdx);
  });
}

function nextRound() {
  const n = meta.round?.num;
  txMeta((m) => {
    if (m.state !== "results" || m.round?.num !== n) return;
    if (m.round.num >= m.settings.rounds) return { ...m, state: "gameEnd" };
    const { qIdx, used } = pickQuestion(m.usedQ || {});
    return {
      ...m,
      state: "estimating",
      usedQ: used,
      round: { num: m.round.num + 1, qIdx, endsAt: nowSrv() + 45000 },
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedQ: null };
  }).then((res) => { if (res.committed) remove(roundsRef()); });
}

// ── Winner computation (deterministic — every client agrees) ─────────────────
function computeWinKey(n, qIdx) {
  const ests = roundsData[n]?.estimates || {};
  const answer = QUESTIONS[qIdx].answer;
  const values = [...new Set(Object.values(ests).map((e) => e.v))];
  const cands = values.filter((v) => v <= answer);
  return cands.length ? String(Math.max(...cands)) : "low";
}

function applyScores(n, qIdx) {
  const winKey = computeWinKey(n, qIdx);
  const ests = roundsData[n]?.estimates || {};
  const bets = roundsData[n]?.bets || {};
  for (const [id, e] of Object.entries(ests)) {
    if (String(e.v) === winKey) bumpScore(id, 10);
  }
  for (const [id, b] of Object.entries(bets)) {
    if (b.card === winKey) bumpScore(id, 10);
  }
}

function bumpScore(id, pts) {
  runTransaction(ref(db, `rooms/${roomCode}/players/${id}/score`), (v) => (v || 0) + pts);
}

// ── Submitting ────────────────────────────────────────────────────────────────
function parseEstimate() {
  const digits = $("estimate-input").value.replace(/[^0-9]/g, "");
  return digits ? Number(digits) : null;
}

function submitEstimate(auto) {
  if (!meta || meta.state !== "estimating" || hasEstimated()) return;
  const n = meta.round.num;
  const v = parseEstimate();
  if (v === null && !auto) { $("estimate-input").focus(); return; }
  submittedLocal = true;
  if (v !== null) {
    set(ref(db, `rooms/${roomCode}/rounds/${n}/estimates/${pid}`), { v, name: me()?.name || "?" });
  }
  update(child(playersRef(), pid), { estRound: n });
  render();
}

function placeBet(cardKey) {
  if (!meta || meta.state !== "betting") return;
  const n = meta.round.num;
  set(ref(db, `rooms/${roomCode}/rounds/${n}/bets/${pid}`), { card: cardKey, name: me()?.name || "?" });
  update(child(playersRef(), pid), { betRound: n });
}

const hasEstimated = () => submittedLocal || (me()?.estRound ?? -1) >= (meta?.round?.num ?? 0);
const myBet = () => {
  const n = meta?.round?.num;
  return roundsData[n]?.bets?.[pid]?.card ?? null;
};

$("btn-submit-estimate").addEventListener("click", () => submitEstimate(false));
$("estimate-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitEstimate(false); });
$("estimate-input").addEventListener("input", () => {
  const digits = $("estimate-input").value.replace(/[^0-9]/g, "").slice(0, 15);
  $("estimate-input").value = digits ? Number(digits).toLocaleString("en-US") : "";
});

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = ["estimating", "betting", "results"].includes(meta.state);
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < MIN_PLAYERS - 1) { // allow finishing a game at 2, abort below that
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) {
      txMeta((m) => active ? { ...m, state: "lobby", round: null, usedQ: null } : undefined);
    }
  } else {
    lowPlayersSince = null;
  }

  if (!active) return;
  const n = nowSrv();
  const r = meta.round;
  if (!r?.endsAt) return;

  // Auto-submit my estimate at the deadline.
  if (meta.state === "estimating" && !hasEstimated() && n > r.endsAt) submitEstimate(true);

  if (!isHost()) return;
  const everyone = (marker) => Object.values(players)
    .filter((p) => p.connected)
    .every((p) => (p[marker] ?? -1) >= r.num);

  if (meta.state === "estimating" && (everyone("estRound") || n > r.endsAt + 3000)) advanceToBetting();
  else if (meta.state === "betting" && (everyone("betRound") || n > r.endsAt + 3000)) advanceToResults();
  else if (meta.state === "results" && n > r.endsAt) nextRound();
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
function render() {
  if (!meta) return;
  if (meta.state === "lobby") {
    loadedRound = -1;
    showScreen("lobby");
    renderLobby();
    return;
  }
  showScreen("game");

  const r = meta.round;
  if (r && r.num !== loadedRound) {
    loadedRound = r.num;
    submittedLocal = false;
    $("estimate-input").value = "";
  }

  $("round-info").textContent = r ? `Round ${r.num}/${meta.settings.rounds}` : "";
  const q = r ? QUESTIONS[r.qIdx] : null;

  if (meta.state === "estimating") {
    $("phase-label").textContent = "✍️ Estimate!";
    $("estimate-question").textContent = q.question;
    const done = hasEstimated();
    $("estimate-input").disabled = done;
    $("btn-submit-estimate").disabled = done;
    $("estimate-done").classList.toggle("hidden", !done);
    renderChecklist($("estimate-checklist"), "estRound");
    showView("estimate");
  } else if (meta.state === "betting") {
    $("phase-label").textContent = "💰 Place your bet!";
    $("bet-question").textContent = q.question;
    renderBetCards();
    renderChecklist($("bet-checklist"), "betRound");
    showView("bet");
  } else if (meta.state === "results") {
    $("phase-label").textContent = "📣 The answer is…";
    renderResults();
    showView("results");
  } else if (meta.state === "gameEnd") {
    $("phase-label").textContent = "🏁 Final standings";
    renderEnd();
    showView("end");
  }
  renderTimer();
}

function renderLobby() {
  $("lobby-code").textContent = roomCode;
  const ul = $("lobby-player-list");
  ul.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    const li = document.createElement("li");
    li.textContent = `${p.name}${meta.hostId === id ? " 👑" : ""}${id === pid ? " (you)" : ""}`;
    if (id === pid) li.classList.add("me");
    ul.appendChild(li);
  }
  const connCount = Object.values(players).filter((p) => p.connected).length;
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) {
    $("set-rounds").value = String(meta.settings.rounds);
    $("btn-start").disabled = connCount < MIN_PLAYERS;
    $("start-hint").classList.toggle("hidden", connCount >= MIN_PLAYERS);
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderChecklist(ul, marker) {
  ul.innerHTML = "";
  const n = meta.round?.num;
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    const done = (p[marker] ?? -1) >= n;
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : "⏳"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
}

// Build the card list for the current round: "lower than all" + sorted unique
// estimates with merged authors.
function buildCards(n) {
  const ests = roundsData[n]?.estimates || {};
  const byValue = new Map();
  for (const e of Object.values(ests)) {
    if (!byValue.has(e.v)) byValue.set(e.v, []);
    byValue.get(e.v).push(e.name);
  }
  const cards = [{ key: "low", label: "⬇️ Lower than all of them", authors: [] }];
  for (const v of [...byValue.keys()].sort((a, b) => a - b)) {
    cards.push({ key: String(v), label: v.toLocaleString("en-US"), authors: byValue.get(v) });
  }
  return cards;
}

function renderBetCards() {
  const n = meta.round.num;
  const wrap = $("bet-cards");
  wrap.innerHTML = "";
  const bets = roundsData[n]?.bets || {};
  const bettorsByCard = {};
  for (const b of Object.values(bets)) {
    (bettorsByCard[b.card] ??= []).push(b.name);
  }
  const mine = myBet();
  const myEst = roundsData[n]?.estimates?.[pid]?.v;

  for (const c of buildCards(n)) {
    const div = document.createElement("div");
    div.className = "est-card";
    if (c.key === mine) div.classList.add("selected");
    if (myEst !== undefined && String(myEst) === c.key) div.classList.add("mine");
    div.innerHTML = `
      <div class="value">${esc(c.label)}</div>
      <div class="authors">${c.authors.length ? esc(c.authors.join(", ")) : "&nbsp;"}</div>
      <div class="bettors">${bettorsByCard[c.key] ? "💰 " + esc(bettorsByCard[c.key].join(", ")) : ""}</div>`;
    div.addEventListener("click", () => placeBet(c.key));
    wrap.appendChild(div);
  }
}

function renderResults() {
  const n = meta.round.num;
  const q = QUESTIONS[meta.round.qIdx];
  $("results-question").textContent = q.question;
  $("answer-source").textContent = q.source ? `(${q.source})` : "";

  if (animatedRound !== n) {
    animatedRound = n;
    animateCount($("answer-reveal"), q.answer, 1200);
  }

  const winKey = computeWinKey(n, meta.round.qIdx);
  const bets = roundsData[n]?.bets || {};
  const bettorsByCard = {};
  for (const b of Object.values(bets)) (bettorsByCard[b.card] ??= []).push(b.name);

  const wrap = $("results-cards");
  wrap.innerHTML = "";
  for (const c of buildCards(n)) {
    const div = document.createElement("div");
    div.className = "est-card static";
    if (c.key === winKey) div.classList.add("winner");
    else if (c.key !== "low" && Number(c.key) > q.answer) div.classList.add("over");
    div.innerHTML = `
      <div class="value">${esc(c.label)}</div>
      <div class="authors">${c.authors.length ? esc(c.authors.join(", ")) : "&nbsp;"}</div>
      <div class="bettors">${bettorsByCard[c.key] ? "💰 " + esc(bettorsByCard[c.key].join(", ")) : ""}</div>`;
    wrap.appendChild(div);
  }

  const scorers = [];
  const ests = roundsData[n]?.estimates || {};
  for (const e of Object.values(ests)) if (String(e.v) === winKey) scorers.push(`${e.name} +10 (best estimate)`);
  for (const b of Object.values(bets)) if (b.card === winKey) scorers.push(`${b.name} +10 (winning bet)`);
  $("round-scorers").innerHTML = scorers.length
    ? scorers.map((s) => `<div class="scorer">🏅 ${esc(s)}</div>`).join("")
    : `<div class="noscore">Nobody scored. Bold strategy.</div>`;
}

function animateCount(el, target, ms) {
  const start = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - start) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(target * eased).toLocaleString("en-US");
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderEnd() {
  const ol = $("leaderboard");
  ol.innerHTML = "";
  const ranked = sortedPlayers()
    .filter(([, p]) => p.connected || (p.score || 0) > 0)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  ranked.forEach(([id, p], i) => {
    const li = document.createElement("li");
    if (i === 0) li.classList.add("first");
    li.innerHTML = `<span>${i === 0 ? "🏆 " : ""}${esc(p.name)}${id === pid ? " (you)" : ""}</span><span class="pts">${p.score || 0}</span>`;
    ol.appendChild(li);
  });
  const bar = $("end-controls");
  bar.innerHTML = "";
  if (isHost()) {
    const b = document.createElement("button");
    b.className = "btn primary big";
    b.textContent = "Back to lobby";
    b.addEventListener("click", backToLobby);
    bar.appendChild(b);
  } else {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Waiting for the host…";
    bar.appendChild(p);
  }
  const leave = document.createElement("button");
  leave.className = "btn small ghost";
  leave.textContent = "Leave room";
  leave.addEventListener("click", leaveRoom);
  bar.appendChild(leave);
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || !["estimating", "betting", "results"].includes(meta.state)) {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", meta.state !== "results" && secs <= 10);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── Lobby interactions ────────────────────────────────────────────────────────
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
