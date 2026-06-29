import type { ExitType, TradeRoundRow } from "../state/tradeRounds.js";
import type { OrderSide } from "../polymarket/types.js";

export type TradeRoundDto = {
  marketId: string;
  orderSide: OrderSide;
  slug: string;
  entryPlacedAtMs: number | null;
  entryFilledAtMs: number | null;
  exitAtMs: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  shares: number | null;
  entryUsd: number | null;
  exitUsd: number | null;
  filled: boolean;
  stopTriggered: boolean;
  exitType: ExitType | null;
  pnlUsd: number | null;
  secondsToExpiryAtEntry: number | null;
  entryOrderId: string | null;
  exitOrderId: string | null;
  redeemTxHash: string | null;
  updatedAtMs: number;
};

export type TradeEventDto = {
  tradeKey: string;
  marketId: string | null;
  slug: string | null;
  action: string;
  side: string | null;
  tokenId: string | null;
  price: number | null;
  shares: number | null;
  usdAmount: number | null;
  orderId: string | null;
  txHash: string | null;
  status: string | null;
  source: string;
  createdAtMs: number;
};

export function serializeTradeRound(row: TradeRoundRow): TradeRoundDto {
  return {
    marketId: row.market_id,
    orderSide: row.order_side,
    slug: row.slug,
    entryPlacedAtMs: row.entry_placed_at_ms,
    entryFilledAtMs: row.entry_filled_at_ms,
    exitAtMs: row.exit_at_ms,
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    shares: row.shares,
    entryUsd: row.entry_usd,
    exitUsd: row.exit_usd,
    filled: row.filled === 1,
    stopTriggered: row.stop_triggered === 1,
    exitType: row.exit_type,
    pnlUsd: row.pnl_usd,
    secondsToExpiryAtEntry: row.seconds_to_expiry_at_entry,
    entryOrderId: row.entry_order_id,
    exitOrderId: row.exit_order_id,
    redeemTxHash: row.redeem_tx_hash,
    updatedAtMs: row.updated_at_ms,
  };
}
