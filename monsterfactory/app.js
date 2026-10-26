// Monster Factory — exquisite-corpse drawing, synced through Firebase RTDB.
//
// With N players there are N monsters of 3 sections (head, torso, legs).
// Monster m's section s is drawn by order[(m + s) % N], so for N >= 3 every
// monster gets three distinct artists. Between sections, the next artist sees
// only a 30px sliver from the bottom of the previous band — the digital
// version of folding the paper over.

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

const SECTIONS = ["HEAD", "TORSO", "LEGS"];
const SECTION_HINTS = [
  "👺 Draw a head and neck. Leave lines running off the bottom edge — the torso artist only gets the last 30 pixels.",
  "💪 That faded strip is the bottom of someone's head. Continue the lines into a torso and arms, and run lines off the bottom edge.",
  "🦵 That strip is the bottom of a torso. Finish the beast: legs, feet, tail, wheels — your call.",
];
const BAND_W = 600, BAND_H = 300, SLIVER_H = 30;
const MIN_PLAYERS = 3;

let roomCode = null;
let meta = null;
let players = {};
let monsters = {};
let votes = {};
let serverOffset = 0;
let prevSliver = null;      // data URL of the sliver I'm continuing from
let loadedStep = -1;
let submittedLocal = false;
let advancing = false;
let finishingVote = false;
let monstersSubscribed = false;
let votesSubscribed = false;
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const monstersRef = () => ref(db, `rooms/${roomCode}/monsters`);
const votesRef = () => ref(db, `rooms/${roomCode}/votes`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

const myOrderIdx = () => (meta?.order || []).indexOf(pid);
const participating = () => myOrderIdx() >= 0;
const N = () => (meta?.order || []).length;
// Monster I work on at step s: artist = order[(m + s) % N] → m = (idx - s) mod N
const myMonster = (s) => ((myOrderIdx() - s) % N() + N()) % N();
const contributors = (m) => [0, 1, 2].map((s) => meta.order[(m + s) % N()]);
const iSubmitted = () =>
  submittedLocal || (me()?.submittedStep ?? -1) >= (meta?.step ?? 0);

// ── Screens & views ───────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game", "reveal"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["draw", "wait", "spectate"]) {
    $(`view-${v}`).classList.toggle("hidden", v !== name);
  }
}
function showRevealView(name) {
  for (const v of ["reveal", "voting", "done"]) {
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
      game: "monsterfactory",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { drawSeconds: 60 },
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
    if (snap.val().game !== "monsterfactory") {
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
    submittedStep: existing?.submittedStep ?? -1,
    score: existing?.score ?? 0,
  });
  trackPresence(db, meRef);

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

async function startGame() {
  const order = Object.entries(players)
    .filter(([, p]) => p.connected)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
    .map(([id]) => id);
  if (order.length < MIN_PLAYERS) { alert("Need at least 3 players — each monster has 3 artists."); return; }

  // Reset BEFORE flipping state so stale submittedStep values can't skip step 0.
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/submittedStep`] = -1;
    resets[`${id}/score`] = 0;
  }
  await update(playersRef(), resets);
  await remove(monstersRef());
  await remove(votesRef());

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    return {
      ...m,
      state: "playing",
      order,
      step: 0,
      endsAt: nowSrv() + m.settings.drawSeconds * 1000,
    };
  });
}

async function advanceStep() {
  if (advancing || !meta) return;
  advancing = true;
  try {
    const s = meta.step;
    const n = N();

    // Placeholder bands for anyone who didn't submit, so the next artist and
    // the reveal always have something. Transaction so a submission landing at
    // the same moment is never clobbered.
    const fills = meta.order.map((id, idx) => {
      const p = players[id];
      if ((p?.submittedStep ?? -1) >= s) return null;
      const m = ((idx - s) % n + n) % n;
      const node = ref(db, `rooms/${roomCode}/monsters/${m}/${s}`);
      const placeholder = { img: null, sliver: null, by: id, name: p?.name || "?" };
      return runTransaction(node, (cur) => (cur === null ? placeholder : undefined));
    });
    await Promise.all(fills.filter(Boolean));

    await txMeta((m) => {
      if (m.state !== "playing" || m.step !== s) return;
      if (s + 1 >= 3) {
        return { ...m, state: "reveal", reveal: { monster: 0, part: 0 }, endsAt: null };
      }
      return { ...m, step: s + 1, endsAt: nowSrv() + m.settings.drawSeconds * 1000 };
    });
  } finally {
    advancing = false;
  }
}

function hostRevealNext() {
  txMeta((m) => {
    if (m.state !== "reveal") return;
    const { monster, part } = m.reveal;
    if (part + 1 < 3) return { ...m, reveal: { monster, part: part + 1 } };
    if (monster + 1 < m.order.length) return { ...m, reveal: { monster: monster + 1, part: 0 } };
    return { ...m, state: "voting", endsAt: nowSrv() + 45000 };
  });
}

async function finishVoting() {
  if (finishingVote || !meta) return;
  finishingVote = true;
  try {
    const tally = {};
    for (const v of Object.values(votes)) {
      if (typeof v === "number") tally[v] = (tally[v] || 0) + 1;
    }
    const max = Math.max(0, ...Object.values(tally));
    const winners = Object.keys(tally).filter((k) => tally[k] === max && max > 0).map(Number);

    const res = await txMeta((m) => {
      if (m.state !== "voting") return;
      return { ...m, state: "done", results: { tally, winners }, endsAt: null };
    });

    if (res.committed && res.snapshot.val()?.state === "done") {
      // Scoring, applied exactly once by the committing client:
      // +5 per vote to each of the monster's three contributors; winning
      // monster's trio +10 each on top.
      const delta = {};
      for (const [mStr, count] of Object.entries(tally)) {
        for (const id of contributors(Number(mStr))) {
          delta[id] = (delta[id] || 0) + 5 * count;
        }
      }
      for (const w of winners) {
        for (const id of contributors(w)) delta[id] = (delta[id] || 0) + 10;
      }
      for (const [id, pts] of Object.entries(delta)) {
        runTransaction(ref(db, `rooms/${roomCode}/players/${id}/score`), (v) => (v || 0) + pts);
      }
    }
  } finally {
    finishingVote = false;
  }
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "done") return;
    return { ...m, state: "lobby", order: null, step: null, reveal: null, results: null, endsAt: null };
  }).then((res) => {
    if (res.committed) { remove(monstersRef()); remove(votesRef()); }
  });
}

// ── Submitting a section ──────────────────────────────────────────────────────
function submitSection() {
  if (!meta || meta.state !== "playing" || !participating() || iSubmitted()) return;
  submittedLocal = true;
  const s = meta.step;
  const m = myMonster(s);

  const img = board.toDataURL("image/png");
  const sliverCanvas = document.createElement("canvas");
  sliverCanvas.width = BAND_W; sliverCanvas.height = SLIVER_H;
  const sctx = sliverCanvas.getContext("2d");
  sctx.fillStyle = "#ffffff";
  sctx.fillRect(0, 0, BAND_W, SLIVER_H);
  sctx.drawImage(board, 0, BAND_H - SLIVER_H, BAND_W, SLIVER_H, 0, 0, BAND_W, SLIVER_H);
  const sliver = sliverCanvas.toDataURL("image/png");

  set(ref(db, `rooms/${roomCode}/monsters/${m}/${s}`), {
    img, sliver, by: pid, name: me()?.name || "?",
  });
  update(child(playersRef(), pid), { submittedStep: s });
  render();
}
$("btn-submit-draw").addEventListener("click", submitSection);

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const connCount = Object.values(players).filter((p) => p.connected).length;
  const minimum = meta.state === "playing" ? MIN_PLAYERS : 2;
  if (meta.state !== "lobby" && meta.state !== "done" && connCount < minimum) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => (m.state !== "lobby"
        ? { ...m, state: "lobby", order: null, step: null, reveal: null, results: null, endsAt: null }
        : undefined));
      return;
    }
  } else {
    lowPlayersSince = null;
  }

  const n = nowSrv();
  if (meta.state === "playing") {
    if (participating() && !iSubmitted() && meta.endsAt && n > meta.endsAt) {
      submitSection(); // whatever's drawn — an empty band is a charming void
    }
    if (isHost()) {
      const allDone = (meta.order || []).every((id) => {
        const p = players[id];
        return !p?.connected || (p.submittedStep ?? -1) >= meta.step;
      });
      if (allDone || (meta.endsAt && n > meta.endsAt + 3000)) advanceStep();
    }
  } else if (meta.state === "voting" && isHost()) {
    const allVoted = (meta.order || []).every((id) =>
      !players[id]?.connected || votes[id] !== undefined);
    if (allVoted || (meta.endsAt && n > meta.endsAt)) finishVoting();
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
    loadedStep = -1;
    showScreen("lobby");
    renderLobby();
  } else if (meta.state === "playing") {
    showScreen("game");
    renderGame();
  } else { // reveal | voting | done
    showScreen("reveal");
    subscribeMonsters();
    subscribeVotes();
    if (meta.state === "reveal") { showRevealView("reveal"); renderReveal(); }
    else if (meta.state === "voting") { showRevealView("voting"); renderVoting(); }
    else { showRevealView("done"); renderDone(); }
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
    $("set-draw-seconds").value = String(meta.settings.drawSeconds);
    $("start-hint").classList.toggle("hidden", count >= MIN_PLAYERS);
    $("btn-start").disabled = count < MIN_PLAYERS;
  }
}

function renderGame() {
  const s = meta.step;
  $("step-info").textContent = `Section ${s + 1}/3`;
  $("task-label").textContent = `Draw the ${SECTIONS[s]}`;

  if (s !== loadedStep) {
    loadedStep = s;
    submittedLocal = false;
    prevSliver = null;
    clearStrokes();
    if (s > 0 && participating()) loadPrevSliver(s);
  }

  if (!participating()) { showView("spectate"); return; }
  if (iSubmitted()) { renderWait(); showView("wait"); return; }

  $("draw-hint").textContent = SECTION_HINTS[s];
  const strip = $("sliver-strip");
  if (s === 0) {
    strip.classList.add("hidden");
  } else {
    strip.classList.remove("hidden");
    const img = $("sliver-img");
    if (prevSliver) { img.src = prevSliver; img.style.visibility = "visible"; }
    else { img.style.visibility = "hidden"; }
  }
  showView("draw");
  renderTimer();
}

async function loadPrevSliver(s) {
  const snap = await get(ref(db, `rooms/${roomCode}/monsters/${myMonster(s)}/${s - 1}`));
  if (meta?.step !== s) return; // step moved on while fetching
  prevSliver = snap.val()?.sliver || null;
  if (!prevSliver) $("draw-hint").textContent =
    SECTION_HINTS[meta.step] + " (The previous artist vanished — freestyle it.)";
  render();
}

function renderWait() {
  const ul = $("wait-list");
  ul.innerHTML = "";
  for (const id of meta.order || []) {
    const p = players[id];
    if (!p) continue;
    const done = (p.submittedStep ?? -1) >= meta.step;
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : p.connected ? "✏️" : "💤"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
}

function renderTimer() {
  const el = $("timer");
  if (meta?.state !== "playing" || !meta.endsAt) {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((meta.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", secs <= 10);
}

// ── Reveal / voting / done ────────────────────────────────────────────────────
function subscribeMonsters() {
  if (monstersSubscribed) return;
  monstersSubscribed = true;
  onValue(monstersRef(), (s) => { monsters = s.val() || {}; render(); });
}
function subscribeVotes() {
  if (votesSubscribed) return;
  votesSubscribed = true;
  onValue(votesRef(), (s) => { votes = s.val() || {}; render(); });
}

function monsterPart(m, s, small = false) {
  const entry = (monsters[m] || {})[s];
  const div = document.createElement("div");
  div.className = "monster-part";
  if (entry?.img) {
    const img = document.createElement("img");
    img.src = entry.img;
    img.alt = `${SECTIONS[s].toLowerCase()} by ${entry.name}`;
    div.appendChild(img);
    if (!small) {
      const credit = document.createElement("span");
      credit.className = "credit";
      credit.textContent = `${SECTIONS[s].toLowerCase()} · ${entry.name}`;
      div.appendChild(credit);
    }
  } else {
    div.classList.add("missing");
    div.textContent = "❓";
  }
  return div;
}

function renderReveal() {
  const { monster, part } = meta.reveal || { monster: 0, part: 0 };
  $("reveal-title").textContent = `🧟 Monster ${monster + 1} of ${N()}`;
  const stage = $("monster-stage");
  stage.innerHTML = "";
  for (let s = 0; s <= part; s++) stage.appendChild(monsterPart(monster, s));

  const btn = $("btn-reveal-next");
  btn.classList.toggle("hidden", !isHost());
  $("reveal-waiting").classList.toggle("hidden", isHost());
  const lastMonster = monster + 1 >= N();
  const lastPart = part + 1 >= 3;
  btn.textContent = !lastPart ? "Next ▶" : !lastMonster ? "Next monster ▶▶" : "To the vote! 🗳";
}
$("btn-reveal-next").addEventListener("click", hostRevealNext);

function renderVoting() {
  const anyAllowed = N() <= 4; // with few players everyone touched everything
  $("vote-hint").textContent = anyAllowed
    ? "Small factory — vote for any monster, even your own handiwork."
    : "Vote for your favourite — but not one you helped build.";

  const grid = $("vote-grid");
  grid.innerHTML = "";
  for (let m = 0; m < N(); m++) {
    const card = document.createElement("button");
    card.className = "vote-card";
    const blocked = participating() && !anyAllowed && contributors(m).includes(pid);
    if (blocked) card.classList.add("blocked");
    if (votes[pid] === m) card.classList.add("selected");
    for (let s = 0; s < 3; s++) {
      const entry = (monsters[m] || {})[s];
      if (entry?.img) {
        const img = document.createElement("img");
        img.src = entry.img;
        img.alt = "";
        card.appendChild(img);
      } else {
        const miss = document.createElement("div");
        miss.className = "mini-missing";
        miss.textContent = "❓";
        card.appendChild(miss);
      }
    }
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `#${m + 1}${blocked ? " · yours" : ""}`;
    card.appendChild(tag);
    if (!blocked && participating()) {
      card.addEventListener("click", () => set(child(votesRef(), pid), m));
    }
    grid.appendChild(card);
  }

  const eligible = (meta.order || []).filter((id) => players[id]?.connected);
  const cast = eligible.filter((id) => votes[id] !== undefined).length;
  const secs = meta.endsAt ? Math.max(0, Math.ceil((meta.endsAt - nowSrv()) / 1000)) : 0;
  $("vote-progress").textContent = participating()
    ? `${cast}/${eligible.length} votes in · ${secs}s left`
    : "Spectators get opinions, not ballots. Enjoy the gallery.";
}

function renderDone() {
  const winners = meta.results?.winners || [];
  $("done-title").textContent = winners.length === 0
    ? "🤷 Nobody voted. The monsters remain unjudged."
    : winners.length > 1 ? "👑 Monsters of the day (tie!)" : "👑 Monster of the day";

  const stage = $("winner-stage");
  stage.innerHTML = "";
  for (const w of winners) {
    for (let s = 0; s < 3; s++) stage.appendChild(monsterPart(w, s));
  }

  const lb = $("leaderboard");
  lb.innerHTML = "";
  const ranked = (meta.order || [])
    .map((id) => [id, players[id]])
    .filter(([, p]) => p)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  const medals = ["🥇", "🥈", "🥉"];
  ranked.forEach(([id, p], i) => {
    const li = document.createElement("li");
    if (id === pid) li.classList.add("me");
    li.innerHTML = `<span>${medals[i] || "·"} ${esc(p.name)}</span><span class="pts">${p.score || 0}</span>`;
    lb.appendChild(li);
  });

  const bar = $("done-controls");
  bar.innerHTML = "";
  if (isHost()) {
    const again = document.createElement("button");
    again.className = "btn primary big";
    again.textContent = "Back to lobby";
    again.addEventListener("click", backToLobby);
    bar.appendChild(again);
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

// ── Lobby interactions ────────────────────────────────────────────────────────
$("btn-start").addEventListener("click", startGame);
$("set-draw-seconds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { drawSeconds: Number(e.target.value) }));

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

// ── Local canvas (same pattern as telephone — each artist draws privately) ───
const board = $("board");
const ctx = board.getContext("2d");
ctx.lineCap = "round";
ctx.lineJoin = "round";

const COLORS = ["#000000", "#868e96", "#e03131", "#f08c00", "#ffd43b",
                "#2f9e44", "#1971c2", "#9c36b5", "#e64980", "#795548"];
const SIZES = [4, 9, 18];
let curColor = COLORS[0];
let curSize = SIZES[1];
let erasing = false;
let strokes = [];
let drawing = false;

const colorRow = $("color-row");
for (const c of COLORS) {
  const b = document.createElement("button");
  b.className = "color-btn";
  b.style.background = c;
  b.title = c;
  b.addEventListener("click", () => { curColor = c; erasing = false; refreshTools(); });
  colorRow.appendChild(b);
}
const eraserBtn = document.createElement("button");
eraserBtn.className = "tool-btn";
eraserBtn.textContent = "🧽";
eraserBtn.title = "Eraser";
eraserBtn.addEventListener("click", () => { erasing = !erasing; refreshTools(); });
colorRow.appendChild(eraserBtn);

const sizeRow = $("size-row");
for (const s of SIZES) {
  const b = document.createElement("button");
  b.className = "size-btn";
  b.innerHTML = `<i style="width:${Math.min(s, 20)}px;height:${Math.min(s, 20)}px"></i>`;
  b.addEventListener("click", () => { curSize = s; refreshTools(); });
  sizeRow.appendChild(b);
}

function refreshTools() {
  [...colorRow.querySelectorAll(".color-btn")].forEach((b, i) =>
    b.classList.toggle("active", !erasing && COLORS[i] === curColor));
  eraserBtn.style.outline = erasing ? "2px solid #ffd43b" : "none";
  [...sizeRow.children].forEach((b, i) => b.classList.toggle("active", SIZES[i] === curSize));
}
refreshTools();

$("btn-clear").addEventListener("click", clearStrokes);
$("btn-undo").addEventListener("click", () => { strokes.pop(); redrawAll(); });

function getPos(e) {
  const rect = board.getBoundingClientRect();
  return [
    Math.round((e.clientX - rect.left) / rect.width * BAND_W),
    Math.round((e.clientY - rect.top) / rect.height * BAND_H),
  ];
}

board.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  board.setPointerCapture(e.pointerId);
  drawing = true;
  const [x, y] = getPos(e);
  strokes.push({
    c: erasing ? "#ffffff" : curColor,
    w: erasing ? curSize * 3 : curSize,
    p: [x, y, x + 1, y + 1],
  });
  redrawAll();
});

board.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  e.preventDefault();
  const stroke = strokes[strokes.length - 1];
  const [x, y] = getPos(e);
  const n = stroke.p.length;
  const dx = x - stroke.p[n - 2], dy = y - stroke.p[n - 1];
  if (dx * dx + dy * dy < 9) return;
  ctx.strokeStyle = stroke.c;
  ctx.lineWidth = stroke.w;
  ctx.beginPath();
  ctx.moveTo(stroke.p[n - 2], stroke.p[n - 1]);
  ctx.lineTo(x, y);
  ctx.stroke();
  stroke.p.push(x, y);
});

const stopStroke = () => { drawing = false; };
board.addEventListener("pointerup", stopStroke);
board.addEventListener("pointercancel", stopStroke);

function clearStrokes() {
  strokes = [];
  redrawAll();
}

function redrawAll() {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, BAND_W, BAND_H);
  for (const s of strokes) {
    if (s.p.length < 4) continue;
    ctx.strokeStyle = s.c;
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(s.p[0], s.p[1]);
    for (let i = 2; i < s.p.length; i += 2) ctx.lineTo(s.p[i], s.p[i + 1]);
    ctx.stroke();
  }
}
redrawAll();
