import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),

  // Core wallet
  botPrivateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),

  // Polymarket endpoints (headless should use direct URLs)
  gammaBaseUrl: z.string().url().default("https://gamma-api.polymarket.com"),
  clobHost: z.string().url().default("https://clob.polymarket.com"),
  dataApiUrl: z.string().url().default("https://data-api.polymarket.com"),

  // Derived wallet addresses (required for real trading; can be stubbed in tests)
  safeAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  depositWalletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),

  // Execution settings
  usdPerTrade: z.coerce.number().positive().default(1),
  orderSide: z
    .preprocess((v) => (typeof v === "string" ? v.toUpperCase() : v), z.enum(["UP", "DOWN"]))
    .default("UP"),
  maxConcurrentPositions: z.coerce.number().int().positive().default(2),
  maxTotalUsdExposure: z.coerce.number().positive().default(100),
  maxDailyLossUsd: z.coerce.number().positive().default(100),

  scanIntervalMs: z.coerce.number().int().positive().default(5_000),
  reconcileIntervalMs: z.coerce.number().int().positive().default(15_000),

  // Stop monitor — polls best bid while positions are open (default 1s)
  stopPollMs: z.coerce.number().int().positive().default(1_000),

  dbPath: z.string().default("./data/bot.sqlite"),

  // Polygon RPC for on-chain reads/writes used by redeem.
  polygonRpcUrl: z.string().url().optional(),

  // Ops
  killSwitch: z.coerce.boolean().default(false),
});

export type BotConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): BotConfig {
  const parsed = ConfigSchema.safeParse({
    nodeEnv: process.env.NODE_ENV,
    botPrivateKey: process.env.BOT_PRIVATE_KEY,
    gammaBaseUrl: process.env.GAMMA_BASE_URL,
    clobHost: process.env.CLOB_HOST,
    dataApiUrl: process.env.DATA_API_URL,
    safeAddress: process.env.SAFE_ADDRESS,
    depositWalletAddress: process.env.DEPOSIT_WALLET_ADDRESS,
    usdPerTrade: process.env.USD_PER_TRADE ?? process.env.USD_BUDGET_PER_MARKET,
    orderSide: process.env.ORDER_SIDE,
    maxConcurrentPositions: process.env.MAX_CONCURRENT_POSITIONS,
    maxTotalUsdExposure: process.env.MAX_TOTAL_USD_EXPOSURE,
    maxDailyLossUsd: process.env.MAX_DAILY_LOSS_USD,
    scanIntervalMs: process.env.SCAN_INTERVAL_MS,
    reconcileIntervalMs: process.env.RECONCILE_INTERVAL_MS,
    stopPollMs: process.env.STOP_POLL_MS,
    dbPath: process.env.DB_PATH,
    polygonRpcUrl: process.env.POLYGON_RPC_URL,
    killSwitch: process.env.KILL_SWITCH,
  });

  if (!parsed.success) {
    // Keep the thrown object stable and readable.
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

