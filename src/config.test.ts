import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

// Dummy key for unit tests only — never use for real funds.
const TEST_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";

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

  it("defaults exit thresholds to stop 0.15 / take-profit 0.98", () => {
    const oldKey = process.env.BOT_PRIVATE_KEY;
    const oldStop = process.env.STOP_LOSS_PRICE;
    const oldTp = process.env.TAKE_PROFIT_PRICE;

    process.env.BOT_PRIVATE_KEY = TEST_KEY;
    delete process.env.STOP_LOSS_PRICE;
    delete process.env.TAKE_PROFIT_PRICE;

    const cfg = loadConfig();
    expect(cfg.stopPrice).toBe(0.15);
    expect(cfg.takeProfitPrice).toBe(0.98);

    if (oldKey) process.env.BOT_PRIVATE_KEY = oldKey;
    else delete process.env.BOT_PRIVATE_KEY;
    if (oldStop) process.env.STOP_LOSS_PRICE = oldStop;
    if (oldTp) process.env.TAKE_PROFIT_PRICE = oldTp;
  });

  it("rejects a take-profit price that is not above the stop price", () => {
    const oldKey = process.env.BOT_PRIVATE_KEY;
    const oldStop = process.env.STOP_LOSS_PRICE;
    const oldTp = process.env.TAKE_PROFIT_PRICE;

    process.env.BOT_PRIVATE_KEY = TEST_KEY;
    process.env.STOP_LOSS_PRICE = "0.15";
    process.env.TAKE_PROFIT_PRICE = "0.10"; // below the stop — invalid

    expect(() => loadConfig()).toThrow(/Invalid configuration/i);

    if (oldKey) process.env.BOT_PRIVATE_KEY = oldKey;
    else delete process.env.BOT_PRIVATE_KEY;
    if (oldStop) process.env.STOP_LOSS_PRICE = oldStop;
    else delete process.env.STOP_LOSS_PRICE;
    if (oldTp) process.env.TAKE_PROFIT_PRICE = oldTp;
    else delete process.env.TAKE_PROFIT_PRICE;
  });

  it("parses KILL_SWITCH=false as false (not Zod coerce truthy string)", () => {
    const oldKey = process.env.BOT_PRIVATE_KEY;
    const oldKill = process.env.KILL_SWITCH;

    process.env.BOT_PRIVATE_KEY = TEST_KEY;
    process.env.KILL_SWITCH = "false";

    expect(loadConfig().killSwitch).toBe(false);

    if (oldKey) process.env.BOT_PRIVATE_KEY = oldKey;
    else delete process.env.BOT_PRIVATE_KEY;
    if (oldKill) process.env.KILL_SWITCH = oldKill;
    else delete process.env.KILL_SWITCH;
  });
});

