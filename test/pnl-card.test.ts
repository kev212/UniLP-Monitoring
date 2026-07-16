import { describe, expect, it } from "vitest";

import { renderPnlCard } from "../src/services/pnl-card.js";
import type { CloseHistoryRecord } from "../src/types.js";

const record: CloseHistoryRecord = {
  id: "history", positionId: "position", chainId: 4663, protocol: "v4", positionKey: "128754",
  token0: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", token1: "0x75c8258eaa6d0f94b82951194191ca3efb0bcbe2",
  quoteToken: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", finalPnlBps: 483n,
  finalPnlQuote: 2_903_561n, finalPnlUsd: 5_211_865n, trigger: "manual",
  closeTransactionHash: null, swapTransactionHash: null, settledAt: new Date("2026-07-14T11:55:21Z"), openedAtBlock: null, openedAt: null,
};

describe("PnL card", () => {
  it("renders protocol, fee tier, and quote-token detail values", async () => {
    const image = await renderPnlCard(record, "TOKEN/USDG", 6, "USDG", {
      depositsQuote: 100_000_000n,
      settlementQuote: 102_903_561n,
      feesQuote: 1_250_000n,
      feePips: 30_000,
    });

    expect(image.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(image.length).toBeGreaterThan(10_000);
  });
});
