// match.js — headless match + best-of-three series harness tying the pure Sim
// to two intent sources.
//
// Used by tests, the balance runner, and the offline client (bot duel /
// practice). Intent sources are functions (sim) => intent; a DuelBot's `act`
// method fits directly. Runs to a natural end (health/timer) with a hard tick
// cap safety net so a match can never hang.

import { Sim } from './sim.js';
import { starterLoadout } from '../balance/loadouts.js';
import { TICK_HZ, MATCH } from './constants.js';

const HARD_TICK_CAP = Math.ceil((MATCH.roundLimitS + 2) * TICK_HZ);

export function createMatch(opts = {}) {
  const loadouts = opts.loadouts || [starterLoadout(), starterLoadout()];
  return new Sim({ seed: opts.seed ?? 12345, loadouts });
}

// sources: [fn0, fn1] each (sim) => intent. Returns a result summary.
export function runMatch(sim, sources, opts = {}) {
  const cap = opts.tickCap || HARD_TICK_CAP;
  const collectEvents = opts.collectEvents ? [] : null;
  let steps = 0;
  while (!sim.ended && steps < cap) {
    const intents = {
      0: sources[0] ? sources[0](sim) : {},
      1: sources[1] ? sources[1](sim) : {},
    };
    const evs = sim.step(intents);
    if (collectEvents) for (const e of evs) collectEvents.push(e);
    steps += 1;
  }
  return {
    ended: sim.ended,
    winner: sim.winner,
    endReason: sim.endReason,
    ticks: sim.tick,
    timeS: sim.timeS,
    health: [sim.wizards[0].health, sim.wizards[1].health],
    hitCap: steps >= cap,
    events: collectEvents,
  };
}

// --- Best-of-three series (MASTERPLAN §3) --------------------------------
// A series preserves both loadouts across rounds; arena zones, statuses, and
// resources reset each round (a fresh Sim). First to 2 round wins takes the
// series. Draw rounds award neither player a point.
export const SERIES = { roundsToWin: 2, maxRounds: 3 };

export class Series {
  constructor(opts = {}) {
    this.loadouts = opts.loadouts || [starterLoadout(), starterLoadout()];
    this.baseSeed = (opts.seed ?? 12345) >>> 0;
    this.score = [0, 0];
    this.roundIndex = 0;
    this.rounds = [];        // per-round result summaries
    this.winner = null;      // 0 | 1 | 'draw' | null (series decided)
    this.sim = null;
  }

  get decided() {
    return this.score[0] >= SERIES.roundsToWin || this.score[1] >= SERIES.roundsToWin
      || this.roundIndex >= SERIES.maxRounds;
  }

  // Build (or rebuild) the Sim for the current round, preserving loadouts.
  newRoundSim() {
    // Derive a distinct-but-deterministic seed per round.
    const seed = (this.baseSeed + this.roundIndex * 0x9e3779b9) >>> 0;
    this.sim = new Sim({ seed, loadouts: this.loadouts });
    return this.sim;
  }

  // Record a completed round's outcome and advance the score.
  recordRound(result) {
    this.rounds.push(result);
    if (result.winner === 0) this.score[0] += 1;
    else if (result.winner === 1) this.score[1] += 1;
    this.roundIndex += 1;
    if (this.score[0] >= SERIES.roundsToWin) this.winner = 0;
    else if (this.score[1] >= SERIES.roundsToWin) this.winner = 1;
    else if (this.roundIndex >= SERIES.maxRounds) {
      // Series exhausted without a clean 2-0/2-1: higher score wins, else draw.
      this.winner = this.score[0] > this.score[1] ? 0 : this.score[1] > this.score[0] ? 1 : 'draw';
    }
    return { score: [...this.score], decided: this.decided, seriesWinner: this.winner };
  }
}

// Run a whole best-of-three headlessly. `makeSources(sim, roundIndex)` returns
// [fn0, fn1] fresh each round (e.g. new bots seeded per round).
export function runSeries(opts = {}) {
  const series = new Series(opts);
  while (!series.decided) {
    const sim = series.newRoundSim();
    const sources = opts.makeSources
      ? opts.makeSources(sim, series.roundIndex)
      : [() => ({}), () => ({})];
    const result = runMatch(sim, sources, { tickCap: opts.tickCap });
    series.recordRound(result);
  }
  return {
    winner: series.winner,
    score: series.score,
    rounds: series.rounds,
    roundsPlayed: series.roundIndex,
  };
}
