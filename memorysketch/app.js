// Memory Sketch — draw famous things from memory, then vote 🎯 accurate / 😂 funny.
// Individual scores. State machine: lobby → (drawing → judging → results) × N → gameEnd.
// The host's client drives transitions via whole-meta transactions; references for
// flags reuse the geometric specs from ../flagzoom/flags.js.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { PROMPTS, CAT_LABELS } from "./prompts.js";
import { FLAGS, drawFlag } from "../flagzoom/flags.js";

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
let artMap = {};          // current round's drawings {pid: {img}}
let myVotes = {};         // local mirror of my {acc, fun} this round
let serverOffset = 0;
let loadedRound = -1;
let unsubArt = null;
let lowPlayersSince = null;
// A genuine reconnect (phone waking, wifi roaming) can take a good few
// seconds; 10s of grace used to dump a whole room back to the lobby.
const ABANDON_MS = 45000;

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const artRef = (n) => ref(db, `rooms/${roomCode}/art/${n}`);
const votesRef = (n) => ref(db, `rooms/${roomCode}/votes/${n}`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

const participating = () =>
  !!me() && meta?.round?.createdAt && (me().joinedAt || 0) <= meta.round.createdAt;
const doneDraw = () => (me()?.doneDraw || 0) >= (meta?.round?.num || 1);
const doneVote = () => (me()?.doneVote || 0) >= (meta?.round?.num || 1);

// ── Screens / views ───────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["draw", "wait", "gallery", "spectate"]) {
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
      game: "memorysketch",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: { rounds: 5, drawSeconds: 60 },
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
    if (snap.val().game !== "memorysketch") {
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
    score: existing?.score || 0,
    accVotes: existing?.accVotes || 0,
    funVotes: existing?.funVotes || 0,
    doneDraw: existing?.doneDraw || 0,
    doneVote: existing?.doneVote || 0,
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

// ── State-machine transactions (host-driven) ──────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function samplePrompt(used = {}) {
  const fresh = PROMPTS.map((p, i) => i).filter((i) => !used["p" + i]);
  const pool = fresh.length ? fresh : PROMPTS.map((_, i) => i);
  const i = pool[Math.floor(Math.random() * pool.length)];
  return { i, prompt: PROMPTS[i] };
}

async function startGame() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < 3) { alert("Need at least 3 players — the voting needs a crowd."); return; }

  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/score`] = 0;
    resets[`${id}/accVotes`] = 0;
    resets[`${id}/funVotes`] = 0;
    resets[`${id}/doneDraw`] = 0;
    resets[`${id}/doneVote`] = 0;
  }
  await update(playersRef(), resets);
  await remove(ref(db, `rooms/${roomCode}/art`));
  await remove(ref(db, `rooms/${roomCode}/votes`));

  await txMeta((m) => {
    if (m.state !== "lobby") return;
    const { i, prompt } = samplePrompt({});
    return {
      ...m,
      state: "drawing",
      usedPrompts: { ["p" + i]: true },
      round: {
        num: 1, prompt, createdAt: nowSrv(),
        endsAt: nowSrv() + m.settings.drawSeconds * 1000,
      },
    };
  });
}

// drawing → judging (or straight to results when the gallery is too empty)
let advancing = false;
async function advanceFromDrawing() {
  if (advancing) return;
  advancing = true;
  try {
    const n = meta.round.num;
    const snap = await get(artRef(n));
    const submitted = Object.keys(snap.val() || {});
    const order = [...submitted];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    await txMeta((m) => {
      if (m.state !== "drawing" || m.round?.num !== n) return;
      if (submitted.length < 2) {
        return { ...m, state: "results", round: { ...m.round, order, tally: {}, endsAt: nowSrv() + 6000 } };
      }
      return { ...m, state: "judging", round: { ...m.round, order, endsAt: nowSrv() + 45000 } };
    });
  } finally { advancing = false; }
}

async function advanceFromJudging() {
  if (advancing) return;
  advancing = true;
  try {
    const n = meta.round.num;
    const vsnap = await get(votesRef(n));
    const votes = vsnap.val() || {};
    const tally = {};
    for (const v of Object.values(votes)) {
      if (v.acc) { tally[v.acc] = tally[v.acc] || { acc: 0, fun: 0 }; tally[v.acc].acc++; }
      if (v.fun) { tally[v.fun] = tally[v.fun] || { acc: 0, fun: 0 }; tally[v.fun].fun++; }
    }
    const res = await txMeta((m) => {
      if (m.state !== "judging" || m.round?.num !== n) return;
      return { ...m, state: "results", round: { ...m.round, tally, endsAt: nowSrv() + 10000 } };
    });
    if (res.committed && res.snapshot.val()?.state === "results") {
      for (const [artist, t] of Object.entries(tally)) {
        runTransaction(child(playersRef(), `${artist}/score`), (v) => (v || 0) + t.acc * 10 + t.fun * 5);
        if (t.acc) runTransaction(child(playersRef(), `${artist}/accVotes`), (v) => (v || 0) + t.acc);
        if (t.fun) runTransaction(child(playersRef(), `${artist}/funVotes`), (v) => (v || 0) + t.fun);
      }
    }
  } finally { advancing = false; }
}

function nextRound() {
  const expect = meta.round?.num;
  txMeta((m) => {
    if (m.state !== "results" || m.round?.num !== expect) return;
    if (m.round.num >= m.settings.rounds) return { ...m, state: "gameEnd" };
    const { i, prompt } = samplePrompt(m.usedPrompts || {});
    return {
      ...m,
      state: "drawing",
      usedPrompts: { ...(m.usedPrompts || {}), ["p" + i]: true },
      round: {
        num: m.round.num + 1, prompt, createdAt: nowSrv(),
        endsAt: nowSrv() + m.settings.drawSeconds * 1000,
      },
    };
  });
}

function backToLobby() {
  txMeta((m) => {
    if (m.state !== "gameEnd") return;
    return { ...m, state: "lobby", round: null, usedPrompts: null };
  }).then((res) => {
    if (res.committed) {
      remove(ref(db, `rooms/${roomCode}/art`));
      remove(ref(db, `rooms/${roomCode}/votes`));
    }
  });
}

// ── Submitting ────────────────────────────────────────────────────────────────
function submitDrawing() {
  if (!meta || meta.state !== "drawing" || !participating() || doneDraw()) return;
  const n = meta.round.num;
  const out = document.createElement("canvas");
  out.width = 700; out.height = 490;
  const octx = out.getContext("2d");
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(board, 0, 0, out.width, out.height);
  set(child(artRef(n), pid), { img: out.toDataURL("image/png") });
  update(child(playersRef(), pid), { doneDraw: n });
}
$("btn-submit-draw").addEventListener("click", submitDrawing);

function castVote(kind, targetPid) {
  if (!meta || meta.state !== "judging" || targetPid === pid) return;
  const n = meta.round.num;
  myVotes[kind] = targetPid;
  set(child(votesRef(n), `${pid}/${kind}`), targetPid);
  const eligible = (meta.round.order || []).filter((id) => id !== pid);
  if ((myVotes.acc && myVotes.fun) || eligible.length < 2) {
    update(child(playersRef(), pid), { doneVote: n });
  }
  renderGallery();
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const inGame = ["drawing", "judging", "results"].includes(meta.state);
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (inGame && connCount < 3) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => (["drawing", "judging", "results"].includes(m.state)
        ? { ...m, state: "lobby", round: null, usedPrompts: null } : undefined));
    }
  } else {
    lowPlayersSince = null;
  }

  const r = meta.round;
  if (!r?.endsAt) return;
  const n = nowSrv();

  // Auto-submit / auto-finish on timeout.
  if (meta.state === "drawing" && participating() && !doneDraw() && n > r.endsAt) {
    submitDrawing();
  }
  if (meta.state === "judging" && participating() && !doneVote() && n > r.endsAt) {
    update(child(playersRef(), pid), { doneVote: r.num });
  }

  if (!isHost()) return;
  const parts = Object.entries(players)
    .filter(([, p]) => p.connected && (p.joinedAt || 0) <= (r.createdAt || 0));
  if (meta.state === "drawing") {
    const allDone = parts.length && parts.every(([, p]) => (p.doneDraw || 0) >= r.num);
    if (allDone || n > r.endsAt + 3000) advanceFromDrawing();
  } else if (meta.state === "judging") {
    const allDone = parts.length && parts.every(([, p]) => (p.doneVote || 0) >= r.num);
    if (allDone || n > r.endsAt + 3000) advanceFromJudging();
  } else if (meta.state === "results") {
    if (n > r.endsAt) nextRound();
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
  showScreen("game");
  renderGame();
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
    $("set-rounds").value = String(meta.settings.rounds);
    $("set-seconds").value = String(meta.settings.drawSeconds);
  }
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function renderGame() {
  const r = meta.round;
  const overlay = $("overlay");

  if (meta.state === "gameEnd") {
    renderGameEnd();
    overlay.classList.remove("hidden");
    return;
  }
  overlay.classList.add("hidden");
  if (!r) return;

  $("round-info").textContent = `Round ${r.num}/${meta.settings.rounds}`;
  $("prompt-display").innerHTML =
    `<span class="cat">${CAT_LABELS[r.prompt.cat] || ""}</span>${esc(r.prompt.text)}`;

  if (r.num !== loadedRound) {
    loadedRound = r.num;
    myVotes = {};
    clearStrokes();
    if (unsubArt) unsubArt();
    artMap = {};
    unsubArt = onValue(artRef(r.num), (s) => { artMap = s.val() || {}; renderGallery(); });
  }

  if (meta.state === "drawing") {
    if (!participating()) { showView("spectate"); return; }
    if (doneDraw()) { renderWait(); showView("wait"); return; }
    showView("draw");
  } else {
    // judging & results share the gallery view
    renderGallery();
    showView("gallery");
  }
  renderTimer();
}

function renderWait() {
  const ul = $("wait-list");
  ul.innerHTML = "";
  const r = meta.round;
  for (const [id, p] of sortedPlayers()) {
    if (!p.connected || (p.joinedAt || 0) > (r.createdAt || 0)) continue;
    const done = (p.doneDraw || 0) >= r.num;
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : "✏️"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  if (!r?.endsAt || !["drawing", "judging"].includes(meta.state)) {
    el.textContent = "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", secs <= 10);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── Gallery (judging + results) ───────────────────────────────────────────────
function renderGallery() {
  if (!meta || !["judging", "results"].includes(meta.state)) return;
  const r = meta.round;
  const judging = meta.state === "judging";

  $("gallery-title").textContent = judging ? "🖼️ The gallery — cast your votes" : "🏅 The verdict";
  $("gallery-hint").classList.toggle("hidden", !judging);
  renderReference(r.prompt.ref);

  const grid = $("gallery-grid");
  grid.innerHTML = "";
  const order = r.order || [];
  if (!order.length) {
    grid.innerHTML = `<p class="hint">Gallery closed early — not enough drawings this round. 😢</p>`;
    return;
  }
  const tally = r.tally || {};
  const maxAcc = Math.max(0, ...Object.values(tally).map((t) => t.acc || 0));

  for (const artist of order) {
    const art = artMap[artist];
    const card = document.createElement("div");
    card.className = "art-card";
    const img = document.createElement("img");
    img.alt = "a drawing from memory";
    if (art?.img) img.src = art.img;
    card.appendChild(img);

    const label = document.createElement("div");
    label.className = "artist";
    if (judging) {
      label.innerHTML = artist === pid ? `<span class="you">(yours)</span>` : "&nbsp;";
    } else {
      label.textContent = players[artist]?.name || "?";
      const t = tally[artist];
      if (t?.acc && t.acc === maxAcc) card.classList.add("winner");
    }
    card.appendChild(label);

    if (judging) {
      const row = document.createElement("div");
      row.className = "vote-row";
      const accBtn = document.createElement("button");
      accBtn.className = "btn" + (myVotes.acc === artist ? " sel-acc" : "");
      accBtn.textContent = "🎯 Accurate";
      const funBtn = document.createElement("button");
      funBtn.className = "btn" + (myVotes.fun === artist ? " sel-fun" : "");
      funBtn.textContent = "😂 Funniest";
      if (artist === pid) {
        accBtn.disabled = funBtn.disabled = true;
        accBtn.style.opacity = funBtn.style.opacity = ".35";
      } else {
        accBtn.addEventListener("click", () => castVote("acc", artist));
        funBtn.addEventListener("click", () => castVote("fun", artist));
      }
      row.append(accBtn, funBtn);
      card.appendChild(row);
    } else {
      const t = tally[artist] || { acc: 0, fun: 0 };
      const line = document.createElement("div");
      line.className = "tally";
      const pts = t.acc * 10 + t.fun * 5;
      line.innerHTML = `<span>🎯 ${t.acc}</span><span>😂 ${t.fun}</span><span class="pts">+${pts}</span>`;
      card.appendChild(line);
    }
    grid.appendChild(card);
  }
}

// ── Reference rendering ("the real thing") ────────────────────────────────────
function renderReference(refSpec) {
  const box = $("reference-box");
  if (!refSpec) { box.classList.add("hidden"); return; }
  const canvas = $("reference-canvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  if (refSpec.type === "flag") {
    const flag = FLAGS.find((f) => f.name === refSpec.name);
    if (!flag) { box.classList.add("hidden"); return; }
    drawFlag(ctx, flag.spec, W, H);
  } else if (refSpec.type === "glyph") {
    ctx.fillStyle = "#111";
    ctx.font = "110px Georgia, serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(refSpec.char, W / 2, H / 2 + 6);
  } else if (refSpec.type === "sym") {
    drawSymbolRef(ctx, refSpec.id, W, H);
  } else {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
}

function drawSymbolRef(ctx, id, W, H) {
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.42;
  ctx.lineCap = "round";
  switch (id) {
    case "yinyang": {
      ctx.fillStyle = "#111";
      ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, Math.PI / 2); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI / 2, -Math.PI / 2); ctx.fill();
      ctx.fillStyle = "#111";
      ctx.beginPath(); ctx.arc(cx, cy - R / 2, R / 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(cx, cy + R / 2, R / 2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy - R / 2, R / 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#111";
      ctx.beginPath(); ctx.arc(cx, cy + R / 2, R / 7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#111"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case "power": {
      ctx.strokeStyle = "#111"; ctx.lineWidth = R / 5;
      ctx.beginPath(); ctx.arc(cx, cy + R * 0.05, R * 0.8, -Math.PI * 0.35, Math.PI * 1.35); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy - R * 0.1); ctx.stroke();
      break;
    }
    case "peace": {
      ctx.strokeStyle = "#111"; ctx.lineWidth = R / 6;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
      const d = R * 0.71;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx - d, cy + d); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + d, cy + d); ctx.stroke();
      break;
    }
    case "wifi": {
      ctx.strokeStyle = "#111"; ctx.lineWidth = R / 5.5;
      for (const f of [1, 0.66, 0.33]) {
        ctx.beginPath();
        ctx.arc(cx, cy + R * 0.75, R * 1.15 * f, -Math.PI * 0.78, -Math.PI * 0.22);
        ctx.stroke();
      }
      ctx.fillStyle = "#111";
      ctx.beginPath(); ctx.arc(cx, cy + R * 0.72, R / 6, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "noentry": {
      ctx.fillStyle = "#d21f26";
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillRect(cx - R * 0.72, cy - R * 0.18, R * 1.44, R * 0.36);
      break;
    }
    case "smiley": {
      ctx.fillStyle = "#ffd43b";
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#111"; ctx.lineWidth = R / 10;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#111";
      ctx.beginPath(); ctx.arc(cx - R * 0.35, cy - R * 0.25, R / 8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + R * 0.35, cy - R * 0.25, R / 8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy + R * 0.1, R * 0.55, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();
      break;
    }
  }
}

// ── Game end ──────────────────────────────────────────────────────────────────
function renderGameEnd() {
  const box = $("overlay-content");
  const ranked = sortedPlayers()
    .filter(([, p]) => (p.score || 0) > 0 || p.connected)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  const medals = ["🥇", "🥈", "🥉"];
  const rows = ranked.map(([id, p], i) =>
    `<li><span>${medals[i] || "·"} ${esc(p.name)}${id === pid ? " (you)" : ""}</span><strong>${p.score || 0}</strong></li>`).join("");

  const topAcc = [...ranked].sort((a, b) => (b[1].accVotes || 0) - (a[1].accVotes || 0))[0];
  const topFun = [...ranked].sort((a, b) => (b[1].funVotes || 0) - (a[1].funVotes || 0))[0];
  let crowns = "";
  if (topAcc && (topAcc[1].accVotes || 0) > 0) crowns += `<p class="crown-line">🏆 Most accurate artist: <strong>${esc(topAcc[1].name)}</strong></p>`;
  if (topFun && (topFun[1].funVotes || 0) > 0) crowns += `<p class="crown-line">🤡 People's clown: <strong>${esc(topFun[1].name)}</strong></p>`;

  box.innerHTML = `
    <h2>🎬 Gallery closed!</h2>
    <ul class="leaderboard">${rows}</ul>
    ${crowns}
    ${isHost() ? `<button id="btn-again" class="btn primary big">Back to lobby</button>`
               : `<p class="hint">Waiting for the host…</p>`}
    <button id="btn-leave-game" class="btn small ghost">Leave room</button>`;
  box.querySelector("#btn-again")?.addEventListener("click", backToLobby);
  box.querySelector("#btn-leave-game").addEventListener("click", leaveRoom);
}

// ── Lobby interactions ────────────────────────────────────────────────────────
$("btn-start").addEventListener("click", startGame);
$("set-rounds").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { rounds: Number(e.target.value) }));
$("set-seconds").addEventListener("change", (e) =>
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

// ── Local canvas (same approach as telephone/) ────────────────────────────────
const board = $("board");
const bctx = board.getContext("2d");
const CW = board.width, CH = board.height;
bctx.lineCap = "round";
bctx.lineJoin = "round";

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
    Math.round((e.clientX - rect.left) / rect.width * CW),
    Math.round((e.clientY - rect.top) / rect.height * CH),
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
  bctx.strokeStyle = stroke.c;
  bctx.lineWidth = stroke.w;
  bctx.beginPath();
  bctx.moveTo(stroke.p[n - 2], stroke.p[n - 1]);
  bctx.lineTo(x, y);
  bctx.stroke();
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
  bctx.fillStyle = "#ffffff";
  bctx.fillRect(0, 0, CW, CH);
  for (const s of strokes) {
    if (s.p.length < 4) continue;
    bctx.strokeStyle = s.c;
    bctx.lineWidth = s.w;
    bctx.beginPath();
    bctx.moveTo(s.p[0], s.p[1]);
    for (let i = 2; i < s.p.length; i += 2) bctx.lineTo(s.p[i], s.p[i + 1]);
    bctx.stroke();
  }
}
redrawAll();
