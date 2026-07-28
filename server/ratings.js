// ratings.js — persistent Glyph rankings, match history, and quarterly seasons.
//
// PostgreSQL is authoritative when DATABASE_URL is configured. The memory
// adapter mirrors the same behavior for tests, LAN hosting, and local dev.

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const DEFAULT_GLYPHS = 100;
export const GLYPH_TRANSFER_MIN = 5;
export const GLYPH_TRANSFER_MAX = 50;
export const GLYPH_TRANSFER_EQUAL = 25;
export const SEASON_CHECK_MS = 60 * 60 * 1000;
export const TEMP_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const USERNAME_PATTERN = /^[A-Za-z0-9]{1,24}$/;
export const PIN_PATTERN = /^\d{6}$/;

export function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateTemporaryCredentials(username, pin) {
  if (!USERNAME_PATTERN.test(String(username || ''))) {
    return { ok: false, code: 'invalid-username' };
  }
  if (!PIN_PATTERN.test(String(pin || ''))) {
    return { ok: false, code: 'invalid-pin' };
  }
  return { ok: true };
}

async function derivePinHash(pin, salt) {
  const value = await scrypt(String(pin), salt, 32);
  return Buffer.from(value).toString('hex');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function cleanName(value) {
  return String(value || '').trim().slice(0, 24);
}

function publicProfile(account, rank = null) {
  if (!account) return null;
  return {
    name: account.displayName || 'Anonymous wizard',
    glyphs: Number(account.glyphs) || 0,
    wins: Number(account.wins) || 0,
    losses: Number(account.losses) || 0,
    draws: Number(account.draws) || 0,
    games: Number(account.rankedGames) || 0,
    rank: rank == null ? null : Number(rank),
  };
}

export function glyphTransfer(winnerGlyphs, loserGlyphs) {
  const winner = Math.max(0, Math.floor(Number(winnerGlyphs) || 0));
  const loser = Math.max(0, Math.floor(Number(loserGlyphs) || 0));
  return Math.max(
    GLYPH_TRANSFER_MIN,
    Math.min(
      GLYPH_TRANSFER_MAX,
      GLYPH_TRANSFER_EQUAL + Math.round((loser - winner) / 10),
    ),
  );
}

// winnerSlot: 0 | 1 | 'draw'. The winner always receives the full transfer;
// the loser cannot fall below zero.
export function nextGlyphs(glyphsA, glyphsB, winnerSlot) {
  const before = [
    Math.max(0, Math.floor(Number(glyphsA) || 0)),
    Math.max(0, Math.floor(Number(glyphsB) || 0)),
  ];
  if (winnerSlot !== 0 && winnerSlot !== 1) {
    return { glyphs: before.slice(), deltas: [0, 0], transfer: 0 };
  }
  const loserSlot = winnerSlot === 0 ? 1 : 0;
  const transfer = glyphTransfer(before[winnerSlot], before[loserSlot]);
  const after = before.slice();
  after[winnerSlot] += transfer;
  after[loserSlot] = Math.max(0, after[loserSlot] - transfer);
  return {
    glyphs: after,
    deltas: [after[0] - before[0], after[1] - before[1]],
    transfer,
  };
}

export function quarterStart(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const month = Math.floor(date.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(date.getUTCFullYear(), month, 1));
}

export function seasonKey(value = new Date()) {
  const start = quarterStart(value);
  return `${start.getUTCFullYear()}-Q${Math.floor(start.getUTCMonth() / 3) + 1}`;
}

export function resetGlyphTotal(value) {
  const glyphs = Math.max(0, Math.floor(Number(value) || 0));
  return Math.max(0, Math.floor(glyphs / 300) * 300 - 50);
}

function nextQuarter(value) {
  const start = quarterStart(value);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 1));
}

function compareAccounts(a, b) {
  return b.glyphs - a.glyphs
    || b.wins - a.wins
    || a.losses - b.losses
    || a.glyphsReachedAt - b.glyphsReachedAt
    || a.id.localeCompare(b.id);
}

class MemoryRatingStore {
  constructor() {
    this.kind = 'memory';
    this.accounts = new Map();
    this.results = new Map();
    this.credentials = new Map();
    this.sessions = new Map();
    this.credentialLocks = new Map();
    this.seasons = [];
    this.currentSeasonStart = null;
    this.seasonTimer = null;
  }

  async init(now = new Date()) {
    this.currentSeasonStart = quarterStart(now);
    this.seasons.push({
      key: seasonKey(now),
      startsAt: this.currentSeasonStart,
      resetAppliedAt: now,
      accountsReset: 0,
    });
    return this;
  }

  ensureAccount(accountId, name = '') {
    if (!accountId) {
      return {
        id: '', displayName: cleanName(name), glyphs: DEFAULT_GLYPHS,
        wins: 0, losses: 0, draws: 0, rankedGames: 0,
        glyphsReachedAt: Date.now(),
      };
    }
    let account = this.accounts.get(accountId);
    if (!account) {
      account = {
        id: accountId,
        displayName: cleanName(name),
        glyphs: DEFAULT_GLYPHS,
        wins: 0,
        losses: 0,
        draws: 0,
        rankedGames: 0,
        glyphsReachedAt: Date.now(),
      };
      this.accounts.set(accountId, account);
    } else if (cleanName(name)) {
      account.displayName = cleanName(name);
    }
    return account;
  }

  rankedAccounts() {
    return [...this.accounts.values()]
      .filter((account) => account.rankedGames > 0)
      .sort(compareAccounts);
  }

  rankOf(accountId) {
    const index = this.rankedAccounts().findIndex((account) => account.id === accountId);
    return index < 0 ? null : index + 1;
  }

  async withCredentialLock(key, action) {
    const previous = this.credentialLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const current = previous.then(() => gate);
    this.credentialLocks.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.credentialLocks.get(key) === current) this.credentialLocks.delete(key);
    }
  }

  async authenticateTemporary(username, pin) {
    const validation = validateTemporaryCredentials(username, pin);
    if (!validation.ok) return validation;
    const usernameKey = normalizeUsername(username);
    return this.withCredentialLock(usernameKey, () =>
      this.authenticateTemporaryUnlocked(username, pin, usernameKey));
  }

  async authenticateTemporaryUnlocked(username, pin, usernameKey) {
    let credential = this.credentials.get(usernameKey);
    let created = false;
    if (credential) {
      const hash = await derivePinHash(pin, credential.salt);
      const expected = Buffer.from(credential.hash, 'hex');
      const actual = Buffer.from(hash, 'hex');
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        return { ok: false, code: 'name-taken' };
      }
    } else {
      const accountId = `acct-${crypto.randomUUID()}`;
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await derivePinHash(pin, salt);
      const account = this.ensureAccount(accountId, username);
      account.displayName = username;
      credential = { accountId, name: username, salt, hash };
      this.credentials.set(usernameKey, credential);
      created = true;
    }
    const token = createSessionToken();
    this.sessions.set(hashSessionToken(token), {
      accountId: credential.accountId,
      expiresAt: Date.now() + TEMP_SESSION_TTL_MS,
    });
    const rankings = await this.getLeaderboard(credential.accountId, credential.name, 100);
    return {
      ok: true,
      created,
      accountId: credential.accountId,
      name: credential.name,
      token,
      profile: rankings.self,
    };
  }

  async resolveTemporarySession(token) {
    const key = hashSessionToken(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    const account = this.accounts.get(session.accountId);
    if (!account) return null;
    return {
      accountId: account.id,
      name: account.displayName,
    };
  }

  async getGlyphs(accountId, name = '') {
    await this.ensureCurrentSeason();
    return this.ensureAccount(accountId, name).glyphs;
  }

  async getLeaderboard(accountId, name = '', limit = 10) {
    await this.ensureCurrentSeason();
    const selfAccount = this.ensureAccount(accountId, name);
    const ranked = this.rankedAccounts();
    return {
      season: seasonKey(this.currentSeasonStart),
      top: ranked.slice(0, Math.max(1, Math.min(100, Number(limit) || 10)))
        .map((account, index) => publicProfile(account, index + 1)),
      self: publicProfile(selfAccount, this.rankOf(accountId)),
    };
  }

  async recordResult({ matchId, ranked, players, winnerSlot, reason }) {
    if (!ranked) return { matchId, ranked: false, applied: false };
    await this.ensureCurrentSeason();
    if (this.results.has(matchId)) return { ...this.results.get(matchId), applied: false };
    const [pa, pb] = players;
    const accounts = [
      this.ensureAccount(pa.accountId, pa.name),
      this.ensureAccount(pb.accountId, pb.name),
    ];
    const effectiveRanked = !!ranked
      && !!pa.accountId
      && !!pb.accountId
      && pa.accountId !== pb.accountId;
    const before = accounts.map((account) => account.glyphs);
    const update = effectiveRanked
      ? nextGlyphs(before[0], before[1], winnerSlot)
      : { glyphs: before.slice(), deltas: [0, 0], transfer: 0 };

    if (effectiveRanked) {
      for (let slot = 0; slot < 2; slot++) {
        const account = accounts[slot];
        account.glyphs = update.glyphs[slot];
        account.rankedGames++;
        if (winnerSlot === 'draw' || winnerSlot == null) account.draws++;
        else if (winnerSlot === slot) account.wins++;
        else account.losses++;
        if (update.deltas[slot] !== 0) account.glyphsReachedAt = Date.now();
      }
    }

    const result = {
      matchId,
      ranked: effectiveRanked,
      applied: true,
      season: seasonKey(this.currentSeasonStart),
      winnerSlot,
      reason,
      transfer: update.transfer,
      players: accounts.map((account, slot) => ({
        ...publicProfile(account, this.rankOf(account.id)),
        accountId: account.id,
        glyphsBefore: before[slot],
        glyphsAfter: update.glyphs[slot],
        delta: update.deltas[slot],
      })),
    };
    this.results.set(matchId, result);
    return result;
  }

  async ensureCurrentSeason(now = new Date()) {
    const target = quarterStart(now);
    if (!this.currentSeasonStart) {
      this.currentSeasonStart = target;
      return { applied: false, season: seasonKey(target), resets: 0 };
    }
    let resets = 0;
    while (this.currentSeasonStart < target) {
      this.currentSeasonStart = nextQuarter(this.currentSeasonStart);
      let accountsReset = 0;
      for (const account of this.accounts.values()) {
        if (account.rankedGames <= 0) continue;
        account.glyphs = resetGlyphTotal(account.glyphs);
        account.glyphsReachedAt = now.getTime();
        accountsReset++;
      }
      this.seasons.push({
        key: seasonKey(this.currentSeasonStart),
        startsAt: this.currentSeasonStart,
        resetAppliedAt: now,
        accountsReset,
      });
      resets++;
    }
    return { applied: resets > 0, season: seasonKey(target), resets };
  }

  startSeasonScheduler() {
    if (this.seasonTimer) return;
    this.seasonTimer = setInterval(() => {
      this.ensureCurrentSeason().catch(() => {});
    }, SEASON_CHECK_MS);
    if (this.seasonTimer.unref) this.seasonTimer.unref();
  }

  async close() {
    if (this.seasonTimer) clearInterval(this.seasonTimer);
    this.seasonTimer = null;
  }
}

class PostgresRatingStore {
  constructor(pool) {
    this.kind = 'postgres';
    this.pool = pool;
    this.seasonTimer = null;
  }

  async init(now = new Date()) {
    const schema = await this.pool.connect();
    try {
      await schema.query(`SELECT pg_advisory_lock(hashtext('aetherglyph-ranking-schema-migration'))`);
      await schema.query(`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          rating INTEGER NOT NULL DEFAULT 1000,
          games INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await schema.query(`
        ALTER TABLE accounts
          ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS glyphs INTEGER NOT NULL DEFAULT ${DEFAULT_GLYPHS},
          ADD COLUMN IF NOT EXISTS ranked_games INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS ranked_wins INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS ranked_losses INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS ranked_draws INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS glyphs_reached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      `);
      await schema.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'accounts_glyphs_nonnegative'
              AND conrelid = 'accounts'::regclass
          ) THEN
            ALTER TABLE accounts
              ADD CONSTRAINT accounts_glyphs_nonnegative CHECK (glyphs >= 0);
          END IF;
        END
        $$
      `);
      await schema.query(`
        CREATE TABLE IF NOT EXISTS match_results (
          match_id TEXT PRIMARY KEY,
          ranked BOOLEAN NOT NULL,
          winner_slot SMALLINT,
          account_a TEXT,
          account_b TEXT,
          rating_a INTEGER,
          rating_b INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await schema.query(`
        ALTER TABLE match_results
          ADD COLUMN IF NOT EXISTS reason TEXT,
          ADD COLUMN IF NOT EXISTS glyphs_a_before INTEGER,
          ADD COLUMN IF NOT EXISTS glyphs_b_before INTEGER,
          ADD COLUMN IF NOT EXISTS glyphs_delta INTEGER,
          ADD COLUMN IF NOT EXISTS glyphs_a_after INTEGER,
          ADD COLUMN IF NOT EXISTS glyphs_b_after INTEGER
      `);
      await schema.query(`
        CREATE TABLE IF NOT EXISTS ranking_seasons (
          season_key TEXT PRIMARY KEY,
          starts_at TIMESTAMPTZ NOT NULL,
          reset_applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          accounts_reset INTEGER NOT NULL DEFAULT 0
        )`);
      await schema.query(`
        CREATE TABLE IF NOT EXISTS account_identities (
          provider TEXT NOT NULL,
          provider_user_id TEXT NOT NULL,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (provider, provider_user_id)
        )`);
      await schema.query(`
        CREATE TABLE IF NOT EXISTS temporary_credentials (
          username_key TEXT PRIMARY KEY,
          account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
          pin_salt TEXT NOT NULL,
          pin_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await schema.query(`
        ALTER TABLE temporary_credentials
          ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS blocked_until TIMESTAMPTZ
      `);
      await schema.query(`
        CREATE TABLE IF NOT EXISTS temporary_sessions (
          token_hash TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await schema.query(`
        CREATE INDEX IF NOT EXISTS temporary_sessions_expiry_idx
        ON temporary_sessions (expires_at)
      `);
      await schema.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          migration_key TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      // The pre-auth test leaderboard used client-chosen anonymous ids. Keep the
      // rows for deletion/history purposes but remove them from competitive rank.
      const legacyReset = await schema.query(`
        INSERT INTO schema_migrations (migration_key)
        VALUES ('2026-07-temporary-accounts-reset-anonymous-rankings')
        ON CONFLICT DO NOTHING
        RETURNING migration_key
      `);
      if (legacyReset.rows.length) {
        await schema.query(`
          UPDATE accounts a SET
            glyphs = ${DEFAULT_GLYPHS},
            ranked_games = 0,
            ranked_wins = 0,
            ranked_losses = 0,
            ranked_draws = 0,
            updated_at = now()
          WHERE ranked_games > 0
            AND NOT EXISTS (
              SELECT 1 FROM temporary_credentials c WHERE c.account_id = a.id
            )
        `);
      }
      await schema.query(`
        CREATE INDEX IF NOT EXISTS accounts_world_rank_idx
        ON accounts (glyphs DESC, ranked_wins DESC, ranked_losses ASC, glyphs_reached_at ASC)
        WHERE ranked_games > 0
      `);
      await schema.query(`
        CREATE INDEX IF NOT EXISTS match_results_accounts_idx
        ON match_results (account_a, account_b, created_at DESC)
      `);
    } finally {
      try {
        await schema.query(`SELECT pg_advisory_unlock(hashtext('aetherglyph-ranking-schema-migration'))`);
      } catch { /* migration error remains authoritative */ }
      schema.release();
    }
    await this.ensureCurrentSeason(now);
    return this;
  }

  async ensureAccount(queryable, accountId, name = '') {
    if (!accountId) return null;
    const { rows } = await queryable.query(
      `INSERT INTO accounts (id, display_name, glyphs)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         display_name = CASE
           WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name
           ELSE accounts.display_name
         END,
         updated_at = now()
       RETURNING id, display_name, glyphs, ranked_games, ranked_wins,
         ranked_losses, ranked_draws, glyphs_reached_at`,
      [accountId, cleanName(name), DEFAULT_GLYPHS],
    );
    return rows[0];
  }

  async issueTemporarySession(accountId) {
    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + TEMP_SESSION_TTL_MS);
    await this.pool.query(
      `INSERT INTO temporary_sessions (token_hash, account_id, expires_at)
       VALUES ($1, $2, $3)`,
      [hashSessionToken(token), accountId, expiresAt],
    );
    return token;
  }

  async authenticateTemporary(username, pin) {
    const validation = validateTemporaryCredentials(username, pin);
    if (!validation.ok) return validation;
    const usernameKey = normalizeUsername(username);
    const existing = await this.pool.query(
      `SELECT c.account_id, c.pin_salt, c.pin_hash, c.failed_attempts,
         c.blocked_until, a.display_name
       FROM temporary_credentials c
       JOIN accounts a ON a.id = c.account_id
       WHERE c.username_key = $1`,
      [usernameKey],
    );
    let accountId;
    let displayName;
    let created = false;
    if (existing.rows.length) {
      const credential = existing.rows[0];
      if (credential.blocked_until && new Date(credential.blocked_until).getTime() > Date.now()) {
        return { ok: false, code: 'rate' };
      }
      const hash = await derivePinHash(pin, credential.pin_salt);
      const expected = Buffer.from(credential.pin_hash, 'hex');
      const actual = Buffer.from(hash, 'hex');
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        const failures = Number(credential.failed_attempts) + 1;
        const blockSeconds = failures >= 5
          ? Math.min(600, 30 * 2 ** Math.min(4, failures - 5))
          : 0;
        await this.pool.query(
          `UPDATE temporary_credentials SET
             failed_attempts = $2,
             blocked_until = CASE
               WHEN $3 > 0 THEN now() + ($3 * interval '1 second')
               ELSE blocked_until
             END
           WHERE username_key = $1`,
          [usernameKey, failures, blockSeconds],
        );
        return { ok: false, code: 'name-taken' };
      }
      await this.pool.query(
        `UPDATE temporary_credentials
         SET failed_attempts = 0, blocked_until = NULL
         WHERE username_key = $1`,
        [usernameKey],
      );
      accountId = credential.account_id;
      displayName = credential.display_name;
    } else {
      accountId = `acct-${crypto.randomUUID()}`;
      displayName = username;
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await derivePinHash(pin, salt);
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO accounts (id, display_name, glyphs)
           VALUES ($1, $2, $3)`,
          [accountId, displayName, DEFAULT_GLYPHS],
        );
        const inserted = await client.query(
          `INSERT INTO temporary_credentials (
             username_key, account_id, pin_salt, pin_hash
           ) VALUES ($1, $2, $3, $4)
           ON CONFLICT (username_key) DO NOTHING
           RETURNING username_key`,
          [usernameKey, accountId, salt, hash],
        );
        if (!inserted.rows.length) {
          await client.query('ROLLBACK');
          return this.authenticateTemporary(username, pin);
        }
        await client.query(
          `INSERT INTO account_identities (provider, provider_user_id, account_id)
           VALUES ('temporary-pin', $1, $2)
           ON CONFLICT (provider, provider_user_id) DO NOTHING`,
          [usernameKey, accountId],
        );
        await client.query('COMMIT');
        created = true;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* original error wins */ }
        if (error?.code === '23505') return this.authenticateTemporary(username, pin);
        throw error;
      } finally {
        client.release();
      }
    }

    await this.pool.query('DELETE FROM temporary_sessions WHERE expires_at <= now()');
    const token = await this.issueTemporarySession(accountId);
    const rankings = await this.getLeaderboard(accountId, displayName, 100);
    return {
      ok: true,
      created,
      accountId,
      name: displayName,
      token,
      profile: rankings.self,
    };
  }

  async resolveTemporarySession(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 256) return null;
    const { rows } = await this.pool.query(
      `SELECT s.account_id, a.display_name
       FROM temporary_sessions s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashSessionToken(token)],
    );
    if (!rows.length) return null;
    return {
      accountId: rows[0].account_id,
      name: rows[0].display_name,
    };
  }

  async getGlyphs(accountId, name = '') {
    if (!accountId) return DEFAULT_GLYPHS;
    await this.ensureCurrentSeason();
    const row = await this.ensureAccount(this.pool, accountId, name);
    return Number(row.glyphs);
  }

  async getLeaderboard(accountId, name = '', limit = 10) {
    await this.ensureCurrentSeason();
    if (accountId) await this.ensureAccount(this.pool, accountId, name);
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 10));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { rows: topRows } = await client.query(
        `WITH ranked AS (
           SELECT id, display_name, glyphs, ranked_games, ranked_wins,
             ranked_losses, ranked_draws,
             ROW_NUMBER() OVER (
               ORDER BY glyphs DESC, ranked_wins DESC, ranked_losses ASC,
                 glyphs_reached_at ASC, id ASC
             ) AS world_rank
           FROM accounts
           WHERE ranked_games > 0
         )
         SELECT * FROM ranked WHERE world_rank <= $1 ORDER BY world_rank`,
        [boundedLimit],
      );
      let self = null;
      if (accountId) {
        const { rows } = await client.query(
          `WITH ranked AS (
             SELECT id, display_name, glyphs, ranked_games, ranked_wins,
               ranked_losses, ranked_draws,
               ROW_NUMBER() OVER (
                 ORDER BY glyphs DESC, ranked_wins DESC, ranked_losses ASC,
                   glyphs_reached_at ASC, id ASC
               ) AS world_rank
             FROM accounts
             WHERE ranked_games > 0
           )
           SELECT a.id, a.display_name, a.glyphs, a.ranked_games,
             a.ranked_wins, a.ranked_losses, a.ranked_draws, r.world_rank
           FROM accounts a
           LEFT JOIN ranked r ON r.id = a.id
           WHERE a.id = $1`,
          [accountId],
        );
        const rankedSelf = rows[0];
        self = publicProfile({
          displayName: rankedSelf.display_name,
          glyphs: rankedSelf.glyphs,
          rankedGames: rankedSelf.ranked_games,
          wins: rankedSelf.ranked_wins,
          losses: rankedSelf.ranked_losses,
          draws: rankedSelf.ranked_draws,
        }, rankedSelf?.world_rank ?? null);
      }
      const seasonResult = await client.query(
        'SELECT season_key FROM ranking_seasons ORDER BY starts_at DESC LIMIT 1',
      );
      await client.query('COMMIT');
      return {
        season: seasonResult.rows[0]?.season_key || seasonKey(),
        top: topRows.map((row) => publicProfile({
          displayName: row.display_name,
          glyphs: row.glyphs,
          rankedGames: row.ranked_games,
          wins: row.ranked_wins,
          losses: row.ranked_losses,
          draws: row.ranked_draws,
        }, row.world_rank)),
        self,
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* original error wins */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async loadStoredResult(queryable, matchId, players) {
    const stored = await queryable.query(
      `SELECT match_id, ranked, winner_slot, reason, account_a, account_b,
         glyphs_a_before, glyphs_b_before, glyphs_delta,
         glyphs_a_after, glyphs_b_after
       FROM match_results
       WHERE match_id = $1`,
      [matchId],
    );
    const row = stored.rows[0];
    if (!row) return null;
    if (!row.ranked || row.glyphs_a_before == null || row.glyphs_b_before == null
        || row.glyphs_a_after == null || row.glyphs_b_after == null) {
      return { matchId, ranked: !!row.ranked, applied: false };
    }
    const accountIds = [row.account_a, row.account_b];
    const rankedProfiles = await queryable.query(
      `WITH ranked AS (
         SELECT id, display_name, glyphs, ranked_games, ranked_wins,
           ranked_losses, ranked_draws,
           ROW_NUMBER() OVER (
             ORDER BY glyphs DESC, ranked_wins DESC, ranked_losses ASC,
               glyphs_reached_at ASC, id ASC
           ) AS world_rank
         FROM accounts
         WHERE ranked_games > 0
       )
       SELECT * FROM ranked WHERE id = ANY($1::text[])`,
      [accountIds],
    );
    const profilesById = new Map(rankedProfiles.rows.map((profile) => [profile.id, profile]));
    const seasonResult = await queryable.query(
      'SELECT season_key FROM ranking_seasons ORDER BY starts_at DESC LIMIT 1',
    );
    const before = [Number(row.glyphs_a_before), Number(row.glyphs_b_before)];
    const after = [Number(row.glyphs_a_after), Number(row.glyphs_b_after)];
    return {
      matchId,
      ranked: true,
      applied: false,
      season: seasonResult.rows[0]?.season_key || seasonKey(),
      winnerSlot: row.winner_slot == null ? 'draw' : Number(row.winner_slot),
      reason: row.reason,
      transfer: Number(row.glyphs_delta) || 0,
      players: accountIds.map((accountId, slot) => {
        const profile = profilesById.get(accountId);
        return {
          ...publicProfile({
            displayName: profile?.display_name || players?.[slot]?.name,
            glyphs: after[slot],
            rankedGames: profile?.ranked_games,
            wins: profile?.ranked_wins,
            losses: profile?.ranked_losses,
            draws: profile?.ranked_draws,
          }, profile?.world_rank ?? null),
          accountId,
          glyphsBefore: before[slot],
          glyphsAfter: after[slot],
          delta: after[slot] - before[slot],
        };
      }),
    };
  }

  async recordResult(args) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.recordResultOnce(args);
      } catch (error) {
        if (error?.ambiguousCommit) {
          try {
            const stored = await this.loadStoredResult(this.pool, args.matchId, args.players);
            if (stored?.players) return stored;
          } catch { /* retry the settlement path below */ }
        }
        const retryable = error?.ambiguousCommit || ['40P01', '40001'].includes(error?.code);
        if (!retryable || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    return null;
  }

  async recordResultOnce({ matchId, ranked, players, winnerSlot, reason }) {
    const [pa, pb] = players;
    const effectiveRanked = !!ranked
      && !!pa.accountId
      && !!pb.accountId
      && pa.accountId !== pb.accountId;
    if (!effectiveRanked) return { matchId, ranked: false, applied: false };
    const client = await this.pool.connect();
    let commitStarted = false;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('aetherglyph-quarterly-ranking-reset'))`);
      const season = await this.ensureCurrentSeasonInTransaction(client, new Date());
      const inserted = await client.query(
        `INSERT INTO match_results (
           match_id, ranked, winner_slot, account_a, account_b, reason
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (match_id) DO NOTHING
         RETURNING match_id`,
        [
          matchId,
          effectiveRanked,
          winnerSlot === 'draw' || winnerSlot == null ? null : winnerSlot,
          pa.accountId,
          pb.accountId,
          reason || null,
        ],
      );
      if (!inserted.rows.length) {
        const stored = await this.loadStoredResult(client, matchId, players);
        commitStarted = true;
        await client.query('COMMIT');
        commitStarted = false;
        return stored || { matchId, ranked: effectiveRanked, applied: false };
      }

      const identities = [
        { accountId: pa.accountId, name: pa.name },
        { accountId: pb.accountId, name: pb.name },
      ].sort((a, b) => String(a.accountId).localeCompare(String(b.accountId)));
      for (const identity of identities) {
        await this.ensureAccount(client, identity.accountId, identity.name);
      }
      const locked = await client.query(
        `SELECT id, display_name, glyphs, ranked_games, ranked_wins,
           ranked_losses, ranked_draws
         FROM accounts
         WHERE id = ANY($1::text[])
         ORDER BY id
         FOR UPDATE`,
        [[pa.accountId, pb.accountId]],
      );
      const byId = new Map(locked.rows.map((row) => [row.id, row]));
      const accounts = [byId.get(pa.accountId), byId.get(pb.accountId)];
      const before = accounts.map((account) => Number(account.glyphs));
      const update = effectiveRanked
        ? nextGlyphs(before[0], before[1], winnerSlot)
        : { glyphs: before.slice(), deltas: [0, 0], transfer: 0 };

      if (effectiveRanked) {
        for (let slot = 0; slot < 2; slot++) {
          const won = winnerSlot === slot ? 1 : 0;
          const lost = winnerSlot === (slot === 0 ? 1 : 0) ? 1 : 0;
          const drew = winnerSlot === 'draw' || winnerSlot == null ? 1 : 0;
          await client.query(
            `UPDATE accounts SET
               glyphs = $2,
               games = games + 1,
               ranked_games = ranked_games + 1,
               ranked_wins = ranked_wins + $3,
               ranked_losses = ranked_losses + $4,
               ranked_draws = ranked_draws + $5,
               glyphs_reached_at = CASE WHEN glyphs <> $2 THEN now() ELSE glyphs_reached_at END,
               updated_at = now()
             WHERE id = $1`,
            [accounts[slot].id, update.glyphs[slot], won, lost, drew],
          );
        }
      }

      await client.query(
        `UPDATE match_results SET
           glyphs_a_before = $2,
           glyphs_b_before = $3,
           glyphs_delta = $4,
           glyphs_a_after = $5,
           glyphs_b_after = $6
         WHERE match_id = $1`,
        [
          matchId,
          before[0],
          before[1],
          update.transfer,
          update.glyphs[0],
          update.glyphs[1],
        ],
      );
      const rankedProfiles = await client.query(
        `WITH ranked AS (
           SELECT id, display_name, glyphs, ranked_games, ranked_wins,
             ranked_losses, ranked_draws,
             ROW_NUMBER() OVER (
               ORDER BY glyphs DESC, ranked_wins DESC, ranked_losses ASC,
                 glyphs_reached_at ASC, id ASC
             ) AS world_rank
           FROM accounts
           WHERE ranked_games > 0
         )
         SELECT * FROM ranked WHERE id = ANY($1::text[])`,
        [[pa.accountId, pb.accountId]],
      );
      const profilesById = new Map(rankedProfiles.rows.map((row) => [row.id, row]));
      const result = {
        matchId,
        ranked: effectiveRanked,
        applied: true,
        season: season.season,
        winnerSlot,
        reason,
        transfer: update.transfer,
        players: players.map((player, slot) => ({
          ...publicProfile({
            displayName: profilesById.get(player.accountId)?.display_name
              ?? accounts[slot].display_name,
            glyphs: update.glyphs[slot],
            rankedGames: effectiveRanked
              ? Number(accounts[slot].ranked_games) + 1
              : Number(accounts[slot].ranked_games),
            wins: Number(accounts[slot].ranked_wins)
              + (effectiveRanked && winnerSlot === slot ? 1 : 0),
            losses: Number(accounts[slot].ranked_losses)
              + (effectiveRanked && winnerSlot === (slot === 0 ? 1 : 0) ? 1 : 0),
            draws: Number(accounts[slot].ranked_draws)
              + (effectiveRanked && (winnerSlot === 'draw' || winnerSlot == null) ? 1 : 0),
          }, profilesById.get(player.accountId)?.world_rank ?? null),
          accountId: player.accountId,
          glyphsBefore: before[slot],
          glyphsAfter: update.glyphs[slot],
          delta: update.deltas[slot],
        })),
      };
      commitStarted = true;
      await client.query('COMMIT');
      commitStarted = false;
      return result;
    } catch (error) {
      if (commitStarted) error.ambiguousCommit = true;
      try { await client.query('ROLLBACK'); } catch { /* original error wins */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async ensureCurrentSeasonInTransaction(client, now = new Date()) {
    const target = quarterStart(now);
    const latest = await client.query(
      'SELECT starts_at FROM ranking_seasons ORDER BY starts_at DESC LIMIT 1',
    );
    if (!latest.rows.length) {
      await client.query(
        `INSERT INTO ranking_seasons (season_key, starts_at, reset_applied_at, accounts_reset)
         VALUES ($1, $2, $3, 0)`,
        [seasonKey(target), target, now],
      );
      return { applied: false, season: seasonKey(target), resets: 0 };
    }

    let cursor = quarterStart(latest.rows[0].starts_at);
    let resets = 0;
    while (cursor < target) {
      cursor = nextQuarter(cursor);
      const reset = await client.query(
        `UPDATE accounts SET
           glyphs = GREATEST(0, FLOOR(glyphs / 300.0) * 300 - 50)::integer,
           glyphs_reached_at = $1,
           updated_at = $1
         WHERE ranked_games > 0`,
        [now],
      );
      await client.query(
        `INSERT INTO ranking_seasons (
           season_key, starts_at, reset_applied_at, accounts_reset
         ) VALUES ($1, $2, $3, $4)`,
        [seasonKey(cursor), cursor, now, reset.rowCount],
      );
      resets++;
    }
    return { applied: resets > 0, season: seasonKey(target), resets };
  }

  async ensureCurrentSeason(now = new Date()) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('aetherglyph-quarterly-ranking-reset'))`);
      const result = await this.ensureCurrentSeasonInTransaction(client, now);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* original error wins */ }
      throw error;
    } finally {
      client.release();
    }
  }

  startSeasonScheduler() {
    if (this.seasonTimer) return;
    this.seasonTimer = setInterval(() => {
      this.ensureCurrentSeason().catch((error) => {
        console.warn('[rankings] quarterly reset check failed:', error.message);
      });
    }, SEASON_CHECK_MS);
    if (this.seasonTimer.unref) this.seasonTimer.unref();
  }

  async close() {
    if (this.seasonTimer) clearInterval(this.seasonTimer);
    this.seasonTimer = null;
    await this.pool.end();
  }
}

// Build the adapter. PostgreSQL is used whenever DATABASE_URL is configured.
export async function createRatingStore(opts = {}) {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (url) {
    let pool = null;
    try {
      const pg = await import('pg');
      const Pool = pg.default?.Pool || pg.Pool;
      const hostname = new URL(url).hostname;
      const local = /^(?:localhost|127\.0\.0\.1)$/.test(hostname);
      const renderInternal = process.env.RENDER === 'true'
        || hostname.endsWith('.render.com')
        || !hostname.includes('.');
      const rejectUnauthorized = process.env.PGSSL_REJECT_UNAUTHORIZED == null
        ? !renderInternal
        : process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false';
      const ssl = local ? false : { rejectUnauthorized };
      pool = new Pool({ connectionString: url, ssl, max: opts.max || 4 });
      const store = new PostgresRatingStore(pool);
      await store.init();
      store.startSeasonScheduler();
      return store;
    } catch (error) {
      if (pool) {
        try { await pool.end(); } catch { /* initialization error remains authoritative */ }
      }
      throw new Error(`PostgreSQL ranking initialization failed: ${error.message}`, { cause: error });
    }
  }
  const store = new MemoryRatingStore();
  await store.init();
  store.startSeasonScheduler();
  return store;
}

// Compatibility aliases for older tests/importers during the Glyph migration.
export const DEFAULT_RATING = DEFAULT_GLYPHS;
export const nextRatings = nextGlyphs;
export { MemoryRatingStore, PostgresRatingStore };
