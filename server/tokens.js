// tokens.js — single-use, HMAC-signed resume tokens for match reconnect
// (MASTERPLAN §17). Pure Node crypto, no external deps. A token binds a player
// to a match slot and carries a rotating nonce so a captured token cannot be
// replayed once it has been rotated on a successful (re)connect.
//
// No secret is stored in source: the signing secret comes from SESSION_SECRET
// (or a per-process random one for local dev) and is injected by server.js.

import crypto from 'node:crypto';

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function signToken(secret, payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// Verify signature + expiry. Returns the decoded payload or null (never throws).
export function verifyToken(secret, token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
  let actual;
  try { actual = Buffer.from(parts[1], 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload || !Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomSecret() {
  return crypto.randomBytes(32).toString('hex');
}
