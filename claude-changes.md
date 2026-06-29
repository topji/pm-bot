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
