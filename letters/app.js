// Letters Round — Countdown-style longest-word game, Red vs Blue.
// Each round all players get the same 9 letters and one shot at a word;
// each team scores the length of its best valid word. Synced via Firebase RTDB.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { WORDS } from "./dictionary.js";

const $ = (id) => document.getElementById(id);
const DICT = new Set(WORDS);

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
let subs = {};            // rooms/{code}/subs/{roundNum}/{pid} = {word, len, valid, team, name}
let serverOffset = 0;
let submittedLocal = false;
let localRound = -1;
let advancing = false;
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const subsRef = () => ref(db, `rooms/${roomCode}/subs`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const iSubmitted = () =>
  submittedLocal || (me()?.submittedRound ?? -1) >= (meta?.round?.num ?? 0);

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
      game: "letters",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 9, seconds: 45 },
      scores: { red: 0, blue: 0 },
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
    if (snap.val().game !== "letters") {
      joinError(`Room ${code} is a ${snap.val().game || "different"} room — join it from that game's page.`);
      return;
    }
    await enterRoom(code, name, snap.val());
  } catch (e) {
    joinError("Couldn't reach the database. Check the Firebase config and your network. (" + e.message + ")");
  }
});

async function enterRoom(code, name, joinMeta = null) {
  roomCode = code;
  location.hash = code;

  const meRef = child(playersRef(), pid);
  const existing = (await get(meRef)).val();
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

  // A brand-new player joining mid-round sits that round out (counts as
  // submitted) and plays from the next one.
  const midRound = !existing && joinMeta?.state === "answering" ? (joinMeta.round?.num ?? -1) : null;

  await update(meRef, {
    name, team,
    connected: true,
    joinedAt: existing?.joinedAt || serverTimestamp(),
    submittedRound: midRound ?? (existing?.submittedRound ?? -1),
  });
  trackPresence(db, meRef);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
  onValue(subsRef(), (s) => { subs = s.val() || {}; render(); });
}

function leaveRoom() {
  if (roomCode) set(ref(db, `rooms/${roomCode}/players/${pid}/connected`), false);
  location.hash = "";
  location.reload();
}
$("btn-leave-lobby").addEventListener("click", leaveRoom);

// ── Letters & word validation ─────────────────────────────────────────────────
const VOWEL_POOL = "eeeeeeeeeeeeaaaaaaaaaiiiiiiiiioooooooouuuu";
const CONS_POOL = "nnnnnnrrrrrrttttttllllssssddddgggbbcccmmmpppffhhhvvwwyykjxqz";

function genLetters() {
  const pick = (pool, n) => {
    const arr = pool.split("");
    const out = [];
    for (let i = 0; i < n; i++) out.push(arr.splice(Math.floor(Math.random() * arr.length), 1)[0]);
    return out;
  };
  const nv = 3 + Math.floor(Math.random() * 3); // 3–5 vowels
  const letters = [...pick(VOWEL_POOL, nv), ...pick(CONS_POOL, 9 - nv)];
  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [letters[i], letters[j]] = [letters[j], letters[i]];
  }
  return letters.join("").toUpperCase();
}

// Which rack positions does `word` consume? Returns null if not buildable.
function rackUsage(word, letters) {
  const rack = letters.toLowerCase().split("");
  const used = [];
  for (const ch of word) {
    const i = rack.indexOf(ch);
    if (i === -1) return null;
    rack[i] = null;
    used.push(i);
  }
  return used;
}

// Rebuild index after consuming: simpler correct approach — track used flags.
function usedIndices(word, letters) {
  const rack = letters.toLowerCase().split("");
  const taken = new Array(9).fill(false);
  for (const ch of word) {
    let found = -1;
    for (let i = 0; i < rack.length; i++) {
      if (!taken[i] && rack[i] === ch) { found = i; break; }
    }
    if (found === -1) return null;
    taken[found] = true;
  }
  return taken;
}

// ── State transitions ─────────────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

async function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  const reds = conn.filter((p) => p.team === "red").length;
  const blues = conn.filter((p) => p.team === "blue").length;
  if (conn.length < 2 || !reds || !blues) {
    const hint = $("start-hint");
    hint.textContent = "Need at least 2 players with someone on each team.";
    hint.classList.remove("hidden");
    return;
  }
  const resets = {};
  for (const id of Object.keys(players)) resets[`${id}/submittedRound`] = -1;
  await update(playersRef(), resets);
  await remove(subsRef());

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    return {
      ...m,
      state: "answering",
      scores: { red: 0, blue: 0 },
      round: { num: 1, letters: genLetters(), endsAt: nowSrv() + m.settings.seconds * 1000 },
    };
  });
}

function submitWord(auto = false) {
  if (!meta || meta.state !== "answering" || iSubmitted() || !me()) return;
  const word = $("word-input").value.trim().toLowerCase().replace(/[^a-z]/g, "");
  const letters = meta.round.letters;
  const buildable = word.length >= 3 && usedIndices(word, letters) !== null;
  const valid = buildable && DICT.has(word);
  if (!auto && !word) { $("word-input").focus(); return; }
  submittedLocal = true;
  set(ref(db, `rooms/${roomCode}/subs/${meta.round.num}/${pid}`), {
    word, len: word.length, valid,
    team: me().team, name: me().name,
  });
  update(child(playersRef(), pid), { submittedRound: meta.round.num });
  render();
}
$("btn-submit").addEventListener("click", () => submitWord(false));
$("word-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitWord(false); });
$("word-input").addEventListener("input", renderRackAndStatus);

function advanceToReveal() {
  if (advancing) return;
  advancing = true;
  const num = meta.round.num;
  const roundSubs = subs[num] || {};
  const best = { red: null, blue: null };
  for (const [sid, s] of Object.entries(roundSubs)) {
    if (!s.valid) continue;
    if (!best[s.team] || s.len > best[s.team].len) best[s.team] = { word: s.word, len: s.len, name: s.name };
  }
  txMeta((m) => {
    if (m.state !== "answering" || m.round?.num !== num) return;
    return {
      ...m,
      state: "reveal",
      scores: {
        red: (m.scores?.red || 0) + (best.red?.len || 0),
        blue: (m.scores?.blue || 0) + (best.blue?.len || 0),
      },
      round: { ...m.round, endsAt: nowSrv() + 10000, best },
    };
  }).finally(() => { advancing = false; });
}

function nextRound() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "reveal" || m.round?.num !== expect) return;
    if (m.round.num >= m.settings.rounds) return { ...m, state: "gameEnd" };
    return {
      ...m,
      state: "answering",
      round: { num: m.round.num + 1, letters: genLetters(), endsAt: nowSrv() + m.settings.seconds * 1000 },
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null };
  }).then((res) => { if (res.committed) remove(subsRef()); });
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = meta.state === "answering" || meta.state === "reveal";
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => (m.state === "lobby" || m.state === "gameEnd") ? undefined
        : { ...m, state: "lobby", round: null });
    }
  } else {
    lowPlayersSince = null;
  }

  const r = meta.round;
  if (!r?.endsAt) return;
  const n = nowSrv();

  if (meta.state === "answering") {
    if (!iSubmitted() && n > r.endsAt) submitWord(true);
    if (isHost()) {
      const allDone = Object.entries(players).every(([id, p]) =>
        !p.connected || (p.submittedRound ?? -1) >= r.num);
      if (allDone || n > r.endsAt + 3000) advanceToReveal();
    }
  } else if (meta.state === "reveal") {
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
function render() {
  if (!meta) return;
  if (meta.state === "lobby") {
    localRound = -1;
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
  const lists = { red: $("lobby-red-list"), blue: $("lobby-blue-list") };
  lists.red.innerHTML = "";
  lists.blue.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    const li = document.createElement("li");
    li.textContent = `${p.name}${meta.hostId === id ? " 👑" : ""}${id === pid ? " (you)" : ""}`;
    if (id === pid) li.classList.add("me");
    (lists[p.team] || lists.red).appendChild(li);
  }
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) {
    $("set-rounds").value = String(meta.settings.rounds);
    $("set-seconds").value = String(meta.settings.seconds);
  }
}

function renderGame() {
  const r = meta.round;
  if (!r) return;

  if (r.num !== localRound && meta.state === "answering") {
    localRound = r.num;
    submittedLocal = false;
    $("word-input").value = "";
  }

  $("round-info").textContent = `Round ${r.num}/${meta.settings.rounds}`;
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;

  renderRackAndStatus();
  renderChecklist();

  const answering = meta.state === "answering";
  $("view-answer").classList.toggle("hidden", !(answering && !iSubmitted()));
  $("view-wait").classList.toggle("hidden", !(answering && iSubmitted()));
  if (answering && iSubmitted()) {
    const mySub = subs[r.num]?.[pid];
    $("wait-word").textContent = mySub?.word ? mySub.word : "(nothing — ouch)";
    $("wait-title").textContent = mySub?.word && !mySub.valid ? "🔒 Locked in… riskily" : "🔒 Locked in!";
  }

  renderOverlay();
  renderTimer();
}

function renderRackAndStatus() {
  const r = meta?.round;
  const rack = $("rack");
  rack.innerHTML = "";
  if (!r?.letters) return;

  const word = $("word-input").value.trim().toLowerCase().replace(/[^a-z]/g, "");
  const taken = word ? usedIndices(word, r.letters) : new Array(9).fill(false);

  r.letters.split("").forEach((ch, i) => {
    const t = document.createElement("div");
    t.className = "tile" + (taken && taken[i] ? " used" : "");
    t.textContent = ch;
    rack.appendChild(t);
  });

  const status = $("word-status");
  if (meta.state !== "answering" || iSubmitted()) { status.textContent = " "; return; }
  status.className = "word-status";
  if (!word) {
    status.textContent = " ";
  } else if (taken === null) {
    status.textContent = "✖ uses letters you don't have";
    status.classList.add("bad");
  } else if (word.length < 3) {
    status.textContent = "needs at least 3 letters";
  } else if (!DICT.has(word)) {
    status.textContent = "⚠ not in our dictionary — would score 0";
    status.classList.add("warn");
  } else {
    status.textContent = `✓ valid — worth ${word.length} points`;
    status.classList.add("ok");
  }
}

function renderChecklist() {
  const ul = $("checklist");
  ul.innerHTML = "";
  const r = meta.round;
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    const done = (p.submittedRound ?? -1) >= (r?.num ?? 0);
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : "✏️"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || (meta.state !== "answering" && meta.state !== "reveal")) {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", meta.state === "answering" && secs <= 10);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");
  const r = meta.round;

  if (meta.state === "reveal" && r) {
    ov.classList.remove("hidden");
    const roundSubs = subs[r.num] || {};
    const cols = { red: [], blue: [] };
    for (const s of Object.values(roundSubs)) {
      (cols[s.team] || cols.red).push(s);
    }
    for (const t of ["red", "blue"]) cols[t].sort((a, b) => b.len - a.len);

    const colHtml = (t, label) => {
      const bestWord = r.best?.[t]?.word;
      const items = cols[t].map((s) => {
        const isBest = s.valid && s.word === bestWord;
        return `<li class="${s.valid ? "" : "invalid"}${isBest ? " best" : ""}">
          ${esc(s.name)}: <span class="w">${esc(s.word) || "—"}</span>${s.valid ? ` (${s.len})` : ""}${isBest ? " ⭐" : ""}
        </li>`;
      }).join("");
      const pts = r.best?.[t]?.len || 0;
      return `<div class="reveal-col ${t}"><h3>${label}</h3><ul>${items || "<li>—</li>"}</ul>
        <div class="round-points">+${pts} points</div></div>`;
    };

    box.innerHTML = `
      <h2>Round ${r.num} results</h2>
      <div class="reveal-cols">${colHtml("red", "🔴 Red")}${colHtml("blue", "🔵 Blue")}</div>`;
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
$("set-seconds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { seconds: Number(e.target.value) }));

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
