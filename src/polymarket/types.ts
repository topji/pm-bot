import { z } from "zod";
import type { TickSize as ClobTickSize } from "@polymarket/clob-client-v2";

export const TickSizeSchema = z.enum(["0.1", "0.01", "0.001", "0.0001"]);
export type TickSize = ClobTickSize;

export type MarketSide = "up" | "down";

/** Bot env: which outcome to trade (UP or DOWN). */
export type OrderSide = "UP" | "DOWN";

export function outcomeTokenId(market: GammaMarket, orderSide: OrderSide): string {
  return orderSide === "UP" ? market.upTokenId : market.downTokenId;
}

export function outcomeTokenIdFromRow(
  row: { up_token_id: string; down_token_id: string },
  orderSide: OrderSide,
): string {
  return orderSide === "UP" ? row.up_token_id : row.down_token_id;
}

export type GammaMarket = {
  id: string;
  slug: string;
  question: string;
  endDate: string; // ISO date string
  active: boolean;
  closed: boolean;
  negRisk: boolean;
  tickSize: TickSize;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
};

export type DataApiPosition = {
  proxyWallet?: string | undefined;
  asset?: string | undefined;
  conditionId?: string | undefined;
  size?: number | undefined;
  curPrice?: number | undefined;
  negativeRisk?: boolean | undefined;
  redeemable?: boolean | undefined;
  avgPrice?: number | undefined;
};

