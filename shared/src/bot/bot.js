// bot.js — deterministic rule-based duel bot.
//
// The bot uses the SAME intents and resource rules a human uses (MASTERPLAN
// §15). It never touches Math.random; it takes a seeded rng so a match replays
// identically. Difficulty changes decision quality and reaction time, not
// hidden stats. Phase 2 lets the bot pilot ANY legal loadout and reason (at
// least basically) about setup requirements, resources, zones, defense, and
// counters. The four internal levels are kept until the final solo phase.

import { makeRng } from '../rng/rng.js';
import {
  effectFor, categoryOf,
  REFLECT, SHIELD, BARRIER, BLINK, DISPEL, CHANNEL,
} from '../sim/spellEffects.js';
import { TICK_HZ, SIGIL } from '../sim/constants.js';

export const DIFFICULTY = {
  apprentice: { reactionTicks: 30, aggression: 0.6, defends: 0.25, focusBias: 0.2, dodge: 0.4, planning: 0 },
  adept:      { reactionTicks: 18, aggression: 0.75, defends: 0.55, focusBias: 0.35, dodge: 0.65, planning: 1 },
  magus:      { reactionTicks: 10, aggression: 0.85, defends: 0.8, focusBias: 0.5, dodge: 0.8, planning: 2 },
  archmage:   { reactionTicks: 6, aggression: 0.9, defends: 0.95, focusBias: 0.6, dodge: 0.95, planning: 3 },
};

export class DuelBot {
  constructor(playerId, opts = {}) {
    this.id = playerId;
    const diff = typeof opts.difficulty === 'string' ? opts.difficulty : 'apprentice';
    this.profile = { ...(DIFFICULTY[diff] || DIFFICULTY.apprentice), ...(opts.overrides || {}) };
    this.difficulty = diff;
    this.rng = opts.rng || makeRng(((opts.seed ?? 1) ^ (playerId * 0x9e3779b9)) >>> 0);
    this.lastDecisionTick = -999;
    this.moveDir = playerId === 0 ? 1 : -1;
    this.nextStrafeFlip = 0;
  }

  // Group the equipped spells by broad role once we can see the loadout.
  categorize(sim) {
    const w = sim.wizards[this.id];
    const buckets = { offense: [], control: [], debuff: [], buff: [], zone: [], defense: [], damage: [] };
    for (const s of w.loadout) {
      const eff = effectFor(s.id);
      if (!eff) continue;
      const cat = categoryOf(eff);
      if (buckets[cat]) buckets[cat].push(s);
      if ((eff.damage || 0) > 0 || eff.type === CHANNEL) buckets.damage.push(s);
    }
    buckets.offense.sort((a, b) => a.aether - b.aether);
    buckets.damage.sort((a, b) => a.aether - b.aether);
    return buckets;
  }

  incomingThreat(sim) {
    return sim.projectiles
      .filter((p) => p.owner !== this.id)
      .sort((a, b) => a.ticks - b.ticks)[0];
  }

  canCast(sim, w, spell) {
    if ((w.cooldowns[spell.id] || 0) > 0) return false;
    if (w.aether < spell.aether) return false;
    if ((spell.charges || 0) > w.charges) return false;
    return true;
  }

  has(list, id) { return list.find((s) => s.id === id); }

  // Largest Sigil-Charge cost in the loadout — the target charge stock.
  maxChargeNeed(w) {
    let need = 0;
    for (const s of w.loadout) need = Math.max(need, s.charges || 0);
    return Math.min(SIGIL.max, need);
  }

  act(sim) {
    const w = sim.wizards[this.id];
    const o = sim.opponentOf(this.id);
    const intent = {};
    if (!sim.canAct(w) || w.casting || w.focusing || w.channel) {
      return intent; // committed / controlled — no new action
    }

    // Strafing / dodging so the bot is a moving target and can dodge.
    if (sim.tick >= this.nextStrafeFlip) {
      this.moveDir *= -1;
      this.nextStrafeFlip = sim.tick + this.rng.int(18, 42);
    }
    intent.move = this.moveDir;

    const threat = this.incomingThreat(sim);
    const b = this.categorize(sim);
    const plan = this.profile.planning;

    // --- 1. Reactive defense to an incoming projectile ---------------------
    if (threat && this.rng.next() < this.profile.defends) {
      const reflect = b.defense.find((s) => effectFor(s.id).type === REFLECT && this.canCast(sim, w, s));
      const ward = b.defense.find((s) => effectFor(s.id).type === SHIELD && this.canCast(sim, w, s));
      const blink = b.defense.find((s) => effectFor(s.id).type === BLINK && this.canCast(sim, w, s));
      const barrier = b.defense.find((s) => effectFor(s.id).type === BARRIER && this.canCast(sim, w, s));
      if (reflect && threat.ticks <= Math.round(0.25 * TICK_HZ) && effectFor(threat.spellId).reflectable) {
        return { ...intent, cast: reflect.id, castQuality: 1 };
      }
      if (ward && threat.ticks <= Math.round(0.5 * TICK_HZ)) {
        return { ...intent, cast: ward.id, castQuality: 1 };
      }
      if (barrier && w.health < 45 && threat.ticks <= Math.round(0.5 * TICK_HZ)) {
        return { ...intent, cast: barrier.id, castQuality: 1 };
      }
      if (blink && plan >= 2 && threat.ticks <= Math.round(0.3 * TICK_HZ)) {
        return { ...intent, cast: blink.id, castQuality: 1 };
      }
      if (w.sidestepCharges > 0 && this.rng.next() < this.profile.dodge) {
        intent.sidestep = this.moveDir;
      }
    }

    // --- 2. Cleanse a meaningful debuff (adept+) ---------------------------
    if (plan >= 1) {
      const dispel = b.defense.find((s) => effectFor(s.id).type === DISPEL && this.canCast(sim, w, s));
      const bad = ['Frozen', 'Rooted', 'Sundered', 'Chilled', 'Marked', 'Sloth'].some((n) => sim.hasStatus(w, n));
      if (dispel && bad && this.rng.next() < 0.6) {
        return { ...intent, cast: dispel.id, castQuality: 1 };
      }
    }

    // Reaction gate: only pick a new proactive action every reactionTicks.
    if (sim.tick - this.lastDecisionTick < this.profile.reactionTicks) return intent;
    this.lastDecisionTick = sim.tick;

    // --- 3. Grounding vs a lightning threat (magus+) ----------------------
    if (plan >= 2) {
      const grounding = this.has(w.loadout, 20);
      const oppStorm = o.loadout.some((s) => s.school === 'Storm');
      if (grounding && oppStorm && !sim.hasStatus(w, 'Grounded') && this.canCast(sim, w, grounding) && this.rng.next() < 0.4) {
        return { ...intent, move: 0, cast: 20, castQuality: 1 };
      }
    }

    // --- 4. Finish a primed setup (magus+) --------------------------------
    if (plan >= 2) {
      const frostBind = this.has(w.loadout, 27);
      if (frostBind && sim.hasStatus(o, 'Chilled') && this.canCast(sim, w, frostBind)) {
        return { ...intent, cast: 27, castQuality: 1 };
      }
      const primedStun = sim.hasStatus(o, 'Soaked') || sim.statusStacks(o, 'Static') >= 3;
      const thunder = this.has(w.loadout, 30) || this.has(w.loadout, 7);
      if (thunder && primedStun && this.canCast(sim, w, thunder)) {
        return { ...intent, cast: thunder.id, castQuality: 1 };
      }
      // Consume our own Mark on the opponent with a hard hitter.
      if (sim.hasStatus(o, 'Marked')) {
        const hitter = b.damage.find((s) => this.canCast(sim, w, s));
        if (hitter) return { ...intent, cast: hitter.id, castQuality: 1 };
      }
    }

    // --- 5. Apply the setup for an available payoff (magus+) --------------
    if (plan >= 2 && this.rng.next() < 0.5) {
      if (this.has(w.loadout, 27) && !sim.hasStatus(o, 'Chilled')) {
        const chiller = [2, 9].map((id) => this.has(w.loadout, id)).find((s) => s && this.canCast(sim, w, s));
        if (chiller) return { ...intent, cast: chiller.id, castQuality: 1 };
      }
      if ((this.has(w.loadout, 30) || this.has(w.loadout, 7)) && sim.statusStacks(o, 'Static') < 3) {
        const spark = this.has(w.loadout, 3);
        if (spark && this.canCast(sim, w, spark)) return { ...intent, cast: 3, castQuality: 1 };
      }
    }

    // --- 6. Mark then commit (adept+) -------------------------------------
    if (plan >= 1) {
      const amplify = this.has(w.loadout, 18);
      if (amplify && !sim.hasStatus(o, 'Marked') && this.canCast(sim, w, amplify) && this.rng.next() < 0.4) {
        return { ...intent, cast: 18, castQuality: 1 };
      }
    }

    // --- 7. Situational buffs (adept+) ------------------------------------
    if (plan >= 1) {
      const haste = this.has(w.loadout, 16);
      if (haste && sim.hasStatus(w, 'Chilled') && this.canCast(sim, w, haste)) {
        return { ...intent, cast: 16, castQuality: 1 };
      }
      const surge = this.has(w.loadout, 17);
      if (surge && !threat && w.aether < 35 && this.canCast(sim, w, surge) && o.casting == null && this.rng.next() < 0.3) {
        return { ...intent, move: 0, cast: 17, castQuality: 1 };
      }
    }

    // --- 8. Zone play: place then exploit (magus+) ------------------------
    if (plan >= 2 && this.rng.next() < 0.35) {
      const haveOilZone = sim.zonesOfKind('Oil').length > 0;
      const oil = this.has(w.loadout, 31);
      const ember = b.damage.find((s) => s.school === 'Ember' && this.canCast(sim, w, s));
      if (haveOilZone && ember) return { ...intent, cast: ember.id, castQuality: 1 }; // ignite
      if (oil && !haveOilZone && ember && this.canCast(sim, w, oil)) return { ...intent, cast: 31, castQuality: 1 };
      const rain = this.has(w.loadout, 32);
      const wantsWet = this.has(w.loadout, 3) || this.has(w.loadout, 7) || this.has(w.loadout, 30);
      if (rain && wantsWet && sim.zonesOfKind('Wet').length === 0 && this.canCast(sim, w, rain)) {
        return { ...intent, cast: 32, castQuality: 1 };
      }
    }

    // --- 9. Build a Sigil Charge when safe --------------------------------
    const need = this.maxChargeNeed(w);
    if (!threat && need > 0 && w.charges < need && this.rng.next() < this.profile.focusBias && o.casting == null) {
      return { ...intent, move: 0, focus: true };
    }

    // --- 10. Default offensive pressure -----------------------------------
    if (this.rng.next() < this.profile.aggression) {
      const pick = (b.offense.find((s) => this.canCast(sim, w, s))
        || b.damage.find((s) => this.canCast(sim, w, s))
        || b.control.find((s) => this.canCast(sim, w, s))
        || b.debuff.find((s) => this.canCast(sim, w, s)));
      if (pick) {
        const quality = 0.95 + this.rng.next() * 0.1; // 0.95..1.05
        return { ...intent, cast: pick.id, castQuality: Math.min(1.05, quality) };
      }
    }

    return intent;
  }
}

export function makeBots(seed, diff0 = 'apprentice', diff1 = 'apprentice') {
  return [
    new DuelBot(0, { difficulty: diff0, rng: makeRng((seed ^ 0xA5A5) >>> 0) }),
    new DuelBot(1, { difficulty: diff1, rng: makeRng((seed ^ 0x5A5A) >>> 0) }),
  ];
}
