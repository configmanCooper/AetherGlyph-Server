// sim.js — Aetherglyph pure deterministic fixed-tick duel simulation.
//
// DOM-free, Three.js-free, Socket.IO-free. Imports only balance data + rng so
// it runs identically in Node (tests, bots, future authoritative server) and in
// the browser. Advance with step(intents); read state via snapshot(); verify
// determinism via hash(). NEVER call Math.random here — use this.rng.
//
// This follows the Fish-Friends pattern: all game logic is headless and emits
// events that rendering/audio/ui consume.

import {
  DT, TICK_HZ, MATCH, AETHER, STAMINA, SIGIL, FOCUS, SIDESTEP, BRACE, MOVE, CONTROL,
  CAST, STATUSES, HARD_CONTROL, DISPELLABLE, ZONE, REACTION, MIRROR_DECOY,
} from './constants.js';
import { SPELLS_BY_ID } from '../balance/spellData.generated.js';
import {
  effectFor, categoryOf, isHeavyProjectile,
  PROJECTILE, SHIELD, BARRIER, REFLECT, HEX, BUFF, ZONE as ZONE_T,
  DISPEL, BLINK, CHANNEL, MIRROR, PHOENIX,
} from './spellEffects.js';
import { REACTIONS, sortByPriority, prismaticUtility } from './reactions.js';
import { makeRng } from '../rng/rng.js';

const sToTicks = (s) => Math.max(0, Math.round(s * TICK_HZ));

function makeWizard(id, loadout, spawnArc) {
  return {
    id,
    loadout,                    // array of spell objects (with gestureKey)
    loadoutIds: loadout.map((s) => s.id),
    health: MATCH.startHealth,
    aether: AETHER.start,
    stamina: STAMINA.start,
    charges: SIGIL.start,
    arcPos: spawnArc,           // -1..1 along the movement arc
    facing: -spawnArc,          // toward opponent (render hint)
    sidestepCharges: SIDESTEP.charges,
    sidestepTimers: [],         // recharge timers (ticks)
    statuses: {},               // name -> { stacks, ticks }
    tenacityTicks: 0,
    cooldowns: {},              // spellId -> ticks
    casting: null,              // { spellId, ticks, totalTicks, quality }
    channel: null,              // { spellId, ticks, totalTicks, perTick, utility }
    focusTicks: 0,              // accumulated focus channel ticks
    focusing: false,
    braceTicks: 0,
    shield: null,               // { absorb, ticks, frontal }
    barrier: null,              // { absorb, ticks }
    reflectTicks: 0,
    deflectTicks: 0,           // Gust Wall light-projectile deflect window
    evadeTicks: 0,              // brief post-Blink evade window
    invisibleTicks: 0,          // post-Blink visual invisibility window
    mirrorTicks: 0,             // Mirror Twin decoy still up
    mirrorPos: spawnArc,        // decoy position along the caster's movement arc
    mirrorDir: 0,               // -1 toward left, +1 toward right, 0 stopped
    phoenixUsed: false,         // Phoenix save spent this round
    recoveryTicks: 0,           // post-cast / reject recovery lockout
    resonance: [],              // [{ school, ticks }]
    knockbackTimes: [],         // tick timestamps of recent knockbacks
    lastActivityTick: 0,        // for sigil decay
    snaredZones: new Set(),     // snare zone ids already triggered on this wizard
    wetExposureTicks: 0,        // continuous shared Rain exposure before Soaked
    staminaIdleTicks: 0,        // continuous time stationary for rested regeneration
    movedThisTick: false,
    // rolling counters
    damageDealt: 0,
    countersLanded: 0,
    castsResolved: 0,
    castsRejected: 0,
    actionRejectKeys: {},
  };
}

export class Sim {
  constructor(opts = {}) {
    const seed = (opts.seed ?? 0x1234) >>> 0;
    this.rng = makeRng(seed);
    this.seed = seed;
    this.tick = 0;
    this.timeS = 0;
    this.ended = false;
    this.winner = null;         // 0 | 1 | 'draw' | null
    this.endReason = null;      // 'health' | 'timer'
    this.projectiles = [];
    this.zones = [];            // active environmental zones (shared)
    this.nextProjectileId = 1;
    this.nextZoneId = 1;
    this.reactionCooldowns = {}; // reaction name -> ticks remaining
    this.pressureLevel = 0;
    this.healingDisabled = false;
    this.events = [];
    // Optional rule toggles. Defaults preserve the authoritative online/offline
    // behaviour exactly. Tutorial instances may shorten cooldowns for teaching;
    // Practice and online omit the multiplier and therefore remain at 1.
    this.rules = {
      timer: opts.rules?.timer !== false,
      pressure: opts.rules?.pressure !== false,
      projectileTravelScale: Math.max(0.5, Math.min(4, Number(opts.rules?.projectileTravelScale) || 1)),
      cooldownScale: Number.isFinite(Number(opts.rules?.cooldownScale))
        ? Math.max(0.05, Math.min(1, Number(opts.rules.cooldownScale)))
        : 1,
      sandbox: opts.rules?.sandbox === true,
      sandboxCooldowns: opts.rules?.sandboxCooldowns === true,
    };

    const l0 = opts.loadouts?.[0] || [];
    const l1 = opts.loadouts?.[1] || [];
    this.wizards = [
      makeWizard(0, l0, -0.35),
      makeWizard(1, l1, 0.35),
    ];
  }

  // ------------------------------------------------------------------ helpers
  opponentOf(id) { return this.wizards[id === 0 ? 1 : 0]; }

  emit(type, data) { this.events.push({ tick: this.tick, type, ...data }); }

  spellData(id) { return SPELLS_BY_ID[id]; }

  staminaCostMultiplier(w) {
    return this.hasStatus(w, 'Haste') ? STAMINA.hasteCostMul : 1;
  }

  spendStamina(w, baseCost) {
    const cost = Math.max(0, baseCost * this.staminaCostMultiplier(w));
    if (w.stamina + 1e-9 < cost) return false;
    w.stamina = Math.max(0, w.stamina - cost);
    return true;
  }

  rejectAction(w, action, reason, details = {}) {
    const key = `${action}:${reason}`;
    if (w.actionRejectKeys[action] === key) return;
    w.actionRejectKeys[action] = key;
    this.emit('actionRejected', { caster: w.id, action, reason, ...details });
  }

  clearActionReject(w, action) {
    delete w.actionRejectKeys[action];
  }

  rejectCast(w, spellId, reason, details = {}) {
    this.lastCastReject = { caster: w.id, spellId, reason, ...details };
    this.emit('castRejected', this.lastCastReject);
    return false;
  }

  regenerateStamina(w, regenerationBlocked = this.isHardControlled(w)) {
    if (regenerationBlocked) {
      w.staminaIdleTicks = 0;
      return;
    }
    if (w.movedThisTick) {
      w.staminaIdleTicks = 0;
      return;
    }
    w.staminaIdleTicks += 1;
    let rate = this.hasStatus(w, 'Haste') ? STAMINA.hasteRegenPerS : STAMINA.regenPerS;
    if (w.staminaIdleTicks > sToTicks(STAMINA.deepRestAfterS)) rate *= STAMINA.deepRestRegenMul;
    else if (w.staminaIdleTicks > sToTicks(STAMINA.restedAfterS)) rate *= STAMINA.restedRegenMul;
    if (this.hasStatus(w, 'Sloth')) rate *= 0.7;
    w.stamina = Math.min(STAMINA.max, w.stamina + rate * DT);
  }

  cooldownTicks(id) {
    const spell = this.spellData(id);
    return spell ? sToTicks(spell.cooldown_s * this.rules.cooldownScale) : 0;
  }

  hasStatus(w, name) { return !!w.statuses[name] && w.statuses[name].ticks > 0; }

  hasBarrier(w) {
    return !!w.barrier && w.barrier.ticks > 0 && w.barrier.absorb > 0;
  }

  fogActive() {
    return this.zones.some((zone) => zone.kind === 'Fog' && zone.ticks > 0);
  }

  visionObscured(w, opponent = this.opponentOf(w.id)) {
    return this.fogActive() || opponent.invisibleTicks > 0 || this.hasStatus(w, 'Blinded');
  }

  targetArcPos(w) {
    return w.mirrorTicks > 0 ? w.mirrorPos : w.arcPos;
  }

  mirrorSeparated(w) {
    return w.mirrorTicks > 0
      && Math.abs(w.arcPos - w.mirrorPos) > MIRROR_DECOY.touchRadius;
  }

  updateFacings() {
    for (const w of this.wizards) {
      const opponent = this.opponentOf(w.id);
      w.facing = this.visionObscured(w, opponent) ? -w.arcPos : this.targetArcPos(opponent);
    }
  }

  statusStacks(w, name) { return this.hasStatus(w, name) ? w.statuses[name].stacks : 0; }

  isHardControlled(w) {
    return this.hasStatus(w, 'Frozen') || this.hasStatus(w, 'Stunned');
  }

  canAct(w) {
    return !this.isHardControlled(w) && !w.channel;
  }

  // Slow that affects MOVEMENT and post-cast recovery. Haste can push this
  // slightly negative (a speed-up); statuses and Frozen Ground add to it.
  moveSlow(w) {
    let s = 0;
    if (this.hasStatus(w, 'Chilled')) s += STATUSES.Chilled.slow;
    if (this.hasStatus(w, 'Sloth')) s += STATUSES.Sloth.slow;
    if (this.hasStatus(w, 'Grounded')) s += STATUSES.Grounded.moveSlow;
    if (this.hasStatus(w, 'Haste')) s -= STATUSES.Haste.haste;
    if (this.zones.some((z) => z.kind === 'Frozen' && z.ticks > 0 && this.wizardInZone(w, z))) {
      s += ZONE.frozenSlow;
    }
    return Math.max(-0.30, Math.min(0.6, s));
  }

  // Slow that lengthens cast WINDUP. Haste affects movement only and never
  // shortens a spell's minimum cast time.
  castSlow(w) {
    let s = 0;
    if (this.hasStatus(w, 'Chilled')) s += STATUSES.Chilled.slow;
    if (this.hasStatus(w, 'Sloth')) s += STATUSES.Sloth.slow;
    return Math.max(0, Math.min(0.6, s));
  }

  // Back-compat alias used by older call sites.
  slowFactor(w) { return this.castSlow(w); }

  // ------------------------------------------------------------------- zones
  hourglassActive() {
    return this.zones.some((z) => z.kind === 'Hourglass' && z.ticks > 0);
  }

  hostileHourglassActive(projectileOwner) {
    return this.zones.some((z) =>
      z.kind === 'Hourglass' && z.ticks > 0 && z.owner !== projectileOwner);
  }

  zonesOfKind(kind) { return this.zones.filter((z) => z.kind === kind && z.ticks > 0); }

  wizardInZone(w, z) {
    return Math.abs(w.arcPos - z.center) <= (z.radius ?? ZONE.radius);
  }

  addZone(ownerId, kind, opts = {}) {
    const durS = opts.durationS ?? ZONE.durations[kind] ?? 5;
    const owner = this.wizards[ownerId];
    const center = opts.center ?? (['Cover', 'Snare'].includes(kind) ? owner.arcPos : 0);
    const radius = opts.radius ?? (['Fog', 'Wet', 'Oil', 'Hourglass', 'Fire'].includes(kind) ? 0.8 : ZONE.radius);
    // §10 two active zones per player; recasting replaces the oldest owned zone.
    const owned = this.zones.filter((z) => z.owner === ownerId);
    while (owned.length >= ZONE.maxPerPlayer) {
      const oldest = owned.shift();
      this.zones = this.zones.filter((z) => z !== oldest);
      this.emit('zoneEnd', { id: oldest.id, kind: oldest.kind, reason: 'replaced' });
    }
    const zone = {
      id: this.nextZoneId++, owner: ownerId, kind, center, radius,
      ticks: sToTicks(durS), totalTicks: sToTicks(durS),
      hp: kind === 'Cover' ? ZONE.coverHp : 0,
    };
    this.zones.push(zone);
    this.emit('zone', {
      owner: ownerId, kind, id: zone.id, durationTicks: zone.ticks,
      center: zone.center, radius: zone.radius,
    });
    return zone;
  }

  removeZones(pred, reason) {
    let removed = 0;
    const kept = [];
    for (const z of this.zones) {
      if (pred(z)) { this.emit('zoneEnd', { id: z.id, kind: z.kind, reason }); removed++; }
      else kept.push(z);
    }
    this.zones = kept;
    return removed;
  }

  // ----------------------------------------------------------------- statuses
  applyStatus(target, name, stacks = 1, opts = {}) {
    const def = STATUSES[name];
    if (!def) return false;
    if (def.hard) {
      // Hard control obeys Tenacity.
      if (target.tenacityTicks > 0) {
        this.emit('controlResisted', { target: target.id, status: name });
        return false;
      }
    }
    // Grounding Mantle cancels NEW Static application while active.
    if (name === 'Static' && this.hasStatus(target, 'Grounded')) {
      this.emit('grounded', { target: target.id, blocked: 'Static' });
      return false;
    }
    if (name === 'KnockedDown' && this.hasStatus(target, 'Grounded')) {
      this.emit('grounded', { target: target.id, blocked: 'KnockedDown' });
      return false;
    }
    if (name === 'Wet' && this.hasStatus(target, 'Soaked')) return false;
    if (name === 'Soaked' && target.statuses.Wet) {
      delete target.statuses.Wet;
      this.emit('statusEnd', { target: target.id, status: 'Wet' });
    }
    // Wet or Soaked washes off Burning (water beats fire).
    if ((name === 'Wet' || name === 'Soaked') && target.statuses.Burning) {
      delete target.statuses.Burning;
      this.emit('statusEnd', { target: target.id, status: 'Burning' });
    }
    const durS = Math.min(
      opts.durationS ?? def.durationS,
      def.hard && !opts.ignoreHardCap ? CONTROL.maxHardControlS : (opts.durationS ?? def.durationS),
    );
    const cur = target.statuses[name];
    const maxStacks = def.maxStacks || 1;
    if (cur && cur.ticks > 0) {
      cur.stacks = Math.min(maxStacks, cur.stacks + stacks);
      cur.ticks = Math.max(cur.ticks, sToTicks(durS));
    } else {
      target.statuses[name] = { stacks: Math.min(maxStacks, stacks), ticks: sToTicks(durS) };
    }
    this.emit('status', { target: target.id, status: name, stacks: target.statuses[name].stacks });
    return true;
  }

  tickStatuses(w) {
    for (const name of Object.keys(w.statuses)) {
      const st = w.statuses[name];
      if (st.ticks <= 0) { delete w.statuses[name]; continue; }
      const def = STATUSES[name];
      if (def.kind === 'dot') {
        // Burning: dps damage per second, spread across ticks. Bypasses shields
        // and amp modifiers; not attributed to a live attacker.
        this.dealDamage(null, w,
          def.dps * st.stacks * DT, { source: 'Burning', ignoreDefense: true, ignoreAmp: true, ignoreCap: true, silent: true });
      }
      st.ticks -= 1;
      if (st.ticks <= 0) {
        delete w.statuses[name];
        if (def.hard) {
          // Tenacity engages after hard control ends.
          w.tenacityTicks = sToTicks(CONTROL.tenacityS);
          this.emit('tenacity', { target: w.id });
        }
        this.emit('statusEnd', { target: w.id, status: name });
      }
    }
  }

  // ------------------------------------------------------------------ damage
  dealDamage(attacker, target, rawAmount, opts = {}) {
    if (rawAmount <= 0 || target.health <= 0) return 0;
    let dmg = rawAmount;
    let markedPayoff = false;

    // Attacker Weakened reduces outgoing damage.
    if (attacker && this.hasStatus(attacker, 'Weakened')) {
      dmg *= (1 - STATUSES.Weakened.damageDealt);
    }
    // Target Sundered increases incoming direct damage.
    if (!opts.ignoreAmp && this.hasStatus(target, 'Sundered')) {
      dmg *= (1 + STATUSES.Sundered.damageTaken);
    }
    // Marked: next direct hit amplified, then consumed.
    if (!opts.ignoreAmp && this.hasStatus(target, 'Marked')) {
      markedPayoff = true;
      dmg *= (1 + STATUSES.Marked.markBonus);
      delete target.statuses.Marked;
      this.emit('statusEnd', { target: target.id, status: 'Marked' });
    }
    // Soaked amplifies lightning (Storm) damage — unless the target is Grounded,
    // which cancels the lightning bonus (Grounding Mantle reaction).
    if (opts.school === 'Storm' && this.hasStatus(target, 'Soaked') && !this.hasStatus(target, 'Grounded')) {
      dmg *= (1 + STATUSES.Soaked.lightningBonus);
    }
    // Grounding Mantle: flat 15% direct-damage reduction (not on DoT).
    if (!opts.ignoreAmp && this.hasStatus(target, 'Grounded')) {
      dmg *= (1 - STATUSES.Grounded.dmgReduction);
    }

    if (!opts.ignoreDefense) {
      if (target.braceTicks > 0) {
        const incoming = dmg;
        dmg *= (1 - BRACE.damageReduction);
        const gained = incoming * BRACE.aetherGain;
        target.aether = Math.min(AETHER.max, target.aether + gained);
        this.emit('braceAbsorb', { target: target.id, incoming, damage: dmg, aether: gained });
      }

      // Barrier (360) absorbs first.
      if (target.barrier && target.barrier.ticks > 0) {
        const absorbed = Math.min(target.barrier.absorb, dmg);
        target.barrier.absorb -= absorbed;
        dmg -= absorbed;
        if (target.barrier.absorb <= 0) { target.barrier = null; }
      }
      // Frontal Ward shield. Piercing bypasses half the shield.
      if (dmg > 0 && target.shield && target.shield.ticks > 0) {
        const effective = opts.piercing ? dmg * 0.5 : dmg;
        const absorbed = Math.min(target.shield.absorb, effective);
        target.shield.absorb -= absorbed;
        dmg -= absorbed;
        if (target.shield.absorb <= 0) { target.shield = null; }
      }
    }

    dmg = Math.max(0, dmg);
    if (dmg <= 0) return 0;
    // No single resolved cast exceeds 30 direct damage (MASTERPLAN §9).
    if (!opts.ignoreCap) dmg = Math.min(dmg, 30);

    // Phoenix Covenant: a lethal hit instead leaves the caster at 1 health,
    // once per round, while the aura is up.
    if (dmg >= target.health && this.hasStatus(target, 'Phoenix') && !target.phoenixUsed) {
      target.phoenixUsed = true;
      delete target.statuses.Phoenix;
      this.emit('statusEnd', { target: target.id, status: 'Phoenix' });
      dmg = Math.max(0, target.health - 1);
      target.health = 1;
      target.lastActivityTick = this.tick;
      if (attacker) { attacker.damageDealt += dmg; attacker.lastActivityTick = this.tick; }
      this.emit('phoenixSave', { target: target.id });
      if (!opts.silent) this.emit('damage', {
        target: target.id, amount: dmg, source: opts.source, markedPayoff,
      });
      return dmg;
    }

    target.health = Math.max(0, target.health - dmg);
    target.lastActivityTick = this.tick;
    if (attacker) {
      attacker.damageDealt += dmg;
      attacker.lastActivityTick = this.tick;
    }
    if (!opts.silent) this.emit('damage', {
      target: target.id, amount: dmg, source: opts.source, markedPayoff,
    });
    if (target.health <= 0) this.endMatch(attacker ? attacker.id : this.opponentOf(target.id).id, 'health');
    return dmg;
  }

  // ---------------------------------------------------------------- intents
  beginCast(w, spellId, quality, targetPos = null) {
    this.lastCastReject = null;
    if (this.hasStatus(w, 'Frozen')) return this.rejectCast(w, spellId, 'frozen');
    if (this.hasStatus(w, 'Stunned')) return this.rejectCast(w, spellId, 'stunned');
    if (w.channel) return this.rejectCast(w, spellId, 'channeling');
    if (w.casting) return this.rejectCast(w, spellId, 'casting');
    if (w.focusing) return this.rejectCast(w, spellId, 'focusing');
    const spell = this.spellData(spellId);
    const eff = effectFor(spellId);
    if (!spell || !eff) return this.rejectCast(w, spellId, 'unavailable');
    // Barrier prevents offensive casting while active.
    const offensive = eff.type === PROJECTILE || eff.type === CHANNEL;
    if (offensive && w.barrier && w.barrier.ticks > 0) {
      return this.rejectCast(w, spellId, 'barrier');
    }
    // Cooldown check.
    const cooldownTicks = Math.max(0, w.cooldowns[spellId] || 0);
    if (cooldownTicks > 0) {
      return this.rejectCast(w, spellId, 'cooldown', {
        cooldownTicks,
        cooldownSeconds: cooldownTicks / TICK_HZ,
      });
    }
    if (w.recoveryTicks > 0) {
      return this.rejectCast(w, spellId, 'recovery', {
        recoveryTicks: w.recoveryTicks,
        recoverySeconds: w.recoveryTicks / TICK_HZ,
      });
    }
    // Static interrupts the next channel (channel-type or channelled buff).
    if ((eff.type === CHANNEL || eff.channel) && this.statusStacks(w, 'Static') > 0) {
      w.statuses.Static.stacks -= 1;
      if (w.statuses.Static.stacks <= 0) delete w.statuses.Static;
      w.recoveryTicks = Math.max(w.recoveryTicks, sToTicks(CAST.rejectRecoveryS));
      this.emit('staticInterrupt', { caster: w.id, spellId });
      return this.rejectCast(w, spellId, 'static');
    }
    // Aether cost (with resonance / Attunement discount).
    const cost = this.effectiveCost(w, spell);
    if (w.aether < cost) {
      return this.rejectCast(w, spellId, 'aether', {
        required: cost,
        available: w.aether,
      });
    }
    // Sigil charge cost.
    if ((spell.charges || 0) > w.charges) {
      return this.rejectCast(w, spellId, 'charges', {
        required: spell.charges || 0,
        available: w.charges,
      });
    }

    let windupS = spell.min_cast_s * (1 + this.castSlow(w));
    const durationEligible = ['Defensive', 'Buff', 'Debuff', 'Environmental'].includes(spell.category);
    const damageBenefit = (eff.damage || 0) > 0 || (eff.type === CHANNEL && (eff.totalDamage || 0) > 0);
    const durationBenefit = durationEligible && (
      [SHIELD, BARRIER, REFLECT, BLINK, ZONE_T, BUFF].includes(eff.type)
      || (eff.type === HEX && !!eff.status)
    );
    const empowered = (spell.charges || 0) === 0 && w.charges >= 1 && (damageBenefit || durationBenefit);
    w.casting = {
      spellId, ticks: sToTicks(windupS), totalTicks: sToTicks(windupS),
      quality: Math.max(CAST.minPotency, Math.min(CAST.maxPotency, quality ?? 1)),
      targetPos: Number.isFinite(targetPos) ? Math.max(-1, Math.min(1, targetPos)) : null,
      empowered,
      durationScale: empowered && durationBenefit ? 1.2 : 1,
    };
    w.lastActivityTick = this.tick;
    this.emit('castStart', { caster: w.id, spellId, windupTicks: w.casting.ticks });
    return true;
  }

  effectiveCost(w, spell) {
    let cost = spell.aether;
    const school = spell.school;
    // Resonance: third matching elemental cast gets 10% discount.
    const matches = w.resonance.filter((r) => r.school === school && r.ticks > 0).length;
    if (matches >= 2) cost *= 0.9;
    // Ember Attunement: Ember costs 15% less while active.
    if (this.hasStatus(w, 'Attunement') && school === STATUSES.Attunement.school) {
      cost *= STATUSES.Attunement.costMul;
    }
    return cost;
  }

  resolveCast(w) {
    const c = w.casting;
    w.casting = null;
    const spell = this.spellData(c.spellId);
    const eff = effectFor(c.spellId);
    const cost = Math.round(this.effectiveCost(w, spell));
    w.aether = Math.max(0, w.aether - cost);
    if (spell.charges) w.charges = Math.max(0, w.charges - spell.charges);
    else if (c.empowered) w.charges = Math.max(0, w.charges - 1);
    w.cooldowns[c.spellId] = this.cooldownTicks(c.spellId);
    w.recoveryTicks = sToTicks(0.15 * (1 + Math.max(0, this.moveSlow(w))));
    w.castsResolved += 1;
    w.lastActivityTick = this.tick;

    // Build elemental resonance (offensive elemental schools only).
    if (eff.type === PROJECTILE && ['Ember', 'Tide', 'Storm', 'Stone', 'Gale'].includes(spell.school)) {
      w.resonance.push({ school: spell.school, ticks: sToTicks(7) });
      if (w.resonance.length > 2) w.resonance.shift();
    }

    this.emit('cast', {
      caster: w.id, spellId: c.spellId, quality: c.quality,
      empowered: !!c.empowered, durationScale: c.durationScale,
    });

    const opp = this.opponentOf(w.id);
    switch (eff.type) {
      case PROJECTILE: {
        this.projectiles.push({
          id: this.nextProjectileId++, owner: w.id, spellId: c.spellId, eff,
          ticks: sToTicks(eff.travelS * this.rules.projectileTravelScale),
          totalTicks: sToTicks(eff.travelS * this.rules.projectileTravelScale),
          quality: c.quality * (c.empowered ? 1.1 : 1),
          originPos: w.arcPos,
          targetPos: c.targetPos ?? w.facing,
        });
        break;
      }
      case SHIELD: {
        let absorb = eff.absorb;
        if (this.timeS >= MATCH.lateRoundS) absorb *= 0.8; // §3 shields lose 20%
        w.shield = { absorb, ticks: sToTicks(eff.durationS * c.durationScale), frontal: eff.frontal };
        this.emit('shield', { caster: w.id, absorb });
        break;
      }
      case BARRIER: {
        let absorb = eff.absorb;
        if (this.timeS >= MATCH.lateRoundS) absorb *= 0.8;
        w.barrier = { absorb, ticks: sToTicks(eff.durationS * c.durationScale) };
        this.emit('barrier', { caster: w.id, absorb });
        break;
      }
      case REFLECT: {
        w.reflectTicks = sToTicks(eff.windowS * c.durationScale);
        this.emit('reflectWindow', { caster: w.id });
        break;
      }
      case HEX:     this.resolveHex(w, opp, eff, c.spellId, c.durationScale); break;
      case BUFF:    this.resolveBuff(w, eff, c.durationScale); break;
      case ZONE_T:  this.resolveZone(w, eff, c.durationScale); break;
      case DISPEL:  this.resolveDispel(w, opp, eff); break;
      case BLINK:   this.resolveBlink(w, opp, eff, c.durationScale); break;
      case MIRROR:
        w.mirrorTicks = sToTicks(eff.durationS);
        w.mirrorPos = w.arcPos;
        w.mirrorDir = -1;
        this.emit('mirror', { caster: w.id, decoyPos: w.mirrorPos });
        break;
      case PHOENIX:
        this.applyStatus(w, 'Phoenix', 1, { durationS: eff.durationS });
        this.emit('phoenix', { caster: w.id });
        break;
      case CHANNEL: this.resolveChannel(w, eff, c.quality, c.spellId); break;
      default: break;
    }
  }

  // ------------------------------------------------------------- cast handlers
  resolveHex(w, opp, eff, spellId, durationScale = 1) {
    if (this.hasBarrier(opp)) {
      this.emit('barrierNegate', { caster: w.id, target: opp.id, spellId });
      return;
    }
    if (eff.drain) {
      const drainable = Math.max(0, opp.aether - AETHER.protectedFloor);
      const drained = Math.min(eff.drain, drainable);
      opp.aether = Math.max(AETHER.protectedFloor, opp.aether - drained);
      w.aether = Math.min(AETHER.max, w.aether + drained * 0.5);
      opp.lastActivityTick = this.tick;
      if (drained > 0) w.countersLanded += 0; // resource denial, not a counter
      this.emit('leech', { caster: w.id, target: opp.id, amount: drained });
      return;
    }
    if (eff.conditionalControl) {
      const cc = eff.conditionalControl;
      const met = cc.needs === 'chilled' ? this.hasStatus(opp, 'Chilled') : false;
      if (met) {
        if (cc.consume && opp.statuses[cc.consume]) {
          delete opp.statuses[cc.consume];
          this.emit('statusEnd', { target: opp.id, status: cc.consume });
        }
        this.applyStatus(opp, cc.status, 1, {
          durationS: cc.durationS,
          ignoreHardCap: !!cc.ignoreHardCap,
        });
      } else {
        this.emit('hexFizzle', { caster: w.id, spellId, reason: 'setup-missing' });
      }
      return;
    }
    if (eff.status) {
      const baseDuration = STATUSES[eff.status.name]?.durationS;
      this.applyStatus(opp, eff.status.name, eff.status.stacks || 1, {
        durationS: baseDuration ? baseDuration * durationScale : undefined,
      });
      this.emit('hex', { caster: w.id, target: opp.id, status: eff.status.name });
    }
  }

  resolveBuff(w, eff, durationScale = 1) {
    if (eff.cleanses) {
      for (const name of eff.cleanses) {
        if (w.statuses[name]) { delete w.statuses[name]; this.emit('statusEnd', { target: w.id, status: name }); }
      }
    }
    if (eff.self) {
      this.applyStatus(w, eff.self, 1, {
        durationS: STATUSES[eff.self].durationS * durationScale,
      });
      this.emit('buff', { caster: w.id, status: eff.self });
    }
  }

  resolveZone(w, eff, durationScale = 1) {
    const opponent = this.opponentOf(w.id);
    let zoneOpts = {};
    if (eff.zoneKind === 'Snare') {
      const direction = opponent.arcPos > 0 ? -1 : opponent.arcPos < 0 ? 1 : (w.arcPos <= 0 ? 1 : -1);
      zoneOpts = {
        center: Math.max(-1, Math.min(1, opponent.arcPos + direction * (ZONE.radius + 0.13))),
      };
    }
    zoneOpts.durationS = (ZONE.durations[eff.zoneKind] || 5) * durationScale;
    const zone = this.addZone(w.id, eff.zoneKind, zoneOpts);
    if (eff.knockdown && !this.hasBarrier(opponent)) {
      this.applyStatus(opponent, 'KnockedDown', 1);
    }
    // Incoming water (Rain Glyph) immediately douses Burning + fire zones.
    let incoming = null;
    if (eff.zoneKind === 'Wet') incoming = 'water';
    else if (eff.zoneKind === 'Gust') {
      incoming = 'gust';
      // Gust Wall raises a brief window that blows away LIGHT projectiles aimed
      // at the caster (heavy shots punch through — see resolveProjectile).
      if (eff.deflect) {
        w.deflectTicks = sToTicks((eff.deflectWindowS || 0) * durationScale);
        this.emit('gustWall', { caster: w.id });
      }
    }
    if (incoming) this.triggerReactions({ casterId: w.id, targetId: this.opponentOf(w.id).id, incoming, center: zone.center });
  }

  resolveDispel(w, opp, eff) {
    // Priority: strip harmful statuses from self first (DISPELLABLE order).
    let removed = 0;
    let preserveWet = false;
    for (const name of DISPELLABLE) {
      if (removed >= eff.statuses) break;
      if (name === 'Wet' && preserveWet) continue;
      if (w.statuses[name]) {
        if (name === 'Soaked') {
          delete w.statuses.Soaked;
          this.emit('statusEnd', { target: w.id, status: 'Soaked' });
          this.applyStatus(w, 'Wet', 1);
          w.wetExposureTicks = 0;
          this.emit('dispel', { caster: w.id, removed: 'Soaked', downgradedTo: 'Wet' });
          removed++;
          preserveWet = true;
          continue;
        }
        if (name === 'Wet') w.wetExposureTicks = 0;
        delete w.statuses[name];
        this.emit('statusEnd', { target: w.id, status: name });
        this.emit('dispel', { caster: w.id, removed: name });
        removed++;
      }
    }
    // If nothing to cleanse, remove one enemy-owned zone edge instead.
    if (removed === 0 && eff.orZone) {
      const enemyZone = this.zones.find((z) => z.owner === opp.id && z.ticks > 0);
      if (enemyZone) {
        this.removeZones((z) => z === enemyZone, 'dispelled');
        this.emit('dispel', { caster: w.id, removedZone: enemyZone.kind });
        removed++;
      }
    }
    if (removed === 0) this.emit('dispel', { caster: w.id, removed: null });
  }

  resolveBlink(w, opp, eff, durationScale = 1) {
    if (eff.escapesRoot && w.statuses.Rooted) {
      delete w.statuses.Rooted;
      this.emit('statusEnd', { target: w.id, status: 'Rooted' });
    }
    const dir = w.arcPos >= opp.arcPos ? 1 : -1; // blink away from the opponent
    const limit = Math.max(0.1, 1 - this.pressureLevel * 0.12);
    w.arcPos = Math.max(-limit, Math.min(limit, w.arcPos + dir * eff.arcDelta));
    w.evadeTicks = sToTicks(eff.evadeS * durationScale);
    w.invisibleTicks = sToTicks(eff.invisibleS * durationScale);
    this.emit('blink', { caster: w.id });
  }

  resolveChannel(w, eff, quality, spellId) {
    const totalTicks = sToTicks(eff.durationS);
    // Prismatic mixed-resonance utility from the two visible resonance marks.
    const schools = w.resonance.filter((r) => r.ticks > 0).map((r) => r.school);
    const util = prismaticUtility(schools[0], schools[1]);
    let total = eff.totalDamage;
    if (util.coverDamageBonus) total *= (1 + util.coverDamageBonus);
    // Total damage never raises player damage above the 28 channel cap.
    total = Math.min(28, total) * quality;
    w.channel = {
      spellId, ticks: totalTicks, totalTicks,
      perTick: total / Math.max(1, totalTicks), utility: util, staticApplied: false,
    };
    this.emit('channelStart', { caster: w.id, utility: util.key });
  }

  advanceChannel(w) {
    if (!w.channel) return;
    if (!this.isHardControlled(w)) {
      const opp = this.opponentOf(w.id);
      this.dealDamage(w, opp, w.channel.perTick, { source: 'Prismatic Beam', school: 'Prismatic', ignoreCap: true });
      const half = w.channel.totalTicks / 2;
      // Tide+Storm utility: apply Static 1 once at least half the beam landed.
      if (w.channel.utility.applyStatic && !w.channel.staticApplied && w.channel.ticks <= half
          && !this.hasBarrier(opp)) {
        this.applyStatus(opp, 'Static', w.channel.utility.applyStatic);
        w.channel.staticApplied = true;
      }
      w.channel.ticks -= 1;
      if (w.channel.ticks <= 0) { this.emit('channelEnd', { caster: w.id }); w.channel = null; }
    } else {
      this.emit('channelInterrupt', { caster: w.id });
      w.channel = null;
    }
  }

  // ------------------------------------------------- environmental reactions
  triggerReactions(ctx) {
    const incomings = Array.isArray(ctx.incoming) ? ctx.incoming : [ctx.incoming];
    // Build candidate reactions whose incoming token + existing state are met.
    const candidates = REACTIONS.filter((r) => {
      if (!incomings.includes(r.incoming)) return false;
      if ((this.reactionCooldowns[r.name] || 0) > 0) return false;
      switch (r.existing) {
        case 'Oil': return this.zonesOfKind('Oil').length > 0;
        case 'Wet': return this.zonesOfKind('Wet').length > 0;
        case 'Fog': return this.zonesOfKind('Fog').length > 0;
        case 'Fire': return this.zonesOfKind('Fire').length > 0;
        case 'Frozen': return this.zonesOfKind('Frozen').length > 0;
        case 'Cover': return this.zones.some((z) => z.kind === 'Cover' && z.ticks > 0);
        case 'Burning': return this.wizards.some((w) => this.hasStatus(w, 'Burning'));
        case 'Storm': return this.wizards.some((w) => this.hasStatus(w, 'Grounded'));
        default: return false;
      }
    });
    if (candidates.length === 0) return null;
    // Deterministic priority ordering; resolve exactly ONE (no recursion).
    const chosen = sortByPriority(candidates)[0];
    this.applyReaction(chosen, ctx);
    this.reactionCooldowns[chosen.name] = sToTicks(REACTION.cooldownS);
    // Additive spatial fields (targetId/center) let the renderer anchor the
    // reaction VFX in the world without changing deterministic sim behaviour.
    // Both are already computed for the trigger and are backward compatible.
    this.emit('reaction', {
      name: chosen.name, category: chosen.category,
      casterId: ctx.casterId, targetId: ctx.targetId, center: ctx.center,
    });
    return chosen;
  }

  applyReaction(r, ctx) {
    const target = ctx.targetId != null ? this.wizards[ctx.targetId] : null;
    switch (r.name) {
      case 'Doused':
        for (const w of this.wizards) {
          if (this.hasBarrier(w)) continue;
          if (w.statuses.Burning) { delete w.statuses.Burning; this.emit('statusEnd', { target: w.id, status: 'Burning' }); }
        }
        this.removeZones((z) => z.kind === 'Fire', 'doused');
        break;
      case 'WashedGround':
        this.removeZones((z) => z.kind === 'Oil', 'washed');
        break;
      case 'FrozenGround': {
        const wet = this.zonesOfKind('Wet')[0];
        if (wet) { wet.kind = 'Frozen'; wet.ticks = sToTicks(REACTION.frozenGroundSlowS); wet.totalTicks = wet.ticks; }
        break;
      }
      case 'SteamVeil':
        this.removeZones((z) => z.kind === 'Frozen', 'melted');
        this.addZone(ctx.casterId, 'Fog', { durationS: 9 });
        break;
      case 'ConductiveArc':
        if (target && !this.hasBarrier(target)) this.applyStatus(target, 'Soaked', 1);
        break;
      case 'FlashFire': {
        const oil = this.zonesOfKind('Oil')[0];
        const members = this.wizards.filter((w) => oil && this.wizardInZone(w, oil));
        this.removeZones((z) => z.kind === 'Oil', 'ignited');
        for (const w of members) {
          const barrierProtected = this.hasBarrier(w);
          this.dealDamage(this.wizards[ctx.casterId], w, REACTION.flashFireDamage, { source: 'Flash Fire', school: 'Ember' });
          if (!barrierProtected) this.applyStatus(w, 'Burning', 1);
        }
        this.addZone(ctx.casterId, 'Fire', {});
        break;
      }
      case 'SpreadingFlame': {
        const fire = this.zonesOfKind('Fire')[0];
        if (fire) { fire.radius = Math.min(1, fire.radius + 0.2); fire.ticks = Math.max(1, Math.round(fire.ticks * 0.6)); }
        break;
      }
      case 'ClearedAir':
      case 'BacklitFog':
        this.removeZones((z) => z.kind === 'Fog', 'dispersed');
        break;
      case 'DriftingOil': {
        const oil = this.zonesOfKind('Oil')[0];
        if (oil) oil.center = Math.max(-1, Math.min(1, oil.center + 0.2));
        break;
      }
      case 'Rubble':
        this.removeZones((z) => z.kind === 'Cover', 'rubble');
        break;
      case 'FracturedCover': {
        const cover = this.zones.find((z) => z.kind === 'Cover');
        if (cover) { cover.hp = Math.max(0, cover.hp - 18); if (cover.hp <= 0) this.removeZones((z) => z === cover, 'fractured'); }
        break;
      }
      default: break;
    }
  }

  // -------------------------------------------------------------- projectiles
  advanceProjectiles() {
    const remaining = [];
    const fogActive = this.fogActive();
    for (const p of this.projectiles) {
      const speed = this.hostileHourglassActive(p.owner)
        ? ZONE.hourglassProjectileSpeedMul
        : 1;
      p.ticks -= speed;
      const attacker = this.wizards[p.owner];
      const defender = this.opponentOf(p.owner);
      // Blink invisibility hides the target; Eclipse blindness and shared Fog
      // deny the visual lock needed to update a homing projectile.
      if (p.eff.homing > 0 && defender.invisibleTicks <= 0
          && !this.hasStatus(attacker, 'Blinded') && !fogActive) {
        // Spread the small homing allowance over the projectile's full flight.
        // Scaling by speed prevents Hourglass from granting extra tracking simply
        // because the projectile remains alive for four times as many ticks.
        const trackingStep = p.eff.homing * speed / Math.max(1, p.totalTicks || 1);
        p.targetPos += (this.targetArcPos(defender) - p.targetPos) * trackingStep;
      }
      const progress = 1 - Math.max(0, p.ticks) / Math.max(1, p.totalTicks || 1);
      const projectilePos = p.originPos + (p.targetPos - p.originPos) * progress;
      const cover = this.zones.find((z) =>
        z.kind === 'Cover' && z.owner === defender.id && z.ticks > 0 && z.hp > 0
        && Math.abs(projectilePos - z.center) <= z.radius);
      if (cover && !p.eff.piercing && !p.eff.area && progress >= 0.84) {
        const blocked = (p.eff.damage || 0) * p.quality;
        cover.hp -= blocked;
        this.emit('coverBlock', {
          target: defender.id, spellId: p.spellId, zone: cover.id,
          center: cover.center, blocked,
        });
        if (cover.hp <= 0) this.removeZones((z) => z === cover, 'shattered');
        continue;
      }
      if ((defender.barrier || defender.shield) && progress >= 0.9) {
        this.resolveProjectile(p, defender);
        continue;
      }
      if (p.ticks > 0) { remaining.push(p); continue; }
      this.resolveProjectile(p, defender);
    }
    this.projectiles = remaining;
  }

  resolveProjectile(p, defender) {
    const attacker = this.wizards[p.owner];
    const eff = p.eff;

    // Reflect window: bounce reflectable projectiles back at the caster.
    if (defender.reflectTicks > 0 && eff.reflectable) {
      defender.reflectTicks = 0;
      defender.charges = Math.min(SIGIL.max, defender.charges + 0.5); // half charge (§6)
      defender.countersLanded += 1;
      this.emit('reflect', { by: defender.id, spellId: p.spellId });
      this.projectiles.push({
        id: this.nextProjectileId++, owner: defender.id, spellId: p.spellId, eff,
        ticks: sToTicks(eff.travelS * this.rules.projectileTravelScale),
        totalTicks: sToTicks(eff.travelS * this.rules.projectileTravelScale), quality: p.quality,
        originPos: defender.arcPos,
        targetPos: this.targetArcPos(attacker),
      });
      return;
    }

    // Mirror Twin only intercepts while its decoy is visibly separated from the
    // caster. When their silhouettes overlap, the incoming shot reaches the real
    // wizard and the decoy remains active.
    if (this.mirrorSeparated(defender) && !eff.area) {
      const decoyPos = defender.mirrorPos;
      defender.mirrorTicks = 0;
      defender.mirrorDir = 0;
      this.emit('decoyHit', { target: defender.id, spellId: p.spellId, decoyPos });
      return;
    }

    // Gust Wall: a fresh wind wall blows away a LIGHT projectile before it lands.
    // Heavy shots (Stone Shard, charged/area heavies) punch straight through, so
    // Gust answers pokes, not committed heavy attacks (SOLO-MODES-PLAN §9 L10).
    if (defender.deflectTicks > 0 && !isHeavyProjectile(eff)) {
      defender.countersLanded += 1;
      this.emit('deflect', { by: defender.id, spellId: p.spellId });
      return;
    }

    // Brief post-Blink evade makes any shot miss.
    if (defender.evadeTicks > 0) { this.emit('miss', { spellId: p.spellId, target: defender.id, reason: 'evade' }); return; }

    // Dodge: if the defender has strafed beyond the projectile's dodge radius.
    const miss = Math.abs(defender.arcPos - p.targetPos) > eff.dodgeRadius;
    if (miss) { this.emit('miss', { spellId: p.spellId, target: defender.id }); return; }

    // Interrupt channels/focus first (Concussive Blast, Quake) so a heavy cast
    // can be denied even if a shield eats the damage.
    if (eff.interrupt) {
      if (defender.casting) {
        this.emit('interrupt', { target: defender.id, spellId: defender.casting.spellId });
        defender.cooldowns[defender.casting.spellId] = this.cooldownTicks(defender.casting.spellId);
        defender.casting = null;
        defender.recoveryTicks = sToTicks(CAST.rejectRecoveryS);
      }
      if (defender.channel) { this.emit('channelInterrupt', { caster: defender.id }); defender.channel = null; }
      if (defender.focusing) {
        defender.focusing = false; defender.focusTicks = 0;
        this.emit('focusInterrupt', { target: defender.id });
      }
      attacker.countersLanded += 1;
    }

    // Quake / Fireball destroy the defender's cover on impact.
    if (eff.destroysCover) this.removeZones((z) => z.kind === 'Cover' && z.owner === defender.id, 'destroyed');

    // Hit — apply damage.
    const barrierProtected = this.hasBarrier(defender);
    let dmgBase = eff.damage || 0;
    if (eff.coverBonus && this.zones.some((z) => z.kind === 'Cover' && z.owner === defender.id)) dmgBase += 4;
    const dmg0 = dmgBase * p.quality;
    const dealt = this.dealDamage(attacker, defender, dmg0, {
      source: this.spellData(p.spellId).name,
      piercing: !!eff.piercing,
      school: eff.school,
    });

    // Status application — only if the projectile actually landed damage
    // (a fully-absorbed shot does not deliver its status rider).
    if (eff.status && dealt > 0 && !barrierProtected) {
      this.applyStatus(defender, eff.status.name, eff.status.stacks, {
        durationS: eff.status.durationS,
      });
    }

    // Conditional stun (Chain Lightning, Thunderclap): only on Soaked or enough Static.
    if (eff.conditionalStun && dealt > 0 && !barrierProtected) {
      const cs = eff.conditionalStun;
      const primed = this.hasStatus(defender, 'Soaked')
        || this.statusStacks(defender, 'Static') >= (cs.staticStacks ?? 3);
      if (primed) {
        if (cs.consumeStatic && defender.statuses.Static) { delete defender.statuses.Static; this.emit('statusEnd', { target: defender.id, status: 'Static' }); }
        const ok = this.applyStatus(defender, 'Stunned', 1, {
          durationS: cs.durationS,
          ignoreHardCap: !!cs.ignoreHardCap,
        });
        if (ok) { attacker.countersLanded += 1; this.emit('hardControl', { target: defender.id, status: 'Stunned' }); }
      }
    }
    if (eff.knockdown && dealt > 0 && !barrierProtected) {
      this.applyStatus(defender, 'KnockedDown', 1);
    }

    // Knockback with diminishing returns (max 2 per 4s).
    if (eff.knockback) {
      defender.knockbackTimes = defender.knockbackTimes.filter(
        (t) => this.tick - t < sToTicks(CONTROL.knockbackWindowS));
      if (defender.knockbackTimes.length < CONTROL.knockbackMaxChain) {
        defender.knockbackTimes.push(this.tick);
        const dir = defender.arcPos >= attacker.arcPos ? 1 : -1;
        defender.arcPos = Math.max(-1, Math.min(1, defender.arcPos + dir * 0.25));
        this.emit('knockback', { target: defender.id });
      }
    }

    // Environmental reactions triggered by where this shot lands.
    const incoming = [];
    if (eff.quake) incoming.push('quake');
    if (eff.destroysCover && eff.school === 'Ember') incoming.push('fireball'); // Fireball
    if (eff.backlitFog) incoming.push('flamewave');
    if (eff.igniteOil) incoming.push('ember');
    if (eff.frostReaction) incoming.push('frost');
    if (eff.conductReaction) incoming.push('storm');
    if (incoming.length) this.triggerReactions({ casterId: attacker.id, targetId: defender.id, incoming, center: defender.arcPos });
  }

  // ------------------------------------------------------------------ per-tick
  updateWizardTimers(w) {
    const regenerationBlocked = this.isHardControlled(w);
    const fullChargeFocus = w.focusing && w.charges >= SIGIL.max;
    let aetherRegenPerS = !regenerationBlocked && (!w.focusing || fullChargeFocus)
      ? AETHER.regenPerS
      : 0;
    // Aether Surge remains active during Focus.
    if (!regenerationBlocked && this.hasStatus(w, 'AetherSurge')) {
      aetherRegenPerS += STATUSES.AetherSurge.aetherPerS;
    }
    if (fullChargeFocus) {
      aetherRegenPerS *= FOCUS.fullChargeAetherRegenMul;
    }
    if (aetherRegenPerS > 0 && w.aether < AETHER.max) {
      w.aether = Math.min(AETHER.max, w.aether + aetherRegenPerS * DT);
    }
    // Cooldowns.
    for (const id of Object.keys(w.cooldowns)) {
      if (w.cooldowns[id] > 0) w.cooldowns[id] -= 1;
    }
    // Sidestep recharge: decrement each pending timer; restore a charge at 0.
    const nextTimers = [];
    for (const t of w.sidestepTimers) {
      const nt = t - 1;
      if (nt <= 0) w.sidestepCharges = Math.min(SIDESTEP.charges, w.sidestepCharges + 1);
      else nextTimers.push(nt);
    }
    w.sidestepTimers = nextTimers;
    // Tenacity.
    if (w.tenacityTicks > 0) w.tenacityTicks -= 1;
    // Recovery.
    if (w.recoveryTicks > 0) w.recoveryTicks -= 1;
    // Brace.
    if (w.braceTicks > 0) w.braceTicks -= 1;
    // Shield / barrier / reflect / evade / mirror windows.
    if (w.shield) { w.shield.ticks -= 1; if (w.shield.ticks <= 0) w.shield = null; }
    if (w.barrier) { w.barrier.ticks -= 1; if (w.barrier.ticks <= 0) w.barrier = null; }
    if (w.reflectTicks > 0) w.reflectTicks -= 1;
    if (w.deflectTicks > 0) w.deflectTicks -= 1;
    if (w.evadeTicks > 0) w.evadeTicks -= 1;
    if (w.invisibleTicks > 0) w.invisibleTicks -= 1;
    if (w.mirrorTicks > 0) {
      if (w.mirrorDir !== 0) {
        w.mirrorPos += w.mirrorDir * MIRROR_DECOY.speedPerS * DT;
        if (w.mirrorPos <= -1) {
          w.mirrorPos = -1;
          w.mirrorDir = 1;
        } else if (w.mirrorPos >= 1 && w.mirrorDir > 0) {
          w.mirrorPos = 1;
          w.mirrorDir = 0;
        }
      }
      w.mirrorTicks -= 1;
      if (w.mirrorTicks <= 0) {
        w.mirrorDir = 0;
        this.emit('mirrorEnd', { caster: w.id });
      }
    }
    // Resonance expiry.
    w.resonance = w.resonance.filter((r) => (r.ticks -= 1) > 0);

    // Sigil decay: one charge decays after inactivity.
    if (w.charges > 0 && (this.tick - w.lastActivityTick) >= sToTicks(SIGIL.decayS)) {
      w.charges = Math.max(0, w.charges - 1);
      w.lastActivityTick = this.tick;
      this.emit('chargeDecay', { caster: w.id });
    }
  }

  // Age zones, reaction cooldowns, and trigger Snare traps on entry.
  updateZones() {
    for (const name of Object.keys(this.reactionCooldowns)) {
      if (this.reactionCooldowns[name] > 0) this.reactionCooldowns[name] -= 1;
    }
    for (const z of this.zones) {
      // Snare: root a non-owner who crosses into the trap, once, then consume.
      if (z.kind === 'Snare' && z.ticks > 0) {
        for (const w of this.wizards) {
          if (w.id === z.owner) continue;
          const inside = this.wizardInZone(w, z);
          if (inside && this.hasBarrier(w)) continue;
          if (inside && !w.snaredZones.has(z.id)) {
            w.snaredZones.add(z.id);
            this.applyStatus(w, 'Rooted', 1, { durationS: ZONE.snareRootS });
            this.emit('snare', { target: w.id, zone: z.id });
            z.ticks = 0; // trap consumed
          }
        }
      }
    }
    const kept = [];
    for (const z of this.zones) {
      z.ticks -= 1;
      if (z.ticks > 0) kept.push(z);
      else this.emit('zoneEnd', { id: z.id, kind: z.kind, reason: 'expired' });
    }
    this.zones = kept;
  }

  updateWeatherExposure() {
    const raining = this.zones.some((zone) => zone.kind === 'Wet' && zone.ticks > 0);
    const threshold = sToTicks(ZONE.soakAfterS);
    for (const wizard of this.wizards) {
      if (!raining) {
        wizard.wetExposureTicks = 0;
        continue;
      }
      if (this.hasBarrier(wizard)) {
        wizard.wetExposureTicks = 0;
        continue;
      }
      if (wizard.statuses.Burning) {
        delete wizard.statuses.Burning;
        this.emit('statusEnd', { target: wizard.id, status: 'Burning' });
      }
      if (this.hasStatus(wizard, 'Soaked')) {
        wizard.wetExposureTicks = threshold;
        wizard.statuses.Soaked.ticks = Math.max(wizard.statuses.Soaked.ticks, sToTicks(STATUSES.Soaked.durationS));
        continue;
      }
      wizard.wetExposureTicks += 1;
      if (wizard.wetExposureTicks >= threshold) {
        if (wizard.statuses.Wet) {
          delete wizard.statuses.Wet;
          this.emit('statusEnd', { target: wizard.id, status: 'Wet' });
        }
        this.applyStatus(wizard, 'Soaked', 1);
        this.emit('weatherSoaked', { target: wizard.id });
      } else if (wizard.statuses.Wet) {
        wizard.statuses.Wet.ticks = Math.max(wizard.statuses.Wet.ticks, sToTicks(STATUSES.Wet.durationS));
      } else {
        this.applyStatus(wizard, 'Wet', 1);
      }
    }
  }

  applyIntent(w, intent) {
    if (!intent) return;
    const canAct = this.canAct(w);
    const rooted = this.hasStatus(w, 'Rooted') || this.hasStatus(w, 'Frozen');
    const knockedDown = this.hasStatus(w, 'KnockedDown');
    const wantsOther = !!(intent.sidestep || intent.brace || intent.cast != null);
    if (!intent.focus) this.clearActionReject(w, 'focus');
    if (!intent.brace) this.clearActionReject(w, 'brace');
    if (!intent.move) this.clearActionReject(w, 'move');
    if (!intent.sidestep) this.clearActionReject(w, 'sidestep');

    // --- Focus (hold to gain a Sigil Charge) ---
    if (intent.focus) {
      let reason = null;
      if (wantsOther) reason = 'conflict';
      else if (this.hasStatus(w, 'Frozen')) reason = 'frozen';
      else if (this.hasStatus(w, 'Stunned')) reason = 'stunned';
      else if (w.channel) reason = 'channeling';
      else if (w.casting) reason = 'casting';
      else if (w.recoveryTicks > 0) reason = 'recovery';
      else if (rooted) reason = 'rooted';
      else if (knockedDown) reason = 'knocked-down';

      if (reason) {
        this.rejectAction(w, 'focus', reason, {
          recoverySeconds: w.recoveryTicks / TICK_HZ,
        });
        if (w.focusing) {
          w.focusing = false; w.focusTicks = 0;
          this.emit('focusCancel', { caster: w.id, reason });
        }
      } else if (this.spendStamina(w, STAMINA.focusPerS * DT)) {
        if (!w.focusing) { w.focusing = true; w.focusTicks = 0; this.emit('focusStart', { caster: w.id }); }
        if (w.charges < SIGIL.max) w.focusTicks += 1;
        else w.focusTicks = 0;
        w.lastActivityTick = this.tick;
        if (w.charges < SIGIL.max && w.focusTicks >= sToTicks(FOCUS.channelS)) {
          w.charges = Math.min(SIGIL.max, w.charges + 1);
          w.focusing = w.charges >= SIGIL.max;
          w.focusTicks = 0;
          this.emit('focusComplete', { caster: w.id, charges: w.charges });
        }
      } else {
        this.rejectAction(w, 'focus', 'stamina', {
          required: STAMINA.focusPerS * DT,
          available: w.stamina,
        });
        if (w.focusing) {
          w.focusing = false; w.focusTicks = 0;
          this.emit('focusCancel', { caster: w.id, reason: 'stamina' });
        }
      }
    } else if (w.focusing) {
      // Any other action interrupts the focus channel.
      w.focusing = false; w.focusTicks = 0;
      this.emit('focusCancel', { caster: w.id });
    }

    // --- Brace ---
    if (intent.brace) {
      let reason = null;
      if (this.hasStatus(w, 'Frozen')) reason = 'frozen';
      else if (this.hasStatus(w, 'Stunned')) reason = 'stunned';
      else if (knockedDown) reason = 'knocked-down';
      else if (w.channel) reason = 'channeling';
      else if (w.focusing) reason = 'focusing';

      if (reason) {
        this.rejectAction(w, 'brace', reason);
      } else if (this.spendStamina(w, STAMINA.bracePerS * DT)) {
        const wasBracing = w.braceTicks > 0;
        w.braceTicks = Math.max(2, sToTicks(BRACE.durationS));
        if (!wasBracing) this.emit('brace', { caster: w.id });
      } else {
        w.braceTicks = 0;
        this.rejectAction(w, 'brace', 'stamina', {
          required: STAMINA.bracePerS * DT,
          available: w.stamina,
        });
      }
    }

    // --- Movement ---
    const limit = Math.max(0.1, 1 - this.pressureLevel * 0.12);
    if (intent.move) {
      let reason = null;
      if (this.hasStatus(w, 'Frozen')) reason = 'frozen';
      else if (this.hasStatus(w, 'Stunned')) reason = 'stunned';
      else if (w.channel) reason = 'channeling';
      else if (rooted) reason = 'rooted';
      else if (knockedDown) reason = 'knocked-down';
      else if (w.focusing || intent.focus) reason = 'focusing';

      const speed = MOVE.speedPerS * (1 - this.moveSlow(w)) * DT;
      const nextPos = Math.max(-limit, Math.min(limit, w.arcPos + Math.sign(intent.move) * speed));
      if (!reason && Math.abs(nextPos - w.arcPos) < 1e-9) reason = 'boundary';

      if (reason === 'boundary') {
        // Holding toward the edge is normal joystick behavior, not an error.
      } else if (reason) {
        this.rejectAction(w, 'move', reason);
      } else if (this.spendStamina(w, STAMINA.movePerS * DT)) {
        w.arcPos = nextPos;
        w.movedThisTick = true;
      } else {
        this.rejectAction(w, 'move', 'stamina', {
          required: STAMINA.movePerS * DT,
          available: w.stamina,
        });
      }
    }

    if (intent.sidestep) {
      let reason = null;
      if (this.hasStatus(w, 'Frozen')) reason = 'frozen';
      else if (this.hasStatus(w, 'Stunned')) reason = 'stunned';
      else if (w.channel) reason = 'channeling';
      else if (rooted) reason = 'rooted';
      else if (knockedDown) reason = 'knocked-down';
      else if (w.focusing || intent.focus) reason = 'focusing';
      else if (w.sidestepCharges <= 0) reason = 'no-dodges';

      const nextPos = Math.max(-limit, Math.min(
        limit,
        w.arcPos + Math.sign(intent.sidestep) * SIDESTEP.arcDelta,
      ));
      if (!reason && Math.abs(nextPos - w.arcPos) < 1e-9) reason = 'boundary';

      if (reason === 'boundary') {
        // An outward Dodge at the arena edge simply does not fire.
      } else if (reason) {
        this.rejectAction(w, 'sidestep', reason);
      } else if (this.spendStamina(w, STAMINA.dodgeCost)) {
        w.sidestepCharges -= 1;
        w.sidestepTimers.push(sToTicks(SIDESTEP.rechargeS));
        w.arcPos = nextPos;
        w.movedThisTick = true;
        this.emit('sidestep', { caster: w.id });
      } else {
        this.rejectAction(w, 'sidestep', 'stamina', {
          required: STAMINA.dodgeCost,
          available: w.stamina,
        });
      }
    }
    // Arcane Pressure narrows the safe arc; clamp within the shrinking window.
    w.arcPos = Math.max(-limit, Math.min(limit, w.arcPos));

    // --- Cast (edge-triggered) ---
    if (intent.cast != null) {
      const ok = this.beginCast(w, intent.cast, intent.castQuality, intent.targetPos);
      if (!ok && intent.castWasGesture) {
        const noPenalty = new Set(['frozen', 'stunned', 'channeling', 'casting', 'focusing', 'recovery']);
        if (!noPenalty.has(this.lastCastReject?.reason)) {
          // A rejected deliberate trace incurs recovery but no Aether cost.
          w.recoveryTicks = Math.max(w.recoveryTicks, sToTicks(CAST.rejectRecoveryS));
        }
        w.castsRejected += 1;
      }
    } else if (intent.castReject != null && canAct && !w.casting && !w.channel && w.recoveryTicks <= 0) {
      // A modelled failed gesture (Practice AI whose sampled gesture score fell
      // below the recognizer threshold). It receives the SAME reject recovery and
      // rejection counter a human's below-threshold trace would (§16) — never an
      // Aether cost and never a cast.
      w.recoveryTicks = Math.max(w.recoveryTicks, sToTicks(CAST.rejectRecoveryS));
      w.castsRejected += 1;
      this.emit('castRejected', { caster: w.id, spellId: intent.castReject });
    }
  }

  advanceCasting(w) {
    if (!w.casting) return;
    if (!this.canAct(w)) { // hard control cancels an in-progress cast
      this.emit('castCanceled', { caster: w.id, spellId: w.casting.spellId });
      w.casting = null;
      return;
    }
    w.casting.ticks -= 1;
    if (w.casting.ticks <= 0) this.resolveCast(w);
  }

  updatePressure() {
    if (!this.rules.pressure) return;
    if (this.timeS >= MATCH.arcanePressureStartS) {
      const steps = 1 + Math.floor((this.timeS - MATCH.arcanePressureStartS) / MATCH.arcanePressureStepS);
      if (steps !== this.pressureLevel) {
        this.pressureLevel = steps;
        this.emit('arcanePressure', { level: steps });
      }
    }
    if (this.timeS >= MATCH.lateRoundS && !this.healingDisabled) {
      this.healingDisabled = true;
      this.emit('lateRound', {});
    }
  }

  endMatch(winner, reason) {
    if (this.ended) return;
    this.ended = true;
    this.winner = winner;
    this.endReason = reason;
    this.emit('roundEnd', { winner, reason });
  }

  resolveTimer() {
    const [a, b] = this.wizards;
    let winner;
    if (a.health > b.health) winner = 0;
    else if (b.health > a.health) winner = 1;
    else if (a.damageDealt > b.damageDealt) winner = 0;
    else if (b.damageDealt > a.damageDealt) winner = 1;
    else winner = 'draw';
    this.endMatch(winner, 'timer');
  }

  // -------------------------------------------------------------------- step
  refreshSandbox() {
    if (!this.rules.sandbox) return;
    for (const w of this.wizards) {
      w.health = MATCH.startHealth;
      w.aether = AETHER.max;
      w.stamina = STAMINA.max;
      w.charges = SIGIL.max;
      w.sidestepCharges = SIDESTEP.charges;
      if (!this.rules.sandboxCooldowns) {
        for (const id of Object.keys(w.cooldowns)) w.cooldowns[id] = 0;
        if (!w.casting && !w.channel) w.recoveryTicks = 0;
      }
    }
  }

  setSandboxCooldowns(enabled) {
    if (!this.rules.sandbox) return;
    this.rules.sandboxCooldowns = !!enabled;
    // Switching the lab mode starts a fresh cooldown exercise rather than
    // carrying a hidden recovery/cooldown from the previous setting.
    for (const w of this.wizards) {
      for (const id of Object.keys(w.cooldowns)) w.cooldowns[id] = 0;
      if (!w.casting && !w.channel) w.recoveryTicks = 0;
    }
  }

  step(intents = {}) {
    if (this.ended) return this.events.splice(0);
    this.events = [];
    this.refreshSandbox();
    this.tick += 1;
    this.timeS = this.tick * DT;

    // 1. Timers / regen / status ticks / zones.
    const regenerationBlocked = this.wizards.map((w) => this.isHardControlled(w));
    for (const w of this.wizards) {
      this.updateWizardTimers(w);
      this.tickStatuses(w);
    }
    this.updateZones();
    this.updateWeatherExposure();
    if (this.ended) return this.events.splice(0);

    // 2. Pressure state.
    this.updatePressure();

    // 3. Intents (deterministic wizard order).
    this.wizards[0].movedThisTick = false;
    this.wizards[1].movedThisTick = false;
    this.applyIntent(this.wizards[0], intents[0]);
    this.applyIntent(this.wizards[1], intents[1]);
    this.regenerateStamina(this.wizards[0], regenerationBlocked[0]);
    this.regenerateStamina(this.wizards[1], regenerationBlocked[1]);
    this.updateFacings();

    // 4. Advance casts + channels.
    this.advanceCasting(this.wizards[0]);
    this.advanceCasting(this.wizards[1]);
    this.advanceChannel(this.wizards[0]);
    this.advanceChannel(this.wizards[1]);
    if (this.ended) return this.events.splice(0);

    // 5. Advance projectiles / resolve hits.
    this.advanceProjectiles();
    if (this.ended) return this.events.splice(0);

    // 6. Round timer.
    if (this.rules.timer && this.timeS >= MATCH.roundLimitS) this.resolveTimer();

    return this.events.splice(0);
  }

  // --------------------------------------------------------------- snapshot
  snapshot() {
    return {
      tick: this.tick,
      timeS: this.timeS,
      ended: this.ended,
      winner: this.winner,
      endReason: this.endReason,
      pressureLevel: this.pressureLevel,
      projectiles: this.projectiles.map((p) => ({
        id: p.id, owner: p.owner, spellId: p.spellId, ticks: p.ticks,
        totalTicks: p.totalTicks, originPos: p.originPos, targetPos: p.targetPos,
      })),
      zones: this.zones.map((z) => ({
        id: z.id, owner: z.owner, kind: z.kind, center: z.center, radius: z.radius,
        ticks: z.ticks, totalTicks: z.totalTicks, hp: z.hp,
      })),
      wizards: this.wizards.map((w) => ({
        id: w.id, health: w.health, aether: w.aether, stamina: w.stamina, charges: w.charges,
        arcPos: w.arcPos, facing: w.facing, casting: w.casting ? {
          spellId: w.casting.spellId, ticks: w.casting.ticks,
          totalTicks: w.casting.totalTicks, targetPos: w.casting.targetPos,
          empowered: !!w.casting.empowered, durationScale: w.casting.durationScale,
        } : null,
        channel: w.channel ? { spellId: w.channel.spellId, ticks: w.channel.ticks, totalTicks: w.channel.totalTicks } : null,
        focusing: w.focusing, focusTicks: w.focusTicks, braceTicks: w.braceTicks,
        shield: w.shield ? { absorb: w.shield.absorb, ticks: w.shield.ticks } : null,
        barrier: w.barrier ? { absorb: w.barrier.absorb, ticks: w.barrier.ticks } : null,
        reflectTicks: w.reflectTicks, tenacityTicks: w.tenacityTicks,
        deflectTicks: w.deflectTicks,
        evadeTicks: w.evadeTicks, invisibleTicks: w.invisibleTicks, mirrorTicks: w.mirrorTicks,
        mirrorPos: w.mirrorPos, mirrorDir: w.mirrorDir,
        wetExposureTicks: w.wetExposureTicks,
        staminaIdleTicks: w.staminaIdleTicks,
        sidestepCharges: w.sidestepCharges, recoveryTicks: w.recoveryTicks,
        statuses: Object.fromEntries(Object.entries(w.statuses).map(([k, v]) => [k, { stacks: v.stacks, ticks: v.ticks }])),
        cooldowns: { ...w.cooldowns }, resonance: w.resonance.map((r) => r.school),
        damageDealt: w.damageDealt, castsResolved: w.castsResolved,
      })),
    };
  }

  // Stable FNV-1a hash of quantized state for divergence checks / replay tests.
  hash() {
    const q = (x, s) => Math.round(x * s);
    const parts = [
      this.tick, this.ended ? 1 : 0, this.winner ?? 'n',
      this.timerTicks, this.pressureLevel,
      this.healingDisabled ? 1 : 0, this.nextProjectileId, this.nextZoneId,
    ];
    for (const w of this.wizards) {
      parts.push(
        q(w.health, 100), q(w.aether, 100), q(w.stamina, 10000), q(w.charges, 2),
        q(w.arcPos, 1000), q(w.facing, 1000),
        w.casting ? w.casting.spellId : 0, w.casting ? w.casting.ticks : 0,
        w.casting ? w.casting.totalTicks : 0,
        w.casting ? q(w.casting.quality, 1000) : 0,
        w.casting && w.casting.targetPos != null ? 1 : 0,
        w.casting && w.casting.targetPos != null ? q(w.casting.targetPos, 1000) : 0,
        w.casting?.empowered ? 1 : 0,
        w.casting ? q(w.casting.durationScale || 1, 100) : 0,
        w.channel ? w.channel.spellId : 0, w.channel ? w.channel.ticks : 0,
        w.channel ? w.channel.totalTicks : 0, w.channel ? q(w.channel.perTick, 10000) : 0,
        w.channel?.staticApplied ? 1 : 0,
        w.focusing ? 1 : 0, w.focusTicks, w.braceTicks, w.reflectTicks, w.tenacityTicks,
        w.deflectTicks, w.evadeTicks, w.invisibleTicks, w.mirrorTicks,
        q(w.mirrorPos, 1000), w.mirrorDir,
        w.wetExposureTicks, w.staminaIdleTicks,
        w.shield ? q(w.shield.absorb, 100) : 0, w.shield ? w.shield.ticks : 0,
        w.barrier ? q(w.barrier.absorb, 100) : 0, w.barrier ? w.barrier.ticks : 0,
        w.sidestepCharges, w.recoveryTicks, w.lastActivityTick, w.phoenixUsed ? 1 : 0,
        q(w.damageDealt, 100), w.castsResolved,
      );
      if (w.channel) {
        for (const [k, v] of Object.entries(w.channel.utility || {}).sort()) parts.push('cu', k, v);
      }
      for (const [k, v] of Object.entries(w.statuses).sort()) parts.push(k, v.stacks, v.ticks);
      for (const [k, v] of Object.entries(w.cooldowns).sort()) if (v > 0) parts.push('cd', k, v);
      for (const [k, v] of Object.entries(w.actionRejectKeys).sort()) parts.push('ar', k, v);
      for (const r of w.resonance) parts.push('res', r.school, r.ticks);
      for (const t of w.sidestepTimers) parts.push('side', t);
      for (const t of w.knockbackTimes) parts.push('knock', t);
      for (const id of [...w.snaredZones].sort((a, b) => a - b)) parts.push('snare', id);
    }
    for (const [k, v] of Object.entries(this.reactionCooldowns).sort()) parts.push('rc', k, v);
    parts.push('rng', this.rng.getState ? this.rng.getState() : this.rng.seed);
    for (const p of this.projectiles) {
      parts.push('p', p.id, p.owner, p.spellId, q(p.ticks, 100), p.totalTicks,
        q(p.originPos, 1000), q(p.targetPos, 1000), q(p.quality, 1000));
    }
    for (const z of this.zones.slice().sort((a, b) => a.id - b.id)) {
      parts.push('z', z.id, z.owner, z.kind, z.ticks, z.totalTicks,
        q(z.center, 1000), q(z.radius, 1000), q(z.hp || 0, 100));
    }
    const str = parts.join('|');
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
}

export { sToTicks };
