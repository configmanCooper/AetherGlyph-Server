// roomManager.js — owns room/match lifecycle for the authoritative service.
//
// Responsibilities: private rooms (create/join by short code), a quick-match
// queue with Glyph-range matching, anonymous stable identity, per-socket
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

function authKey(value) {
  return String(value || '').trim().toLowerCase().slice(0, 24) || '-';
}

// Rating band widens with wait time so a match is always eventually found.
export class RoomManager {
  constructor(io, opts = {}) {
    this.io = io;
    this.secret = opts.secret;
    this.ratingStore = opts.ratingStore;
    this.log = opts.log || (() => {});
    this.graceMs = opts.graceMs;
    this.intermissionMs = opts.intermissionMs;
    this.privateLobbyGraceMs = opts.privateLobbyGraceMs ?? 2 * 60 * 1000;
    this.rankedRange = opts.rankedRange ?? 50;
    this.rankedRangeWaitMs = opts.rankedRangeWaitMs ?? 3000;
    this.requireAccounts = opts.requireAccounts !== false;
    this.privateLobbies = new Map(); // code -> { code, seats, ready }
    this.queue = [];               // { socket, accountId, name, loadoutIds, glyphs, ranked, since }
    this.matches = new Map();      // matchId -> MatchRoom
    this.authIpBuckets = new Map();
    this.authNameBuckets = new Map();
    this.draining = false;
    this.populationTimer = null;
    this.matchmakeTimer = setInterval(() => this.matchmake(), 1000);
    if (this.matchmakeTimer.unref) this.matchmakeTimer.unref();
  }

  // ---- socket wiring -----------------------------------------------------
  authBucket(map, key, rate, burst) {
    const now = Date.now();
    let entry = map.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(rate, burst), lastSeen: now };
      map.set(key, entry);
    }
    entry.lastSeen = now;
    if (map.size > 1024) {
      for (const [storedKey, stored] of map) {
        if (now - stored.lastSeen > 10 * 60 * 1000) map.delete(storedKey);
      }
      while (map.size > 2048) map.delete(map.keys().next().value);
    }
    return entry.bucket;
  }

  allowAccountAttempt(socket, username) {
    const ip = socket.handshake.address || 'unknown';
    return this.authBucket(this.authIpBuckets, ip, 0.5, 10).take()
      && this.authBucket(this.authNameBuckets, authKey(username), 0.2, 5).take();
  }

  register(socket) {
    const verified = socket.data.verifiedAccount;
    socket.data.accountId = verified?.accountId
      || sanitizeAccountId(socket.handshake.auth && socket.handshake.auth.clientId)
      || `anon-${randomId(6)}`;
    socket.data.name = verified?.name
      || sanitizeName(socket.handshake.auth && socket.handshake.auth.name, `Wizard-${socket.data.accountId.slice(-4)}`);
    socket.data.authenticated = !!verified || !this.requireAccounts;
    socket.data.control = new TokenBucket(5, 8); // create/join/quick spam guard
    socket.data.auxiliary = new TokenBucket(10, 20); // ping/resume/ready/leave flood guard
    socket.data.authLimiter = new TokenBucket(1, 4);
    socket.data.loc = null;

    socket.on(EVENTS.ACCOUNT_STATUS, (p, ack) => {
      this.ack(ack, {
        ok: true,
        authenticated: socket.data.authenticated,
        accountId: socket.data.authenticated ? socket.data.accountId : null,
        name: socket.data.authenticated ? socket.data.name : null,
      });
    });
    socket.on(EVENTS.ACCOUNT_AUTH, async (p, ack) => {
      if (!socket.data.authLimiter.take() || !this.allowAccountAttempt(socket, p?.username)) {
        this.ack(ack, { ok: false, code: ERR.RATE });
        return;
      }
      if (socket.data.loc) {
        this.ack(ack, { ok: false, code: ERR.IN_MATCH });
        return;
      }
      try {
        const result = await this.ratingStore.authenticateTemporary(p?.username, p?.pin);
        if (!result.ok) {
          this.ack(ack, result);
          return;
        }
        socket.data.accountId = result.accountId;
        socket.data.name = result.name;
        socket.data.authenticated = true;
        this.ack(ack, result);
      } catch (error) {
        this.log('temporary account authentication failed', error?.message);
        this.ack(ack, { ok: false, code: ERR.BAD_STATE });
      }
    });
    socket.on(EVENTS.CREATE_ROOM, (p, ack) => this.createRoom(socket, p || {}, ack));
    socket.on(EVENTS.JOIN_ROOM, (p, ack) => this.joinRoom(socket, p || {}, ack));
    socket.on(EVENTS.QUICK_MATCH, (p, ack) => this.quickMatch(socket, p || {}, ack));
    socket.on(EVENTS.QUICK_MATCH_UNRANKED, (p, ack) => {
      this.quickMatch(socket, { ...(p || {}), ranked: false }, ack);
    });
    socket.on(EVENTS.CANCEL_QUEUE, (p, ack) => this.cancelQueue(socket, ack));
    socket.on(EVENTS.PRIVATE_READY, (p, ack) => {
      if (!socket.data.auxiliary.take()) { this.ack(ack, { ok: false, code: ERR.RATE }); return; }
      this.privateReady(socket, p || {}, ack);
    });
    socket.on(EVENTS.PRIVATE_UNREADY, (p, ack) => {
      if (!socket.data.auxiliary.take()) { this.ack(ack, { ok: false, code: ERR.RATE }); return; }
      this.privateUnready(socket, ack);
    });
    socket.on(EVENTS.RANKINGS_REQUEST, async (p, ack) => {
      if (!socket.data.auxiliary.take()) { this.ack(ack, { ok: false, code: ERR.RATE }); return; }
      if (this.requireAccounts && !socket.data.authenticated) {
        this.ack(ack, { ok: false, code: ERR.AUTH_REQUIRED });
        return;
      }
      try {
        const rankings = await this.ratingStore.getLeaderboard(
          socket.data.accountId,
          socket.data.name,
          100,
        );
        this.ack(ack, { ok: true, ...rankings });
      } catch (error) {
        this.log('rankings request failed', error?.message);
        this.ack(ack, { ok: false, code: ERR.BAD_STATE });
      }
    });
    socket.on(EVENTS.LEAVE, (p, ack) => {
      if (!socket.data.auxiliary.take()) { this.ack(ack, { ok: false, code: ERR.RATE }); return; }
      this.leave(socket, ack);
    });
    socket.on(EVENTS.INPUT, (p) => this.routeInput(socket, p || {}));
    socket.on(EVENTS.CAST, (p, ack) => this.routeCast(socket, p || {}, ack));
    socket.on(EVENTS.RESUME, (p, ack) => {
      if (!socket.data.auxiliary.take()) { this.ack(ack, { ok: false, code: ERR.RATE }); return; }
      this.resume(socket, p || {}, ack);
    });
    socket.on(EVENTS.PING, (p) => {
      if (socket.data.auxiliary.take() && p && Number.isFinite(p.t)) socket.emit(EVENTS.PONG, { t: p.t });
    });
    socket.on('disconnect', () => {
      this.disconnect(socket);
      this.schedulePopulationBroadcast();
    });
    socket.emit(EVENTS.POPULATION, this.populationPayload());
    this.schedulePopulationBroadcast();
  }

  ack(fn, payload) { if (typeof fn === 'function') fn(payload); }

  guard(socket, ack) {
    if (this.draining) { this.ack(ack, { ok: false, code: ERR.DRAINING }); return false; }
    if (this.requireAccounts && !socket.data.authenticated) {
      this.ack(ack, { ok: false, code: ERR.AUTH_REQUIRED });
      return false;
    }
    if (!socket.data.control.take()) { this.ack(ack, { ok: false, code: ERR.RATE }); return false; }
    if (socket.data.loc) { this.ack(ack, { ok: false, code: ERR.IN_MATCH }); return false; }
    return true;
  }

  seatInit(socket, loadoutIds) {
    return { accountId: socket.data.accountId, name: socket.data.name, loadoutIds, socket };
  }

  populationPayload() {
    return { online: Math.max(0, Number(this.io.engine.clientsCount) || 0) };
  }

  schedulePopulationBroadcast() {
    if (this.populationTimer) return;
    this.populationTimer = setTimeout(() => {
      this.populationTimer = null;
      this.io.emit(EVENTS.POPULATION, this.populationPayload());
    }, 100);
    if (this.populationTimer.unref) this.populationTimer.unref();
  }

  // ---- private rooms -----------------------------------------------------
  createRoom(socket, payload, ack) {
    if (!this.guard(socket, ack)) return;
    const ids = Array.isArray(payload.loadout) ? payload.loadout.map(Number) : null;
    const v = validateSeatLoadout(ids);
    if (!v.valid) { this.ack(ack, { ok: false, code: ERR.INVALID_LOADOUT, errors: v.errors }); return; }
    if (!this.requireAccounts && payload.name) socket.data.name = sanitizeName(payload.name, socket.data.name);

    let code = roomCode(NET.ROOM_CODE_LEN);
    while (this.privateLobbies.has(code)) code = roomCode(NET.ROOM_CODE_LEN);
    const lobby = {
      code, seats: [this.seatInit(socket, ids)], ready: new Set(), expiryTimer: null,
    };
    this.privateLobbies.set(code, lobby);
    socket.data.loc = { type: 'private-lobby', code, slot: 0 };
    this.ack(ack, {
      ok: true, state: ROOM_STATE.PRIVATE_LOBBY, code, slot: 0,
      readyCount: 0, playerCount: 1, connectedCount: 1, selfReady: false,
    });
    this.broadcastPrivateLobby(lobby);
  }

  joinRoom(socket, payload, ack) {
    if (!this.guard(socket, ack)) return;
    const code = normalizeCode(payload.code, NET.ROOM_CODE_LEN);
    if (!code) { this.ack(ack, { ok: false, code: ERR.BAD_CODE }); return; }
    const lobby = this.privateLobbies.get(code);
    if (!lobby) { this.ack(ack, { ok: false, code: ERR.NO_ROOM }); return; }
    const ids = Array.isArray(payload.loadout) ? payload.loadout.map(Number) : null;
    const v = validateSeatLoadout(ids);
    if (!v.valid) { this.ack(ack, { ok: false, code: ERR.INVALID_LOADOUT, errors: v.errors }); return; }
    if (!this.requireAccounts && payload.name) socket.data.name = sanitizeName(payload.name, socket.data.name);
    const existingSlot = lobby.seats.findIndex((seat) => seat.accountId === socket.data.accountId);
    if (existingSlot >= 0) {
      const seat = lobby.seats[existingSlot];
      if (seat.socket?.connected && seat.socket !== socket) {
        this.ack(ack, { ok: false, code: ERR.IN_MATCH });
        return;
      }
      seat.socket = socket;
      seat.loadoutIds = ids;
      seat.name = socket.data.name;
      lobby.ready.delete(existingSlot);
      socket.data.loc = { type: 'private-lobby', code, slot: existingSlot };
      if (lobby.seats.every((entry) => entry.socket?.connected)) this.clearLobbyExpiry(lobby);
      this.ack(ack, {
        ok: true, state: ROOM_STATE.PRIVATE_LOBBY, code, slot: existingSlot,
        readyCount: lobby.ready.size, playerCount: lobby.seats.length,
        connectedCount: lobby.seats.filter((entry) => entry.socket?.connected).length,
        selfReady: false,
        resumed: true,
      });
      this.broadcastPrivateLobby(lobby);
      return;
    }
    if (lobby.seats.length >= 2) { this.ack(ack, { ok: false, code: ERR.ROOM_FULL }); return; }
    const slot = lobby.seats.length;
    lobby.seats.push(this.seatInit(socket, ids));
    socket.data.loc = { type: 'private-lobby', code, slot };
    this.ack(ack, {
      ok: true, state: ROOM_STATE.PRIVATE_LOBBY, code, slot,
      readyCount: lobby.ready.size, playerCount: lobby.seats.length,
      connectedCount: lobby.seats.filter((entry) => entry.socket?.connected).length,
      selfReady: false,
    });
    this.broadcastPrivateLobby(lobby);
  }

  // ---- quick match -------------------------------------------------------
  async quickMatch(socket, payload, ack) {
    if (!this.guard(socket, ack)) return;
    const ids = Array.isArray(payload.loadout) ? payload.loadout.map(Number) : null;
    const v = validateSeatLoadout(ids);
    if (!v.valid) { this.ack(ack, { ok: false, code: ERR.INVALID_LOADOUT, errors: v.errors }); return; }
    if (!this.requireAccounts && payload.name) socket.data.name = sanitizeName(payload.name, socket.data.name);
    const ranked = payload.ranked !== false;
    let glyphs = 100;
    if (ranked) {
      try {
        glyphs = await this.ratingStore.getGlyphs(socket.data.accountId, socket.data.name);
      } catch { /* default */ }
    }
    if (socket.data.loc || this.draining || !socket.connected) return; // state changed while awaiting
    const entry = {
      socket, accountId: socket.data.accountId, name: socket.data.name,
      loadoutIds: ids, glyphs, ranked, since: Date.now(),
    };
    this.queue.push(entry);
    socket.data.loc = { type: 'queue' };
    this.ack(ack, { ok: true, state: ROOM_STATE.QUEUED, glyphs, ranked });
    socket.emit(EVENTS.ROOM_UPDATE, { state: ROOM_STATE.QUEUED, glyphs, ranked });
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
        if (i === j || used.has(q[j]) || !q[j].socket.connected
            || q[j].ranked !== q[i].ranked) continue;
        if (q[i].accountId && q[j].accountId && q[i].accountId === q[j].accountId) continue;
        const diff = Math.abs(q[i].glyphs - q[j].glyphs);
        if (diff < bestDiff) { bestDiff = diff; best = q[j]; }
      }
      if (!best) continue;
      const waitedLongEnough = now - q[i].since >= this.rankedRangeWaitMs;
      const eligible = !q[i].ranked || bestDiff <= this.rankedRange || waitedLongEnough;
      if (eligible) {
        used.add(q[i]);
        used.add(best);
        this.startMatch([q[i], best], { ranked: q[i].ranked });
      }
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
      onClosed: (m, reason) => this.matchClosed(m, reason),
    });
    this.matches.set(match.matchId, match);
    for (const seat of match.seats) {
      if (seat.socket) seat.socket.data.loc = { type: 'match', matchId: match.matchId, slot: seat.slot };
    }
    match.start();
    return match;
  }

  matchClosed(match, reason) {
    this.matches.delete(match.matchId);
    for (const seat of match.seats) {
      if (seat.socket?.data?.loc?.matchId === match.matchId) seat.socket.data.loc = null;
    }
    if (reason !== 'match-complete' || !match.code || !match.seats.every((seat) => seat.socket?.connected)) return;
    const lobby = {
      code: match.code,
      seats: match.seats.map((seat) => ({
        accountId: seat.accountId,
        name: seat.name,
        loadoutIds: seat.loadoutIds.slice(),
        socket: seat.socket,
      })),
      ready: new Set(),
      expiryTimer: null,
    };
    this.privateLobbies.set(lobby.code, lobby);
    lobby.seats.forEach((seat, slot) => {
      seat.socket.data.loc = { type: 'private-lobby', code: lobby.code, slot };
    });
    this.broadcastPrivateLobby(lobby);
  }

  broadcastPrivateLobby(lobby) {
    lobby.seats.forEach((seat, slot) => {
      if (!seat.socket?.connected) return;
      seat.socket.emit(EVENTS.ROOM_UPDATE, {
        state: ROOM_STATE.PRIVATE_LOBBY,
        code: lobby.code,
        readyCount: lobby.ready.size,
        playerCount: lobby.seats.length,
        connectedCount: lobby.seats.filter((entry) => entry.socket?.connected).length,
        selfReady: true,
        playerCount: lobby.seats.length,
        connectedCount: lobby.seats.filter((entry) => entry.socket?.connected).length,
        selfReady: lobby.ready.has(slot),
        opponentReady: lobby.ready.has(slot === 0 ? 1 : 0),
      });
    });
  }

  privateReady(socket, payload, ack) {
    const loc = socket.data.loc;
    const lobby = loc?.type === 'private-lobby' ? this.privateLobbies.get(loc.code) : null;
    if (!lobby || !lobby.seats[loc.slot] || lobby.seats[loc.slot].socket !== socket) {
      this.ack(ack, { ok: false, code: ERR.BAD_STATE });
      return;
    }
    const ids = Array.isArray(payload.loadout) ? payload.loadout.map(Number) : null;
    const v = validateSeatLoadout(ids);
    if (!v.valid) {
      this.ack(ack, { ok: false, code: ERR.INVALID_LOADOUT, errors: v.errors });
      return;
    }
    const seat = lobby.seats[loc.slot];
    seat.loadoutIds = ids;
    if (!this.requireAccounts && payload.name) {
      socket.data.name = sanitizeName(payload.name, socket.data.name);
      seat.name = socket.data.name;
    }
    lobby.ready.add(loc.slot);
    this.ack(ack, {
      ok: true,
      state: ROOM_STATE.PRIVATE_LOBBY,
      code: lobby.code,
      readyCount: lobby.ready.size,
    });
    this.broadcastPrivateLobby(lobby);
    if (lobby.seats.length < 2 || lobby.ready.size < 2
        || !lobby.seats.every((seat) => seat.socket?.connected)) return;
    this.clearLobbyExpiry(lobby);
    this.privateLobbies.delete(lobby.code);
    for (const readySeat of lobby.seats) readySeat.socket.data.loc = null;
    this.startMatch(lobby.seats, { code: lobby.code, ranked: false });
  }

  privateUnready(socket, ack) {
    const loc = socket.data.loc;
    const lobby = loc?.type === 'private-lobby' ? this.privateLobbies.get(loc.code) : null;
    if (!lobby || !lobby.seats[loc.slot] || lobby.seats[loc.slot].socket !== socket) {
      this.ack(ack, { ok: false, code: ERR.BAD_STATE });
      return;
    }
    lobby.ready.delete(loc.slot);
    this.ack(ack, {
      ok: true, state: ROOM_STATE.PRIVATE_LOBBY, code: lobby.code,
      readyCount: lobby.ready.size, playerCount: lobby.seats.length,
      connectedCount: lobby.seats.filter((entry) => entry.socket?.connected).length,
      selfReady: false,
    });
    this.broadcastPrivateLobby(lobby);
  }

  clearLobbyExpiry(lobby) {
    if (!lobby?.expiryTimer) return;
    clearTimeout(lobby.expiryTimer);
    lobby.expiryTimer = null;
  }

  scheduleLobbyExpiry(lobby) {
    this.clearLobbyExpiry(lobby);
    lobby.expiryTimer = setTimeout(() => {
      lobby.expiryTimer = null;
      if (lobby.seats.every((seat) => seat.socket?.connected)) return;
      this.privateLobbies.delete(lobby.code);
      for (const seat of lobby.seats) {
        if (!seat.socket?.connected) continue;
        seat.socket.data.loc = null;
        seat.socket.emit(EVENTS.ROOM_UPDATE, { state: 'closed', code: lobby.code, reason: 'expired' });
      }
    }, this.privateLobbyGraceMs);
    if (lobby.expiryTimer.unref) lobby.expiryTimer.unref();
  }

  closePrivateLobby(lobby, exceptSocket = null) {
    if (!lobby) return;
    this.clearLobbyExpiry(lobby);
    this.privateLobbies.delete(lobby.code);
    for (const seat of lobby.seats) {
      if (!seat.socket) continue;
      seat.socket.data.loc = null;
      if (seat.socket !== exceptSocket) {
        seat.socket.emit(EVENTS.ROOM_UPDATE, { state: 'closed', code: lobby.code });
      }
    }
  }

  async persistResult(result) {
    if (!this.ratingStore) return;
    if (!result.ranked) return { ranked: false, applied: false };
    try {
      return await this.ratingStore.recordResult({
        matchId: result.matchId,
        ranked: result.ranked,
        winnerSlot: result.winnerSlot,
        reason: result.reason,
        players: result.players.map((p) => ({
          accountId: p.accountId,
          name: p.name,
        })),
      });
    } catch (err) {
      this.log('Glyph ranking persist failed', err && err.message);
      throw err;
    }
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
    if (loc && loc.type === 'queue') { this.queue = this.queue.filter((e) => e.socket !== socket); socket.data.loc = null; }
    else if (loc && loc.type === 'private-lobby') {
      const lobby = this.privateLobbies.get(loc.code);
      if (lobby) {
        this.closePrivateLobby(lobby, socket);
      }
      socket.data.loc = null;
    } else if (loc && loc.type === 'match') {
      const m = this.matches.get(loc.matchId);
      if (m) m.handleLeave(loc.slot);
      if (socket.data.loc?.type === 'match') socket.data.loc = null;
    }
    this.ack(ack, { ok: true });
  }

  // ---- reconnect / resume ------------------------------------------------
  resume(socket, payload, ack) {
    if (this.draining) { this.ack(ack, { ok: false, code: ERR.DRAINING }); return; }
    if (this.requireAccounts && !socket.data.authenticated) {
      this.ack(ack, { ok: false, code: ERR.AUTH_REQUIRED });
      return;
    }
    const token = verifyToken(this.secret, payload && payload.token);
    if (!token) { this.ack(ack, { ok: false, code: ERR.BAD_TOKEN }); return; }
    if (token.accountId !== socket.data.accountId) {
      this.ack(ack, { ok: false, code: ERR.BAD_TOKEN });
      return;
    }
    const match = this.matches.get(token.matchId);
    if (!match) { this.ack(ack, { ok: false, code: ERR.NO_ROOM }); return; }
    const res = match.resume(token, socket);
    if (res.ok) socket.data.loc = { type: 'match', matchId: match.matchId, slot: res.slot };
    this.ack(ack, res);
  }

  disconnect(socket) {
    const loc = socket.data.loc;
    if (!loc) return;
    if (loc.type === 'queue') { this.queue = this.queue.filter((e) => e.socket !== socket); }
    else if (loc.type === 'private-lobby') {
      const lobby = this.privateLobbies.get(loc.code);
      if (lobby) {
        const seat = lobby.seats[loc.slot];
        if (seat?.socket === socket) seat.socket = null;
        lobby.ready.delete(loc.slot);
        this.scheduleLobbyExpiry(lobby);
        this.broadcastPrivateLobby(lobby);
      }
    } else if (loc.type === 'match') {
      const match = this.matches.get(loc.matchId);
      if (match) match.onDisconnect(loc.slot); // keep the match alive for the grace window
    }
    socket.data.loc = null;
  }

  // ---- drain -------------------------------------------------------------
  drain(reason) {
    this.draining = true;
    if (this.populationTimer) { clearTimeout(this.populationTimer); this.populationTimer = null; }
    if (this.matchmakeTimer) { clearInterval(this.matchmakeTimer); this.matchmakeTimer = null; }
    for (const e of this.queue) if (e.socket) e.socket.emit(EVENTS.ABORTED, { reason: reason || 'Server restarting' });
    this.queue = [];
    for (const lobby of this.privateLobbies.values()) {
      this.clearLobbyExpiry(lobby);
      for (const seat of lobby.seats) if (seat.socket) seat.socket.emit(EVENTS.ABORTED, { reason: reason || 'Server restarting' });
    }
    this.privateLobbies.clear();
    for (const match of [...this.matches.values()]) match.abort(reason);
    this.matches.clear();
  }

  close() { this.drain('Server closed'); }

  stats() {
    return {
      rooms: this.privateLobbies.size,
      queue: this.queue.length,
      matches: this.matches.size,
    };
  }
}
