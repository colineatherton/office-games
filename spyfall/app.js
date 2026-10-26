// Spyfall — static client, synced through Firebase Realtime Database.
// Everyone but the spy knows the location; interrogation happens out loud on
// the call. All state transitions run as whole-meta transactions; the host's
// client resolves votes and timers (with host migration if they vanish).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { LOCATIONS } from "./locations.js";

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
let spyGoneSince = null;
let accusePickerOpen = false;
let spyGuessOpen = false;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const isSpy = () => meta?.round?.spyId === pid;
const isParticipant = () => !!meta?.round?.players?.[pid];
const inRound = () => ["playing", "voting", "finalVote"].includes(meta?.state);

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
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

$("btn-create").addEventListener("click", async () => {
  const name = myName(); if (!name) return;
  joinError("");
  try {
    const code = randCode();
    await set(ref(db, `rooms/${code}/meta`), {
      game: "spyfall",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { roundMinutes: 8, rounds: 3 },
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
    if (snap.val().game !== "spyfall") {
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

// ── State-machine transactions ────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

const connectedIds = () =>
  Object.entries(players).filter(([, p]) => p.connected).map(([id]) => id);

function buildRound(m, num) {
  const conn = connectedIds();
  const used = m.usedLocations || {};
  let pool = LOCATIONS.filter((l) => !used[l.name]);
  if (!pool.length) pool = LOCATIONS;
  const loc = rand(pool);
  const spyId = rand(conn);
  const shuffledRoles = [...loc.roles].sort(() => Math.random() - 0.5);
  const roles = {};
  let i = 0;
  for (const id of conn) {
    if (id === spyId) continue;
    roles[id] = shuffledRoles[i % shuffledRoles.length];
    i++;
  }
  const playersMap = {};
  for (const id of conn) playersMap[id] = true;
  return {
    round: {
      num, spyId, location: loc.name, roles, players: playersMap,
      endsAt: nowSrv() + m.settings.roundMinutes * 60000,
      usedVoteCallers: {},
    },
    usedLocations: { ...used, [loc.name]: true },
  };
}

async function startGame() {
  if (connectedIds().length < 3) return;
  const resets = {};
  for (const id of Object.keys(players)) resets[`${id}/score`] = 0;
  await update(playersRef(), resets);
  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const built = buildRound(m, 1);
    return {
      ...m, state: "playing",
      totalRounds: m.settings.rounds,
      round: built.round,
      usedLocations: built.usedLocations,
      roundResult: null, vote: null, final: null,
    };
  });
}

// End the round with an outcome; the committing client applies scores once.
function endRound(outcome, extra = {}) {
  const expectNum = meta?.round?.num;
  txMeta((m) => {
    if (!["playing", "voting", "finalVote"].includes(m.state)) return;
    if (m.round?.num !== expectNum) return;
    return {
      ...m, state: "roundEnd", vote: null, final: null,
      roundResult: {
        outcome,
        spyId: m.round.spyId,
        location: m.round.location,
        callerId: extra.callerId || null,
        accusedId: extra.accusedId || null,
        endsAt: nowSrv() + 12000,
        num: m.round.num,
      },
    };
  }).then((res) => {
    if (res.committed && res.snapshot.val()?.state === "roundEnd") {
      applyScores(res.snapshot.val());
    }
  });
}

function applyScores(m) {
  const r = m.roundResult;
  const participants = Object.keys(m.round?.players || {});
  const nonSpies = participants.filter((id) => id !== r.spyId);
  const give = (id, pts) =>
    runTransaction(ref(db, `rooms/${roomCode}/players/${id}/score`), (v) => (v || 0) + pts);

  if (r.outcome === "voteCaught" || r.outcome === "finalCaught" ||
      r.outcome === "spyGuessWrong" || r.outcome === "spyGone") {
    for (const id of nonSpies) give(id, 1);
    if (r.outcome === "voteCaught" && r.callerId) give(r.callerId, 1);
  } else {
    // voteWrong | finalMiss | spyGuessCorrect — the spy wins
    give(r.spyId, 2);
  }
}

// Call a vote on a suspect (non-spies only, once per round each).
function callVote(targetId) {
  txMeta((m) => {
    if (m.state !== "playing" || !m.round) return;
    if (!m.round.players?.[pid] || pid === m.round.spyId) return;
    if (m.round.usedVoteCallers?.[pid]) return;
    if (!m.round.players?.[targetId] || targetId === pid) return;
    return {
      ...m, state: "voting",
      round: { ...m.round, remainingMs: Math.max(5000, m.round.endsAt - nowSrv()) },
      vote: {
        accusedId: targetId, callerId: pid,
        endsAt: nowSrv() + 30000,
        votes: { [pid]: true }, // the caller votes yes by calling
      },
    };
  });
}

function castVote(yes) {
  if (meta?.state !== "voting" || !meta.vote) return;
  if (pid === meta.vote.accusedId || !meta.round?.players?.[pid]) return;
  update(child(metaRef(), "vote/votes"), { [pid]: yes });
}

function resolveVote() {
  txMeta((m) => {
    if (m.state !== "voting" || !m.vote || !m.round) return;
    const votes = m.vote.votes || {};
    const eligible = Object.keys(m.round.players || {})
      .filter((id) => id !== m.vote.accusedId && players[id]?.connected);
    const allVoted = eligible.every((id) => votes[id] !== undefined);
    const expired = nowSrv() > m.vote.endsAt;
    if (!allVoted && !expired) return;
    const unanimous = eligible.length > 0 && eligible.every((id) => votes[id] === true);
    if (unanimous) {
      const caught = m.vote.accusedId === m.round.spyId;
      return {
        ...m, state: "roundEnd", vote: null, final: null,
        roundResult: {
          outcome: caught ? "voteCaught" : "voteWrong",
          spyId: m.round.spyId, location: m.round.location,
          callerId: m.vote.callerId, accusedId: m.vote.accusedId,
          endsAt: nowSrv() + 12000, num: m.round.num,
        },
      };
    }
    // Not unanimous — resume play, burn the caller's one vote call.
    return {
      ...m, state: "playing", vote: null,
      round: {
        ...m.round,
        endsAt: nowSrv() + (m.round.remainingMs || 60000),
        remainingMs: null,
        usedVoteCallers: { ...(m.round.usedVoteCallers || {}), [m.vote.callerId]: true },
      },
    };
  }).then((res) => {
    if (res.committed && res.snapshot.val()?.state === "roundEnd") {
      applyScores(res.snapshot.val());
    }
  });
}

// Spy reveals and guesses the location (ends the round immediately).
function spyGuess(locationName) {
  if (!isSpy() || meta?.state !== "playing") return;
  const correct = locationName === meta.round.location;
  endRound(correct ? "spyGuessCorrect" : "spyGuessWrong");
}

function startFinalVote() {
  txMeta((m) => {
    if (m.state !== "playing" || !m.round) return;
    if (nowSrv() <= m.round.endsAt) return;
    return { ...m, state: "finalVote", final: { endsAt: nowSrv() + 45000, votes: {} } };
  });
}

function castFinalVote(targetId) {
  if (meta?.state !== "finalVote" || !meta.round?.players?.[pid]) return;
  if (targetId === pid || !meta.round.players?.[targetId]) return;
  update(child(metaRef(), "final/votes"), { [pid]: targetId });
}

function resolveFinalVote() {
  txMeta((m) => {
    if (m.state !== "finalVote" || !m.final || !m.round) return;
    const votes = m.final.votes || {};
    const voters = Object.keys(m.round.players || {}).filter((id) => players[id]?.connected);
    const allVoted = voters.every((id) => votes[id]);
    if (!allVoted && nowSrv() <= m.final.endsAt) return;
    const counts = {};
    for (const [voter, target] of Object.entries(votes)) {
      if (!m.round.players[voter] || !m.round.players[target] || voter === target) continue;
      counts[target] = (counts[target] || 0) + 1;
    }
    const top = Math.max(0, ...Object.values(counts));
    const leaders = Object.keys(counts).filter((id) => counts[id] === top);
    const picked = leaders.length ? rand(leaders) : null; // tie → coin flip
    const caught = picked === m.round.spyId;
    return {
      ...m, state: "roundEnd", vote: null, final: null,
      roundResult: {
        outcome: caught ? "finalCaught" : "finalMiss",
        spyId: m.round.spyId, location: m.round.location,
        accusedId: picked, callerId: null,
        endsAt: nowSrv() + 12000, num: m.round.num,
      },
    };
  }).then((res) => {
    if (res.committed && res.snapshot.val()?.state === "roundEnd") {
      applyScores(res.snapshot.val());
    }
  });
}

function nextRound() {
  const expectNum = meta?.roundResult?.num;
  txMeta((m) => {
    if (m.state !== "roundEnd" || m.roundResult?.num !== expectNum) return;
    if (m.roundResult.num >= m.totalRounds) return { ...m, state: "gameEnd" };
    const built = buildRound(m, m.roundResult.num + 1);
    return {
      ...m, state: "playing",
      round: built.round, usedLocations: built.usedLocations,
      roundResult: null,
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return {
      ...m, state: "lobby",
      round: null, roundResult: null, vote: null, final: null,
      usedLocations: null, totalRounds: null,
    };
  });
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  // Watchdog: fewer than 3 players mid-game → back to lobby after 10s grace.
  const active = meta.state !== "lobby" && meta.state !== "gameEnd";
  if (active && connectedIds().length < 3) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => (m.state !== "lobby" && m.state !== "gameEnd")
        ? { ...m, state: "lobby", round: null, roundResult: null, vote: null, final: null, usedLocations: null }
        : undefined);
      return;
    }
  } else {
    lowPlayersSince = null;
  }

  // Watchdog: the spy vanished → end the round for the non-spies.
  if (inRound() && meta.round && !players[meta.round.spyId]?.connected) {
    spyGoneSince ??= Date.now();
    if (isHost() && Date.now() - spyGoneSince > 5000) {
      spyGoneSince = null;
      endRound("spyGone");
    }
  } else {
    spyGoneSince = null;
  }

  if (!isHost()) return;
  const n = nowSrv();
  if (meta.state === "playing" && meta.round && n > meta.round.endsAt) {
    startFinalVote();
  } else if (meta.state === "voting" && meta.vote) {
    const votes = meta.vote.votes || {};
    const eligible = Object.keys(meta.round?.players || {})
      .filter((id) => id !== meta.vote.accusedId && players[id]?.connected);
    if (eligible.every((id) => votes[id] !== undefined) || n > meta.vote.endsAt + 1000) {
      resolveVote();
    }
  } else if (meta.state === "finalVote" && meta.final) {
    const votes = meta.final.votes || {};
    const voters = Object.keys(meta.round?.players || {}).filter((id) => players[id]?.connected);
    if (voters.every((id) => votes[id]) || n > meta.final.endsAt + 1000) {
      resolveFinalVote();
    }
  } else if (meta.state === "roundEnd" && meta.roundResult && n > meta.roundResult.endsAt) {
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
function render() {
  if (!meta) return;
  if (meta.state === "lobby") {
    accusePickerOpen = false;
    spyGuessOpen = false;
    showScreen("lobby");
    renderLobby();
  } else {
    showScreen("game");
    renderGame();
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
  if (isHost()) {
    $("set-minutes").value = String(meta.settings.roundMinutes);
    $("set-rounds").value = String(meta.settings.rounds);
    $("btn-start").disabled = count < 3;
    $("start-hint").classList.toggle("hidden", count >= 3);
  }
}

function renderGame() {
  const r = meta.round;
  $("round-info").textContent = r ? `Round ${r.num}/${meta.totalRounds}` :
    (meta.roundResult ? `Round ${meta.roundResult.num}/${meta.totalRounds}` : "");

  $("state-label").textContent =
    meta.state === "playing" ? "🔎 Interrogate out loud!" :
    meta.state === "voting" ? "🗳️ Vote in progress" :
    meta.state === "finalVote" ? "⏰ Time's up — final vote!" :
    meta.state === "roundEnd" ? "Round over" : "";

  // Player list with scores
  const pl = $("player-list");
  pl.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    const row = document.createElement("div");
    row.className = "player-row";
    if (!p.connected) row.classList.add("offline");
    if (id === pid) row.classList.add("me");
    const crown = meta.hostId === id ? " 👑" : "";
    const used = r?.usedVoteCallers?.[id] ? " 🗳️" : "";
    row.innerHTML = `<span class="pname">${esc(p.name)}${crown}${used}</span><span class="pscore">${p.score || 0}</span>`;
    pl.appendChild(row);
  }

  renderRoleCard();
  renderActions();
  renderLocGrid();
  renderOverlay();
  renderTimer();
}

function renderRoleCard() {
  const card = $("role-card");
  const r = meta.round;
  if (!r || !inRound() && meta.state !== "roundEnd") { card.innerHTML = ""; return; }
  if (!isParticipant()) {
    card.innerHTML = `<div class="big">🍿</div><p class="hint">You joined mid-round — watch this one, you're dealt in next round.</p>`;
  } else if (isSpy()) {
    card.innerHTML = `
      <div class="big spy-card">🕵️ YOU ARE THE SPY</div>
      <p class="role-line">Figure out the location without getting caught. Bluff hard.</p>`;
  } else {
    card.innerHTML = `
      <div class="big">📍 <span class="loc-name">${esc(r.location)}</span></div>
      <p class="role-line">You're the <strong>${esc(r.roles?.[pid] || "Visitor")}</strong>. Don't say the location out loud!</p>`;
  }
}

function renderActions() {
  const box = $("actions");
  const canAct = meta.state === "playing" && isParticipant();
  box.classList.toggle("hidden", !canAct);
  if (!canAct) { accusePickerOpen = false; return; }

  const voteBtn = $("btn-call-vote");
  const canCall = !isSpy() && !meta.round.usedVoteCallers?.[pid];
  voteBtn.classList.toggle("hidden", !canCall);
  voteBtn.textContent = accusePickerOpen ? "✖ Cancel" : "🗳️ Call a vote…";

  const row = $("accuse-row");
  row.classList.toggle("hidden", !accusePickerOpen);
  if (accusePickerOpen) {
    row.innerHTML = "";
    for (const id of Object.keys(meta.round.players || {})) {
      if (id === pid || !players[id]?.connected) continue;
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = `Accuse ${players[id]?.name || "?"}`;
      b.addEventListener("click", () => { accusePickerOpen = false; callVote(id); });
      row.appendChild(b);
    }
  }

  $("btn-spy-guess").classList.toggle("hidden", !isSpy());
}

$("btn-call-vote").addEventListener("click", () => {
  accusePickerOpen = !accusePickerOpen;
  render();
});
$("btn-spy-guess").addEventListener("click", () => {
  spyGuessOpen = true;
  render();
});

function renderLocGrid() {
  const grid = $("loc-grid");
  if (grid.childElementCount) return; // static list, build once
  for (const l of LOCATIONS) {
    const d = document.createElement("div");
    d.className = "loc-chip";
    d.textContent = l.name;
    grid.appendChild(d);
  }
}

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");

  // Spy's local guess grid takes priority while playing.
  if (spyGuessOpen && meta.state === "playing" && isSpy()) {
    ov.classList.remove("hidden");
    box.innerHTML = `<h2>🎯 Name the location</h2>
      <p class="hint">Guess right: +2 for you. Guess wrong: everyone else scores.</p>
      <div class="loc-grid" id="guess-grid"></div>
      <button id="btn-guess-cancel" class="btn ghost small">Never mind</button>`;
    const grid = box.querySelector("#guess-grid");
    for (const l of LOCATIONS) {
      const d = document.createElement("div");
      d.className = "loc-chip guessable";
      d.textContent = l.name;
      d.addEventListener("click", () => { spyGuessOpen = false; spyGuess(l.name); });
      grid.appendChild(d);
    }
    box.querySelector("#btn-guess-cancel").addEventListener("click", () => {
      spyGuessOpen = false; render();
    });
    return;
  }
  spyGuessOpen = spyGuessOpen && meta.state === "playing";

  if (meta.state === "voting" && meta.vote) {
    ov.classList.remove("hidden");
    const accused = players[meta.vote.accusedId]?.name || "?";
    const caller = players[meta.vote.callerId]?.name || "?";
    const votes = meta.vote.votes || {};
    const eligible = Object.keys(meta.round?.players || {})
      .filter((id) => id !== meta.vote.accusedId && players[id]?.connected);
    const votedCount = eligible.filter((id) => votes[id] !== undefined).length;
    let inner = `<h2>🗳️ ${esc(caller)} accuses ${esc(accused)}!</h2>
      <p class="hint">Is ${esc(accused)} the spy? Must be unanimous to convict. ${votedCount}/${eligible.length} voted.</p>`;
    if (pid === meta.vote.accusedId) {
      inner += `<p class="big-word">Defend yourself — out loud!</p>`;
    } else if (isParticipant()) {
      const mine = votes[pid];
      inner += `<div class="vote-buttons">
        <button id="v-yes" class="btn danger" ${mine === true ? "disabled" : ""}>👍 Spy!</button>
        <button id="v-no" class="btn" ${mine === false ? "disabled" : ""}>👎 Innocent</button>
      </div>`;
      if (mine !== undefined) inner += `<p class="hint">You voted ${mine ? "SPY" : "innocent"}.</p>`;
    }
    box.innerHTML = inner;
    box.querySelector("#v-yes")?.addEventListener("click", () => castVote(true));
    box.querySelector("#v-no")?.addEventListener("click", () => castVote(false));
    return;
  }

  if (meta.state === "finalVote" && meta.final) {
    ov.classList.remove("hidden");
    const votes = meta.final.votes || {};
    let inner = `<h2>⏰ Time's up! Who is the spy?</h2>`;
    if (isParticipant()) {
      inner += `<div class="suspect-grid" id="suspects"></div>`;
      if (votes[pid]) inner += `<p class="hint">You voted for ${esc(players[votes[pid]]?.name || "?")}. You can change it until everyone's in.</p>`;
    } else {
      inner += `<p class="hint">The players are deciding…</p>`;
    }
    const voters = Object.keys(meta.round?.players || {}).filter((id) => players[id]?.connected);
    inner += `<p class="hint">${Object.keys(votes).length}/${voters.length} votes in.</p>`;
    box.innerHTML = inner;
    const grid = box.querySelector("#suspects");
    if (grid) {
      for (const id of Object.keys(meta.round.players || {})) {
        if (id === pid) continue;
        const b = document.createElement("button");
        b.className = "btn" + (votes[pid] === id ? " primary" : "");
        b.textContent = players[id]?.name || "?";
        b.addEventListener("click", () => castFinalVote(id));
        grid.appendChild(b);
      }
    }
    return;
  }

  if (meta.state === "roundEnd" && meta.roundResult) {
    ov.classList.remove("hidden");
    const rr = meta.roundResult;
    const spyName = players[rr.spyId]?.name || "?";
    const outcomeText = {
      voteCaught: `✅ Caught! ${esc(spyName)} was the spy. +1 to everyone else, +1 bonus to ${esc(players[rr.callerId]?.name || "the accuser")}.`,
      voteWrong: `😬 Wrong! ${esc(players[rr.accusedId]?.name || "?")} was innocent. The spy escapes with +2.`,
      finalCaught: `✅ The group voted correctly — ${esc(spyName)} was the spy. +1 to everyone else.`,
      finalMiss: `😬 The group voted wrong. ${esc(spyName)} was the spy and scores +2.`,
      spyGuessCorrect: `🎯 ${esc(spyName)} named the location and wins +2!`,
      spyGuessWrong: `❌ ${esc(spyName)} guessed wrong. +1 to everyone else.`,
      spyGone: `🚪 The spy (${esc(spyName)}) vanished. +1 to everyone else.`,
    }[rr.outcome] || "";
    box.innerHTML = `
      <h2>Round ${rr.num} over</h2>
      <p class="spy-reveal">The location was <span class="big-word">${esc(rr.location)}</span></p>
      <p>${outcomeText}</p>
      ${scoreListHTML()}
      ${isHost() ? `<button id="btn-next" class="btn primary big">${rr.num >= meta.totalRounds ? "Final scores" : "Next round ▶"}</button>` : `<p class="hint">Waiting for the host…</p>`}`;
    box.querySelector("#btn-next")?.addEventListener("click", nextRound);
    return;
  }

  if (meta.state === "gameEnd") {
    ov.classList.remove("hidden");
    const ranked = sortedPlayers().sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
    const winner = ranked[0];
    box.innerHTML = `
      <h2>🏁 Game over</h2>
      ${winner ? `<p class="big-word">🏆 ${esc(winner[1].name)}</p>` : ""}
      ${scoreListHTML()}
      ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>` : `<p class="hint">Waiting for the host…</p>`}
      <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
    box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
    box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
    return;
  }

  ov.classList.add("hidden");
}

function scoreListHTML() {
  const ranked = sortedPlayers().sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  return `<ul class="score-list">` + ranked.map(([id, p]) =>
    `<li><span>${esc(p.name)}${id === pid ? " (you)" : ""}</span><span class="pts">${p.score || 0}</span></li>`
  ).join("") + `</ul>`;
}

function renderTimer() {
  const el = $("timer");
  let endsAt = null, paused = false;
  if (meta?.state === "playing") endsAt = meta.round?.endsAt;
  else if (meta?.state === "voting") { endsAt = meta.vote?.endsAt; paused = true; }
  else if (meta?.state === "finalVote") endsAt = meta.final?.endsAt;
  if (!endsAt) {
    el.textContent = "--:--";
    el.classList.remove("low", "paused");
    return;
  }
  const secs = Math.max(0, Math.ceil((endsAt - nowSrv()) / 1000));
  const mm = Math.floor(secs / 60), ss = String(secs % 60).padStart(2, "0");
  el.textContent = `${mm}:${ss}`;
  el.classList.toggle("low", !paused && secs <= 30);
  el.classList.toggle("paused", paused);
}

// ── Lobby interactions ────────────────────────────────────────────────────────
$("btn-start").addEventListener("click", startGame);
$("set-minutes").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { roundMinutes: Number(e.target.value) }));
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
