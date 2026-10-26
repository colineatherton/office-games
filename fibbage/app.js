// Fibbage — static client, synced through Firebase Realtime Database.
//
// Each round every player sees a true fact with its key word blanked out and
// submits a convincing fake answer. All the fakes plus the real answer are
// shuffled and everyone votes for the truth: +100 for finding it, +50 to a
// lie's author for every player they fooled. Individual scores, no teams.
// The host's client advances the phase state machine (lying → voting →
// results → next round), guarded by whole-meta transactions.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { QUESTIONS, DECOYS } from "./questions.js";

const $ = (id) => document.getElementById(id);

const LIE_SECONDS = 60;
const VOTE_SECONDS = 45;
const RESULTS_SECONDS = 9;
const MIN_PLAYERS = 3;

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
let rounds = {};        // rounds/{n}/{lies,votes}
let serverOffset = 0;
let loadedPhase = "";   // "state:roundNum" — resets local UI on change
let liedLocal = false;
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const roundsRef = () => ref(db, `rooms/${roomCode}/rounds`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const participating = () => (meta?.order || []).includes(pid);
const curQ = () => QUESTIONS[meta?.qIndex] || { question: "…", answer: "" };
const curRound = () => rounds?.[meta?.roundNum] || {};
const iLied = () => liedLocal || (me()?.liedRound || 0) >= (meta?.roundNum || 1);
const iVoted = () => (me()?.votedRound || 0) >= (meta?.roundNum || 1);

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// ── Screens & views ───────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["lie", "vote", "results", "end", "wait", "spectate"]) {
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
      game: "fibbage",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 8 },
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
    if (snap.val().game !== "fibbage") {
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
    liedRound: existing?.liedRound || 0,
    votedRound: existing?.votedRound || 0,
  });
  trackPresence(db, meRef);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
  onValue(roundsRef(), (s) => { rounds = s.val() || {}; render(); });
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

function pickQuestion(used = {}) {
  let fresh = QUESTIONS.map((_, i) => i).filter((i) => !used[i]);
  if (!fresh.length) { used = {}; fresh = QUESTIONS.map((_, i) => i); }
  const qIndex = rand(fresh);
  return { qIndex, usedQ: { ...used, [qIndex]: true } };
}

async function startGame() {
  const order = Object.entries(players)
    .filter(([, p]) => p.connected)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
    .map(([id]) => id);
  if (order.length < MIN_PLAYERS) {
    alert(`Need at least ${MIN_PLAYERS} players — with fewer there's nobody to fool.`);
    return;
  }

  // Reset scores/submissions BEFORE flipping state, so stale values from a
  // previous game can't instantly auto-advance round 1.
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/score`] = 0;
    resets[`${id}/liedRound`] = 0;
    resets[`${id}/votedRound`] = 0;
  }
  await update(playersRef(), resets);
  await remove(roundsRef());

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const { qIndex, usedQ } = pickQuestion({});
    return {
      ...m,
      state: "lying",
      order,
      roundNum: 1,
      totalRounds: Number(m.settings.rounds) || 8,
      qIndex, usedQ,
      endsAt: nowSrv() + LIE_SECONDS * 1000,
    };
  });
}

function advanceToVoting() {
  const expect = meta?.roundNum;
  txMeta((m) => {
    if (m.state !== "lying" || m.roundNum !== expect) return;
    return {
      ...m,
      state: "voting",
      seed: Math.floor(Math.random() * 1e9),
      endsAt: nowSrv() + VOTE_SECONDS * 1000,
    };
  });
}

function advanceToResults() {
  const expect = meta?.roundNum;
  txMeta((m) => {
    if (m.state !== "voting" || m.roundNum !== expect) return;
    return { ...m, state: "results", endsAt: nowSrv() + RESULTS_SECONDS * 1000 };
  }).then((res) => {
    // Only the client whose transaction committed applies the scores — exactly once.
    if (res.committed && res.snapshot.val()?.state === "results") applyScores(expect);
  });
}

function applyScores(n) {
  const lies = rounds?.[n]?.lies || {};
  const votes = rounds?.[n]?.votes || {};
  const addScore = (id, pts) =>
    runTransaction(ref(db, `rooms/${roomCode}/players/${id}/score`), (v) => (v || 0) + pts);
  for (const [voter, key] of Object.entries(votes)) {
    if (key === "truth") addScore(voter, 100);
    else if (key !== voter && lies[key] != null) addScore(key, 50);
  }
}

function advanceRound() {
  const expect = meta?.roundNum;
  txMeta((m) => {
    if (m.state !== "results" || m.roundNum !== expect) return;
    if (m.roundNum >= m.totalRounds) return { ...m, state: "gameEnd", endsAt: null };
    const { qIndex, usedQ } = pickQuestion(m.usedQ || {});
    return {
      ...m,
      state: "lying",
      roundNum: m.roundNum + 1,
      qIndex, usedQ,
      endsAt: nowSrv() + LIE_SECONDS * 1000,
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return {
      ...m, state: "lobby",
      order: null, roundNum: null, totalRounds: null,
      qIndex: null, usedQ: null, seed: null, endsAt: null,
    };
  }).then((res) => {
    if (res.committed) remove(roundsRef());
  });
}

// ── Lies & votes ──────────────────────────────────────────────────────────────
const normalize = (s) => s.toLowerCase().normalize("NFD")
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

function tooCloseToTruth(lie, truth) {
  if (!lie || !truth) return false;
  if (lie === truth) return true;
  if (levenshtein(lie, truth) <= 1) return true;
  // "the unicorn" vs "unicorn" etc. — containment counts for non-trivial answers
  if (truth.length > 3 && (lie.includes(truth) || truth.includes(lie))) return true;
  return false;
}

function submitLie(text) {
  if (!meta || meta.state !== "lying" || !participating() || iLied()) return;
  liedLocal = true;
  const n = meta.roundNum;
  set(ref(db, `rooms/${roomCode}/rounds/${n}/lies/${pid}`), text);
  update(child(playersRef(), pid), { liedRound: n });
  render();
}

$("btn-submit-lie").addEventListener("click", () => trySubmitLie(false));
$("lie-input").addEventListener("keydown", (e) => { if (e.key === "Enter") trySubmitLie(false); });

function trySubmitLie(auto) {
  let text = $("lie-input").value.trim();
  const truth = normalize(curQ().answer);
  if (!auto) {
    if (!text) { $("lie-input").focus(); return; }
    if (tooCloseToTruth(normalize(text), truth)) {
      $("lie-warning").classList.remove("hidden");
      $("lie-input").value = "";
      $("lie-input").focus();
      return;
    }
  } else if (!text || tooCloseToTruth(normalize(text), truth)) {
    // Timed out — sub in a canned decoy that isn't accidentally the truth.
    const safe = DECOYS.filter((d) => !tooCloseToTruth(normalize(d), truth));
    text = rand(safe.length ? safe : DECOYS);
  }
  submitLie(text);
}

function castVote(key) {
  if (!meta || meta.state !== "voting" || !participating() || key === pid) return;
  const n = meta.roundNum;
  set(ref(db, `rooms/${roomCode}/rounds/${n}/votes/${pid}`), key);
  update(child(playersRef(), pid), { votedRound: n });
}

// Deterministic shuffle so every client shows the cards in the same order.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCards() {
  const lies = curRound().lies || {};
  const cards = [
    { key: "truth", text: curQ().answer },
    ...Object.keys(lies).sort().map((k) => ({ key: k, text: lies[k] })),
  ];
  const rng = mulberry32(meta.seed || 1);
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = ["lying", "voting", "results"].includes(meta.state);
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < MIN_PLAYERS) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => ["lying", "voting", "results"].includes(m.state)
        ? {
            ...m, state: "lobby",
            order: null, roundNum: null, totalRounds: null,
            qIndex: null, usedQ: null, seed: null, endsAt: null,
          }
        : undefined);
      return;
    }
  } else {
    lowPlayersSince = null;
  }

  if (!active || !meta.endsAt) return;
  const n = nowSrv();

  // Auto-submit a decoy lie when time runs out.
  if (meta.state === "lying" && participating() && !iLied() && n > meta.endsAt) {
    trySubmitLie(true);
  }

  if (!isHost()) return;
  const everyone = (pred) => (meta.order || []).every((id) => {
    const p = players[id];
    return !p?.connected || pred(p);
  });

  if (meta.state === "lying") {
    if (everyone((p) => (p.liedRound || 0) >= meta.roundNum) || n > meta.endsAt + 3000) {
      advanceToVoting();
    }
  } else if (meta.state === "voting") {
    if (everyone((p) => (p.votedRound || 0) >= meta.roundNum) || n > meta.endsAt + 3000) {
      advanceToResults();
    }
  } else if (meta.state === "results") {
    if (n > meta.endsAt) advanceRound();
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

const questionHtml = () =>
  esc(curQ().question).replace("___", `<span class="blank">______</span>`);

function render() {
  if (!meta) return;
  if (meta.state === "lobby") {
    loadedPhase = "";
    showScreen("lobby");
    renderLobby();
    return;
  }
  showScreen("game");

  const phase = `${meta.state}:${meta.roundNum || 0}`;
  if (phase !== loadedPhase) {
    loadedPhase = phase;
    liedLocal = false;
    $("lie-input").value = "";
    $("lie-warning").classList.add("hidden");
  }

  $("round-info").textContent =
    meta.state === "gameEnd" ? "Game over" : `Round ${meta.roundNum}/${meta.totalRounds}`;
  $("phase-label").textContent =
    meta.state === "lying" ? "✍️ Write a lie" :
    meta.state === "voting" ? "🗳️ Spot the truth" :
    meta.state === "results" ? "📊 Results" : "🏆 Final scores";

  if (meta.state === "gameEnd") { renderEnd(); showView("end"); return; }
  if (meta.state === "results") { renderResults(); showView("results"); return; }
  if (!participating()) { showView("spectate"); return; }

  if (meta.state === "lying") {
    if (iLied()) {
      renderWaitList($("wait-list"), (p) => (p.liedRound || 0) >= meta.roundNum);
      showView("wait");
    } else {
      $("lie-question").innerHTML = questionHtml();
      showView("lie");
      renderWaitList($("lie-wait-list"), (p) => (p.liedRound || 0) >= meta.roundNum);
    }
  } else if (meta.state === "voting") {
    renderVoting();
    showView("vote");
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
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) $("set-rounds").value = String(meta.settings.rounds);
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderWaitList(ul, isDone) {
  ul.innerHTML = "";
  for (const id of meta.order || []) {
    const p = players[id];
    if (!p) continue;
    const done = isDone(p);
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : p.connected ? "✏️" : "💤"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
}

function renderVoting() {
  $("vote-question").innerHTML = questionHtml();
  const wrap = $("vote-cards");
  wrap.innerHTML = "";
  const myVote = curRound().votes?.[pid];
  for (const card of buildCards()) {
    const b = document.createElement("button");
    b.className = "card";
    b.innerHTML = esc(card.text);
    if (card.key === pid) {
      b.classList.add("mine");
      b.innerHTML += `<span class="tag">YOUR LIE</span>`;
    } else {
      if (myVote === card.key) b.classList.add("selected");
      b.addEventListener("click", () => castVote(card.key));
    }
    wrap.appendChild(b);
  }
  renderWaitList($("vote-wait-list"), (p) => (p.votedRound || 0) >= meta.roundNum);
}

function renderResults() {
  $("results-question").innerHTML = questionHtml();
  const wrap = $("results-cards");
  wrap.innerHTML = "";
  const lies = curRound().lies || {};
  const votes = curRound().votes || {};
  const votersFor = (key) => Object.entries(votes)
    .filter(([, k]) => k === key)
    .map(([voter]) => esc(players[voter]?.name || "?"));

  for (const card of buildCards()) {
    const div = document.createElement("div");
    div.className = "card reveal" + (card.key === "truth" ? " truth" : "");
    const fooled = votersFor(card.key);
    if (card.key === "truth") {
      div.innerHTML = `${esc(card.text)} <span class="tag-truth">✔ THE TRUTH</span>
        <span class="meta-line">${fooled.length
          ? `Found by ${fooled.join(", ")} <span class="pts">+100 each</span>`
          : "Nobody found it! 😈"}</span>`;
    } else {
      const author = esc(players[card.key]?.name || "?");
      div.innerHTML = `${esc(card.text)}
        <span class="meta-line">${author}'s lie${fooled.length
          ? ` — fooled ${fooled.join(", ")} <span class="pts">+${fooled.length * 50}</span>`
          : " — fooled no one"}</span>`;
    }
    wrap.appendChild(div);
  }

  const scores = $("results-scores");
  scores.innerHTML = "";
  for (const [id, p] of standings()) {
    const span = document.createElement("span");
    span.innerHTML = `<strong>${esc(p.name)}</strong> ${p.score || 0}`;
    if (id === pid) span.style.color = "var(--accent)";
    scores.appendChild(span);
  }
}

const standings = () => Object.entries(players)
  .filter(([id]) => (meta.order || []).includes(id))
  .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));

function renderEnd() {
  const ol = $("end-leaderboard");
  ol.innerHTML = "";
  standings().forEach(([id, p], i) => {
    const li = document.createElement("li");
    const medal = ["🥇", "🥈", "🥉"][i] || "·";
    li.innerHTML = `<span>${medal} ${esc(p.name)}${id === pid ? " (you)" : ""}</span>
      <span class="score">${p.score || 0}</span>`;
    ol.appendChild(li);
  });

  const controls = $("end-controls");
  controls.innerHTML = "";
  if (isHost()) {
    const again = document.createElement("button");
    again.className = "btn primary big";
    again.textContent = "Back to lobby";
    again.addEventListener("click", backToLobby);
    controls.appendChild(again);
  } else {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Waiting for the host…";
    controls.appendChild(p);
  }
  const leave = document.createElement("button");
  leave.className = "btn small ghost";
  leave.textContent = "Leave room";
  leave.addEventListener("click", leaveRoom);
  controls.appendChild(leave);
}

function renderTimer() {
  const el = $("timer");
  const timed = ["lying", "voting", "results"].includes(meta?.state);
  if (!timed || !meta.endsAt) {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((meta.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", meta.state !== "results" && secs <= 10);
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
