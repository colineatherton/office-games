// Numbers Round — Countdown-style team maths, synced through Firebase RTDB.
// Everyone gets the same 6 tiles and target; each team scores on its closest
// expression. The host's client drives the state machine (lobby → answering →
// reveal → … → gameEnd) via whole-meta transactions, like the other games.

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

let roomCode = null;
let meta = null;
let players = {};
let answers = {};
let serverOffset = 0;
let loadedRound = -1;
let submittedLocal = false;
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
const iSubmitted = () =>
  submittedLocal || (me()?.submittedRound ?? -1) >= (meta?.round?.num ?? 1);

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// ── Expression parser (safe, no eval) ─────────────────────────────────────────
// Classic Countdown rules: every intermediate result must be a positive integer
// (division exact, subtraction stays positive); each tile usable at most once.
// PARSER-START
class ExprError extends Error {}

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t") { i++; continue; }
    if (ch === "x" || ch === "X" || ch === "×" || ch === "*") { toks.push("*"); i++; continue; }
    if (ch === "÷" || ch === "/") { toks.push("/"); i++; continue; }
    if (ch === "−" || ch === "-" || ch === "–") { toks.push("-"); i++; continue; }
    if ("+()".includes(ch)) { toks.push(ch); i++; continue; }
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < src.length && src[j] >= "0" && src[j] <= "9") j++;
      toks.push(Number(src.slice(i, j)));
      i = j;
      continue;
    }
    throw new ExprError(`Unexpected character "${ch}"`);
  }
  return toks;
}

function parseExpression(src, tiles) {
  const toks = tokenize(src);
  if (!toks.length) throw new ExprError("Type an expression");
  let pos = 0;
  const used = [];

  const peek = () => toks[pos];
  const next = () => toks[pos++];

  function parseExpr() {
    let v = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const r = parseTerm();
      if (op === "+") v = v + r;
      else {
        v = v - r;
        if (v <= 0) throw new ExprError("Subtraction must leave a positive number");
      }
    }
    return v;
  }

  function parseTerm() {
    let v = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const r = parseFactor();
      if (op === "*") v = v * r;
      else {
        if (v % r !== 0) throw new ExprError(`${v} ÷ ${r} isn't a whole number`);
        v = v / r;
      }
    }
    return v;
  }

  function parseFactor() {
    const t = next();
    if (typeof t === "number") { used.push(t); return t; }
    if (t === "(") {
      const v = parseExpr();
      if (next() !== ")") throw new ExprError("Missing closing bracket");
      return v;
    }
    throw new ExprError(t === undefined ? "Expression is incomplete" : `Unexpected "${t}"`);
  }

  const value = parseExpr();
  if (pos < toks.length) throw new ExprError(`Unexpected "${toks[pos]}" after the expression`);

  const avail = [...tiles];
  for (const n of used) {
    const idx = avail.indexOf(n);
    if (idx === -1) {
      throw new ExprError(tiles.includes(n)
        ? `You've used ${n} more times than you have it`
        : `${n} isn't one of your numbers`);
    }
    avail.splice(idx, 1);
  }
  return { value, used };
}
// PARSER-END

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
      game: "numbers",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 9, answerSeconds: 90 },
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
    if (snap.val().game !== "numbers") {
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
    submittedRound: existing?.submittedRound ?? -1,
  });
  trackPresence(db, meRef);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
  onValue(answersRef(), (s) => { answers = s.val() || {}; renderSubmitList(); });
}

function leaveRoom() {
  if (roomCode) set(ref(db, `rooms/${roomCode}/players/${pid}/connected`), false);
  location.hash = "";
  location.reload();
}
$("btn-leave-lobby").addEventListener("click", leaveRoom);

// ── State machine ─────────────────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function genRound(num, answerSeconds) {
  const nLarge = 1 + Math.floor(Math.random() * 3);
  const larges = shuffle([25, 50, 75, 100]).slice(0, nLarge);
  const smallPool = [];
  for (let v = 1; v <= 10; v++) smallPool.push(v, v);
  const smalls = shuffle(smallPool).slice(0, 6 - nLarge);
  return {
    num,
    tiles: shuffle([...larges, ...smalls]),
    target: 101 + Math.floor(Math.random() * 899),
    startAt: nowSrv(),
    endsAt: nowSrv() + answerSeconds * 1000,
  };
}

async function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  const redOk = conn.some((p) => p.team === "red");
  const blueOk = conn.some((p) => p.team === "blue");
  if (conn.length < 2 || !redOk || !blueOk) {
    $("start-hint").classList.remove("hidden");
    return;
  }
  const resets = {};
  for (const id of Object.keys(players)) resets[`${id}/submittedRound`] = -1;
  await update(playersRef(), resets);
  await remove(answersRef());

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    return {
      ...m,
      state: "answering",
      scores: { red: 0, blue: 0 },
      round: genRound(1, m.settings.answerSeconds),
    };
  });
}

const scoreBand = (d) => (d === 0 ? 10 : d <= 5 ? 7 : d <= 10 ? 5 : 0);

function advanceToReveal() {
  const n = meta.round.num;
  const target = meta.round.target;
  const roundAnswers = Object.values(answers).filter(
    (a) => a && a.round === n && typeof a.value === "number");
  const best = { red: null, blue: null };
  for (const a of roundAnswers) {
    const d = Math.abs(a.value - target);
    if (!best[a.team] || d < best[a.team].d) best[a.team] = { ...a, d };
  }
  const result = {};
  for (const t of ["red", "blue"]) {
    result[t] = best[t]
      ? { name: best[t].name, expr: best[t].expr, value: best[t].value, d: best[t].d, pts: scoreBand(best[t].d) }
      : null;
  }
  txMeta((m) => {
    if (m.state !== "answering" || m.round?.num !== n) return;
    return {
      ...m,
      state: "reveal",
      scores: {
        red: (m.scores?.red || 0) + (result.red?.pts || 0),
        blue: (m.scores?.blue || 0) + (result.blue?.pts || 0),
      },
      round: { ...m.round, endsAt: nowSrv() + 12000, result },
    };
  });
}

function nextRound() {
  const n = meta.round?.num;
  txMeta((m) => {
    if (m.state !== "reveal" || m.round?.num !== n) return;
    if (m.round.num >= m.settings.rounds) return { ...m, state: "gameEnd" };
    return { ...m, state: "answering", round: genRound(m.round.num + 1, m.settings.answerSeconds) };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null };
  }).then((res) => {
    if (res.committed) remove(answersRef());
  });
}

function abortToLobby() {
  txMeta((m) => {
    if (m.state === "lobby" || m.state === "gameEnd") return;
    return { ...m, state: "lobby", round: null };
  });
}

// ── Submitting ────────────────────────────────────────────────────────────────
function trySubmit(auto = false) {
  if (!meta || meta.state !== "answering" || iSubmitted()) return;
  const n = meta.round.num;
  const expr = $("expr-input").value.trim();
  let parsed = null;
  try {
    parsed = parseExpression(expr, meta.round.tiles);
  } catch (e) {
    if (!auto) { flashFeedback(e.message); return; }
  }
  submittedLocal = true;
  update(child(playersRef(), pid), { submittedRound: n });
  if (parsed) {
    set(ref(db, `rooms/${roomCode}/answers/${pid}`), {
      round: n, expr, value: parsed.value, name: me()?.name || "?", team: me()?.team || "red",
    });
  } else {
    remove(ref(db, `rooms/${roomCode}/answers/${pid}`));
  }
  render();
}

$("btn-submit").addEventListener("click", () => trySubmit(false));
$("expr-input").addEventListener("keydown", (e) => { if (e.key === "Enter") trySubmit(false); });
$("expr-input").addEventListener("input", renderFeedback);

function flashFeedback(msg) {
  const fb = $("expr-feedback");
  fb.textContent = msg;
  fb.className = "err";
}

function renderFeedback() {
  const fb = $("expr-feedback");
  if (!meta?.round || meta.state !== "answering") { fb.innerHTML = "&nbsp;"; return; }
  const src = $("expr-input").value.trim();
  const tiles = meta.round.tiles;
  let usedTiles = [];
  if (!src) {
    fb.innerHTML = "&nbsp;";
    fb.className = "";
  } else {
    try {
      const { value, used } = parseExpression(src, tiles);
      usedTiles = used;
      const d = Math.abs(value - meta.round.target);
      if (d === 0) { fb.textContent = `= ${value} — SPOT ON! 🎯`; fb.className = "exact"; }
      else { fb.textContent = `= ${value}  (${d} away)`; fb.className = d <= 10 ? "ok" : ""; }
    } catch (e) {
      fb.textContent = e.message;
      fb.className = "err";
    }
  }
  // Grey out consumed tiles
  const remaining = [...tiles];
  for (const n of usedTiles) {
    const i = remaining.indexOf(n);
    if (i !== -1) remaining.splice(i, 1);
  }
  const tileEls = [...$("tiles-row").children];
  const pool = [...remaining];
  for (const el of tileEls) {
    const v = Number(el.dataset.value);
    const i = pool.indexOf(v);
    if (i !== -1) { el.classList.remove("used"); pool.splice(i, 1); }
    else el.classList.add("used");
  }
}

// ── Tick: timer + fallbacks ───────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = meta.state === "answering" || meta.state === "reveal";
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) abortToLobby();
  } else {
    lowPlayersSince = null;
  }

  const r = meta.round;
  if (!r?.endsAt) return;
  const n = nowSrv();

  if (meta.state === "answering") {
    if (!iSubmitted() && n > r.endsAt && players[pid]) trySubmit(true);
    if (isHost()) {
      const waitingFor = Object.values(players).filter((p) =>
        p.connected && (p.joinedAt || 0) <= (r.startAt || Infinity) &&
        (p.submittedRound ?? -1) < r.num);
      if (!waitingFor.length || n > r.endsAt + 3000) advanceToReveal();
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
    loadedRound = -1;
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
    li.textContent = `${p.name}${meta.hostId === id ? " 👑" : ""}`;
    if (id === pid) { li.classList.add("me"); li.textContent += " (you)"; }
    (lists[p.team] || lists.red).appendChild(li);
  }
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) {
    $("set-rounds").value = String(meta.settings.rounds);
    $("set-seconds").value = String(meta.settings.answerSeconds);
    const conn = Object.values(players).filter((p) => p.connected);
    const ok = conn.length >= 2 &&
      conn.some((p) => p.team === "red") && conn.some((p) => p.team === "blue");
    if (ok) $("start-hint").classList.add("hidden");
  }
}

function renderGame() {
  const r = meta.round;
  $("round-info").textContent = r ? `Round ${r.num}/${meta.settings.rounds}` : "";
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;

  if (r && r.num !== loadedRound) {
    loadedRound = r.num;
    submittedLocal = false;
    $("expr-input").value = "";
    $("expr-feedback").innerHTML = "&nbsp;";
    $("expr-feedback").className = "";
    renderTiles();
  }

  $("target-value").textContent = r ? r.target : "---";

  const answering = meta.state === "answering" && !iSubmitted();
  $("expr-input").disabled = !answering;
  $("btn-submit").disabled = !answering;
  $("btn-submit").textContent = iSubmitted() ? "Locked in ✔" : "Lock it in ✔";

  renderSubmitList();
  renderOverlay();
  renderTimer();
}

function renderTiles() {
  const row = $("tiles-row");
  row.innerHTML = "";
  for (const v of meta.round?.tiles || []) {
    const d = document.createElement("div");
    d.className = "num-tile";
    d.dataset.value = v;
    d.textContent = v;
    d.addEventListener("click", () => {
      if ($("expr-input").disabled) return;
      const inp = $("expr-input");
      const cur = inp.value;
      inp.value = cur + (cur && !/[(+\-*/×÷ ]$/.test(cur) ? " + " : "") + v;
      inp.focus();
      renderFeedback();
    });
    row.appendChild(d);
  }
}

function renderSubmitList() {
  if (!meta?.round || meta.state === "lobby") return;
  const ul = $("submit-list");
  ul.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected && (p.submittedRound ?? -1) < meta.round.num) continue;
    const done = (p.submittedRound ?? -1) >= meta.round.num;
    const li = document.createElement("li");
    li.className = p.team === "blue" ? "blue-name" : "red-name";
    if (done) li.classList.add("done");
    li.textContent = `${done ? "✅" : "✏️"} ${p.name}${id === pid ? " (you)" : ""}`;
    ul.appendChild(li);
  }
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || meta.state === "lobby" || meta.state === "gameEnd") {
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

  if (meta.state === "reveal" && meta.round) {
    ov.classList.remove("hidden");
    const r = meta.round;
    const cols = ["red", "blue"].map((t) => {
      const best = r.result?.[t];
      const others = Object.values(answers)
        .filter((a) => a && a.round === r.num && a.team === t)
        .sort((a, b) => Math.abs(a.value - r.target) - Math.abs(b.value - r.target))
        .map((a) => `<li>${esc(a.name)}: ${esc(a.expr)} = ${a.value}</li>`).join("");
      return `
        <div class="reveal-team ${t}">
          <h3>${t === "red" ? "🔴 Red" : "🔵 Blue"} — <span class="reveal-pts">+${best?.pts ?? 0}</span></h3>
          ${best ? `
            <div class="reveal-best">
              <div class="expr">${esc(best.expr)} = ${best.value}</div>
              <div class="meta-line">${esc(best.name)} · ${best.d === 0 ? "exact! 🎯" : `${best.d} away`}</div>
            </div>` : `<div class="reveal-best"><div class="meta-line">No valid answer 😶</div></div>`}
          <ul class="reveal-others">${others}</ul>
        </div>`;
    }).join("");
    box.innerHTML = `
      <h2>Target was <span class="big-result">${r.target}</span></h2>
      <div class="reveal-teams">${cols}</div>`;
  } else if (meta.state === "gameEnd") {
    ov.classList.remove("hidden");
    const red = meta.scores?.red || 0, blue = meta.scores?.blue || 0;
    const headline = red === blue
      ? `<h2>🤝 It's a tie!</h2>`
      : red > blue
        ? `<h2 class="winner-red">🔴 Red Team wins!</h2>`
        : `<h2 class="winner-blue">🔵 Blue Team wins!</h2>`;
    box.innerHTML = `
      ${headline}
      <div class="big-result">${red} — ${blue}</div>
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
  update(child(metaRef(), "settings"), { answerSeconds: Number(e.target.value) }));

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
