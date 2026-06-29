import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

import {
  getAnalyticsSummary,
  getDailyPnl,
  listTradeRounds,
} from "./queries.js";
import {
  closeTradeRoundWithStop,
  markEntryFilled,
  openTradeRound,
} from "../state/tradeRounds.js";

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("../state/schema.sql", import.meta.url), "utf8"));

  const now = Date.UTC(2026, 5, 29, 12, 0, 0);
  openTradeRound(db, {
    marketId: "m1",
    orderSide: "UP",
    slug: "btc-updown-5m-a",
    entryPlacedAtMs: now,
    secondsToExpiryAtEntry: 120,
    entryOrderId: "e1",
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
    exitAtMs: now + 60_000,
    exitPrice: 0.15,
    exitUsd: 0.5,
    shares: 3.33,
    exitOrderId: "x1",
  });

  openTradeRound(db, {
    marketId: "m2",
    orderSide: "DOWN",
    slug: "btc-updown-5m-b",
    entryPlacedAtMs: now + 86_400_000,
    secondsToExpiryAtEntry: 200,
    entryOrderId: "e2",
    intendedEntryPrice: 0.3,
    intendedEntryUsd: 1,
  });

  return db;
}

describe("analytics queries", () => {
  it("summarizes rounds with pnl and rates", () => {
    const db = seedDb();
    const summary = getAnalyticsSummary(db);
    expect(summary.totalRounds).toBe(2);
    expect(summary.filledRounds).toBe(1);
    expect(summary.stoppedRounds).toBe(1);
    expect(summary.totalPnlUsd).toBeCloseTo(-0.5, 5);
    expect(summary.winCount).toBe(0);
    expect(summary.lossCount).toBe(1);
    db.close();
  });

  it("filters rounds by order side", () => {
    const db = seedDb();
    const rows = listTradeRounds(db, { orderSide: "DOWN", limit: 10, offset: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.order_side).toBe("DOWN");
    db.close();
  });

  it("groups daily pnl", () => {
    const db = seedDb();
    const daily = getDailyPnl(db, { days: 30 });
    expect(daily.length).toBeGreaterThanOrEqual(1);
    expect(daily[0]?.rounds).toBeGreaterThanOrEqual(1);
    db.close();
  });
});
