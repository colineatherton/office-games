// Scattergories — static client, synced through Firebase Realtime Database.
// One letter, 8 categories, 90 seconds. Duplicate answers cancel each other,
// the group can challenge dodgy answers, survivors score. Individual scores.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { CATEGORIES } from "./categories.js";

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

const MIN_PLAYERS = 3;
const WRITE_SECONDS = 90;
const REVIEW_SECONDS = 45;
const RESULTS_SECONDS = 8;

let roomCode = null;
let meta = null;
let players = {};
let answersRound = {};    // answers for the current round: {pid: {a:[8]}}
let challengesRound = {}; // {"c{cat}_{pid}": {challengerPid: true}}
let serverOffset = 0;
let loadedRound = -1;
let submittedLocal = false;
let roundUnsubs = [];
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const answersRef = (num) => ref(db, `rooms/${roomCode}/answers/r${num}`);
const challengesRef = (num) => ref(db, `rooms/${roomCode}/challenges/r${num}`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const iSubmitted = () =>
  submittedLocal || (me()?.submittedRound ?? 0) >= (meta?.round?.num ?? 1);

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// Letters pool: common starters weighted double; Q, X, Z excluded.
const LETTER_POOL = "AABBCCDDEFFGGHHIJKLLMMNOPPRRSSTTUVWWY";

// ── Screens & views ───────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["write", "wait", "board", "spectate"]) {
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
      game: "scattergories",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 3 },
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
    if (snap.val().game !== "scattergories") {
      joinError(`Room ${code} is a ${snap.val().game || "different"} room — join it from that game's page.`);
      return;
    }
    await enterRoom(code, name, snap.val());
  } catch (e) {
    joinError("Couldn't reach the database. Check the Firebase config and your network. (" + e.message + ")");
  }
});

async function enterRoom(code, name, metaSnap = null) {
  roomCode = code;
  location.hash = code;

  const meRef = child(playersRef(), pid);
  const existing = (await get(meRef)).val();
  // Mid-game joiners are marked as having submitted the round in progress so
  // they never block the advance check; they play from the next round.
  const midGameRound = metaSnap && metaSnap.state !== "lobby" ? (metaSnap.round?.num || 0) : 0;
  await update(meRef, {
    name,
    connected: true,
    joinedAt: existing?.joinedAt || serverTimestamp(),
    submittedRound: Math.max(existing?.submittedRound ?? 0, midGameRound),
    score: existing?.score ?? 0,
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

// ── Round data subscriptions ──────────────────────────────────────────────────
function subscribeRound(num) {
  for (const u of roundUnsubs) u();
  roundUnsubs = [];
  answersRound = {};
  challengesRound = {};
  roundUnsubs.push(onValue(answersRef(num), (s) => {
    answersRound = s.val() || {};
    if (meta?.state === "review" || meta?.state === "results") renderBoard();
  }));
  roundUnsubs.push(onValue(challengesRef(num), (s) => {
    challengesRound = s.val() || {};
    if (meta?.state === "review") renderBoard();
  }));
}

// ── State machine ─────────────────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function pickLetter(used = {}) {
  const fresh = [...new Set(LETTER_POOL)].filter((l) => !used[l]);
  const pool = fresh.length
    ? LETTER_POOL.split("").filter((l) => !used[l])
    : LETTER_POOL.split("");
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickCategories(used = {}) {
  let avail = CATEGORIES.map((_, i) => i).filter((i) => !used[`i${i}`]);
  if (avail.length < 8) avail = CATEGORIES.map((_, i) => i);
  const picked = [];
  while (picked.length < 8) {
    const i = avail.splice(Math.floor(Math.random() * avail.length), 1)[0];
    picked.push(i);
  }
  return picked;
}

async function startGame() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < MIN_PLAYERS) { alert(`Need at least ${MIN_PLAYERS} players.`); return; }

  // Reset BEFORE flipping state so stale values can't skip round 1.
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/submittedRound`] = 0;
    resets[`${id}/score`] = 0;
  }
  await update(playersRef(), resets);
  await remove(ref(db, `rooms/${roomCode}/answers`));
  await remove(ref(db, `rooms/${roomCode}/challenges`));

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const letter = pickLetter({});
    const categories = pickCategories({});
    const usedCats = {};
    for (const i of categories) usedCats[`i${i}`] = true;
    return {
      ...m,
      state: "writing",
      usedLetters: { [letter]: true },
      usedCats,
      round: { num: 1, letter, categories, endsAt: nowSrv() + WRITE_SECONDS * 1000 },
    };
  });
}

function toReview() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "writing" || m.round?.num !== expect) return;
    return { ...m, state: "review", round: { ...m.round, endsAt: nowSrv() + REVIEW_SECONDS * 1000 } };
  });
}

// Scores are computed by the client whose transaction flips review→results, from
// its local snapshot of answers + challenges, and applied exactly once.
function toResults() {
  const expect = meta?.round?.num;
  const pts = computeRoundScores();
  txMeta((m) => {
    if (m.state !== "review" || m.round?.num !== expect) return;
    return {
      ...m,
      state: "results",
      round: { ...m.round, endsAt: nowSrv() + RESULTS_SECONDS * 1000, pts },
    };
  }).then((res) => {
    if (!res.committed) return;
    for (const [id, p] of Object.entries(pts)) {
      if (p > 0) runTransaction(ref(db, `rooms/${roomCode}/players/${id}/score`), (v) => (v || 0) + p);
    }
  });
}

function nextRound() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "results" || m.round?.num !== expect) return;
    if (m.round.num >= m.settings.rounds) return { ...m, state: "gameEnd" };
    const letter = pickLetter(m.usedLetters || {});
    const categories = pickCategories(m.usedCats || {});
    const usedCats = { ...(m.usedCats || {}) };
    for (const i of categories) usedCats[`i${i}`] = true;
    return {
      ...m,
      state: "writing",
      usedLetters: { ...(m.usedLetters || {}), [letter]: true },
      usedCats,
      round: { num: m.round.num + 1, letter, categories, endsAt: nowSrv() + WRITE_SECONDS * 1000 },
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedLetters: null, usedCats: null };
  }).then((res) => {
    if (res.committed) {
      remove(ref(db, `rooms/${roomCode}/answers`));
      remove(ref(db, `rooms/${roomCode}/challenges`));
    }
  });
}

// ── Submitting answers ────────────────────────────────────────────────────────
function submitAnswers() {
  if (!meta || meta.state !== "writing" || iSubmitted()) return;
  submittedLocal = true;
  const a = [...$("answer-rows").querySelectorAll("input")].map((i) => i.value.trim().slice(0, 40));
  set(child(answersRef(meta.round.num), pid), { a });
  update(child(playersRef(), pid), { submittedRound: meta.round.num });
  render();
}
$("btn-submit").addEventListener("click", submitAnswers);

// ── Answer analysis (shared by review display, results display, and scoring) ──
const normAns = (s) => {
  let n = String(s || "").toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ").trim();
  if (n.startsWith("the ")) n = n.slice(4);
  return n;
};

// Status per cell: {ok, reason, bonus}
function cellStatus(catIdx, playerId) {
  const letter = meta.round.letter.toLowerCase();
  const raw = answersRound[playerId]?.a?.[catIdx] || "";
  const norm = normAns(raw);
  if (!norm) return { ok: false, reason: "—" };
  if (norm[0] !== letter) return { ok: false, reason: `doesn't start with ${meta.round.letter}` };
  // duplicates (among letter-valid answers in this category)
  let dup = 0;
  for (const [otherId, sub] of Object.entries(answersRound)) {
    const oNorm = normAns(sub.a?.[catIdx] || "");
    if (oNorm && oNorm === norm && oNorm[0] === letter) dup++;
  }
  if (dup > 1) return { ok: false, reason: "duplicate" };
  // group challenges: struck when challenged by >50% of the OTHER connected players
  const challengers = Object.keys(challengesRound[`c${catIdx}_${playerId}`] || {}).length;
  const others = Object.entries(players).filter(([id, p]) => p.connected && id !== playerId).length;
  if (others > 0 && challengers > others / 2) return { ok: false, reason: "rejected by the group" };
  const words = norm.split(" ");
  const bonus = words.filter((w) => w[0] === letter).length >= 2;
  return { ok: true, reason: "", bonus, challengers };
}

function computeRoundScores() {
  const pts = {};
  const cats = meta.round.categories || [];
  for (const playerId of Object.keys(answersRound)) {
    let total = 0;
    for (let c = 0; c < cats.length; c++) {
      const st = cellStatus(c, playerId);
      if (st.ok) total += 2 + (st.bonus ? 1 : 0);
    }
    pts[playerId] = total;
  }
  return pts;
}

function toggleChallenge(catIdx, targetPid) {
  if (meta?.state !== "review" || targetPid === pid) return;
  const node = ref(db, `rooms/${roomCode}/challenges/r${meta.round.num}/c${catIdx}_${targetPid}/${pid}`);
  const mine = !!challengesRound[`c${catIdx}_${targetPid}`]?.[pid];
  if (mine) remove(node); else set(node, true);
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const inGame = ["writing", "review", "results"].includes(meta.state);
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (inGame && connCount < MIN_PLAYERS) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => (["writing", "review", "results"].includes(m.state)
        ? { ...m, state: "lobby", round: null, usedLetters: null, usedCats: null }
        : undefined));
    }
  } else {
    lowPlayersSince = null;
  }

  if (!inGame || !meta.round?.endsAt) return;
  const n = nowSrv();

  if (meta.state === "writing" && !iSubmitted() && n > meta.round.endsAt) submitAnswers();

  if (isHost()) {
    if (meta.state === "writing") {
      const allDone = Object.entries(players).every(([, p]) =>
        !p.connected || (p.submittedRound ?? 0) >= meta.round.num);
      if (allDone || n > meta.round.endsAt + 3000) toReview();
    } else if (meta.state === "review" && n > meta.round.endsAt) {
      toResults();
    } else if (meta.state === "results" && n > meta.round.endsAt) {
      nextRound();
    }
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
    loadedRound = -1;
    showScreen("lobby");
    renderLobby();
    return;
  }
  if (meta.state === "gameEnd") {
    showScreen("game");
    renderGameEnd();
    return;
  }
  $("overlay").classList.add("hidden");
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
  if (isHost()) {
    $("set-rounds").value = String(meta.settings.rounds);
    $("start-hint").classList.toggle("hidden", count >= MIN_PLAYERS);
  }
}

function renderGame() {
  const r = meta.round;
  if (!r) return;
  $("round-info").textContent = `Round ${r.num}/${meta.settings.rounds}`;
  $("letter-badge").textContent = r.letter;

  if (r.num !== loadedRound) {
    loadedRound = r.num;
    submittedLocal = false;
    subscribeRound(r.num);
    buildAnswerInputs();
  }

  const participating = (me()?.submittedRound ?? 0) >= r.num || meta.state === "writing";
  if (meta.state === "writing") {
    if (!me()) { showView("spectate"); return; }
    if (iSubmitted()) { renderWait(); showView("wait"); }
    else showView("write");
  } else if (meta.state === "review" || meta.state === "results") {
    if (!participating && !answersRound[pid]) {
      // spectators still get to watch the board
    }
    renderBoard();
    showView("board");
  }
  renderTimer();
}

function buildAnswerInputs() {
  const wrap = $("answer-rows");
  wrap.innerHTML = "";
  const letter = meta.round.letter;
  $("write-title").textContent = `✍️ Everything starts with “${letter}”`;
  for (const [i, catIdx] of (meta.round.categories || []).entries()) {
    const row = document.createElement("div");
    row.className = "answer-row";
    row.innerHTML = `
      <span class="cat-label"><span>${i + 1}. ${esc(CATEGORIES[catIdx])}</span><span class="letter-warn hidden">starts with ${letter}?</span></span>
      <input maxlength="40" autocomplete="off">`;
    const input = row.querySelector("input");
    const warn = row.querySelector(".letter-warn");
    input.addEventListener("input", () => {
      const n = normAns(input.value);
      const bad = n && n[0] !== letter.toLowerCase();
      warn.classList.toggle("hidden", !bad);
      input.classList.toggle("bad-letter", !!bad);
      const filled = [...wrap.querySelectorAll("input")].filter((x) => x.value.trim()).length;
      $("write-progress").textContent = `${filled}/8 filled`;
    });
    wrap.appendChild(row);
  }
  $("write-progress").textContent = "0/8 filled";
}

function renderWait() {
  const ul = $("wait-list");
  ul.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    const done = (p.submittedRound ?? 0) >= meta.round.num;
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : "✏️"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
}

function renderBoard() {
  if (!meta?.round) return;
  const review = meta.state === "review";
  $("board-title").textContent = review ? "🔍 Group review" : "🏁 Round scores";
  $("board-hint").textContent = review
    ? "Duplicates are already cancelled. Tap 👎 on any answer you don't buy — a majority of the group strikes it."
    : "Surviving answers score 2 points (+1 alliteration bonus).";

  const cols = sortedPlayers().filter(([id]) => answersRound[id]);
  const pts = meta.state === "results" ? (meta.round.pts || {}) : null;

  const table = document.createElement("table");
  table.id = "answers-table";
  const thead = document.createElement("thead");
  let headHtml = `<th class="cat-col">Category</th>`;
  for (const [id, p] of cols) {
    headHtml += `<th class="${id === pid ? "me-col" : ""}">${esc(p.name)}${pts ? ` <span class="round-pts">+${pts[id] || 0}</span>` : ""}</th>`;
  }
  thead.innerHTML = `<tr>${headHtml}</tr>`;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const [i, catIdx] of (meta.round.categories || []).entries()) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.className = "cat-col";
    th.textContent = CATEGORIES[catIdx];
    tr.appendChild(th);
    for (const [id] of cols) {
      const td = document.createElement("td");
      const raw = answersRound[id]?.a?.[i] || "";
      const st = cellStatus(i, id);
      const cell = document.createElement("div");
      cell.className = "cell-answer" + (st.ok ? "" : " struck");
      const ans = document.createElement("span");
      ans.className = "ans";
      ans.textContent = raw || "—";
      cell.appendChild(ans);
      if (!st.ok && raw) {
        const reason = document.createElement("span");
        reason.className = "reason";
        reason.textContent = st.reason;
        cell.appendChild(reason);
      }
      if (st.ok && st.bonus) {
        const b = document.createElement("span");
        b.className = "bonus-tag";
        b.textContent = "✨ alliteration +1";
        cell.appendChild(b);
      }
      // Challenge button stays visible on majority-struck answers so a
      // mis-tapped challenge can be withdrawn and the answer revived.
      const challengeable = st.ok || st.reason === "rejected by the group";
      if (review && raw && challengeable && id !== pid && me()) {
        const challengers = Object.keys(challengesRound[`c${i}_${id}`] || {}).length;
        const mine = !!challengesRound[`c${i}_${id}`]?.[pid];
        const btn = document.createElement("button");
        btn.className = "challenge-btn" + (mine ? " mine" : "");
        btn.textContent = `👎 ${challengers}`;
        btn.title = mine ? "Withdraw your challenge" : "Challenge this answer";
        btn.addEventListener("click", () => toggleChallenge(i, id));
        cell.appendChild(btn);
      }
      td.appendChild(cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const wrap = $("table-wrap");
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

function renderGameEnd() {
  const ov = $("overlay");
  ov.classList.remove("hidden");
  const box = $("overlay-content");
  const ranked = sortedPlayers()
    .map(([id, p]) => ({ id, name: p.name, score: p.score || 0 }))
    .sort((a, b) => b.score - a.score);
  const medals = ["🥇", "🥈", "🥉"];
  box.innerHTML = `
    <h2>🏁 Final scores</h2>
    <ol class="leaderboard">
      ${ranked.map((p, i) => `<li class="${i === 0 ? "first" : ""}"><span>${medals[i] || "•"} ${esc(p.name)}${p.id === pid ? " (you)" : ""}</span><strong>${p.score}</strong></li>`).join("")}
    </ol>
    ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
               : `<p class="hint">Waiting for the host…</p>`}
    <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
  box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
  box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || !["writing", "review", "results"].includes(meta.state)) {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", meta.state === "writing" && secs <= 10);
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
