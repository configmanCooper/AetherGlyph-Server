// combos.js — the Practice AI's tier-gated combat KNOWLEDGE (SOLO-MODES-PLAN
// §14, §17). This is pure data + small helpers: which setup→payoff combos and
// which counters a difficulty is allowed to know. It contains NO simulation or
// randomness so it can be inspected and unit-tested on its own, and it never
// grants stats — only *which legal plays the bot is aware of*.
//
// Knowledge is the ONLY thing gated here. Easy, Medium, and Hard all execute the
// same legal intents through the same Sim; they simply know fewer or more of the
// plays below.

// Combo tiers, lowest → highest knowledge:
//   'one-step'  a single obvious follow-up (known by Easy and up)
//   'two-step'  a selected setup→payoff plan   (known by Medium and up)
//   'expert'    every legal setup→payoff plan   (known by Hard only)
export const COMBO_TIERS = ['one-step', 'two-step', 'expert'];

// setupStatusOnOpp / setupZone describe the primed condition; payoffSpells are
// the spells that cash it in. setupSpells are how the bot creates the condition.
export const COMBOS = [
  { key: 'chill-freeze',   tier: 'one-step', setupStatusOnOpp: 'Chilled', setupSpells: [2, 9],  payoffSpells: [27] },
  { key: 'mark-payoff',    tier: 'two-step', setupStatusOnOpp: 'Marked',  setupSpells: [18],    payoffSpells: [5, 8, 4, 6, 34] },
  { key: 'soak-thunder',   tier: 'two-step', setupStatusOnOpp: 'Soaked',  setupZone: 'Wet', setupSpells: [32], payoffSpells: [30, 7] },
  { key: 'static-thunder', tier: 'two-step', setupStatusOnOpp: 'Static', setupStacks: 3, setupSpells: [3], payoffSpells: [30, 7] },
  { key: 'oil-ignite',     tier: 'expert',   setupZone: 'Oil',  setupSpells: [31], payoffSpells: [1, 6, 8], ownZone: true },
  { key: 'sunder-burst',   tier: 'expert',   setupStatusOnOpp: 'Sundered', setupSpells: [22], payoffSpells: [8, 4, 5, 6] },
];

// The combos a difficulty may use, given its combo-knowledge tier.
export function combosForTier(tier) {
  const max = Math.max(0, COMBO_TIERS.indexOf(tier));
  return COMBOS.filter((c) => COMBO_TIERS.indexOf(c.tier) <= max);
}

// Counter-knowledge levels (SOLO-MODES-PLAN §14 "Counter knowledge"):
//   basic    → a Ward vs projectiles, one cleanse, Chill→Freeze
//   common   → + Reflect, Blink, Grounding vs Storm, primed stun, Mark payoff, hazard avoidance
//   complete → + Gust vs light shots, Barrier vs heavy, Sunder burst, environment plays, feints
export const COUNTER_LEVELS = ['basic', 'common', 'complete'];

const COUNTER_SETS = {
  basic:    new Set(['ward', 'cleanse', 'chill-freeze']),
  common:   new Set(['ward', 'cleanse', 'chill-freeze', 'reflect', 'blink', 'grounding', 'primed-stun', 'mark-payoff', 'avoid-hazard']),
  complete: new Set(['ward', 'cleanse', 'chill-freeze', 'reflect', 'blink', 'grounding', 'primed-stun', 'mark-payoff', 'avoid-hazard',
    'gust', 'barrier', 'sunder', 'environment', 'feint', 'reserve']),
};

export function knowsCounter(level, key) {
  const set = COUNTER_SETS[level] || COUNTER_SETS.basic;
  return set.has(key);
}

// School → legal spell ids that broadly ANSWER that school. Used by Medium to
// score curated presets and by Hard to prioritise a counter-build (§18). Every
// id here is a real, legal roster spell; equipping it is always rules-legal.
export const COUNTER_SPELLS_FOR_SCHOOL = {
  Storm:     [20, 12, 10],       // Grounding cancels lightning; Reflect; Ward
  Ember:     [32, 11, 10],       // Rain douses; Barrier; Ward
  Tide:      [13, 16, 10],       // Dispel chill; Haste cleanse; Ward
  Stone:     [14, 11, 10],       // Blink the piercer; Barrier; Ward
  Gale:      [10, 13, 11],       // Ward; Dispel; Barrier
  Umbra:     [13, 10, 14],       // Dispel debuffs; Ward; Blink
  Arcane:    [13, 12, 10],       // Dispel; Reflect; Ward
  Prismatic: [28, 34, 11],       // interrupt the channel; Quake; Barrier
};

// Control spells that should make a counter-builder pack a cleanse / mobility
// answer (§18 "contains a cleanse or mobility answer when the player uses control").
export const CONTROL_SPELL_IDS = new Set([7, 26, 27, 29, 30, 36, 23]); // Chain L., Entangle, Frost Bind, Eclipse, Thunderclap, Rune Snare, Sloth

// Storm spell ids — three or more of these in the player build strongly justifies
// Grounding Mantle (§18 "contains Grounding when Storm is strongly represented").
export const STORM_SPELL_IDS = new Set([3, 7, 30]);
