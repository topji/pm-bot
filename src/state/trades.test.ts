import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

import { countTrades, recordTrade } from "./trades.js";

function openTestDb(): Database.Database {
  const db = new Database(":memory:");
  const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  db.exec(schema);
  return db;
}

describe("recordTrade", () => {
  it("inserts once and ignores duplicate trade_key", () => {
    const db = openTestDb();
    const trade = {
      tradeKey: "bot:order:0xabc",
      marketId: "m1",
      slug: "btc-5m",
      action: "entry" as const,
      side: "buy" as const,
      tokenId: "123",
      price: 0.3,
      shares: 10,
      usdAmount: 3,
      orderId: "0xabc",
      status: "matched",
      source: "bot" as const,
      createdAtMs: Date.now(),
    };

    expect(recordTrade(db, trade)).toBe(true);
    expect(recordTrade(db, trade)).toBe(false);
    expect(countTrades(db)).toBe(1);
    db.close();
  });
});
