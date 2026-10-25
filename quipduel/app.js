// Quip Duel — Quiplash-style head-to-head joke writing, synced through Firebase RTDB.
// With N players, each round deals N prompts; prompt i is answered by order[i] and
// order[(i+1) % N], so everyone writes exactly two answers and every prompt gets a
// head-to-head face-off. The room votes between the two anonymous answers.
// A "#CODE-screen" hash joins as a 📺 Big Screen: a non-player spectator renderer
// meant to be screen-shared in the call. It is never added to players, so it can
// never block an advance, claim host, or trip a watchdog.

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
let isBigScreen = false;
let meta = null;
let players = {};
let answers = {};   // { r1: { p0: { pid: {text} } }, final: { pid: {text} } }
let votes = {};     // { r1: { p0: { voterPid: authorPid } }, final: { voterPid: authorPid } }
let serverOffset = 0;
let lowPlayersSince = null;
let submittedSlots = [false, false];
let submittedFinal = false;
let loadedPhaseKey = "";

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const answersRef = () => ref(db, `rooms/${roomCode}/answers`);
const votesRef = () => ref(db, `rooms/${roomCode}/votes`);
const me = () => players[pid];
const isHost = () => !isBigScreen && meta?.hostId === pid;
const participating = () => !isBigScreen && (meta?.order || []).includes(pid);

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const PLACEHOLDER = "…awkward silence";

// ── Screens ───────────────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game", "bigscreen"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["writing", "finalwrite", "faceoff", "finalvote", "wait", "spectate"]) {
    $(`view-${v}`).classList.toggle("hidden", v !== name);
  }
}

// ── Boot: player vs Big Screen ────────────────────────────────────────────────
const screenMatch = location.hash.match(/^#([a-z]{4})-screen$/i);
if (screenMatch) {
  isBigScreen = true;
  bootBigScreen(screenMatch[1].toUpperCase());
} else {
  $("name-input").value = localStorage.getItem("pg_name") || "";
  if (location.hash.length > 1) $("code-input").value = location.hash.slice(1, 5).toUpperCase();
  showScreen("join");
}

async function bootBigScreen(code) {
  roomCode = code;
  showScreen("bigscreen");
  $("bs-content").innerHTML = `<h1 class="bs-title">💬 Quip <span>Duel</span></h1><p class="bs-sub">Connecting…</p>`;
  try {
    const snap = await get(metaRef());
    if (!snap.exists() || snap.val().game !== "quipduel") {
      $("bs-content").innerHTML = `<h1 class="bs-title">💬 Quip <span>Duel</span></h1><p class="bs-sub">Room ${esc(code)} not found.</p>`;
      return;
    }
    subscribe();
  } catch (e) {
    $("bs-content").innerHTML = `<p class="bs-sub">Couldn't reach the database. (${esc(e.message)})</p>`;
  }
}

// ── Join screen ───────────────────────────────────────────────────────────────
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

$("btn-create")?.addEventListener("click", async () => {
  const name = myName(); if (!name) return;
  joinError("");
  try {
    const code = randCode();
    await set(ref(db, `rooms/${code}/meta`), {
      game: "quipduel",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 2 },
    });
    await enterRoom(code, name);
  } catch (e) {
    joinError("Couldn't reach the database. Check the Firebase config and your network. (" + e.message + ")");
  }
});

$("btn-join")?.addEventListener("click", async () => {
  const name = myName(); if (!name) return;
  const code = $("code-input").value.trim().toUpperCase();
  if (code.length !== 4) { joinError("Room codes are 4 letters."); return; }
  joinError("");
  try {
    const snap = await get(metaRefFor(code));
    if (!snap.exists()) { joinError(`Room ${code} not found.`); return; }
    if (snap.val().game !== "quipduel") {
      joinError(`Room ${code} is a ${snap.val().game || "different"} room — join it from that game's page.`);
      return;
    }
    await enterRoom(code, name);
  } catch (e) {
    joinError("Couldn't reach the database. Check the Firebase config and your network. (" + e.message + ")");
  }
});
const metaRefFor = (code) => ref(db, `rooms/${code}/meta`);

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
  });
  onDisconnect(child(meRef, "connected")).set(false);
  subscribe();
}

function subscribe() {
  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
  onValue(answersRef(), (s) => { answers = s.val() || {}; render(); });
  onValue(votesRef(), (s) => { votes = s.val() || {}; render(); });
}

function leaveRoom() {
  if (roomCode) set(ref(db, `rooms/${roomCode}/players/${pid}/connected`), false);
  location.hash = "";
  location.reload();
}
$("btn-leave-lobby")?.addEventListener("click", leaveRoom);

// ── Prompt pairing helpers ────────────────────────────────────────────────────
const promptAuthors = (i) => {
  const o = meta.order;
  return [o[i], o[(i + 1) % o.length]];
};
const myPromptIdxs = () => {
  const o = meta.order;
  const m = o.indexOf(pid);
  if (m < 0) return [];
  return [m, (m - 1 + o.length) % o.length];
};
const cardOrder = (i) => {
  const [a, b] = promptAuthors(i);
  return mulberry32((meta.round.seed || 1) + i * 7919)() < 0.5 ? [a, b] : [b, a];
};
const faceoffAnswer = (i, authorPid) => {
  const t = answers[`r${meta.round.num}`]?.[`p${i}`]?.[authorPid]?.text;
  return t && t.trim() ? t : null;
};

function findFaceoff(from) {
  const N = meta.order.length;
  for (let i = from; i < N; i++) {
    const [a, b] = promptAuthors(i);
    if (faceoffAnswer(i, a) || faceoffAnswer(i, b)) return i;
  }
  return null;
}

// ── State-machine transactions ────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function pickPromptIdxs(count, used) {
  let pool = PROMPTS.map((_, i) => i).filter((i) => !used[`i${i}`]);
  if (pool.length < count) { used = {}; pool = PROMPTS.map((_, i) => i); }
  const picked = [];
  const newUsed = { ...used };
  for (let k = 0; k < count; k++) {
    const j = Math.floor(Math.random() * pool.length);
    const idx = pool.splice(j, 1)[0];
    picked.push(idx);
    newUsed[`i${idx}`] = true;
  }
  return { picked, used: newUsed };
}

async function startGame() {
  const order = Object.entries(players)
    .filter(([, p]) => p.connected)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
    .map(([id]) => id);
  if (order.length < 3) { alert("Quip Duel needs at least 3 players (voters make the jokes matter)."); return; }

  // Pre-reset before flipping state so stale flags can't leak into round 1.
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/score`] = 0;
    resets[`${id}/wroteRound`] = 0;
    resets[`${id}/wroteFinal`] = false;
  }
  await update(playersRef(), resets);
  await remove(answersRef());
  await remove(votesRef());

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const { picked, used } = pickPromptIdxs(order.length, m.usedPrompts || {});
    return {
      ...m,
      state: "writing",
      order,
      usedPrompts: used,
      round: {
        num: 1,
        prompts: picked,
        seed: Math.floor(Math.random() * 1e9),
        endsAt: nowSrv() + 120000,
      },
    };
  });
}

function startNextRound(num) {
  return txMeta((m) => {
    if (m.state !== "voting" || m.round?.num !== num - 1) return;
    const { picked, used } = pickPromptIdxs(m.order.length, m.usedPrompts || {});
    return {
      ...m, state: "writing", usedPrompts: used,
      round: { num, prompts: picked, seed: Math.floor(Math.random() * 1e9), endsAt: nowSrv() + 120000 },
    };
  });
}

function startFinal() {
  return txMeta((m) => {
    if (m.state !== "voting") return;
    const { picked, used } = pickPromptIdxs(1, m.usedPrompts || {});
    return {
      ...m, state: "finalWriting", usedPrompts: used,
      round: { final: true, prompt: picked[0], endsAt: nowSrv() + 60000 },
    };
  });
}

function advanceWritingToVoting() {
  const num = meta.round.num;
  const first = findFaceoff(0);
  if (first === null) {
    // Nobody wrote anything at all — enter a zero-length reveal so the normal
    // reveal→next path (next round or Grand Final) takes over.
    txMeta((m) => (m.state === "writing" && m.round?.num === num)
      ? { ...m, state: "voting", round: { ...m.round, voteIdx: -1, votePhase: "reveal", endsAt: nowSrv() } }
      : undefined);
    return;
  }
  txMeta((m) => {
    if (m.state !== "writing" || m.round?.num !== num) return;
    return { ...m, state: "voting", round: { ...m.round, voteIdx: first, votePhase: "vote", endsAt: nowSrv() + 20000 } };
  });
}

function advanceVoteToReveal() {
  const r = meta.round;
  const i = r.voteIdx;
  const [a, b] = promptAuthors(i);
  const vmap = votes[`r${r.num}`]?.[`p${i}`] || {};
  let ca = 0, cb = 0;
  for (const v of Object.values(vmap)) { if (v === a) ca++; else if (v === b) cb++; }
  const total = ca + cb;
  const winner = ca === cb ? null : (ca > cb ? a : b);
  const loserVotes = Math.min(ca, cb);
  const ko = !!winner && total >= 3 && loserVotes === 0;
  const pts = {};
  if (ca > 0) pts[a] = ca * 10;
  if (cb > 0) pts[b] = cb * 10;
  if (ko) pts[winner] = (pts[winner] || 0) + 30;

  txMeta((m) => {
    if (m.state !== "voting" || m.round?.num !== r.num ||
        m.round.voteIdx !== i || m.round.votePhase !== "vote") return;
    return {
      ...m,
      round: {
        ...m.round, votePhase: "reveal", endsAt: nowSrv() + 8000,
        reveal: { tally: { [a]: ca, [b]: cb }, winner: winner || "", ko, pts },
      },
    };
  }).then((res) => {
    if (!res.committed || res.snapshot.val()?.round?.votePhase !== "reveal") return;
    for (const [author, p] of Object.entries(pts)) {
      runTransaction(ref(db, `rooms/${roomCode}/players/${author}/score`), (v) => (v || 0) + p);
    }
  });
}

function advanceRevealToNext() {
  const r = meta.round;
  const next = findFaceoff(r.voteIdx + 1);
  if (next !== null) {
    txMeta((m) => {
      if (m.state !== "voting" || m.round?.num !== r.num ||
          m.round.voteIdx !== r.voteIdx || m.round.votePhase !== "reveal") return;
      return { ...m, round: { ...m.round, voteIdx: next, votePhase: "vote", endsAt: nowSrv() + 20000, reveal: null } };
    });
  } else if (r.num < (meta.settings.rounds || 2)) {
    startNextRound(r.num + 1);
  } else {
    startFinal();
  }
}

function advanceFinalWriting() {
  txMeta((m) => {
    if (m.state !== "finalWriting") return;
    return { ...m, state: "finalVoting", round: { ...m.round, votePhase: "vote", endsAt: nowSrv() + 30000 } };
  });
}

function advanceFinalVote() {
  const tally = {};
  for (const target of Object.values(votes.final || {})) tally[target] = (tally[target] || 0) + 1;
  // Rank by votes: distinct vote-count groups take 40 / 20 / 10.
  const ranked = Object.entries(tally).sort((x, y) => y[1] - x[1]);
  const groupPts = [40, 20, 10];
  const pts = {};
  let g = -1, lastCount = -1;
  for (const [author, count] of ranked) {
    if (count !== lastCount) { g++; lastCount = count; }
    if (g > 2) break;
    pts[author] = groupPts[g];
  }
  txMeta((m) => {
    if (m.state !== "finalVoting" || m.round?.votePhase !== "vote") return;
    return { ...m, round: { ...m.round, votePhase: "reveal", endsAt: nowSrv() + 12000, reveal: { tally, pts } } };
  }).then((res) => {
    if (!res.committed || res.snapshot.val()?.round?.votePhase !== "reveal") return;
    for (const [author, p] of Object.entries(pts)) {
      runTransaction(ref(db, `rooms/${roomCode}/players/${author}/score`), (v) => (v || 0) + p);
    }
  });
}

function finishGame() {
  txMeta((m) => (m.state === "finalVoting" && m.round?.votePhase === "reveal")
    ? { ...m, state: "gameEnd" } : undefined);
}

function backToLobby() {
  txMeta((m) => (m.state === "gameEnd" || m.state !== "lobby")
    ? { ...m, state: "lobby", round: null, order: null } : undefined)
    .then((res) => {
      if (res.committed) { remove(answersRef()); remove(votesRef()); }
    });
}

// ── Writing & voting actions ──────────────────────────────────────────────────
function submitSlot(slot, auto = false) {
  if (!participating() || meta.state !== "writing" || submittedSlots[slot]) return;
  const input = $(`write-input-${slot}`);
  let text = input.value.trim();
  if (!text) {
    if (!auto) { input.focus(); return; }
    text = PLACEHOLDER;
  }
  const idx = myPromptIdxs()[slot];
  submittedSlots[slot] = true;
  set(ref(db, `rooms/${roomCode}/answers/r${meta.round.num}/p${idx}/${pid}`), { text });
  input.disabled = true;
  $(`btn-submit-${slot}`).disabled = true;
  input.closest(".quip-block")?.classList.add("done");
  if (submittedSlots[0] && submittedSlots[1]) {
    update(child(playersRef(), pid), { wroteRound: meta.round.num });
    render();
  }
}
$("btn-submit-0")?.addEventListener("click", () => submitSlot(0));
$("btn-submit-1")?.addEventListener("click", () => submitSlot(1));
$("write-input-0")?.addEventListener("keydown", (e) => { if (e.key === "Enter") submitSlot(0); });
$("write-input-1")?.addEventListener("keydown", (e) => { if (e.key === "Enter") submitSlot(1); });

function submitFinal(auto = false) {
  if (!participating() || meta.state !== "finalWriting" || submittedFinal) return;
  const input = $("final-input");
  let text = input.value.trim();
  if (!text) {
    if (!auto) { input.focus(); return; }
    text = PLACEHOLDER;
  }
  submittedFinal = true;
  set(ref(db, `rooms/${roomCode}/answers/final/${pid}`), { text });
  update(child(playersRef(), pid), { wroteFinal: true });
  render();
}
$("btn-submit-final")?.addEventListener("click", () => submitFinal());
$("final-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter") submitFinal(); });

function castVote(authorPid) {
  const r = meta?.round;
  if (!participating() || meta.state !== "voting" || r.votePhase !== "vote") return;
  const [a, b] = promptAuthors(r.voteIdx);
  if (pid === a || pid === b) return;
  if (authorPid !== a && authorPid !== b) return;
  set(ref(db, `rooms/${roomCode}/votes/r${r.num}/p${r.voteIdx}/${pid}`), authorPid);
}

function castFinalVote(authorPid) {
  if (!participating() || meta.state !== "finalVoting" || meta.round.votePhase !== "vote") return;
  if (authorPid === pid || !answers.final?.[authorPid]) return;
  set(ref(db, `rooms/${roomCode}/votes/final/${pid}`), authorPid);
}

$("btn-next-faceoff")?.addEventListener("click", () => { if (isHost()) advanceRevealToNext(); });
$("btn-finish-game")?.addEventListener("click", () => { if (isHost()) finishGame(); });

// ── Lobby interactions ────────────────────────────────────────────────────────
$("btn-start")?.addEventListener("click", startGame);
$("set-rounds")?.addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { rounds: Number(e.target.value) }));

$("btn-copy-link")?.addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#${roomCode}`;
  try {
    await navigator.clipboard.writeText(url);
    $("btn-copy-link").textContent = "Copied!";
  } catch {
    prompt("Copy this link:", url);
  }
  setTimeout(() => { $("btn-copy-link").textContent = "Copy invite link"; }, 1500);
});

$("btn-bigscreen")?.addEventListener("click", () => {
  window.open(`${location.pathname}#${roomCode}-screen`, "_blank");
});

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  if (isBigScreen) return;
  claimHostIfAbandoned();

  const n = nowSrv();
  const r = meta.round;

  // Watchdog: fewer than 3 connected participants mid-game → back to lobby.
  if (meta.state !== "lobby" && meta.state !== "gameEnd" && meta.order) {
    const conn = meta.order.filter((id) => players[id]?.connected).length;
    if (conn < 3) {
      lowPlayersSince ??= Date.now();
      if (isHost() && Date.now() - lowPlayersSince > 10000) backToLobby();
    } else {
      lowPlayersSince = null;
    }
  } else {
    lowPlayersSince = null;
  }

  // Auto-submits for me.
  if (participating() && r?.endsAt && n > r.endsAt) {
    if (meta.state === "writing" && !(submittedSlots[0] && submittedSlots[1])) {
      submitSlot(0, true); submitSlot(1, true);
    } else if (meta.state === "finalWriting" && !submittedFinal) {
      submitFinal(true);
    }
  }

  // Host drives the state machine.
  if (!isHost() || !r) return;
  if (meta.state === "writing") {
    const allWrote = meta.order.every((id) => !players[id]?.connected || (players[id].wroteRound || 0) >= r.num);
    if (allWrote || n > r.endsAt + 3000) advanceWritingToVoting();
  } else if (meta.state === "voting" && r.votePhase === "vote") {
    const [a, b] = promptAuthors(r.voteIdx);
    const eligible = meta.order.filter((id) => id !== a && id !== b && players[id]?.connected);
    const vmap = votes[`r${r.num}`]?.[`p${r.voteIdx}`] || {};
    const allVoted = eligible.length > 0 && eligible.every((id) => vmap[id]);
    if (allVoted || n > r.endsAt) advanceVoteToReveal();
  } else if (meta.state === "voting" && r.votePhase === "reveal") {
    if (n > r.endsAt) advanceRevealToNext();
  } else if (meta.state === "finalWriting") {
    const allWrote = meta.order.every((id) => !players[id]?.connected || players[id].wroteFinal);
    if (allWrote || n > r.endsAt + 3000) advanceFinalWriting();
  } else if (meta.state === "finalVoting" && r.votePhase === "vote") {
    const eligible = meta.order.filter((id) => players[id]?.connected);
    const allVoted = eligible.every((id) => votes.final?.[id]);
    if (allVoted || n > r.endsAt) advanceFinalVote();
  } else if (meta.state === "finalVoting" && r.votePhase === "reveal") {
    if (n > r.endsAt) finishGame();
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

// ── Rendering (player) ────────────────────────────────────────────────────────
function render() {
  if (!meta) return;
  if (isBigScreen) { renderBigScreen(); return; }
  if (meta.state === "lobby") {
    resetLocalPhase("lobby");
    showScreen("lobby");
    renderLobby();
  } else {
    showScreen("game");
    renderGame();
  }
}

function resetLocalPhase(key) {
  if (loadedPhaseKey === key) return;
  loadedPhaseKey = key;
  if (key.startsWith("write")) {
    submittedSlots = [false, false];
    for (const s of [0, 1]) {
      const inp = $(`write-input-${s}`);
      inp.value = ""; inp.disabled = false;
      $(`btn-submit-${s}`).disabled = false;
      inp.closest(".quip-block")?.classList.remove("done");
    }
  }
  if (key === "finalwrite") {
    submittedFinal = false;
    $("final-input").value = "";
  }
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
  if (isHost()) $("set-rounds").value = String(meta.settings.rounds || 2);
  $("overlay").classList.add("hidden");
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderGame() {
  const r = meta.round;
  const totalRounds = meta.settings.rounds || 2;
  $("round-info").textContent = r?.final ? "🏆 Grand Final" : `Round ${r?.num || 1}/${totalRounds}`;

  if (meta.state === "gameEnd") {
    $("phase-label").textContent = "🏁 Final scores";
    renderGameEnd();
    return;
  }
  $("overlay").classList.add("hidden");

  if (!participating()) {
    $("phase-label").textContent = "Spectating";
    if (meta.state === "voting" || meta.state === "finalVoting") {
      // Spectators still get to watch the face-offs.
      if (meta.state === "voting") { renderFaceoff(); showView("faceoff"); }
      else { renderFinalVote(); showView("finalvote"); }
    } else {
      showView("spectate");
    }
    return;
  }

  if (meta.state === "writing") {
    $("phase-label").textContent = "✍️ Writing quips";
    resetLocalPhase(`write-r${r.num}`);
    if (submittedSlots[0] && submittedSlots[1]) { renderWait("wroteRound", r.num); showView("wait"); return; }
    const [i0, i1] = myPromptIdxs();
    $("write-prompt-0").textContent = PROMPTS[r.prompts[i0]];
    $("write-prompt-1").textContent = PROMPTS[r.prompts[i1]];
    showView("writing");
  } else if (meta.state === "voting") {
    $("phase-label").textContent = r.votePhase === "vote" ? "🗳️ Vote!" : "🎭 The reveal";
    resetLocalPhase(`vote-r${r.num}-${r.voteIdx}`);
    renderFaceoff();
    showView("faceoff");
  } else if (meta.state === "finalWriting") {
    $("phase-label").textContent = "🏆 Grand Final";
    resetLocalPhase("finalwrite");
    if (submittedFinal) { renderWait("wroteFinal", true); showView("wait"); return; }
    $("final-prompt").textContent = PROMPTS[r.prompt];
    showView("finalwrite");
  } else if (meta.state === "finalVoting") {
    $("phase-label").textContent = r.votePhase === "vote" ? "🗳️ Vote for the champion" : "🥇 The podium";
    renderFinalVote();
    showView("finalvote");
  }
}

function renderWait(field, val) {
  $("wait-title").textContent = "✅ Submitted!";
  $("wait-sub").textContent = "Waiting for the others…";
  const ul = $("wait-list");
  ul.innerHTML = "";
  for (const id of meta.order || []) {
    const p = players[id];
    if (!p) continue;
    const done = field === "wroteFinal" ? !!p.wroteFinal : (p.wroteRound || 0) >= val;
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : p.connected ? "✍️" : "💤"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
}

function renderFaceoff() {
  const r = meta.round;
  if (r.voteIdx == null || r.voteIdx < 0) return;
  const N = meta.order.length;
  $("faceoff-counter").textContent = `Face-off ${r.voteIdx + 1} of ${N} · Round ${r.num}`;
  $("faceoff-prompt").textContent = PROMPTS[r.prompts[r.voteIdx]];

  const [a, b] = promptAuthors(r.voteIdx);
  const ordered = cardOrder(r.voteIdx);
  const iAmAuthor = pid === a || pid === b;
  const canVote = participating() && !iAmAuthor && r.votePhase === "vote";
  const vmap = votes[`r${r.num}`]?.[`p${r.voteIdx}`] || {};
  const myVote = vmap[pid];

  const wrap = $("faceoff-cards");
  wrap.innerHTML = "";
  const totalVotes = r.reveal ? Object.values(r.reveal.tally || {}).reduce((x, y) => x + y, 0) : 0;

  for (const author of ordered) {
    const card = document.createElement("div");
    card.className = "quip-card";
    const text = faceoffAnswer(r.voteIdx, author) || PLACEHOLDER;
    card.innerHTML = `<div class="quip-text">${esc(text)}</div>`;

    if (r.votePhase === "vote") {
      if (canVote) {
        card.classList.add("votable");
        if (myVote === author) card.classList.add("myvote");
        card.addEventListener("click", () => castVote(author));
        const btn = document.createElement("button");
        btn.className = "btn" + (myVote === author ? " primary" : "");
        btn.textContent = myVote === author ? "Your vote ✓" : "This one";
        card.appendChild(btn);
      }
    } else if (r.reveal) {
      const count = r.reveal.tally?.[author] || 0;
      const pct = totalVotes ? Math.round((count / totalVotes) * 100) : 0;
      const nameEl = document.createElement("div");
      nameEl.className = "author";
      nameEl.textContent = `— ${players[author]?.name || "?"}`;
      card.appendChild(nameEl);
      const barWrap = document.createElement("div");
      barWrap.className = "votebar-wrap";
      barWrap.innerHTML = `<div class="votebar"></div>`;
      card.appendChild(barWrap);
      requestAnimationFrame(() => { barWrap.firstChild.style.width = pct + "%"; });
      const countEl = document.createElement("div");
      countEl.className = "votecount";
      countEl.textContent = `${count} vote${count === 1 ? "" : "s"}`;
      card.appendChild(countEl);
      const p = r.reveal.pts?.[author];
      if (p) {
        const ptsEl = document.createElement("div");
        ptsEl.className = "pts";
        ptsEl.textContent = `+${p}`;
        card.appendChild(ptsEl);
      }
      if (r.reveal.winner === author) {
        card.classList.add("winner");
        if (r.reveal.ko) card.classList.add("ko");
      }
    }
    wrap.appendChild(card);
  }

  const note = $("faceoff-note");
  if (r.votePhase === "vote" && iAmAuthor) {
    note.textContent = "🤫 You're in this one — look innocent.";
    note.classList.remove("hidden");
  } else if (r.votePhase === "vote" && !participating()) {
    note.textContent = "🍿 Spectating — you're in the next game.";
    note.classList.remove("hidden");
  } else {
    note.classList.add("hidden");
  }
  $("btn-next-faceoff").classList.toggle("hidden", !(isHost() && r.votePhase === "reveal"));
}

function renderFinalVote() {
  const r = meta.round;
  $("finalvote-prompt").textContent = PROMPTS[r.prompt];
  const wall = $("finalvote-wall");
  wall.innerHTML = "";
  const entries = Object.entries(answers.final || {});
  // Stable seeded shuffle so everyone sees the same order.
  const rand = mulberry32(r.prompt + 13);
  entries.sort((x, y) => x[0].localeCompare(y[0]));
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  const myVote = votes.final?.[pid];
  const medals = ["🥇", "🥈", "🥉"];

  for (const [author, ans] of entries) {
    const card = document.createElement("div");
    card.className = "quip-card";
    card.innerHTML = `<div class="quip-text">${esc(ans.text || PLACEHOLDER)}</div>`;
    if (r.votePhase === "vote") {
      if (participating() && author !== pid) {
        card.classList.add("votable");
        if (myVote === author) card.classList.add("myvote");
        card.addEventListener("click", () => castFinalVote(author));
      } else if (author === pid) {
        const tag = document.createElement("div");
        tag.className = "votecount";
        tag.textContent = "yours";
        card.appendChild(tag);
      }
    } else if (r.reveal) {
      const count = r.reveal.tally?.[author] || 0;
      const nameEl = document.createElement("div");
      nameEl.className = "author";
      nameEl.textContent = `— ${players[author]?.name || "?"} · ${count} vote${count === 1 ? "" : "s"}`;
      card.appendChild(nameEl);
      const p = r.reveal.pts?.[author];
      if (p) {
        const rank = [40, 20, 10].indexOf(p);
        const ptsEl = document.createElement("div");
        ptsEl.className = "pts";
        ptsEl.textContent = `${medals[rank] || "✨"} +${p}`;
        card.appendChild(ptsEl);
      }
    }
    wall.appendChild(card);
  }
  $("btn-finish-game").classList.toggle("hidden", !(isHost() && r.votePhase === "reveal"));
}

function renderGameEnd() {
  showView("wait");
  const box = $("overlay-content");
  const board = (meta.order || [])
    .map((id) => [id, players[id]])
    .filter(([, p]) => p)
    .sort((x, y) => (y[1].score || 0) - (x[1].score || 0));
  const medals = ["🥇", "🥈", "🥉"];
  box.innerHTML = `
    <h2>🏁 Final scores</h2>
    <ul class="leaderboard">
      ${board.map(([id, p], i) =>
        `<li class="${id === pid ? "me" : ""}"><span>${medals[i] || "·"} ${esc(p.name)}</span><span>${p.score || 0}</span></li>`).join("")}
    </ul>
    ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
               : `<p class="hint">Waiting for the host…</p>`}
    <button id="btn-leave-end" class="btn small ghost">Leave room</button>`;
  box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
  box.querySelector("#btn-leave-end").addEventListener("click", leaveRoom);
  $("overlay").classList.remove("hidden");
}

function renderTimer() {
  const el = isBigScreen ? document.querySelector(".bs-timer") : $("timer");
  if (!el) return;
  const r = meta?.round;
  const timed = ["writing", "finalWriting"].includes(meta?.state) ||
    (["voting", "finalVoting"].includes(meta?.state) && r?.votePhase === "vote");
  if (!timed || !r?.endsAt) {
    el.textContent = isBigScreen ? "" : "--";
    el.classList?.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = isBigScreen ? `⏱ ${secs}` : secs;
  if (!isBigScreen) el.classList.toggle("low", secs <= 10);
}

// ── Rendering (📺 Big Screen) ─────────────────────────────────────────────────
function renderBigScreen() {
  const c = $("bs-content");
  const r = meta.round;
  const title = `<h1 class="bs-title">💬 Quip <span>Duel</span></h1>`;

  if (meta.state === "lobby") {
    const pills = sortedPlayers().filter(([, p]) => p.connected)
      .map(([, p]) => `<span>${esc(p.name)}</span>`).join("");
    c.innerHTML = `${title}
      <p class="bs-sub">Join at this site with the room code:</p>
      <div class="bs-code">${roomCode}</div>
      <div class="bs-pills">${pills || "<span>waiting for players…</span>"}</div>`;
    return;
  }

  if (meta.state === "writing" || meta.state === "finalWriting") {
    const isFinal = meta.state === "finalWriting";
    const pills = (meta.order || []).map((id) => {
      const p = players[id];
      if (!p) return "";
      const done = isFinal ? !!p.wroteFinal : (p.wroteRound || 0) >= r.num;
      return `<span class="${done ? "done" : ""}">${done ? "✅ " : "✍️ "}${esc(p.name)}</span>`;
    }).join("");
    c.innerHTML = `${title}
      <p class="bs-sub">${isFinal ? "🏆 GRAND FINAL — one prompt, everyone answers" : `Round ${r.num} — quips are being written…`}</p>
      <div class="bs-timer"></div>
      <div class="bs-pills">${pills}</div>`;
    renderTimer();
    return;
  }

  if (meta.state === "voting" && r.voteIdx >= 0) {
    const [a, b] = promptAuthors(r.voteIdx);
    const ordered = cardOrder(r.voteIdx);
    const totalVotes = r.reveal ? Object.values(r.reveal.tally || {}).reduce((x, y) => x + y, 0) : 0;
    const eligible = (meta.order || []).filter((id) => id !== a && id !== b && players[id]?.connected);
    const vmap = votes[`r${r.num}`]?.[`p${r.voteIdx}`] || {};
    const votesIn = eligible.filter((id) => vmap[id]).length;

    const cards = ordered.map((author) => {
      const text = faceoffAnswer(r.voteIdx, author) || PLACEHOLDER;
      if (r.votePhase === "vote") {
        return `<div class="quip-card"><div class="quip-text">${esc(text)}</div></div>`;
      }
      const count = r.reveal?.tally?.[author] || 0;
      const pct = totalVotes ? Math.round((count / totalVotes) * 100) : 0;
      const p = r.reveal?.pts?.[author];
      const win = r.reveal?.winner === author;
      return `<div class="quip-card ${win ? "winner" : ""} ${win && r.reveal?.ko ? "ko" : ""}">
        <div class="quip-text">${esc(text)}</div>
        <div class="author">— ${esc(players[author]?.name || "?")}</div>
        <div class="votebar-wrap"><div class="votebar" style="width:${pct}%"></div></div>
        <div class="votecount">${count} vote${count === 1 ? "" : "s"}</div>
        ${p ? `<div class="pts">+${p}</div>` : ""}
      </div>`;
    }).join("");

    c.innerHTML = `${title}
      <p class="bs-sub">Face-off ${r.voteIdx + 1} of ${meta.order.length} · Round ${r.num}</p>
      <div class="bs-prompt">${esc(PROMPTS[r.prompts[r.voteIdx]])}</div>
      <div class="bs-cards">${cards}</div>
      ${r.votePhase === "vote"
        ? `<div class="bs-votes-in">🗳️ ${votesIn}/${eligible.length} votes in</div><div class="bs-timer"></div>`
        : ""}`;
    renderTimer();
    return;
  }

  if (meta.state === "finalVoting") {
    const entries = Object.entries(answers.final || {});
    const medalFor = (p) => (p === 40 ? "🥇" : p === 20 ? "🥈" : p === 10 ? "🥉" : "");
    const cards = entries.map(([author, ans]) => {
      if (r.votePhase === "vote") {
        return `<div class="quip-card"><div class="quip-text">${esc(ans.text || PLACEHOLDER)}</div></div>`;
      }
      const count = r.reveal?.tally?.[author] || 0;
      const p = r.reveal?.pts?.[author];
      return `<div class="quip-card ${p ? "winner" : ""}">
        <div class="quip-text">${esc(ans.text || PLACEHOLDER)}</div>
        <div class="author">— ${esc(players[author]?.name || "?")} · ${count} vote${count === 1 ? "" : "s"}</div>
        ${p ? `<div class="pts">${medalFor(p)} +${p}</div>` : ""}
      </div>`;
    }).join("");
    c.innerHTML = `${title}
      <p class="bs-sub">🏆 GRAND FINAL</p>
      <div class="bs-prompt">${esc(PROMPTS[r.prompt])}</div>
      <div class="bs-wall">${cards}</div>
      ${r.votePhase === "vote" ? `<div class="bs-timer"></div>` : ""}`;
    renderTimer();
    return;
  }

  if (meta.state === "gameEnd") {
    const board = (meta.order || [])
      .map((id) => [id, players[id]])
      .filter(([, p]) => p)
      .sort((x, y) => (y[1].score || 0) - (x[1].score || 0));
    const medals = ["🥇", "🥈", "🥉"];
    c.innerHTML = `${title}
      <p class="bs-sub">🏁 Final scores</p>
      <ul class="bs-board">
        ${board.map(([, p], i) =>
          `<li><span>${medals[i] || "·"} ${esc(p.name)}</span><span>${p.score || 0}</span></li>`).join("")}
      </ul>`;
  }
}
