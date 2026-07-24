// ratings.js — optional rating persistence adapter (MASTERPLAN §16 persistence).
//
// If DATABASE_URL is set, use Postgres for anonymous-account rating + results;
// otherwise fall back to an EXPLICIT in-memory development adapter (never a
// silent no-op). Schema initialization is idempotent and safe. All queries are
// parameterized. No secrets live in source — the connection string comes from
// the environment.
//
// Ratings use a simple symmetric Elo update. Quick match is ranked (rating
// affects/records results); private matches pass { ranked: false } and do not
// change ratings (§14).

const DEFAULT_RATING = 1000;
const K = 24;

function expectedScore(a, b) {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

// Compute new ratings for a two-player result. winnerSlot: 0 | 1 | 'draw'.
export function nextRatings(ra, rb, winnerSlot) {
  const sa = winnerSlot === 0 ? 1 : winnerSlot === 1 ? 0 : 0.5;
  const sb = 1 - sa;
  return [
    Math.round(ra + K * (sa - expectedScore(ra, rb))),
    Math.round(rb + K * (sb - expectedScore(rb, ra))),
  ];
}

// --- In-memory development adapter --------------------------------------
class MemoryRatingStore {
  constructor() { this.kind = 'memory'; this.ratings = new Map(); this.results = []; }
  async init() { return this; }
  async getRating(accountId) {
    if (!accountId) return DEFAULT_RATING;
    if (!this.ratings.has(accountId)) this.ratings.set(accountId, DEFAULT_RATING);
    return this.ratings.get(accountId);
  }
  async recordResult({ matchId, ranked, players, winnerSlot }) {
    // players: [{ accountId }, { accountId }] in server slot order.
    const [pa, pb] = players;
    const ra = await this.getRating(pa.accountId);
    const rb = await this.getRating(pb.accountId);
    let na = ra, nb = rb;
    if (ranked) {
      [na, nb] = nextRatings(ra, rb, winnerSlot);
      if (pa.accountId) this.ratings.set(pa.accountId, na);
      if (pb.accountId) this.ratings.set(pb.accountId, nb);
    }
    this.results.push({ matchId, ranked, winnerSlot, at: Date.now(), a: pa.accountId, b: pb.accountId });
    return { ratings: [na, nb], deltas: [na - ra, nb - rb] };
  }
  async close() {}
}

// --- Postgres adapter ----------------------------------------------------
class PostgresRatingStore {
  constructor(pool) { this.kind = 'postgres'; this.pool = pool; }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        rating INTEGER NOT NULL DEFAULT ${DEFAULT_RATING},
        games INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await this.pool.query(`
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
    return this;
  }
  async getRating(accountId) {
    if (!accountId) return DEFAULT_RATING;
    const { rows } = await this.pool.query('SELECT rating FROM accounts WHERE id = $1', [accountId]);
    if (rows.length) return rows[0].rating;
    await this.pool.query(
      'INSERT INTO accounts (id, rating) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [accountId, DEFAULT_RATING],
    );
    return DEFAULT_RATING;
  }
  async recordResult({ matchId, ranked, players, winnerSlot }) {
    const [pa, pb] = players;
    const ra = await this.getRating(pa.accountId);
    const rb = await this.getRating(pb.accountId);
    let na = ra, nb = rb;
    if (ranked) {
      [na, nb] = nextRatings(ra, rb, winnerSlot);
      if (pa.accountId) {
        await this.pool.query(
          'UPDATE accounts SET rating = $2, games = games + 1, updated_at = now() WHERE id = $1',
          [pa.accountId, na],
        );
      }
      if (pb.accountId) {
        await this.pool.query(
          'UPDATE accounts SET rating = $2, games = games + 1, updated_at = now() WHERE id = $1',
          [pb.accountId, nb],
        );
      }
    }
    await this.pool.query(
      `INSERT INTO match_results (match_id, ranked, winner_slot, account_a, account_b, rating_a, rating_b)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (match_id) DO NOTHING`,
      [matchId, ranked, winnerSlot === 'draw' ? null : winnerSlot, pa.accountId, pb.accountId, na, nb],
    );
    return { ratings: [na, nb], deltas: [na - ra, nb - rb] };
  }
  async close() { await this.pool.end(); }
}

// Build the adapter. Returns an initialized store. Uses Postgres only when
// DATABASE_URL is present AND `pg` is installable; otherwise the explicit
// in-memory dev adapter (logged, never silent).
export async function createRatingStore(opts = {}) {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (url) {
    try {
      const pg = await import('pg');
      const Pool = pg.default?.Pool || pg.Pool;
      const ssl = /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
      const pool = new Pool({ connectionString: url, ssl, max: opts.max || 4 });
      const store = new PostgresRatingStore(pool);
      await store.init();
      return store;
    } catch (err) {
      console.warn('[ratings] DATABASE_URL set but Postgres init failed; using in-memory dev store:', err.message);
    }
  }
  const store = new MemoryRatingStore();
  await store.init();
  return store;
}

export { MemoryRatingStore, PostgresRatingStore, DEFAULT_RATING };
