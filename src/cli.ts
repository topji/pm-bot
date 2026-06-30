import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { discoverBtc5mUpDownMarkets } from "./polymarket/gamma.js";
import { createBotWallets } from "./polymarket/wallets.js";
import { deriveDepositWalletForBot } from "./polymarket/wallets.js";
import { buildCtfRedeemCalldata } from "./polymarket/redeem.js";
import { runExitCheckOnce } from "./polymarket/stopMonitor.js";
import { loadOrCreateClobCreds, createDepositWalletClobClient } from "./polymarket/clob.js";

type Command = "scan" | "redeem-calldata" | "stop-test" | "derive-deposit-wallet";

function usage(): never {
  console.error(
    [
      "Usage:",
      "  npm run cli -- scan",
      "  npm run cli -- derive-deposit-wallet",
      "  npm run cli -- redeem-calldata <conditionIdBytes32>",
      "  npm run cli -- stop-test <tokenId> <shares> <tickSize> <negRisk:true|false>",
    ].join("\n"),
  );
  process.exit(2);
}

function parseBool(s: string): boolean {
  if (s === "true") return true;
  if (s === "false") return false;
  throw new Error(`Invalid boolean: ${s}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config);
  const endpoints = {
    gammaBaseUrl: config.gammaBaseUrl,
    clobHost: config.clobHost,
    dataApiUrl: config.dataApiUrl,
  };

  const [, , cmdRaw, ...args] = process.argv;
  const cmd = cmdRaw as Command | undefined;
  if (!cmd) usage();

  if (cmd === "scan") {
    const markets = await discoverBtc5mUpDownMarkets(endpoints);
    log.info({ count: markets.length }, "scan complete");
    for (const m of markets.slice(0, 10)) {
      console.log(
        JSON.stringify(
          {
            id: m.id,
            slug: m.slug,
            endDate: m.endDate,
            tickSize: m.tickSize,
            negRisk: m.negRisk,
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  if (cmd === "derive-deposit-wallet") {
    const wallets = createBotWallets(config.botPrivateKey as `0x${string}`, config.polygonRpcUrl);
    const addr = await deriveDepositWalletForBot(wallets);
    console.log(addr);
    return;
  }

  if (cmd === "redeem-calldata") {
    const [conditionId] = args;
    if (!conditionId) usage();
    const data = buildCtfRedeemCalldata({ conditionId: conditionId as `0x${string}` });
    console.log(data);
    return;
  }

  if (cmd === "stop-test") {
    const [tokenId, sharesStr, tickSize, negRiskStr] = args;
    if (!tokenId || !sharesStr || !tickSize || !negRiskStr) usage();
    const wallets = createBotWallets(config.botPrivateKey as `0x${string}`, config.polygonRpcUrl);
    const depositWallet =
      config.depositWalletAddress ?? (await deriveDepositWalletForBot(wallets));

    const shares = Number(sharesStr);
    if (!Number.isFinite(shares) || shares <= 0) throw new Error("shares must be positive number");
    const negRisk = parseBool(negRiskStr);

    const { walletClient } = wallets;
    const creds = await loadOrCreateClobCreds({
      endpoints,
      signer: walletClient,
      credsPath: "./data/clob-creds.json",
    });
    const clob = createDepositWalletClobClient({
      endpoints,
      signer: walletClient,
      creds,
      depositWalletAddress: depositWallet,
    });

    const out = await runExitCheckOnce(
      {
        endpoints,
        client: clob,
        tokenId,
        shares,
        tickSize: tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
        negRisk,
        stopPrice: config.stopPrice,
        takeProfitPrice: config.takeProfitPrice,
        pollMs: config.stopPollMs,
        maxExitRetries: 3,
      },
      Date.now(),
    );
    log.info({ out }, "exit-check result");
    return;
  }

  usage();
}

await main();

