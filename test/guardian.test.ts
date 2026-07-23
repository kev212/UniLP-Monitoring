import { describe, expect, it, vi } from "vitest";

import { Guardian, shouldResumeExitRetry, shouldWaitForExitRetry } from "../src/services/guardian.js";
import { quoteRangeState } from "../src/services/quote-range.js";
import { sqrtRatioAtTick } from "../src/services/uniswap-math.js";
import type { RuntimeConfig } from "../src/config.js";
import type { PositionRecord } from "../src/types.js";

describe("quote-oriented range triggers", () => {
  const range = (status: "in_range" | "above" | "below", currentTick: number) => ({
    status,
    tickLower: 0,
    tickUpper: 100,
    currentTick,
    currentSqrtPrice: sqrtRatioAtTick(currentTick),
  });

  it.each(["USDG", "ETH", "WETH"])("maps raw above to quote below when %s is token0", () => {
    const value = range("above", 200);
    const state = quoteRangeState(value, true)!;
    expect(state.status).toBe("below");
    expect(state.belowDistanceBps).toBeGreaterThan(0n);
    expect(state.aboveDistanceBps).toBe(0n);
  });

  it.each(["USDG", "ETH", "WETH"])("maps raw below to quote below when %s is token1", () => {
    const value = range("below", -100);
    const state = quoteRangeState(value, false)!;
    expect(state.status).toBe("below");
    expect(state.belowDistanceBps).toBeGreaterThan(0n);
    expect(state.aboveDistanceBps).toBe(0n);
  });

  it.each(["USDG", "ETH", "WETH"])("maps raw above to quote above when %s is token1", () => {
    const value = { ...range("above", 200), aboveDistanceBps: 1_200n };
    const state = quoteRangeState(value, false)!;
    expect(state.status).toBe("above");
    expect(state.aboveDistanceBps).toBe(1_200n);
    expect(state.belowDistanceBps).toBe(0n);
  });

  it("maps raw below to quote above when the quote is token0", () => {
    const value = range("below", -100);
    const state = quoteRangeState(value, true)!;
    expect(state.status).toBe("above");
    expect(state.aboveDistanceBps).toBeGreaterThan(0n);
  });
});

describe("profit + OOR above timer", () => {
  const config = {
    trailingStopActivationPercent: 5,
    profitOorAboveThresholdPercent: 3,
    slTwapGuardMaxWaitMs: 15_000,
    oorAboveProfitDurationMs: 300_000,
    oorAutoCloseEnabled: true,
    oorAboveMinDistancePercent: 10,
    oorAboveMinDurationMs: 300_000,
  } as RuntimeConfig;

  function makeGuardian(): Guardian {
    const database = {
      setPositionStatus: vi.fn().mockResolvedValue(undefined),
    };
    return new Guardian(config, database as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  }

  const position = {
    id: "position",
    chainId: 4663,
    protocol: "v4" as const,
    positionKey: "1",
    owner: "0x0000000000000000000000000000000000000001",
    poolAddress: null,
    token0: "0x0000000000000000000000000000000000000000",
    token1: "0x0000000000000000000000000000000000000002",
    quoteToken: "0x0000000000000000000000000000000000000002",
    status: "armed" as const,
    liquidity: null,
    openedAtBlock: null,
    metadata: {},
  } satisfies PositionRecord;

  const aboveRange = {
    tickLower: 0,
    tickUpper: 100,
    currentTick: 200,
    currentSqrtPrice: sqrtRatioAtTick(200),
    status: "above" as const,
    aboveDistanceBps: 500n,
  };

  it("starts the timer when above range and PnL reaches the dedicated 3% threshold", async () => {
    const guardian = makeGuardian();
    await (guardian as unknown as {
      updateProfitOorAboveTimer(position: PositionRecord, range: unknown, pnlBps: bigint): Promise<void>;
    }).updateProfitOorAboveTimer(position, aboveRange, 600n);

    const db = (guardian as unknown as { database: { setPositionStatus: ReturnType<typeof vi.fn> } }).database;
    expect(db.setPositionStatus).toHaveBeenCalledWith("position", "armed", expect.objectContaining({ profitOorAboveSeenAt: expect.any(Number) }));
  });

  it("resets the timer when PnL drops below the dedicated threshold", async () => {
    const guardian = makeGuardian();
    await (guardian as unknown as {
      updateProfitOorAboveTimer(position: PositionRecord, range: unknown, pnlBps: bigint): Promise<void>;
    }).updateProfitOorAboveTimer({ ...position, metadata: { profitOorAboveSeenAt: Date.now() - 10_000 } }, aboveRange, 299n);

    const db = (guardian as unknown as { database: { setPositionStatus: ReturnType<typeof vi.fn> } }).database;
    expect(db.setPositionStatus).toHaveBeenCalledWith("position", "armed", expect.objectContaining({ profitOorAboveSeenAt: null }));
  });

  it("does not use the trailing-stop activation threshold", async () => {
    const guardian = makeGuardian();
    await (guardian as unknown as {
      updateProfitOorAboveTimer(position: PositionRecord, range: unknown, pnlBps: bigint): Promise<void>;
    }).updateProfitOorAboveTimer(position, aboveRange, 300n);

    const db = (guardian as unknown as { database: { setPositionStatus: ReturnType<typeof vi.fn> } }).database;
    expect(db.setPositionStatus).toHaveBeenCalledWith("position", "armed", expect.objectContaining({ profitOorAboveSeenAt: expect.any(Number) }));
  });

  it("keeps stop-loss eligible when a previous exit retry is still backing off", () => {
    const now = Date.now();
    expect(shouldWaitForExitRetry("trailing_take_profit", now + 60_000, now)).toBe(true);
    expect(shouldWaitForExitRetry("stop_loss", now + 60_000, now)).toBe(false);
  });

  it("fires the trigger only while live range and PnL remain eligible after the duration", async () => {
    const guardian = makeGuardian();
    const update = (guardian as unknown as {
      updateProfitOorAboveTimer(position: PositionRecord, range: unknown, pnlBps: bigint): Promise<string | null>;
    }).updateProfitOorAboveTimer.bind(guardian);

    await expect(update({ ...position, metadata: { profitOorAboveSeenAt: Date.now() - 60_000 } }, aboveRange, 600n)).resolves.toBeNull();
    await expect(update({ ...position, metadata: { profitOorAboveSeenAt: Date.now() - 300_000 } }, aboveRange, 600n)).resolves.toBe("profit_oor_above");
  });

  it("resets stale OOR metadata without returning a trigger when live price is in range", async () => {
    const guardian = makeGuardian();
    const update = (guardian as unknown as {
      updateOorAboveTimer(position: PositionRecord, range: unknown): Promise<string | null>;
    }).updateOorAboveTimer.bind(guardian);
    const inRange = { ...aboveRange, status: "in_range" as const, currentTick: 50, currentSqrtPrice: sqrtRatioAtTick(50), aboveDistanceBps: 0n };

    await expect(update({ ...position, metadata: { oorAboveSeenAt: Date.now() - 1_000_000 } }, inRange)).resolves.toBeNull();
    const db = (guardian as unknown as { database: { setPositionStatus: ReturnType<typeof vi.fn> } }).database;
    expect(db.setPositionStatus).toHaveBeenCalledWith("position", "armed", expect.objectContaining({ oorAboveSeenAt: null }));
  });

  it("does not resume dynamic retries after their live trigger disappears", () => {
    expect(shouldResumeExitRetry("out_of_range_above")).toBe(false);
    expect(shouldResumeExitRetry("profit_oor_above")).toBe(false);
    expect(shouldResumeExitRetry("trailing_take_profit")).toBe(false);
    expect(shouldResumeExitRetry("stop_loss")).toBe(true);
    expect(shouldResumeExitRetry("take_profit")).toBe(true);
    expect(shouldResumeExitRetry("manual")).toBe(true);
  });
});

describe("pending settlement status recovery", () => {
  const pendingPosition = {
    id: "pending-position",
    chainId: 4663,
    protocol: "v3" as const,
    positionKey: "305936",
    owner: "0x0000000000000000000000000000000000000001",
    poolAddress: "0x0000000000000000000000000000000000000003",
    token0: "0x0000000000000000000000000000000000000002",
    token1: "0x0000000000000000000000000000000000000004",
    quoteToken: "0x0000000000000000000000000000000000000002",
    status: "syncing" as const,
    liquidity: null,
    openedAtBlock: 1n,
    metadata: {
      pendingSwap: { token: "0x0000000000000000000000000000000000000004", amount: "5" },
      settlementRetryDisabled: true,
    },
  } satisfies PositionRecord;

  it("returns a disabled pending settlement to needs review without reading the burned NFT", async () => {
    const database = { setPositionStatusUnlessSettled: vi.fn().mockResolvedValue(true) };
    const guardian = new Guardian({} as RuntimeConfig, database as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);

    const result = await (guardian as unknown as {
      evaluatePosition(name: "robinhood", position: PositionRecord, blockNumber: bigint): Promise<boolean>;
    }).evaluatePosition("robinhood", pendingPosition, 10n);

    expect(result).toBe(true);
    expect(database.setPositionStatusUnlessSettled).toHaveBeenCalledWith("pending-position", "needs_review", {
      reason: "settlement_retry_disabled",
    });
  });
});

describe("position monitor timeouts", () => {
  const position = {
    id: "stuck-position",
    chainId: 4663,
    protocol: "v4" as const,
    positionKey: "123",
    owner: "0x0000000000000000000000000000000000000001",
    poolAddress: null,
    token0: "0x0000000000000000000000000000000000000000",
    token1: "0x0000000000000000000000000000000000000002",
    quoteToken: "0x0000000000000000000000000000000000000002",
    status: "armed" as const,
    liquidity: null,
    openedAtBlock: null,
    metadata: {},
  } satisfies PositionRecord;

  it("releases the monitor cycle and avoids duplicate valuation when a position hangs", async () => {
    vi.useFakeTimers();
    try {
      const pnl = { value: vi.fn(() => new Promise(() => {})) };
      const guardian = new Guardian({} as RuntimeConfig, {} as never, {} as never, {} as never, {} as never, pnl as never, {} as never, {} as never);
      const evaluate = (guardian as unknown as {
        evaluatePositionWithTimeout(name: "robinhood", position: PositionRecord, blockNumber: bigint): Promise<boolean>;
      }).evaluatePositionWithTimeout.bind(guardian);

      const first = evaluate("robinhood", position, 10n);
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(first).resolves.toBe(true);
      await expect(evaluate("robinhood", position, 11n)).resolves.toBe(true);
      expect(pnl.value).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
