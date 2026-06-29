import type Database from "better-sqlite3";

import type { Endpoints } from "./endpoints.js";
import { fetchTradesForUser, type DataApiTrade } from "./dataApi.js";
import { recordTrade } from "../state/trades.js";
import { applyDataApiFillToTradeRound } from "../state/tradeRounds.js";

function tradeKeyFromDataApiTrade(t: DataApiTrade): string {
  if (t.transactionHash) return `data_api:tx:${t.transactionHash}`;
  if (t.orderId) return `data_api:order:${t.orderId}`;
  if (t.id) return `data_api:id:${t.id}`;
  const parts = [t.asset ?? "", t.side ?? "", String(t.timestamp ?? ""), String(t.size ?? "")];
  return `data_api:composite:${parts.join(":")}`;
}

function normalizeSide(side: string | undefined): "buy" | "sell" | null {
  const s = side?.toLowerCase();
  if (s === "buy") return "buy";
  if (s === "sell") return "sell";
  return null;
}

export async function syncTradesFromDataApi(params: {
  db: Database.Database;
  endpoints: Endpoints;
  userAddress: string;
  nowMs: number;
  limitPerPage?: number;
  maxPages?: number;
}): Promise<{ inserted: number; fetched: number }> {
  const limit = params.limitPerPage ?? 100;
  const maxPages = params.maxPages ?? 5;
  let inserted = 0;
  let fetched = 0;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;
    const batch = await fetchTradesForUser(params.endpoints, params.userAddress, { limit, offset });
    if (batch.length === 0) break;
    fetched += batch.length;

    for (const raw of batch) {
      const t = raw;

      const shares = t.size ?? null;
      const price = t.price ?? null;
      const usdAmount =
        shares !== null && price !== null && Number.isFinite(shares) && Number.isFinite(price)
          ? shares * price
          : null;

      const createdAtMs =
        typeof t.timestamp === "number" && Number.isFinite(t.timestamp)
          ? t.timestamp > 1_000_000_000_000
            ? Math.floor(t.timestamp)
            : Math.floor(t.timestamp * 1000)
          : params.nowMs;

      const didInsert = recordTrade(params.db, {
        tradeKey: tradeKeyFromDataApiTrade(t),
        slug: t.slug ?? null,
        action: "fill",
        side: normalizeSide(t.side),
        tokenId: t.asset ?? null,
        price,
        shares,
        usdAmount,
        orderId: t.orderId ?? null,
        txHash: t.transactionHash ?? null,
        status: "filled",
        source: "data_api",
        rawJson: JSON.stringify(t),
        createdAtMs,
      });
      if (didInsert) inserted += 1;

      applyDataApiFillToTradeRound(params.db, {
        orderId: t.orderId,
        side: t.side,
        price,
        shares,
        nowMs: createdAtMs,
      });
    }

    if (batch.length < limit) break;
  }

  params.db
    .prepare(
      `
      INSERT INTO checkpoints (key, value, updated_at_ms)
      VALUES ('last_trades_sync_ms', @value, @updated_at_ms)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at_ms=excluded.updated_at_ms
    `,
    )
    .run({ value: String(params.nowMs), updated_at_ms: params.nowMs });

  return { inserted, fetched };
}

export function shouldSyncTrades(db: Database.Database, nowMs: number, intervalMs: number): boolean {
  const row = db
    .prepare(`SELECT value FROM checkpoints WHERE key = 'last_trades_sync_ms'`)
    .get() as { value: string } | undefined;
  if (!row) return true;
  const last = Number(row.value);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= intervalMs;
}
