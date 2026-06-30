import { describe, expect, it } from "vitest";

import { isActiveOpenPosition } from "./bot.js";

describe("isActiveOpenPosition", () => {
  it("counts a live held position (shares, not yet resolved)", () => {
    expect(isActiveOpenPosition({ size: 6.06, redeemable: false })).toBe(true);
  });

  it("excludes a resolved/redeemable position so it cannot block new entries", () => {
    // The wedge bug: a losing position resolves to $0, is never auto-redeemed,
    // and lingers with size > 0. It must NOT count toward the concurrency cap.
    expect(isActiveOpenPosition({ size: 6.1, redeemable: true })).toBe(false);
    // Same for a winning-but-not-yet-redeemed position.
    expect(isActiveOpenPosition({ size: 6.06, redeemable: true })).toBe(false);
  });

  it("excludes empty / zero-size positions", () => {
    expect(isActiveOpenPosition({ size: 0, redeemable: false })).toBe(false);
    expect(isActiveOpenPosition({})).toBe(false);
  });
});
