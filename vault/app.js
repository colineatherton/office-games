// The Vault — co-op escape puzzle. The whole room races one clock through six
// sequential locks. All state lives under rooms/{CODE}; lock advances, time
// penalties and hint spends are whole-meta transactions so they apply exactly once.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove, push,
  onValue, onChildAdded, onDisconnect, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { VAULTS } from "./puzzles.js";

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
let lastAttemptAt = 0;
let renderedLock = null;
let confettiDone = false;
let historyDone = false;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const attemptsRef = () => ref(db, `rooms/${roomCode}/attempts`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

const norm = (s) => String(s).toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const currentLock = () => {
  if (!meta?.run) return null;
  return VAULTS[meta.run.vault]?.locks[meta.run.lockIndex] || null;
};

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
      game: "vault",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { vault: "A", minutes: 20 },
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
    if (snap.val().game !== "vault") {
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
  onDisconnect(child(meRef, "connected")).set(false);

  onValue(metaRef(), (s) => { meta = s.val(); if (meta) render(); });
  onValue(playersRef(), (s) => { players = s.val() || {}; render(); });
  onChildAdded(attemptsRef(), (s) => renderAttempt(s.val()));
  // Replayed history shouldn't strobe the penalty flash at a late joiner.
  setTimeout(() => { historyDone = true; }, 1500);
}

function leaveRoom() {
  if (roomCode) set(ref(db, `rooms/${roomCode}/players/${pid}/connected`), false);
  location.hash = "";
  location.reload();
}
$("btn-leave-lobby").addEventListener("click", leaveRoom);

// ── Transactions ──────────────────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

async function startGame() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < 2) { alert("Co-op needs at least 2 crew members."); return; }
  await remove(attemptsRef());
  $("attempt-log").innerHTML = "";
  await txMeta((m) => {
    if (m.state === "playing") return;
    const minutes = Number(m.settings.minutes) || 20;
    return {
      ...m,
      state: "playing",
      run: {
        vault: m.settings.vault || "A",
        minutes,
        lockIndex: 0,
        startedAt: nowSrv(),
        endsAt: nowSrv() + minutes * 60 * 1000,
        hintsUsed: null,
      },
    };
  });
  confettiDone = false;
}

// Correct answers advance the lock (and win on the 6th) in one transaction —
// two simultaneous correct submissions can never double-advance.
async function submitAttempt(text) {
  if (!meta || meta.state !== "playing") return;
  const now = Date.now();
  if (now - lastAttemptAt < 2000) {
    note("Easy, safecracker — one try every 2 seconds.");
    return;
  }
  lastAttemptAt = now;

  const i = meta.run.lockIndex;
  const lock = currentLock();
  if (!lock) return;
  const good = lock.answers.some((a) => norm(a) === norm(text));

  if (good) {
    const res = await txMeta((m) => {
      if (m.state !== "playing" || m.run.lockIndex !== i) return;
      const next = i + 1;
      if (next >= 6) {
        return {
          ...m, state: "won",
          run: { ...m.run, lockIndex: 6, finishedMsLeft: Math.max(0, m.run.endsAt - nowSrv()) },
        };
      }
      return { ...m, run: { ...m.run, lockIndex: next } };
    });
    if (res.committed && (res.snapshot.val()?.run?.lockIndex ?? 0) > i) {
      push(attemptsRef(), { name: me()?.name || "?", text: text.trim(), ok: true, lock: i, t: serverTimestamp() });
      if (res.snapshot.val().state === "won") recordBest(res.snapshot.val());
    } else {
      note("Someone already cracked that lock!");
    }
  } else {
    push(attemptsRef(), { name: me()?.name || "?", text: text.trim(), ok: false, lock: i, t: serverTimestamp() });
    txMeta((m) => {
      if (m.state !== "playing") return;
      return { ...m, run: { ...m.run, endsAt: Math.max(nowSrv(), m.run.endsAt - 15000) } };
    });
    note("✗ Not it. −15 seconds.");
  }
}

function useHint() {
  if (!meta || meta.state !== "playing") return;
  const i = meta.run.lockIndex;
  const used = Object.keys(meta.run.hintsUsed || {}).filter((k) => k.startsWith(`l${i}h`)).length;
  if (used >= 2) return;
  txMeta((m) => {
    if (m.state !== "playing" || m.run.lockIndex !== i) return;
    const cur = Object.keys(m.run.hintsUsed || {}).filter((k) => k.startsWith(`l${i}h`)).length;
    if (cur >= 2) return;
    return {
      ...m,
      run: {
        ...m.run,
        hintsUsed: { ...(m.run.hintsUsed || {}), [`l${i}h${cur}`]: { name: me()?.name || "?" } },
        endsAt: Math.max(nowSrv(), m.run.endsAt - 60000),
      },
    };
  }).then((res) => {
    if (res.committed && res.snapshot.val()?.run?.hintsUsed?.[`l${i}h${used}`]) {
      push(attemptsRef(), { name: me()?.name || "?", sys: true, text: "spent a hint (−60s)", lock: i, t: serverTimestamp() });
    }
  });
}

function endLost() {
  txMeta((m) => (m.state === "playing" ? { ...m, state: "lost" } : undefined));
}

function backToLobby() {
  txMeta((m) => (m.state === "won" || m.state === "lost"
    ? { ...m, state: "lobby", run: null }
    : undefined));
}

function recordBest(m) {
  const key = `${m.run.vault}_${m.run.minutes}`;
  const msLeft = m.run.finishedMsLeft || 0;
  runTransaction(ref(db, `rooms/${roomCode}/records/${key}`), (cur) => {
    if (cur && cur.msLeft >= msLeft) return; // existing record stands
    return { msLeft, at: Date.now() };
  }).then((res) => {
    if (!res.committed || res.snapshot.val()?.msLeft !== msLeft) return;
    const stamp = () => $("overlay-content")?.querySelector(".record-slot")?.replaceChildren(
      Object.assign(document.createElement("p"), { className: "record-note", textContent: "🏆 New room best!" }));
    stamp();
    setTimeout(stamp, 500); // the overlay may render just after the transaction resolves
  });
}

// ── Tick: timer + fallbacks ──────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (meta.state === "playing" && connCount < 2) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > 10000) {
      txMeta((m) => (m.state === "playing" ? { ...m, state: "lobby", run: null } : undefined));
    }
  } else {
    lowPlayersSince = null;
  }

  if (meta.state === "playing" && meta.run?.endsAt) {
    const n = nowSrv();
    if ((isHost() && n > meta.run.endsAt) || n > meta.run.endsAt + 3000) endLost();
  }
}, 300);

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
function render() {
  if (!meta) return;
  if (meta.state === "lobby") {
    showScreen("lobby");
    renderedLock = null;
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
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected) continue;
    const li = document.createElement("li");
    li.textContent = `${p.name}${meta.hostId === id ? " 👑" : ""}${id === pid ? " (you)" : ""}`;
    if (id === pid) li.classList.add("me");
    ul.appendChild(li);
  }
  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (isHost()) {
    $("set-vault").value = meta.settings.vault || "A";
    $("set-minutes").value = String(meta.settings.minutes || 20);
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderGame() {
  const run = meta.run;
  if (!run) return;
  const vault = VAULTS[run.vault];
  $("vault-name").textContent = `Vault ${run.vault} — ${vault.name}`;

  // Dials
  document.querySelectorAll(".dial").forEach((d, i) => {
    d.classList.toggle("open", i < run.lockIndex);
    d.classList.toggle("active", i === run.lockIndex && meta.state === "playing");
  });

  // Puzzle
  if (meta.state === "playing") {
    const lock = currentLock();
    const key = `${run.vault}:${run.lockIndex}`;
    if (renderedLock !== key && lock) {
      renderedLock = key;
      $("lock-label").textContent = `LOCK ${run.lockIndex + 1} OF 6 · ${lock.type.toUpperCase()}`;
      $("puzzle-title").textContent = lock.title;
      $("puzzle-body").textContent = lock.body;
      $("attempt-input").value = "";
      note(" ");
    }
    // Hints for the current lock
    const box = $("hints-revealed");
    box.innerHTML = "";
    const usedKeys = Object.keys(run.hintsUsed || {})
      .filter((k) => k.startsWith(`l${run.lockIndex}h`)).sort();
    usedKeys.forEach((k, n) => {
      const div = document.createElement("div");
      div.className = "hint-line";
      div.textContent = `💡 ${currentLock()?.hints[n] || ""}`;
      box.appendChild(div);
    });
    const left = 2 - usedKeys.length;
    $("hint-count").textContent = left ? `${left} left for this lock` : "no hints left for this lock";
    $("btn-hint").disabled = left === 0;
  }

  // Crew
  const crew = $("crew-list");
  crew.innerHTML = "";
  for (const [id, p] of sortedPlayers()) {
    const s = document.createElement("span");
    s.textContent = `${p.name}${meta.hostId === id ? " 👑" : ""}`;
    if (!p.connected) s.classList.add("off");
    crew.appendChild(s);
  }

  renderOverlay();
  renderTimer();
}

function renderTimer() {
  const el = $("timer");
  if (meta?.state !== "playing" || !meta.run?.endsAt) {
    if (meta?.state === "won" && meta.run) el.textContent = fmt(meta.run.finishedMsLeft || 0);
    else if (meta?.state === "lost") el.textContent = "0:00";
    el.classList.remove("low");
    return;
  }
  const ms = Math.max(0, meta.run.endsAt - nowSrv());
  el.textContent = fmt(ms);
  el.classList.toggle("low", ms < 120000);
}

const fmt = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function renderOverlay() {
  const ov = $("overlay");
  const box = $("overlay-content");
  if (meta.state === "won") {
    ov.classList.remove("hidden");
    box.innerHTML = `
      <h2>🔓 THE VAULT IS OPEN</h2>
      <p>All six locks cracked with</p>
      <div class="big-time">${fmt(meta.run.finishedMsLeft || 0)}</div>
      <p>left on the clock.</p>
      <div class="record-slot"></div>
      ${hostButtons()}`;
    wireOverlayButtons(box);
    if (!confettiDone) { confettiDone = true; confetti(); }
  } else if (meta.state === "lost") {
    ov.classList.remove("hidden");
    const run = meta.run;
    const locks = VAULTS[run.vault].locks;
    const remaining = locks.slice(run.lockIndex)
      .map((l, n) => `<div><b>Lock ${run.lockIndex + n + 1}:</b> ${esc(l.title)} — ${esc(l.answers[0].toUpperCase())}</div>`)
      .join("");
    box.innerHTML = `
      <h2 class="fail">🚨 THE VAULT SEALS SHUT</h2>
      <p>You cracked ${run.lockIndex} of 6 locks. The ones that beat you:</p>
      <div class="answers-list">${remaining}</div>
      ${hostButtons()}`;
    wireOverlayButtons(box);
  } else {
    ov.classList.add("hidden");
  }
}

function hostButtons() {
  return isHost()
    ? `<div class="btn-row" style="width:100%">
         <button id="btn-again" class="btn primary big">Back to lobby</button>
       </div>
       <button id="btn-leave-game" class="btn small ghost">Leave room</button>`
    : `<p class="hint">Waiting for the host…</p>
       <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
}

function wireOverlayButtons(box) {
  box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
  box.querySelector("#btn-leave-game")?.addEventListener("click", leaveRoom);
}

function confetti() {
  const bits = ["🎉", "✨", "💰", "🪙", "🎊"];
  for (let i = 0; i < 40; i++) {
    const s = document.createElement("span");
    s.className = "confetti";
    s.textContent = bits[i % bits.length];
    s.style.left = Math.random() * 100 + "vw";
    s.style.animationDuration = 2 + Math.random() * 2.5 + "s";
    s.style.animationDelay = Math.random() * 1.2 + "s";
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 6000);
  }
}

// ── Attempts log ──────────────────────────────────────────────────────────────
function renderAttempt(a) {
  if (!a) return;
  const log = $("attempt-log");
  const div = document.createElement("div");
  if (a.sys) {
    div.className = "attempt-row sys";
    div.innerHTML = `<span class="who">${esc(a.name)}</span> ${esc(a.text)}`;
  } else if (a.ok) {
    div.className = "attempt-row ok";
    div.innerHTML = `<span class="who">${esc(a.name)}</span> cracked lock ${(a.lock ?? 0) + 1}: <b>${esc(a.text)}</b> ✓`;
  } else {
    div.className = "attempt-row bad";
    div.innerHTML = `<span class="who">${esc(a.name)}</span> tried <span class="word">${esc(a.text)}</span> ✗`;
    if (historyDone) flashPenalty();
  }
  log.appendChild(div);
  while (log.children.length > 60) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

let flashTimer = null;
function flashPenalty() {
  const f = $("penalty-flash");
  f.classList.remove("hidden");
  f.style.animation = "none";
  void f.offsetWidth; // restart the animation
  f.style.animation = "";
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => f.classList.add("hidden"), 650);
}

function note(text) {
  $("attempt-note").textContent = text;
}

// ── Wiring ────────────────────────────────────────────────────────────────────
$("btn-start").addEventListener("click", startGame);
$("set-vault").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { vault: e.target.value }));
$("set-minutes").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { minutes: Number(e.target.value) }));
$("btn-hint").addEventListener("click", useHint);

$("attempt-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("attempt-input").value.trim();
  if (!text) return;
  $("attempt-input").value = "";
  submitAttempt(text);
});

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
