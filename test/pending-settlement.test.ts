import { describe, expect, it } from "vitest";

import { hasPendingSettlement, hasPendingSwap } from "../src/services/pending-settlement.js";

describe("hasPendingSwap", () => {
  it("keeps burned LP positions recoverable while a swap is pending", () => {
    expect(hasPendingSwap({ pendingSwap: { token: "0x0000000000000000000000000000000000000001", amount: "1" } })).toBe(true);
  });

  it("does not treat cleared or malformed values as a pending swap", () => {
    expect(hasPendingSwap({ pendingSwap: null })).toBe(false);
    expect(hasPendingSwap({ pendingSwap: "pending" })).toBe(false);
  });

  it("keeps a closing position pending before the post-close swap is recorded", () => {
    expect(hasPendingSettlement("closing", { pendingSwap: null })).toBe(true);
    expect(hasPendingSettlement("armed", { pendingSwap: null })).toBe(false);
  });
});
