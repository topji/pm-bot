import { z } from "zod";
import type { Endpoints } from "./endpoints.js";
import type { DataApiPosition } from "./types.js";

const DataApiPositionSchema = z.object({
  proxyWallet: z.string().optional(),
  asset: z.string().optional(),
  conditionId: z.string().optional(),
  size: z.number().optional(),
  avgPrice: z.number().optional(),
  curPrice: z.number().optional(),
  negativeRisk: z.boolean().optional(),
  redeemable: z.boolean().optional(),
});

const PositionsResponseSchema = z.object({
  positions: z.array(DataApiPositionSchema).optional(),
});

// Data API sometimes returns array directly; support both.
const PositionsAnySchema = z.union([z.array(DataApiPositionSchema), PositionsResponseSchema]);

export async function fetchPositionsForUser(
  endpoints: Endpoints,
  userAddress: string,
): Promise<DataApiPosition[]> {
  const url = new URL("/positions", endpoints.dataApiUrl);
  url.searchParams.set("user", userAddress);
  url.searchParams.set("limit", "100");
  url.searchParams.set("sizeThreshold", "0");
  url.searchParams.set("sortBy", "CURRENT");
  url.searchParams.set("sortDirection", "DESC");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Data API positions failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const parsed = PositionsAnySchema.safeParse(json);
  if (!parsed.success) throw new Error(`Data API positions parse failed: ${parsed.error.message}`);
  if (Array.isArray(parsed.data)) return parsed.data;
  return parsed.data.positions ?? [];
}

const DataApiTradeSchema = z
  .object({
    proxyWallet: z.string().optional(),
    side: z.string().optional(),
    asset: z.string().optional(),
    conditionId: z.string().optional(),
    size: z.number().optional(),
    price: z.number().optional(),
    timestamp: z.number().optional(),
    transactionHash: z.string().optional(),
    title: z.string().optional(),
    slug: z.string().optional(),
    outcome: z.string().optional(),
    orderId: z.string().optional(),
    id: z.string().optional(),
  })
  .passthrough();

export type DataApiTrade = z.infer<typeof DataApiTradeSchema>;

export async function fetchTradesForUser(
  endpoints: Endpoints,
  userAddress: string,
  opts?: { limit?: number; offset?: number },
): Promise<DataApiTrade[]> {
  const url = new URL("/trades", endpoints.dataApiUrl);
  url.searchParams.set("user", userAddress);
  url.searchParams.set("limit", String(opts?.limit ?? 100));
  url.searchParams.set("offset", String(opts?.offset ?? 0));

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Data API trades failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const parsed = z.array(DataApiTradeSchema).safeParse(json);
  if (!parsed.success) throw new Error(`Data API trades parse failed: ${parsed.error.message}`);
  return parsed.data;
}

