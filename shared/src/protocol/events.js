// events.js — canonical Socket.IO event names + error codes shared by the
// authoritative server and the client net adapter so the two never disagree on
// wire vocabulary. Pure/DOM-free (imported in Node and the browser).

export const EVENTS = Object.freeze({
  // ---- client -> server ------------------------------------------------
  CREATE_ROOM: 'aeth:createRoom',   // { loadout:[ids], name? } -> ack {ok, code, slot, ...}
  JOIN_ROOM: 'aeth:joinRoom',       // { code, loadout:[ids], name? }
  QUICK_MATCH: 'aeth:quickMatch',   // { loadout:[ids], name?, rating? }
  CANCEL_QUEUE: 'aeth:cancelQueue', // {}
  LEAVE: 'aeth:leave',              // {} leave room / forfeit
  INPUT: 'aeth:input',              // { seq, move, focus, brace, sidestep }
  CAST: 'aeth:cast',                // { seq, points:[{x,y}], strokeBreaks?, durationMs, hint? }
  RESUME: 'aeth:resume',            // { token } re-attach to an in-progress match
  PING: 'aeth:ping',                // { t } latency probe

  // ---- server -> client ------------------------------------------------
  ROOM_UPDATE: 'aeth:roomUpdate',   // waiting-room / queue status
  MATCH_START: 'aeth:matchStart',   // { matchId, slot, epoch, token, series, loadouts }
  SNAPSHOT: 'aeth:snapshot',        // { tick, epoch, ackSeq, state, events }
  ROUND_END: 'aeth:roundEnd',       // { winner, reason, score }
  MATCH_END: 'aeth:matchEnd',       // { winner, reason, score }
  OPPONENT_STATUS: 'aeth:opponentStatus', // { state:'disconnected'|'returned', graceMs? }
  RESUME_TOKEN: 'aeth:resumeToken', // { token } rotated single-use token
  ABORTED: 'aeth:aborted',          // { reason } drain / fatal
  PONG: 'aeth:pong',                // { t } echo of ping
});

// Machine-readable rejection codes. Clear acknowledgements, never silent drops.
export const ERR = Object.freeze({
  RATE: 'rate',                 // per-player cast/input rate limit exceeded
  STALE: 'stale',               // duplicate or out-of-order sequence
  PAYLOAD: 'payload',           // malformed envelope
  MALFORMED: 'malformed',       // trace points malformed / non-finite
  OVERSIZE: 'oversize',         // trace point count / byte size over cap
  TOO_FAST: 'too-fast',         // trace drawn implausibly fast
  AMBIGUOUS: 'ambiguous',       // recognizer could not separate two spells
  BELOW: 'below-threshold',     // recognizer best score below accept threshold
  NO_ROOM: 'no-room',           // room code not found
  ROOM_FULL: 'room-full',       // room already has two players
  BAD_CODE: 'bad-code',         // malformed join code
  INVALID_LOADOUT: 'invalid-loadout', // loadout fails §8 validation
  INCOMPATIBLE: 'incompatible', // protocol/balance/roster mismatch
  BAD_STATE: 'bad-state',       // action not valid in current phase
  BAD_TOKEN: 'bad-token',       // resume token invalid / expired / used
  DRAINING: 'draining',         // server preparing to restart
  IN_MATCH: 'in-match',         // already in a room/match
});

// Queue / room lifecycle states surfaced to the client waiting UI.
export const ROOM_STATE = Object.freeze({
  WAITING: 'waiting',   // private room created, awaiting opponent
  QUEUED: 'queued',     // in the quick-match queue
  MATCHED: 'matched',   // paired, match starting
});
