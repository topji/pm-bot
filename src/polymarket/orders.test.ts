import { describe, expect, it } from "vitest";
import { canPlaceEntryNow } from "./orders.js";

describe("canPlaceEntryNow", () => {
  it("rejects too early", () => {
    const now = Date.now();
    const end = new Date(now + 400_000).toISOString();
    expect(canPlaceEntryNow({ endDateIso: end, nowMs: now })).toEqual({
      allowed: false,
      reason: "too_early",
    });
  });

  it("rejects too close to expiry", () => {
    const now = Date.now();
    const end = new Date(now + 20_000).toISOString();
    expect(canPlaceEntryNow({ endDateIso: end, nowMs: now })).toEqual({
      allowed: false,
      reason: "too_close_to_expiry",
    });
  });

  it("allows inside the 30-290s window", () => {
    const now = Date.now();
    const end = new Date(now + 120_000).toISOString();
    const out = canPlaceEntryNow({ endDateIso: end, nowMs: now });
    expect(out.allowed).toBe(true);
    if (out.allowed) expect(out.secondsToExpiry).toBeGreaterThanOrEqual(30);
  });
});

