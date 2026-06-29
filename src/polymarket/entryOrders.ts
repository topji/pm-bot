import type { ClobClient } from "@polymarket/clob-client-v2";
import type Database from "better-sqlite3";

import type { GammaMarket, OrderSide } from "./types.js";
import { outcomeTokenId } from "./types.js";
import { secondsToExpiry } from "./orders.js";
import {
  markTradeRoundEntryCancelled,
} from "../state/tradeRounds.js";

import type { DataApiPosition } from "./types.js";

const ENTRY_MIN_SECONDS = 30;

export function isSellOpenOrder(side: string | undefined): boolean {
  return side?.toUpperCase() === "SELL";
}

export function isBuyOpenOrder(side: string | undefined): boolean {
  return side?.toUpperCase() === "BUY";
}

async function safeGetOpenOrders(
  client: ClobClient,
  params?: { asset_id: string },
): Promise<{ id: string; side: string; price: string; asset_id?: string }[]> {
  try {
    const orders = await client.getOpenOrders(params, true);
    if (Array.isArray(orders)) return orders;
  } catch {
    // CLOB client throws when response.data is missing or not an array (common with asset_id filter).
  }

  // Fallback: unfiltered list, then match asset locally.
  if (params?.asset_id) {
    try {
      const all = await client.getOpenOrders(undefined, true);
      if (Array.isArray(all)) {
        return all.filter((o) => o.asset_id === params.asset_id);
      }
    } catch {
      // ignore
    }
  }

  return [];
}

export async function fetchOpenBuyOrdersForAsset(
  client: ClobClient,
  assetId: string,
): Promise<{ id: string; side: string; price: string }[]> {
  const orders = await safeGetOpenOrders(client, { asset_id: assetId });
  return orders.filter((o) => isBuyOpenOrder(o.side));
}

/** At most one resting entry per market + side (DB state or live CLOB buy). */
export async function hasEntryForMarket(params: {
  db: Database.Database;
  client: ClobClient;
  marketId: string;
  orderSide: OrderSide;
  tokenId: string;
}): Promise<boolean> {
  const row = params.db
    .prepare(`SELECT 1 AS ok FROM market_state WHERE market_id = ? AND order_side = ? LIMIT 1`)
    .get(params.marketId, params.orderSide) as { ok: 1 } | undefined;
  if (row?.ok) return true;

  const openBuys = await fetchOpenBuyOrdersForAsset(params.client, params.tokenId);
  return openBuys.length > 0;
}

export type CancelNearExpiryResult = {
  cancelled: number;
  markets: string[];
};

/** Cancel resting entry limits when fewer than 30 seconds remain before market expiry. */
export async function cancelEntryOrdersNearExpiry(params: {
  client: ClobClient;
  db: Database.Database;
  markets: GammaMarket[];
  orderSide: OrderSide;
  nowMs: number;
  /** Live positions — skip bookkeeping cancel when shares are held (filled trade). */
  positions?: DataApiPosition[] | undefined;
}): Promise<CancelNearExpiryResult> {
  const marketsCancelled: string[] = [];
  let cancelled = 0;

  for (const market of params.markets) {
    if (secondsToExpiry(market.endDate, params.nowMs) >= ENTRY_MIN_SECONDS) continue;

    const tokenId = outcomeTokenId(market, params.orderSide);
    const heldShares =
      params.positions?.find((p) => p.asset === tokenId && (p.size ?? 0) > 0)?.size ?? 0;

    const openBuys = await fetchOpenBuyOrdersForAsset(params.client, tokenId);
    if (openBuys.length === 0) continue;

    for (const order of openBuys) {
      if (isSellOpenOrder(order.side)) continue;
      await params.client.cancelOrder({ orderID: order.id });
      cancelled += 1;
    }
    marketsCancelled.push(market.slug);

    // Never mark a filled round cancelled — that only applies to unfilled entry limits.
    if (heldShares > 0) continue;

    params.db
      .prepare(
        `
        UPDATE market_state
        SET status = 'entryCancelled', updated_at_ms = @updated_at_ms
        WHERE market_id = @market_id AND order_side = @order_side AND status = 'entryPlaced'
      `,
      )
      .run({
        market_id: market.id,
        order_side: params.orderSide,
        updated_at_ms: params.nowMs,
      });

    markTradeRoundEntryCancelled(params.db, {
      marketId: market.id,
      orderSide: params.orderSide,
      cancelledAtMs: params.nowMs,
    });
  }

  return { cancelled, markets: marketsCancelled };
}
