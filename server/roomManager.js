// roomManager.js — owns room/match lifecycle for the authoritative service.
//
// Responsibilities: private rooms (create/join by short code), a quick-match
// queue with a widening rating band, anonymous stable identity, per-socket
// control rate limiting, disconnect routing, single-use resume-token routing,
// and graceful drain. Each live match is owned by exactly one MatchRoom.

import { EVENTS, ERR, ROOM_STATE } from '../shared/src/protocol/events.js';
import { NET } from '../shared/src/protocol/net.js';
import { MatchRoom, validateSeatLoadout } from './matchRoom.js';
import { verifyToken, randomId } from './tokens.js';
import { TokenBucket, roomCode, normalizeCode } from './util.js';

function sanitizeName(value, fallback) {
  const s = String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
  return s || fallback;
}

function sanitizeAccountId(value) {
  const s = String(value == null ? '' : value).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
  return s || null;
}

// Rating band widens with wait time so a match is always eventually found.
function bandFor(waitMs) {
  return 80 + Math.floor(Math.max(0, waitMs) / 1000) * 50;
}

export class RoomManager {
  constructor(io, opts = {}) {
    this.io = io;
    this.secret = opts.secret;
    this.ratingStore = opts.ratingStore;
    this.log = opts.log || (() => {});
    this.graceMs = opts.graceMs;
    this.intermissionMs = opts.intermissionMs;
    this.waitingRooms = new Map(); // code -> { code, host }
    this.queue = [];               // { socket, accountId, name, loadoutIds, rating, since }
    this.matches = new Map();      // matchId -> MatchRoom
    this.draining = false;
    this.matchmakeTimer = setInterval(() => this.matchmake(), 1000);
    if (this.matchmakeTimer.unref) this.matchmakeTimer.unref();
  }

  // ---- socket wiring -----------------------------------------------------
  register(socket) {
    socket.data.accountId = sanitizeAccountId(socket.handshake.auth && socket.handshake.auth.clientId) || `anon-${randomId(6)}`;
    socket.data.name = sanitizeName(socket.handshake.auth && socket.handshake.auth.name, `Wizard-${socket.data.accountId.slice(-4)}`);
    socket.data.control = new TokenBucket(5, 8); // create/join/quick spam guard
    socket.data.auxiliary = new TokenBucket(10, 20); // ping/resume/leave flood guard
    socket.data.loc = null;

    socket.on(EVENTS.CREATE_ROOM, (p, ack) => this.createRoom(socket, p || {}, ack));
    socket.on(EVENTS.JOIN_ROOM, (p, ack) => this.joinRoom(socket, p || {}, ack));
    socket.on(EVENTS.QUICK_MATCH, (p, ack) => this.quickMatch(socket, p || {}, ack));
    socket.on(EVENTS.CANCEL_QUEUE, (p, ack) => this.cancelQueue(socket, ack));
    socket.on(EVENTS.LEAVE, (p, ack) => {
      if (!socket.data.auxiliary.take()) return;
      this.leave(socket, ack);
    });
    socket.on(EVENTS.INPUT, (p) => this.routeInput(socket, p || {}));
    socket.on(EVENTS.CAST, (p, ack) => this.routeCast(socket, p || {}, ack));
    socket.on(EVENTS.RESUME, (p, ack) => {
      if (!socket.data.auxiliary.take()) {
        this.ack(ack, { ok: false, code: ERR.RATE });
        return;
      }
      this.resume(socket, p || {}, ack);
    });
    socket.on(EVENTS.PING, (p) => {
      if (socket.data.auxiliary.take() && p && Number.isFinite(p.t)) {
        socket.emit(EVENTS.PONG, { t: p.t });
      }
    });
    socket.on('disconnect', () => this.disconnect(socket));
  }

  ack(fn, payload) { if (typeof fn === 'function') fn(payload); }

  guard(socket, ack) {
    if (this.draining) { this.ack(ack, { ok: false, code: ERR.DRAINING }); return false; }
    if (!socket.data.control.take()) { this.ack(ack, { ok: false, code: ERR.RATE }); return false; }
    if (socket.data.loc) { this.ack(ack, { ok: false, code: ERR.IN_MATCH }); return false; }
    return true;
  }

  seatInit(socket, loadoutIds) {
    return { accountId: socket.data.accountId, name: socket.data.name, loadoutIds, socket };
  }

  // ---- private rooms -----------------------------------------------------
  createRoom(socket, payload, ack) {
    if (!this.guard(socket, ack)) return;
    const ids = Array.isArray(payload.loadout) ? payload.loadout.map(Number) : null;
    const v = validateSeatLoadout(ids);
    if (!v.valid) { this.ack(ack, { ok: false, code: ERR.INVALID_LOADOUT, errors: v.errors }); return; }
    if (payload.name) socket.data.name = sanitizeName(payload.name, socket.data.name);

    let code = roomCode(NET.ROOM_CODE_LEN);
    while (this.waitingRooms.has(code)) code = roomCode(NET.ROOM_CODE_LEN);
    this.waitingRooms.set(code, { code, host: this.seatInit(socket, ids), createdAt: Date.now() });
    socket.data.loc = { type: 'waiting', code };
    this.ack(ack, { ok: true, state: ROOM_STATE.WAITING, code, slot: 0 });
    socket.emit(EVENTS.ROOM_UPDATE, { state: ROOM_STATE.WAITING, code });
  }

  joinRoom(socket, payload, ack) {
    if (!this.guard(socket, ack)) return;
    const code = normalizeCode(payload.code, NET.ROOM_CODE_LEN);
    if (!code) { this.ack(ack, { ok: false, code: ERR.BAD_CODE }); return; }
    const room = this.waitingRooms.get(code);
    if (!room) { this.ack(ack, { ok: false, code: ERR.NO_ROOM }); return; }
    const ids = Array.isArray(payload.loadout) ? payload.loadout.map(Number) : null;
    const v = validateSeatLoadout(ids);
    if (!v.valid) { this.ack(ack, { ok: false, code: ERR.INVALID_LOADOUT, errors: v.errors }); return; }
    if (payload.name) socket.data.name = sanitizeName(payload.name, socket.data.name);
    if (!room.host.socket || !room.host.socket.connected) {
      this.waitingRooms.delete(code);
      this.ack(ack, { ok: false, code: ERR.NO_ROOM });
      return;
    }
    this.waitingRooms.delete(code);
    this.ack(ack, { ok: true, state: ROOM_STATE.MATCHED, code, slot: 1 });
    // Private matches do not affect rating (§14).
    this.startMatch([room.host, this.seatInit(socket, ids)], { code, ranked: false });
  }

  // ---- quick match -------------------------------------------------------
  async quickMatch(socket, payload, ack) {
    if (!this.guard(socket, ack)) return;
    const ids = Array.isArray(payload.loadout) ? payload.loadout.map(Number) : null;
    const v = validateSeatLoadout(ids);
    if (!v.valid) { this.ack(ack, { ok: false, code: ERR.INVALID_LOADOUT, errors: v.errors }); return; }
    if (payload.name) socket.data.name = sanitizeName(payload.name, socket.data.name);
    let rating = 1000;
    try { rating = await this.ratingStore.getRating(socket.data.accountId); } catch { /* default */ }
    if (socket.data.loc || this.draining || !socket.connected) return; // state changed while awaiting
    const entry = { socket, accountId: socket.data.accountId, name: socket.data.name, loadoutIds: ids, rating, since: Date.now() };
    this.queue.push(entry);
    socket.data.loc = { type: 'queue' };
    this.ack(ack, { ok: true, state: ROOM_STATE.QUEUED, rating });
    socket.emit(EVENTS.ROOM_UPDATE, { state: ROOM_STATE.QUEUED });
    this.matchmake();
  }

  cancelQueue(socket, ack) {
    if (socket.data.loc && socket.data.loc.type === 'queue') {
      this.queue = this.queue.filter((e) => e.socket !== socket);
      socket.data.loc = null;
    }
    this.ack(ack, { ok: true });
  }

  matchmake() {
    if (this.draining || this.queue.length < 2) return;
    const now = Date.now();
    const q = [...this.queue].sort((a, b) => a.since - b.since);
    const used = new Set();
    for (let i = 0; i < q.length; i++) {
      if (used.has(q[i]) || !q[i].socket.connected) continue;
      let best = null; let bestDiff = Infinity;
      for (let j = 0; j < q.length; j++) {
        if (i === j || used.has(q[j]) || !q[j].socket.connected) continue;
        const diff = Math.abs(q[i].rating - q[j].rating);
        if (diff < bestDiff) { bestDiff = diff; best = q[j]; }
      }
      if (!best) continue;
      const allowed = Math.max(bandFor(now - q[i].since), bandFor(now - best.since));
      if (bestDiff <= allowed) { used.add(q[i]); used.add(best); this.startMatch([q[i], best], { ranked: true }); }
    }
    if (used.size) this.queue = this.queue.filter((e) => !used.has(e));
  }

  // ---- match creation ----------------------------------------------------
  startMatch(seatsInit, opts) {
    const match = new MatchRoom(seatsInit, {
      code: opts.code,
      ranked: opts.ranked,
      secret: this.secret,
      graceMs: this.graceMs,
      intermissionMs: this.intermissionMs,
      log: this.log,
      onResult: (r) => this.persistResult(r),
      onClosed: (m) => this.matches.delete(m.matchId),
    });
    this.matches.set(match.matchId, match);
    for (const seat of match.seats) {
      if (seat.socket) seat.socket.data.loc = { type: 'match', matchId: match.matchId, slot: seat.slot };
    }
    match.start();
    return match;
  }

  async persistResult(result) {
    if (!this.ratingStore) return;
    try {
      await this.ratingStore.recordResult({
        matchId: result.matchId,
        ranked: result.ranked,
        winnerSlot: result.winnerSlot,
        players: result.players.map((p) => ({ accountId: p.accountId })),
      });
    } catch (err) { this.log('rating persist failed', err && err.message); }
  }

  // ---- in-match routing --------------------------------------------------
  matchFor(socket) {
    const loc = socket.data.loc;
    if (!loc || loc.type !== 'match') return null;
    const match = this.matches.get(loc.matchId);
    return match ? { match, slot: loc.slot } : null;
  }

  routeInput(socket, payload) {
    const m = this.matchFor(socket);
    if (m) m.match.handleInput(m.slot, payload);
  }

  routeCast(socket, payload, ack) {
    const m = this.matchFor(socket);
    if (!m) { this.ack(ack, { ok: false, code: ERR.BAD_STATE }); return; }
    this.ack(ack, m.match.handleCast(m.slot, payload));
  }

  leave(socket, ack) {
    const loc = socket.data.loc;
    if (loc && loc.type === 'waiting') { this.waitingRooms.delete(loc.code); socket.data.loc = null; }
    else if (loc && loc.type === 'queue') { this.queue = this.queue.filter((e) => e.socket !== socket); socket.data.loc = null; }
    else if (loc && loc.type === 'match') { const m = this.matches.get(loc.matchId); if (m) m.handleLeave(loc.slot); socket.data.loc = null; }
    this.ack(ack, { ok: true });
  }

  // ---- reconnect / resume ------------------------------------------------
  resume(socket, payload, ack) {
    if (this.draining) { this.ack(ack, { ok: false, code: ERR.DRAINING }); return; }
    const token = verifyToken(this.secret, payload && payload.token);
    if (!token) { this.ack(ack, { ok: false, code: ERR.BAD_TOKEN }); return; }
    const match = this.matches.get(token.matchId);
    if (!match) { this.ack(ack, { ok: false, code: ERR.NO_ROOM }); return; }
    const res = match.resume(token, socket);
    if (res.ok) socket.data.loc = { type: 'match', matchId: match.matchId, slot: res.slot };
    this.ack(ack, res);
  }

  disconnect(socket) {
    const loc = socket.data.loc;
    if (!loc) return;
    if (loc.type === 'waiting') { this.waitingRooms.delete(loc.code); }
    else if (loc.type === 'queue') { this.queue = this.queue.filter((e) => e.socket !== socket); }
    else if (loc.type === 'match') {
      const match = this.matches.get(loc.matchId);
      if (match) match.onDisconnect(loc.slot); // keep the match alive for the grace window
    }
    socket.data.loc = null;
  }

  // ---- drain -------------------------------------------------------------
  drain(reason) {
    this.draining = true;
    if (this.matchmakeTimer) { clearInterval(this.matchmakeTimer); this.matchmakeTimer = null; }
    for (const e of this.queue) if (e.socket) e.socket.emit(EVENTS.ABORTED, { reason: reason || 'Server restarting' });
    this.queue = [];
    for (const room of this.waitingRooms.values()) if (room.host.socket) room.host.socket.emit(EVENTS.ABORTED, { reason: reason || 'Server restarting' });
    this.waitingRooms.clear();
    for (const match of [...this.matches.values()]) match.abort(reason);
    this.matches.clear();
  }

  close() { this.drain('Server closed'); }

  stats() {
    return { rooms: this.waitingRooms.size, queue: this.queue.length, matches: this.matches.size };
  }
}
