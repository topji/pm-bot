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
});

