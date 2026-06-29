import { describe, expect, it } from "vitest";

import { bestAskPrice, bestBidPrice } from "./orderbook.js";

describe("bestBidPrice", () => {
  it("returns the highest bid when bids are sorted ascending (Polymarket order)", () => {
    // Polymarket /book returns bids low -> high; bids[0] is the WORST bid.
    const book = {
      bids: [
        { price: "0.18", size: "440" },
        { price: "0.30", size: "120" },
        { price: "0.43", size: "320" },
      ],
      asks: [],
    };
    expect(bestBidPrice(book)).toBe(0.43);
  });

  it("ignores a lowball bid that would falsely trip a 15c stop", () => {
    // Real best bid is 0.33; a 0.02 lowball sits at bids[0]. The old code read
    // bids[0] (0.02) and dumped the position. Best bid must be 0.33.
    const book = {
      bids: [
        { price: "0.02", size: "5" },
        { price: "0.33", size: "200" },
      ],
      asks: [],
    };
    expect(bestBidPrice(book)).toBe(0.33);
  });

  it("returns 0 for an empty or missing book", () => {
    expect(bestBidPrice({ bids: [], asks: [] })).toBe(0);
    expect(bestBidPrice({})).toBe(0);
  });
});

describe("bestAskPrice", () => {
  it("returns the lowest ask when asks are sorted descending (Polymarket order)", () => {
    const book = {
      bids: [],
      asks: [
        { price: "0.80", size: "120" },
        { price: "0.60", size: "440" },
        { price: "0.48", size: "15" },
      ],
    };
    expect(bestAskPrice(book)).toBe(0.48);
  });

  it("returns 0 for an empty or missing book", () => {
    expect(bestAskPrice({ bids: [], asks: [] })).toBe(0);
    expect(bestAskPrice({})).toBe(0);
  });
});
