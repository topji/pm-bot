import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type BotDb = {
  db: Database.Database;
  close: () => void;
};

function loadSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "schema.sql"),
    join(here, "../../src/state/schema.sql"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error(`schema.sql not found (tried: ${candidates.join(", ")})`);
}

function migrateMarketStateOrderSide(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(market_state)").all() as { name: string }[];
  if (cols.length === 0 || cols.some((c) => c.name === "order_side")) return;

  db.exec(`
    CREATE TABLE market_state_new (
      market_id TEXT NOT NULL,
      order_side TEXT NOT NULL DEFAULT 'UP',
      status TEXT NOT NULL,
      entry_order_id TEXT,
      entry_order_type TEXT,
      entry_price REAL,
      entry_shares REAL,
      stop_price REAL,
      stop_order_id TEXT,
      redeemed_tx_hash TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (market_id, order_side)
    );

    INSERT INTO market_state_new (
      market_id, order_side, status, entry_order_id, entry_order_type, entry_price,
      entry_shares, stop_price, stop_order_id, redeemed_tx_hash, updated_at_ms
    )
    SELECT
      market_id, 'UP', status, entry_order_id, entry_order_type, entry_price,
      entry_shares, stop_price, stop_order_id, redeemed_tx_hash, updated_at_ms
    FROM market_state;

    DROP TABLE market_state;
    ALTER TABLE market_state_new RENAME TO market_state;
  `);
}

export function openDb(dbPath: string): BotDb {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");

  const schema = loadSchemaSql();
  db.exec(schema);
  migrateMarketStateOrderSide(db);

  return {
    db,
    close: () => db.close(),
  };
}

/** Read-only handle for analytics API (does not run migrations). */
export function openReadonlyDb(dbPath: string): BotDb {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  return {
    db,
    close: () => db.close(),
  };
}
