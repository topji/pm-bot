import type Database from "better-sqlite3";

import type { OrderSide } from "../polymarket/types.js";
import type { TradeRoundRow } from "../state/tradeRounds.js";
import type { TradeEventDto } from "./dto.js";

export type RoundsFilter = {
  orderSide?: OrderSide | undefined;
  filled?: boolean | undefined;
  exitType?: string | undefined;
  limit: number;
  offset: number;
};

export type AnalyticsSummary = {
  totalRounds: number;
  filledRounds: number;
  fillRate: number | null;
  openRounds: number;
  stoppedRounds: number;
  redeemedRounds: number;
  cancelledRounds: number;
  closedWithPnl: number;
  totalPnlUsd: number;
  avgPnlUsd: number | null;
  winCount: number;
  lossCount: number;
  winRate: number | null;
  stopRateOfFilled: number | null;
};

export type DailyPnlRow = {
  day: string;
  rounds: number;
  filledRounds: number;
  closedRounds: number;
  totalPnlUsd: number;
  stoppedRounds: number;
  redeemedRounds: number;
};

function buildRoundsWhere(filter: RoundsFilter): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.orderSide) {
    clauses.push("order_side = ?");
    params.push(filter.orderSide);
  }
  if (filter.filled !== undefined) {
    clauses.push("filled = ?");
    params.push(filter.filled ? 1 : 0);
  }
  if (filter.exitType) {
    clauses.push("exit_type = ?");
    params.push(filter.exitType);
  }

  const sql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return { sql, params };
}

export function countTradeRounds(db: Database.Database, filter: RoundsFilter): number {
  const { sql, params } = buildRoundsWhere(filter);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM trade_rounds ${sql}`).get(...params) as {
    n: number;
  };
  return row.n;
}

export function listTradeRounds(db: Database.Database, filter: RoundsFilter): TradeRoundRow[] {
  const { sql, params } = buildRoundsWhere(filter);
  return db
    .prepare(
      `
      SELECT *
      FROM trade_rounds
      ${sql}
      ORDER BY entry_placed_at_ms DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params, filter.limit, filter.offset) as TradeRoundRow[];
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

export function getAnalyticsSummary(
  db: Database.Database,
  orderSide?: OrderSide,
): AnalyticsSummary {
  const sideClause = orderSide ? "WHERE order_side = ?" : "";
  const params = orderSide ? [orderSide] : [];

  const agg = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total_rounds,
        SUM(CASE WHEN filled = 1 THEN 1 ELSE 0 END) AS filled_rounds,
        SUM(CASE WHEN exit_at_ms IS NULL THEN 1 ELSE 0 END) AS open_rounds,
        SUM(CASE WHEN exit_type = 'stop' THEN 1 ELSE 0 END) AS stopped_rounds,
        SUM(CASE WHEN exit_type = 'redeem' THEN 1 ELSE 0 END) AS redeemed_rounds,
        SUM(CASE WHEN exit_type = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_rounds,
        SUM(CASE WHEN pnl_usd IS NOT NULL THEN 1 ELSE 0 END) AS closed_with_pnl,
        COALESCE(SUM(pnl_usd), 0) AS total_pnl_usd,
        AVG(CASE WHEN pnl_usd IS NOT NULL THEN pnl_usd END) AS avg_pnl_usd,
        SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS win_count,
        SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) AS loss_count
      FROM trade_rounds
      ${sideClause}
    `,
    )
    .get(...params) as {
    total_rounds: number;
    filled_rounds: number;
    open_rounds: number;
    stopped_rounds: number;
    redeemed_rounds: number;
    cancelled_rounds: number;
    closed_with_pnl: number;
    total_pnl_usd: number;
    avg_pnl_usd: number | null;
    win_count: number;
    loss_count: number;
  };

  const filled = agg.filled_rounds ?? 0;
  const closed = agg.closed_with_pnl ?? 0;
  const wins = agg.win_count ?? 0;

  return {
    totalRounds: agg.total_rounds ?? 0,
    filledRounds: filled,
    fillRate: agg.total_rounds > 0 ? filled / agg.total_rounds : null,
    openRounds: agg.open_rounds ?? 0,
    stoppedRounds: agg.stopped_rounds ?? 0,
    redeemedRounds: agg.redeemed_rounds ?? 0,
    cancelledRounds: agg.cancelled_rounds ?? 0,
    closedWithPnl: closed,
    totalPnlUsd: agg.total_pnl_usd ?? 0,
    avgPnlUsd: agg.avg_pnl_usd,
    winCount: wins,
    lossCount: agg.loss_count ?? 0,
    winRate: closed > 0 ? wins / closed : null,
    stopRateOfFilled: filled > 0 ? (agg.stopped_rounds ?? 0) / filled : null,
  };
}

export function getDailyPnl(
  db: Database.Database,
  params: { days: number; orderSide?: OrderSide | undefined },
): DailyPnlRow[] {
  const sinceMs = Date.now() - params.days * 86_400_000;
  const sideFilter = params.orderSide ? "AND order_side = ?" : "";
  const bind = params.orderSide ? [sinceMs, params.orderSide] : [sinceMs];

  return db
    .prepare(
      `
      SELECT
        strftime('%Y-%m-%d', entry_placed_at_ms / 1000, 'unixepoch') AS day,
        COUNT(*) AS rounds,
        SUM(CASE WHEN filled = 1 THEN 1 ELSE 0 END) AS filled_rounds,
        SUM(CASE WHEN exit_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS closed_rounds,
        COALESCE(SUM(pnl_usd), 0) AS total_pnl_usd,
        SUM(CASE WHEN exit_type = 'stop' THEN 1 ELSE 0 END) AS stopped_rounds,
        SUM(CASE WHEN exit_type = 'redeem' THEN 1 ELSE 0 END) AS redeemed_rounds
      FROM trade_rounds
      WHERE entry_placed_at_ms >= ?
      ${sideFilter}
      GROUP BY day
      ORDER BY day DESC
    `,
    )
    .all(...bind) as DailyPnlRow[];
}

export function listTradeEvents(
  db: Database.Database,
  params: { limit: number; offset: number },
): TradeEventDto[] {
  const rows = db
    .prepare(
      `
      SELECT
        trade_key, market_id, slug, action, side, token_id, price, shares,
        usd_amount, order_id, tx_hash, status, source, created_at_ms
      FROM trades
      ORDER BY created_at_ms DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(params.limit, params.offset) as {
    trade_key: string;
    market_id: string | null;
    slug: string | null;
    action: string;
    side: string | null;
    token_id: string | null;
    price: number | null;
    shares: number | null;
    usd_amount: number | null;
    order_id: string | null;
    tx_hash: string | null;
    status: string | null;
    source: string;
    created_at_ms: number;
  }[];

  return rows.map((r) => ({
    tradeKey: r.trade_key,
    marketId: r.market_id,
    slug: r.slug,
    action: r.action,
    side: r.side,
    tokenId: r.token_id,
    price: r.price,
    shares: r.shares,
    usdAmount: r.usd_amount,
    orderId: r.order_id,
    txHash: r.tx_hash,
    status: r.status,
    source: r.source,
    createdAtMs: r.created_at_ms,
  }));
}

export function countTradeEvents(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM trades`).get() as { n: number };
  return row.n;
}
