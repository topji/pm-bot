import type Database from "better-sqlite3";

import type { OrderSide } from "../polymarket/types.js";

export type ExitType = "stop" | "redeem" | "cancelled";

export type TradeRoundRow = {
  market_id: string;
  order_side: OrderSide;
  slug: string;
  entry_placed_at_ms: number | null;
  entry_filled_at_ms: number | null;
  exit_at_ms: number | null;
  entry_price: number | null;
  exit_price: number | null;
  shares: number | null;
  entry_usd: number | null;
  exit_usd: number | null;
  filled: number;
  stop_triggered: number;
  exit_type: ExitType | null;
  pnl_usd: number | null;
  seconds_to_expiry_at_entry: number | null;
  entry_order_id: string | null;
  exit_order_id: string | null;
  redeem_tx_hash: string | null;
  updated_at_ms: number;
};

function computePnl(entryUsd: number | null, exitUsd: number | null): number | null {
  if (entryUsd === null || exitUsd === null) return null;
  if (!Number.isFinite(entryUsd) || !Number.isFinite(exitUsd)) return null;
  return exitUsd - entryUsd;
}

export function openTradeRound(
  db: Database.Database,
  params: {
    marketId: string;
    orderSide: OrderSide;
    slug: string;
    entryPlacedAtMs: number;
    secondsToExpiryAtEntry: number;
    entryOrderId: string;
    intendedEntryPrice: number;
    intendedEntryUsd: number;
  },
): void {
  db.prepare(
    `
    INSERT INTO trade_rounds (
      market_id, order_side, slug, entry_placed_at_ms, seconds_to_expiry_at_entry,
      entry_order_id, entry_price, entry_usd, filled, stop_triggered, updated_at_ms
    )
    VALUES (
      @market_id, @order_side, @slug, @entry_placed_at_ms, @seconds_to_expiry_at_entry,
      @entry_order_id, @entry_price, @entry_usd, 0, 0, @updated_at_ms
    )
    ON CONFLICT(market_id, order_side) DO NOTHING
  `,
  ).run({
    market_id: params.marketId,
    order_side: params.orderSide,
    slug: params.slug,
    entry_placed_at_ms: params.entryPlacedAtMs,
    seconds_to_expiry_at_entry: params.secondsToExpiryAtEntry,
    entry_order_id: params.entryOrderId,
    entry_price: params.intendedEntryPrice,
    entry_usd: params.intendedEntryUsd,
    updated_at_ms: params.entryPlacedAtMs,
  });
}

export function markEntryFilled(
  db: Database.Database,
  params: {
    marketId: string;
    orderSide: OrderSide;
    entryFilledAtMs: number;
    entryPrice: number;
    shares: number;
    entryUsd: number;
  },
): void {
  db.prepare(
    `
    UPDATE trade_rounds SET
      filled = 1,
      entry_filled_at_ms = @entry_filled_at_ms,
      entry_price = @entry_price,
      shares = @shares,
      entry_usd = @entry_usd,
      updated_at_ms = @updated_at_ms
    WHERE market_id = @market_id AND order_side = @order_side AND filled = 0
  `,
  ).run({
    market_id: params.marketId,
    order_side: params.orderSide,
    entry_filled_at_ms: params.entryFilledAtMs,
    entry_price: params.entryPrice,
    shares: params.shares,
    entry_usd: params.entryUsd,
    updated_at_ms: params.entryFilledAtMs,
  });
}

export function closeTradeRoundWithStop(
  db: Database.Database,
  params: {
    marketId: string;
    orderSide: OrderSide;
    exitAtMs: number;
    exitPrice: number;
    exitUsd: number;
    shares: number;
    exitOrderId: string;
  },
): void {
  const row = db
    .prepare(
      `SELECT entry_usd, filled FROM trade_rounds WHERE market_id = ? AND order_side = ?`,
    )
    .get(params.marketId, params.orderSide) as { entry_usd: number | null; filled: number } | undefined;

  const entryUsd = row?.entry_usd ?? null;
  const pnl = row?.filled ? computePnl(entryUsd, params.exitUsd) : null;

  db.prepare(
    `
    UPDATE trade_rounds SET
      filled = 1,
      stop_triggered = 1,
      exit_type = 'stop',
      exit_at_ms = @exit_at_ms,
      exit_price = @exit_price,
      exit_usd = @exit_usd,
      shares = @shares,
      exit_order_id = @exit_order_id,
      pnl_usd = @pnl_usd,
      updated_at_ms = @updated_at_ms
    WHERE market_id = @market_id AND order_side = @order_side
  `,
  ).run({
    market_id: params.marketId,
    order_side: params.orderSide,
    exit_at_ms: params.exitAtMs,
    exit_price: params.exitPrice,
    exit_usd: params.exitUsd,
    shares: params.shares,
    exit_order_id: params.exitOrderId,
    pnl_usd: pnl,
    updated_at_ms: params.exitAtMs,
  });
}

export function closeTradeRoundWithRedeem(
  db: Database.Database,
  params: {
    marketId: string;
    orderSide: OrderSide;
    exitAtMs: number;
    shares: number;
    redeemTxHash: string;
  },
): void {
  const exitUsd = params.shares;
  const row = db
    .prepare(`SELECT entry_usd, filled FROM trade_rounds WHERE market_id = ? AND order_side = ?`)
    .get(params.marketId, params.orderSide) as { entry_usd: number | null; filled: number } | undefined;

  const pnl = row?.filled ? computePnl(row.entry_usd, exitUsd) : null;

  db.prepare(
    `
    UPDATE trade_rounds SET
      filled = 1,
      stop_triggered = 0,
      exit_type = 'redeem',
      exit_at_ms = @exit_at_ms,
      exit_price = 1.0,
      exit_usd = @exit_usd,
      shares = @shares,
      redeem_tx_hash = @redeem_tx_hash,
      pnl_usd = @pnl_usd,
      updated_at_ms = @updated_at_ms
    WHERE market_id = @market_id AND order_side = @order_side
  `,
  ).run({
    market_id: params.marketId,
    order_side: params.orderSide,
    exit_at_ms: params.exitAtMs,
    exit_usd: exitUsd,
    shares: params.shares,
    redeem_tx_hash: params.redeemTxHash,
    pnl_usd: pnl,
    updated_at_ms: params.exitAtMs,
  });
}

export function markTradeRoundEntryCancelled(
  db: Database.Database,
  params: {
    marketId: string;
    orderSide: OrderSide;
    cancelledAtMs: number;
  },
): void {
  db.prepare(
    `
    UPDATE trade_rounds SET
      filled = 0,
      stop_triggered = 0,
      exit_type = 'cancelled',
      exit_at_ms = @exit_at_ms,
      exit_price = NULL,
      exit_usd = 0,
      pnl_usd = 0,
      updated_at_ms = @updated_at_ms
    WHERE market_id = @market_id AND order_side = @order_side AND exit_at_ms IS NULL AND filled = 0
  `,
  ).run({
    market_id: params.marketId,
    order_side: params.orderSide,
    exit_at_ms: params.cancelledAtMs,
    updated_at_ms: params.cancelledAtMs,
  });
}

export function getTradeRound(
  db: Database.Database,
  marketId: string,
  orderSide: OrderSide,
): TradeRoundRow | null {
  const row = db
    .prepare(`SELECT * FROM trade_rounds WHERE market_id = ? AND order_side = ?`)
    .get(marketId, orderSide) as TradeRoundRow | undefined;
  return row ?? null;
}

/** Infer entry fill from an open position when the entry order rested then filled. */
export function reconcileEntryFillsFromPositions(
  db: Database.Database,
  params: {
    positions: { asset?: string | undefined; size?: number | undefined; avgPrice?: number | undefined }[];
    orderSide: OrderSide;
    nowMs: number;
  },
): number {
  const openRounds = db
    .prepare(
      `
      SELECT tr.market_id, tr.order_side, tr.entry_price, m.up_token_id, m.down_token_id
      FROM trade_rounds tr
      JOIN markets m ON m.market_id = tr.market_id
      WHERE tr.filled = 0 AND tr.exit_at_ms IS NULL
    `,
    )
    .all() as {
    market_id: string;
    order_side: OrderSide;
    entry_price: number | null;
    up_token_id: string;
    down_token_id: string;
  }[];

  let updated = 0;
  for (const round of openRounds) {
    if (round.order_side !== params.orderSide) continue;
    const tokenId = params.orderSide === "UP" ? round.up_token_id : round.down_token_id;
    const pos = params.positions.find((p) => p.asset === tokenId && (p.size ?? 0) > 0);
    if (!pos?.size) continue;

    const entryPrice = pos.avgPrice ?? round.entry_price ?? 0.3;
    const shares = pos.size;
    const entryUsd = shares * entryPrice;

    markEntryFilled(db, {
      marketId: round.market_id,
      orderSide: params.orderSide,
      entryFilledAtMs: params.nowMs,
      entryPrice,
      shares,
      entryUsd,
    });
    updated += 1;
  }
  return updated;
}

export function applyDataApiFillToTradeRound(
  db: Database.Database,
  params: {
    orderId?: string | null | undefined;
    side?: string | null | undefined;
    price?: number | null | undefined;
    shares?: number | null | undefined;
    nowMs: number;
  },
): boolean {
  if (!params.orderId || params.side?.toLowerCase() !== "buy") return false;
  if (params.price == null || params.shares == null) return false;

  const round = db
    .prepare(`SELECT market_id, order_side, filled FROM trade_rounds WHERE entry_order_id = ?`)
    .get(params.orderId) as { market_id: string; order_side: OrderSide; filled: number } | undefined;
  if (!round || round.filled) return false;

  const entryUsd = params.shares * params.price;
  markEntryFilled(db, {
    marketId: round.market_id,
    orderSide: round.order_side,
    entryFilledAtMs: params.nowMs,
    entryPrice: params.price,
    shares: params.shares,
    entryUsd,
  });
  return true;
}

export function parseImmediateEntryFill(res: {
  status: string;
  price: number;
  shares: number;
  makingAmount?: string | undefined;
  takingAmount?: string | undefined;
}): { filled: boolean; entryPrice: number; shares: number; entryUsd: number } | null {
  const making = res.makingAmount ? Number(res.makingAmount) : NaN;
  const taking = res.takingAmount ? Number(res.takingAmount) : NaN;
  const status = res.status.toLowerCase();
  const matched =
    status === "matched" ||
    status === "filled" ||
    (Number.isFinite(making) && making > 0 && Number.isFinite(taking) && taking > 0);

  if (!matched) return null;

  const shares = Number.isFinite(taking) && taking > 0 ? taking : res.shares;
  const entryUsd = Number.isFinite(making) && making > 0 ? making : shares * res.price;
  const entryPrice = shares > 0 ? entryUsd / shares : res.price;

  return { filled: true, entryPrice, shares, entryUsd };
}
