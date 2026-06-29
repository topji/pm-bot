import { describe, expect, it } from "vitest";
import { buildCtfRedeemCalldata } from "./redeem.js";

describe("buildCtfRedeemCalldata", () => {
  it("produces calldata for a bytes32 conditionId", () => {
    const conditionId =
      "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
    const data = buildCtfRedeemCalldata({ conditionId });
    expect(data.startsWith("0x")).toBe(true);
    expect(data.length).toBeGreaterThan(10);
  });
});

