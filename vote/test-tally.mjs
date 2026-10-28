// Tests for the vote arithmetic. Run: node test-tally.mjs
//
// The cases worth pinning down are the awkward ones: ties (which must NOT pick
// a winner), nobody voting, votes for games that aren't on the ballot, and the
// vote budget on a tiny ballot.

import assert from "node:assert/strict";
import {
  MIN_BALLOT, MAX_BALLOT, ballotFromNominations, tallyBallot, voteBudget,
} from "./tally.js";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

// Pretend catalogue order: a, b, c, d …
const order = Object.fromEntries("abcdefghij".split("").map((s, i) => [s, i]));
const opts = { order };

// ── ballotFromNominations ─────────────────────────────────────────────────────
test("counts nominations, most-nominated first", () => {
  const ballot = ballotFromNominations({
    p1: { c: true, a: true },
    p2: { c: true },
    p3: { b: true },
  }, opts);
  assert.deepEqual(ballot, ["c", "a", "b"]); // c twice; a before b on catalogue order
});

test("catalogue order breaks equal nomination counts", () => {
  assert.deepEqual(ballotFromNominations({ p1: { d: true }, p2: { b: true } }, opts), ["b", "d"]);
});

test("drops slugs that aren't games", () => {
  const ballot = ballotFromNominations({ p1: { a: true, ghost: true } },
    { ...opts, isGame: (s) => s !== "ghost" });
  assert.deepEqual(ballot, ["a"]);
});

test("caps the ballot at max", () => {
  const noms = { p1: Object.fromEntries("abcdefghij".split("").map((s) => [s, true])) };
  assert.equal(ballotFromNominations(noms, opts).length, MAX_BALLOT);
  assert.equal(ballotFromNominations(noms, { ...opts, max: 3 }).length, 3);
});

test("no nominations at all is an empty ballot, not a crash", () => {
  assert.deepEqual(ballotFromNominations(null, opts), []);
  assert.deepEqual(ballotFromNominations({ p1: null, p2: {} }, opts), []);
});

// ── voteBudget ────────────────────────────────────────────────────────────────
test("the vote budget never reaches the ballot size", () => {
  assert.equal(voteBudget(3, 6), 3);
  assert.equal(voteBudget(3, 3), 2);   // ticking all 3 would say nothing
  assert.equal(voteBudget(2, 2), 1);
  assert.equal(voteBudget(1, 8), 1);
  assert.equal(voteBudget(0, 8), 1);   // never zero — you'd be unable to vote
  assert.equal(voteBudget(2, 1), 1);   // degenerate ballot, still votable
});

// ── tallyBallot ───────────────────────────────────────────────────────────────
const names = { p1: "Ana", p2: "Ben", p3: "Cleo", p4: "Dev" };
const nameOf = (id) => names[id] || "someone";

test("approval counting: a clear winner with its voters", () => {
  const res = tallyBallot(["a", "b", "c"], {
    p1: { a: true, b: true },
    p2: { a: true },
    p3: { c: true, a: true },
  }, nameOf, opts);
  assert.equal(res.winner, "a");
  assert.equal(res.decidedBy, "votes");
  assert.deepEqual(res.tied, []);
  assert.equal(res.voterCount, 3);
  assert.deepEqual(res.rows.map((r) => [r.slug, r.votes]), [["a", 3], ["b", 1], ["c", 1]]);
  assert.deepEqual(res.rows[0].voters, ["Ana", "Ben", "Cleo"]);
});

test("the approval winner can be nobody's favourite", () => {
  // b is first choice for nobody, but everyone would happily play it.
  const res = tallyBallot(["a", "b", "c"], {
    p1: { a: true, b: true },
    p2: { c: true, b: true },
    p3: { c: true, b: true },
  }, nameOf, opts);
  assert.equal(res.winner, "b");
});

test("a tie does NOT pick a winner — it reports the tied games", () => {
  const res = tallyBallot(["a", "b", "c"], {
    p1: { a: true },
    p2: { b: true },
  }, nameOf, opts);
  assert.equal(res.winner, null);
  assert.equal(res.decidedBy, null);
  assert.deepEqual(res.tied, ["a", "b"]);
});

test("a three-way tie reports all three", () => {
  const res = tallyBallot(["a", "b", "c"], {
    p1: { a: true }, p2: { b: true }, p3: { c: true },
  }, nameOf, opts);
  assert.deepEqual(res.tied, ["a", "b", "c"]);
});

test("nobody voted: no winner, nothing tied, every row at zero", () => {
  const res = tallyBallot(["a", "b"], {}, nameOf, opts);
  assert.equal(res.winner, null);
  assert.deepEqual(res.tied, []);
  assert.equal(res.voterCount, 0);
  assert.deepEqual(res.rows.map((r) => r.votes), [0, 0]);
});

test("an abstention (empty vote node) counts as a voter but no votes", () => {
  const res = tallyBallot(["a", "b"], { p1: { a: true }, p2: {} }, nameOf, opts);
  assert.equal(res.winner, "a");
  assert.equal(res.rows[0].votes, 1);
});

test("votes for games that aren't on the ballot are ignored", () => {
  // Can happen if a runoff narrows the ballot while a slow client is voting.
  const res = tallyBallot(["a", "b"], { p1: { z: true, a: true }, p2: { z: true } }, nameOf, opts);
  assert.equal(res.winner, "a");
  assert.deepEqual(res.rows.map((r) => [r.slug, r.votes]), [["a", 1], ["b", 0]]);
});

test("every ballot entry appears in the rows, even with zero votes", () => {
  const ballot = ["a", "b", "c", "d"];
  const res = tallyBallot(ballot, { p1: { d: true } }, nameOf, opts);
  assert.deepEqual(res.rows.map((r) => r.slug).sort(), ballot);
  assert.equal(res.rows[0].slug, "d");
});

test("rows are ordered by votes, then catalogue order", () => {
  const res = tallyBallot(["d", "a", "b"], {
    p1: { a: true, d: true }, p2: { a: true, b: true }, p3: { b: true, d: true },
  }, nameOf, opts);
  assert.deepEqual(res.rows.map((r) => r.slug), ["a", "b", "d"]);
  assert.deepEqual(res.tied, ["a", "b", "d"]);
});

test("a runoff between the tied games produces a winner", () => {
  const first = tallyBallot(["a", "b"], { p1: { a: true }, p2: { b: true } }, nameOf, opts);
  assert.deepEqual(first.tied, ["a", "b"]);
  const runoff = tallyBallot(first.tied, {
    p1: { a: true }, p2: { b: true }, p3: { b: true },
  }, nameOf, opts);
  assert.equal(runoff.winner, "b");
});

assert.equal(MIN_BALLOT, 2);

console.log(process.exitCode
  ? "\nsome tests failed."
  : `✅ ${passed} vote-arithmetic tests passed.`);
