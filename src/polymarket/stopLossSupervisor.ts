import type { ClobClient } from "@polymarket/clob-client-v2";
import type Database from "better-sqlite3";
import type pino from "pino";
import type { Address } from "viem";

import type { BotConfig } from "../config.js";
import type { Endpoints } from "./endpoints.js";
import type { DataApiPosition } from "./types.js";
import type { OrderSide } from "./types.js";
import { outcomeTokenIdFromRow } from "./types.js";
import { fetchPositionsForUser } from "./dataApi.js";
import { runExitCheckOnce } from "./stopMonitor.js";
import { recordTrade } from "../state/trades.js";
import { closeTradeRoundWithStop, closeTradeRoundWithTakeProfit } from "../state/tradeRounds.js";

type MarketRow = {
  market_id: string;
  slug: string;
  end_date: string;
  tick_size: "0.1" | "0.01" | "0.001" | "0.0001";
  neg_risk: number;
  up_token_id: string;
  down_token_id: string;
};

function findMarketByTokenId(db: Database.Database, tokenId: string): MarketRow | null {
  const row = db
    .prepare(
      `
      SELECT market_id, slug, end_date, tick_size, neg_risk, up_token_id, down_token_id
      FROM markets
      WHERE up_token_id = ? OR down_token_id = ?
      LIMIT 1
    `,
    )
    .get(tokenId, tokenId) as MarketRow | undefined;
  return row ?? null;
}

function positionMatchesOrderSide(
  db: Database.Database,
  asset: string | undefined,
  orderSide: OrderSide,
): boolean {
  if (!asset) return false;
  const m = findMarketByTokenId(db, asset);
  if (!m) return false;
  return outcomeTokenIdFromRow(m, orderSide) === asset;
}

async function handleStopForPosition(params: {
  db: Database.Database;
  endpoints: Endpoints;
  clob: ClobClient;
  log: pino.Logger;
  orderSide: OrderSide;
  pos: DataApiPosition;
  nowMs: number;
  stopPollMs: number;
  stopPrice: number;
  takeProfitPrice: number;
}): Promise<void> {
  if (!params.pos.asset || !params.pos.size || params.pos.size <= 0) return;
  if (!positionMatchesOrderSide(params.db, params.pos.asset, params.orderSide)) return;

  const m = findMarketByTokenId(params.db, params.pos.asset);
  if (!m) return;

  // Exit checks only apply while the market is live. Once it's at/past expiry,
  // the position holds to resolution and is auto-redeemed — and the CLOB /book
  // 404s for resolved markets, so polling it is pointless noise. Skip.
  const endMs = Date.parse(m.end_date);
  if (Number.isFinite(endMs) && params.nowMs >= endMs) return;

  const out = await runExitCheckOnce(
    {
      endpoints: params.endpoints,
      client: params.clob,
      tokenId: params.pos.asset,
      shares: params.pos.size,
      tickSize: m.tick_size,
      negRisk: Boolean(params.pos.negativeRisk ?? m.neg_risk),
      stopPrice: params.stopPrice,
      takeProfitPrice: params.takeProfitPrice,
      pollMs: params.stopPollMs,
      maxExitRetries: 3,
    },
    params.nowMs,
  );

  if (out.status !== "exited") return;

  const isTakeProfit = out.trigger === "take_profit";
  const newStatus = isTakeProfit ? "tookProfit" : "stopped";

  params.db
    .prepare(
      `
      INSERT INTO market_state (market_id, order_side, status, stop_order_id, updated_at_ms)
      VALUES (@market_id, @order_side, @status, @stop_order_id, @updated_at_ms)
      ON CONFLICT(market_id, order_side) DO UPDATE SET
        status=excluded.status,
        stop_order_id=excluded.stop_order_id,
        updated_at_ms=excluded.updated_at_ms
    `,
    )
    .run({
      market_id: m.market_id,
      order_side: params.orderSide,
      status: newStatus,
      stop_order_id: out.orderId,
      updated_at_ms: params.nowMs,
    });

  params.log.warn(
    { market: m.slug, orderId: out.orderId, trigger: out.trigger, exitPrice: out.exitPrice },
    isTakeProfit ? "take-profit executed" : "stop-loss executed",
  );

  const exitUsd = Number(out.filledUsd);
  recordTrade(params.db, {
    tradeKey: `bot:order:${out.orderId}`,
    marketId: m.market_id,
    slug: m.slug,
    action: isTakeProfit ? "take_profit_exit" : "stop_exit",
    side: "sell",
    tokenId: params.pos.asset,
    price: out.exitPrice,
    shares: out.shares,
    usdAmount: Number.isFinite(exitUsd) ? exitUsd : null,
    orderId: out.orderId,
    status: "filled",
    makingAmount: out.makingAmount ?? null,
    takingAmount: out.takingAmount ?? null,
    source: "bot",
    rawJson: JSON.stringify(out),
    createdAtMs: params.nowMs,
  });

  const closeArgs = {
    marketId: m.market_id,
    orderSide: params.orderSide,
    exitAtMs: params.nowMs,
    exitPrice: out.exitPrice,
    exitUsd: Number.isFinite(exitUsd) ? exitUsd : 0,
    shares: out.shares,
    exitOrderId: out.orderId,
  };
  if (isTakeProfit) {
    closeTradeRoundWithTakeProfit(params.db, closeArgs);
  } else {
    closeTradeRoundWithStop(params.db, closeArgs);
  }
}

/** Polls open positions every `stopPollMs` and runs exit checks (stop loss + take profit). */
export async function runStopLossSupervisor(params: {
  config: BotConfig;
  log: pino.Logger;
  db: Database.Database;
  endpoints: Endpoints;
  clob: ClobClient;
  depositWalletAddress: Address;
}): Promise<never> {
  const orderSide = params.config.orderSide;

  while (true) {
    const loopStartMs = Date.now();

    if (!params.config.killSwitch) {
      try {
        const positions = await fetchPositionsForUser(params.endpoints, params.depositWalletAddress);
        await Promise.all(
          positions.map((pos) =>
            handleStopForPosition({
              db: params.db,
              endpoints: params.endpoints,
              clob: params.clob,
              log: params.log,
              orderSide,
              pos,
              nowMs: loopStartMs,
              stopPollMs: params.config.stopPollMs,
              stopPrice: params.config.stopPrice,
              takeProfitPrice: params.config.takeProfitPrice,
            }).catch((err) => {
              params.log.warn({ err, asset: pos.asset }, "stop-loss check failed");
            }),
          ),
        );
      } catch (err) {
        params.log.warn({ err }, "stop-loss supervisor fetch failed");
      }
    }

    const elapsed = Date.now() - loopStartMs;
    const sleepMs = Math.max(50, params.config.stopPollMs - elapsed);
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}
