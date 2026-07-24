// reactions.js — environmental reaction catalog + deterministic priority.
//
// The actual state mutation lives in the Sim (it needs zones, statuses, damage,
// and Tenacity), but the reaction NAMES, their matrix category, and the
// data-versioned priority order live here so they can be inspected and tested
// independently (environment-matrix.md "Deterministic reaction priority").
//
// category maps each reaction to one of the seven ordered buckets:
//   douse < ground < freeze < conduct < ignite < spread < cover

import { REACTION_PRIORITY } from './constants.js';

export const REACTIONS = [
  // existing state  + incoming  -> result                       category
  { name: 'Doused',         category: 'douse',   existing: 'Burning', incoming: 'water' },
  { name: 'WashedGround',   category: 'douse',   existing: 'Oil',     incoming: 'water' },
  { name: 'Grounded',       category: 'ground',  existing: 'Storm',   incoming: 'grounding' },
  { name: 'FrozenGround',   category: 'freeze',  existing: 'Wet',     incoming: 'frost' },
  { name: 'SteamVeil',      category: 'freeze',  existing: 'Frozen',  incoming: 'ember' },
  { name: 'ConductiveArc',  category: 'conduct', existing: 'Wet',     incoming: 'storm' },
  { name: 'FlashFire',      category: 'ignite',  existing: 'Oil',     incoming: 'ember' },
  { name: 'SpreadingFlame', category: 'spread',  existing: 'Fire',    incoming: 'gust' },
  { name: 'ClearedAir',     category: 'spread',  existing: 'Fog',     incoming: 'gust' },
  { name: 'BacklitFog',     category: 'spread',  existing: 'Fog',     incoming: 'flamewave' },
  { name: 'DriftingOil',    category: 'spread',  existing: 'Oil',     incoming: 'gust' },
  { name: 'Rubble',         category: 'cover',   existing: 'Cover',   incoming: 'quake' },
  { name: 'FracturedCover', category: 'cover',   existing: 'Cover',   incoming: 'fireball' },
  { name: 'Spectrum',       category: 'conduct', existing: 'resonance', incoming: 'prismatic' },
];

export const REACTIONS_BY_NAME = Object.freeze(
  REACTIONS.reduce((m, r) => { m[r.name] = r; return m; }, {}),
);

// Priority index for a reaction category (lower = resolves earlier).
export function priorityOf(category) {
  const i = REACTION_PRIORITY.indexOf(category);
  return i < 0 ? REACTION_PRIORITY.length : i;
}

// Stable-sort a list of candidate reaction records by matrix priority; ties
// break on the fixed REACTIONS declaration order for determinism.
export function sortByPriority(candidates) {
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) =>
      priorityOf(a.c.category) - priorityOf(b.c.category) || a.i - b.i)
    .map((x) => x.c);
}

// Prismatic Beam mixed-resonance utility (environment-matrix.md table). Returns
// a small non-stacking modifier object based on the two prior resonance schools.
export function prismaticUtility(schoolA, schoolB) {
  const set = new Set([schoolA, schoolB]);
  const has = (x, y) => set.has(x) && set.has(y) && schoolA !== schoolB;
  if (has('Ember', 'Gale')) return { key: 'width', widthBonus: 0.10 };
  if (has('Tide', 'Storm')) return { key: 'static', applyStatic: 1 };
  if (has('Tide', 'Stone')) return { key: 'grounded', groundedStripS: 1 };
  if (has('Stone', 'Ember')) return { key: 'cover', coverDamageBonus: 0.20 };
  if (has('Gale', 'Tide')) return { key: 'clearfog', clearFog: true };
  return { key: 'none' };
}
