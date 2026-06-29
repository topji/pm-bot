import {
  AssetType,
  OrderType,
  Side,
  type ClobClient,
  type OrderResponse,
} from "@polymarket/clob-client-v2";

import type { GammaMarket, OrderSide } from "./types.js";
import { isPriceOnTick } from "./tick.js";
import { outcomeTokenId } from "./types.js";

export type EntryDecision =
  | { allowed: false; reason: string }
  | { allowed: true; secondsToExpiry: number };

export function secondsToExpiry(endDateIso: string, nowMs: number): number {
  const endMs = Date.parse(endDateIso);
  if (!Number.isFinite(endMs)) return -1;
  return Math.floor((endMs - nowMs) / 1000);
}

export function canPlaceEntryNow(params: { endDateIso: string; nowMs: number }): EntryDecision {
  const secs = secondsToExpiry(params.endDateIso, params.nowMs);
  if (secs < 0) return { allowed: false, reason: "invalid_endDate" };
  if (secs < 30) return { allowed: false, reason: "too_close_to_expiry" };
  if (secs > 290) return { allowed: false, reason: "too_early" };
  return { allowed: true, secondsToExpiry: secs };
}

export type PlaceExactEntryInput = {
  client: ClobClient;
  market: GammaMarket;
  orderSide: OrderSide;
  usdPerTrade: number;
  exactPrice: number; // e.g. 0.30
  nowMs: number;
};

export type PlaceExactEntryResult = {
  orderType: OrderType;
  orderId: string;
  status: string;
  price: number;
  shares: number;
  tokenId: string;
  makingAmount?: string | undefined;
  takingAmount?: string | undefined;
};

export async function placeExactEntryAtPrice(
  input: PlaceExactEntryInput,
): Promise<PlaceExactEntryResult | { skipped: true; reason: string }> {
  const gate = canPlaceEntryNow({ endDateIso: input.market.endDate, nowMs: input.nowMs });
  if (!gate.allowed) return { skipped: true, reason: gate.reason };

  if (!isPriceOnTick(input.exactPrice, input.market.tickSize)) {
    return { skipped: true, reason: "tick_does_not_support_exact_price" };
  }

  const shares = input.usdPerTrade / input.exactPrice;
  if (!Number.isFinite(shares) || shares <= 0) return { skipped: true, reason: "invalid_share_calc" };

  const tokenId = outcomeTokenId(input.market, input.orderSide);

  // Keep CLOB collateral accounting in sync before a buy.
  await input.client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });

  // Polymarket constraint: GTD expiration must be >= now + 60 seconds.
  // We still must respect the required entry window [30, 290].
  // If we're inside the window but cannot satisfy GTD, we fall back to GTC and rely on bot-side cancel.
  const nowSec = Math.floor(input.nowMs / 1000);
  const endSec = Math.floor(Date.parse(input.market.endDate) / 1000);
  const minGtdExpiration = nowSec + 60;
  const orderType = endSec >= minGtdExpiration ? OrderType.GTD : OrderType.GTC;
  const expiration = orderType === OrderType.GTD ? endSec : undefined;

  const response = (await input.client.createAndPostOrder(
    {
      tokenID: tokenId,
      price: input.exactPrice,
      size: shares,
      side: Side.BUY,
      ...(expiration ? { expiration } : {}),
    },
    { tickSize: input.market.tickSize, negRisk: input.market.negRisk },
    orderType,
    false,
  )) as OrderResponse;

  if (!response.orderID) {
    return { skipped: true, reason: `order_failed_${response.status ?? "unknown"}` };
  }

  return {
    orderType,
    orderId: response.orderID,
    status: response.status ?? "unknown",
    price: input.exactPrice,
    shares,
    tokenId,
    makingAmount: response.makingAmount || undefined,
    takingAmount: response.takingAmount || undefined,
  };
}
