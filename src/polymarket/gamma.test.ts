import { describe, expect, it } from "vitest";

import {
  btc5mEventSlugFromWindowStart,
  btc5mWindowStartsAround,
  isBtc5mUpDownSlug,
  mapGammaMarketToUpDown,
} from "./gamma.js";

describe("btc5m slug helpers", () => {
  it("matches polymarket event slug pattern", () => {
    expect(isBtc5mUpDownSlug("btc-updown-5m-1782728100")).toBe(true);
    expect(btc5mEventSlugFromWindowStart(1782728100)).toBe("btc-updown-5m-1782728100");
  });

  it("aligns window starts to 5-minute boundaries", () => {
    const starts = btc5mWindowStartsAround(1782728100 + 120, { behind: 1, ahead: 1 });
    expect(starts).toEqual([1782727800, 1782728100, 1782728400]);
  });
});

describe("mapGammaMarketToUpDown", () => {
  it("accepts markets without outcomePrices from Gamma events API", () => {
    const market = mapGammaMarketToUpDown({
      id: "1",
      slug: "btc-updown-5m-1782728100",
      question: "BTC Up or Down",
      active: true,
      closed: false,
      endDate: "2026-06-29T12:05:00Z",
      negRisk: false,
      conditionId: "0x" + "a".repeat(64),
      outcomes: '["Up","Down"]',
      clobTokenIds: '["111","222"]',
      orderPriceMinTickSize: "0.01",
    });
    expect(market?.upTokenId).toBe("111");
    expect(market?.downTokenId).toBe("222");
  });
});
