// Hangman Duel — Red vs Blue on the same hidden phrase, each team with its own
// gallows. All state lives under rooms/{CODE} in RTDB; transitions go through
// whole-meta transactions so simultaneous clicks serialize safely.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { PHRASES } from "./phrases.js";

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

const TURN_MS = 30000;
const MAX_WRONGS = 6;

let roomCode = null;
let meta = null;
let players = {};
let serverOffset = 0;
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;
let emptyTurnSince = null;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const otherTeam = (t) => (t === "red" ? "blue" : "red");

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
      game: "hangman",
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
    if (snap.val().game !== "hangman") {
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

// ── Phrase helpers ────────────────────────────────────────────────────────────
const phraseLetters = (phrase) => new Set(phrase.replace(/[^a-z]/g, ""));
const isComplete = (phrase, guessed) =>
  [...phraseLetters(phrase)].every((ch) => guessed[ch]);
const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

function pickPhrase(used) {
  let pool = PHRASES.map((p, i) => i).filter((i) => !used["p" + i]);
  if (!pool.length) pool = PHRASES.map((p, i) => i);
  const idx = pool[Math.floor(Math.random() * pool.length)];
  return { idx, entry: PHRASES[idx] };
}

function newRound(num, idx, entry) {
  return {
    num, phraseIdx: idx,
    phrase: entry.phrase, category: entry.category,
    guessed: {}, wrongs: { red: 0, blue: 0 }, points: { red: 0, blue: 0 },
    turn: num % 2 === 1 ? "red" : "blue",
    turnEndsAt: nowSrv() + TURN_MS,
  };
}

// ── State-machine transactions ────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function startGame() {
  const conn = Object.values(players).filter((p) => p.connected);
  const red = conn.filter((p) => p.team === "red").length;
  const blue = conn.filter((p) => p.team === "blue").length;
  if (!red || !blue) {
    const hint = $("start-hint");
    hint.textContent = "Both teams need at least one player.";
    hint.classList.remove("hidden");
    return;
  }
  txMeta((m) => {
    if (m.state !== "lobby") return;
    const { idx, entry } = pickPhrase(m.usedPhrases || {});
    return {
      ...m,
      state: "playing",
      scores: { red: 0, blue: 0 },
      usedPhrases: { ...(m.usedPhrases || {}), ["p" + idx]: true },
      round: newRound(1, idx, entry),
    };
  });
}

// Shared miss handling: adds a gallows piece for `team` and resolves the turn.
// Mutates and returns the new meta object (m2 already has fresh round copies).
function applyMiss(m2, team, last) {
  const wrongs = { ...(m2.round.wrongs || { red: 0, blue: 0 }) };
  wrongs[team] = (wrongs[team] || 0) + 1;
  m2.round.wrongs = wrongs;
  m2.round.last = last;
  const other = otherTeam(team);
  if (wrongs[team] >= MAX_WRONGS && (wrongs[other] || 0) >= MAX_WRONGS) {
    m2.state = "roundEnd";
    m2.round.endsAt = nowSrv() + 8000;
    m2.round.note = "Both teams ran out of guesses 😵";
  } else if ((wrongs[other] || 0) < MAX_WRONGS) {
    m2.round.turn = other;
    m2.round.turnEndsAt = nowSrv() + TURN_MS;
  } else {
    // Opponent already locked out — current team plays on alone.
    m2.round.turnEndsAt = nowSrv() + TURN_MS;
  }
  return m2;
}

function pickLetter(letter) {
  const team = me()?.team;
  const name = me()?.name || "?";
  if (!team) return;
  txMeta((m) => {
    if (m.state !== "playing" || !m.round) return;
    const r = m.round;
    const guessed = r.guessed || {};
    if (guessed[letter] || r.turn !== team || (r.wrongs?.[team] || 0) >= MAX_WRONGS) return;

    const m2 = { ...m, round: { ...r, guessed: { ...guessed, [letter]: true } } };
    const occ = [...r.phrase].filter((c) => c === letter).length;
    if (occ > 0) {
      const complete = isComplete(r.phrase, m2.round.guessed);
      const pts = 2 * occ + (complete ? 10 : 0);
      m2.scores = { ...m.scores, [team]: (m.scores[team] || 0) + pts };
      m2.round.points = { ...(r.points || {}), [team]: (r.points?.[team] || 0) + pts };
      m2.round.last = { name, team, kind: "hit", letter, n: occ, pts };
      if (complete) {
        m2.state = "roundEnd";
        m2.round.endsAt = nowSrv() + 8000;
        m2.round.note = `${name} revealed the last letter! +10 bonus`;
      } else {
        m2.round.turnEndsAt = nowSrv() + TURN_MS; // same team goes again
      }
      return m2;
    }
    return applyMiss(m2, team, { name, team, kind: "miss", letter });
  });
}

function trySolve(text) {
  const team = me()?.team;
  const name = me()?.name || "?";
  if (!team || !text.trim()) return;
  txMeta((m) => {
    if (m.state !== "playing" || !m.round) return;
    const r = m.round;
    if (r.turn !== team || (r.wrongs?.[team] || 0) >= MAX_WRONGS) return;

    const m2 = { ...m, round: { ...r } };
    if (norm(text) === norm(r.phrase)) {
      const pts = 15;
      m2.scores = { ...m.scores, [team]: (m.scores[team] || 0) + pts };
      m2.round.points = { ...(r.points || {}), [team]: (r.points?.[team] || 0) + pts };
      m2.round.last = { name, team, kind: "solved", pts };
      m2.state = "roundEnd";
      m2.round.endsAt = nowSrv() + 8000;
      m2.round.note = `${name} solved it! +15`;
      return m2;
    }
    return applyMiss(m2, team, { name, team, kind: "solveWrong" });
  });
}

function passTurn(reason) {
  txMeta((m) => {
    if (m.state !== "playing" || !m.round) return;
    const r = m.round;
    if (nowSrv() < r.turnEndsAt && reason !== "empty") return; // recheck inside tx
    const m2 = { ...m, round: { ...r } };
    const other = otherTeam(r.turn);
    if ((r.wrongs?.[other] || 0) < MAX_WRONGS) m2.round.turn = other;
    m2.round.turnEndsAt = nowSrv() + TURN_MS;
    m2.round.last = { team: r.turn, kind: "pass" };
    return m2;
  });
}

function nextRound() {
  const expect = meta?.round?.num;
  txMeta((m) => {
    if (m.state !== "roundEnd" || m.round?.num !== expect) return;
    if (m.round.num >= m.settings.rounds) return { ...m, state: "gameEnd" };
    const { idx, entry } = pickPhrase(m.usedPhrases || {});
    return {
      ...m,
      state: "playing",
      usedPhrases: { ...(m.usedPhrases || {}), ["p" + idx]: true },
      round: newRound(m.round.num + 1, idx, entry),
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null };
  });
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = meta.state === "playing" || meta.state === "roundEnd";
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

  if (!isHost()) return;
  const r = meta.round;
  if (meta.state === "playing" && r) {
    if (nowSrv() > r.turnEndsAt) passTurn("timeout");
    const turnTeamAlive = Object.values(players)
      .some((p) => p.connected && p.team === r.turn);
    if (!turnTeamAlive) {
      emptyTurnSince ??= Date.now();
      if (Date.now() - emptyTurnSince > 15000) { emptyTurnSince = null; passTurn("empty"); }
    } else {
      emptyTurnSince = null;
    }
  } else if (meta.state === "roundEnd" && r?.endsAt && nowSrv() > r.endsAt) {
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
  const myTeam = me()?.team;
  const guessed = r.guessed || {};
  const over = meta.state !== "playing";

  $("round-info").textContent = `Round ${r.num}/${meta.settings.rounds}`;
  $("score-red").textContent = meta.scores?.red || 0;
  $("score-blue").textContent = meta.scores?.blue || 0;
  $("category-chip").textContent = `${r.category} · ${phraseLetters(r.phrase).size} letters`;

  // Turn banner
  const banner = $("turn-banner");
  if (meta.state === "playing") {
    const mine = r.turn === myTeam;
    banner.textContent = `${r.turn === "red" ? "🔴 Red's" : "🔵 Blue's"} turn${mine ? " — you're up!" : ""}`;
    banner.className = r.turn;
  } else {
    banner.textContent = "";
    banner.className = "";
  }

  // Phrase slots
  const pd = $("phrase-display");
  pd.innerHTML = "";
  for (const word of r.phrase.split(" ")) {
    const w = document.createElement("span");
    w.className = "word";
    for (const ch of word) {
      const slot = document.createElement("span");
      if (/[a-z]/.test(ch)) {
        const shown = guessed[ch] || over;
        slot.className = "slot" + (guessed[ch] ? " revealed" : "");
        slot.textContent = shown ? ch : " ";
      } else {
        slot.className = "slot punct";
        slot.textContent = ch;
      }
      w.appendChild(slot);
    }
    pd.appendChild(w);
  }

  // Last action
  const la = $("last-action");
  const l = r.last;
  if (!l) la.innerHTML = "&nbsp;";
  else if (l.kind === "hit") la.innerHTML = `${esc(l.name)} picked ${l.letter.toUpperCase()} — <span class="good">${l.n} found! +${l.pts}</span>`;
  else if (l.kind === "miss") la.innerHTML = `${esc(l.name)} picked ${l.letter.toUpperCase()} — <span class="bad">nope! a piece for the gallows</span>`;
  else if (l.kind === "solveWrong") la.innerHTML = `${esc(l.name)} tried to solve — <span class="bad">wrong! a piece for the gallows</span>`;
  else if (l.kind === "solved") la.innerHTML = `<span class="good">${esc(l.name)} solved it! +${l.pts}</span>`;
  else if (l.kind === "pass") la.innerHTML = `⏳ ${l.team} ran out of time — turn passed`;

  // Gallows
  renderGallows("red", r.wrongs?.red || 0);
  renderGallows("blue", r.wrongs?.blue || 0);
  $("locked-red").classList.toggle("hidden", (r.wrongs?.red || 0) < MAX_WRONGS);
  $("locked-blue").classList.toggle("hidden", (r.wrongs?.blue || 0) < MAX_WRONGS);

  // Keyboard
  const canAct = meta.state === "playing" && r.turn === myTeam &&
    (r.wrongs?.[myTeam] || 0) < MAX_WRONGS;
  for (const btn of $("keyboard").children) {
    const letter = btn.dataset.l;
    const used = !!guessed[letter];
    btn.disabled = used || !canAct;
    btn.className = used ? (r.phrase.includes(letter) ? "hit" : "miss") : "";
  }

  // Solve controls
  $("solve-row").style.visibility = canAct ? "visible" : "hidden";
  if (!canAct) hideSolveForm();

  renderOverlay();
  renderTimer();
}

function renderGallows(team, wrongs) {
  const svg = $(`gallows-${team}`);
  if (!svg.childElementCount) {
    svg.innerHTML = `
      <line class="frame" x1="10" y1="132" x2="110" y2="132"></line>
      <line class="part p1" x1="30" y1="132" x2="30" y2="15"></line>
      <line class="part p2" x1="30" y1="15" x2="80" y2="15"></line>
      <line class="part p3" x1="80" y1="15" x2="80" y2="35"></line>
      <circle class="part p4" cx="80" cy="48" r="13"></circle>
      <line class="part p5" x1="80" y1="61" x2="80" y2="95"></line>
      <path class="part p6" d="M80 72 L63 85 M80 72 L97 85 M80 95 L66 115 M80 95 L94 115"></path>
    `;
  }
  // 6 parts: pole, beam, rope, head, body, limbs (base is always shown).
  svg.querySelectorAll(".part").forEach((el, i) =>
    el.classList.toggle("show", i < wrongs));
}

function renderTimer() {
  const el = $("turn-timer");
  const r = meta?.round;
  if (meta?.state !== "playing" || !r?.turnEndsAt) {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.turnEndsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", secs <= 5);
}

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");
  const r = meta.round;

  if (meta.state === "roundEnd" && r) {
    ov.classList.remove("hidden");
    box.innerHTML = `
      <h2>The phrase was</h2>
      <div class="big-word">${esc(r.phrase.toUpperCase())}</div>
      <p class="hint">${esc(r.note || "")}</p>
      <p class="score-line">🔴 +${r.points?.red || 0} &nbsp;·&nbsp; 🔵 +${r.points?.blue || 0}</p>
      <p class="hint">Totals: Red ${meta.scores?.red || 0} — Blue ${meta.scores?.blue || 0}</p>`;
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

// ── Keyboard & solve UI ───────────────────────────────────────────────────────
const kb = $("keyboard");
for (const letter of "abcdefghijklmnopqrstuvwxyz") {
  const b = document.createElement("button");
  b.textContent = letter;
  b.dataset.l = letter;
  b.disabled = true;
  b.addEventListener("click", () => pickLetter(letter));
  kb.appendChild(b);
}

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (meta?.state !== "playing") return;
  const l = e.key.toLowerCase();
  if (l.length === 1 && l >= "a" && l <= "z") pickLetter(l);
});

function hideSolveForm() {
  $("solve-form").classList.add("hidden");
  $("btn-solve").classList.remove("hidden");
}
$("btn-solve").addEventListener("click", () => {
  $("btn-solve").classList.add("hidden");
  $("solve-form").classList.remove("hidden");
  $("solve-input").focus();
});
$("btn-solve-cancel").addEventListener("click", hideSolveForm);
$("solve-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("solve-input").value;
  $("solve-input").value = "";
  hideSolveForm();
  trySolve(text);
});
