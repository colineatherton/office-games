// The vote arithmetic, deliberately free of DOM and Firebase so it can be run
// in node — see test-tally.mjs. app.js owns everything stateful (rooms, hosts,
// timers); this file only answers "what's on the ballot" and "who won".
//
// `order` maps slug → catalogue position. It is a *presentation* tie-break
// only: equal votes never silently pick a winner, they come back as `tied` for
// the room to settle with a coin flip or a runoff.

export const MIN_BALLOT = 2;   // a "vote" between fewer than two games isn't one
export const MAX_BALLOT = 8;   // more than this and nobody reads the ballot

/**
 * Fold everyone's nominations into a ballot: most-nominated first.
 * Unknown slugs (a stale link, a renamed folder) are dropped.
 */
export function ballotFromNominations(nominations, {
  order = {}, isGame = () => true, max = MAX_BALLOT,
} = {}) {
  const counts = new Map();
  for (const picks of Object.values(nominations || {})) {
    for (const slug of Object.keys(picks || {})) {
      if (!isGame(slug)) continue;
      counts.set(slug, (counts.get(slug) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (order[a[0]] ?? 0) - (order[b[0]] ?? 0))
    .slice(0, max)
    .map(([slug]) => slug);
}

/**
 * How many games one person may tick. Ticking every option says nothing, so the
 * budget always stays below the ballot size.
 */
export function voteBudget(requested, ballotSize) {
  return Math.min(Math.max(1, requested || 1), Math.max(1, ballotSize - 1));
}

/**
 * Approval-count the votes.
 * @param {string[]} ballot        slugs, in ballot order
 * @param {Object} cast            { playerId: { slug: true } }
 * @param {(id: string) => string} nameOf
 * @returns {{rows, voterCount, winner, tied, decidedBy}} rows are sorted
 *          best-first; `winner` is only set when a single game leads outright.
 */
export function tallyBallot(ballot, cast, nameOf = (id) => id, { order = {} } = {}) {
  const rows = ballot.map((slug) => ({ slug, votes: 0, voters: [] }));
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  for (const [id, picks] of Object.entries(cast || {})) {
    for (const slug of Object.keys(picks || {})) {
      const row = bySlug.get(slug);
      if (!row) continue;   // a vote for something that isn't on this ballot
      row.votes++;
      row.voters.push(nameOf(id));
    }
  }
  rows.sort((a, b) => b.votes - a.votes || (order[a.slug] ?? 0) - (order[b.slug] ?? 0));

  const top = rows[0]?.votes || 0;
  const leaders = top > 0 ? rows.filter((r) => r.votes === top).map((r) => r.slug) : [];
  return {
    rows,
    voterCount: Object.keys(cast || {}).length,
    winner: leaders.length === 1 ? leaders[0] : null,
    tied: leaders.length > 1 ? leaders : [],
    decidedBy: leaders.length === 1 ? "votes" : null,
  };
}
