import type Database from "better-sqlite3";

export type TradeAction = "entry" | "stop_exit" | "redeem" | "fill";
export type TradeSource = "bot" | "data_api";

export type TradeInsert = {
  tradeKey: string;
  marketId?: string | null | undefined;
  slug?: string | null | undefined;
  action: TradeAction;
  side?: "buy" | "sell" | null | undefined;
  tokenId?: string | null | undefined;
  price?: number | null | undefined;
  shares?: number | null | undefined;
  usdAmount?: number | null | undefined;
  orderId?: string | null | undefined;
  txHash?: string | null | undefined;
  status?: string | null | undefined;
  makingAmount?: string | null | undefined;
  takingAmount?: string | null | undefined;
  source: TradeSource;
  rawJson?: string | null | undefined;
  createdAtMs: number;
};

export function recordTrade(db: Database.Database, trade: TradeInsert): boolean {
  const result = db
    .prepare(
      `
      INSERT INTO trades (
        trade_key, market_id, slug, action, side, token_id, price, shares, usd_amount,
        order_id, tx_hash, status, making_amount, taking_amount, source, raw_json, created_at_ms
      )
      VALUES (
        @trade_key, @market_id, @slug, @action, @side, @token_id, @price, @shares, @usd_amount,
        @order_id, @tx_hash, @status, @making_amount, @taking_amount, @source, @raw_json, @created_at_ms
      )
      ON CONFLICT(trade_key) DO NOTHING
    `,
    )
    .run({
      trade_key: trade.tradeKey,
      market_id: trade.marketId ?? null,
      slug: trade.slug ?? null,
      action: trade.action,
      side: trade.side ?? null,
      token_id: trade.tokenId ?? null,
      price: trade.price ?? null,
      shares: trade.shares ?? null,
      usd_amount: trade.usdAmount ?? null,
      order_id: trade.orderId ?? null,
      tx_hash: trade.txHash ?? null,
      status: trade.status ?? null,
      making_amount: trade.makingAmount ?? null,
      taking_amount: trade.takingAmount ?? null,
      source: trade.source,
      raw_json: trade.rawJson ?? null,
      created_at_ms: trade.createdAtMs,
    });

  return result.changes > 0;
}

export function countTrades(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM trades`).get() as { n: number };
  return row.n;
}
