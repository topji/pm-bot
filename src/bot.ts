import type { ClobClient } from "@polymarket/clob-client-v2";
import type Database from "better-sqlite3";
import type pino from "pino";
import type { Address, Hex } from "viem";

import type { BotConfig } from "./config.js";
import type { Endpoints } from "./polymarket/endpoints.js";
import type { GammaMarket, OrderSide } from "./polymarket/types.js";
import { outcomeTokenId, outcomeTokenIdFromRow } from "./polymarket/types.js";
import { discoverBtc5mUpDownMarkets } from "./polymarket/gamma.js";
import { createBotWallets, deriveDepositWalletForBot } from "./polymarket/wallets.js";
import { createDepositWalletClobClient, loadOrCreateClobCreds } from "./polymarket/clob.js";
import { canPlaceEntryNow, placeExactEntryAtPrice, secondsToExpiry } from "./polymarket/orders.js";
import { cancelEntryOrdersNearExpiry, hasEntryForMarket } from "./polymarket/entryOrders.js";
import { fetchPositionsForUser } from "./polymarket/dataApi.js";
import { runStopLossSupervisor } from "./polymarket/stopLossSupervisor.js";
import { recordTrade } from "./state/trades.js";
import { shouldSyncTrades, syncTradesFromDataApi } from "./polymarket/tradesSync.js";
import {
  closeTradeRoundAtResolution,
  getTradeRound,
  markEntryFilled,
  openTradeRound,
  parseImmediateEntryFill,
  reconcileEntryFillsFromPositions,
} from "./state/tradeRounds.js";

export async function runBot(params: { config: BotConfig; log: pino.Logger; db: Database.Database }) {
  const endpoints: Endpoints = {
    gammaBaseUrl: params.config.gammaBaseUrl,
    clobHost: params.config.clobHost,
    dataApiUrl: params.config.dataApiUrl,
  };

  const wallets = createBotWallets(params.config.botPrivateKey as Hex, params.config.polygonRpcUrl);
  const depositWalletAddress =
    (params.config.depositWalletAddress as Address | undefined) ?? (await deriveDepositWalletForBot(wallets));

  const creds = await loadOrCreateClobCreds({
    endpoints,
    signer: wallets.walletClient,
    credsPath: "./data/clob-creds.json",
  });

  const clob = createDepositWalletClobClient({
    endpoints,
    signer: wallets.walletClient,
    creds,
    depositWalletAddress,
  });

  params.log.info(
    {
      killSwitch: params.config.killSwitch,
      depositWalletAddress,
      orderSide: params.config.orderSide,
      usdPerTrade: params.config.usdPerTrade,
      entryPrice: params.config.entryPrice,
      stopPollMs: params.config.stopPollMs,
    },
    "bot initialized",
  );

  void runStopLossSupervisor({
    config: params.config,
    log: params.log,
    db: params.db,
    endpoints,
    clob,
    depositWalletAddress,
  }).catch((err) => {
    params.log.error({ err }, "stop-loss supervisor exited");
  });

  // Main supervisor loop: periodic scan + act.
  // State machine is persisted in SQLite and rechecked each loop.
  // This keeps behavior idempotent across restarts.
  while (true) {
    const loopStartMs = Date.now();
    try {
      await botTick({
        config: params.config,
        log: params.log,
        db: params.db,
        endpoints,
        clob,
        depositWalletAddress,
      });
    } catch (err) {
      params.log.error({ err }, "bot tick failed");
    }

    const elapsed = Date.now() - loopStartMs;
    const sleepMs = Math.max(250, params.config.scanIntervalMs - elapsed);
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}

async function botTick(params: {
  config: BotConfig;
  log: pino.Logger;
  db: Database.Database;
  endpoints: Endpoints;
  clob: ClobClient;
  depositWalletAddress: Address;
}): Promise<void> {
  const nowMs = Date.now();

  // 1) Market discovery
  const markets = await discoverBtc5mUpDownMarkets(params.endpoints, nowMs);
  upsertMarkets(params.db, markets, nowMs);
  params.log.debug(
    {
      count: markets.length,
      windowStartSec: Math.floor(nowMs / 1000 / 300) * 300,
      slugs: markets.map((m) => m.slug),
    },
    "markets scanned",
  );

  // 2) Fetch current positions (deposit wallet)
  const positions = await fetchPositionsForUser(params.endpoints, params.depositWalletAddress);

  const fillsReconciled = reconcileEntryFillsFromPositions(params.db, {
    positions,
    orderSide: params.config.orderSide,
    nowMs,
  });
  if (fillsReconciled > 0) {
    params.log.info({ fillsReconciled }, "reconciled entry fills from positions");
  }

  // 3) Kill switch behavior
  if (params.config.killSwitch) {
    // Stop new entries. Optionally cancel open orders to reduce exposure growth.
    await params.clob.cancelAll();
    params.log.warn("kill switch enabled: cancelled all open orders and skipped new entries");
    return;
  }

  const orderSide = params.config.orderSide;

  const cancelResult = await cancelEntryOrdersNearExpiry({
    client: params.clob,
    db: params.db,
    markets,
    orderSide,
    nowMs,
    positions,
  });
  if (cancelResult.cancelled > 0) {
    params.log.info(
      { cancelled: cancelResult.cancelled, markets: cancelResult.markets },
      "cancelled entry orders inside 30s expiry window",
    );
  }

  // Risk controls: cap concurrent positions for this instance's outcome side.
  // Only count positions still ACTIVE (held + not yet resolved). A redeemable
  // position is settled: winners auto-redeem, but worthless losers ($0) are never
  // auto-redeemed and linger in the positions API with size > 0 forever. Counting
  // them would let a single dead loser permanently block all new entries.
  const openPosCount = positions.filter(
    (p) => isActiveOpenPosition(p) && positionMatchesOrderSide(params.db, p.asset, orderSide),
  ).length;
  if (openPosCount >= params.config.maxConcurrentPositions) {
    params.log.info({ openPosCount, orderSide }, "maxConcurrentPositions reached; skipping entries");
  } else {
    // Attempt entries for markets we have not yet tried on this side.
    for (const m of markets) {
      if (openPosCount >= params.config.maxConcurrentPositions) break;

      const entryGate = canPlaceEntryNow({ endDateIso: m.endDate, nowMs });
      if (!entryGate.allowed) {
        if (entryGate.reason !== "too_early") {
          params.log.debug({ market: m.slug, reason: entryGate.reason }, "entry skipped");
        }
        continue;
      }

      const tokenId = outcomeTokenId(m, orderSide);
      const alreadyHasEntry = await hasEntryForMarket({
        db: params.db,
        client: params.clob,
        marketId: m.id,
        orderSide,
        tokenId,
      });
      if (alreadyHasEntry) continue;

      const res = await placeExactEntryAtPrice({
        client: params.clob,
        market: m,
        orderSide,
        usdPerTrade: params.config.usdPerTrade,
        exactPrice: params.config.entryPrice,
        nowMs,
      });
      if ("skipped" in res) {
        params.log.debug({ market: m.slug, reason: res.reason }, "entry skipped");
        continue;
      }

      params.db
        .prepare(
          `
          INSERT INTO market_state (
            market_id, order_side, status, entry_order_id, entry_order_type, entry_price, entry_shares, stop_price, updated_at_ms
          )
          VALUES (
            @market_id, @order_side, 'entryPlaced', @order_id, @order_type, @entry_price, @entry_shares, @stop_price, @updated_at_ms
          )
        `,
        )
        .run({
          market_id: m.id,
          order_side: orderSide,
          order_id: res.orderId,
          order_type: res.orderType,
          entry_price: params.config.entryPrice,
          entry_shares: params.config.usdPerTrade / params.config.entryPrice,
          stop_price: params.config.stopPrice,
          updated_at_ms: nowMs,
        });

      params.log.info({ market: m.slug, orderId: res.orderId, orderSide }, "entry placed");

      const secsToExpiry = secondsToExpiry(m.endDate, nowMs);
      openTradeRound(params.db, {
        marketId: m.id,
        orderSide,
        slug: m.slug,
        entryPlacedAtMs: nowMs,
        secondsToExpiryAtEntry: secsToExpiry >= 0 ? secsToExpiry : 0,
        entryOrderId: res.orderId,
        intendedEntryPrice: params.config.entryPrice,
        intendedEntryUsd: params.config.usdPerTrade,
      });

      const immediateFill = parseImmediateEntryFill(res);
      if (immediateFill) {
        markEntryFilled(params.db, {
          marketId: m.id,
          orderSide,
          entryFilledAtMs: nowMs,
          entryPrice: immediateFill.entryPrice,
          shares: immediateFill.shares,
          entryUsd: immediateFill.entryUsd,
        });
        params.log.info(
          { market: m.slug, shares: immediateFill.shares, entryUsd: immediateFill.entryUsd },
          "entry filled immediately",
        );
      }

      const entryUsd = res.makingAmount ? Number(res.makingAmount) : params.config.usdPerTrade;
      const entryShares = res.takingAmount ? Number(res.takingAmount) : res.shares;
      recordTrade(params.db, {
        tradeKey: `bot:order:${res.orderId}`,
        marketId: m.id,
        slug: m.slug,
        action: "entry",
        side: "buy",
        tokenId: res.tokenId,
        price: res.price,
        shares: Number.isFinite(entryShares) ? entryShares : res.shares,
        usdAmount: Number.isFinite(entryUsd) ? entryUsd : params.config.usdPerTrade,
        orderId: res.orderId,
        status: res.status,
        makingAmount: res.makingAmount ?? null,
        takingAmount: res.takingAmount ?? null,
        source: "bot",
        rawJson: JSON.stringify({ ...res, orderSide }),
        createdAtMs: nowMs,
      });
    }
  }

  // Resolution bookkeeping (gas-free). Polymarket auto-redeems winning positions
  // on-chain for this account, so the bot sends NO redeem transactions. We only
  // record the resolved outcome locally for P&L. Idempotent across ticks: the
  // round close, market_state upsert, and trade row all no-op once applied.
  for (const pos of positions) {
    if (!pos.redeemable) continue;
    if (!pos.asset) continue;
    if (!positionMatchesOrderSide(params.db, pos.asset, orderSide)) continue;
    const m = findMarketByTokenId(params.db, pos.asset);
    if (!m) continue;

    const round = getTradeRound(params.db, m.market_id, orderSide);
    if (!round || round.exit_at_ms !== null) continue; // already closed or never entered

    const shares = pos.size ?? round.shares ?? 0;
    if (shares <= 0) continue;

    // Resolved price settles near $1 on the winning side and near $0 on the losing side.
    const won = (pos.curPrice ?? 0) >= 0.5;

    closeTradeRoundAtResolution(params.db, {
      marketId: m.market_id,
      orderSide,
      exitAtMs: nowMs,
      shares,
      won,
    });

    params.db
      .prepare(
        `
        INSERT INTO market_state (market_id, order_side, status, updated_at_ms)
        VALUES (@market_id, @order_side, 'redeemed', @updated_at_ms)
        ON CONFLICT(market_id, order_side) DO UPDATE SET
          status='redeemed',
          updated_at_ms=excluded.updated_at_ms
      `,
      )
      .run({ market_id: m.market_id, order_side: orderSide, updated_at_ms: nowMs });

    params.log.info(
      { market: m.slug, won, shares, orderSide },
      "trade resolved (auto-redeemed by Polymarket)",
    );

    recordTrade(params.db, {
      tradeKey: `bot:resolve:${m.market_id}:${orderSide}`,
      marketId: m.market_id,
      slug: m.slug,
      action: "redeem",
      side: null,
      tokenId: pos.asset,
      price: won ? 1 : 0,
      shares,
      usdAmount: won ? shares : 0,
      status: won ? "auto_redeemed_win" : "resolved_loss",
      source: "bot",
      createdAtMs: nowMs,
    });
  }

  if (shouldSyncTrades(params.db, nowMs, params.config.reconcileIntervalMs)) {
    try {
      const sync = await syncTradesFromDataApi({
        db: params.db,
        endpoints: params.endpoints,
        userAddress: params.depositWalletAddress,
        nowMs,
      });
      if (sync.inserted > 0) {
        params.log.info({ inserted: sync.inserted, fetched: sync.fetched }, "synced trades from Data API");
      }
    } catch (err) {
      params.log.warn({ err }, "failed to sync trades from Data API");
    }
  }
}

function upsertMarkets(db: Database.Database, markets: GammaMarket[], nowMs: number): void {
  const stmt = db.prepare(
    `
    INSERT INTO markets (
      market_id, slug, question, end_date, condition_id, neg_risk, tick_size, up_token_id, down_token_id,
      discovered_at_ms, last_seen_at_ms
    )
    VALUES (
      @market_id, @slug, @question, @end_date, @condition_id, @neg_risk, @tick_size, @up_token_id, @down_token_id,
      @discovered_at_ms, @last_seen_at_ms
    )
    ON CONFLICT(market_id) DO UPDATE SET
      slug=excluded.slug,
      question=excluded.question,
      end_date=excluded.end_date,
      condition_id=excluded.condition_id,
      neg_risk=excluded.neg_risk,
      tick_size=excluded.tick_size,
      up_token_id=excluded.up_token_id,
      down_token_id=excluded.down_token_id,
      last_seen_at_ms=excluded.last_seen_at_ms
  `,
  );

  const tx = db.transaction((rows: GammaMarket[]) => {
    for (const m of rows) {
      stmt.run({
        market_id: m.id,
        slug: m.slug,
        question: m.question,
        end_date: m.endDate,
        condition_id: m.conditionId,
        neg_risk: m.negRisk ? 1 : 0,
        tick_size: m.tickSize,
        up_token_id: m.upTokenId,
        down_token_id: m.downTokenId,
        discovered_at_ms: nowMs,
        last_seen_at_ms: nowMs,
      });
    }
  });
  tx(markets);
}

/**
 * A position still actively at risk: held shares in a market that has NOT yet
 * resolved. Resolved (`redeemable`) positions are excluded — a settled winner
 * awaits auto-redeem and a worthless loser ($0) lingers un-redeemed forever, so
 * neither should consume a concurrency slot.
 */
export function isActiveOpenPosition(pos: {
  size?: number | undefined;
  redeemable?: boolean | undefined;
}): boolean {
  return (pos.size ?? 0) > 0 && !pos.redeemable;
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

type MarketRow = {
  market_id: string;
  slug: string;
  question: string;
  end_date: string;
  condition_id: string;
  neg_risk: number;
  tick_size: "0.1" | "0.01" | "0.001" | "0.0001";
  up_token_id: string;
  down_token_id: string;
};

function findMarketByTokenId(db: Database.Database, tokenId: string): MarketRow | null {
  const row = db
    .prepare(
      `
      SELECT market_id, slug, question, end_date, condition_id, neg_risk, tick_size, up_token_id, down_token_id
      FROM markets
      WHERE up_token_id = ? OR down_token_id = ?
      LIMIT 1
    `,
    )
    .get(tokenId, tokenId) as MarketRow | undefined;
  return row ?? null;
}


