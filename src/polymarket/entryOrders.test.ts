import { describe, expect, it, vi } from "vitest";
import type { ClobClient } from "@polymarket/clob-client-v2";

import { openDb } from "../state/db.js";
import { cancelEntryOrdersNearExpiry, hasEntryForMarket } from "./entryOrders.js";
import type { GammaMarket } from "./types.js";

function makeMarket(overrides?: Partial<GammaMarket>): GammaMarket {
  return {
    id: "m1",
    slug: "btc-updown-5m-test",
    question: "test",
    endDate: new Date(Date.now() + 20_000).toISOString(),
    active: true,
    closed: false,
    negRisk: false,
    tickSize: "0.01",
    conditionId: "0x" + "1".repeat(64),
    upTokenId: "up-token",
    downTokenId: "down-token",
    ...overrides,
  };
}

describe("entryOrders", () => {
  it("cancels open buy orders when expiry is under 30 seconds", async () => {
    const cancelOrder = vi.fn().mockResolvedValue({});
    const client = {
      getOpenOrders: vi.fn().mockResolvedValue([{ id: "ord-1", side: "BUY", price: "0.30" }]),
      cancelOrder,
    } as unknown as ClobClient;

    const { db } = openDb(":memory:");
    db.prepare(
      `
      INSERT INTO market_state (market_id, order_side, status, updated_at_ms)
      VALUES ('m1', 'UP', 'entryPlaced', 0)
    `,
    ).run();

    const market = makeMarket();
    const result = await cancelEntryOrdersNearExpiry({
      client,
      db,
      markets: [market],
      orderSide: "UP",
      nowMs: Date.now(),
    });

    expect(result.cancelled).toBe(1);
    expect(cancelOrder).toHaveBeenCalledWith({ orderID: "ord-1" });

    const row = db
      .prepare(`SELECT status FROM market_state WHERE market_id = 'm1' AND order_side = 'UP'`)
      .get() as { status: string };
    expect(row.status).toBe("entryCancelled");
    db.close();
  });

  it("hasEntryForMarket is true when a live CLOB buy exists", async () => {
    const client = {
      getOpenOrders: vi.fn().mockResolvedValue([{ id: "ord-1", side: "BUY", price: "0.30" }]),
    } as unknown as ClobClient;

    const { db } = openDb(":memory:");
    const has = await hasEntryForMarket({
      db,
      client,
      marketId: "m1",
      orderSide: "UP",
      tokenId: "up-token",
    });
    expect(has).toBe(true);
    db.close();
  });
});
