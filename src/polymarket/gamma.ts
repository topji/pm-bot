import { z } from "zod";
import type { Endpoints } from "./endpoints.js";
import { TickSizeSchema, type GammaMarket, type TickSize } from "./types.js";

const GammaMarketRawSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  slug: z.string(),
  question: z.string().default(""),
  active: z.boolean().default(true),
  closed: z.boolean().default(false),
  endDate: z.string(),
  negRisk: z.boolean().optional().default(false),
  conditionId: z.string().optional().default(""),
  outcomes: z.string().optional().default("[]"),
  outcomePrices: z.string().optional(),
  clobTokenIds: z.string().optional().default("[]"),
  orderPriceMinTickSize: z.union([z.string(), z.number()]).transform(String),
});

type GammaMarketRaw = z.infer<typeof GammaMarketRawSchema>;

const GammaEventLooseSchema = z.object({
  slug: z.string(),
  markets: z.array(z.unknown()).optional(),
});

function parseGammaMarketRaw(value: unknown): GammaMarketRaw | null {
  const parsed = GammaMarketRawSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function marketsFromEvent(event: z.infer<typeof GammaEventLooseSchema>): GammaMarketRaw[] {
  const rows: GammaMarketRaw[] = [];
  for (const market of event.markets ?? []) {
    const parsed = parseGammaMarketRaw(market);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

function parseJsonStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((v) => String(v));
}

export function mapGammaMarketToUpDown(raw: GammaMarketRaw): GammaMarket | null {
  const outcomes = parseJsonStringArray(raw.outcomes).map((s) => s.trim());
  const tokenIds = parseJsonStringArray(raw.clobTokenIds).map((s) => s.trim());
  if (outcomes.length !== tokenIds.length || outcomes.length < 2) return null;

  let upTokenId: string | undefined;
  let downTokenId: string | undefined;

  for (let i = 0; i < outcomes.length; i++) {
    const name = outcomes[i]?.toLowerCase();
    const tokenId = tokenIds[i];
    if (!name || !tokenId) continue;
    if (name === "up" || name === "yes") upTokenId = tokenId;
    if (name === "down" || name === "no") downTokenId = tokenId;
  }

  const tickSizeParsed = TickSizeSchema.safeParse(raw.orderPriceMinTickSize);
  if (!tickSizeParsed.success) return null;
  const tickSize: TickSize = tickSizeParsed.data;
  if (!upTokenId || !downTokenId) return null;
  if (!raw.conditionId) return null;
  return {
    id: raw.id,
    slug: raw.slug,
    question: raw.question,
    endDate: raw.endDate,
    active: raw.active,
    closed: raw.closed,
    negRisk: raw.negRisk,
    tickSize,
    conditionId: raw.conditionId,
    upTokenId,
    downTokenId,
  };
}

export async function fetchActiveMarkets(endpoints: Endpoints, limit = 200): Promise<GammaMarketRaw[]> {
  const url = new URL("/markets", endpoints.gammaBaseUrl);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma markets fetch failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (!Array.isArray(json)) return [];
  const rows: GammaMarketRaw[] = [];
  for (const item of json) {
    const parsed = parseGammaMarketRaw(item);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

export const BTC5M_WINDOW_SEC = 300;

/** Polymarket event slug: `btc-updown-5m-{windowStartUnix}` (window start, 5m-aligned). */
export function btc5mEventSlugFromWindowStart(windowStartSec: number): string {
  return `btc-updown-5m-${windowStartSec}`;
}

/** Unix seconds at the start of the current 5-minute BTC window. */
export function currentBtc5mWindowStartSec(nowMs = Date.now()): number {
  const nowSec = Math.floor(nowMs / 1000);
  return Math.floor(nowSec / BTC5M_WINDOW_SEC) * BTC5M_WINDOW_SEC;
}

/** Window starts to poll: previous, current, and upcoming 5m windows. */
export function btc5mWindowStartsAround(
  nowSec: number,
  opts?: { behind?: number; ahead?: number },
): number[] {
  const behind = opts?.behind ?? 1;
  const ahead = opts?.ahead ?? 1;
  const current = Math.floor(nowSec / BTC5M_WINDOW_SEC) * BTC5M_WINDOW_SEC;
  const starts: number[] = [];
  for (let i = -behind; i <= ahead; i++) {
    starts.push(current + i * BTC5M_WINDOW_SEC);
  }
  return starts;
}

async function fetchEventMarketsBySlug(
  endpoints: Endpoints,
  eventSlug: string,
): Promise<GammaMarketRaw[]> {
  const url = new URL("/events", endpoints.gammaBaseUrl);
  url.searchParams.set("slug", eventSlug);
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  const arr = z.array(GammaEventLooseSchema).safeParse(json);
  if (!arr.success || arr.data.length === 0) return [];
  const event = arr.data[0];
  if (!event || !isBtc5mUpDownSlug(event.slug)) return [];
  return marketsFromEvent(event);
}

/** Fetch the live rolling windows by slug (matches polymarket.com/event/btc-updown-5m-{ts}). */
export async function fetchBtc5mMarketsByComputedSlugs(
  endpoints: Endpoints,
  nowMs = Date.now(),
): Promise<GammaMarketRaw[]> {
  const nowSec = Math.floor(nowMs / 1000);
  const slugs = btc5mWindowStartsAround(nowSec).map(btc5mEventSlugFromWindowStart);
  const batches = await Promise.all(slugs.map((slug) => fetchEventMarketsBySlug(endpoints, slug)));
  return batches.flat();
}

export function isBtc5mUpDownSlug(slug: string): boolean {
  return /^btc-updown-5m-/i.test(slug);
}

export function isLikelyBtc5mMarket(m: GammaMarketRaw): boolean {
  if (isBtc5mUpDownSlug(m.slug)) return true;
  const text = `${m.slug} ${m.question}`.toLowerCase();
  if (!text.includes("btc") && !text.includes("bitcoin")) return false;
  // Heuristic: “5 minute”, “5-min”, “5m”
  if (/(5\s*min|5-minute|5m)/i.test(text)) return true;
  return false;
}

/** BTC 5m up/down markets are published as rolling events (`btc-updown-5m-*`), not in the flat /markets feed. */
export async function fetchBtc5mMarketsFromEvents(endpoints: Endpoints): Promise<GammaMarketRaw[]> {
  const url = new URL("/events", endpoints.gammaBaseUrl);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", "50");
  url.searchParams.set("order", "createdAt");
  url.searchParams.set("ascending", "false");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma events fetch failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const arr = z.array(GammaEventLooseSchema).safeParse(json);
  if (!arr.success) {
    throw new Error(`Gamma events parse failed: ${arr.error.message}`);
  }

  const raw: GammaMarketRaw[] = [];
  for (const event of arr.data) {
    if (!isBtc5mUpDownSlug(event.slug)) continue;
    raw.push(...marketsFromEvent(event));
  }
  return raw;
}

/**
 * Discover the active BTC 5m market(s) for the current clock window only.
 *
 * Slug format: `btc-updown-5m-{windowStartUnix}` where windowStartUnix is
 * floor(now/300)*300. We fetch previous + current + next window (3 Gamma calls)
 * so we can enter the live window and cancel orders on the one expiring soon.
 */
export async function discoverBtc5mUpDownMarkets(
  endpoints: Endpoints,
  nowMs = Date.now(),
): Promise<GammaMarket[]> {
  const raw = await fetchBtc5mMarketsByComputedSlugs(endpoints, nowMs);

  const mapped: GammaMarket[] = [];
  for (const r of raw) {
    const m = mapGammaMarketToUpDown(r);
    if (m && !m.closed) mapped.push(m);
  }
  return mapped;
}

