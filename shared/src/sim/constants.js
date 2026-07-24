// constants.js — authoritative Phase 1 tuning constants pulled straight from
// MASTERPLAN.md sections 3, 6, 7. Kept DOM-free so it imports cleanly in Node
// and the browser. Times are seconds; the sim converts them to ticks.

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

// --- Match structure (MASTERPLAN §3) -------------------------------------
export const MATCH = {
  startHealth: 150,
  roundLimitS: 105,
  arcanePressureStartS: 60,
  arcanePressureStepS: 10,
  lateRoundS: 90, // shields -20% cap, healing disabled
};

// --- Aether (MASTERPLAN §6) ----------------------------------------------
export const AETHER = {
  max: 100,
  start: 60,
  regenPerS: 4,
  protectedFloor: 0,
};

export const STAMINA = {
  max: 100,
  start: 100,
  movePerS: 1.5,
  dodgeCost: 5,
  bracePerS: 3,
  focusPerS: 3,
  regenPerS: 1,
  hasteRegenPerS: 1.5,
  hasteCostMul: 0.75,
  restedAfterS: 2,
  restedRegenMul: 1.25,
  deepRestAfterS: 5,
  deepRestRegenMul: 1.75,
};

// --- Sigil charges (MASTERPLAN §6) ---------------------------------------
export const SIGIL = {
  max: 3,
  start: 0,
  decayS: 8, // one charge decays after 8s of inactivity
};

// --- Universal actions (MASTERPLAN §4) -----------------------------------
export const FOCUS = {
  channelS: 1.9, // hold to gain one Sigil Charge; interruptible
  fullChargeAetherRegenMul: 1.5,
};
export const SIDESTEP = {
  charges: 2,
  rechargeS: 2.5,
  arcDelta: 0.42, // fraction of the movement arc covered by one sidestep
};
export const BRACE = {
  durationS: 0.08,
  damageReduction: 0.75,
  aetherGain: 0.25,
};

// --- Movement arc (MASTERPLAN §12) ---------------------------------------
// Position is a scalar in [-1, 1] mapped onto a shallow 100-degree arc.
export const MOVE = {
  arcHalfDeg: 50,
  speedPerS: 0.9,           // free strafe speed (arc units per second)
  separationBase: 10,       // arena units between wizards (render only)
};

// --- Hard control safety / Tenacity (MASTERPLAN §7) ----------------------
export const CONTROL = {
  maxHardControlS: 1.0,
  tenacityS: 3.5, // blocks new hard control after any hard control ends
  knockbackWindowS: 4.0,
  knockbackMaxChain: 2,
};

// --- Recognition recovery (MASTERPLAN §5) --------------------------------
export const CAST = {
  rejectRecoveryS: 0.25,
  minPotency: 0.9,
  maxPotency: 1.05,
};

// --- Status effect definitions (MASTERPLAN §7) ---------------------------
// duration in seconds; other fields are read by sim/status logic.
// `harmful: true` marks statuses Dispel can strip and the HUD flags as debuffs.
// `buff: true` (kind:'buff') marks self buffs — never dispelled off the caster
// by an opponent and shown as beneficial in the HUD.
export const STATUSES = {
  // Debuffs / crowd control ------------------------------------------------
  Burning:  { durationS: 9, maxStacks: 2, dps: 2, kind: 'dot', harmful: true },
  Chilled:  { durationS: 9, maxStacks: 1, slow: 0.18, kind: 'slow', harmful: true },
  Sloth:    { durationS: 12, maxStacks: 1, slow: 0.30, kind: 'slow', harmful: true },
  Wet:      { durationS: 6, maxStacks: 1, kind: 'flag', harmful: true },
  Soaked:   { durationS: 12, maxStacks: 1, lightningBonus: 0.25, kind: 'flag', harmful: true },
  Static:   { durationS: 9, maxStacks: 3, kind: 'flag', harmful: true },
  Sundered: { durationS: 12, maxStacks: 1, damageTaken: 0.20, kind: 'amp', harmful: true },
  Weakened: { durationS: 12, maxStacks: 1, damageDealt: 0.22, kind: 'amp', harmful: true },
  Marked:   { durationS: 15, maxStacks: 1, markBonus: 0.35, kind: 'flag', harmful: true },
  Blinded:  { durationS: 4, maxStacks: 1, kind: 'flag', harmful: true },   // Eclipse Glare
  Veiled:   { durationS: 6, maxStacks: 1, kind: 'flag', harmful: true },   // Veil Hex (visual)
  Rooted:   { durationS: 3, maxStacks: 1, canCast: true, kind: 'control', harmful: true },
  KnockedDown: { durationS: 2, maxStacks: 1, canCast: true, kind: 'control', harmful: true },
  Frozen:   { durationS: 1.0, maxStacks: 1, canCast: false, hard: true, kind: 'control', harmful: true },
  Stunned:  { durationS: 1.0, maxStacks: 1, canCast: false, hard: true, kind: 'control', harmful: true },
  // Self buffs -------------------------------------------------------------
  Haste:       { durationS: 18, maxStacks: 1, haste: 0.30, kind: 'buff' },
  Grounded:    { durationS: 15, maxStacks: 1, dmgReduction: 0.15, moveSlow: 0.15, kind: 'buff' },
  AetherSurge: { durationS: 18, maxStacks: 1, aetherPerS: 5, kind: 'buff' },
  Attunement:  { durationS: 30, maxStacks: 1, school: 'Ember', costMul: 0.50, kind: 'buff' },
  Phoenix:     { durationS: 15, maxStacks: 1, kind: 'buff' },
};

// Hard control that Tenacity guards against.
export const HARD_CONTROL = new Set(['Frozen', 'Stunned']);

// Harmful statuses Dispel can strip (order = Dispel removal priority).
export const DISPELLABLE = [
  'Frozen', 'Stunned', 'Rooted', 'KnockedDown', 'Marked', 'Sundered', 'Weakened',
  'Burning', 'Chilled', 'Sloth', 'Soaked', 'Wet', 'Static', 'Blinded', 'Veiled',
];

// --- Environmental zones (MASTERPLAN §10, environment-matrix.md) ----------
// A wizard occupies a zone when |arcPos - zone.center| <= radius. Zones are
// shared: either player can exploit or be affected by any active zone.
export const ZONE = {
  maxPerPlayer: 2,        // §10 two active zones per player
  radius: 0.55,           // arc half-width a zone covers
  hourglassProjectileSpeedMul: 0.25, // hostile projectiles travel at 25% speed
  frozenSlow: 0.22,       // Frozen Ground slows movement while standing on it
  coverHp: 26,
  snareRootS: 2,
  soakAfterS: 5,
  durations: {
    Oil: 21, Wet: 21, Fog: 18, Frozen: 9, Snare: 24, Cover: 24,
    Hourglass: 18, Fire: 12, Gust: 1.8, Grounded: 3,
  },
};

export const MIRROR_DECOY = {
  speedPerS: 0.34,
  touchRadius: 0.14,
};

// --- Environmental reaction rules (environment-matrix.md) ----------------
export const REACTION = {
  cooldownS: 1.0,          // same reaction cannot trigger more than once/sec
  maxLinks: 2,             // chains stop after two reaction links
  flashFireDamage: 10,     // Oil + Ember -> Flash Fire area damage
  quakeSlowS: 3.0,         // Wall + Quake rubble slow
  frozenGroundSlowS: 9,    // Wet + Frost -> Frozen Ground slow surface
};

// Deterministic reaction priority (environment-matrix.md). Lower = earlier
// when multiple reactions are legal in the same tick.
export const REACTION_PRIORITY = [
  'douse', 'ground', 'freeze', 'conduct', 'ignite', 'spread', 'cover',
];
