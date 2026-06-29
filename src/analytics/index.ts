import pino from "pino";

import { loadAnalyticsConfig } from "./config.js";
import { startAnalyticsServer } from "./server.js";
import { openReadonlyDb } from "../state/db.js";

const config = loadAnalyticsConfig();
const log = pino({
  level: config.nodeEnv === "development" ? "debug" : "info",
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
});

const db = openReadonlyDb(config.dbPath);

const server = startAnalyticsServer({ config, db: db.db, log });

function shutdown(): void {
  log.info("analytics server shutting down");
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
