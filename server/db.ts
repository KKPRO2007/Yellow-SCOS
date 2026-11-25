import pg from 'pg';

export type Query = <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface Db {
  kind: 'neon' | 'pglite';
  query: Query;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Query) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * DATABASE_URL set   -> Postgres over TCP (Neon, or any Postgres).
 * DATABASE_URL unset -> PGlite: real Postgres compiled to WASM, in-process.
 *   PGLITE_DIR set   -> persisted to that folder; unset -> in memory (tests).
 */
export async function connect(url = process.env.DATABASE_URL): Promise<Db> {
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    return {
      kind: 'neon',
      query: async (sql, params) => (await pool.query(sql, params as any[])).rows,
      exec: async (sql) => {
        await pool.query(sql);
      },
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn(async (sql, params) => (await client.query(sql, params as any[])).rows);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.PGLITE_DIR;
  const lite = dir ? new PGlite(dir) : new PGlite();
  return {
    kind: 'pglite',
    query: async (sql, params) => (await lite.query(sql, params as any[])).rows as any[],
    exec: async (sql) => {
      await lite.exec(sql);
    },
    tx: (fn) => lite.transaction((t) => fn(async (sql, params) => (await t.query(sql, params as any[])).rows as any[])),
    close: () => lite.close(),
  };
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('buyer','seller','admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_items (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL,
  price        INT  NOT NULL CHECK (price > 0),
  cost         INT,
  prep_minutes INT  NOT NULL,
  veg          BOOLEAN NOT NULL DEFAULT true,
  available    BOOLEAN NOT NULL DEFAULT true,
  sort         INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per (day, 15-minute slot). "booked" only ever moves through a
-- conditional UPDATE, so two buyers can never both take the last place.
CREATE TABLE IF NOT EXISTS slots (
  service_date TEXT NOT NULL,
  slot_start   TEXT NOT NULL,
  capacity     INT  NOT NULL,
  booked       INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (service_date, slot_start)
);

CREATE TABLE IF NOT EXISTS day_counters (
  service_date TEXT PRIMARY KEY,
  n            INT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id           SERIAL PRIMARY KEY,
  token_no     INT  NOT NULL,
  user_id      INT  REFERENCES users(id) ON DELETE SET NULL,
  service_date TEXT NOT NULL,
  slot_start   TEXT NOT NULL,
  placed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT NOT NULL DEFAULT 'placed'
               CHECK (status IN ('placed','cooking','ready','collected','cancelled')),
  total        INT  NOT NULL,
  discount     INT  NOT NULL DEFAULT 0,
  ready_eta    TIMESTAMPTZ,
  ready_at     TIMESTAMPTZ,
  source       TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','history','seed'))
);
CREATE INDEX IF NOT EXISTS orders_day_slot ON orders (service_date, slot_start);
CREATE INDEX IF NOT EXISTS orders_user ON orders (user_id);

CREATE TABLE IF NOT EXISTS order_items (
  order_id   INT  NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES menu_items(id),
  qty        INT  NOT NULL CHECK (qty > 0),
  unit_price INT  NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items (order_id);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS cost INT;

-- Payments: 'unpaid' (just booked), 'paid' (UPI), 'counter' (pays at pickup).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_ref TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
-- Group orders: which friend each line is for (NULL = the buyer).
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS for_name TEXT;

-- Students waiting for a full slot; the first one is told when a place frees.
CREATE TABLE IF NOT EXISTS waitlist (
  user_id      INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_date TEXT NOT NULL,
  slot_start   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at  TIMESTAMPTZ,
  PRIMARY KEY (user_id, service_date, slot_start)
);

-- Raw stock on hand. Orders use it up through recipes; cancels give it back.
CREATE TABLE IF NOT EXISTS ingredients (
  name          TEXT PRIMARY KEY,
  unit          TEXT NOT NULL,
  on_hand       NUMERIC(12,3) NOT NULL DEFAULT 0,
  reorder_level NUMERIC(12,3) NOT NULL DEFAULT 0,
  price         NUMERIC(10,2) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Change feed for live screens. In-process fan-out can't reach clients held by
-- other serverless instances, so every instance tails this table instead.
CREATE TABLE IF NOT EXISTS events (
  id    BIGSERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  data  TEXT NOT NULL,
  at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
