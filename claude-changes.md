# Claude Changes

## 2026-06-30 — Fix: stop-loss firing instantly on every position

### Symptom
Every trade was being closed within ~11–15 seconds of entry, at wildly varying
prices (15¢, 25¢, 33¢, even 50¢), instead of holding to resolution or stopping
only at 15¢. The "let winners run to $1" path was never reached.

### Root cause
`bestBidPrice()` in [src/polymarket/orderbook.ts](src/polymarket/orderbook.ts)
read `book.bids[0]`. Polymarket's `/book` endpoint returns bids sorted
**ascending**, so `bids[0]` is the **lowest** (worst) bid in the book — usually
a lowball well under 15¢. The real best bid is the **last** element.

As a result, the stop-loss check (`bestBid <= 0.15` in
[src/polymarket/stopMonitor.ts](src/polymarket/stopMonitor.ts)) evaluated `true`
on essentially every poll, ~1 second after a position appeared. It then fired a
FAK sell priced near the tick floor, which behaved as a market sell that swept
down to the real top of book — explaining the varied 15¢–50¢ fills seen in the
trade history while the bot internally recorded the exit near 13¢.

Confirmed empirically against a live Polymarket book:
`raw bids: [0.18, 0.19, 0.22] ... [0.41, 0.42, 0.43]` — `bids[0]=0.18`,
real best bid `=0.43`.

### Changes

1. **`src/polymarket/orderbook.ts`**
   - `bestBidPrice()` now returns the **max** bid across all levels (robust to
     ordering) instead of `bids[0]`. Filters out non-finite / non-positive
     levels; returns `0` for an empty book.
   - Added `bestAskPrice()` returning the **min** ask, for symmetry/future use.

2. **`src/polymarket/stopMonitor.ts`**
   - Stop exits now report the **realized** fill price
     (`takingAmount / makingAmount` = USDC received ÷ shares sold) as
     `exitPrice`, instead of the protective limit-price cap. Trade history /
     P&L now reflect the price actually obtained. Falls back to the limit price
     if the amounts are missing.

3. **`src/polymarket/orderbook.test.ts`** (new)
   - Asserts `bestBidPrice` returns the highest bid for an ascending book, that
     a 0.02 lowball does not mask a real 0.33 best bid, and `0` for empty books.
   - Mirror assertions for `bestAskPrice`.

4. **`src/polymarket/stopMonitor.test.ts`**
   - New test: stop does **not** trigger when the real best bid (0.33) is
     healthy despite a 0.02 lowball present, and no sell order is posted.
   - New test: when the stop legitimately triggers (best bid 0.14), `exitPrice`
     reflects the realized fill (0.14), not the limit cap.

### Behavior after fix
The stop-loss now triggers only when the **best bid** (the price you can
actually sell into) is `<= 15¢`, which is exactly the intended design. Positions
are no longer dumped on entry and can ride to resolution unless price genuinely
falls to the stop.

### Verification
- `npm test` — 32/32 pass (including the new regression tests).
- `npm run typecheck` — clean.
- Live read-only book fetch: `bestBidPrice()` returns `0.43` (real best bid) vs.
  the old `0.18`; `bestAskPrice()` returns `0.48` (real best ask).

### Notes / not changed
- No live trades were placed during verification.
- Pre-existing uncommitted changes in `entryOrders.ts` / `entryOrders.test.ts`
  (open-orders fetch hardening) are unrelated to this fix and were left as-is.

---

## 2026-06-30 — Remove in-bot on-chain redeem; replace with gas-free resolution bookkeeping

### Why
Polymarket auto-redeems winning positions on the account, so the bot's own
on-chain redeem loop was redundant. Worse, it had no idempotency guard: it fired
`redeemResolvedPosition` for every `redeemable` position on every scan tick
(1s), so during the Data API's post-resolution reindex lag it could submit the
**same redeem transaction repeatedly** — wasted gas and likely reverts. (This
was "Issue A" from the pre-deploy review.)

### Changes

1. **`src/bot.ts`**
   - Removed the on-chain redeem loop entirely: no more `redeemResolvedPosition`
     calls, no redeem transactions, no `redeemed_tx_hash` writes from the bot.
   - Replaced it with a **gas-free resolution-bookkeeping** pass: for each
     `redeemable` position on our `ORDER_SIDE`, it closes the local trade round
     for P&L only. Win/loss is read from the resolved `curPrice` (`>= 0.5` → win
     settles at $1/share; else loss at $0). Idempotent across ticks — the round
     close (guarded by `exit_at_ms IS NULL`), the `market_state` upsert, and the
     `trades` row (keyed `bot:resolve:<marketId>:<side>`) all no-op once applied.
   - Removed the now-unused `findMarketByConditionId` helper, the `wallets`
     param from `botTick`, and the `redeemResolvedPosition` /
     `closeTradeRoundWithRedeem` imports.

2. **`src/state/tradeRounds.ts`**
   - Added `closeTradeRoundAtResolution({ marketId, orderSide, exitAtMs, shares,
     won })`: sets `exit_type='redeem'`, `exit_price` 1.0 (win) / 0.0 (loss),
     `exit_usd` = shares (win) / 0 (loss), computes `pnl_usd`, and only updates
     while `exit_at_ms IS NULL` (idempotency). No tx hash.
   - `closeTradeRoundWithRedeem` is retained (still covered by tests) but no
     longer called by the bot.

3. **`src/polymarket/redeem.ts`** — left intact. The CLI (`src/cli.ts`) still
   uses `buildCtfRedeemCalldata` for manual redemption, so the module stays as a
   manual escape hatch; the bot just never calls it automatically anymore.

4. **`src/state/tradeRounds.test.ts`** — new tests: win settles at $1/share with
   `redeem_tx_hash` null (gas-free), loss settles at $0, and a second resolution
   call does not overwrite an already-closed round (idempotent).

### Accounting note
Analytics derive win/loss from the sign of `pnl_usd`, not from `exit_type`, so a
$0 loss recorded with `exit_type='redeem'` is still counted as a loss. Most
losing rounds are closed earlier by the stop-loss path; this pass primarily
records wins and any un-stopped resolutions.

### Verification
- `npm test` — 34/34 pass (incl. 3 new trade-round tests).
- `npm run typecheck` and `npm run lint` — clean.

---

## 2026-06-30 — Stop polling the order book for resolved markets (404 spam)

### Symptom
The DOWN bot logged `CLOB book failed: 404 Not Found` every ~500ms from the
stop-loss supervisor (`fetchOrderBook` → `runStopLossModeAOnce` →
`handleStopForPosition`). It held a position in a 5-minute market that had
already expired/resolved but wasn't yet cleared off the wallet (pending
auto-redeem). Polymarket's `/book` 404s once a market resolves, so the supervisor
kept trying to stop-loss a position that no longer trades — harmless (the error
was caught) but noisy, and a pointless sell attempt + API call every poll.

### Root cause
The stop-loss supervisor ran a stop check for every held position regardless of
whether its market was still live, and `fetchOrderBook` threw on any non-OK
response — including the expected 404 for a resolved market.

### Changes

1. **`src/polymarket/stopLossSupervisor.ts`**
   - `findMarketByTokenId` now also selects `end_date`.
   - `handleStopForPosition` skips the stop check when `nowMs >= end_date`
     (market at/past expiry → holds to resolution + auto-redeem; nothing to
     stop). This removes the root cause — no book fetch for dead markets.

2. **`src/polymarket/orderbook.ts`**
   - `fetchOrderBook` treats HTTP **404** as an empty book (`{ bids: [], asks: [] }`)
     instead of throwing. `bestBidPrice` then returns 0 and the stop monitor
     reports `not_triggered`. Other HTTP errors (5xx/timeouts) still throw so
     real problems stay visible. Defensive backstop for the race where a market
     resolves mid-poll.

3. **`src/polymarket/orderbook.test.ts`** — new tests: 404 yields an empty book
   (best bid 0), and a 500 still throws.

### Strategy alignment
This matches the intended design: stop-loss is active only while the market is
live; at expiry the position holds to resolution (now auto-redeemed by
Polymarket). No behavioral change to live-market stops.

### Verification
- `npm test` — 36/36 pass (incl. 2 new order-book tests).
- `npm run typecheck` and `npm run lint` — clean.

### Ops note (UP bot, separate issue)
The UP bot's `order_failed_401` was a stale `data/clob-creds.json` that didn't
match the instance's `BOT_PRIVATE_KEY`. Resolved by deleting the file so creds
re-derive on startup. Not a code change. (See `loadOrCreateClobCreds` — it still
trusts any cached creds file without verifying it matches the signer; worth
hardening later so this can't recur silently.)

---

## 2026-06-30 — Don't let resolved (redeemable) positions block new entries

### Symptom
The DOWN bot stopped placing orders for ~1 hour, logging
`maxConcurrentPositions reached; skipping entries` with `openPosCount: 1` every
tick. It held a **losing** position (1:45–1:50 AM market) that resolved to $0 and
showed as **Redeemable** in the wallet with size 6.1.

### Root cause
Auto-redeem only redeems *winning* positions — a worthless ($0) loser has nothing
to pay out, so Polymarket never auto-redeems it and it lingers in the Data API
`/positions` response with `size > 0` indefinitely. The concurrency-cap count in
`botTick` counted **any** position with `size > 0`, including resolved/redeemable
ones. With `MAX_CONCURRENT_POSITIONS=1` on the DOWN instance, that single dead
loser permanently filled the only slot and blocked all new entries. (Higher caps
just delay the same wedge as losers accumulate.)

### Changes

1. **`src/bot.ts`**
   - Added `isActiveOpenPosition(pos)` — true only when shares are held AND the
     position is not yet `redeemable` (i.e. the market hasn't resolved).
   - The `openPosCount` concurrency-cap filter now uses it, so settled positions
     (auto-redeemed winners and un-redeemed worthless losers alike) no longer
     consume a slot.

2. **`src/bot.test.ts`** (new) — covers the helper: live position counts,
   redeemable win/loss excluded, zero-size excluded.

### Behavior after fix
The cap now reflects only live, at-risk positions, so a resolved loser left in
the wallet can never wedge the bot. (Those worthless tokens stay in the wallet
harmlessly; redeeming them would cost gas for a $0 return, so we leave them.)

### Note
The UP bot's `invalid_endDate` skip lines are benign — that reason is also
returned for an already-expired market (negative seconds to expiry), not only an
unparseable date. The bot correctly skips and moves on; the label is just
misleading.

### Verification
- `npm test` — 39/39 pass (incl. 3 new bot tests).
- `npm run typecheck` and `npm run lint` — clean.
