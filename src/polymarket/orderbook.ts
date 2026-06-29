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
  if (!res.ok) throw new Error(`CLOB book failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const parsed = OrderBookSchema.safeParse(json);
  if (!parsed.success) throw new Error(`CLOB book parse failed: ${parsed.error.message}`);
  return parsed.data;
}

export function bestBidPrice(book: OrderBookSummary): number {
  const bid = book.bids?.[0]?.price;
  const n = bid ? Number(bid) : 0;
  return Number.isFinite(n) ? n : 0;
}

