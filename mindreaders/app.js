// Mind Readers — static client, synced through Firebase Realtime Database.
//
// Rounds alternate between two types:
//   'either' (odd rounds): a rotating spotlight player secretly picks their true
//     preference from an either/or; everyone else predicts it. Correct
//     predictors +10; the spotlight +3 per fooled predictor.
//   'likely' (even rounds): everyone votes which player is most likely to <X>;
//     voters who match the plurality +10; the chosen get a ⭐ badge.
// Individual scores. The host's client drives the state machine via whole-meta
// transactions, with host migration if they vanish.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { EITHER_OR, MOST_LIKELY } from "./prompts.js";

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
let votes = {};          // rooms/{code}/votes — { r1: {pid: choice}, ... }
let serverOffset = 0;
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const votesRef = () => ref(db, `rooms/${roomCode}/votes`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const isSpotlight = () => meta?.round?.spotlightId === pid;
const participating = () => (meta?.round?.participants || []).includes(pid);
const roundVotes = () => votes[`r${meta?.round?.num}`] || {};
const myVote = () => roundVotes()[pid];

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
      game: "mindreaders",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 12 },
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
    if (snap.val().game !== "mindreaders") {
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
    score: existing?.score || 0,
    spotlit: existing?.spotlit || 0,
    stars: existing?.stars || 0,
  });
  trackPresence(db, meRef);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
  onValue(votesRef(), (s) => { votes = s.val() || {}; render(); });
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

function pickUnused(listLength, used) {
  const free = [];
  for (let i = 0; i < listLength; i++) if (!used[`p${i}`]) free.push(i);
  const pool = free.length ? free : Array.from({ length: listLength }, (_, i) => i);
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickSpotlight(participants) {
  return [...participants].sort((a, b) =>
    (players[a]?.spotlit || 0) - (players[b]?.spotlit || 0) ||
    (players[a]?.joinedAt || 0) - (players[b]?.joinedAt || 0))[0];
}

// Builds the next round into a meta object. Runs inside transactions — uses the
// local `players` closure, which is the house-accepted pattern.
function buildRound(m, num) {
  const parts = Object.entries(players)
    .filter(([, p]) => p.connected)
    .map(([id]) => id);
  const base = {
    num,
    startedAt: nowSrv(),
    endsAt: nowSrv() + 30000,
    participants: parts,
  };
  if (num % 2 === 1) {
    const used = m.usedEither || {};
    const idx = pickUnused(EITHER_OR.length, used);
    return {
      ...m, state: "answering",
      usedEither: { ...used, [`p${idx}`]: true },
      round: { ...base, type: "either", promptIdx: idx, spotlightId: pickSpotlight(parts) },
    };
  }
  const used = m.usedLikely || {};
  const idx = pickUnused(MOST_LIKELY.length, used);
  return {
    ...m, state: "answering",
    usedLikely: { ...used, [`p${idx}`]: true },
    round: { ...base, type: "likely", promptIdx: idx },
  };
}

async function startGame() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < 3) { alert("Need at least 3 players — mind reading requires minds."); return; }

  // Reset BEFORE flipping state so stale scores can't leak into the new game.
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/score`] = 0;
    resets[`${id}/spotlit`] = 0;
    resets[`${id}/stars`] = 0;
  }
  await update(playersRef(), resets);
  await remove(votesRef());

  const res = await txMeta((m) => {
    if (m.state !== "lobby") return;
    return buildRound({ ...m, usedEither: null, usedLikely: null }, 1);
  });
  bumpSpotlit(res);
}

function bumpSpotlit(res) {
  const r = res?.committed && res.snapshot.val()?.round;
  if (r?.type === "either" && r.spotlightId) {
    runTransaction(ref(db, `rooms/${roomCode}/players/${r.spotlightId}/spotlit`), (v) => (v || 0) + 1);
  }
}

// Compute results from the local votes snapshot and flip answering→reveal in one
// transaction; the committing client then applies score transactions exactly once.
function revealRound(skipped) {
  const r = meta.round;
  const v = votes[`r${r.num}`] || {};
  const parts = r.participants || [];
  let results;
  const awards = [];   // [{id, pts}]
  let starWinners = [];

  if (r.type === "either") {
    const pick = v[r.spotlightId];
    if (skipped || pick == null) {
      results = { skipped: true };
    } else {
      const preds = Object.entries(v)
        .filter(([id]) => id !== r.spotlightId && parts.includes(id));
      const correct = preds.filter(([, c]) => c === pick).map(([id]) => id);
      const wrong = preds.filter(([, c]) => c !== pick).map(([id]) => id);
      results = { pick, correct, wrong };
      for (const id of correct) awards.push({ id, pts: 10 });
      if (wrong.length) awards.push({ id: r.spotlightId, pts: 3 * wrong.length });
    }
  } else {
    const tally = {};
    for (const [voter, target] of Object.entries(v)) {
      if (parts.includes(voter)) tally[target] = (tally[target] || 0) + 1;
    }
    const max = Math.max(0, ...Object.values(tally));
    const winners = max > 0 ? Object.keys(tally).filter((t) => tally[t] === max) : [];
    const scorers = Object.entries(v)
      .filter(([voter, target]) => parts.includes(voter) && winners.includes(target))
      .map(([voter]) => voter);
    results = { tally, winners, scorers };
    starWinners = winners;
    for (const id of scorers) awards.push({ id, pts: 10 });
  }

  txMeta((m) => {
    if (m.state !== "answering" || m.round?.num !== r.num) return;
    return { ...m, state: "reveal", round: { ...m.round, endsAt: nowSrv() + 8000, results } };
  }).then((res) => {
    if (!(res.committed && res.snapshot.val()?.state === "reveal")) return;
    for (const a of awards) {
      runTransaction(ref(db, `rooms/${roomCode}/players/${a.id}/score`), (x) => (x || 0) + a.pts);
    }
    for (const w of starWinners) {
      runTransaction(ref(db, `rooms/${roomCode}/players/${w}/stars`), (x) => (x || 0) + 1);
    }
  });
}

function nextRound() {
  const expect = meta.round?.num;
  if (expect == null) return;
  txMeta((m) => {
    if (m.state !== "reveal" || m.round?.num !== expect) return;
    if (expect >= m.settings.rounds) return { ...m, state: "gameEnd" };
    return buildRound(m, expect + 1);
  }).then(bumpSpotlit);
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedEither: null, usedLikely: null };
  }).then((res) => {
    if (res.committed) remove(votesRef());
  });
}

// ── Voting ────────────────────────────────────────────────────────────────────
function castVote(value) {
  const r = meta?.round;
  if (!r || meta.state !== "answering" || !participating()) return;
  set(ref(db, `rooms/${roomCode}/votes/r${r.num}/${pid}`), value);
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  // Watchdog: below 3 connected players mid-game for 10s → back to lobby.
  const active = meta.state === "answering" || meta.state === "reveal";
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 3) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => (m.state === "answering" || m.state === "reveal")
        ? { ...m, state: "lobby", round: null, usedEither: null, usedLikely: null }
        : undefined);
      return;
    }
  } else {
    lowPlayersSince = null;
  }

  if (!isHost()) return;
  const r = meta.round;
  if (!r?.endsAt) return;
  const n = nowSrv();
  const v = votes[`r${r.num}`] || {};
  const parts = (r.participants || []).filter((id) => players[id]?.connected);

  if (meta.state === "answering") {
    if (r.type === "either") {
      const spotGone = !players[r.spotlightId]?.connected;
      const spotPicked = v[r.spotlightId] != null;
      const others = parts.filter((id) => id !== r.spotlightId);
      const othersDone = others.every((id) => v[id] != null);
      if (spotGone) revealRound(true);
      else if (spotPicked && (othersDone || n > r.endsAt + 3000)) revealRound(false);
      else if (n > r.endsAt + 30000) revealRound(true); // AFK spotlight — skip
    } else {
      const allDone = parts.length && parts.every((id) => v[id] != null);
      if (allDone || n > r.endsAt + 3000) revealRound(false);
    }
  } else if (meta.state === "reveal" && n > r.endsAt) {
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
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const pname = (id) => esc(players[id]?.name || "someone");

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
  if (isHost()) $("set-rounds").value = String(meta.settings.rounds);
}

const sortedByJoin = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderGame() {
  const r = meta.round;
  $("round-info").textContent = r ? `Round ${r.num}/${meta.settings.rounds}` : "";
  $("type-label").textContent = !r ? "" :
    r.type === "either" ? "🅰️ Prefers this or that" : "🅱️ Who's most likely to…";

  renderScores();
  renderTimer();

  const view = $("view");
  const checklist = $("checklist");
  const overlay = $("overlay");

  if (meta.state === "gameEnd") {
    overlay.classList.remove("hidden");
    renderGameEnd();
    view.innerHTML = "";
    checklist.classList.add("hidden");
    return;
  }
  overlay.classList.add("hidden");
  if (!r) return;

  if (meta.state === "answering") {
    checklist.classList.remove("hidden");
    renderChecklist();
    if (!participating()) {
      view.innerHTML = `<div class="prompt-card"><h2>🍿 You're in!</h2>
        <p class="hint">You joined mid-round — you'll play (and be votable) from the next round.</p></div>`;
    } else if (r.type === "either") {
      renderEitherAnswering(r);
    } else {
      renderLikelyAnswering(r);
    }
  } else if (meta.state === "reveal") {
    checklist.classList.add("hidden");
    renderReveal(r);
  }
}

function renderScores() {
  const list = $("score-list");
  list.innerHTML = "";
  const rows = Object.entries(players)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  for (const [id, p] of rows) {
    const div = document.createElement("div");
    div.className = "score-row";
    if (!p.connected) div.classList.add("offline");
    if (id === pid) div.classList.add("me");
    const spot = meta.state === "answering" && meta.round?.spotlightId === id ? "🔦 " : "";
    const stars = p.stars ? ` <span class="stars">${"⭐".repeat(Math.min(p.stars, 5))}</span>` : "";
    div.innerHTML = `<span class="pname">${spot}${esc(p.name)}${id === pid ? " (you)" : ""}${stars}</span>
      <span class="pts">${p.score || 0}</span>`;
    list.appendChild(div);
  }
}

function renderChecklist() {
  const r = meta.round;
  const v = roundVotes();
  const ul = $("check-list");
  ul.innerHTML = "";
  for (const id of r.participants || []) {
    const p = players[id];
    if (!p) continue;
    const done = v[id] != null;
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : p.connected ? "🤔" : "💤"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
}

function renderEitherAnswering(r) {
  const prompt = EITHER_OR[r.promptIdx] || { a: "?", b: "?" };
  const spotlight = isSpotlight();
  const header = spotlight
    ? `<span class="eyebrow">🔦 You're in the spotlight — answer honestly!</span>
       <div class="prompt-text">Which is true for <span class="spot-name">you</span>?</div>`
    : `<span class="eyebrow">🔮 Read their mind</span>
       <div class="prompt-text">What will <span class="spot-name">${pname(r.spotlightId)}</span> pick?</div>`;
  $("view").innerHTML = `
    <div class="prompt-card">${header}</div>
    <div class="option-row">
      <button class="option-btn" data-v="a">${esc(prompt.a)}</button>
      <button class="option-btn" data-v="b">${esc(prompt.b)}</button>
    </div>
    <p class="hint">${myVote() ? "Locked in — you can still change your mind until time's up." : "Pick one."}</p>`;
  for (const b of $("view").querySelectorAll(".option-btn")) {
    if (b.dataset.v === myVote()) b.classList.add("selected");
    b.addEventListener("click", () => castVote(b.dataset.v));
  }
}

function renderLikelyAnswering(r) {
  const prompt = MOST_LIKELY[r.promptIdx] || "?";
  const targets = (r.participants || []).filter((id) => players[id]);
  $("view").innerHTML = `
    <div class="prompt-card">
      <span class="eyebrow">🗳️ The group decides</span>
      <div class="prompt-text">Who's most likely to… ${esc(prompt)}?</div>
    </div>
    <div class="target-grid"></div>
    <p class="hint">${myVote() ? "Vote cast — changeable until time's up. Match the majority to score." : "Vote for someone (yes, you can vote for yourself)."}</p>`;
  const grid = $("view").querySelector(".target-grid");
  for (const id of targets) {
    const b = document.createElement("button");
    b.className = "target-btn" + (myVote() === id ? " selected" : "");
    b.textContent = players[id].name + (id === pid ? " (you)" : "");
    b.addEventListener("click", () => castVote(id));
    grid.appendChild(b);
  }
}

function renderReveal(r) {
  const res = r.results || {};
  if (r.type === "either") {
    const prompt = EITHER_OR[r.promptIdx] || { a: "?", b: "?" };
    if (res.skipped) {
      $("view").innerHTML = `<div class="prompt-card reveal-card">
        <h2>😶 Round skipped</h2>
        <p class="hint">${pname(r.spotlightId)} never answered — the spotlight moves on.</p></div>`;
      return;
    }
    const pickText = res.pick === "a" ? prompt.a : prompt.b;
    const correctNames = (res.correct || []).map(pname).join(", ");
    const wrongNames = (res.wrong || []).map(pname).join(", ");
    $("view").innerHTML = `
      <div class="prompt-card reveal-card">
        <span class="eyebrow">${pname(r.spotlightId)} picked…</span>
        <div class="reveal-pick">${esc(pickText)}</div>
        <p class="reveal-list">${(res.correct || []).length
          ? `<span class="good">✅ Called it (+10):</span> <strong>${correctNames}</strong>`
          : "😱 Nobody called it!"}</p>
        <p class="reveal-list">${(res.wrong || []).length
          ? `🙈 Fooled (+3 each to ${pname(r.spotlightId)}): <strong>${wrongNames}</strong>`
          : "No one was fooled."}</p>
      </div>`;
  } else {
    const prompt = MOST_LIKELY[r.promptIdx] || "?";
    const tally = res.tally || {};
    const winners = res.winners || [];
    const maxV = Math.max(1, ...Object.values(tally));
    const rows = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const bars = rows.map(([id, n]) => `
      <div class="bar-row${winners.includes(id) ? " winner" : ""}">
        <span class="bar-name">${pname(id)}${winners.includes(id) ? " ⭐" : ""}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(n / maxV * 100)}%">${n}</div></div>
      </div>`).join("");
    const scorers = (res.scorers || []).map(pname).join(", ");
    $("view").innerHTML = `
      <div class="prompt-card reveal-card">
        <span class="eyebrow">Most likely to… ${esc(prompt)}</span>
        ${bars || `<p class="hint">Nobody voted. Awkward.</p>`}
        <p class="reveal-list">${scorers
          ? `<span class="good">🔮 Read the room (+10):</span> <strong>${scorers}</strong>`
          : "Nobody matched the majority."}</p>
      </div>`;
  }
}

function renderGameEnd() {
  const box = $("overlay-content");
  const rows = Object.entries(players)
    .filter(([, p]) => (p.score || 0) > 0 || p.connected)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  const medals = ["🥇", "🥈", "🥉"];
  const lis = rows.map(([id, p], i) =>
    `<li><span>${medals[i] || "·"} ${esc(p.name)}${id === pid ? " (you)" : ""}</span><strong>${p.score || 0}</strong></li>`).join("");
  const topStars = rows.reduce((best, [id, p]) =>
    (p.stars || 0) > (best?.[1]?.stars || 0) ? [id, p] : best, null);
  box.innerHTML = `
    <h2>🔮 The minds have been read</h2>
    <ul class="leaderboard">${lis}</ul>
    ${rows.length ? `<p class="crown-note">🔮 Top Mind Reader: <strong>${esc(rows[0][1].name)}</strong></p>` : ""}
    ${topStars && (topStars[1].stars || 0) > 0
      ? `<p class="crown-note">⭐ The group has spoken most about: <strong>${esc(topStars[1].name)}</strong></p>` : ""}
    ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
               : `<p class="hint">Waiting for the host…</p>`}
    <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
  box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
  box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || meta.state === "gameEnd" || meta.state === "lobby") {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", meta.state === "answering" && secs <= 8);
}

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
