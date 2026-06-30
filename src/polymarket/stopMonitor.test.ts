import { describe, expect, it, vi } from "vitest";
import type { ClobClient } from "@polymarket/clob-client-v2";

import { runStopLossModeAOnce } from "./stopMonitor.js";

describe("runStopLossModeAOnce", () => {
  it("does not trigger when best bid above stop", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ bids: [{ price: "0.20", size: "10" }], asks: [] }), {
        status: 200,
      }),
    );

    const client = {
      createAndPostMarketOrder: vi.fn(),
    } as unknown as ClobClient;

    const out = await runStopLossModeAOnce(
      {
        endpoints: { gammaBaseUrl: "https://x", clobHost: "https://x", dataApiUrl: "https://x" },
        client,
        tokenId: "123",
        shares: 10,
        tickSize: "0.01",
        negRisk: false,
        stopPrice: 0.15,
        pollMs: 500,
        maxExitRetries: 1,
      },
      Date.now(),
    );

    expect(out).toEqual({ status: "not_triggered" });
    fetchMock.mockRestore();
  });

  it("does not trigger when a lowball bid sits below a healthy best bid", async () => {
    // Polymarket bids are ascending: a 0.02 lowball is bids[0], real best is 0.33.
    // The stop must read the best bid (0.33) and NOT fire.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          bids: [
            { price: "0.02", size: "5" },
            { price: "0.33", size: "200" },
          ],
          asks: [],
        }),
        { status: 200 },
      ),
    );

    const createAndPostMarketOrder = vi.fn();
    const client = { createAndPostMarketOrder } as unknown as ClobClient;

    const out = await runStopLossModeAOnce(
      {
        endpoints: { gammaBaseUrl: "https://x", clobHost: "https://x", dataApiUrl: "https://x" },
        client,
        tokenId: "123",
        shares: 6,
        tickSize: "0.01",
        negRisk: false,
        stopPrice: 0.15,
        pollMs: 500,
        maxExitRetries: 1,
      },
      Date.now(),
    );

    expect(out).toEqual({ status: "not_triggered" });
    expect(createAndPostMarketOrder).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("reports the realized fill price, not the protective limit cap", async () => {
    // Best bid 0.14 -> stop triggers. FAK sweeps and fills 6 shares for 0.84 USDC
    // (0.14/share), well above limitPrice (~tick). exitPrice must reflect 0.14.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ bids: [{ price: "0.14", size: "100" }], asks: [] }), {
        status: 200,
      }),
    );

    const client = {
      createAndPostMarketOrder: vi.fn().mockResolvedValue({
        orderID: "stop-1",
        makingAmount: "6",
        takingAmount: "0.84",
      }),
    } as unknown as ClobClient;

    const out = await runStopLossModeAOnce(
      {
        endpoints: { gammaBaseUrl: "https://x", clobHost: "https://x", dataApiUrl: "https://x" },
        client,
        tokenId: "123",
        shares: 6,
        tickSize: "0.01",
        negRisk: false,
        stopPrice: 0.15,
        pollMs: 500,
        maxExitRetries: 1,
      },
      Date.now(),
    );

    expect(out.status).toBe("stopped");
    if (out.status === "stopped") {
      expect(out.exitPrice).toBeCloseTo(0.14, 6);
    }
    fetchMock.mockRestore();
  });
});

