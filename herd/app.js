// Herd Mentality — everyone answers the same prompt; the biggest group of
// matching answers scores. Synced through Firebase RTDB following the house
// conventions (whole-meta transactions, host-driven advancement, watchdogs).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
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

const WIN_SCORE = 8;
const ANSWER_SECONDS = 30;
const RESULTS_SECONDS = 9;
const MIN_PLAYERS = 3;

let roomCode = null;
let meta = null;
let players = {};
let serverOffset = 0;
let advancing = false;
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
const myAnswered = () => (me()?.answeredRound || 0) >= (meta?.round?.num || 1);

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// ── Screens & views ───────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["answer", "wait", "results", "end"]) {
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
      game: "herd",
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
    if (snap.val().game !== "herd") {
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
    answeredRound: existing?.answeredRound || 0,
  });
  trackPresence(db, meRef);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; if (meta) render(); });
}

function leaveRoom() {
  if (roomCode) set(ref(db, `rooms/${roomCode}/players/${pid}/connected`), false);
  location.hash = "";
  location.reload();
}
$("btn-leave-lobby").addEventListener("click", leaveRoom);
$("btn-leave-end").addEventListener("click", leaveRoom);

// ── State machine ─────────────────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function pickPrompt(used = {}) {
  let pool = PROMPTS.filter((p) => !used[keyify(p)]);
  let newUsed = { ...used };
  if (!pool.length) { pool = PROMPTS; newUsed = {}; }
  const prompt = pool[Math.floor(Math.random() * pool.length)];
  newUsed[keyify(prompt)] = true;
  return { prompt, used: newUsed };
}
const keyify = (s) => s.replace(/[.#$/\[\]]/g, "_").slice(0, 60);

async function startGame() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < MIN_PLAYERS) { alert(`Need at least ${MIN_PLAYERS} players.`); return; }

  // Reset BEFORE flipping state so stale answeredRound/score can't leak in.
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/score`] = 0;
    resets[`${id}/answeredRound`] = 0;
  }
  await update(playersRef(), resets);
  await remove(answersRef());

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const { prompt, used } = pickPrompt({});
    return {
      ...m,
      state: "answering",
      usedPrompts: used,
      cowPid: null,
      round: { num: 1, prompt, endsAt: nowSrv() + ANSWER_SECONDS * 1000 },
    };
  });
}

function submitAnswer(auto = false) {
  if (!meta || meta.state !== "answering" || !me() || myAnswered()) return;
  const text = $("answer-input").value.trim().slice(0, 40);
  if (!text && !auto) { $("answer-input").focus(); return; }
  set(ref(db, `rooms/${roomCode}/answers/${meta.round.num}/${pid}`), {
    text, name: me().name,
  });
  update(child(playersRef(), pid), { answeredRound: meta.round.num });
}

$("btn-submit").addEventListener("click", () => submitAnswer(false));
$("answer-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAnswer(false); });

// Group answers: normalize, bucket, then merge near-identical buckets.
const normalize = (s) => s.toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9 ]/g, "")
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

function computeGroups(answers) {
  const buckets = new Map(); // norm -> {text, members: [{pid, name}]}
  for (const [id, a] of Object.entries(answers)) {
    const norm = normalize(a.text || "");
    if (!norm) continue;
    if (!buckets.has(norm)) buckets.set(norm, { text: a.text.trim(), members: [] });
    buckets.get(norm).members.push({ pid: id, name: a.name || "?" });
  }
  // Merge buckets whose keys are within edit distance 1 (both ≥4 chars).
  const keys = [...buckets.keys()].sort();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i], b = keys[j];
      if (!buckets.has(a) || !buckets.has(b)) continue;
      if (a.length >= 4 && b.length >= 4 && lev1(a, b)) {
        buckets.get(a).members.push(...buckets.get(b).members);
        buckets.delete(b);
      }
    }
  }
  return [...buckets.values()]
    .sort((x, y) => y.members.length - x.members.length || x.text.localeCompare(y.text));
}

async function advanceToResults() {
  if (advancing || !meta) return;
  advancing = true;
  try {
    const num = meta.round.num;
    const snap = await get(ref(db, `rooms/${roomCode}/answers/${num}`));
    const groups = computeGroups(snap.val() || {});
    const maxSize = groups[0]?.members.length || 0;
    const winners = maxSize > 0
      ? groups.filter((g) => g.members.length === maxSize).flatMap((g) => g.members.map((m) => m.pid))
      : [];
    // Pink Cow: exactly one lone wolf while everyone else found a group.
    const singles = groups.filter((g) => g.members.length === 1);
    const cow = (groups.length > 1 && singles.length === 1) ? singles[0].members[0].pid : null;

    const res = await txMeta((m) => {
      if (m.state !== "answering" || m.round?.num !== num) return;
      return {
        ...m,
        state: "results",
        cowPid: cow ?? m.cowPid ?? null,
        round: { ...m.round, endsAt: nowSrv() + RESULTS_SECONDS * 1000, groups, winners },
      };
    });
    if (res.committed && res.snapshot.val()?.state === "results") {
      for (const w of winners) {
        runTransaction(ref(db, `rooms/${roomCode}/players/${w}/score`), (v) => (v || 0) + 1);
      }
    }
  } finally {
    advancing = false;
  }
}

function nextRound() {
  const expect = meta?.round?.num;
  const topScore = Math.max(0, ...Object.values(players).map((p) => p.score || 0));
  txMeta((m) => {
    if (m.state !== "results" || m.round?.num !== expect) return;
    if (topScore >= WIN_SCORE || m.round.num >= m.settings.rounds) {
      return { ...m, state: "gameEnd" };
    }
    const { prompt, used } = pickPrompt(m.usedPrompts || {});
    return {
      ...m,
      state: "answering",
      usedPrompts: used,
      round: { num: m.round.num + 1, prompt, endsAt: nowSrv() + ANSWER_SECONDS * 1000 },
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedPrompts: null, cowPid: null };
  }).then((res) => {
    if (res.committed) remove(answersRef());
  });
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = meta.state === "answering" || meta.state === "results";
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < MIN_PLAYERS) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => (m.state === "answering" || m.state === "results")
        ? { ...m, state: "lobby", round: null, usedPrompts: null, cowPid: null }
        : undefined);
    }
  } else {
    lowPlayersSince = null;
  }

  const r = meta.round;
  if (!r?.endsAt) return;
  const n = nowSrv();

  if (meta.state === "answering") {
    if (!myAnswered() && me()?.connected !== false && n > r.endsAt) submitAnswer(true);
    if (isHost()) {
      const allDone = Object.entries(players).every(([, p]) =>
        !p.connected || (p.answeredRound || 0) >= r.num);
      if (allDone || n > r.endsAt + 3000) advanceToResults();
    }
  } else if (meta.state === "results") {
    if (isHost() && n > r.endsAt) nextRound();
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
let renderedRound = -1;

function render() {
  if (!meta) return;
  if (meta.state === "lobby") {
    renderedRound = -1;
    showScreen("lobby");
    renderLobby();
    return;
  }
  showScreen("game");
  renderGame();
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderLobby() {
  $("lobby-code").textContent = roomCode;
  const ul = $("lobby-player-list");
  ul.innerHTML = "";
  let count = 0;
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    count++;
    const li = document.createElement("li");
    li.textContent = `${p.name}${meta.hostId === id ? " 👑" : ""}${id === pid ? " (you)" : ""}`;
    if (id === pid) li.classList.add("me");
    ul.appendChild(li);
  }
  $("lobby-count").textContent = `(${count})`;
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) $("set-rounds").value = String(meta.settings.rounds);
}

function renderGame() {
  const r = meta.round;
  $("round-info").textContent = r ? `Round ${r.num}/${meta.settings.rounds}` : "";
  $("top-label").textContent =
    meta.state === "answering" ? "🐑 Think like the herd…" :
    meta.state === "results" ? "📊 The herd has spoken" : "🏁 Game over";

  renderScoreboard();

  if (meta.state === "answering") {
    if (r.num !== renderedRound) {
      renderedRound = r.num;
      $("answer-input").value = "";
      $("prompt-text").textContent = r.prompt;
    }
    if (myAnswered()) {
      $("wait-prompt").textContent = `“${r.prompt}”`;
      renderWaitList();
      showView("wait");
    } else {
      showView("answer");
      $("answer-input").focus();
    }
  } else if (meta.state === "results") {
    renderResults();
    showView("results");
  } else if (meta.state === "gameEnd") {
    renderEnd();
    showView("end");
  }
  renderTimer();
}

function renderScoreboard() {
  const box = $("scoreboard");
  box.innerHTML = "";
  const rows = Object.entries(players)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0) || (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  for (const [id, p] of rows) {
    const div = document.createElement("div");
    div.className = "score-row";
    if (!p.connected) div.classList.add("offline");
    if (id === pid) div.classList.add("me");
    const cow = meta.cowPid === id ? `<span class="cow" title="Pink Cow — last one to stand alone">🐄</span>` : "";
    div.innerHTML = `<span class="pname">${esc(p.name)}${id === pid ? " (you)" : ""}</span>${cow}<span class="pts">${p.score || 0}</span>`;
    box.appendChild(div);
  }
}

function renderWaitList() {
  const ul = $("wait-list");
  ul.innerHTML = "";
  for (const [, p] of sortedPlayers()) {
    if (!p.connected) continue;
    const done = (p.answeredRound || 0) >= meta.round.num;
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : "💭"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
}

function renderResults() {
  const r = meta.round;
  $("results-prompt").textContent = r.prompt;
  const box = $("groups");
  box.innerHTML = "";
  const groups = r.groups || [];
  if (!groups.length) {
    box.innerHTML = `<p class="hint">Nobody answered. The herd is asleep. 😴</p>`;
    return;
  }
  const maxSize = groups[0].members.length;
  for (const g of groups) {
    const div = document.createElement("div");
    const isHerd = g.members.length === maxSize && maxSize > 0;
    div.className = "group-card" + (isHerd ? " herd" : "") + (g.members.length === 1 ? " lone" : "");
    div.innerHTML = `
      <div class="answer-line">
        <span class="answer-text">${esc(g.text)}</span>
        <span class="count">× ${g.members.length}</span>
      </div>
      <div class="members">${g.members.map((m) => esc(m.name)).join(", ")}</div>`;
    box.appendChild(div);
  }
}

function renderEnd() {
  const box = $("leaderboard");
  box.innerHTML = "";
  const rows = Object.entries(players)
    .filter(([, p]) => (p.score || 0) > 0 || p.connected)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0) || (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  const medals = ["🥇", "🥈", "🥉"];
  const topScore = rows[0]?.[1].score || 0;
  rows.forEach(([id, p], i) => {
    const div = document.createElement("div");
    div.className = "lb-row" + ((p.score || 0) === topScore && topScore > 0 ? " winner" : "");
    const cow = meta.cowPid === id ? " 🐄" : "";
    div.innerHTML = `<span class="medal">${medals[i] || ""}</span>
      <span class="pname">${esc(p.name)}${id === pid ? " (you)" : ""}${cow}</span>
      <span class="pts">${p.score || 0}</span>`;
    box.appendChild(div);
  });
  $("btn-again").classList.toggle("hidden", !isHost());
  $("end-waiting").classList.toggle("hidden", isHost());
}
$("btn-again").addEventListener("click", backToLobby);

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
