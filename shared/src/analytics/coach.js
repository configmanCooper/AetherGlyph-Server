// coach.js — pure post-round coaching reducer (SOLO-MODES-PLAN §20).
//
// Given a NON-DRAINING log of the round's Sim events (plus small end-state facts)
// it produces a local coaching report from the PLAYER's perspective. It is a pure
// function of its input: no DOM, no randomness, no Sim, and — critically — it
// stores and reads NO raw gesture traces (only discrete domain events). The same
// reducer runs in the browser and in tests.
//
// The report always surfaces exactly ONE primary recommendation and ONE positive
// behaviour to reinforce, plus a structured breakdown the UI renders in summary
// or detailed form. Assisted (template-on) rounds are flagged so they are marked
// assisted and excluded from difficulty-comparison statistics by the caller.

import { SPELLS_BY_ID } from '../balance/spellData.generated.js';

const SETUP_STATUSES = new Set(['Marked', 'Sundered', 'Soaked']);
const spellName = (id) => SPELLS_BY_ID[id]?.name || `spell ${id}`;

// A setup status → the spell that primes it, for actionable advice.
const SETUP_HINT = {
  Marked: 'apply Amplify, then land a heavy hit before it fades',
  Chilled: 'land Frost Lance to Chill first',
  Sundered: 'follow Sunder with your biggest hit',
  Soaked: 'answer a Wet target with lightning quickly',
};

// Reduce the round's events + end facts into a coaching report.
export function coachReport(log = {}) {
  const P = log.playerId ?? 0;
  const B = log.botId ?? 1;
  const events = Array.isArray(log.events) ? log.events : [];
  const assisted = !!log.assisted;

  const r = {
    difficulty: log.difficulty || null,
    assisted,
    outcome: outcomeFor(log, P),
    casting: { acceptedBySpell: {}, accepted: 0, rejected: 0, rejectedBySpell: {}, fizzledBySpell: {} },
    damageDealt: 0,
    damageTaken: 0,
    aetherSpent: 0,
    damagePerAether: 0,
    defensiveUsed: 0,
    defensiveMissed: 0,
    blockedDamage: Math.max(0, Math.round(log.blockedDamage || 0)),
    focusCompletes: 0,
    focusInterruptedByOpp: 0,
    chargesUnused: Math.max(0, Math.round(log.finalCharges || 0)),
    chargeDecays: 0,
    setupsConsumed: 0,
    setupsExpired: 0,
    zonesCreated: 0,
    zonesExploited: 0,
    countersLanded: 0,
    lines: [],
    recommendation: '',
    reinforcement: '',
  };

  // Track the opponent's live setup statuses so we can tell a consumed setup from
  // one that expired unused (a Mark that landed a hit vs. a Mark that faded).
  const oppSetupActive = {}; // status -> { consumed: bool }

  for (const e of events) {
    switch (e.type) {
      case 'cast':
        if (e.caster === P) {
          r.casting.accepted += 1;
          r.casting.acceptedBySpell[e.spellId] = (r.casting.acceptedBySpell[e.spellId] || 0) + 1;
          r.aetherSpent += SPELLS_BY_ID[e.spellId]?.aether || 0;
        }
        break;
      case 'castRejected':
        if (e.caster === P) {
          r.casting.rejected += 1;
          r.casting.rejectedBySpell[e.spellId] = (r.casting.rejectedBySpell[e.spellId] || 0) + 1;
        }
        break;
      case 'hexFizzle':
        if (e.caster === P) r.casting.fizzledBySpell[e.spellId] = (r.casting.fizzledBySpell[e.spellId] || 0) + 1;
        break;
      case 'damage':
        if (e.target === B) {
          r.damageDealt += e.amount || 0;
          for (const s of Object.keys(oppSetupActive)) oppSetupActive[s].consumed = true;
        } else if (e.target === P) {
          r.damageTaken += e.amount || 0;
          r.defensiveMissed += 1;
        }
        break;
      case 'status':
        if (e.target === B && SETUP_STATUSES.has(e.status)) oppSetupActive[e.status] = { consumed: false };
        break;
      case 'statusEnd':
        if (e.target === B && oppSetupActive[e.status]) {
          if (oppSetupActive[e.status].consumed) r.setupsConsumed += 1; else r.setupsExpired += 1;
          delete oppSetupActive[e.status];
        }
        break;
      case 'shield': case 'barrier': case 'brace': case 'sidestep': case 'blink':
        if (e.caster === P) r.defensiveUsed += 1;
        break;
      case 'reflect':
        if (e.by === P) { r.defensiveUsed += 1; r.countersLanded += 1; }
        break;
      case 'deflect':
        if (e.by === P) { r.defensiveUsed += 1; r.countersLanded += 1; }
        break;
      case 'miss':
        if (e.target === P) r.defensiveUsed += 1; // a dodged/evaded shot
        break;
      case 'interrupt':
        if (e.target === B) r.countersLanded += 1;
        break;
      case 'hardControl':
        if (e.target === B) r.countersLanded += 1;
        break;
      case 'dispel':
        if (e.caster === P && (typeof e.removed === 'string' || e.removedZone)) r.defensiveUsed += 1;
        break;
      case 'focusComplete':
        if (e.caster === P) r.focusCompletes += 1;
        break;
      case 'focusInterrupt':
        if (e.target === P) r.focusInterruptedByOpp += 1;
        break;
      case 'chargeDecay':
        if (e.caster === P) r.chargeDecays += 1;
        break;
      case 'zone':
        if (e.owner === P) r.zonesCreated += 1;
        break;
      case 'reaction':
        if (e.casterId === P) r.zonesExploited += 1;
        break;
      default: break;
    }
  }

  const totalCasts = r.casting.accepted + r.casting.rejected;
  r.acceptRate = totalCasts > 0 ? r.casting.accepted / totalCasts : 1;
  r.damageDealt = Math.round(r.damageDealt);
  r.damageTaken = Math.round(r.damageTaken);
  r.aetherSpent = Math.round(r.aetherSpent);
  r.damagePerAether = r.aetherSpent > 0 ? +(r.damageDealt / r.aetherSpent).toFixed(2) : 0;

  r.lines = buildLines(r);
  r.recommendation = pickRecommendation(r);
  r.reinforcement = pickReinforcement(r);
  return r;
}

function outcomeFor(log, P) {
  if (log.winner === P) return 'win';
  if (log.winner === 'draw' || log.winner == null) return 'draw';
  return 'loss';
}

function buildLines(r) {
  const lines = [];
  lines.push(`Casts accepted ${r.casting.accepted}, rejected ${r.casting.rejected} (${Math.round(r.acceptRate * 100)}% accuracy).`);
  lines.push(`Damage dealt ${r.damageDealt}, taken ${r.damageTaken}; ${r.damagePerAether} damage per Aether spent.`);
  lines.push(`Defensive plays used ${r.defensiveUsed}; hits taken ${r.defensiveMissed}; ${r.blockedDamage} damage blocked.`);
  lines.push(`Focus completed ${r.focusCompletes}${r.focusInterruptedByOpp ? `, interrupted ${r.focusInterruptedByOpp}` : ''}; ${r.chargesUnused} charge(s) unspent${r.chargeDecays ? `, ${r.chargeDecays} decayed` : ''}.`);
  lines.push(`Setups cashed in ${r.setupsConsumed}, let expire ${r.setupsExpired}; zones created ${r.zonesCreated}, reactions ${r.zonesExploited}; counters landed ${r.countersLanded}.`);
  if (r.assisted) lines.push('Template assistance was on — this round is marked assisted and excluded from difficulty stats.');
  return lines;
}

function pickRecommendation(r) {
  // 1. A hex fizzled without its setup (e.g. Frost Bind without Chilled).
  const fizzled = topEntry(r.casting.fizzledBySpell);
  if (fizzled && fizzled[1] >= 1) {
    const id = Number(fizzled[0]);
    return `${spellName(id)} fizzled ${fizzled[1]}×; land its setup first (${SETUP_HINT.Chilled}).`;
  }
  // 2. Many rejected casts — accuracy problem.
  if (r.casting.rejected >= 2 && r.acceptRate < 0.7) {
    return `${r.casting.rejected} casts were rejected. Start each glyph on the dot and follow the shown direction.`;
  }
  // 3. Charges wasted to decay.
  if (r.chargeDecays >= 1) {
    return `You let ${r.chargeDecays} Sigil Charge(s) decay. Spend charges on a charged spell before they fade.`;
  }
  // 4. Setups left to expire.
  if (r.setupsExpired >= 1) {
    return `You applied ${r.setupsExpired} setup(s) but never cashed them in — ${SETUP_HINT.Marked}.`;
  }
  // 5. Took many unanswered hits.
  if (r.defensiveMissed >= 4 && r.defensiveMissed > r.defensiveUsed) {
    return `You took ${r.defensiveMissed} unanswered hits. Ward, Gust, or dodge more incoming projectiles.`;
  }
  // 6. Poor damage economy.
  if (r.aetherSpent >= 40 && r.damagePerAether < 0.35) {
    return `Damage per Aether was low (${r.damagePerAether}). Favour efficient pokes and avoid overspending.`;
  }
  // 7. Fallback by outcome.
  if (r.outcome === 'loss') return 'Defend the key threats first, then answer with your own pressure.';
  return 'Keep converting your setups into committed hits.';
}

function pickReinforcement(r) {
  if (r.blockedDamage >= 20 || (r.defensiveUsed >= 3 && r.defensiveUsed > r.defensiveMissed)) {
    return `Your defenses answered ${r.defensiveUsed} threats (${r.blockedDamage} blocked). Keep reading incoming shots.`;
  }
  if (r.countersLanded >= 1) {
    return `You landed ${r.countersLanded} counter(s) — reflects, interrupts, and stuns are strong punishes.`;
  }
  if (r.setupsConsumed >= 1) {
    return `You cashed in ${r.setupsConsumed} setup(s). Setup → payoff is exactly the right plan.`;
  }
  if (r.zonesExploited >= 1) {
    return `You triggered ${r.zonesExploited} environment reaction(s). Great use of the arena.`;
  }
  if (r.acceptRate >= 0.85 && (r.casting.accepted + r.casting.rejected) >= 3) {
    return `Your glyph accuracy was ${Math.round(r.acceptRate * 100)}% — clean, confident casting.`;
  }
  if (r.outcome === 'win') return 'You won the round — well-rounded, disciplined play.';
  return 'You kept drawing and pressuring — stay aggressive when it is safe.';
}

function topEntry(map) {
  let best = null;
  for (const [k, v] of Object.entries(map || {})) if (!best || v > best[1]) best = [k, v];
  return best;
}
