// util.js — small server-side helpers shared by the room manager and match
// room: a deterministic-enough token-bucket rate limiter and a short room-code
// generator using unambiguous characters.

import crypto from 'node:crypto';

// Token-bucket rate limiter. `rate` tokens accrue per second up to `burst`.
export class TokenBucket {
  constructor(rate, burst) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = Date.now();
  }

  take(n = 1, now = Date.now()) {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

export function roomCode(len = 5) {
  const bytes = crypto.randomBytes(len);
  let code = '';
  for (let i = 0; i < len; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

export function normalizeCode(value, len = 5) {
  const s = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== len) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}
