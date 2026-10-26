// Two Truths and a Lie — static client, synced through Firebase Realtime Database.
//
// Everyone locks in 2 truths + 1 lie in the lobby (stored pre-shuffled so the
// card order never changes). The game runs one voting round per player: everyone
// else votes for the lie, then a reveal shows who was fooled. +10 for spotting
// the lie, +5 to the subject per fooled voter. The host's client advances the
// state machine, with host migration if they vanish.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";

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

const VOTE_SECONDS = 45;
const REVEAL_SECONDS = 25;      // auto-advance fallback
const REVEAL_MIN_MS = 10000;    // host can't skip the reveal before this

let roomCode = null;
let meta = null;
let players = {};
let votes = {};
let serverOffset = 0;
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;
let formPrefilled = false;
let scoredRound = -1; // guards double-scoring on this client

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const votesRef = () => ref(db, `rooms/${roomCode}/votes`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

const subjectId = () => meta?.order?.[meta.roundIdx];
const inGameOrder = (id) => (meta?.order || []).includes(id);
const canVote = () =>
  meta?.state === "voting" && inGameOrder(pid) && pid !== subjectId();

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
      game: "twotruths",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
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
    if (snap.val().game !== "twotruths") {
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

// ── Lobby: lock in statements ────────────────────────────────────────────────
function lockIn() {
  const t1 = $("truth1-input").value.trim();
  const t2 = $("truth2-input").value.trim();
  const lie = $("lie-input").value.trim();
  const err = $("lock-error");
  if (!t1 || !t2 || !lie) {
    err.textContent = "Fill in all three statements.";
    err.classList.remove("hidden");
    return;
  }
  err.classList.add("hidden");
  // Shuffle once at lock-in; this order is final so cards never move around.
  const items = [
    { t: t1, isLie: false }, { t: t2, isLie: false }, { t: lie, isLie: true },
  ];
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  update(child(playersRef(), pid), {
    locked: true,
    statements: {
      s: items.map((x) => x.t),
      lie: items.findIndex((x) => x.isLie),
      raw: { t1, t2, l: lie }, // for prefilling the form on rejoin/edit
    },
  });
}
$("btn-lock").addEventListener("click", lockIn);

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

// ── State-machine transactions ────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

async function startGame() {
  const ready = Object.entries(players)
    .filter(([, p]) => p.connected && p.locked && p.statements)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
    .map(([id]) => id);
  if (ready.length < 3) { alert("Need at least 3 locked-in players."); return; }

  // Reset scores and old votes BEFORE flipping state (telephone's pattern).
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/score`] = 0;
    resets[`${id}/foolScore`] = 0;
  }
  await update(playersRef(), resets);
  await remove(votesRef());
  scoredRound = -1;

  // Shuffled subject order.
  for (let i = ready.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ready[i], ready[j]] = [ready[j], ready[i]];
  }
  await txMeta((m) => {
    if (m.state !== "lobby") return;
    return { ...m, state: "voting", order: ready, roundIdx: 0, endsAt: nowSrv() + VOTE_SECONDS * 1000 };
  });
}
$("btn-start").addEventListener("click", startGame);

function toReveal() {
  const idx = meta.roundIdx;
  txMeta((m) => {
    if (m.state !== "voting" || m.roundIdx !== idx) return;
    return { ...m, state: "reveal", endsAt: nowSrv() + REVEAL_SECONDS * 1000 };
  }).then((res) => {
    if (res.committed && res.snapshot.val()?.state === "reveal") applyScores(idx);
  });
}

// Run once by the client whose transaction flipped voting → reveal.
function applyScores(idx) {
  if (scoredRound >= idx) return;
  scoredRound = idx;
  const subj = meta.order[idx];
  const lieIdx = players[subj]?.statements?.lie;
  if (lieIdx === undefined) return;
  for (const [vid, v] of Object.entries(votes[idx] || {})) {
    if (vid === subj) continue;
    if (v === lieIdx) {
      runTransaction(ref(db, `rooms/${roomCode}/players/${vid}/score`), (x) => (x || 0) + 10);
    } else {
      runTransaction(ref(db, `rooms/${roomCode}/players/${subj}/score`), (x) => (x || 0) + 5);
      runTransaction(ref(db, `rooms/${roomCode}/players/${subj}/foolScore`), (x) => (x || 0) + 5);
    }
  }
}

function nextRound() {
  const idx = meta.roundIdx;
  txMeta((m) => {
    if (m.state !== "reveal" || m.roundIdx !== idx) return;
    let n = idx + 1;
    while (n < m.order.length && !players[m.order[n]]?.connected) n++; // skip vanished subjects
    if (n >= m.order.length) return { ...m, state: "gameEnd", endsAt: null };
    return { ...m, state: "voting", roundIdx: n, endsAt: nowSrv() + VOTE_SECONDS * 1000 };
  });
}
$("btn-next").addEventListener("click", () => {
  if (isHost() && revealElapsed() >= REVEAL_MIN_MS) nextRound();
});

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", order: null, roundIdx: null, endsAt: null };
  }).then((res) => {
    if (!res.committed) return;
    remove(votesRef());
    const resets = {};
    for (const id of Object.keys(players)) {
      resets[`${id}/statements`] = null;
      resets[`${id}/locked`] = null;
    }
    update(playersRef(), resets);
    formPrefilled = false;
  });
}

const revealElapsed = () =>
  meta?.endsAt ? REVEAL_SECONDS * 1000 - (meta.endsAt - nowSrv()) : 0;

// ── Voting ────────────────────────────────────────────────────────────────────
function castVote(i) {
  if (!canVote()) return;
  set(ref(db, `rooms/${roomCode}/votes/${meta.roundIdx}/${pid}`), i);
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = meta.state === "voting" || meta.state === "reveal";
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 3) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => (m.state === "voting" || m.state === "reveal")
        ? { ...m, state: "lobby", order: null, roundIdx: null, endsAt: null }
        : undefined);
    }
  } else {
    lowPlayersSince = null;
  }

  if (!isHost() || !meta.endsAt) return;
  const n = nowSrv();
  if (meta.state === "voting") {
    const subj = subjectId();
    const eligible = (meta.order || []).filter((id) =>
      id !== subj && players[id]?.connected);
    const allVoted = eligible.length > 0 &&
      eligible.every((id) => (votes[meta.roundIdx] || {})[id] !== undefined);
    if (allVoted || n > meta.endsAt + 3000) toReveal();
  } else if (meta.state === "reveal" && n > meta.endsAt) {
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

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

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
  let locked = 0, connected = 0;
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    connected++;
    if (p.locked) locked++;
    const li = document.createElement("li");
    li.textContent = `${p.locked ? "✔ " : "✍️ "}${p.name}${meta.hostId === id ? " 👑" : ""}${id === pid ? " (you)" : ""}`;
    if (id === pid) li.classList.add("me");
    if (p.locked) li.classList.add("locked");
    ul.appendChild(li);
  }
  $("locked-count").textContent = `(${locked}/${connected} locked in)`;

  if (!formPrefilled && me()?.statements?.raw) {
    const r = me().statements.raw;
    $("truth1-input").value = r.t1 || "";
    $("truth2-input").value = r.t2 || "";
    $("lie-input").value = r.l || "";
    formPrefilled = true;
  }
  $("lock-status").classList.toggle("hidden", !me()?.locked);
  $("btn-lock").textContent = me()?.locked ? "Update ✍️" : "Lock in ✔";

  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) {
    const ready = connected >= 3 && locked === connected;
    $("btn-start").disabled = !ready;
    $("btn-start").textContent = ready
      ? "Start game"
      : connected < 3 ? "Start game (need 3+ players)" : `Start game (${locked}/${connected} locked in)`;
  }
}

function renderGame() {
  const subj = subjectId();
  const subjP = players[subj];
  const stmts = subjP?.statements;
  const idx = meta.roundIdx;
  const roundVotes = votes[idx] || {};
  const isSubject = pid === subj;
  const spectating = !inGameOrder(pid);

  $("round-info").textContent = `Round ${idx + 1}/${meta.order?.length || "?"}`;
  $("subject-label").textContent = subjP ? `${subjP.name}'s turn` : "";

  // Status banner
  const banner = $("status-banner");
  if (meta.state === "voting" && isSubject) {
    const cast = Object.keys(roundVotes).filter((v) => v !== subj).length;
    banner.textContent = `😬 Sit tight — they're dissecting your life choices. (${cast} vote${cast === 1 ? "" : "s"} in)`;
    banner.classList.remove("hidden");
  } else if (spectating) {
    banner.textContent = "🍿 You're spectating this game — you'll be dealt in next round.";
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }

  // Cards
  const cards = $("cards");
  cards.innerHTML = "";
  if (stmts?.s) {
    stmts.s.forEach((text, i) => {
      const b = document.createElement("button");
      b.className = "statement-card";
      let inner = `<span>${esc(text)}</span>`;
      if (meta.state === "voting") {
        b.disabled = !canVote();
        if (roundVotes[pid] === i) b.classList.add("selected");
        b.addEventListener("click", () => castVote(i));
      } else { // reveal
        b.disabled = true;
        const isLie = i === stmts.lie;
        b.classList.add(isLie ? "lie" : "truth");
        inner += `<span class="verdict">${isLie ? "❌ THE LIE" : "✅ true"}</span>`;
        const names = Object.entries(roundVotes)
          .filter(([vid, v]) => v === i && vid !== subj)
          .map(([vid]) => esc(players[vid]?.name || "?"));
        if (names.length) inner += `<span class="voters">🗳️ ${names.join(", ")}</span>`;
      }
      b.innerHTML = inner;
      cards.appendChild(b);
    });
  }

  // Footer line + reveal extras
  const vs = $("vote-status");
  const extra = $("reveal-extra");
  if (meta.state === "voting") {
    vs.textContent = canVote()
      ? (roundVotes[pid] !== undefined ? "Vote cast — you can change it until the reveal." : "Which one is the lie? Click to vote.")
      : "";
    extra.classList.add("hidden");
  } else if (meta.state === "reveal") {
    vs.textContent = "";
    extra.classList.remove("hidden");
    const fooled = Object.entries(roundVotes)
      .filter(([vid, v]) => vid !== subj && v !== stmts?.lie).length;
    $("reveal-prompt").textContent =
      `${subjP?.name || "They"} fooled ${fooled} ${fooled === 1 ? "person" : "people"} (+${fooled * 5}). ` +
      `Ask ${subjP?.name || "them"} for the story behind the truths!`;
    const nextBtn = $("btn-next");
    nextBtn.classList.toggle("hidden", !isHost());
    nextBtn.disabled = revealElapsed() < REVEAL_MIN_MS;
  } else {
    vs.textContent = "";
    extra.classList.add("hidden");
  }

  // Game end overlay
  const overlay = $("end-overlay");
  if (meta.state === "gameEnd") {
    overlay.classList.remove("hidden");
    renderEnd();
  } else {
    overlay.classList.add("hidden");
  }
  renderTimer();
}

function renderEnd() {
  const lb = $("leaderboard");
  lb.innerHTML = "";
  const rows = (meta.order || [])
    .map((id) => [id, players[id]])
    .filter(([, p]) => p)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  const topFool = Math.max(0, ...rows.map(([, p]) => p.foolScore || 0));
  rows.forEach(([id, p], i) => {
    const li = document.createElement("li");
    const medal = ["🥇", "🥈", "🥉"][i] || "·";
    const liar = topFool > 0 && (p.foolScore || 0) === topFool ? ` <span class="tag">🏆 Best Liar</span>` : "";
    li.innerHTML = `<span>${medal} ${esc(p.name)}${id === pid ? " (you)" : ""}${liar}</span><strong>${p.score || 0}</strong>`;
    lb.appendChild(li);
  });

  const ctl = $("end-controls");
  ctl.innerHTML = "";
  if (isHost()) {
    const again = document.createElement("button");
    again.className = "btn primary big";
    again.textContent = "Back to lobby";
    again.addEventListener("click", backToLobby);
    ctl.appendChild(again);
  } else {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Waiting for the host…";
    ctl.appendChild(p);
  }
  const leave = document.createElement("button");
  leave.className = "btn small ghost";
  leave.textContent = "Leave room";
  leave.addEventListener("click", leaveRoom);
  ctl.appendChild(leave);
}

function renderTimer() {
  const el = $("timer");
  if (!meta?.endsAt || (meta.state !== "voting" && meta.state !== "reveal")) {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((meta.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", meta.state === "voting" && secs <= 10);
  // Keep the host's Next button enabling in sync without a full render.
  if (meta.state === "reveal" && isHost()) {
    $("btn-next").disabled = revealElapsed() < REVEAL_MIN_MS;
  }
}
