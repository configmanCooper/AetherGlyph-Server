// spellEffects.js — machine-usable combat behaviour for the FULL 40-spell
// roster (Phase 2 / Milestone 3).
//
// The canonical cost / cooldown / charges / min-cast / loadout-point values are
// NOT duplicated here; the sim reads those from the generated catalog
// (spellData.generated.js, sourced from design/spells.csv). This module only
// adds the combat-shape data (damage, projectile travel, applied status,
// defensive behaviour, zone kind, secret payloads) that the free-text `effect`
// column in the CSV cannot express in a machine-usable way. Keyed by spell id.
//
// Effect `type` dispatches the sim's resolveCast switch:
//   projectile  travelling shot: damage + status rider + interrupt/knockback
//   shield      frontal Ward
//   barrier     360 barrier (blocks own offence)
//   reflect     timed projectile reflect window
//   hex         instant debuff / drain applied to the opponent at range
//   buff        instant self buff / self status
//   zone        place a shared environmental zone
//   dispel      strip harmful statuses or an enemy zone
//   blink       movement burst + brief evade (escapes Root)
//   channel     immobile damage-over-time beam (Prismatic)
//   mirror      spawn a decoy that eats one incoming projectile
//   phoenix     self death-prevention aura (once per round)

export const PROJECTILE = 'projectile';
export const SHIELD = 'shield';
export const BARRIER = 'barrier';
export const REFLECT = 'reflect';
export const HEX = 'hex';
export const BUFF = 'buff';
export const ZONE = 'zone';
export const DISPEL = 'dispel';
export const BLINK = 'blink';
export const CHANNEL = 'channel';
export const MIRROR = 'mirror';
export const PHOENIX = 'phoenix';

// travelS: seconds for a projectile to cross the arena (before dodge check).
// homing: small total re-aiming strength spread across the full projectile flight.
// dodgeRadius: arc distance beyond which the projectile misses a moving target.
// area: true = wide shot (large dodgeRadius, still sidesteppable at release).
export const SPELL_EFFECTS = {
  // === Offensive projectiles (9) ===========================================
  1: { // Ember Bolt
    type: PROJECTILE, damage: 8, status: { name: 'Burning', stacks: 1 },
    travelS: 0.45, homing: 0, dodgeRadius: 0.30, school: 'Ember', reflectable: true,
    igniteOil: true,
  },
  2: { // Frost Lance
    type: PROJECTILE, damage: 10, status: { name: 'Chilled', stacks: 1 },
    travelS: 0.5, homing: 0, dodgeRadius: 0.28, school: 'Tide', reflectable: true,
    frostReaction: true,
  },
  3: { // Spark Dart
    type: PROJECTILE, damage: 6, status: { name: 'Static', stacks: 1, durationS: 45 },
    travelS: 0.32, homing: 0.15, dodgeRadius: 0.30, school: 'Storm', reflectable: true,
    conductReaction: true,
  },
  4: { // Stone Shard
    type: PROJECTILE, damage: 14, piercing: true, status: null,
    travelS: 0.55, homing: 0, dodgeRadius: 0.24, school: 'Stone', reflectable: false,
    coverBonus: true,
  },
  5: { // Arcane Missile
    type: PROJECTILE, damage: 12, status: null, homing: 0.3,
    travelS: 0.55, dodgeRadius: 0.30, school: 'Arcane', reflectable: true,
  },
  6: { // Flame Wave — cone
    type: PROJECTILE, damage: 16, status: { name: 'Burning', stacks: 1 },
    travelS: 0.5, homing: 0, dodgeRadius: 0.5, area: true, school: 'Ember', reflectable: false,
    igniteOil: true, clearsFog: true, backlitFog: true,
  },
  7: { // Chain Lightning
    type: PROJECTILE, damage: 18, status: null, charges: 1,
    travelS: 0.4, homing: 0.1, dodgeRadius: 0.3, school: 'Storm', reflectable: false,
    conductReaction: true,
    conditionalStun: { needs: 'soakedOrStatic2', staticStacks: 2, durationS: 0.8, grantsTenacity: true },
  },
  8: { // Fireball — heavy area, destroys cover
    type: PROJECTILE, damage: 30, status: { name: 'Burning', stacks: 1 }, charges: 1,
    travelS: 0.55, homing: 0, dodgeRadius: 0.55, area: true, school: 'Ember', reflectable: false,
    destroysCover: true, igniteOil: true,
  },
  9: { // Ice Comet — heavy area
    type: PROJECTILE, damage: 26, status: { name: 'Chilled', stacks: 1 }, charges: 1,
    travelS: 0.6, homing: 0, dodgeRadius: 0.55, area: true, school: 'Tide', reflectable: false,
    frostReaction: true,
  },

  // === Defensive (6) =======================================================
  10: { type: SHIELD, absorb: 30, durationS: 12.6, frontal: true, school: 'Arcane' }, // Ward
  11: { type: BARRIER, absorb: 60, durationS: 9, blocksOffense: true, school: 'Arcane' }, // Barrier Dome
  12: { type: REFLECT, windowS: 3.6, school: 'Gale' }, // Reflect
  13: { type: DISPEL, statuses: 2, orZone: true, school: 'Arcane' }, // Dispel
  14: { type: BLINK, arcDelta: 0.5, evadeS: 1.05, invisibleS: 3, escapesRoot: true, school: 'Arcane' }, // Blink
  15: { type: ZONE, zoneKind: 'Cover', school: 'Stone' }, // Stone Wall

  // === Buffs (5) ===========================================================
  16: { type: BUFF, self: 'Haste', school: 'Gale', cleanses: ['Chilled'] }, // Haste
  17: { type: BUFF, self: 'AetherSurge', channel: true, school: 'Arcane' }, // Aether Surge
  18: { type: HEX, status: { name: 'Marked', stacks: 1 }, charges: 1, school: 'Arcane' }, // Amplify (marks foe)
  19: { type: BUFF, self: 'Attunement', school: 'Ember' }, // Ember Attunement
  20: { type: BUFF, self: 'Grounded', school: 'Stone' }, // Grounding Mantle

  // === Debuffs (5) =========================================================
  21: { type: HEX, status: { name: 'Weakened', stacks: 1 }, school: 'Umbra' }, // Weaken
  22: { type: HEX, status: { name: 'Sundered', stacks: 1 }, school: 'Stone' }, // Sunder
  23: { type: HEX, status: { name: 'Sloth', stacks: 1 }, school: 'Umbra' }, // Sloth Hex
  24: { type: HEX, drain: 18, school: 'Umbra' }, // Aether Leech
  25: { type: HEX, status: { name: 'Veiled', stacks: 1 }, charges: 1, school: 'Umbra' }, // Veil Hex

  // === Control (5) =========================================================
  26: { type: HEX, status: { name: 'Rooted', stacks: 1 }, school: 'Stone' }, // Entangle
  27: { // Frost Bind — freeze only if Chilled; consumes Chilled, grants Tenacity
    type: HEX, conditionalControl: { needs: 'chilled', status: 'Frozen', durationS: 3,
      consume: 'Chilled', grantsTenacity: true, ignoreHardCap: true }, school: 'Tide',
  },
  28: { // Concussive Blast
    type: PROJECTILE, damage: 6, knockback: true, knockdown: true, interrupt: true, status: null,
    travelS: 0.28, homing: 0, dodgeRadius: 0.34, school: 'Gale', reflectable: false,
  },
  29: { type: HEX, status: { name: 'Blinded', stacks: 1 }, school: 'Umbra' }, // Eclipse Glare
  30: { // Thunderclap — damage + conditional stun
    type: PROJECTILE, damage: 8, status: null, charges: 1,
    travelS: 0.25, homing: 0, dodgeRadius: 0.32, school: 'Storm', reflectable: false,
    conditionalStun: {
      needs: 'soakedOrStatic2', staticStacks: 2, durationS: 2, grantsTenacity: true,
      consumeStatic: true, ignoreHardCap: true,
    },
  },

  // === Environmental (6) ===================================================
  31: { type: ZONE, zoneKind: 'Oil', school: 'Ember' }, // Oil Script
  32: { type: ZONE, zoneKind: 'Wet', dousesBurning: true, school: 'Tide' }, // Rain Glyph
  33: { type: ZONE, zoneKind: 'Gust', deflect: true, deflectWindowS: 1.2, movesZones: true, knockdown: true, school: 'Gale' }, // Gust Wall
  34: { // Quake — area damage + interrupt + destroy cover
    type: PROJECTILE, damage: 10, interrupt: true, knockdown: true, destroysCover: true, status: null, charges: 1,
    travelS: 0.2, homing: 0, dodgeRadius: 0.5, area: true, school: 'Stone', reflectable: false,
    quake: true,
  },
  35: { type: ZONE, zoneKind: 'Fog', school: 'Gale' }, // Fog Cloud
  36: { type: ZONE, zoneKind: 'Snare', school: 'Arcane' }, // Rune Snare

  // === Secret (4) ==========================================================
  37: { type: MIRROR, durationS: 12, charges: 2, school: 'Arcane' }, // Mirror Twin
  38: { type: ZONE, zoneKind: 'Hourglass', charges: 2, school: 'Arcane' }, // Hourglass Field
  39: { type: PHOENIX, durationS: 15, charges: 3, school: 'Ember' }, // Phoenix Covenant
  40: { // Prismatic Beam — immobile channel; mixed-resonance utility
    type: CHANNEL, totalDamage: 28, durationS: 2, charges: 2, school: 'Prismatic',
  },
};

export function effectFor(spellId) {
  return SPELL_EFFECTS[spellId] || null;
}

// A "heavy" projectile blows straight through a Gust Wall (Stone Shard, the
// charge-cost heavies, and wide area shots). Light single-target bolts are the
// ones a Gust Wall can deflect (SOLO-MODES-PLAN §9 Lesson 10; spells.csv Gust
// Wall counters "Stone Shard; heavy projectile"). Derived from effect shape so
// no per-spell flag can drift: charged, piercing, or area shots are heavy.
export function isHeavyProjectile(eff) {
  if (!eff || eff.type !== PROJECTILE) return false;
  return !!eff.heavy || !!eff.area || !!eff.piercing || (eff.charges || 0) >= 1;
}

// A light projectile is any non-heavy travelling shot — the class a Gust Wall
// deflects. Kept as its own predicate so callers read clearly.
export function isLightProjectile(eff) {
  return !!eff && eff.type === PROJECTILE && !isHeavyProjectile(eff);
}

// Broad category of an effect for bot reasoning / HUD grouping.
export function categoryOf(eff) {
  if (!eff) return 'none';
  switch (eff.type) {
    case PROJECTILE: return eff.interrupt || eff.knockback || eff.conditionalStun ? 'control' : 'offense';
    case CHANNEL: return 'offense';
    case SHIELD: case BARRIER: case REFLECT: case BLINK: case DISPEL: case PHOENIX: return 'defense';
    case BUFF: return 'buff';
    case HEX: return eff.conditionalControl || (eff.status && ['Rooted', 'Frozen', 'Stunned'].includes(eff.status.name))
      ? 'control' : 'debuff';
    case ZONE: return 'zone';
    case MIRROR: return 'defense';
    default: return 'other';
  }
}

// Every roster id must have an authored effect (Phase 2 invariant).
export function everySpellHasEffect(ids) {
  return ids.every((id) => !!SPELL_EFFECTS[id]);
}
