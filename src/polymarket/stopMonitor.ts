import { OrderType, Side, type ClobClient, type OrderResponse } from "@polymarket/clob-client-v2";

import type { Endpoints } from "./endpoints.js";
import { bestBidPrice, fetchOrderBook } from "./orderbook.js";
import type { TickSize } from "./types.js";

export type ExitCheckConfig = {
  endpoints: Endpoints;
  client: ClobClient;
  tokenId: string;
  shares: number;
  tickSize: TickSize;
  negRisk: boolean;
  stopPrice: number; // sell when best bid <= this (e.g. 0.15)
  takeProfitPrice: number; // sell when best bid >= this (e.g. 0.98)
  pollMs: number;
  maxExitRetries: number;
};

export type ExitTrigger = "stop" | "take_profit";

export type ExitOutcome =
  | {
      status: "exited";
      trigger: ExitTrigger;
      orderId: string;
      filledUsd: string;
      retries: number;
      exitPrice: number;
      shares: number;
      makingAmount?: string | undefined;
      takingAmount?: string | undefined;
    }
  | { status: "not_triggered" };

/**
 * One exit check against the live best bid. Sells the FULL position via an
 * immediate FAK market order when either threshold is crossed:
 *   - best bid >= takeProfitPrice  -> take profit
 *   - best bid <= stopPrice        -> stop loss
 * Exactly one of the two can fire per call (take profit wins ties, but the
 * thresholds never overlap in practice), so a position is never double-sold.
 */
export async function runExitCheckOnce(cfg: ExitCheckConfig, nowMs: number): Promise<ExitOutcome> {
  const book = await fetchOrderBook(cfg.endpoints, cfg.tokenId);
  const bestBid = bestBidPrice(book);
  if (!(bestBid > 0)) return { status: "not_triggered" };

  let trigger: ExitTrigger;
  if (bestBid >= cfg.takeProfitPrice) trigger = "take_profit";
  else if (bestBid <= cfg.stopPrice) trigger = "stop";
  else return { status: "not_triggered" };

  // Immediate FAK exit. Cap the sell price a couple ticks through the best bid
  // so it crosses and fills now; the realized price is computed from the fill.
  const tick = Number(cfg.tickSize);
  const limitPrice = Math.max(tick, bestBid - 2 * tick);

  let retries = 0;
  while (true) {
    const resp = (await cfg.client.createAndPostMarketOrder(
      {
        tokenID: cfg.tokenId,
        price: limitPrice,
        amount: cfg.shares,
        side: Side.SELL,
        orderType: OrderType.FAK,
      },
      { tickSize: cfg.tickSize, negRisk: cfg.negRisk },
      OrderType.FAK,
    )) as OrderResponse;

    const filledUsd = resp.takingAmount;
    const filled = Number(filledUsd);
    if (resp.orderID && Number.isFinite(filled) && filled > 0) {
      // Realized exit price: for a SELL, makingAmount = shares sold,
      // takingAmount = USDC received. The actual fill can differ from our
      // protective limit cap, so report what we truly got, not limitPrice.
      const soldShares = Number(resp.makingAmount);
      const realizedPrice =
        Number.isFinite(soldShares) && soldShares > 0 ? filled / soldShares : limitPrice;
      return {
        status: "exited",
        trigger,
        orderId: resp.orderID,
        filledUsd,
        retries,
        exitPrice: realizedPrice,
        shares: cfg.shares,
        makingAmount: resp.makingAmount || undefined,
        takingAmount: resp.takingAmount || undefined,
      };
    }

    retries += 1;
    if (retries > cfg.maxExitRetries) {
      throw new Error(`Exit (${trigger}) failed to fill after ${cfg.maxExitRetries} retries`);
    }

    const jitter = 50 + (nowMs % 100);
    await new Promise((r) => setTimeout(r, Math.min(500, jitter)));
  }
}

