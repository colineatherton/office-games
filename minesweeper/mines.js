// Pure minesweeper logic — no Firebase, no DOM — so it can be unit-tested in node.
// Mine layout is derived deterministically from (seed, firstIdx): the first
// clicked cell and its 8 neighbours are always safe, and every client
// recomputes the same layout from the seed instead of syncing it.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function neighbors(idx, W, H) {
  const x = idx % W, y = Math.floor(idx / W), out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) out.push(ny * W + nx);
    }
  }
  return out;
}

export function minesFromSeed(seed, firstIdx, W, H, M) {
  const safe = new Set([firstIdx, ...neighbors(firstIdx, W, H)]);
  const pool = [];
  for (let i = 0; i < W * H; i++) if (!safe.has(i)) pool.push(i);
  const rnd = mulberry32(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return new Set(pool.slice(0, M));
}

export function computeCounts(mines, W, H) {
  const counts = new Array(W * H).fill(0);
  for (const m of mines) {
    for (const n of neighbors(m, W, H)) counts[n]++;
  }
  return counts;
}

// Reveal starting at `start`: a numbered cell reveals just itself; a zero cell
// flood-fills through zeros, revealing their numbered borders too. `isOpen`
// reports cells already revealed. Never returns a mine cell.
export function floodReveal(start, mines, counts, isOpen, W, H) {
  if (mines.has(start) || isOpen(start)) return [];
  const out = [];
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const c = queue.shift();
    out.push(c);
    if (counts[c] !== 0) continue;
    for (const n of neighbors(c, W, H)) {
      if (seen.has(n) || isOpen(n) || mines.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return out;
}
