// practiceBot.js — the fair single-player Practice AI (SOLO-MODES-PLAN §13-19).
//
// Easy / Medium / Hard. All three drive the SAME Sim through the SAME legal
// intent path a human uses, spend the SAME resources, and obey the SAME
// cooldowns, charges, Tenacity, zone limits, loadout rules, and gesture
// execution. Difficulty NEVER grants stats, hidden information, instant
// reactions, perfect gestures, or illegal loadouts. Tiers differ only by:
//
//   - perception delay (non-zero at every tier),
//   - planning horizon / depth,
//   - combo + counter knowledge (data-gated in ./combos.js),
//   - legal loadout construction,
//   - adaptation from OBSERVED public events only,
//   - intentional (plausible) mistakes,
//   - gesture-execution modelling (a sampled score → shared potency mapping, or
//     a below-threshold miss that receives the same reject recovery as a human).
//
// Deterministic: the bot only ever reads its seeded rng (never Math.random), so a
// seed replays a Practice round identically.

import { makeRng } from '../rng/rng.js';
import {
  effectFor, categoryOf, isHeavyProjectile,
  REFLECT, SHIELD, BARRIER, BLINK, DISPEL, CHANNEL, PROJECTILE,
} from '../sim/spellEffects.js';
import { TICK_HZ, SIGIL } from '../sim/constants.js';
import { SPELLS_BY_ID } from '../balance/spellData.generated.js';
import {
  PRESETS, PRESETS_BY_KEY, validateLoadout, hasDefensiveAnswer, LOADOUT,
} from '../balance/loadouts.js';
import {
  combosForTier, knowsCounter, COUNTER_SPELLS_FOR_SCHOOL,
  CONTROL_SPELL_IDS, STORM_SPELL_IDS,
} from './combos.js';
import { qualityFromScore, ACCEPT_THRESHOLD } from '../gesture/quality.js';

const ms2ticks = (ms) => Math.max(1, Math.round((ms / 1000) * TICK_HZ));

// The four public practice difficulties. perceptionMs/replanMs/horizonMs and the
// score distribution come straight from the §14 profile table; aggression/defends/
// dodge/focusBias are DECISION likelihoods (how often the bot chooses to act), not
// combat stats. flubRate is a floor gross-miss chance so Medium/Hard keep a small
// but non-zero gesture-miss rate the score tail alone would not produce.
export const PRACTICE_PROFILES = {
  'very-easy': {
    key: 'very-easy', label: 'Very Easy',
    perceptionMs: 700, replanMs: 1000, horizonMs: 0,
    scoreMean: 0.60, scoreSpread: 0.14, flubRate: 0.08, mistakeRate: 0.35,
    counter: 'basic', combo: 'one-step', adapt: 'none', loadout: 'beginner',
    aggression: 0.40, defends: 0.20, dodge: 0.12, focusBias: 0.15,
    defenseReserve: 0, staminaReserve: 0, staminaRecoveryStart: 0, staminaRecoveryTarget: 0,
    moveChance: 0.25, castIntervalMs: 10000,
  },
  easy: {
    key: 'easy', label: 'Easy',
    perceptionMs: 450, replanMs: 500, horizonMs: 0,
    scoreMean: 0.68, scoreSpread: 0.12, flubRate: 0.03, mistakeRate: 0.22,
    counter: 'basic', combo: 'one-step', adapt: 'none', loadout: 'beginner',
    aggression: 0.55, defends: 0.35, dodge: 0.45, focusBias: 0.25,
    defenseReserve: 0, staminaReserve: 0, staminaRecoveryStart: 0, staminaRecoveryTarget: 0,
    moveChance: 1, castIntervalMs: 0,
  },
  medium: {
    key: 'medium', label: 'Medium',
    perceptionMs: 280, replanMs: 267, horizonMs: 1000,
    scoreMean: 0.82, scoreSpread: 0.08, flubRate: 0.06, mistakeRate: 0.10,
    counter: 'common', combo: 'two-step', adapt: 'cast-frequency', loadout: 'soft-counter',
    aggression: 0.72, defends: 0.65, dodge: 0.70, focusBias: 0.40,
    defenseReserve: 0.4, staminaReserve: 5, staminaRecoveryStart: 35, staminaRecoveryTarget: 50,
    moveChance: 1, castIntervalMs: 0,
  },
  hard: {
    key: 'hard', label: 'Hard',
    perceptionMs: 150, replanMs: 133, horizonMs: 2500,
    scoreMean: 0.98, scoreSpread: 0.03, flubRate: 0.01, mistakeRate: 0.01,
    counter: 'complete', combo: 'expert', adapt: 'timing-school', loadout: 'counter-build',
    aggression: 1.00, defends: 0.80, dodge: 0.85, focusBias: 0.30,
    defenseReserve: 0.3, staminaReserve: 25, staminaRecoveryStart: 45, staminaRecoveryTarget: 60,
    moveChance: 0.65, castIntervalMs: 0,
  },
};

export const PRACTICE_DIFFICULTIES = ['very-easy', 'easy', 'medium', 'hard'];

// Beginner-safe archetypes Easy may pick from WITHOUT inspecting the player.
export const BEGINNER_PRESET_KEYS = ['ember-rush', 'stone-warden', 'tide-control'];

// -------------------------------------------------------------- loadout policy
function analyzePlayer(playerIds) {
  const schools = {};
  let control = 0, storm = 0;
  for (const id of playerIds || []) {
    const s = SPELLS_BY_ID[id];
    if (s?.school) schools[s.school] = (schools[s.school] || 0) + 1;
    if (CONTROL_SPELL_IDS.has(id)) control += 1;
    if (STORM_SPELL_IDS.has(id)) storm += 1;
  }
  const mainSchools = Object.entries(schools).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return { schools, mainSchools, usesControl: control > 0, stormHeavy: storm >= 2 };
}

// Score a curated preset by how well its equipped spells answer the player's
// visible school distribution (§18 Medium soft-counter selection).
function scorePresetAgainst(ids, analysis) {
  const set = new Set(ids);
  let score = 0;
  for (const [school, count] of Object.entries(analysis.schools)) {
    for (const answer of (COUNTER_SPELLS_FOR_SCHOOL[school] || [])) {
      if (set.has(answer)) score += count;
    }
  }
  if (hasDefensiveAnswer(ids)) score += 1;
  return score;
}

// Highest-scoring LEGAL curated preset against the player, seeded tie-break.
export function bestPresetAgainst(playerIds, rng) {
  const analysis = analyzePlayer(playerIds);
  let best = null, bestScore = -Infinity;
  for (const p of PRESETS) {
    if (!validateLoadout(p.ids).valid) continue;
    const score = scorePresetAgainst(p.ids, analysis);
    if (score > bestScore || (score === bestScore && rng.next() < 0.5)) { bestScore = score; best = p; }
  }
  return (best || PRESETS[0]).ids.slice();
}

// Easy: random beginner-safe preset, no inspection of the player build.
export function beginnerLoadout(rng) {
  const key = BEGINNER_PRESET_KEYS[rng.int(0, BEGINNER_PRESET_KEYS.length - 1)];
  return (PRESETS_BY_KEY[key] || PRESETS[0]).ids.slice();
}

// Constraint-aware greedy add: only keep a candidate if the build stays legal.
function tryAdd(state, id) {
  const s = SPELLS_BY_ID[id];
  if (!s || state.chosen.includes(id) || state.chosen.length >= LOADOUT.size) return false;
  const pts = s.loadout_points || 0;
  const heavy = pts >= 3;
  const sc = s.school;
  if (state.points + pts > LOADOUT.pointBudget) return false;
  if (heavy && state.heavy >= LOADOUT.maxHeavy) return false;
  if (sc && (state.schools[sc] || 0) >= LOADOUT.maxPerSchool) return false;
  state.chosen.push(id);
  state.points += pts;
  if (heavy) state.heavy += 1;
  if (sc) state.schools[sc] = (state.schools[sc] || 0) + 1;
  return true;
}

// Hard: a bounded, deterministic legal counter-build (§18). Prioritises answers
// to the player's build, always constraint-checked, then validates. Returns null
// if it cannot assemble a legal eight — the caller then falls back to a preset.
export function counterBuild(playerIds, rng) {
  const analysis = analyzePlayer(playerIds);
  const state = { chosen: [], points: 0, heavy: 0, schools: {} };

  // Priority pool: role-ordered and school-diverse so the greedy stays legal.
  const priority = [10]; // Ward — a defensive answer, always
  if (analysis.stormHeavy) priority.push(20);          // Grounding vs heavy Storm
  priority.push(13);                                    // Dispel — cleanse
  if (analysis.usesControl) priority.push(14);          // Blink — mobility vs control
  priority.push(2, 27);                                 // Frost Lance → Frost Bind (setup→payoff)
  const main = analysis.mainSchools[0];
  if (main === 'Ember') priority.push(32);              // Rain douses Ember
  if (main === 'Storm' && !analysis.stormHeavy) priority.push(20);
  // Diverse legal pressure + secondary answers to finish the eight.
  priority.push(1, 3, 4, 22, 28, 18, 5, 6, 15, 11, 16, 21, 26);

  for (const id of priority) { if (state.chosen.length >= LOADOUT.size) break; tryAdd(state, id); }
  // Pad from a broad legal filler list if short.
  if (state.chosen.length < LOADOUT.size) {
    for (const id of [1, 2, 3, 4, 10, 13, 14, 22, 28, 32, 15, 16, 20, 21, 5, 6, 11, 26, 23, 24]) {
      if (state.chosen.length >= LOADOUT.size) break;
      tryAdd(state, id);
    }
  }
  const v = validateLoadout(state.chosen);
  return (v.valid && state.chosen.length === LOADOUT.size) ? state.chosen.slice() : null;
}

// The single entry point the client/tests use to choose a legal opponent loadout
// for a given difficulty and (visible) player build. ALWAYS returns a legal set.
export function chooseOpponentLoadout(difficulty, playerIds, seedOrRng = 1) {
  const rng = (seedOrRng && typeof seedOrRng.next === 'function') ? seedOrRng : makeRng((seedOrRng >>> 0) || 1);
  let ids;
  if (difficulty === 'very-easy' || difficulty === 'easy') ids = beginnerLoadout(rng);
  else if (difficulty === 'medium') ids = bestPresetAgainst(playerIds, rng);
  else ids = counterBuild(playerIds, rng) || bestPresetAgainst(playerIds, rng);
  // Final safety net: never emit an illegal loadout.
  if (!validateLoadout(ids).valid) ids = PRESETS_BY_KEY['ember-rush'].ids.slice();
  return ids;
}

// ------------------------------------------------------------------ the bot
export class PracticeBot {
  constructor(playerId, opts = {}) {
    this.id = playerId;
    const key = PRACTICE_DIFFICULTIES.includes(opts.difficulty) ? opts.difficulty : 'medium';
    this.difficulty = key;
    this.profile = { ...PRACTICE_PROFILES[key], ...(opts.overrides || {}) };
    this.rng = opts.rng || makeRng(((opts.seed ?? 1) ^ (playerId * 0x9e3779b9)) >>> 0);

    this.perceptionTicks = ms2ticks(this.profile.perceptionMs);
    this.replanTicks = ms2ticks(this.profile.replanMs);
    this.castIntervalTicks = Math.max(0, Math.round((this.profile.castIntervalMs / 1000) * TICK_HZ));
    this.planLevel = this.profile.horizonMs === 0 ? 0 : (this.profile.horizonMs <= 1200 ? 1 : 2);
    this.combos = combosForTier(this.profile.combo);
    this.counter = this.profile.counter;

    this.lastPlanTick = -999;
    this.recoveringStamina = false;
    this.nextCastTick = 0;
    this.currentTick = 0;
    this.moveDir = playerId === 0 ? 1 : -1;
    this.nextStrafeFlip = 0;

    // Perception ledgers (§15): a threat is only actionable at/after its notice
    // tick, never the tick it appears.
    this.seenProjectiles = new Map();  // projId -> notice tick
    this.castTell = null;              // { spellId, noticeTick } for the current windup
    this._prevOppCasting = null;
    // Observed-action memory (§17 adaptation), from public events only.
    this.memory = { casts: 0, schoolCounts: {}, spellCounts: {}, lastCastTick: null, intervals: [] };
  }

  // -------------------------------------------------------------- perception
  observe(sim) {
    const self = sim.wizards[this.id];
    if (sim.hasStatus(self, 'Blinded')) {
      this.seenProjectiles.clear();
      this.castTell = null;
      this._prevOppCasting = null;
      return;
    }
    const opp = sim.opponentOf(this.id);
    if (opp.invisibleTicks > 0) {
      this.seenProjectiles.clear();
      this.castTell = null;
      this._prevOppCasting = null;
      return;
    }
    for (const p of sim.projectiles) {
      if (p.owner === this.id) continue;
      if (!this.seenProjectiles.has(p.id)) this.seenProjectiles.set(p.id, sim.tick + this.perceptionTicks);
    }
    for (const id of [...this.seenProjectiles.keys()]) {
      if (!sim.projectiles.some((p) => p.id === id)) this.seenProjectiles.delete(id);
    }
    const nowCasting = opp.casting ? opp.casting.spellId : null;
    if (nowCasting != null && this._prevOppCasting == null) {
      // A new opponent windup began — record its tell (perceived after the delay)
      // and update observed cast memory (public event; adaptation, not reaction).
      this.castTell = { spellId: nowCasting, noticeTick: sim.tick + this.perceptionTicks };
      const school = SPELLS_BY_ID[nowCasting]?.school;
      this.memory.casts += 1;
      if (school) this.memory.schoolCounts[school] = (this.memory.schoolCounts[school] || 0) + 1;
      this.memory.spellCounts[nowCasting] = (this.memory.spellCounts[nowCasting] || 0) + 1;
      if (this.memory.lastCastTick != null) this.memory.intervals.push(sim.tick - this.memory.lastCastTick);
      this.memory.lastCastTick = sim.tick;
    } else if (nowCasting == null) {
      this.castTell = null;
    }
    this._prevOppCasting = nowCasting;
  }

  perceivedCast(sim) {
    if (!this.castTell || sim.tick < this.castTell.noticeTick) return null;
    const opp = sim.opponentOf(this.id);
    if (!opp.casting || opp.casting.spellId !== this.castTell.spellId) return null;
    return {
      spellId: this.castTell.spellId,
      school: SPELLS_BY_ID[this.castTell.spellId]?.school || null,
    };
  }

  // Nearest NOTICED incoming projectile (or null while still within the delay).
  noticedThreat(sim) {
    let best = null;
    for (const p of sim.projectiles) {
      if (p.owner === this.id) continue;
      const notice = this.seenProjectiles.get(p.id);
      if (notice == null || sim.tick < notice) continue;
      if (!best || p.ticks < best.ticks) best = p;
    }
    return best;
  }

  favouredSchool() {
    let top = null, n = -1;
    for (const [s, c] of Object.entries(this.memory.schoolCounts)) if (c > n) { n = c; top = s; }
    return top;
  }

  anticipatesCast(sim) {
    if (this.profile.adapt !== 'timing-school' || this.memory.intervals.length < 2
      || this.memory.lastCastTick == null) return false;
    const recent = this.memory.intervals.slice(-4);
    const average = recent.reduce((sum, n) => sum + n, 0) / recent.length;
    return sim.tick - this.memory.lastCastTick >= Math.max(1, average - this.perceptionTicks);
  }

  _adaptiveResponse(sim, w, intent) {
    if (this.profile.adapt === 'none') return null;
    const perceived = this.perceivedCast(sim);
    const favoured = this.memory.casts >= 2 ? this.favouredSchool() : null;
    const school = perceived?.school || favoured;
    if (!school) return null;

    if (school === 'Storm') {
      const grounding = this.has(w.loadout, 20);
      if (grounding && !sim.hasStatus(w, 'Grounded') && this.canCast(sim, w, grounding)) {
        return this._commitCast(20, { ...intent, move: 0 });
      }
    }
    if (this.profile.adapt === 'timing-school' && school === 'Ember') {
      const rain = this.has(w.loadout, 32);
      if (rain && sim.zonesOfKind('Wet').length === 0 && this.canCast(sim, w, rain)) {
        return this._commitCast(32, { ...intent, move: 0 });
      }
    }
    if (this.profile.adapt === 'timing-school' && school === 'Tide') {
      const haste = this.has(w.loadout, 16);
      if (haste && this.canCast(sim, w, haste)) return this._commitCast(16, intent);
    }
    return null;
  }

  // -------------------------------------------------------- gesture execution
  _gaussian() {
    const r = this.rng;
    return (r.next() + r.next() + r.next() + r.next() - 2) / 0.5773502691896258;
  }

  // Sample this cast's gesture. A gross flub or a below-threshold score is a
  // rejected cast; otherwise the score maps through the SHARED potency function.
  _sampleGesture() {
    const p = this.profile;
    if (this.rng.next() < p.flubRate) return { rejected: true };
    let score = p.scoreMean + this._gaussian() * p.scoreSpread;
    score = Math.max(0.3, Math.min(1.05, score));
    if (score < ACCEPT_THRESHOLD) return { rejected: true };
    return { rejected: false, quality: qualityFromScore(score) };
  }

  // Route EVERY committed cast through gesture execution so misses are possible
  // at every tier and accepted casts use the identical potency mapping (§16).
  _commitCast(spellId, base = {}) {
    if (this.castIntervalTicks > 0 && this.currentTick < this.nextCastTick) return base;
    const g = this._sampleGesture();
    if (g.rejected) return { ...base, castReject: spellId };
    if (this.castIntervalTicks > 0) this.nextCastTick = this.currentTick + this.castIntervalTicks;
    return { ...base, cast: spellId, castQuality: g.quality };
  }

  // ------------------------------------------------------------ legal helpers
  canCast(sim, w, spell) {
    if ((w.cooldowns[spell.id] || 0) > 0) return false;
    if (w.aether < spell.aether) return false;
    if ((spell.charges || 0) > w.charges) return false;
    return true;
  }

  has(list, id) { return list.find((s) => s.id === id); }
  spellById(w, id) { return w.loadout.find((s) => s.id === id); }

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

  maxChargeNeed(w) {
    let need = 0;
    for (const s of w.loadout) need = Math.max(need, s.charges || 0);
    return Math.min(SIGIL.max, need);
  }

  // --------------------------------------------------------------- combo plays
  _isPrimed(sim, o, c) {
    if (c.setupStatusOnOpp) {
      if (c.setupStacks) return sim.statusStacks(o, c.setupStatusOnOpp) >= c.setupStacks;
      return sim.hasStatus(o, c.setupStatusOnOpp);
    }
    if (c.setupZone) return sim.zonesOfKind(c.setupZone).length > 0;
    return false;
  }

  _payoff(sim, w, o) {
    for (const c of this.combos) {
      if (!c.payoffSpells || !this._isPrimed(sim, o, c)) continue;
      for (const id of c.payoffSpells) {
        const s = this.has(w.loadout, id);
        if (s && this.canCast(sim, w, s)) return id;
      }
    }
    return null;
  }

  _setup(sim, w, o) {
    for (const c of this.combos) {
      if (this._isPrimed(sim, o, c)) continue;
      const havePayoff = c.payoffSpells && c.payoffSpells.some((id) => this.has(w.loadout, id));
      if (!havePayoff) continue;
      for (const id of (c.setupSpells || [])) {
        const s = this.has(w.loadout, id);
        if (s && this.canCast(sim, w, s)) return id;
      }
    }
    return null;
  }

  // ----------------------------------------------------------- reactive defense
  _defend(sim, w, o, b, threat, intent, mistake) {
    const heavy = isHeavyProjectile(threat.eff);
    // Plausible mistake: waste a defensive answer on a feint / dodge the wrong way.
    const mistakeDodgeChance = this.difficulty === 'very-easy' ? this.profile.dodge * 0.5 : 0.5;
    if (mistake && w.sidestepCharges > 0 && this.rng.next() < mistakeDodgeChance) {
      return { ...intent, sidestep: this.moveDir };
    }
    const near = threat.ticks <= Math.round(0.5 * TICK_HZ);
    if (knowsCounter(this.counter, 'reflect') && !heavy && threat.eff.reflectable) {
      const reflect = b.defense.find((s) => effectFor(s.id).type === REFLECT && this.canCast(sim, w, s));
      if (reflect && threat.ticks <= Math.round(0.25 * TICK_HZ)) return this._commitCast(reflect.id, intent);
    }
    if (knowsCounter(this.counter, 'gust') && !heavy && threat.ticks > Math.round(0.6 * TICK_HZ)) {
      const gust = this.has(w.loadout, 33);
      if (gust && w.deflectTicks <= 0 && this.canCast(sim, w, gust) && this.rng.next() < 0.5) return this._commitCast(33, intent);
    }
    if (this.rng.next() < this.profile.defends) {
      const ward = b.defense.find((s) => effectFor(s.id).type === SHIELD && this.canCast(sim, w, s));
      if (ward && near) return this._commitCast(ward.id, intent);
      if (knowsCounter(this.counter, 'barrier') && heavy) {
        const barrier = b.defense.find((s) => effectFor(s.id).type === BARRIER && this.canCast(sim, w, s));
        if (barrier && near && (w.health < 55 || heavy)) return this._commitCast(barrier.id, intent);
      }
      if (knowsCounter(this.counter, 'blink') && this.planLevel >= 1) {
        const blink = b.defense.find((s) => effectFor(s.id).type === BLINK && this.canCast(sim, w, s));
        if (blink && threat.ticks <= Math.round(0.3 * TICK_HZ)) return this._commitCast(blink.id, intent);
      }
    }
    if (w.sidestepCharges > 0 && threat.ticks <= 2 && this.rng.next() < this.profile.dodge) {
      return { ...intent, sidestep: (w.arcPos >= 0 ? -1 : 1) };
    }
    return null;
  }

  // --------------------------------------------------------------- environment
  _environment(sim, w, o, b) {
    if (knowsCounter(this.counter, 'environment')) {
      const gust = this.has(w.loadout, 33);
      const enemyFog = sim.zones.some((z) => z.kind === 'Fog' && z.owner === o.id && z.ticks > 0);
      if (gust && enemyFog && this.canCast(sim, w, gust)) return 33;
    }
    return null;
  }

  // ---------------------------------------------------------------- offense
  _offense(sim, w, b, mistake) {
    const offense = b.offense.filter((s) => this.canCast(sim, w, s));
    const damage = b.damage.filter((s) => this.canCast(sim, w, s));
    const control = b.control.filter((s) => this.canCast(sim, w, s));
    const debuff = b.debuff.filter((s) => this.canCast(sim, w, s));
    if (mistake) {
      const cheap = [...offense, ...damage].sort((a, b2) => a.aether - b2.aether)[0];
      if (cheap && this.rng.next() < 0.7) return cheap.id; // cheap poke instead of the best play
    }
    const pick = offense[0] || damage[0] || control[0] || debuff[0];
    if (pick && this.rng.next() < this.profile.aggression) return pick.id;
    return null;
  }

  // Keep a defensive Aether reserve SOME of the time (§17 Medium/Hard). Returns
  // true if the bot should hold this turn rather than spend into the reserve.
  _respectReserve(sim, w, spellId) {
    if (this.profile.defenseReserve <= 0) return false;
    const s = this.spellById(w, spellId);
    if (!s) return false;
    const def = w.loadout
      .filter((x) => categoryOf(effectFor(x.id)) === 'defense')
      .sort((a, b) => a.aether - b.aether)[0];
    const reserve = def ? def.aether : 15;
    if ((w.aether - s.aether) < reserve && this.rng.next() < this.profile.defenseReserve) return true;
    return false;
  }

  _cleanseUrgency(w) {
    const weights = {
      Burning: 6,
      Blinded: 5,
      KnockedDown: 5,
      Rooted: 4,
      Sundered: 4,
      Marked: 4,
      Weakened: 3,
      Sloth: 3,
      Chilled: 2.5,
      Soaked: 2.5,
      Static: 2,
      Veiled: 2,
      Wet: 1,
    };
    let score = 0;
    let count = 0;
    let burning = false;
    for (const [name, status] of Object.entries(w.statuses || {})) {
      const remainingS = (status?.ticks || 0) / TICK_HZ;
      const weight = weights[name] || 0;
      if (weight <= 0 || remainingS < 0.75) continue;
      count += 1;
      if (name === 'Burning') burning = true;
      const durationValue = Math.min(1, remainingS / 3);
      const stackValue = name === 'Burning' || name === 'Static'
        ? Math.max(1, status.stacks || 1)
        : 1;
      score += weight * durationValue + (stackValue - 1) * 1.5;
    }
    return { score, count, burning };
  }

  _shouldDispel(urgency) {
    if (!urgency.count) return false;
    if (this.difficulty === 'hard') return urgency.burning || urgency.score >= 4;
    if (this.difficulty === 'medium') return urgency.burning || urgency.score >= 5;
    if (this.difficulty === 'easy') return urgency.score >= 8 && this.rng.next() < 0.25;
    return urgency.score >= 10 && this.rng.next() < 0.1;
  }

  // ------------------------------------------------------------------- act
  act(sim) {
    if (sim.tick < this.currentTick) this.nextCastTick = 0;
    this.currentTick = sim.tick;
    this.observe(sim);
    const w = sim.wizards[this.id];
    const o = sim.opponentOf(this.id);
    const intent = {};
    if (!sim.canAct(w) || w.casting || w.channel || w.recoveryTicks > 0) return intent;

    if (sim.tick >= this.nextStrafeFlip) {
      this.moveDir *= -1;
      this.nextStrafeFlip = sim.tick + this.rng.int(18, 42);
    }
    const choosesMovement = this.profile.moveChance >= 1 || this.rng.next() < this.profile.moveChance;
    intent.move = w.stamina > this.profile.staminaReserve && choosesMovement ? this.moveDir : 0;

    const b = this.categorize(sim);
    const threat = this.noticedThreat(sim);
    const mistake = this.rng.next() < this.profile.mistakeRate;

    // React before committing to a long rest window.
    if (threat) {
      const decision = this._defend(sim, w, o, b, threat, intent, mistake);
      if (decision) return decision;
    }

    // Cleanse meaningful self-debuffs before committing to Focus, recovery, or
    // offense. Medium and Hard treat Burning as urgent while avoiding effects
    // that are already about to expire.
    if (knowsCounter(this.counter, 'cleanse')) {
      const dispel = b.defense.find((s) => effectFor(s.id).type === DISPEL && this.canCast(sim, w, s));
      const urgency = this._cleanseUrgency(w);
      if (dispel && this._shouldDispel(urgency)) return this._commitCast(dispel.id, intent);
      const haste = this.has(w.loadout, 16);
      if (haste && sim.hasStatus(w, 'Chilled') && this.canCast(sim, w, haste) && this.rng.next() < 0.5) {
        return this._commitCast(16, intent);
      }
    }

    if (sim.hasStatus(w, 'Blinded')) return intent;

    const recoveryStart = Math.max(this.profile.staminaReserve, this.profile.staminaRecoveryStart || 0);
    const recoveryTarget = Math.max(recoveryStart, this.profile.staminaRecoveryTarget || recoveryStart);
    if (!this.recoveringStamina && w.stamina <= recoveryStart) this.recoveringStamina = true;
    if (this.recoveringStamina && w.stamina >= recoveryTarget) this.recoveringStamina = false;
    if ((this.recoveringStamina || w.stamina <= this.profile.staminaReserve) && !threat) {
      intent.move = 0;
      const emergencyRest = w.stamina <= this.profile.staminaReserve;
      const protectedRest = (w.barrier && w.barrier.ticks > 0)
        || sim.zones.some((z) => z.kind === 'Cover' && z.owner === w.id && z.ticks > 0 && z.hp > 0);
      if (protectedRest) return intent;

      if (emergencyRest) {
        for (const name of ['Haste', 'Stone Wall', 'Barrier Dome']) {
          const recoverySpell = w.loadout.find((spell) => spell.name === name && this.canCast(sim, w, spell));
          if (recoverySpell) return this._commitCast(recoverySpell.id, intent);
        }
        return intent;
      }
      this.recoveringStamina = false;
      intent.move = choosesMovement ? this.moveDir : 0;
    }

    if (o.invisibleTicks > 0) {
      if (sim.tick - this.lastPlanTick < this.replanTicks) return intent;
      this.lastPlanTick = sim.tick;
      const blindShots = w.loadout.filter((spell) => {
        const effect = effectFor(spell.id);
        return effect && effect.type === PROJECTILE && this.canCast(sim, w, spell);
      });
      if (!blindShots.length) return intent;
      const shot = blindShots[this.rng.int(0, blindShots.length - 1)];
      return this._commitCast(shot.id, intent);
    }

    // Focus is a held action. Keep channeling unless a noticed threat caused a
    // defensive response above; returning a neutral intent would cancel it.
    if (w.focusing && !threat) return { focus: true };

    // Proactive-decision cadence gate (perception + replan).
    if (sim.tick - this.lastPlanTick < this.replanTicks) return intent;
    this.lastPlanTick = sim.tick;

    // 3. Adapt to perceived casts and repeated observed schools. Easy has no
    // adaptation; Medium uses cast frequency; Hard also anticipates timing.
    const adaptive = this._adaptiveResponse(sim, w, intent);
    if (adaptive) return adaptive;

    // 4. Cash in a primed setup (combo knowledge) — unless a mistake fumbles it.
    const payoff = this._payoff(sim, w, o);
    if (payoff && !(mistake && this.rng.next() < 0.5)) return this._commitCast(payoff, intent);

    // 5. Apply a setup for an owned payoff (planning horizon ≥ 1 exchange).
    if (this.planLevel >= 1) {
      const setup = this._setup(sim, w, o);
      if (setup && this.rng.next() < 0.6) return this._commitCast(setup, intent);
    }

    // 6. Environmental tempo (complete counter knowledge).
    const env = this._environment(sim, w, o, b);
    if (env != null) return this._commitCast(env, intent);

    // 7. Build a Sigil Charge when safe (a bad-timed Focus is a plausible mistake).
    const need = this.maxChargeNeed(w);
    const safeToFocus = !threat && !this.perceivedCast(sim) && !this.anticipatesCast(sim);
    if (need > 0 && w.charges < need && this.rng.next() < this.profile.focusBias && (safeToFocus || (mistake && this.rng.next() < 0.5))) {
      return { ...intent, move: 0, focus: true };
    }

    // 8. Offensive pressure, respecting a defensive Aether reserve some of the time.
    const pick = this._offense(sim, w, b, mistake);
    if (pick != null) {
      if (this._respectReserve(sim, w, pick)) return intent;
      return this._commitCast(pick, intent);
    }

    return intent;
  }
}

export function makePracticeBot(playerId, opts = {}) {
  return new PracticeBot(playerId, opts);
}
