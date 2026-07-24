// quality.js — the single source of truth mapping a recognition score to cast
// potency (SOLO-MODES-PLAN §16). Extracted so the player (client prediction),
// the authoritative server, and the Practice AI all use the SAME function and
// potency math can never drift between them.
//
// DOM-free: imports only the sim tuning constants so it runs identically in
// Node (server + tests), the browser client, and the shared bot.

import { CAST } from '../sim/constants.js';

// The recognizer's default acceptance score. A trace whose best score is below
// this is a rejected cast (below-threshold). Kept here so the Practice AI's
// modelled gesture misses use the exact same bar the human recognizer applies.
export const ACCEPT_THRESHOLD = 0.62;

// Score at/above which potency saturates at the maximum. Below MIN_SCORE potency
// floors at the minimum. Between the two it interpolates linearly.
export const MIN_SCORE = 0.6;
export const MAX_SCORE = 1.0;

// Map a recognition score (~0.60..1.0) to a cast potency (0.90..1.05). A cleaner
// gesture hits marginally harder; a barely-accepted one is at the floor. Clamped
// to the authoritative [minPotency, maxPotency] band so no path can exceed it.
export function qualityFromScore(score) {
  const t = Math.min(1, Math.max(0, (score - MIN_SCORE) / (MAX_SCORE - MIN_SCORE)));
  const q = CAST.minPotency + t * (CAST.maxPotency - CAST.minPotency);
  return Math.min(CAST.maxPotency, Math.max(CAST.minPotency, q));
}
