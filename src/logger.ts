import pino from "pino";
import type { BotConfig } from "./config.js";

export function createLogger(config: BotConfig): pino.Logger {
  return pino({
    level: config.nodeEnv === "development" ? "debug" : "info",
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

