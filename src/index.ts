import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { openDb } from "./state/db.js";
import { runBot } from "./bot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config);

  log.info(
    {
      env: config.nodeEnv,
    },
    "pm-bot starting",
  );

  const db = openDb(config.dbPath);
  try {
    await runBot({ config, log, db: db.db });
  } finally {
    db.close();
  }
}

await main();

