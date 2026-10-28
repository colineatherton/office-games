// 🗳️ Game Vote — the room decides what to play next.
//
// Approval voting, not "pick your favourite": everyone ticks every game they'd
// happily play, and the most-ticked game wins. That matters for a social hour —
// first-past-the-post hands the night to whatever three loud people nominated,
// while approval voting surfaces the game nobody dreads. Ties are a feature, so
// they get a ceremony (coin flip or runoff) rather than a silent tie-break.
//
// Synced through Firebase RTDB on the house conventions: whole-meta
// transactions, host-driven advancement, presence tracking, watchdogs.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, child, get, set, update, remove,
  onValue, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../firebase-config.js";
import { trackPresence } from "../presence.js";
import { GAMES, SECTIONS, GAME_BY_SLUG, gamesByFormat } from "../games.js";
import {
  MIN_BALLOT, MAX_BALLOT, ballotFromNominations, tallyBallot, voteBudget,
} from "./tally.js";

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

const MIN_PLAYERS = 2;
const NOMS_EACH = 2;
const NOM_EXTRA_SECONDS = 25;  // browsing 42 games takes longer than ticking 6
const ABANDON_MS = 45000;
const HOST_GRACE_MS = 12000;

const FORMAT_LABEL = {
  all: "any format", teams: "🔴🔵 Teams", solo: "🙋 Solo scores", coop: "🤝 Co-op",
};
// Catalogue order is the deterministic tie-break for *ordering* (never for
// deciding a winner — a tied vote is settled by the room, see flipCoin/runoff).
const ORDER = Object.fromEntries(GAMES.map((g, i) => [g.slug, i]));

let roomCode = null;
let meta = null;
let players = {};
let serverOffset = 0;
let advancing = false;
let lowPlayersSince = null;
let hostGoneSince = null;
let myLastVote = { num: -1, slugs: [] };

const nowSrv = () => Date.now() + serverOffset;
const metaRef = () => ref(db, `rooms/${roomCode}/meta`);
const playersRef = () => ref(db, `rooms/${roomCode}/players`);
const votesRoot = () => ref(db, `rooms/${roomCode}/votes`);
const nomsRoot = () => ref(db, `rooms/${roomCode}/noms`);
const me = () => players[pid];
const isHost = () => meta?.hostId === pid;
const myNominated = () => (me()?.nominatedRound || 0) >= (meta?.round?.num || 1);
const myVoted = () => (me()?.votedRound || 0) >= (meta?.round?.num || 1);

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// ── Screens & views ───────────────────────────────────────────────────────────
function showScreen(name) {
  for (const s of ["setup", "join", "lobby", "game"]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== name);
  }
}
function showView(name) {
  for (const v of ["nominate", "vote", "wait", "reveal"]) {
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
      game: "vote",
      createdAt: serverTimestamp(),
      hostId: pid,
      state: "lobby",
      settings: {
        source: "nominate", count: 6, filter: "all",
        votesEach: 2, timer: 45, skipPlayed: true,
      },
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
    if (snap.val().game !== "vote") {
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
    votedRound: existing?.votedRound || 0,
    nominatedRound: existing?.nominatedRound || 0,
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
$("btn-leave-reveal").addEventListener("click", leaveRoom);

// ── Catalogue picker ──────────────────────────────────────────────────────────
// One component, two jobs: the host building a ballot by hand, and every player
// nominating. Selection is FIFO-capped, so clicking a third game when you may
// only pick two drops your first choice instead of doing nothing.
function createPicker(container, onChange) {
  let maxSel = 2, filter = "all", query = "";
  let exclude = new Set();
  let selected = [];

  container.innerHTML = `
    <div class="pick-bar">
      <input class="pick-search" type="search" placeholder="🔎 Search games…" autocomplete="off">
      <div class="pick-chips"></div>
    </div>
    <div class="pick-list"></div>`;
  const searchEl = container.querySelector(".pick-search");
  const chipsEl = container.querySelector(".pick-chips");
  const listEl = container.querySelector(".pick-list");

  for (const f of ["all", "teams", "solo", "coop"]) {
    const b = document.createElement("button");
    b.className = "chip" + (f === "all" ? " active" : "");
    b.dataset.f = f;
    b.textContent = f === "all" ? "All" : FORMAT_LABEL[f];
    b.addEventListener("click", () => { setFilter(f, false); });
    chipsEl.appendChild(b);
  }

  searchEl.addEventListener("input", () => { query = searchEl.value.trim().toLowerCase(); renderList(); });

  listEl.addEventListener("click", (e) => {
    const row = e.target.closest(".pick-row");
    if (!row) return;
    toggle(row.dataset.slug);
  });

  const hay = (g) => `${g.title} ${g.blurb} ${g.pick} ${g.players} ${g.time} ${g.format} ${SECTIONS[g.section]}`.toLowerCase();

  function pool() {
    return GAMES.filter((g) =>
      !exclude.has(g.slug) &&
      (filter === "all" || g.format === filter) &&
      (!query || hay(g).includes(query)));
  }

  function prune() {
    const ok = new Set(GAMES.filter((g) =>
      !exclude.has(g.slug) && (filter === "all" || g.format === filter)).map((g) => g.slug));
    selected = selected.filter((s) => ok.has(s));
  }

  function toggle(slug) {
    const i = selected.indexOf(slug);
    if (i >= 0) selected.splice(i, 1);
    else {
      selected.push(slug);
      while (selected.length > maxSel) selected.shift();
    }
    renderList();
    onChange?.();
  }

  function renderList() {
    listEl.innerHTML = "";
    const games = pool();
    if (!games.length) {
      listEl.innerHTML = `<p class="pick-empty">Nothing matches that.</p>`;
      return;
    }
    let section = null;
    for (const g of games) {
      if (g.section !== section) {
        section = g.section;
        const h = document.createElement("div");
        h.className = "pick-section";
        h.textContent = SECTIONS[section];
        listEl.appendChild(h);
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = "pick-row" + (selected.includes(g.slug) ? " on" : "");
      row.dataset.slug = g.slug;
      row.setAttribute("aria-pressed", selected.includes(g.slug) ? "true" : "false");
      row.innerHTML = `
        <span class="pick-emoji">${g.emoji}</span>
        <span>
          <span class="pick-name">${esc(g.title)}</span>
          <span class="pick-blurb">${esc(g.blurb)}</span>
        </span>
        <span class="pick-badges">👥 ${esc(g.players)} · ⏱ ${esc(g.time)}</span>
        <span class="pick-tick">✓</span>`;
      listEl.appendChild(row);
    }
  }

  function setFilter(f, locked) {
    const same = f === filter && locked === chipsEl.classList.contains("hidden");
    if (same) return;
    filter = f;
    chipsEl.classList.toggle("hidden", !!locked);
    for (const b of chipsEl.children) b.classList.toggle("active", b.dataset.f === f);
    prune();
    renderList();
    onChange?.();
  }

  renderList();

  // The setters are called from render(), which runs on every room update, so
  // they no-op when nothing changed — otherwise every player joining would
  // scroll the list back to the top under whoever is mid-pick.
  return {
    selected: () => [...selected],
    count: () => selected.length,
    max: () => maxSel,
    setMax(n) {
      if (n === maxSel) return;
      maxSel = n;
      while (selected.length > maxSel) selected.shift();
      renderList();
      onChange?.();
    },
    setExclude(set) {
      const key = [...set].sort().join(",");
      if (key === [...exclude].sort().join(",")) return;
      exclude = set;
      prune();
      renderList();
      onChange?.();
    },
    setFilter,
    clear() { selected = []; query = ""; searchEl.value = ""; renderList(); onChange?.(); },
  };
}

let handpick = null;
let nominator = null;

function excludedSlugs() {
  if (meta?.settings?.skipPlayed === false) return new Set();
  return new Set(Object.keys(meta?.played || {}));
}

// ── Ballot pools ──────────────────────────────────────────────────────────────
function candidatePool() {
  const s = meta?.settings || {};
  const all = gamesByFormat(s.filter || "all");
  const fresh = all.filter((g) => !excludedSlugs().has(g.slug));
  // Played the whole shelf? Recycle rather than leaving the room with no ballot.
  return fresh.length >= MIN_BALLOT ? fresh : all;
}

function randomPick(pool, n) {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// ── State machine ─────────────────────────────────────────────────────────────
function txMeta(fn) {
  return runTransaction(metaRef(), (cur) => (cur ? fn(cur) : cur));
}

function votingRound(num, ballot, settings, kind = "vote") {
  // A runoff is always a single pick; otherwise it's the host's budget, capped
  // by voteBudget so nobody can tick the entire ballot.
  const budget = kind === "runoff" ? 1 : (settings.votesEach || 2);
  return {
    num, kind, ballot,
    votesEach: voteBudget(budget, ballot.length),
    endsAt: settings.timer ? nowSrv() + settings.timer * 1000 : null,
  };
}

async function resetSubmissions() {
  const resets = {};
  for (const id of Object.keys(players)) {
    resets[`${id}/votedRound`] = 0;
    resets[`${id}/nominatedRound`] = 0;
  }
  if (Object.keys(resets).length) await update(playersRef(), resets);
  await remove(votesRoot());
  await remove(nomsRoot());
}

async function startVote() {
  const connected = Object.values(players).filter((p) => p.connected);
  if (connected.length < MIN_PLAYERS) {
    alert(`Need at least ${MIN_PLAYERS} people in the room — otherwise it's not a vote, it's a decision.`);
    return;
  }
  const s = meta.settings || {};
  let ballot = null;
  if (s.source === "shuffle") {
    const pool = candidatePool();
    if (pool.length < MIN_BALLOT) { alert("Not enough games match that filter."); return; }
    ballot = randomPick(pool, Math.min(s.count || 6, pool.length)).map((g) => g.slug);
  } else if (s.source === "handpick") {
    ballot = handpick?.selected() || [];
    if (ballot.length < MIN_BALLOT) { alert(`Tick at least ${MIN_BALLOT} games for the ballot.`); return; }
  }

  // Reset BEFORE flipping state so a stale votedRound can't skip someone's turn.
  await resetSubmissions();
  const num = (meta.round?.num || 0) + 1;
  await txMeta((m) => {
    if (m.state !== "lobby") return;
    if (ballot) {
      return { ...m, state: "voting", result: null, round: votingRound(num, ballot, m.settings) };
    }
    return {
      ...m, state: "nominating", result: null,
      round: {
        num, kind: "vote", nomsEach: NOMS_EACH, ballot: null,
        endsAt: m.settings.timer ? nowSrv() + (m.settings.timer + NOM_EXTRA_SECONDS) * 1000 : null,
      },
    };
  });
}

async function closeNominations() {
  if (advancing || !meta || meta.state !== "nominating") return;
  advancing = true;
  try {
    const num = meta.round.num;
    const snap = await get(child(nomsRoot(), String(num)));
    let ballot = ballotFromNominations(snap.val(), {
      order: ORDER, isGame: (slug) => !!GAME_BY_SLUG[slug], max: MAX_BALLOT,
    });

    // Nobody nominated (or everyone nominated the same one game): top the
    // ballot up at random so the room still gets something to vote on.
    if (ballot.length < MIN_BALLOT) {
      const fill = candidatePool().filter((g) => !ballot.includes(g.slug));
      ballot = ballot.concat(randomPick(fill, MIN_BALLOT + 1 - ballot.length).map((g) => g.slug));
    }

    await txMeta((m) => {
      if (m.state !== "nominating" || m.round?.num !== num) return;
      return { ...m, state: "voting", round: votingRound(num, ballot, m.settings) };
    });
  } finally {
    advancing = false;
  }
}

async function closeVote() {
  if (advancing || !meta || meta.state !== "voting") return;
  advancing = true;
  try {
    const num = meta.round.num;
    const ballot = meta.round.ballot || [];
    const snap = await get(child(votesRoot(), String(num)));
    const result = {
      num,
      playerCount: Object.values(players).filter((p) => p.connected).length,
      ...tallyBallot(ballot, snap.val(), (id) => players[id]?.name || "someone", { order: ORDER }),
    };

    await txMeta((m) => {
      if (m.state !== "voting" || m.round?.num !== num) return;
      return { ...m, state: "reveal", result };
    });
  } finally {
    advancing = false;
  }
}

// What the host's tie-breakers choose between: the tied leaders, or the whole
// ballot if literally nobody voted.
const tieCandidates = () => {
  const tied = meta?.result?.tied || [];
  return tied.length ? tied : (meta?.round?.ballot || []);
};

function flipCoin() {
  const pool = tieCandidates();
  if (!pool.length) return;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  txMeta((m) => {
    if (m.state !== "reveal" || m.result?.winner) return;
    return { ...m, result: { ...m.result, winner: pick, decidedBy: "coin" } };
  });
}

function runoff() {
  const pool = tieCandidates();
  if (pool.length < MIN_BALLOT) return;
  const expect = meta.round.num;
  txMeta((m) => {
    if (m.state !== "reveal" || m.round?.num !== expect || m.result?.winner) return;
    return {
      ...m, state: "voting", result: null,
      round: votingRound(expect + 1, pool, m.settings, "runoff"),
    };
  });
}

function backToLobby() {
  const winner = meta?.result?.winner || null;
  txMeta((m) => {
    if (m.state !== "reveal") return;
    const played = { ...(m.played || {}) };
    if (winner) played[winner] = true;
    return { ...m, state: "lobby", result: null, played };
  }).then((res) => {
    if (!res.committed) return;
    remove(votesRoot());
    remove(nomsRoot());
  });
}

// ── Submitting ────────────────────────────────────────────────────────────────
function submitNominations(auto = false) {
  if (!meta || meta.state !== "nominating" || !me() || myNominated()) return;
  const picks = nominator?.selected() || [];
  if (!picks.length && !auto) return;
  set(child(nomsRoot(), `${meta.round.num}/${pid}`), Object.fromEntries(picks.map((s) => [s, true])));
  update(child(playersRef(), pid), { nominatedRound: meta.round.num });
}

let ballotSel = [];

function submitVote(auto = false) {
  if (!meta || meta.state !== "voting" || !me() || myVoted()) return;
  const picks = ballotSel.filter((s) => (meta.round.ballot || []).includes(s));
  if (!picks.length && !auto) return;
  myLastVote = { num: meta.round.num, slugs: picks };
  set(child(votesRoot(), `${meta.round.num}/${pid}`), Object.fromEntries(picks.map((s) => [s, true])));
  update(child(playersRef(), pid), { votedRound: meta.round.num });
}

// ── Periodic tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!meta || !roomCode) return;
  renderTimer();
  claimHostIfAbandoned();

  const active = meta.state === "nominating" || meta.state === "voting";
  const connCount = Object.values(players).filter((p) => p.connected).length;
  if (active && connCount < MIN_PLAYERS) {
    lowPlayersSince ??= Date.now();
    if (isHost() && Date.now() - lowPlayersSince > ABANDON_MS) {
      txMeta((m) => (m.state === "nominating" || m.state === "voting")
        ? { ...m, state: "lobby", result: null }
        : undefined);
    }
  } else {
    lowPlayersSince = null;
  }
  if (!active || !connCount) return;

  const r = meta.round;
  const n = nowSrv();
  const field = meta.state === "nominating" ? "nominatedRound" : "votedRound";
  const mine = meta.state === "nominating" ? myNominated() : myVoted();

  if (!mine && me()?.connected !== false && r.endsAt && n > r.endsAt) {
    if (meta.state === "nominating") submitNominations(true); else submitVote(true);
  }
  if (!isHost()) return;
  const allDone = Object.entries(players).every(([, p]) => !p.connected || (p[field] || 0) >= r.num);
  if (allDone || (r.endsAt && n > r.endsAt + 3000)) {
    if (meta.state === "nominating") closeNominations(); else closeVote();
  }
}, 400);

// How long the host may be unreachable before somebody else takes over. The
// whole state machine is host-gated, so during this window nothing advances and
// nothing aborts — which is exactly what we want while a host's wifi reconnects.
function claimHostIfAbandoned() {
  if (!meta || !Object.keys(players).length) return;
  if (players[meta.hostId]?.connected) { hostGoneSince = null; return; }
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
// `built` stops a re-render (someone joins, someone votes) from wiping the
// selections and search text of whoever is mid-pick.
let built = { phase: null, num: -1 };

function render() {
  if (!meta) return;
  if (meta.state === "lobby") {
    built = { phase: null, num: -1 };
    ballotSel = [];
    showScreen("lobby");
    renderLobby();
    return;
  }
  showScreen("game");
  renderTop();
  if (meta.state === "nominating") {
    if (myNominated()) renderWait("nominate"); else renderNominate();
  } else if (meta.state === "voting") {
    if (myVoted()) renderWait("vote"); else renderBallot();
  } else if (meta.state === "reveal") {
    renderReveal();
    showView("reveal");
  }
  renderTimer();
}

const sortedPlayers = () =>
  Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

function settingsSummary() {
  const s = meta.settings || {};
  const src = s.source === "shuffle" ? `a random shortlist of ${s.count || 6}`
    : s.source === "handpick" ? "a ballot picked by the host"
    : `everyone's nominations (${NOMS_EACH} each)`;
  const votes = s.votesEach === 1 ? "1 vote" : `${s.votesEach || 2} votes`;
  const timer = s.timer ? `${s.timer}s to vote` : "no timer";
  const only = (s.filter || "all") !== "all" ? ` · ${FORMAT_LABEL[s.filter]} only` : "";
  return `Ballot: ${src} · ${votes} each · ${timer}${only}`;
}

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
  $("lobby-summary").textContent = settingsSummary();

  const played = Object.keys(meta.played || {}).filter((s) => GAME_BY_SLUG[s]);
  $("played-box").classList.toggle("hidden", !played.length);
  const pl = $("played-list");
  pl.innerHTML = "";
  for (const slug of played) {
    const g = GAME_BY_SLUG[slug];
    const span = document.createElement("span");
    span.textContent = `${g.emoji} ${g.title}`;
    pl.appendChild(span);
  }
  $("btn-clear-played").classList.toggle("hidden", !isHost() || !played.length);

  $("lobby-host-controls").classList.toggle("hidden", !isHost());
  $("lobby-waiting").classList.toggle("hidden", isHost());
  if (!isHost()) return;

  const s = meta.settings || {};
  $("set-source").value = s.source || "nominate";
  $("set-count").value = String(s.count || 6);
  $("set-filter").value = s.filter || "all";
  $("set-votes").value = String(s.votesEach || 2);
  $("set-timer").value = String(s.timer ?? 45);
  $("set-skip").checked = s.skipPlayed !== false;
  $("lbl-count").classList.toggle("hidden", s.source !== "shuffle");

  const handpicking = s.source === "handpick";
  $("handpick-box").classList.toggle("hidden", !handpicking);
  if (handpicking) {
    if (!handpick) handpick = createPicker($("handpick-picker"), renderHandpickCount);
    handpick.setMax(MAX_BALLOT);
    handpick.setExclude(excludedSlugs());
    handpick.setFilter(s.filter || "all", (s.filter || "all") !== "all");
    renderHandpickCount();
  }
}

function renderHandpickCount() {
  if (!handpick) return;
  const n = handpick.count();
  $("handpick-count").textContent =
    `${n} of up to ${MAX_BALLOT} — ${n < MIN_BALLOT ? `pick at least ${MIN_BALLOT}` : "ready"}`;
}

function renderTop() {
  const r = meta.round || {};
  $("round-info").textContent = `Room ${roomCode}`;
  $("top-label").textContent =
    meta.state === "nominating" ? "📝 Nominate your games" :
    meta.state === "voting" ? (r.kind === "runoff" ? "⚔️ Runoff — pick one" : "🗳️ Vote!") :
    meta.result?.winner ? "🏆 We have a winner" : "🤝 Dead heat";
}

function renderNominate() {
  const r = meta.round;
  const max = r.nomsEach || NOMS_EACH;
  if (built.phase !== "nominating" || built.num !== r.num) {
    built = { phase: "nominating", num: r.num };
    if (!nominator) nominator = createPicker($("nominate-picker"), renderNominateCount);
    nominator.clear();
    nominator.setMax(max);
    nominator.setExclude(excludedSlugs());
    const f = meta.settings?.filter || "all";
    nominator.setFilter(f, f !== "all");
    $("nominate-title").textContent = `Nominate up to ${max} game${max === 1 ? "" : "s"}`;
  }
  renderNominateCount();
  $("btn-close-noms").classList.toggle("hidden", !isHost());
  showView("nominate");
}

function renderNominateCount() {
  if (!nominator) return;
  const n = nominator.count();
  $("nominate-count").textContent = `${n} of ${nominator.max()} chosen`;
  $("btn-nominate").disabled = n === 0;
}

function renderBallot() {
  const r = meta.round;
  if (built.phase !== "voting" || built.num !== r.num) {
    built = { phase: "voting", num: r.num };
    ballotSel = [];
    $("vote-title").textContent = r.kind === "runoff"
      ? "Runoff — one pick each, no sitting on the fence"
      : "Tick everything you'd happily play";
    const box = $("ballot");
    box.innerHTML = "";
    for (const slug of r.ballot || []) {
      const g = GAME_BY_SLUG[slug];
      if (!g) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "opt";
      btn.dataset.slug = slug;
      btn.innerHTML = `
        <span class="opt-emoji">${g.emoji}</span>
        <span>
          <span class="opt-name">${esc(g.title)}<span class="opt-badges">👥 ${esc(g.players)} · ⏱ ${esc(g.time)}${
            (g.extras || []).map((x) => ` · ${esc(x)}`).join("")}</span></span>
          <span class="opt-blurb">${esc(g.blurb)}</span>
          <span class="opt-pick">Pick this when ${esc(g.pick)}</span>
        </span>
        <span class="opt-tick">✓</span>`;
      box.appendChild(btn);
    }
  }
  const budget = meta.round.votesEach || 1;
  $("vote-sub").textContent = budget === 1
    ? "One pick each — choose well."
    : `Up to ${budget} picks. Ticking more than that drops your earliest one.`;
  $("vote-count").textContent = `${ballotSel.length} of ${budget} ticked`;
  $("btn-vote").disabled = ballotSel.length === 0;
  for (const btn of $("ballot").children) {
    const on = ballotSel.includes(btn.dataset.slug);
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  $("btn-close-vote").classList.toggle("hidden", !isHost());
  showView("vote");
}

$("ballot").addEventListener("click", (e) => {
  const btn = e.target.closest(".opt");
  if (!btn || !meta || meta.state !== "voting" || myVoted()) return;
  const slug = btn.dataset.slug;
  const i = ballotSel.indexOf(slug);
  if (i >= 0) ballotSel.splice(i, 1);
  else {
    ballotSel.push(slug);
    while (ballotSel.length > (meta.round.votesEach || 1)) ballotSel.shift();
  }
  renderBallot();
});

function renderWait(phase) {
  const nominating = phase === "nominate";
  $("wait-title").textContent = nominating ? "✅ Nominations in!" : "✅ Vote locked in!";
  if (nominating) {
    $("wait-sub").textContent = "Waiting for everyone else — then the ballot goes up.";
  } else {
    const thisRound = myLastVote.num === meta.round.num;
    const names = (thisRound ? myLastVote.slugs : [])
      .map((s) => GAME_BY_SLUG[s]).filter(Boolean)
      .map((g) => `${g.emoji} ${g.title}`);
    $("wait-sub").textContent = names.length ? `You ticked: ${names.join(", ")}`
      : thisRound ? "Time ran out — you abstained."
      : "Waiting for everyone else to vote…";
  }
  const field = nominating ? "nominatedRound" : "votedRound";
  const ul = $("wait-list");
  ul.innerHTML = "";
  for (const [, p] of sortedPlayers()) {
    if (!p.connected) continue;
    const done = (p[field] || 0) >= meta.round.num;
    const li = document.createElement("li");
    li.textContent = `${done ? "✅" : "💭"} ${p.name}`;
    if (done) li.classList.add("done");
    ul.appendChild(li);
  }
  $("btn-close-wait").classList.toggle("hidden", !isHost());
  showView("wait");
}

function renderReveal() {
  const res = meta.result || {};
  const rows = res.rows || [];
  const winner = res.winner ? GAME_BY_SLUG[res.winner] : null;

  $("winner-box").classList.toggle("hidden", !winner);
  if (winner) {
    $("winner-emoji").textContent = winner.emoji;
    $("winner-title").textContent = winner.title;
    $("winner-blurb").textContent = winner.blurb;
    const votes = rows.find((r) => r.slug === res.winner)?.votes || 0;
    $("winner-how").textContent = res.decidedBy === "coin"
      ? `🪙 Tied on ${votes} — the coin chose it.`
      : `${votes} of ${res.voterCount || 0} voters ticked it · 👥 ${winner.players} · ⏱ ${winner.time}`;
    $("winner-link").href = `../${winner.slug}/`;
    $("winner-link").textContent = `Play ${winner.title} →`;
  }

  const needsBreak = !winner;
  $("tie-box").classList.toggle("hidden", !needsBreak);
  if (needsBreak) {
    const tied = res.tied || [];
    const names = (tied.length ? tied : (meta.round?.ballot || []))
      .map((s) => GAME_BY_SLUG[s]).filter(Boolean).map((g) => `${g.emoji} ${g.title}`);
    $("tie-title").textContent = tied.length ? "🤝 It's a tie!" : "😶 Nobody voted";
    $("tie-sub").textContent = tied.length
      ? `${names.join(" vs ")} — level on ${rows[0]?.votes || 0} vote${rows[0]?.votes === 1 ? "" : "s"}.`
      : "Not a single tick. Flip a coin over the whole ballot, or run it again.";
    $("tie-host").classList.toggle("hidden", !isHost());
    $("tie-waiting").classList.toggle("hidden", isHost());
    $("btn-runoff").disabled = (tied.length ? tied.length : (meta.round?.ballot || []).length) < MIN_BALLOT;
  }

  const top = rows[0]?.votes || 0;
  const box = $("results");
  box.innerHTML = "";
  for (const r of rows) {
    const g = GAME_BY_SLUG[r.slug];
    if (!g) continue;
    const div = document.createElement("div");
    const isTop = r.votes === top && top > 0;
    const isMine = myLastVote.num === res.num && myLastVote.slugs.includes(r.slug);
    div.className = "bar-row" + (isTop ? " top" : "") + (isMine ? " mine" : "");
    div.innerHTML = `
      <span class="bar-emoji">${g.emoji}</span>
      <div class="bar-main">
        <div class="bar-title">
          <span class="bar-name">${esc(g.title)}</span>
          <span class="bar-votes">${r.votes} vote${r.votes === 1 ? "" : "s"}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${top ? (r.votes / top) * 100 : 0}%"></div></div>
        <div class="bar-voters">${r.voters?.length ? esc(r.voters.join(", ")) : "—"}</div>
      </div>`;
    box.appendChild(div);
  }
  $("results-heading").textContent =
    `The ballot · ${res.voterCount || 0} of ${res.playerCount || 0} voted`;

  $("reveal-host").classList.toggle("hidden", !isHost());
  $("reveal-waiting").classList.toggle("hidden", isHost());
}

function renderTimer() {
  const el = $("timer");
  const r = meta?.round;
  const ticking = meta?.state === "nominating" || meta?.state === "voting";
  if (!ticking || !r?.endsAt) {
    el.textContent = ticking ? "∞" : "--";
    el.classList.remove("low");
    return;
  }
  const secs = Math.max(0, Math.ceil((r.endsAt - nowSrv()) / 1000));
  el.textContent = secs;
  el.classList.toggle("low", secs <= 8);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── Interactions ──────────────────────────────────────────────────────────────
$("btn-start").addEventListener("click", startVote);
$("btn-nominate").addEventListener("click", () => submitNominations(false));
$("btn-vote").addEventListener("click", () => submitVote(false));
$("btn-close-noms").addEventListener("click", closeNominations);
$("btn-close-vote").addEventListener("click", closeVote);
$("btn-close-wait").addEventListener("click", () => {
  if (meta?.state === "nominating") closeNominations(); else closeVote();
});
$("btn-coin").addEventListener("click", flipCoin);
$("btn-runoff").addEventListener("click", runoff);
$("btn-again").addEventListener("click", backToLobby);
$("btn-clear-played").addEventListener("click", () =>
  txMeta((m) => (m.state === "lobby" ? { ...m, played: null } : undefined)));

const settingWriters = {
  "set-source": (v) => ({ source: v }),
  "set-count": (v) => ({ count: Number(v) }),
  "set-filter": (v) => ({ filter: v }),
  "set-votes": (v) => ({ votesEach: Number(v) }),
  "set-timer": (v) => ({ timer: Number(v) }),
};
for (const [id, toPatch] of Object.entries(settingWriters)) {
  $(id).addEventListener("change", (e) => update(child(metaRef(), "settings"), toPatch(e.target.value)));
}
$("set-skip").addEventListener("change", (e) =>
  update(child(metaRef(), "settings"), { skipPlayed: e.target.checked }));

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
