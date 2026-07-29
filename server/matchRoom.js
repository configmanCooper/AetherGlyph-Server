// matchRoom.js — one authoritative best-of-three match (MASTERPLAN §16-17).
//
// The server OWNS the simulation. It runs the exact same deterministic shared
// Sim at its fixed tick, validates sequenced intents, reclassifies cast traces
// with the shared Recognizer across the full spell roster, and
// broadcasts personalized authoritative snapshots + domain events at a bounded
// rate. Clients never set health, resources, spell ids, or results.
//
// One process owns each live match. Horizontal scale would require external
// ownership leases + fencing (NOT enabled — see render.yaml / README).

import { Series, SERIES } from '../shared/src/sim/match.js';
import { Recognizer } from '../shared/src/gesture/recognizer.js';
import { buildTemplates } from '../shared/src/gesture/templates.js';
import { validateLoadout, makeLoadout } from '../shared/src/balance/loadouts.js';
import { qualityFromScore } from '../shared/src/gesture/quality.js';
import { EVENTS, ERR } from '../shared/src/protocol/events.js';
import {
  NET, remapSnapshotForSlot, remapEventsForSlot, validateTraceEnvelope,
} from '../shared/src/protocol/net.js';
import { signToken, randomId } from './tokens.js';
import { TokenBucket } from './util.js';
import { PracticeBot } from '../shared/src/bot/practiceBot.js';

const TICK_MS = 1000 / NET.TICK_HZ;
const MAX_CATCHUP = 6;
const INTERMISSION_MS = 2800;
const EMOJI_KINDS = new Set(['smile', 'angry', 'cry', 'laugh']);
const EMOJI_COOLDOWN_MS = 10000;
const EMOJI_DURATION_MS = 2000;

// A single full-roster template set is shared by every match. Building it once
// keeps authoritative classification deterministic + cheap.
const BASE_RECOGNIZER = new Recognizer(buildTemplates());

// Map a recognition quality score to potency via the shared single-source
// mapping (shared/src/gesture/quality.js), so the server, client prediction,
// and Practice AI can never drift apart on potency math.

function freshSeatRuntime() {
  return {
    inputState: { move: 0, focus: false, brace: false },
    lastInputSeq: 0,
    lastCastSeq: 0,
    pendingCast: null,
    pendingReject: false,
    pendingSidestep: 0,
  };
}

export class MatchRoom {
  // opts: { code, ranked, secret, seed, onResult, onClosed, log }
  constructor(seatsInit, opts = {}) {
    this.matchId = randomId(9);
    this.code = opts.code || null;
    this.ranked = !!opts.ranked;
    this.secret = opts.secret;
    this.onResult = opts.onResult || (() => {});
    this.onClosed = opts.onClosed || (() => {});
    this.log = opts.log || (() => {});
    this.graceMs = opts.graceMs; // optional override (default: NET grace constants)
    this.intermissionMs = opts.intermissionMs ?? INTERMISSION_MS;
    this.seed = (opts.seed ?? ((Date.now() & 0x7fffffff))) >>> 0;

    this.seats = seatsInit.map((s, slot) => {
      const loadout = makeLoadout(s.loadoutIds);
      return {
        slot,
        accountId: s.accountId,
        name: s.name || `Wizard ${slot + 1}`,
        glyphs: Number.isFinite(s.glyphs) ? s.glyphs : 100,
        isBot: !!s.isBot,
        botKey: s.botKey || null,
        botDifficulty: s.botDifficulty || null,
        botController: null,
        emojiReadyAt: 0,
        loadoutIds: s.loadoutIds.slice(),
        loadout,
        recognizer: BASE_RECOGNIZER,
        socket: s.socket,
        connected: true,
        epoch: 1,
        nonce: randomId(8),
        disconnectCount: 0,
        graceTimer: null,
        castLimiter: new TokenBucket(NET.MAX_CASTS_PER_SEC, NET.MAX_CASTS_PER_SEC + 1),
        inputLimiter: new TokenBucket(NET.MAX_INPUTS_PER_SEC, NET.MAX_INPUTS_PER_SEC + 10),
        ...freshSeatRuntime(),
      };
    });

    this.series = new Series({ loadouts: this.seats.map((s) => s.loadout), seed: this.seed });
    this.sim = null;
    this.state = 'idle';        // idle | live | intermission | paused | ended
    this.prevState = null;
    this.roundEvents = [];
    this.tickCount = 0;
    this.interval = null;
    this.lastTickTime = 0;
    this.acc = 0;
    this.intermissionTimer = null;
    this.intermissionDeadline = 0;
    this.intermissionRemainingMs = 0;
    this.closed = false;
    this.spectators = new Map();
    this.lastCasts = [null, null];
  }

  seatBySocketId(id) { return this.seats.find((s) => s.socket && s.socket.id === id); }
  otherSlot(slot) { return slot === 0 ? 1 : 0; }

  // ---- lifecycle ---------------------------------------------------------
  start() {
    for (const seat of this.seats) this.sendMatchStart(seat);
    this.beginRound();
    this.lastTickTime = Date.now();
    this.interval = setInterval(() => this.loop(), TICK_MS);
  }

  spectatorInfo() {
    return {
      matchId: this.matchId,
      ranked: this.ranked,
      names: this.seats.map((seat) => seat.name),
      glyphs: this.seats.map((seat) => seat.glyphs),
      score: this.series.score.slice(),
      state: this.state,
      bot: this.seats.some((seat) => seat.isBot),
    };
  }

  addSpectator(socket) {
    if (!socket || this.closed || !this.ranked) return { ok: false, code: ERR.BAD_STATE };
    this.spectators.set(socket.id, socket);
    socket.emit(EVENTS.SPECTATE_START, this.spectatorInfo());
    if (this.sim) {
      socket.emit(EVENTS.SPECTATE_SNAPSHOT, {
        matchId: this.matchId,
        tick: this.sim.tick,
        full: true,
        state: this.sim.snapshot(),
        events: [],
        lastCasts: this.lastCasts.slice(),
      });
    }
    return { ok: true, ...this.spectatorInfo() };
  }

  removeSpectator(socket) {
    if (!socket) return;
    this.spectators.delete(socket.id);
  }

  sendMatchStart(seat) {
    if (!seat.socket) return;
    const opp = this.seats[this.otherSlot(seat.slot)];
    seat.socket.emit(EVENTS.MATCH_START, {
      matchId: this.matchId,
      code: this.code,
      slot: seat.slot,
      epoch: seat.epoch,
      token: this.issueToken(seat),
      ranked: this.ranked,
      series: { roundsToWin: SERIES.roundsToWin, maxRounds: SERIES.maxRounds },
      // Local order: self first, opponent second (client always renders as p0).
      loadouts: [seat.loadoutIds, opp.loadoutIds],
      names: [seat.name, opp.name],
      glyphs: [seat.glyphs, opp.glyphs],
    });
  }

  issueToken(seat) {
    return signToken(this.secret, {
      matchId: this.matchId,
      slot: seat.slot,
      accountId: seat.accountId,
      epoch: seat.epoch,
      nonce: seat.nonce,
      exp: Date.now() + NET.RESUME_TOKEN_TTL_MS,
    });
  }

  beginRound() {
    this.sim = this.series.newRoundSim();
    this.tickCount = 0;
    this.roundEvents = [];
    for (const seat of this.seats) {
      Object.assign(seat, freshSeatRuntime());
      if (seat.isBot) {
        seat.botController = new PracticeBot(seat.slot, {
          difficulty: seat.botDifficulty,
          seed: this.seed ^ ((this.series.roundIndex + 1) * 0x9e3779b9),
        });
      }
    }
    this.state = 'live';
    this.pushEvent({ type: 'roundStart', round: this.series.roundIndex, score: this.series.score.slice() });
    this.broadcastSnapshot(true);
    this.lastTickTime = Date.now();
    this.acc = 0;
  }

  pushEvent(ev) { this.roundEvents.push(ev); }

  scheduleIntermission(delayMs = this.intermissionMs) {
    if (this.intermissionTimer) clearTimeout(this.intermissionTimer);
    const delay = Math.max(0, delayMs);
    this.intermissionDeadline = Date.now() + delay;
    this.intermissionTimer = setTimeout(() => {
      this.intermissionTimer = null;
      this.intermissionDeadline = 0;
      if (this.state === 'intermission') this.beginRound();
    }, delay);
  }

  loop() {
    const now = Date.now();
    if (this.closed || this.state !== 'live') { this.lastTickTime = now; return; }
    // Persistent accumulator: carry leftover time forward so timer jitter does
    // not make the authoritative sim drift behind wall-clock. Cap the backlog
    // to avoid a spiral of death after a long stall.
    this.acc += now - this.lastTickTime;
    this.lastTickTime = now;
    if (this.acc > TICK_MS * MAX_CATCHUP) this.acc = TICK_MS * MAX_CATCHUP;
    while (this.acc >= TICK_MS && this.state === 'live') {
      this.stepOnce();
      this.acc -= TICK_MS;
      if (this.state !== 'live') break;
    }
  }

  stepOnce() {
    const intents = { 0: this.buildIntent(this.seats[0]), 1: this.buildIntent(this.seats[1]) };
    const evs = this.sim.step(intents);
    for (const e of evs) {
      this.roundEvents.push(e);
      if (e.type === 'cast' && (e.caster === 0 || e.caster === 1)) {
        this.lastCasts[e.caster] = e.spellId;
      }
    }
    this.tickCount += 1;
    if (this.sim.ended) { this.handleRoundEnd(); return; }
    if (this.tickCount % NET.SNAPSHOT_EVERY_TICKS === 0) this.broadcastSnapshot(false);
  }

  buildIntent(seat) {
    if (!seat.connected) return {};
    if (seat.isBot) {
      const intent = seat.botController?.act(this.sim) || {};
      if (intent.cast != null || intent.castReject != null) intent.castWasGesture = true;
      return intent;
    }
    const i = seat.inputState;
    const intent = { move: i.move, focus: i.focus, brace: i.brace };
    if (seat.pendingSidestep) { intent.sidestep = seat.pendingSidestep; seat.pendingSidestep = 0; }
    if (seat.pendingCast) {
      intent.cast = seat.pendingCast.spellId;
      intent.castQuality = seat.pendingCast.quality;
      intent.castWasGesture = true;
      seat.pendingCast = null;
    } else if (seat.pendingReject) {
      // A recognizer-rejected trace: sim applies reject recovery, no spell, no
      // Aether cost (id 0 is never in a loadout).
      intent.cast = 0;
      intent.castWasGesture = true;
      seat.pendingReject = false;
    }
    return intent;
  }

  // ---- snapshots ---------------------------------------------------------
  broadcastSnapshot(force) {
    const canon = this.sim.snapshot();
    const events = this.roundEvents;
    this.roundEvents = [];
    for (const seat of this.seats) {
      if (!seat.socket || !seat.connected) continue;
      (force ? seat.socket : seat.socket.volatile).emit(EVENTS.SNAPSHOT, {
        matchId: this.matchId,
        tick: canon.tick,
        epoch: seat.epoch,
        ackSeq: seat.lastInputSeq,
        full: !!force,
        state: remapSnapshotForSlot(canon, seat.slot),
        events: remapEventsForSlot(events, seat.slot),
      });
    }
    for (const spectator of this.spectators.values()) {
      (force ? spectator : spectator.volatile).emit(EVENTS.SPECTATE_SNAPSHOT, {
        matchId: this.matchId,
        tick: canon.tick,
        full: !!force,
        state: canon,
        events,
        lastCasts: this.lastCasts.slice(),
      });
    }
  }

  // ---- round / series outcomes ------------------------------------------
  handleRoundEnd() {
    const winner = this.sim.winner; // 0 | 1 | 'draw'
    const record = this.series.recordRound({
      winner, endReason: this.sim.endReason,
      health: [this.sim.wizards[0].health, this.sim.wizards[1].health],
    });
    // Flush the final round events with the terminal snapshot.
    this.broadcastSnapshot(true);
    for (const seat of this.seats) {
      if (!seat.socket) continue;
      seat.socket.emit(EVENTS.ROUND_END, {
        matchId: this.matchId,
        winner: this.localWinner(winner, seat.slot),
        reason: this.sim.endReason,
        score: this.localScore(seat.slot, record.score),
      });
    }
    if (record.decided) { this.endMatch(this.series.winner, 'series'); return; }
    this.state = 'intermission';
    this.scheduleIntermission();
  }

  endMatch(winnerSlot, reason) {
    if (this.state === 'ended' || this.closed) return;
    this.state = 'ended';
    for (const seat of this.seats) {
      if (!seat.socket) continue;
      seat.socket.emit(EVENTS.MATCH_END, {
        matchId: this.matchId,
        winner: this.localWinner(winnerSlot, seat.slot),
        reason,
        score: this.localScore(seat.slot, this.series.score),
        code: this.code,
        ranked: this.ranked,
      });
    }
    for (const spectator of this.spectators.values()) {
      spectator.emit(EVENTS.SPECTATE_END, {
        matchId: this.matchId,
        winner: winnerSlot,
        reason,
        score: this.series.score.slice(),
      });
      spectator.data.loc = null;
    }
    this.spectators.clear();
    // Glyph persistence is delegated. The match closes immediately; the
    // personalized ranking update follows when the atomic transaction commits.
    try {
      Promise.resolve(this.onResult({
        matchId: this.matchId,
        ranked: this.ranked,
        winnerSlot,
        reason,
        players: this.seats.map((s) => ({
          accountId: s.accountId,
          name: s.name,
          glyphs: s.glyphs,
          isBot: s.isBot,
          botKey: s.botKey,
        })),
      })).then((ranking) => {
        if (!ranking?.ranked || !Array.isArray(ranking.players)) return;
        this.seats.forEach((seat, slot) => {
          if (!seat.socket) return;
          const self = ranking.players[slot];
          const opponent = ranking.players[this.otherSlot(slot)];
          seat.socket.emit(EVENTS.RANKING_UPDATE, {
            ok: true,
            matchId: this.matchId,
            season: ranking.season,
            transfer: ranking.transfer,
            glyphsBefore: self.glyphsBefore,
            glyphsAfter: self.glyphsAfter,
            delta: self.delta,
            rank: self.rank,
            wins: self.wins,
            losses: self.losses,
            draws: self.draws,
            opponentGlyphsBefore: opponent.glyphsBefore,
            opponentGlyphsAfter: opponent.glyphsAfter,
          });
        });
      }).catch((error) => {
        this.log('onResult error', error?.message);
        for (const seat of this.seats) {
          if (seat.socket) {
            seat.socket.emit(EVENTS.RANKING_UPDATE, {
              ok: false,
              matchId: this.matchId,
              code: 'persistence-failed',
            });
          }
        }
      });
    } catch (err) { this.log('onResult error', err && err.message); }
    this.stop('match-complete');
  }

  // 'draw' passes through; a numeric winner is remapped to the seat's local view
  // (self = 0). Returns 'win' | 'loss' | 'draw' for the client result flow.
  localWinner(winnerSlot, slot) {
    if (winnerSlot === 'draw' || winnerSlot == null) return 'draw';
    return winnerSlot === slot ? 'win' : 'loss';
  }

  localScore(slot, score) {
    return slot === 0 ? [score[0], score[1]] : [score[1], score[0]];
  }

  // ---- inbound intents ---------------------------------------------------
  handleInput(slot, env) {
    const seat = this.seats[slot];
    if (!seat || !seat.connected) return;
    if (!seat.inputLimiter.take()) return; // over cadence — drop silently
    if (!env || typeof env !== 'object') return;
    const seq = Math.floor(Number(env.seq));
    if (!Number.isSafeInteger(seq) || seq <= 0 || seq <= seat.lastInputSeq) return; // dup/stale
    seat.lastInputSeq = seq;
    seat.inputState.move = (env.move === -1 || env.move === 1) ? env.move : 0;
    seat.inputState.focus = !!env.focus;
    seat.inputState.brace = !!env.brace;
    if (env.sidestep === -1 || env.sidestep === 1) seat.pendingSidestep = env.sidestep;
  }

  // Returns a clear acknowledgement. The classified spell id is authoritative;
  // clients never send a trusted spell id.
  handleCast(slot, env) {
    const seat = this.seats[slot];
    if (!seat || !seat.connected) return { ok: false, code: ERR.BAD_STATE };
    if (this.state !== 'live') return { ok: false, code: ERR.BAD_STATE };
    if (!seat.castLimiter.take()) return { ok: false, code: ERR.RATE };
    if (!env || typeof env !== 'object') return { ok: false, code: ERR.PAYLOAD };
    const seq = Math.floor(Number(env.seq));
    if (!Number.isSafeInteger(seq) || seq <= 0) return { ok: false, code: ERR.PAYLOAD };
    if (seq <= seat.lastCastSeq) return { ok: false, code: ERR.STALE };
    seat.lastCastSeq = seq;

    const shape = validateTraceEnvelope(env);
    if (!shape.ok) return { ok: false, code: shape.code };

    // Authoritative full-roster reclassification. The submitted eight-spell set
    // is a guide shortcut layout, not a cast eligibility list.
    const diag = seat.recognizer.recognize(env.points);
    if (!diag.accepted) {
      seat.pendingReject = true; // sim applies the 0.25s reject recovery
      const code = diag.reason === 'ambiguous' ? ERR.AMBIGUOUS
        : diag.reason === 'below-threshold' ? ERR.BELOW : ERR.MALFORMED;
      return { ok: false, code, spellId: null };
    }
    seat.pendingCast = { spellId: diag.spellId, quality: qualityFromScore(diag.best.score) };
    return { ok: true, accepted: true, spellId: diag.spellId };
  }

  handleEmoji(slot, payload) {
    const seat = this.seats[slot];
    if (!seat || seat.isBot || !seat.connected || this.state !== 'live') {
      return { ok: false, code: ERR.BAD_STATE };
    }

    const kind = String(payload?.kind || '');
    if (!EMOJI_KINDS.has(kind)) return { ok: false, code: ERR.PAYLOAD };
    const now = Date.now();
    if (seat.emojiReadyAt > now) {
      return {
        ok: false,
        code: ERR.RATE,
        cooldownMs: seat.emojiReadyAt - now,
      };
    }
    seat.emojiReadyAt = now + EMOJI_COOLDOWN_MS;
    for (const recipient of this.seats) {
      if (!recipient.socket) continue;
      recipient.socket.emit(EVENTS.EMOJI_EVENT, {
        matchId: this.matchId,
        sender: recipient.slot === slot ? 0 : 1,
        kind,
        durationMs: EMOJI_DURATION_MS,
        cooldownMs: EMOJI_COOLDOWN_MS,
      });
    }
    this.broadcastEmojiToSpectators(slot, kind, EMOJI_DURATION_MS);
    return { ok: true, cooldownMs: EMOJI_COOLDOWN_MS };
  }

  broadcastEmojiToSpectators(sender, kind, durationMs) {
    for (const spectator of this.spectators.values()) {
      spectator.emit(EVENTS.EMOJI_EVENT, {
        matchId: this.matchId,
        sender,
        kind,
        durationMs,
        cooldownMs: EMOJI_COOLDOWN_MS,
        spectator: true,
      });
    }
  }

  handleLeave(slot) {
    const seat = this.seats[slot];
    if (!seat) return;
    if (this.state === 'ended' || this.closed) return;
    this.endMatch(this.otherSlot(slot), 'forfeit');
  }

  // ---- disconnect / reconnect -------------------------------------------
  onDisconnect(slot) {
    const seat = this.seats[slot];
    if (!seat || seat.isBot || !seat.connected) return;
    seat.connected = false;
    seat.socket = null;
    seat.disconnectCount += 1;
    if (this.state === 'ended' || this.closed) return;

    // Pause the authoritative loop so the connected player cannot exploit an
    // inert opponent; the disconnected player issues no actions.
    if (this.state === 'live' || this.state === 'intermission') {
      this.prevState = this.state;
      if (this.state === 'intermission') {
        this.intermissionRemainingMs = Math.max(0, this.intermissionDeadline - Date.now());
        if (this.intermissionTimer) {
          clearTimeout(this.intermissionTimer);
          this.intermissionTimer = null;
        }
        this.intermissionDeadline = 0;
      }
      this.state = 'paused';
    }
    const graceMs = this.graceMs != null
      ? this.graceMs
      : (seat.disconnectCount > 1 ? NET.RECONNECT_GRACE_REPEAT_MS : NET.RECONNECT_GRACE_MS);
    const other = this.seats[this.otherSlot(slot)];
    if (other.socket) other.socket.emit(EVENTS.OPPONENT_STATUS, { state: 'disconnected', graceMs });
    seat.graceTimer = setTimeout(() => {
      seat.graceTimer = null;
      if (!seat.connected && !this.closed && this.state !== 'ended') this.endMatch(this.otherSlot(slot), 'disconnect');
    }, graceMs);
  }

  // Re-attach a reconnecting socket. `token` is the verified (signature+exp)
  // payload. The nonce must match (single-use); on success it rotates and a new
  // token is issued, and a full authoritative snapshot is delivered.
  resume(token, socket) {
    const seat = this.seats[token.slot];
    if (!seat) return { ok: false, code: ERR.BAD_TOKEN };
    if (seat.accountId && token.accountId !== seat.accountId) return { ok: false, code: ERR.BAD_TOKEN };
    if (token.nonce !== seat.nonce) return { ok: false, code: ERR.BAD_TOKEN }; // already used/rotated
    if (this.state === 'ended' || this.closed) return { ok: false, code: ERR.BAD_STATE };

    if (seat.graceTimer) { clearTimeout(seat.graceTimer); seat.graceTimer = null; }
    seat.socket = socket;
    seat.connected = true;
    seat.epoch += 1;
    seat.nonce = randomId(8);            // rotate: the old token can no longer resume
    Object.assign(seat, freshSeatRuntime(), {
      // preserve the just-rotated identity fields
      inputState: { move: 0, focus: false, brace: false },
    });

    const newToken = this.issueToken(seat);
    socket.emit(EVENTS.RESUME_TOKEN, { token: newToken });
    // Full authoritative snapshot for the resumed client.
    if (this.sim) {
      const canon = this.sim.snapshot();
      socket.emit(EVENTS.SNAPSHOT, {
        matchId: this.matchId, tick: canon.tick, epoch: seat.epoch, ackSeq: seat.lastInputSeq,
        full: true, state: remapSnapshotForSlot(canon, seat.slot), events: [],
      });
    }
    const other = this.seats[this.otherSlot(seat.slot)];
    if (other.socket) other.socket.emit(EVENTS.OPPONENT_STATUS, { state: 'returned' });

    // Resume the loop only when both seats are connected again.
    if (this.state === 'paused' && this.seats.every((s) => s.connected)) {
      this.state = this.prevState || 'live';
      this.prevState = null;
      this.lastTickTime = Date.now();
      this.acc = 0;
      if (this.state === 'intermission') {
        this.scheduleIntermission(this.intermissionRemainingMs);
        this.intermissionRemainingMs = 0;
      }
    }
    return {
      ok: true,
      matchId: this.matchId,
      slot: seat.slot,
      epoch: seat.epoch,
      token: newToken,
      ranked: this.ranked,
      code: this.code,
    };
  }

  // ---- teardown ----------------------------------------------------------
  stop(reason) {
    if (this.closed) return;
    this.closed = true;
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this.intermissionTimer) { clearTimeout(this.intermissionTimer); this.intermissionTimer = null; }
    this.intermissionDeadline = 0;
    this.intermissionRemainingMs = 0;
    for (const seat of this.seats) if (seat.graceTimer) { clearTimeout(seat.graceTimer); seat.graceTimer = null; }
    for (const spectator of this.spectators.values()) spectator.data.loc = null;
    this.spectators.clear();
    try { this.onClosed(this, reason); } catch { /* cleanup best-effort */ }
  }

  // Graceful drain (SIGTERM): tell both clients to reconnect elsewhere/later.
  abort(reason) {
    if (this.closed) return;
    for (const seat of this.seats) {
      if (seat.socket) seat.socket.emit(EVENTS.ABORTED, { reason: reason || 'Server restarting' });
    }
    for (const spectator of this.spectators.values()) {
      spectator.emit(EVENTS.SPECTATE_END, {
        matchId: this.matchId,
        reason: reason || 'Server restarting',
      });
    }
    this.stop(reason || 'aborted');
  }
}

// Validate a proposed eight-guide shortcut list independent of the client.
export function validateSeatLoadout(ids) {
  if (!Array.isArray(ids)) return { valid: false, errors: ['Loadout must be a list of spell ids.'] };
  return validateLoadout(ids);
}
