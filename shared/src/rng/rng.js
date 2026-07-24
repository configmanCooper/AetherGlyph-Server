// rng.js — deterministic seeded RNG (mulberry32). Pure, Node + browser safe.
// The simulation MUST use this instead of Math.random so that the same seed
// plus the same ordered inputs always produces the same result (replay/hash).

export function mulberry32(seed) {
  let a = seed >>> 0;
  const next = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.getState = () => a >>> 0;
  return next;
}

export function makeRng(seed) {
  let state = seed >>> 0;
  const next = mulberry32(state);
  const api = {
    seed: state,
    next,
    float: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    getState: () => next.getState(),
  };
  return api;
}
