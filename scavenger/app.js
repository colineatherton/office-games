// Scavenger Dash — the app is the klaxon, timer, and scoreboard; the fetching
// happens in real life and the video call camera is the referee.
// All state lives under rooms/{CODE}; phase transitions are whole-meta
// transactions and the client whose transaction lands in "results" applies
// scores exactly once.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, onDisconnect, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { PROMPTS } from "./prompts.js";

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

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// A participant was in the room when the round was dealt; later joiners spectate.
const participating = () =>
  meta?.round && me() && (me().joinedAt || 0) <= (meta.round.createdAt || Infinity);

// ── Screens ───────────────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["fetch", "vote", "results", "spectate"]) {
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
      game: "scavenger",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 8, fetchSeconds: 60 },
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
    if (snap.val().game !== "scavenger") {
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
    totalReturnMs: existing?.totalReturnMs || 0,
    returnCount: existing?.returnCount || 0,
  });
  onDisconnect(child(meRef, "connected")).set(false);

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

const keyify = (w) => w.replace(/[.#$/\[\]]/g, "_");

function pickPrompt(used = {}) {
  const fresh = PROMPTS.filter((p) => !used[keyify(p)]);
  const pool = fresh.length ? fresh : PROMPTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function makeRound(num, used) {
  const prompt = pickPrompt(used);
  const start = nowSrv() + 3500;
  return {
    round: {
      num, prompt,
      createdAt: nowSrv(),
      startAt: start,
      endsAt: start + (meta?.settings?.fetchSeconds || 60) * 1000,
    },
    usedKey: keyify(prompt),
  };
}

async function startGame() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < 3) { alert("Need at least 3 runners."); return; }

  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/score`] = 0;
    resets[`${id}/totalReturnMs`] = 0;
    resets[`${id}/returnCount`] = 0;
  }
  await update(playersRef(), resets);

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const prompt = pickPrompt({});
    const start = nowSrv() + 3500;
    return {
      ...m,
      state: "fetch",
      usedPrompts: { [keyify(prompt)]: true },
      round: {
        num: 1, prompt,
        createdAt: nowSrv(),
        startAt: start,
        endsAt: start + m.settings.fetchSeconds * 1000,
      },
    };
  });
}

// GOT IT — one return per player, ordered by transaction commit order.
function claimReturn() {
  txMeta((m) => {
    if (m.state !== "fetch" || !m.round) return;
    const n = nowSrv();
    if (n < m.round.startAt || n > m.round.endsAt) return;
    const returns = m.round.returns || {};
    if (returns[pid]) return;
    const order = Object.keys(returns).length + 1;
    return {
      ...m,
      round: {
        ...m.round,
        returns: { ...returns, [pid]: { ms: n - m.round.startAt, order } },
      },
    };
  });
}
$("btn-gotit").addEventListener("click", claimReturn);

const SPEED_PTS = [10, 7, 5];

function endFetch() {
  txMeta((m) => {
    if (m.state !== "fetch" || m.round?.num !== meta?.round?.num) return;
    const returns = m.round.returns || {};
    const ordered = Object.entries(returns).sort((a, b) => a[1].order - b[1].order);
    const roundPoints = {};
    ordered.forEach(([id], i) => { roundPoints[id] = SPEED_PTS[i] ?? 3; });
    if (ordered.length < 2) {
      return {
        ...m, state: "results",
        round: { ...m.round, roundPoints, skipVote: true, endsAt: nowSrv() + 8000 },
      };
    }
    return {
      ...m, state: "vote",
      round: { ...m.round, roundPoints, endsAt: nowSrv() + 45000 },
    };
  }).then((res) => {
    if (res.committed && res.snapshot.val()?.state === "results") applyScores(res.snapshot.val().round);
  });
}

function castVote(targetPid) {
  if (meta?.state !== "vote" || targetPid === pid) return;
  if (!meta.round?.returns?.[targetPid]) return;
  update(child(metaRef(), "round/votes"), { [pid]: targetPid });
}

function endVote() {
  txMeta((m) => {
    if (m.state !== "vote" || m.round?.num !== meta?.round?.num) return;
    const votes = m.round.votes || {};
    const tally = {};
    for (const t of Object.values(votes)) tally[t] = (tally[t] || 0) + 1;
    const max = Math.max(0, ...Object.values(tally));
    const winners = max > 0 ? Object.keys(tally).filter((t) => tally[t] === max) : [];
    const roundPoints = { ...(m.round.roundPoints || {}) };
    for (const w of winners) roundPoints[w] = (roundPoints[w] || 0) + 8;
    return {
      ...m, state: "results",
      round: { ...m.round, roundPoints, bestWinners: winners, endsAt: nowSrv() + 8000 },
    };
  }).then((res) => {
    if (res.committed && res.snapshot.val()?.state === "results") applyScores(res.snapshot.val().round);
  });
}

// Exactly-once by construction: only the client whose transaction committed the
// transition INTO "results" reaches this.
function applyScores(round) {
  for (const [id, pts] of Object.entries(round.roundPoints || {})) {
    if (pts) runTransaction(ref(db, `rooms/${roomCode}/players/${id}/score`), (v) => (v || 0) + pts);
  }
  for (const [id, r] of Object.entries(round.returns || {})) {
    runTransaction(ref(db, `rooms/${roomCode}/players/${id}/totalReturnMs`), (v) => (v || 0) + r.ms);
    runTransaction(ref(db, `rooms/${roomCode}/players/${id}/returnCount`), (v) => (v || 0) + 1);
  }
}

function nextRound() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "results" || m.round?.num !== expect) return;
    if (m.round.num >= m.settings.rounds) return { ...m, state: "gameEnd", round: null };
    const prompt = pickPrompt(m.usedPrompts || {});
    const start = nowSrv() + 3500;
    return {
      ...m,
      state: "fetch",
      usedPrompts: { ...(m.usedPrompts || {}), [keyify(prompt)]: true },
      round: {
        num: m.round.num + 1, prompt,
        createdAt: nowSrv(),
        startAt: start,
        endsAt: start + m.settings.fetchSeconds * 1000,
      },
    };
  });
}

function backToLobby() {
  txMeta((m) => (m.state === "gameEnd" ? { ...m, state: "lobby", round: null, usedPrompts: null } : undefined));
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = ["fetch", "vote", "results"].includes(meta.state);
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 3) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) {
      txMeta((m) => (["fetch", "vote", "results"].includes(m.state)
        ? { ...m, state: "lobby", round: null, usedPrompts: null } : undefined));
      return;
    }
  } else {
    lowPlayersSince = null;
  }

  if (!isHost() || !meta.round) return;
  const n = nowSrv();
  if (meta.state === "fetch") {
    const everyoneBack = eligibleIds().length > 0 &&
      eligibleIds().every((id) => meta.round.returns?.[id]);
    if (n > meta.round.endsAt || everyoneBack) endFetch();
  } else if (meta.state === "vote") {
    const allVoted = eligibleIds().every((id) => meta.round.votes?.[id]);
    if (n > meta.round.endsAt + 2000 || allVoted) endVote();
  } else if (meta.state === "results") {
    if (n > meta.round.endsAt) nextRound();
  }
}, 400);

// Connected players who were present when the round was dealt.
function eligibleIds() {
  if (!meta?.round) return [];
  return Object.entries(players)
    .filter(([, p]) => p.connected && (p.joinedAt || 0) <= (meta.round.createdAt || Infinity))
    .map(([id]) => id);
}

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

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function render() {
  if (!meta) return;
  if (meta.state === "lobby") {
    showScreen("lobby");
    renderLobby();
    return;
  }
  showScreen("game");
  renderGame();
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
  if (isHost()) {
    $("set-rounds").value = String(meta.settings.rounds);
    $("set-seconds").value = String(meta.settings.fetchSeconds);
  }
}

function renderGame() {
  const r = meta.round;
  $("round-info").textContent = r ? `Round ${r.num}/${meta.settings.rounds}` : "";
  $("phase-label").textContent =
    meta.state === "fetch" ? "🏃 FETCH!" :
    meta.state === "vote" ? "📸 Show & vote" :
    meta.state === "results" ? "📊 Results" : "";

  const overlay = $("overlay");
  if (meta.state === "gameEnd") {
    overlay.classList.remove("hidden");
    renderGameEnd();
    return;
  }
  overlay.classList.add("hidden");

  if (!r) return;
  if (!participating()) { showView("spectate"); return; }

  if (meta.state === "fetch") {
    showView("fetch");
    renderFetch();
  } else if (meta.state === "vote") {
    showView("vote");
    renderVote();
  } else if (meta.state === "results") {
    showView("results");
    renderResults();
  }
}

function renderFetch() {
  const r = meta.round;
  const n = nowSrv();
  const counting = n < r.startAt;
  $("countdown-overlay").classList.toggle("hidden", !counting);
  $("fetch-live").classList.toggle("hidden", counting);
  if (counting) {
    $("countdown-num").textContent = Math.max(1, Math.ceil((r.startAt - n) / 1000));
    return;
  }
  $("fetch-prompt").textContent = r.prompt;
  const mine = r.returns?.[pid];
  $("btn-gotit").disabled = !!mine || n > r.endsAt;
  $("gotit-note").classList.toggle("hidden", !mine);
  const frac = Math.max(0, Math.min(1, (r.endsAt - n) / (r.endsAt - r.startAt)));
  $("time-bar").style.width = `${frac * 100}%`;

  const feed = $("finish-feed");
  feed.innerHTML = "";
  const medals = ["🥇", "🥈", "🥉"];
  for (const [id, ret] of Object.entries(r.returns || {}).sort((a, b) => a[1].order - b[1].order)) {
    const div = document.createElement("div");
    div.className = "finish-row";
    div.innerHTML = `<span>${medals[ret.order - 1] || "🏃"} ${esc(players[id]?.name || "?")}</span>
                     <span class="ms">${(ret.ms / 1000).toFixed(1)}s</span>`;
    feed.appendChild(div);
  }
}

function renderVote() {
  const r = meta.round;
  $("vote-prompt").textContent = `The mission was: ${r.prompt}`;
  const wrap = $("vote-cards");
  wrap.innerHTML = "";
  const myVote = r.votes?.[pid];
  const medals = ["🥇", "🥈", "🥉"];
  for (const [id, ret] of Object.entries(r.returns || {}).sort((a, b) => a[1].order - b[1].order)) {
    const card = document.createElement("div");
    card.className = "vote-card" + (id === pid ? " own" : "") + (myVote === id ? " selected" : "");
    card.innerHTML = `<div class="vc-name">${esc(players[id]?.name || "?")}${id === pid ? " (you)" : ""}</div>
                      <div class="vc-meta">${medals[ret.order - 1] || "🏃"} ${(ret.ms / 1000).toFixed(1)}s</div>`;
    if (id !== pid) card.addEventListener("click", () => castVote(id));
    wrap.appendChild(card);
  }
  const voted = Object.keys(r.votes || {}).length;
  $("vote-status").textContent = `${voted}/${eligibleIds().length} votes in`;
}

function renderResults() {
  const r = meta.round;
  const rows = $("results-rows");
  rows.innerHTML = "";
  const returned = Object.keys(r.returns || {});
  $("results-title").textContent = `Round ${r.num}: ${r.prompt}`;

  if (!returned.length) {
    rows.innerHTML = `<p class="mockery">Nobody came back. Are you all still running? 🫠</p>`;
  } else {
    const medals = ["🥇", "🥈", "🥉"];
    for (const [id, ret] of Object.entries(r.returns).sort((a, b) => a[1].order - b[1].order)) {
      const pts = r.roundPoints?.[id] || 0;
      const best = (r.bestWinners || []).includes(id) ? " 🏆 best item" : "";
      const div = document.createElement("div");
      div.className = "result-row" + (pts ? "" : " zero");
      div.innerHTML = `<span>${medals[ret.order - 1] || "🏃"} ${esc(players[id]?.name || "?")}${best}</span>
                       <span class="pts">+${pts}</span>`;
      rows.appendChild(div);
    }
    if (r.skipVote) {
      const p = document.createElement("p");
      p.className = "mockery";
      p.textContent = "Not enough returners for a style vote. The rest of you: reflect.";
      rows.appendChild(p);
    }
  }
  $("results-leaderboard").innerHTML = leaderboardHtml();
}

function leaderboardHtml() {
  return sortedByScore().map(([id, p], i) =>
    `<div class="lb-row${id === pid ? " me" : ""}">
       <span>${i === 0 ? "👑 " : ""}${esc(p.name)}${id === pid ? " (you)" : ""}</span>
       <span class="score">${p.score || 0}</span>
     </div>`).join("");
}

const sortedByScore = () =>
  Object.entries(players).sort((a, b) => (b[1].score || 0) - (a[1].score || 0));

function renderGameEnd() {
  const box = $("overlay-content");
  const board = sortedByScore();
  const champ = board[0];
  let fastest = null;
  for (const [id, p] of Object.entries(players)) {
    if (!p.returnCount) continue;
    const avg = p.totalReturnMs / p.returnCount;
    if (!fastest || avg < fastest.avg) fastest = { id, name: p.name, avg };
  }
  box.innerHTML = `
    <h2>🏁 That's a wrap!</h2>
    ${champ ? `<p class="crown-line">🏆 Champion: ${esc(champ[1].name)} (${champ[1].score || 0} pts)</p>` : ""}
    ${fastest ? `<p class="crown-line">🏎️ Fastest average return: ${esc(fastest.name)} (${(fastest.avg / 1000).toFixed(1)}s)</p>` : ""}
    <div class="final-board">${leaderboardHtml()}</div>
    ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
               : `<p class="hint">Waiting for the host…</p>`}
    <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
  box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
  box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r || meta.state === "gameEnd" || meta.state === "lobby") {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const n = nowSrv();
  const target = meta.state === "fetch" && n < r.startAt ? r.startAt : r.endsAt;
  const secs = Math.max(0, Math.ceil((target - n) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", meta.state === "fetch" && n >= r.startAt && secs <= 10);
  // Keep the fetch view's countdown/bar fresh between DB events.
  if (meta.state === "fetch" && participating()) renderFetch();
}

// ── Lobby interactions ────────────────────────────────────────────────────────
$("btn-start").addEventListener("click", startGame);
$("set-rounds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { rounds: Number(e.target.value) }));
$("set-seconds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { fetchSeconds: Number(e.target.value) }));

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
