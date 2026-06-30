import { z } from "zod";
import type { Endpoints } from "./endpoints.js";

const BookLevelSchema = z.object({
  price: z.string(),
  size: z.string(),
});

const OrderBookSchema = z.object({
  bids: z.array(BookLevelSchema).optional(),
  asks: z.array(BookLevelSchema).optional(),
});

export type OrderBookSummary = z.infer<typeof OrderBookSchema>;

export async function fetchOrderBook(endpoints: Endpoints, tokenId: string): Promise<OrderBookSummary> {
  const url = new URL("/book", endpoints.clobHost);
  url.searchParams.set("token_id", tokenId);
  const res = await fetch(url);
  if (res.status === 404) {
    // No book exists for this token — typically a resolved/closed market.
    // Return an empty book so callers see "no bid" rather than throwing on
    // every poll (the stop monitor then treats it as not-triggered).
    return { bids: [], asks: [] };
  }
  if (!res.ok) throw new Error(`CLOB book failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const parsed = OrderBookSchema.safeParse(json);
  if (!parsed.success) throw new Error(`CLOB book parse failed: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * Best (highest) bid — the price we can actually sell into right now.
 *
 * Polymarket's /book returns bids sorted ASCENDING, so the best bid is the
 * LAST element, not bids[0]. We take the max across all levels to stay correct
 * regardless of ordering. Returns 0 when the book has no bids.
 */
export function bestBidPrice(book: OrderBookSummary): number {
  const prices = (book.bids ?? [])
    .map((level) => Number(level.price))
    .filter((n) => Number.isFinite(n) && n > 0);
  return prices.length ? Math.max(...prices) : 0;
}

/**
 * Best (lowest) ask — the price we'd pay to buy right now.
 *
 * Polymarket's /book returns asks sorted DESCENDING, so the best ask is the
 * LAST element. We take the min across all levels to stay correct regardless
 * of ordering. Returns 0 when the book has no asks.
 */
export function bestAskPrice(book: OrderBookSummary): number {
  const prices = (book.asks ?? [])
    .map((level) => Number(level.price))
    .filter((n) => Number.isFinite(n) && n > 0);
  return prices.length ? Math.min(...prices) : 0;
}

