import type { ClobClient, OpenOrder } from "@polymarket/clob-client-v2";

import type { BotDb } from "./db.js";
import type { Endpoints } from "../polymarket/endpoints.js";
import { fetchPositionsForUser } from "../polymarket/dataApi.js";

export async function reconcileFromLive(params: {
  db: BotDb;
  endpoints: Endpoints;
  clob: ClobClient;
  depositWalletAddress: string;
  nowMs: number;
}): Promise<void> {
  const openOrders = await params.clob.getOpenOrders();

  const stmtUpsert = params.db.db.prepare(
    `
    INSERT INTO open_orders (order_id, market_id, asset_id, side, price, status, expiration, updated_at_ms)
    VALUES (@order_id, @market_id, @asset_id, @side, @price, @status, @expiration, @updated_at_ms)
    ON CONFLICT(order_id) DO UPDATE SET
      market_id=excluded.market_id,
      asset_id=excluded.asset_id,
      side=excluded.side,
      price=excluded.price,
      status=excluded.status,
      expiration=excluded.expiration,
      updated_at_ms=excluded.updated_at_ms
  `,
  );

  const tx = params.db.db.transaction((orders: OpenOrder[]) => {
    for (const o of orders) {
      stmtUpsert.run({
        order_id: o.id,
        market_id: o.market ?? null,
        asset_id: o.asset_id ?? null,
        side: o.side ?? "unknown",
        price: o.price ?? null,
        status: o.status ?? null,
        expiration: o.expiration ?? null,
        updated_at_ms: params.nowMs,
      });
    }
  });
  tx(openOrders);

  // Positions reconciliation: record presence; detailed state machine is built in bot loop.
  // Data API is eventually consistent; we will re-check in loop with backoff.
  const positions = await fetchPositionsForUser(params.endpoints, params.depositWalletAddress);
  const hasAny = positions.some((p) => (p.size ?? 0) > 0);

  params.db.db
    .prepare(
      `
      INSERT INTO checkpoints (key, value, updated_at_ms)
      VALUES ('last_reconcile_has_position', @value, @updated_at_ms)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at_ms=excluded.updated_at_ms
    `,
    )
    .run({ value: hasAny ? "1" : "0", updated_at_ms: params.nowMs });
}

