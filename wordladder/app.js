// Word Ladder Race — Red vs Blue race up the same ladder, one letter per step.
// All game state lives under rooms/{CODE} in RTDB; transitions and chain edits
// go through whole-meta transactions so simultaneous teammates serialize safely.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, onValue, onDisconnect,
  runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { DICT, PUZZLES } from "./words.js";

const $ = (id) => document.getElementById(id);

// ── Config check ──────────────────────────────────────────────────────────────
if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("PASTE")) {
  showScreen("setup");
  throw new Error("Firebase config not filled in — see firebase-config.js");
}

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const DICT_SET = new Set(DICT);
const ROUND_MS = 180000; // 3-minute cap per round

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
const myTeam = () => me()?.team || "red";
const oppTeam = () => (myTeam() === "red" ? "blue" : "red");
const isHost = () => meta?.hostId === pid;

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
      game: "wordladder",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 5 },
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
    if (snap.val().game !== "wordladder") {
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
  await update(meRef, {
    name, team,
    connected: true,
    joinedAt: existing?.joinedAt || serverTimestamp(),
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

// ── Word helpers ──────────────────────────────────────────────────────────────
const oneDiff = (a, b) => {
  if (!a || !b || a.length !== 4 || b.length !== 4) return false;
  let d = 0;
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) d++;
  return d === 1;
};

// BFS over DICT for the round-end "shortest path" reveal.
let patternMap = null;
function buildPatternMap() {
  patternMap = new Map();
  for (const w of DICT) {
    for (let i = 0; i < 4; i++) {
      const k = w.slice(0, i) + "*" + w.slice(i + 1);
      if (!patternMap.has(k)) patternMap.set(k, []);
      patternMap.get(k).push(w);
    }
  }
}
function bfsPath(start, target) {
  if (!patternMap) buildPatternMap();
  const prev = new Map([[start, null]]);
  let frontier = [start];
  while (frontier.length) {
    const next = [];
    for (const w of frontier) {
      for (let i = 0; i < 4; i++) {
        const k = w.slice(0, i) + "*" + w.slice(i + 1);
        for (const n of patternMap.get(k) || []) {
          if (prev.has(n)) continue;
          prev.set(n, w);
          if (n === target) {
            const path = [n];
            let cur = w;
            while (cur) { path.unshift(cur); cur = prev.get(cur); }
            return path;
          }
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return null;
}

// ── State-machine transactions ────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function pickPuzzle(used = {}) {
  let pool = PUZZLES.map((p, i) => i).filter((i) => !used[`p${i}`]);
  if (!pool.length) pool = PUZZLES.map((_, i) => i);
  return pool[Math.floor(Math.random() * pool.length)];
}

function makeRound(num, used) {
  const idx = pickPuzzle(used);
  const p = PUZZLES[idx];
  return {
    round: {
      num,
      start: p.start, target: p.target, par: p.par,
      chains: { red: [p.start], blue: [p.start] },
      endsAt: nowSrv() + ROUND_MS,
    },
    usedKey: `p${idx}`,
  };
}

function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  const red = conn.filter((p) => p.team === "red").length;
  const blue = conn.filter((p) => p.team === "blue").length;
  if (!red || !blue) {
    const hint = $("start-hint");
    hint.textContent = "Need at least one player on each team.";
    hint.classList.remove("hidden");
    return;
  }
  txMeta((m) => {
    if (m.state !== "lobby") return;
    const { round, usedKey } = makeRound(1, {});
    return {
      ...m, state: "playing",
      scores: { red: 0, blue: 0 },
      usedPuzzles: { [usedKey]: true },
      round,
    };
  });
}

function nextRound() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "roundEnd" || m.round?.num !== expect) return;
    if (m.round.num >= m.settings.rounds) return { ...m, state: "gameEnd" };
    const used = m.usedPuzzles || {};
    const { round, usedKey } = makeRound(m.round.num + 1, used);
    return { ...m, state: "playing", usedPuzzles: { ...used, [usedKey]: true }, round };
  });
}

function endRoundNoWinner() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "playing" || m.round?.num !== expect) return;
    return { ...m, state: "roundEnd", round: { ...m.round, endsAt: nowSrv() + 10000 } };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedPuzzles: null };
  });
}

function abortToLobby() {
  txMeta((m) => {
    if (m.state === "lobby" || m.state === "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedPuzzles: null };
  });
}

// ── Playing actions ───────────────────────────────────────────────────────────
function feedback(msg, cls = "") {
  const el = $("word-feedback");
  el.textContent = msg || " ";
  el.className = "feedback " + cls;
}

function shakeInput() {
  const el = $("word-input");
  el.classList.remove("shake");
  void el.offsetWidth;
  el.classList.add("shake");
}

$("word-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("word-input");
  const word = input.value.trim().toLowerCase();
  const r = meta?.round;
  if (!r || meta.state !== "playing") return;
  const team = myTeam();
  if (r.finished?.[team]) return;

  const chain = r.chains?.[team] || [];
  const tail = chain[chain.length - 1];
  if (!/^[a-z]{4}$/.test(word)) { shakeInput(); feedback("Four letters, a–z.", "bad"); return; }
  if (!oneDiff(tail, word)) { shakeInput(); feedback(`Must change exactly one letter of ${tail.toUpperCase()}.`, "bad"); return; }
  if (!DICT_SET.has(word)) { shakeInput(); feedback("Not in the word list.", "bad"); return; }
  if (chain.includes(word)) { shakeInput(); feedback("Already on your ladder.", "bad"); return; }

  input.value = "";
  feedback("");
  const roundNum = r.num;
  txMeta((m) => {
    if (m.state !== "playing" || m.round?.num !== roundNum) return;
    const c = m.round.chains?.[team] || [];
    const t = c[c.length - 1];
    if (m.round.finished?.[team]) return;
    if (!oneDiff(t, word) || c.includes(word)) return;
    const chains = { ...m.round.chains, [team]: [...c, word] };
    let m2 = { ...m, round: { ...m.round, chains } };
    if (word === m.round.target) {
      const steps = chains[team].length - 1;
      const bonus = steps <= m.round.par ? 5 : 0;
      m2.scores = { ...m.scores, [team]: (m.scores?.[team] || 0) + 20 + bonus };
      m2.round = {
        ...m2.round,
        finished: { ...(m.round.finished || {}), [team]: true },
        winnerTeam: team,
        winnerBonus: bonus,
        endsAt: nowSrv() + 10000,
      };
      m2.state = "roundEnd";
    }
    return m2;
  }).then((res) => {
    if (!res.committed) feedback("A teammate just changed the ladder — check the new top word.", "bad");
  });
});

$("btn-undo").addEventListener("click", () => {
  const r = meta?.round;
  if (!r || meta.state !== "playing") return;
  const team = myTeam();
  const roundNum = r.num;
  txMeta((m) => {
    if (m.state !== "playing" || m.round?.num !== roundNum) return;
    const c = m.round.chains?.[team] || [];
    if (c.length <= 1 || m.round.finished?.[team]) return;
    return { ...m, round: { ...m.round, chains: { ...m.round.chains, [team]: c.slice(0, -1) } } };
  });
});

$("btn-giveup").addEventListener("click", () => {
  const r = meta?.round;
  if (!r || meta.state !== "playing") return;
  if (!confirm("Give up this round? If the other team gives up too, the round ends with no points.")) return;
  const team = myTeam();
  const roundNum = r.num;
  txMeta((m) => {
    if (m.state !== "playing" || m.round?.num !== roundNum) return;
    const giveUp = { ...(m.round.giveUp || {}), [team]: true };
    let m2 = { ...m, round: { ...m.round, giveUp } };
    if (giveUp.red && giveUp.blue) {
      m2.state = "roundEnd";
      m2.round = { ...m2.round, endsAt: nowSrv() + 10000 };
    }
    return m2;
  });
});

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = meta.state === "playing" || meta.state === "roundEnd";
  const conn = Object.values(players).filter((p) => p.connected);
  const teamsOk = conn.some((p) => p.team === "red") && conn.some((p) => p.team === "blue");
  if (active && (conn.length < 2 || !teamsOk)) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) abortToLobby();
  } else {
    lowPlayersSince = null;
  }

  const r = meta.round;
  if (!r?.endsAt || !isHost()) return;
  const n = nowSrv();
  if (meta.state === "playing" && n > r.endsAt) endRoundNoWinner();
  else if (meta.state === "roundEnd" && n > r.endsAt) nextRound();
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

// ── Rendering ─────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
    $("start-hint").classList.add("hidden");
  }
}

function renderGame() {
  const r = meta.round;
  if (!r) return;
  $("round-info").textContent = `Round ${r.num}/${meta.settings.rounds}`;
  $("word-start").textContent = r.start;
  $("word-target").textContent = r.target;
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;
  $("par-note").textContent = `Par: ${r.par} steps`;

  const team = myTeam();
  const chain = r.chains?.[team] || [r.start];
  const oppChain = r.chains?.[oppTeam()] || [r.start];

  // My ladder (column-reverse: start sits at the bottom, target ghost on top)
  const ladder = $("ladder");
  ladder.innerHTML = "";
  chain.forEach((w, i) => {
    ladder.appendChild(rungEl(w, i === 0 ? null : chain[i - 1], {
      start: i === 0,
      solved: w === r.target,
    }));
  });
  if (chain[chain.length - 1] !== r.target) {
    const ghost = rungEl(r.target, null, {});
    ghost.classList.add("target-row");
    ladder.appendChild(ghost);
  }
  ladder.scrollTop = 0;

  // Opponent status
  $("opp-title").textContent = oppTeam() === "red" ? "🔴 Their ladder" : "🔵 Their ladder";
  const oppEl = $("opp-rungs");
  const oppSteps = oppChain.length - 1;
  if (r.finished?.[oppTeam()]) {
    oppEl.textContent = `FINISHED in ${oppSteps} 😱`;
    oppEl.classList.add("finished");
  } else {
    oppEl.textContent = `${oppSteps} step${oppSteps === 1 ? "" : "s"}${r.giveUp?.[oppTeam()] ? " · 🏳 gave up" : ""}`;
    oppEl.classList.remove("finished");
  }

  // Player list
  const pl = $("player-list");
  pl.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    const row = document.createElement("div");
    row.className = `player-row ${p.team}`;
    if (!p.connected) row.classList.add("offline");
    if (id === pid) row.classList.add("me");
    row.textContent = `${p.name}${meta.hostId === id ? " 👑" : ""}`;
    pl.appendChild(row);
  }

  // Controls
  const playing = meta.state === "playing";
  const done = r.finished?.[team] || r.giveUp?.[team];
  $("word-input").disabled = !playing || !!done;
  $("btn-undo").disabled = !playing || !!done || chain.length <= 1;
  $("btn-giveup").disabled = !playing || !!done;
  if (done && playing) feedback(r.finished?.[team] ? "🎉 Finished! Watching the other team sweat…" : "🏳 Gave up — waiting for the other team.", "good");

  renderOverlay();
  renderTimer();
}

function rungEl(word, prevWord, { start = false, solved = false }) {
  const div = document.createElement("div");
  div.className = "rung" + (start ? " start" : "") + (solved ? " solved" : "");
  for (let i = 0; i < 4; i++) {
    const c = document.createElement("div");
    c.className = "cell" + (prevWord && word[i] !== prevWord[i] ? " changed" : "");
    c.textContent = word[i];
    div.appendChild(c);
  }
  return div;
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || meta.state !== "playing") {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  el.classList.toggle("low", secs <= 20);
}

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");
  const r = meta.round;

  if (meta.state === "roundEnd" && r) {
    ov.classList.remove("hidden");
    if (r.winnerTeam) {
      const wc = r.chains[r.winnerTeam] || [];
      const lossTeam = r.winnerTeam === "red" ? "blue" : "red";
      const lc = r.chains[lossTeam] || [];
      box.innerHTML = `
        <h2 class="winner-${r.winnerTeam}">${r.winnerTeam === "red" ? "🔴 Red" : "🔵 Blue"} made it in ${wc.length - 1} steps!
          ${r.winnerBonus ? " ⭐ under par +5" : ""}</h2>
        <div class="chain-reveal">${wc.map((w) => `<span class="chip gold">${esc(w)}</span>`).join("")}</div>
        <p class="hint">${lossTeam === "red" ? "🔴" : "🔵"} got ${lc.length - 1} step${lc.length === 2 ? "" : "s"} up: so close.</p>
        <div class="chain-reveal">${lc.map((w) => `<span class="chip">${esc(w)}</span>`).join("")}</div>`;
    } else {
      const path = bfsPath(r.start, r.target);
      box.innerHTML = `
        <h2>⏱ Nobody made it</h2>
        <p class="hint">One shortest path (${r.par} steps):</p>
        <div class="chain-reveal">${(path || []).map((w) => `<span class="chip gold">${esc(w)}</span>`).join("")}</div>`;
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
      <div class="big-word">${red} — ${blue}</div>
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
