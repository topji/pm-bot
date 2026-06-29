# Polymarket BTC 5-minute Bot

Implements the execution rules in `bot-requirements.md`:

- Entry: **one** limit buy at **0.33** per market per side (`ORDER_SIDE`, override with `ENTRY_PRICE`); auto-cancelled if &lt;30s to expiry
- Stop: **0.15** Mode A — best bid polled every **1s** (`STOP_POLL_MS`, default `1000`)
- Otherwise hold to resolution and **redeem on-chain**
- Entry window gating: place entries only when **30s–290s** to expiry

## Requirements

- Node.js **20+**

## Setup

1. Install deps:

```bash
npm install
```

2. Create `.env`:

```bash
BOT_PRIVATE_KEY=0x...
DEPOSIT_WALLET_ADDRESS=0x...
USD_PER_TRADE=1
ENTRY_PRICE=0.33
ORDER_SIDE=UP
MAX_CONCURRENT_POSITIONS=2
MAX_TOTAL_USD_EXPOSURE=100
MAX_DAILY_LOSS_USD=100
SCAN_INTERVAL_MS=5000
RECONCILE_INTERVAL_MS=15000
STOP_POLL_MS=1000
DB_PATH=./data/bot.sqlite
POLYGON_RPC_URL=https://polygon-rpc.com
KILL_SWITCH=false
```

| Variable | Description |
|----------|-------------|
| `USD_PER_TRADE` | USD collateral per entry order (default `1`). `USD_BUDGET_PER_MARKET` is accepted as a legacy alias. |
| `ENTRY_PRICE` | Limit buy price (default `0.33`). Must be valid for market tick size. |
| `ORDER_SIDE` | `UP` or `DOWN` — which outcome token to buy (default `UP`). |
| `STOP_POLL_MS` | Stop-loss price check interval in ms (default `1000` = 1 second). |

### Running UP and DOWN in parallel

Use **two processes** with different `ORDER_SIDE` values. Use a **separate `DB_PATH` per instance** so each side tracks its own `market_state`:

```bash
# Terminal 1 — UP
ORDER_SIDE=UP DB_PATH=./data/bot-up.sqlite npm run dev

# Terminal 2 — DOWN
ORDER_SIDE=DOWN DB_PATH=./data/bot-down.sqlite npm run dev
```

Both instances can share the same wallet and CLOB creds; each only manages positions for its configured side.

## Run

```bash
npm run dev
```

## CLI (safe helpers)

```bash
npm run cli -- scan
npm run cli -- derive-deposit-wallet
npm run cli -- redeem-calldata 0x0000000000000000000000000000000000000000000000000000000000000001
npm run cli -- stop-test <tokenId> <shares> <tickSize> <negRisk:true|false>
```

## Trade history

**`trade_rounds`** — one row per market + side (Tier 1 & 2 analytics): entry/exit times, fill status, prices, shares, PnL, stop flag, seconds-to-expiry at entry.

**`trades`** — raw event log (entries, stops, redeems, Data API fills).

Query trade rounds:

```bash
sqlite3 ./data/bot.sqlite "SELECT entry_placed_at_ms, slug, order_side, filled, entry_price, exit_price, shares, entry_usd, exit_usd, stop_triggered, exit_type, pnl_usd, seconds_to_expiry_at_entry FROM trade_rounds ORDER BY entry_placed_at_ms DESC LIMIT 20;"
```

Query raw events:

```bash
sqlite3 ./data/bot.sqlite "SELECT created_at_ms, action, side, price, shares, usd_amount, order_id, tx_hash FROM trades ORDER BY created_at_ms DESC LIMIT 20;"
```

## Analytics API

Read-only HTTP API for dashboards. Runs as a **separate process** from the trading bot and reads the same SQLite file (`DB_PATH`).

```bash
npm run analytics          # dev (tsx)
npm run build && npm run analytics:start   # production
```

Environment (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `./data/bot.sqlite` | Same DB the bot writes |
| `ANALYTICS_HOST` | `127.0.0.1` | Bind address |
| `ANALYTICS_PORT` | `8787` | Listen port |
| `ANALYTICS_API_KEY` | — | Optional Bearer token |
| `ANALYTICS_CORS_ORIGIN` | `*` | CORS header for browser dashboards |

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness + DB path |
| GET | `/api/v1/summary` | Aggregate stats (fill rate, PnL, win rate, stop rate) |
| GET | `/api/v1/summary/daily?days=30` | Daily PnL rollup |
| GET | `/api/v1/rounds?limit=50&offset=0` | Paginated trade rounds |
| GET | `/api/v1/rounds/:marketId/:orderSide` | Single round |
| GET | `/api/v1/events` | Raw trade events |

Query params for filtering: `order_side=UP|DOWN`, `filled=true|false`, `exit_type=stop|redeem|cancelled`.

Example:

```bash
curl -s http://127.0.0.1:8787/api/v1/summary | jq
curl -s "http://127.0.0.1:8787/api/v1/rounds?order_side=UP&limit=10" | jq
```

With API key:

```bash
curl -s -H "Authorization: Bearer $ANALYTICS_API_KEY" http://127.0.0.1:8787/api/v1/summary
```

For two bot instances (UP/DOWN), point each analytics server at the matching DB (`bot-up.sqlite` / `bot-down.sqlite`) or run one API and query with `order_side`.

## Notes

- This repo is **headless**: it talks to Polymarket upstream services directly (no Vite proxy).
- Relayer / builder-sign and redeem are implemented as part of the bot in later modules.

## Operations (production)

### Kill switch

Set `KILL_SWITCH=true` to:

- Cancel all open orders
- Skip placing new entries

### Long-running service (systemd example)

Create `/etc/systemd/system/pm-bot.service`:

```ini
[Unit]
Description=Polymarket BTC 5m bot
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/pm-bot
ExecStart=/usr/bin/node /opt/pm-bot/dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/pm-bot/.env

[Install]
WantedBy=multi-user.target
```

Deploy:

```bash
npm ci
npm run build
sudo systemctl daemon-reload
sudo systemctl enable --now pm-bot
sudo journalctl -u pm-bot -f
```

