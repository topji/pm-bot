import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

import {
  closeTradeRoundAtResolution,
  closeTradeRoundWithRedeem,
  closeTradeRoundWithStop,
  closeTradeRoundWithTakeProfit,
  getTradeRound,
  markEntryFilled,
  markTradeRoundEntryCancelled,
  openTradeRound,
  parseImmediateEntryFill,
} from "./tradeRounds.js";

function openTestDb(): Database.Database {
  const db = new Database(":memory:");
  const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  db.exec(schema);
  return db;
}

describe("tradeRounds", () => {
  it("records a full stop-loss round with pnl", () => {
    const db = openTestDb();
    const now = Date.now();

    openTradeRound(db, {
      marketId: "m1",
      orderSide: "UP",
      slug: "btc-updown-5m-test",
      entryPlacedAtMs: now,
      secondsToExpiryAtEntry: 120,
      entryOrderId: "ord-entry",
      intendedEntryPrice: 0.3,
      intendedEntryUsd: 1,
    });

    markEntryFilled(db, {
      marketId: "m1",
      orderSide: "UP",
      entryFilledAtMs: now + 1000,
      entryPrice: 0.3,
      shares: 3.33,
      entryUsd: 1,
    });

    closeTradeRoundWithStop(db, {
      marketId: "m1",
      orderSide: "UP",
      exitAtMs: now + 5000,
      exitPrice: 0.15,
      exitUsd: 0.5,
      shares: 3.33,
      exitOrderId: "ord-exit",
    });

    const row = getTradeRound(db, "m1", "UP");
    expect(row?.filled).toBe(1);
    expect(row?.stop_triggered).toBe(1);
    expect(row?.exit_type).toBe("stop");
    expect(row?.seconds_to_expiry_at_entry).toBe(120);
    expect(row?.entry_price).toBe(0.3);
    expect(row?.exit_price).toBe(0.15);
    expect(row?.shares).toBe(3.33);
    expect(row?.pnl_usd).toBeCloseTo(-0.5, 5);
    db.close();
  });

  it("marks cancelled entries as unfilled with zero pnl", () => {
    const db = openTestDb();
    const now = Date.now();

    openTradeRound(db, {
      marketId: "m1",
      orderSide: "DOWN",
      slug: "btc-updown-5m-test",
      entryPlacedAtMs: now,
      secondsToExpiryAtEntry: 25,
      entryOrderId: "ord-entry",
      intendedEntryPrice: 0.3,
      intendedEntryUsd: 1,
    });

    markTradeRoundEntryCancelled(db, {
      marketId: "m1",
      orderSide: "DOWN",
      cancelledAtMs: now + 2000,
    });

    const row = getTradeRound(db, "m1", "DOWN");
    expect(row?.filled).toBe(0);
    expect(row?.exit_type).toBe("cancelled");
    expect(row?.pnl_usd).toBe(0);
    db.close();
  });

  it("parses immediate entry fills from order response", () => {
    const parsed = parseImmediateEntryFill({
      status: "matched",
      price: 0.3,
      shares: 3.33,
      makingAmount: "1",
      takingAmount: "3.33",
    });
    expect(parsed?.filled).toBe(true);
    expect(parsed?.shares).toBe(3.33);
    expect(parsed?.entryUsd).toBe(1);
    expect(parsed?.entryPrice).toBeCloseTo(0.3003, 4);
  });

  it("records redeem exit at $1 per share", () => {
    const db = openTestDb();
    const now = Date.now();

    openTradeRound(db, {
      marketId: "m1",
      orderSide: "UP",
      slug: "btc-updown-5m-test",
      entryPlacedAtMs: now,
      secondsToExpiryAtEntry: 180,
      entryOrderId: "ord-entry",
      intendedEntryPrice: 0.3,
      intendedEntryUsd: 1,
    });

    markEntryFilled(db, {
      marketId: "m1",
      orderSide: "UP",
      entryFilledAtMs: now + 500,
      entryPrice: 0.3,
      shares: 3.33,
      entryUsd: 1,
    });

    closeTradeRoundWithRedeem(db, {
      marketId: "m1",
      orderSide: "UP",
      exitAtMs: now + 300_000,
      shares: 3.33,
      redeemTxHash: "0xabc",
    });

    const row = getTradeRound(db, "m1", "UP");
    expect(row?.exit_type).toBe("redeem");
    expect(row?.stop_triggered).toBe(0);
    expect(row?.exit_usd).toBe(3.33);
    expect(row?.pnl_usd).toBeCloseTo(2.33, 5);
    db.close();
  });

  it("records a take-profit round: profit, exit_type, stop_triggered = 0", () => {
    const db = openTestDb();
    const now = Date.now();

    openTradeRound(db, {
      marketId: "m1",
      orderSide: "UP",
      slug: "btc-updown-5m-test",
      entryPlacedAtMs: now,
      secondsToExpiryAtEntry: 200,
      entryOrderId: "ord-entry",
      intendedEntryPrice: 0.33,
      intendedEntryUsd: 2,
    });
    markEntryFilled(db, {
      marketId: "m1",
      orderSide: "UP",
      entryFilledAtMs: now + 500,
      entryPrice: 0.33,
      shares: 6,
      entryUsd: 1.98,
    });

    // Sold 6 shares at ~0.99 => 5.94 USDC.
    closeTradeRoundWithTakeProfit(db, {
      marketId: "m1",
      orderSide: "UP",
      exitAtMs: now + 120_000,
      exitPrice: 0.99,
      exitUsd: 5.94,
      shares: 6,
      exitOrderId: "tp-1",
    });

    const row = getTradeRound(db, "m1", "UP");
    expect(row?.exit_type).toBe("take_profit");
    expect(row?.stop_triggered).toBe(0);
    expect(row?.exit_price).toBe(0.99);
    expect(row?.exit_usd).toBe(5.94);
    expect(row?.exit_order_id).toBe("tp-1");
    expect(row?.pnl_usd).toBeCloseTo(3.96, 5);
    db.close();
  });

  it("closeTradeRoundAtResolution settles a win at $1/share without a tx", () => {
    const db = openTestDb();
    const now = Date.now();

    openTradeRound(db, {
      marketId: "m1",
      orderSide: "UP",
      slug: "btc-updown-5m-test",
      entryPlacedAtMs: now,
      secondsToExpiryAtEntry: 180,
      entryOrderId: "ord-entry",
      intendedEntryPrice: 0.33,
      intendedEntryUsd: 1,
    });
    markEntryFilled(db, {
      marketId: "m1",
      orderSide: "UP",
      entryFilledAtMs: now + 500,
      entryPrice: 0.33,
      shares: 3,
      entryUsd: 0.99,
    });

    closeTradeRoundAtResolution(db, {
      marketId: "m1",
      orderSide: "UP",
      exitAtMs: now + 300_000,
      shares: 3,
      won: true,
    });

    const row = getTradeRound(db, "m1", "UP");
    expect(row?.exit_type).toBe("redeem");
    expect(row?.redeem_tx_hash).toBeNull(); // gas-free: no tx recorded
    expect(row?.exit_price).toBe(1);
    expect(row?.exit_usd).toBe(3);
    expect(row?.pnl_usd).toBeCloseTo(2.01, 5);
    db.close();
  });

  it("closeTradeRoundAtResolution settles a loss at $0 and is idempotent", () => {
    const db = openTestDb();
    const now = Date.now();

    openTradeRound(db, {
      marketId: "m1",
      orderSide: "UP",
      slug: "btc-updown-5m-test",
      entryPlacedAtMs: now,
      secondsToExpiryAtEntry: 180,
      entryOrderId: "ord-entry",
      intendedEntryPrice: 0.33,
      intendedEntryUsd: 1,
    });
    markEntryFilled(db, {
      marketId: "m1",
      orderSide: "UP",
      entryFilledAtMs: now + 500,
      entryPrice: 0.33,
      shares: 3,
      entryUsd: 0.99,
    });

    closeTradeRoundAtResolution(db, {
      marketId: "m1",
      orderSide: "UP",
      exitAtMs: now + 300_000,
      shares: 3,
      won: false,
    });
    // Second call must NOT overwrite the already-closed round (idempotent).
    closeTradeRoundAtResolution(db, {
      marketId: "m1",
      orderSide: "UP",
      exitAtMs: now + 600_000,
      shares: 3,
      won: true,
    });

    const row = getTradeRound(db, "m1", "UP");
    expect(row?.exit_type).toBe("redeem");
    expect(row?.exit_price).toBe(0);
    expect(row?.exit_usd).toBe(0);
    expect(row?.exit_at_ms).toBe(now + 300_000); // unchanged by the 2nd call
    expect(row?.pnl_usd).toBeCloseTo(-0.99, 5);
    db.close();
  });
});
