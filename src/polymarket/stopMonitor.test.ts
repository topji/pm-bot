import { describe, expect, it, vi } from "vitest";
import type { ClobClient } from "@polymarket/clob-client-v2";

import { runExitCheckOnce } from "./stopMonitor.js";

const endpoints = { gammaBaseUrl: "https://x", clobHost: "https://x", dataApiUrl: "https://x" };

function baseCfg(client: ClobClient, shares = 6) {
  return {
    endpoints,
    client,
    tokenId: "123",
    shares,
    tickSize: "0.01" as const,
    negRisk: false,
    stopPrice: 0.15,
    takeProfitPrice: 0.98,
    pollMs: 500,
    maxExitRetries: 1,
  };
}

function mockBook(bids: { price: string; size: string }[]) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ bids, asks: [] }), { status: 200 }));
}

describe("runExitCheckOnce", () => {
  it("does not trigger when best bid is between the stop and take-profit thresholds", async () => {
    const fetchMock = mockBook([{ price: "0.20", size: "10" }]);
    const createAndPostMarketOrder = vi.fn();
    const client = { createAndPostMarketOrder } as unknown as ClobClient;

    const out = await runExitCheckOnce(baseCfg(client, 10), Date.now());

    expect(out).toEqual({ status: "not_triggered" });
    expect(createAndPostMarketOrder).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("does not trigger when a lowball bid sits below a healthy best bid", async () => {
    // Polymarket bids are ascending: a 0.02 lowball is bids[0], real best is 0.33.
    const fetchMock = mockBook([
      { price: "0.02", size: "5" },
      { price: "0.33", size: "200" },
    ]);
    const createAndPostMarketOrder = vi.fn();
    const client = { createAndPostMarketOrder } as unknown as ClobClient;

    const out = await runExitCheckOnce(baseCfg(client), Date.now());

    expect(out).toEqual({ status: "not_triggered" });
    expect(createAndPostMarketOrder).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("stops out and reports the realized fill price, not the protective limit cap", async () => {
    // Best bid 0.14 -> stop triggers. FAK fills 6 shares for 0.84 USDC (0.14/share).
    const fetchMock = mockBook([{ price: "0.14", size: "100" }]);
    const client = {
      createAndPostMarketOrder: vi
        .fn()
        .mockResolvedValue({ orderID: "stop-1", makingAmount: "6", takingAmount: "0.84" }),
    } as unknown as ClobClient;

    const out = await runExitCheckOnce(baseCfg(client), Date.now());

    expect(out.status).toBe("exited");
    if (out.status === "exited") {
      expect(out.trigger).toBe("stop");
      expect(out.exitPrice).toBeCloseTo(0.14, 6);
    }
    fetchMock.mockRestore();
  });

  it("takes profit when best bid reaches the take-profit threshold", async () => {
    // Best bid 0.99 (>= 0.98) -> take profit. FAK fills 6 shares for 5.94 USDC.
    const fetchMock = mockBook([{ price: "0.99", size: "100" }]);
    const client = {
      createAndPostMarketOrder: vi
        .fn()
        .mockResolvedValue({ orderID: "tp-1", makingAmount: "6", takingAmount: "5.94" }),
    } as unknown as ClobClient;

    const out = await runExitCheckOnce(baseCfg(client), Date.now());

    expect(out.status).toBe("exited");
    if (out.status === "exited") {
      expect(out.trigger).toBe("take_profit");
      expect(out.exitPrice).toBeCloseTo(0.99, 6);
    }
    fetchMock.mockRestore();
  });

  it("does not take profit just below the threshold (0.97 < 0.98)", async () => {
    const fetchMock = mockBook([{ price: "0.97", size: "100" }]);
    const createAndPostMarketOrder = vi.fn();
    const client = { createAndPostMarketOrder } as unknown as ClobClient;

    const out = await runExitCheckOnce(baseCfg(client), Date.now());

    expect(out).toEqual({ status: "not_triggered" });
    expect(createAndPostMarketOrder).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});
