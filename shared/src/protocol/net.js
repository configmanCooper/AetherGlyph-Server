// net.js — shared networking constants + pure helpers used by BOTH the
// authoritative server and the client. DOM/socket-free so it can be imported in
// Node (server, tests) and the browser identically.
//
// Two responsibilities:
//   1. Bounded / quantized gesture traces (the authoritative cast packet — the
//      client sends a shape, never a trusted spell id).
//   2. Per-recipient snapshot/event remapping so every device renders itself as
//      local player 0 even when the server assigned it slot 1.

import { resample } from '../gesture/recognizer.js';

export const NET = Object.freeze({
  // The authoritative tick equals the shared Sim's fixed tick so the exact same
  // deterministic simulation runs server-side (no divergent tick constant).
  TICK_HZ: 60,
  SNAPSHOT_HZ: 10,               // bounded snapshot + event flush rate
  SNAPSHOT_EVERY_TICKS: 6,       // TICK_HZ / SNAPSHOT_HZ
  INPUT_HZ: 20,                  // client movement/focus/brace cadence cap

  // Cast trace limits (MASTERPLAN §5 "Authoritative cast packet").
  MAX_TRACE_POINTS: 48,
  MIN_TRACE_POINTS: 4,
  MAX_CAST_BYTES: 2048,
  MAX_CASTS_PER_SEC: 3,
  MIN_TRACE_DURATION_MS: 60,     // faster than this is not a real hand trace
  MAX_TRACE_DURATION_MS: 6000,
  MAX_INPUTS_PER_SEC: 40,

  // Reconnect / resume (MASTERPLAN §17).
  RECONNECT_GRACE_MS: 25000,
  RECONNECT_GRACE_REPEAT_MS: 10000, // shortened grace after a repeat disconnect
  RESUME_TOKEN_TTL_MS: 10 * 60 * 1000,

  ROOM_CODE_LEN: 5,
});

// Quantize a raw pointer trace into a compact, bounded integer point list. The
// SAME quantized points are classified on the client (for prediction) and sent
// to the server (for the authoritative classification), so the two agree. The
// recognizer normalizes translation + scale, so integer rounding is lossless
// for classification purposes.
export function boundTrace(points, maxPoints = NET.MAX_TRACE_POINTS) {
  const clean = (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  let pts = clean;
  if (clean.length > maxPoints) pts = resample(clean, maxPoints);
  return pts.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
}

// Rough serialized size of a cast trace, used to enforce the payload cap without
// depending on the transport's framing.
export function traceByteSize(points) {
  return JSON.stringify(points || []).length;
}

// Validate an incoming cast trace envelope shape-wise (server authority also
// re-classifies). Returns { ok, code } — a clear, machine-readable reason.
export function validateTraceEnvelope(env) {
  if (!env || typeof env !== 'object') return { ok: false, code: 'payload' };
  const pts = env.points;
  if (!Array.isArray(pts)) return { ok: false, code: 'payload' };
  if (pts.length > NET.MAX_TRACE_POINTS) return { ok: false, code: 'oversize' };
  if (pts.length < NET.MIN_TRACE_POINTS) return { ok: false, code: 'malformed' };
  for (const p of pts) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return { ok: false, code: 'malformed' };
  }
  if (traceByteSize(pts) > NET.MAX_CAST_BYTES) return { ok: false, code: 'oversize' };
  const dur = Number(env.durationMs);
  if (!Number.isFinite(dur) || dur < NET.MIN_TRACE_DURATION_MS) return { ok: false, code: 'too-fast' };
  if (dur > NET.MAX_TRACE_DURATION_MS) return { ok: false, code: 'malformed' };
  return { ok: true };
}

// ---- per-slot remapping -------------------------------------------------
const flip = (i) => (i === 0 ? 1 : 0);

// Slot-bearing fields present on Sim domain events (see sim.js emits). These hold
// wizard slot ids (0/1) and are flipped for the remote recipient. NOTE: purely
// spatial fields (e.g. reaction `center`, an arc position) are intentionally NOT
// listed — arc positions are shared, not per-slot, so they must never be flipped.
const SLOT_FIELDS = ['caster', 'target', 'targetId', 'owner', 'winner', 'by', 'casterId', 'source', 'attacker', 'victim'];

function remapWizard(w, localId) {
  return { ...w, id: localId };
}

// Rewrite a canonical Sim snapshot so the recipient in `slot` sees itself as
// wizard 0 and its opponent as wizard 1.
export function remapSnapshotForSlot(snap, slot) {
  if (!snap) return snap;
  if (slot === 0) return snap;
  const out = { ...snap };
  if (typeof snap.winner === 'number') out.winner = flip(snap.winner);
  if (Array.isArray(snap.wizards) && snap.wizards.length === 2) {
    out.wizards = [remapWizard(snap.wizards[1], 0), remapWizard(snap.wizards[0], 1)];
  }
  if (Array.isArray(snap.projectiles)) {
    out.projectiles = snap.projectiles.map((p) => ({ ...p, owner: flip(p.owner) }));
  }
  if (Array.isArray(snap.zones)) {
    out.zones = snap.zones.map((z) => ({
      ...z,
      owner: flip(z.owner),
      damageTargetId: z.damageTargetId === 0 || z.damageTargetId === 1
        ? flip(z.damageTargetId)
        : z.damageTargetId,
    }));
  }
  return out;
}

// Rewrite domain events for the recipient slot (0/1 slot fields flipped).
export function remapEventForSlot(ev, slot) {
  if (slot === 0 || !ev || typeof ev !== 'object') return ev;
  const out = { ...ev };
  for (const f of SLOT_FIELDS) {
    if (out[f] === 0 || out[f] === 1) out[f] = flip(out[f]);
  }
  return out;
}

export function remapEventsForSlot(events, slot) {
  if (slot === 0 || !Array.isArray(events)) return events || [];
  return events.map((e) => remapEventForSlot(e, slot));
}
