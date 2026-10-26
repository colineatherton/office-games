// Polyglot — static client, synced through Firebase Realtime Database.
//
// Red vs Blue race on a shared board of 24 foreign-word tiles (6 hidden meanings
// × 4 words). Click two unclaimed tiles: same meaning → your team claims both
// (+20); different → your whole team is locked out for 4s (−5). All claims and
// state transitions go through whole-meta transactions, so simultaneous pairs
// from rival teams serialize safely and the final pair ends the round exactly once.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { MEANINGS } from "./translations.js";

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
let selectedIdx = null;
let renderedRound = -1;
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const myTeam = () => me()?.team;
const isHost = () => meta?.hostId === pid;
const iAmLocked = () =>
  (meta?.teamLockedUntil?.[myTeam()] || 0) > nowSrv();

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
      game: "polyglot",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 5, mode: "classic" },
      scores: { red: 0, blue: 0 },
      teamLockedUntil: { red: 0, blue: 0 },
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
    if (snap.val().game !== "polyglot") {
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
  });
  trackPresence(db, meRef);

  onValue(metaRef(), (s) => {
    meta = s.val();
    if (!meta) return;
    render();
  });
  onValue(playersRef(), (s) => {
    players = s.val() || {};
    render();
  });
}

function leaveRoom() {
  if (roomCode) set(ref(db, `rooms/${roomCode}/players/${pid}/connected`), false);
  location.hash = "";
  location.reload();
}
$("btn-leave-lobby").addEventListener("click", leaveRoom);

// ── Round generation ──────────────────────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Build a fresh board: 6 meanings not used this game, 4 sampled words each.
function makeRound(used) {
  let avail = MEANINGS.map((_, i) => i).filter((i) => !used[MEANINGS[i].english]);
  if (avail.length < 6) { used = {}; avail = MEANINGS.map((_, i) => i); }
  shuffle(avail);
  const newUsed = { ...used };
  const meanings = [];
  const tiles = [];
  for (const mi of avail.slice(0, 6)) {
    const mm = MEANINGS[mi];
    newUsed[mm.english] = true;
    const mIdx = meanings.length;
    meanings.push(mm.english);
    for (const wo of shuffle([...mm.words]).slice(0, 4)) {
      tiles.push({ w: wo.w, lang: wo.lang, m: mIdx, claimed: "" });
    }
  }
  shuffle(tiles);
  return { round: { mode: "classic", tiles, meanings }, used: newUsed };
}

// Hunt mode board: one target meaning, 5 of its translations + 15 decoys
// (one per other meaning, so a decoy can never belong to the target).
function makeHuntRound(used) {
  let avail = MEANINGS.map((_, i) => i).filter((i) => !used[MEANINGS[i].english]);
  if (!avail.length) { used = {}; avail = MEANINGS.map((_, i) => i); }
  const ti = avail[Math.floor(Math.random() * avail.length)];
  const target = MEANINGS[ti];
  const newUsed = { ...used, [target.english]: true };

  const tiles = shuffle([...target.words]).slice(0, 5)
    .map((wo) => ({ w: wo.w, lang: wo.lang, good: true, claimed: "" }));
  const others = shuffle(MEANINGS.map((_, i) => i).filter((i) => i !== ti));
  for (const oi of others.slice(0, 15)) {
    const ws = MEANINGS[oi].words;
    const wo = ws[Math.floor(Math.random() * ws.length)];
    tiles.push({ w: wo.w, lang: wo.lang, good: false, eng: MEANINGS[oi].english, claimed: "" });
  }
  shuffle(tiles);
  return { round: { mode: "hunt", target: target.english, tiles }, used: newUsed };
}

const roundMaker = (m) => (m.settings?.mode === "hunt" ? makeHuntRound : makeRound);

// ── State-machine transactions ────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function teamCounts() {
  let red = 0, blue = 0;
  for (const p of Object.values(players)) {
    if (!p.connected) continue;
    p.team === "red" ? red++ : blue++;
  }
  return { red, blue };
}

function startGame() {
  const { red, blue } = teamCounts();
  if (red < 1 || blue < 1) return; // button is disabled anyway
  txMeta((m) => {
    if (m.state !== "lobby") return;
    const { round, used } = roundMaker(m)({});
    return {
      ...m,
      state: "playing",
      scores: { red: 0, blue: 0 },
      teamLockedUntil: { red: 0, blue: 0 },
      roundNum: 1,
      usedMeanings: used,
      round,
    };
  });
}

function submitPair(i, j) {
  const team = myTeam();
  if (!team) return;
  txMeta((m) => {
    if (m.state !== "playing" || !m.round?.tiles) return;
    const tiles = m.round.tiles;
    if (!tiles[i] || !tiles[j] || tiles[i].claimed || tiles[j].claimed) return;
    const now = nowSrv();
    if ((m.teamLockedUntil?.[team] || 0) > now) return;

    const next = {
      ...m,
      scores: { ...m.scores },
      teamLockedUntil: { red: 0, blue: 0, ...m.teamLockedUntil },
      round: { ...m.round, tiles: tiles.map((t) => ({ ...t })) },
    };
    if (tiles[i].m === tiles[j].m) {
      next.round.tiles[i].claimed = team;
      next.round.tiles[j].claimed = team;
      next.scores[team] = (next.scores[team] || 0) + 20;
      if (next.round.tiles.every((t) => t.claimed)) {
        next.state = "roundEnd";
        next.round.endsAt = now + 8000;
      }
    } else {
      next.teamLockedUntil[team] = now + 4000;
      next.scores[team] = (next.scores[team] || 0) - 5;
    }
    return next;
  });
}

// Hunt mode: single click. Correct → claim (+10); wrong → tile dies, team
// locked 4s (−5). The 5th correct claim ends the round and awards the majority
// bonus inside the same transaction, so it fires exactly once.
function submitHunt(i) {
  const team = myTeam();
  if (!team) return;
  txMeta((m) => {
    if (m.state !== "playing" || m.round?.mode !== "hunt" || !m.round.tiles) return;
    const t = m.round.tiles[i];
    if (!t || t.claimed || t.dead) return;
    const now = nowSrv();
    if ((m.teamLockedUntil?.[team] || 0) > now) return;

    const next = {
      ...m,
      scores: { ...m.scores },
      teamLockedUntil: { red: 0, blue: 0, ...m.teamLockedUntil },
      round: { ...m.round, tiles: m.round.tiles.map((x) => ({ ...x })) },
    };
    if (t.good) {
      next.round.tiles[i].claimed = team;
      next.scores[team] = (next.scores[team] || 0) + 10;
      const goods = next.round.tiles.filter((x) => x.good);
      if (goods.every((x) => x.claimed)) {
        const reds = goods.filter((x) => x.claimed === "red").length;
        const bonusTeam = reds >= 3 ? "red" : "blue"; // 5 is odd — no ties
        next.scores[bonusTeam] = (next.scores[bonusTeam] || 0) + 20;
        next.round.bonusTeam = bonusTeam;
        next.state = "roundEnd";
        next.round.endsAt = now + 8000;
      }
    } else {
      next.round.tiles[i].dead = true;
      next.teamLockedUntil[team] = now + 4000;
      next.scores[team] = (next.scores[team] || 0) - 5;
    }
    return next;
  });
}

function advanceRound() {
  const expect = meta?.roundNum;
  txMeta((m) => {
    if (m.state !== "roundEnd" || m.roundNum !== expect) return;
    if (m.roundNum >= m.settings.rounds) return { ...m, state: "gameEnd" };
    const { round, used } = roundMaker(m)(m.usedMeanings || {});
    return {
      ...m,
      state: "playing",
      roundNum: m.roundNum + 1,
      usedMeanings: used,
      teamLockedUntil: { red: 0, blue: 0 },
      round,
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedMeanings: null, roundNum: null };
  });
}

function abortToLobby() {
  txMeta((m) => {
    if (m.state === "lobby" || m.state === "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedMeanings: null, roundNum: null };
  });
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  claimHostIfAbandoned();
  renderLock();

  const active = meta.state === "playing" || meta.state === "roundEnd";

  // Watchdog: each team needs at least one connected player.
  const { red, blue } = teamCounts();
  if (active && (red < 1 || blue < 1)) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) abortToLobby();
  } else {
    lowPlayersSince = null;
  }

  if (meta.state === "roundEnd" && meta.round?.endsAt) {
    renderOverlay(); // keep the countdown fresh
    if (isHost() && nowSrv() > meta.round.endsAt) advanceRound();
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
    renderedRound = -1;
    selectedIdx = null;
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
  if (isHost()) {
    $("set-rounds").value = String(meta.settings.rounds);
    $("set-mode").value = meta.settings.mode || "classic";
    const { red, blue } = teamCounts();
    const ok = red >= 1 && blue >= 1;
    $("btn-start").disabled = !ok;
    $("start-hint").textContent = ok ? "" : "Each team needs at least one player.";
    $("start-hint").classList.toggle("hidden", ok);
  }
}

function renderGame() {
  $("round-info").textContent = meta.roundNum
    ? `Round ${meta.roundNum}/${meta.settings.rounds}` : "";
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;
  $("side-score-red").textContent = meta.scores?.red || 0;
  $("side-score-blue").textContent = meta.scores?.blue || 0;

  const pl = $("player-list");
  pl.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    const row = document.createElement("div");
    row.className = `player-row ${p.team}`;
    if (!p.connected) row.classList.add("offline");
    if (id === pid) row.classList.add("me");
    row.innerHTML = `<span class="pname">${meta.hostId === id ? "👑 " : ""}${esc(p.name)}${id === pid ? " (you)" : ""}</span>`;
    pl.appendChild(row);
  }

  if (meta.roundNum !== renderedRound) {
    renderedRound = meta.roundNum;
    selectedIdx = null;
  }
  renderBoard();
  renderLock();
  renderOverlay();
}

function renderBoard() {
  const board = $("board");
  board.innerHTML = "";
  const hunt = meta.round?.mode === "hunt";
  const tiles = meta.round?.tiles || [];
  const meanings = meta.round?.meanings || [];

  $("hunt-target").classList.toggle("hidden", !hunt);
  if (hunt) $("hunt-target-word").textContent = meta.round?.target || "?";

  tiles.forEach((t, i) => {
    const b = document.createElement("button");
    b.className = "tile";
    if (t.claimed) b.classList.add("claimed", t.claimed);
    if (t.dead) b.classList.add("dead");
    if (!hunt && i === selectedIdx && !t.claimed) b.classList.add("selected");
    const meaning = t.claimed
      ? (hunt ? meta.round.target : meanings[t.m])
      : (t.dead ? t.eng : null);
    b.innerHTML = `
      <span class="word">${esc(t.w)}</span>
      <span class="lang">${esc(t.lang)}</span>
      ${meaning ? `<span class="meaning">= ${esc(meaning)}</span>` : ""}`;
    if (!t.claimed && !t.dead) b.addEventListener("click", () => onTileClick(i));
    board.appendChild(b);
  });
}

function onTileClick(i) {
  if (meta?.state !== "playing" || iAmLocked()) return;
  const t = meta.round?.tiles?.[i];
  if (!t || t.claimed || t.dead) return;
  if (meta.round.mode === "hunt") {
    submitHunt(i);
    return;
  }
  if (selectedIdx === i) {
    selectedIdx = null;
  } else if (selectedIdx === null || meta.round.tiles[selectedIdx]?.claimed) {
    selectedIdx = i;
  } else {
    const first = selectedIdx;
    selectedIdx = null;
    submitPair(first, i);
  }
  renderBoard();
}

function renderLock() {
  if (!meta || meta.state !== "playing") {
    $("lock-overlay").classList.add("hidden");
    $("lock-status").innerHTML = "&nbsp;";
    return;
  }
  const now = nowSrv();
  const mine = (meta.teamLockedUntil?.[myTeam()] || 0) - now;
  const theirs = (meta.teamLockedUntil?.[myTeam() === "red" ? "blue" : "red"] || 0) - now;

  const locked = mine > 0;
  $("lock-overlay").classList.toggle("hidden", !locked);
  if (locked) {
    $("lock-count").textContent = Math.ceil(mine / 1000);
    selectedIdx = null;
  }
  $("lock-status").innerHTML = theirs > 0
    ? `<span class="locked">Other team locked 🔒 ${Math.ceil(theirs / 1000)}</span>`
    : "&nbsp;";
}

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");

  if (meta.state === "roundEnd" && meta.round) {
    ov.classList.remove("hidden");
    const tiles = meta.round.tiles || [];
    const secs = Math.max(0, Math.ceil(((meta.round.endsAt || 0) - nowSrv()) / 1000));
    const last = meta.roundNum >= meta.settings.rounds;
    const footer = `<p class="hint">${last ? "Final scores" : "Next round"} in ${secs}…</p>`;

    if (meta.round.mode === "hunt") {
      const goods = tiles.filter((t) => t.good);
      const counts = { red: 0, blue: 0 };
      for (const t of goods) if (counts[t.claimed] !== undefined) counts[t.claimed]++;
      const ws = goods.map((t) =>
        `<span class="fw ${t.claimed}">${esc(t.w)} · ${esc(t.lang)}</span>`).join("");
      const bt = meta.round.bonusTeam;
      box.innerHTML = `
        <h2>Round ${meta.roundNum} — "${esc(meta.round.target)}" found! 🔴 ${counts.red} · 🔵 ${counts.blue}</h2>
        <div class="reveal-groups"><div class="reveal-group"><span class="eng">${esc(meta.round.target)}</span>${ws}</div></div>
        ${bt ? `<p class="${bt === "red" ? "winner-red" : "winner-blue"}">🏆 Majority bonus +20 to ${bt === "red" ? "🔴 Red" : "🔵 Blue"}!</p>` : ""}
        ${footer}`;
    } else {
      const meanings = meta.round.meanings || [];
      const counts = { red: 0, blue: 0 };
      for (const t of tiles) if (counts[t.claimed] !== undefined) counts[t.claimed]++;
      const groups = meanings.map((eng, mi) => {
        const ws = tiles.filter((t) => t.m === mi)
          .map((t) => `<span class="fw ${t.claimed}">${esc(t.w)}</span>`).join("");
        return `<div class="reveal-group"><span class="eng">${esc(eng)}</span>${ws}</div>`;
      }).join("");
      box.innerHTML = `
        <h2>Round ${meta.roundNum} done — 🔴 ${counts.red} · 🔵 ${counts.blue} tiles</h2>
        <div class="reveal-groups">${groups}</div>
        ${footer}`;
    }
  } else if (meta.state === "gameEnd") {
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
$("set-rounds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { rounds: Number(e.target.value) }));
$("set-mode").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { mode: e.target.value }));

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
