import { describe, expect, it } from "vitest";

import {
  btc5mEventSlugFromWindowStart,
  btc5mWindowStartsAround,
  isBtc5mUpDownSlug,
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
