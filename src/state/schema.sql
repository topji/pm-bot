PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS markets (
  market_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  question TEXT NOT NULL,
  end_date TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  neg_risk INTEGER NOT NULL,
  tick_size TEXT NOT NULL,
  up_token_id TEXT NOT NULL,
  down_token_id TEXT NOT NULL,
  discovered_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS market_state (
  market_id TEXT NOT NULL,
  order_side TEXT NOT NULL DEFAULT 'UP',
  status TEXT NOT NULL, -- discovered|entryPlaced|entered|stopped|redeemable|redeemed
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

CREATE TABLE IF NOT EXISTS open_orders (
  order_id TEXT PRIMARY KEY,
  market_id TEXT,
  asset_id TEXT,
  side TEXT NOT NULL,
  price TEXT,
  status TEXT,
  expiration TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  trade_key TEXT PRIMARY KEY,
  market_id TEXT,
  slug TEXT,
  action TEXT NOT NULL,
  side TEXT,
  token_id TEXT,
  price REAL,
  shares REAL,
  usd_amount REAL,
  order_id TEXT,
  tx_hash TEXT,
  status TEXT,
  making_amount TEXT,
  taking_amount TEXT,
  source TEXT NOT NULL,
  raw_json TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trades_market_id ON trades(market_id);
CREATE INDEX IF NOT EXISTS idx_trades_created_at_ms ON trades(created_at_ms);
CREATE INDEX IF NOT EXISTS idx_trades_order_id ON trades(order_id);

-- One analytics row per market window + outcome side (Tier 1 + 2 trade journal).
CREATE TABLE IF NOT EXISTS trade_rounds (
  market_id TEXT NOT NULL,
  order_side TEXT NOT NULL,
  slug TEXT NOT NULL,
  entry_placed_at_ms INTEGER,
  entry_filled_at_ms INTEGER,
  exit_at_ms INTEGER,
  entry_price REAL,
  exit_price REAL,
  shares REAL,
  entry_usd REAL,
  exit_usd REAL,
  filled INTEGER NOT NULL DEFAULT 0,
  stop_triggered INTEGER NOT NULL DEFAULT 0,
  exit_type TEXT,
  pnl_usd REAL,
  seconds_to_expiry_at_entry INTEGER,
  entry_order_id TEXT,
  exit_order_id TEXT,
  redeem_tx_hash TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (market_id, order_side)
);

CREATE INDEX IF NOT EXISTS idx_trade_rounds_slug ON trade_rounds(slug);
CREATE INDEX IF NOT EXISTS idx_trade_rounds_entry_placed_at ON trade_rounds(entry_placed_at_ms);
CREATE INDEX IF NOT EXISTS idx_trade_rounds_exit_at ON trade_rounds(exit_at_ms);

