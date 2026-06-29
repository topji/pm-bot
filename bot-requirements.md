# Bot Requirements — BTC 5-minute “UP @ 0.30, stop @ 0.15, redeem @ 1.00”

## 1. Objective

Build a fully automated Polymarket trading bot that, for every eligible BTC 5‑minute **Up/Down** market:

- **Enters**: buys **UP** at exactly **$0.30**
- **Risk control**: triggers a **stop-loss at $0.15** using **Mode A** (immediate exit using FAK sell)
- **Profit target**: otherwise **holds to resolution** and realizes profit by **redeeming** at **$1.00** (on-chain)

This is an infrastructure + execution bot (not discretionary strategy).

---

## 2. Core trading rules

### 2.1 Market scope

- The bot trades **BTC 5-minute** markets only (Up/Down style).
- Market discovery must be implemented using **Gamma API** (see `trading-info.md` §19 + §2.8 gap #3).

### 2.2 Entry price (exact)

- Entry is a **limit BUY** for the UP token at **price = 0.30**.
- Entry price must respect market tick size (`orderPriceMinTickSize`).
  - If the market tick size does not support `0.30` exactly, the bot must **skip** that market.

### 2.3 Entry time window (expiry gating)

The bot must only place the entry order when the market time-to-expiry is inside:

- **max 290 seconds to expiry** (not earlier than 290s)
- **min 30 seconds to expiry** (not later than 30s)

In other words, at order placement time:

\[
30 \le (endTime - now) \le 290
\]

If outside the window, the bot must not place new entries for that market.

### 2.4 Stop-loss: Mode A (immediate exit)

Polymarket does not support native stop orders. The bot must implement stop-loss via monitoring.

- **Stop trigger level**: **$0.15**
- **Trigger condition (default)**: when the monitored reference price for the UP token indicates the market has reached/breached the stop (see §5.4 for the precise feed).
- **Mode A action**: place an immediate **FAK market sell** for the full UP position size (shares) to exit as quickly as possible.

Notes:

- Mode A prioritizes getting out quickly. The actual fill may be below $0.15 in fast moves (this is expected behavior).
- If the exit order returns success but does not fill, bot must treat this as an error and retry (with a bounded retry policy).

### 2.5 Profit realization at resolution (redeem)

If stop-loss does not trigger:

- The bot **holds until resolution**.
- When Data API reports the position as `redeemable: true`, the bot must perform an on-chain **redeem** (not implemented in the app repo today).
- Redeem must convert winning outcome shares into collateral (pUSD), capturing the “100 cents” payout.

---

## 3. Wallet and funding model (hard requirement)

The bot must follow the repo’s Polymarket wallet model:

### 3.1 Three-layer identity

- **EOA**: Polygon account controlled by the bot (private key). Used for:
  - CLOB L1 API key derivation (EIP-712 signature)
  - EIP-712 signatures for relayer operations
- **Safe**: derived Polymarket Gnosis Safe address. Used for:
  - bridge deposits
  - wrap/unwrap pUSD
  - withdrawals
- **Deposit wallet**: derived deposit wallet address. Used for:
  - all CLOB trading (collateral and outcome tokens live here)

### 3.2 Signature mode

All CLOB orders must be placed using:

- funder = **deposit wallet**
- signature type = **`POLY_1271`**

Trading from the Safe directly will fail (“Maker address not allowed”).

### 3.3 Funding / approvals workflow

Before any market entries:

- Ensure Safe has funds (bridge → wrap to pUSD if needed)
- Ensure deposit wallet is deployed and approved (repo has this flow)
- Ensure deposit wallet has enough pUSD collateral for:
  - `usdBudgetPerMarket` + fees buffer

See `trading-info.md` §2 and §9.

---

## 4. External dependencies & infrastructure

### 4.1 APIs used

- **Gamma API**: discover BTC 5-minute markets and read metadata (tickSize, outcomes, end time, negRisk)
- **CLOB API**: place/cancel orders, read orderbook
- **Data API**: positions and portfolio value, plus `redeemable`
- **Relayer v2**: gasless Safe/deposit-wallet deployment and batch operations

### 4.2 Builder-sign (server-side HMAC)

Relayer operations require builder-signed headers produced from secret credentials. The bot must have access to a **server-side builder-sign service** (same model as `apps/api`):

- `POLY_BUILDER_API_KEY`
- `POLY_BUILDER_SECRET`
- `POLY_BUILDER_PASSPHRASE`
- optional `POLY_BUILDER_SIGN_TOKEN`

The bot must never embed these credentials in a distributed client bundle.

---

## 5. Functional requirements

### 5.1 Market discovery

The bot must:

- continuously scan for eligible BTC 5-minute markets
- correctly map **UP** outcome → correct `tokenId`
  - must match by name (`Up/Down` vs `Yes/No`) and verify mapping
- track per-market:
  - `endDate` (or equivalent end time)
  - `tickSize`
  - `negRisk`
  - liquidity/volume (optional filters)

### 5.2 Order placement (entry)

When inside the entry window:

- compute desired shares:
  - `shares = usdBudgetPerMarket / 0.30`
- place **limit buy**:
  - `OrderType`: **GTD** recommended for 5m markets (auto-expire)
  - `expiration`: must satisfy Polymarket requirement \( \ge now + 60s \)
  - `postOnly`: configurable; default **false**

### 5.3 Entry fill detection

After placing an entry order, bot must determine whether it has entered:

- Primary: use CLOB order status (matched/filled)
- Secondary: detect position appearing in Data API (`asset == upTokenId` and `size > 0`)
- Bot must handle Data API lag with retries/backoff.

### 5.4 Stop monitoring (price feed + trigger)

The bot must monitor the UP token price frequently enough to enforce the stop:

- Preferred: CLOB WebSocket book/trade stream
- Fallback: polling `GET /book?token_id=` (or equivalent) at `pollMs`

The bot must define and consistently use a reference price for stop checks (default):

- **best bid price** for the UP token from the order book

Trigger rule (default):

- if `bestBid > 0` and `bestBid <= 0.15` → trigger stop-loss

### 5.5 Stop execution (Mode A)

On trigger:

- cancel any resting sell orders (if any exist in the future)
- place **FAK SELL** for full share size
- confirm exit by:
  - order fill, then
  - Data API position size returns to 0

### 5.6 Resolution & redeem

If stop never triggers:

- bot waits until Data API marks position `redeemable: true`
- bot executes **on-chain redeem** for the resolved condition
- bot verifies collateral increased and position is cleared

---

## 6. State model and idempotency

The bot must persist enough state to restart safely without duplicating exposure:

- known markets and their `endTime`
- per market: entryAttempted, entryOrderId(s), entered (shares), stopTriggered, redeemed
- mapping: upTokenId, downTokenId, conditionId (if needed for redeem)
- last successful scans/checkpoints

On restart:

- reload state
- reconcile with live CLOB open orders and Data API positions
- continue from correct state

---

## 7. Risk controls (must-have)

Configurable safeguards:

- `usdBudgetPerMarket`
- `maxConcurrentPositions`
- `maxTotalUsdExposure`
- `maxDailyLossUsd` (halt new entries if exceeded)
- global kill switch:
  - cancel open orders
  - disable new entries
  - keep stop monitoring for already-entered positions unless explicitly disabled

---

## 8. Observability and operations

### 8.1 Logging

Structured logs (JSON) with:

- market identifiers (slug/id), endTime
- order actions: placed/cancelled/filled
- entry window evaluations
- stop triggers and exit results
- redeem attempts/results
- errors with retry counts

### 8.2 Metrics / alerts (minimum)

- count of markets scanned / eligible / entered / stopped / redeemed
- failures:
  - relayer failures
  - CLOB auth failures
  - stop exits that fail to fill
  - redeem failures

---

## 9. Acceptance criteria

The bot is accepted when it can run unattended and:

- correctly discovers BTC 5-minute markets and maps UP token correctly
- places entry limit orders only within the **[290s, 30s]** time window
- enters only at **0.30** (tick-valid), and never buys outside rule
- triggers stop on **0.15** and executes **Mode A** exit reliably
- holds to resolution when not stopped and successfully redeems when `redeemable: true`
- survives restarts without duplicate entries/exposure

---

## 10. Open implementation items (explicit)

This repo’s app does not currently implement the following, which the bot must add:

- **GTC/GTD limit entry wrappers + cancellations** (SDK supports; repo currently FAK only)
- **Stop-loss monitor loop** (WS/poll) that triggers Mode A exits
- **On-chain redeem logic** (redeemPositions / correct redemption path)
- **BTC market discovery** (Gamma filter + outcome mapping validation)

