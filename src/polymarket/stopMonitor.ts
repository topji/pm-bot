import { OrderType, Side, type ClobClient, type OrderResponse } from "@polymarket/clob-client-v2";

import type { Endpoints } from "./endpoints.js";
import { bestBidPrice, fetchOrderBook } from "./orderbook.js";
import type { TickSize } from "./types.js";

export type StopMonitorConfig = {
  endpoints: Endpoints;
  client: ClobClient;
  tokenId: string;
  shares: number;
  tickSize: TickSize;
  negRisk: boolean;
  stopPrice: number; // 0.15
  pollMs: number;
  maxExitRetries: number;
};

export type StopOutcome =
  | {
      status: "stopped";
      orderId: string;
      filledUsd: string;
      retries: number;
      exitPrice: number;
      shares: number;
      makingAmount?: string | undefined;
      takingAmount?: string | undefined;
    }
  | { status: "not_triggered" };

export async function runStopLossModeAOnce(
  cfg: StopMonitorConfig,
  nowMs: number,
): Promise<StopOutcome> {
  const book = await fetchOrderBook(cfg.endpoints, cfg.tokenId);
  const bestBid = bestBidPrice(book);
  if (!(bestBid > 0 && bestBid <= cfg.stopPrice)) return { status: "not_triggered" };

  // Mode A: immediate FAK exit. We price to cross the book similarly to the app pattern.
  // Use a conservative sell price cap below bestBid to improve fill likelihood.
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
      return {
        status: "stopped",
        orderId: resp.orderID,
        filledUsd,
        retries,
        exitPrice: limitPrice,
        shares: cfg.shares,
        makingAmount: resp.makingAmount || undefined,
        takingAmount: resp.takingAmount || undefined,
      };
    }

    retries += 1;
    if (retries > cfg.maxExitRetries) {
      throw new Error(`Stop exit failed to fill after ${cfg.maxExitRetries} retries`);
    }

    const jitter = 50 + (nowMs % 100);
    await new Promise((r) => setTimeout(r, Math.min(500, jitter)));
  }
}

