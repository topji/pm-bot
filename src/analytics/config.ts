import "dotenv/config";
import { z } from "zod";

const AnalyticsConfigSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  dbPath: z.string().default("./data/bot.sqlite"),
  analyticsHost: z.string().default("127.0.0.1"),
  analyticsPort: z.coerce.number().int().positive().default(8787),
  analyticsApiKey: z.string().min(1).optional(),
  analyticsCorsOrigin: z.string().default("*"),
});

export type AnalyticsConfig = z.infer<typeof AnalyticsConfigSchema>;

export function loadAnalyticsConfig(): AnalyticsConfig {
  const parsed = AnalyticsConfigSchema.safeParse({
    nodeEnv: process.env.NODE_ENV,
    dbPath: process.env.DB_PATH,
    analyticsHost: process.env.ANALYTICS_HOST,
    analyticsPort: process.env.ANALYTICS_PORT,
    analyticsApiKey: process.env.ANALYTICS_API_KEY,
    analyticsCorsOrigin: process.env.ANALYTICS_CORS_ORIGIN,
  });

  if (!parsed.success) {
    throw new Error(`Invalid analytics configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
