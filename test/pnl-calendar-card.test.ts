import { describe, expect, it } from "vitest";

import { renderPnlCalendarCard } from "../src/services/pnl-calendar-card.js";

describe("PnL calendar card", () => {
  it("renders a UTC realized-PnL calendar", async () => {
    const image = await renderPnlCalendarCard({
      year: 2026,
      month: 7,
      pnlUsd: 1_250_000n,
      closeCount: 2,
      winCount: 1,
      activeDays: 2,
      days: [
        { date: "2026-07-01", pnlUsd: 2_000_000n, closeCount: 1, winCount: 1 },
        { date: "2026-07-02", pnlUsd: -750_000n, closeCount: 1, winCount: 0 },
      ],
    }, new Date("2026-07-16T08:05:06Z"));

    expect(image.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(image.length).toBeGreaterThan(10_000);
  });
});
