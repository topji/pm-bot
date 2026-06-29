import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const TEST_KEY = "0x9dbde49b815ff26315ce8baa4faa633f3dfe3f71234adaf52de94f741e84275e";

describe("loadConfig", () => {
  it("fails when BOT_PRIVATE_KEY is missing", () => {
    const old = process.env.BOT_PRIVATE_KEY;
    delete process.env.BOT_PRIVATE_KEY;
    expect(() => loadConfig()).toThrow(/Invalid configuration/i);
    if (old) process.env.BOT_PRIVATE_KEY = old;
  });

  it("defaults USD_PER_TRADE to 1 and ORDER_SIDE to UP", () => {
    const oldKey = process.env.BOT_PRIVATE_KEY;
    const oldUsd = process.env.USD_PER_TRADE;
    const oldBudget = process.env.USD_BUDGET_PER_MARKET;
    const oldSide = process.env.ORDER_SIDE;

    process.env.BOT_PRIVATE_KEY = TEST_KEY;
    delete process.env.USD_PER_TRADE;
    delete process.env.USD_BUDGET_PER_MARKET;
    delete process.env.ORDER_SIDE;

    const cfg = loadConfig();
    expect(cfg.usdPerTrade).toBe(1);
    expect(cfg.orderSide).toBe("UP");

    if (oldKey) process.env.BOT_PRIVATE_KEY = oldKey;
    else delete process.env.BOT_PRIVATE_KEY;
    if (oldUsd) process.env.USD_PER_TRADE = oldUsd;
    else delete process.env.USD_PER_TRADE;
    if (oldBudget) process.env.USD_BUDGET_PER_MARKET = oldBudget;
    else delete process.env.USD_BUDGET_PER_MARKET;
    if (oldSide) process.env.ORDER_SIDE = oldSide;
    else delete process.env.ORDER_SIDE;
  });

  it("accepts ORDER_SIDE=down (case-insensitive)", () => {
    const oldKey = process.env.BOT_PRIVATE_KEY;
    const oldSide = process.env.ORDER_SIDE;

    process.env.BOT_PRIVATE_KEY = TEST_KEY;
    process.env.ORDER_SIDE = "down";

    expect(loadConfig().orderSide).toBe("DOWN");

    if (oldKey) process.env.BOT_PRIVATE_KEY = oldKey;
    else delete process.env.BOT_PRIVATE_KEY;
    if (oldSide) process.env.ORDER_SIDE = oldSide;
    else delete process.env.ORDER_SIDE;
  });
});

