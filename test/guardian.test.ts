import { describe, expect, it, vi } from "vitest";

import { Guardian, ROBINHOOD_RPC_BACKOFF_MS, shouldResumeExitRetry, shouldResumeGroupExitRetry, shouldWaitForExitRetry, shouldWaitForGroupExitRetry } from "../src/services/guardian.js";
import { quoteRangeState } from "../src/services/quote-range.js";
import { sqrtRatioAtTick } from "../src/services/uniswap-math.js";
import type { RuntimeConfig } from "../src/config.js";
import type { PnlSnapshot, PositionGroupPnlSnapshot, PositionGroupRecord, PositionRecord } from "../src/types.js";

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
    trailingTwapGuardMaxWaitMs: 15_000,
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

describe("trailing TWAP guard timeout", () => {
  const config = { trailingTwapGuardMaxWaitMs: 15_000 } as RuntimeConfig;
  const position = {
    id: "trailing-position",
    chainId: 4663,
    protocol: "v3" as const,
    positionKey: "1",
    owner: "0x0000000000000000000000000000000000000001",
    poolAddress: null,
    token0: "0x0000000000000000000000000000000000000002",
    token1: "0x0000000000000000000000000000000000000003",
    quoteToken: "0x0000000000000000000000000000000000000002",
    status: "armed" as const,
    liquidity: null,
    openedAtBlock: null,
    metadata: {},
  } satisfies PositionRecord;

  function makeGuardian(value = config): Guardian {
    const database = { setPositionStatus: vi.fn().mockResolvedValue(undefined) };
    return new Guardian(value, database as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  }

  async function allow(guardian: Guardian, value: PositionRecord): Promise<boolean> {
    return (guardian as unknown as {
      allowTrailingAfterTwapWait(position: PositionRecord, deviationBps?: bigint): Promise<boolean>;
    }).allowTrailingAfterTwapWait(value, 900n);
  }

  it("starts a bounded wait when the trailing guard is not ready", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      const guardian = makeGuardian();
      await expect(allow(guardian, position)).resolves.toBe(false);
      const database = (guardian as unknown as { database: { setPositionStatus: ReturnType<typeof vi.fn> } }).database;
      expect(database.setPositionStatus).toHaveBeenCalledWith("trailing-position", "armed", { trailingTwapWaitStartedAt: 100_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues waiting until the trailing timeout expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      const guardian = makeGuardian();
      await expect(allow(guardian, { ...position, metadata: { trailingTwapWaitStartedAt: 90_001 } })).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows conservative trailing evaluation after the timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      const guardian = makeGuardian();
      await expect(allow(guardian, { ...position, metadata: { trailingTwapWaitStartedAt: 84_999 } })).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows an explicitly disabled wait without storing timer state", async () => {
    const guardian = makeGuardian({ trailingTwapGuardMaxWaitMs: 0 } as RuntimeConfig);
    await expect(allow(guardian, position)).resolves.toBe(true);
    const database = (guardian as unknown as { database: { setPositionStatus: ReturnType<typeof vi.fn> } }).database;
    expect(database.setPositionStatus).not.toHaveBeenCalled();
  });

  it("keeps the hard-floor override below the conservative estimate gate", async () => {
    const database = { setPositionStatusUnlessSettled: vi.fn().mockResolvedValue(true) };
    const pnl = {
      trailingExitEstimateGateBps: vi.fn().mockReturnValue(365n),
      trailingFloorBps: vi.fn().mockReturnValue(406n),
    };
    const guardian = new Guardian(config, database as never, {} as never, {} as never, {} as never, pnl as never, {} as never, {} as never);
    const valued = { snapshot: { pnlBps: 206n } };

    await expect((guardian as unknown as {
      trailingExitEstimateAllowed(value: PositionRecord, blockNumber: bigint, estimate: typeof valued): Promise<unknown>;
    }).trailingExitEstimateAllowed(position, 10n, valued)).resolves.toBe(valued.snapshot);
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

describe("valuation retry status handling", () => {
  const position = {
    id: "route-position",
    chainId: 4663,
    protocol: "v4" as const,
    positionKey: "812384",
    owner: "0x0000000000000000000000000000000000000001",
    poolAddress: null,
    token0: "0x0000000000000000000000000000000000000002",
    token1: "0x0000000000000000000000000000000000000003",
    quoteToken: "0x0000000000000000000000000000000000000002",
    status: "syncing" as const,
    liquidity: null,
    openedAtBlock: null,
    metadata: { armedAtBlock: "100" },
  } satisfies PositionRecord;

  const snapshot: PnlSnapshot = {
    positionId: position.id,
    quoteToken: position.quoteToken,
    depositsQuote: 1_000n,
    realizedQuote: 0n,
    liquidationQuote: 1_000n,
    pnlQuote: 0n,
    pnlBps: 0n,
    blockNumber: 10n,
    liquidity: 1n,
    feeQuote: 0n,
    feeNonQuote: null,
    feeQuoteUsdg: 0n,
  };

  it("keeps a previously armed position armed when a route quote is temporarily unavailable", async () => {
    const database = { setPositionStatus: vi.fn().mockResolvedValue(undefined) };
    const pnl = { value: vi.fn().mockRejectedValue(new Error("No safe direct Uniswap route from LP asset to quote token")) };
    const guardian = new Guardian({} as RuntimeConfig, database as never, {} as never, {} as never, {} as never, pnl as never, {} as never, {} as never);

    const result = await (guardian as unknown as {
      evaluatePosition(name: "robinhood", position: PositionRecord, blockNumber: bigint): Promise<boolean>;
    }).evaluatePosition("robinhood", position, 10n);

    expect(result).toBe(false);
    expect(database.setPositionStatus).toHaveBeenCalledWith("route-position", "armed", { reason: null });
    expect(database.setPositionStatus).not.toHaveBeenCalledWith("route-position", "needs_review", expect.anything());
  });

  it("does not resend ARMED for a position that already has an armed block", async () => {
    const database = {
      addPnlSnapshot: vi.fn().mockResolvedValue(undefined),
      setPositionStatus: vi.fn().mockResolvedValue(undefined),
    };
    const notifier = { logPnL: vi.fn().mockResolvedValue(undefined), armed: vi.fn().mockResolvedValue(undefined) };
    const pnl = {
      value: vi.fn().mockResolvedValue({ snapshot, range: undefined, twapGuard: { ready: true } }),
      evaluateTrailingStop: vi.fn().mockReturnValue({ action: "none" }),
    };
    const guardian = new Guardian({} as RuntimeConfig, database as never, {} as never, {} as never, {} as never, pnl as never, {} as never, notifier as never);
    vi.spyOn(guardian as any, "updateOorAboveTimer").mockResolvedValue(null);
    vi.spyOn(guardian as any, "updateProfitOorAboveTimer").mockResolvedValue(null);

    await (guardian as unknown as {
      evaluatePosition(name: "robinhood", position: PositionRecord, blockNumber: bigint): Promise<boolean>;
    }).evaluatePosition("robinhood", position, 10n);

    expect(database.setPositionStatus).toHaveBeenCalledWith("route-position", "armed", expect.objectContaining({ armedAtBlock: "10" }));
    expect(notifier.armed).not.toHaveBeenCalled();
  });

  it("backs off retrying a recently retried needs_review position", async () => {
    const database = {
      listOpenPositions: vi.fn().mockResolvedValue([{
        ...position,
        status: "needs_review",
        metadata: { needsReviewRetriedAt: new Date().toISOString() },
      }]),
      setPositionStatus: vi.fn().mockResolvedValue(undefined),
    };
    const chains = {
      get: vi.fn(() => ({
        client: { getBlockNumber: vi.fn().mockResolvedValue(10n) },
        registry: { chain: { id: 4663 }, monitoringEnabled: true },
      })),
    };
    const guardian = new Guardian({} as RuntimeConfig, database as never, chains as never, {} as never, {} as never, {} as never, {} as never, {} as never);

    await (guardian as unknown as { retryNeedsReview(name: "robinhood"): Promise<void> }).retryNeedsReview("robinhood");

    expect(database.setPositionStatus).not.toHaveBeenCalled();
  });
});

describe("stop-loss local quote validation", () => {
  const position = {
    id: "position",
    chainId: 4663,
    protocol: "v4" as const,
    positionKey: "1",
    owner: "0x0000000000000000000000000000000000000001",
    poolAddress: null,
    token0: "0x0000000000000000000000000000000000000002",
    token1: "0x0000000000000000000000000000000000000003",
    quoteToken: "0x0000000000000000000000000000000000000002",
    status: "armed" as const,
    liquidity: null,
    openedAtBlock: null,
    metadata: {},
  } satisfies PositionRecord;

  const snapshot = (pnlBps: bigint): PnlSnapshot => ({
    positionId: position.id,
    quoteToken: position.quoteToken,
    depositsQuote: 1_000_000n,
    realizedQuote: 0n,
    liquidationQuote: 1_000_000n + pnlBps,
    pnlQuote: pnlBps,
    pnlBps,
    blockNumber: 10n,
    liquidity: 1n,
    feeQuote: 0n,
    feeNonQuote: null,
    feeQuoteUsdg: 0n,
  });

  it("cancels an API-triggered SL when the local quote is above the threshold", async () => {
    const database = { setPositionStatus: vi.fn().mockResolvedValue(undefined) };
    const pnl = {
      valueLocal: vi.fn().mockResolvedValue({ snapshot: snapshot(-1_000n), range: undefined }),
      shouldTrigger: vi.fn().mockReturnValue(null),
    };
    const guardian = new Guardian({} as RuntimeConfig, database as never, {} as never, {} as never, {} as never, pnl as never, {} as never, {} as never);

    const result = await (guardian as unknown as {
      validateStopLossWithLocalQuote(position: PositionRecord, blockNumber: bigint, apiSnapshot: PnlSnapshot): Promise<PnlSnapshot | null>;
    }).validateStopLossWithLocalQuote(position, 10n, snapshot(-5_844n));

    expect(result).toBeNull();
    expect(database.setPositionStatus).toHaveBeenCalledWith("position", "armed", { slTwapWaitStartedAt: null });
    expect(pnl.valueLocal).toHaveBeenCalledWith(position, 10n);
  });

  const group = {
    id: "group",
    chainId: 4663,
    protocol: "v3",
    positionManager: "0x0000000000000000000000000000000000000001",
    poolKey: "0x0000000000000000000000000000000000000004",
    owner: "0x0000000000000000000000000000000000000005",
    token0: "0x0000000000000000000000000000000000000002",
    token1: "0x0000000000000000000000000000000000000003",
    quoteToken: "0x0000000000000000000000000000000000000002",
    shape: "bid_ask",
    shapeVersion: "delta-amount-linear-v3",
    requestedBinCount: 5,
    generatedBinCount: 5,
    mintableBinCount: 5,
    outerTickLower: 0,
    outerTickUpper: 100,
    anchorBinIndex: 2,
    totalDeposit: 1_000_000n,
    deployedCostQuote: 1_000_000n,
    directCloseAmount0: 0n,
    directCloseAmount1: 0n,
    totalReceivedQuote: 0n,
    status: "active",
    planHash: "0xplan",
    planJson: {},
    referenceBlock: 1n,
    referenceTick: 50,
    referencePrice: 1n,
    openTransactionHash: "0xopen",
    closeTransactionHash: null,
    pendingRawTransaction: null,
    executionLeaseToken: null,
    executionLeaseUntil: null,
    finalPnlQuote: null,
    finalPnlBps: null,
    finalPnlUsd: null,
    settledAt: null,
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } satisfies PositionGroupRecord;

  const groupSnapshot = (pnlBps: bigint): PositionGroupPnlSnapshot => ({
    groupId: group.id,
    quoteToken: group.quoteToken,
    depositsQuote: 1_000_000n,
    realizedQuote: 0n,
    liquidationQuote: 1_000_000n + pnlBps,
    feeQuote: 0n,
    feeQuoteUsdg: 0n,
    pnlQuote: pnlBps,
    pnlBps,
    blockNumber: 10n,
    groupGasQuote: 0n,
  });

  it("cancels an API-triggered group SL when the local quote is above the threshold", async () => {
    const pnl = {
      valueGroupLocal: vi.fn().mockResolvedValue({ snapshot: groupSnapshot(-151n) }),
      shouldTriggerGroup: vi.fn().mockReturnValue(null),
    };
    const guardian = new Guardian({} as RuntimeConfig, {} as never, {} as never, {} as never, {} as never, pnl as never, {} as never, {} as never);

    const result = await (guardian as unknown as {
      validateGroupStopLossWithLocalQuote(
        value: PositionGroupRecord,
        blockNumber: bigint,
        apiSnapshot: PositionGroupPnlSnapshot,
      ): Promise<PositionGroupPnlSnapshot | null>;
    }).validateGroupStopLossWithLocalQuote(group, 10n, groupSnapshot(-3_158n));

    expect(result).toBeNull();
    expect(pnl.valueGroupLocal).toHaveBeenCalledWith(group, 10n);
    expect(pnl.shouldTriggerGroup).toHaveBeenCalledWith(groupSnapshot(-151n));
  });

  it("propagates a group SL rate limit so chain backoff can activate", async () => {
    const pnl = {
      valueGroupLocal: vi.fn().mockRejectedValue(new Error("RPC rate limited")),
      shouldTriggerGroup: vi.fn(),
    };
    const guardian = new Guardian({} as RuntimeConfig, {} as never, {} as never, {} as never, {} as never, pnl as never, {} as never, {} as never);

    const result = (guardian as unknown as {
      validateGroupStopLossWithLocalQuote(
        value: PositionGroupRecord,
        blockNumber: bigint,
        apiSnapshot: PositionGroupPnlSnapshot,
      ): Promise<PositionGroupPnlSnapshot | null>;
    }).validateGroupStopLossWithLocalQuote(group, 10n, groupSnapshot(-3_158n));

    await expect(result).rejects.toThrow("RPC rate limited");
    expect(pnl.shouldTriggerGroup).not.toHaveBeenCalled();
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

      await expect(first).resolves.toBe(false);
      const second = evaluate("robinhood", position, 11n);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(second).resolves.toBe(false);
      expect(pnl.value).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("monitor RPC backoff", () => {
  const group = (id: string): PositionGroupRecord => ({
    id,
    chainId: 4663,
    protocol: "v4",
    positionManager: "0x0000000000000000000000000000000000000001",
    poolKey: "0x0000000000000000000000000000000000000004",
    owner: "0x0000000000000000000000000000000000000005",
    token0: "0x0000000000000000000000000000000000000002",
    token1: "0x0000000000000000000000000000000000000003",
    quoteToken: "0x0000000000000000000000000000000000000002",
    shape: "bid_ask",
    shapeVersion: "delta-amount-linear-v3",
    requestedBinCount: 5,
    generatedBinCount: 5,
    mintableBinCount: 5,
    outerTickLower: 0,
    outerTickUpper: 100,
    anchorBinIndex: 2,
    totalDeposit: 1_000_000n,
    deployedCostQuote: 1_000_000n,
    directCloseAmount0: 0n,
    directCloseAmount1: 0n,
    totalReceivedQuote: 0n,
    status: "active",
    planHash: "0xplan",
    planJson: {},
    referenceBlock: 1n,
    referenceTick: 50,
    referencePrice: 1n,
    openTransactionHash: "0xopen",
    closeTransactionHash: null,
    pendingRawTransaction: null,
    executionLeaseToken: null,
    executionLeaseUntil: null,
    finalPnlQuote: null,
    finalPnlBps: null,
    finalPnlUsd: null,
    settledAt: null,
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  const valued = {
    snapshot: {
      groupId: "g1",
      quoteToken: "0x0000000000000000000000000000000000000002",
      depositsQuote: 1_000_000n,
      realizedQuote: 0n,
      liquidationQuote: 1_000_000n,
      feeQuote: 0n,
      feeQuoteUsdg: 0n,
      pnlQuote: 0n,
      pnlBps: 0n,
      blockNumber: 10n,
      groupGasQuote: 0n,
    },
    twapGuard: { ready: false },
    range: undefined,
  };

  it("skips remaining groups after a 429 and does not revalue successes on the same block", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00Z"));
    try {
      const rateLimit = Object.assign(new Error("HTTP request failed.\nStatus: 429\nToo Many Requests"), { status: 429 });
      let g2Attempts = 0;
      const pnl = {
        valueGroup: vi.fn(async (item: PositionGroupRecord) => {
          if (item.id === "g2" && g2Attempts === 0) {
            g2Attempts += 1;
            throw rateLimit;
          }
          return { ...valued, snapshot: { ...valued.snapshot, groupId: item.id } };
        }),
        evaluateTrailingStop: vi.fn().mockReturnValue({ action: "none" }),
        shouldTriggerGroup: vi.fn().mockReturnValue(null),
      };
      const database = {
        listPositionGroups: vi.fn().mockResolvedValue([group("g1"), group("g2"), group("g3")]),
        listOpenPositions: vi.fn().mockResolvedValue([]),
        setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
      };
      const chains = {
        get: () => ({
          client: { getBlockNumber: vi.fn().mockResolvedValue(10n) },
          registry: { chain: { id: 4663 }, monitoringEnabled: true },
        }),
      };
      const guardian = new Guardian(
        { positionMonitorConcurrency: 1 } as RuntimeConfig,
        database as never,
        chains as never,
        {} as never,
        {} as never,
        pnl as never,
        {} as never,
        {} as never,
      );
      const evaluate = (guardian as unknown as { evaluateChain(name: "robinhood"): Promise<void> }).evaluateChain.bind(guardian);

      await evaluate("robinhood");
      expect(pnl.valueGroup.mock.calls.map((call) => call[0].id)).toEqual(["g1", "g2"]);

      await evaluate("robinhood");
      expect(pnl.valueGroup).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(ROBINHOOD_RPC_BACKOFF_MS);
      await evaluate("robinhood");
      expect(pnl.valueGroup.mock.calls.map((call) => call[0].id)).toEqual(["g1", "g2", "g2", "g3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds TWAP waits for every automatic group trigger", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00Z"));
    try {
      const database = { setPositionGroupStatus: vi.fn().mockResolvedValue(undefined) };
      const guardian = new Guardian(
        { slTwapGuardMaxWaitMs: 15_000, trailingTwapGuardMaxWaitMs: 15_000 } as RuntimeConfig,
        database as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const allow = (guardian as unknown as {
        allowGroupAfterTwapWait(value: PositionGroupRecord, trigger: import("../src/types.js").ExitTrigger): Promise<boolean>;
      }).allowGroupAfterTwapWait.bind(guardian);
      const cases = [
        ["stop_loss", "slTwapWaitStartedAt"],
        ["trailing_take_profit", "trailingTwapWaitStartedAt"],
        ["take_profit", "profitTwapWaitStartedAt"],
        ["profit_oor_above", "profitTwapWaitStartedAt"],
        ["out_of_range_above", "profitTwapWaitStartedAt"],
      ] as const;

      for (const [trigger, key] of cases) {
        const value = group(trigger);
        await expect(allow(value, trigger)).resolves.toBe(false);
        expect(database.setPositionGroupStatus).toHaveBeenLastCalledWith(value.id, "active", { [key]: Date.now() });
        await expect(allow({ ...value, metadata: { [key]: Date.now() - 15_000 } }, trigger)).resolves.toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("executes group SL after the TWAP wait with local validation", async () => {
    const value = {
      ...valued,
      snapshot: { ...valued.snapshot, pnlBps: -3_000n, pnlQuote: -300_000n },
    };
    const pnl = {
      valueGroup: vi.fn().mockResolvedValue(value),
      valueGroupLocal: vi.fn().mockResolvedValue({ ...value, twapGuard: { ready: true } }),
      evaluateTrailingStop: vi.fn().mockReturnValue({ action: "none" }),
      shouldTriggerGroup: vi.fn().mockReturnValue("stop_loss"),
    };
    const database = { setPositionGroupStatus: vi.fn().mockResolvedValue(undefined) };
    const executor = { executeRelatedGroup: vi.fn().mockResolvedValue(undefined) };
    const guardian = new Guardian(
      { slTwapGuardMaxWaitMs: 15_000, trailingTwapGuardMaxWaitMs: 15_000 } as RuntimeConfig,
      database as never,
      {} as never,
      {} as never,
      {} as never,
      pnl as never,
      executor as never,
      {} as never,
    );
    const evaluate = (guardian as unknown as {
      evaluatePositionGroup(name: "robinhood", value: PositionGroupRecord, block: bigint): Promise<boolean>;
    }).evaluatePositionGroup.bind(guardian);

    await expect(evaluate("robinhood", { ...group("sl"), metadata: { slTwapWaitStartedAt: Date.now() - 15_001 } }, 10n)).resolves.toBe(true);

    expect(executor.executeRelatedGroup).toHaveBeenCalledWith("sl", "stop_loss");
    expect(database.setPositionGroupStatus).toHaveBeenCalledWith("sl", "active", expect.objectContaining({ exitTrigger: "stop_loss" }));
  });

  it("revalidates TP locally and persists its trigger before group execution", async () => {
    const value = {
      ...valued,
      snapshot: { ...valued.snapshot, pnlBps: 2_500n, pnlQuote: 250_000n },
    };
    const pnl = {
      valueGroup: vi.fn().mockResolvedValue(value),
      valueGroupLocalExitEstimate: vi.fn().mockResolvedValue({ ...value, twapGuard: { ready: true } }),
      evaluateTrailingStop: vi.fn().mockReturnValue({ action: "none" }),
      shouldTriggerGroup: vi.fn().mockReturnValue("take_profit"),
    };
    const database = { setPositionGroupStatus: vi.fn().mockResolvedValue(undefined) };
    const executor = { executeRelatedGroup: vi.fn().mockResolvedValue(undefined) };
    const guardian = new Guardian(
      { slTwapGuardMaxWaitMs: 15_000, trailingTwapGuardMaxWaitMs: 15_000 } as RuntimeConfig,
      database as never,
      {} as never,
      {} as never,
      {} as never,
      pnl as never,
      executor as never,
      {} as never,
    );
    const evaluate = (guardian as unknown as {
      evaluatePositionGroup(name: "robinhood", value: PositionGroupRecord, block: bigint): Promise<boolean>;
    }).evaluatePositionGroup.bind(guardian);

    await expect(evaluate("robinhood", { ...group("tp"), metadata: { profitTwapWaitStartedAt: Date.now() - 15_001 } }, 10n)).resolves.toBe(true);

    expect(pnl.valueGroupLocalExitEstimate).toHaveBeenCalledWith(expect.anything(), 10n, undefined);
    expect(executor.executeRelatedGroup).toHaveBeenCalledWith("tp", "take_profit");
    expect(database.setPositionGroupStatus).toHaveBeenCalledWith("tp", "active", expect.objectContaining({
      exitTrigger: "take_profit",
      exitSnapshot: expect.objectContaining({ pnlBps: "2500" }),
    }));
  });

  it("upgrades a profit exit to SL when the conservative local quote has crossed SL", async () => {
    const main = {
      ...valued,
      twapGuard: { ready: true },
      snapshot: { ...valued.snapshot, pnlBps: 2_500n, pnlQuote: 250_000n },
    };
    const local = {
      ...main,
      snapshot: { ...main.snapshot, pnlBps: -3_000n, pnlQuote: -300_000n },
    };
    const pnl = {
      valueGroup: vi.fn().mockResolvedValue(main),
      valueGroupLocalExitEstimate: vi.fn().mockResolvedValue(local),
      evaluateTrailingStop: vi.fn().mockReturnValue({ action: "none" }),
      shouldTriggerGroup: vi.fn((snapshot: PositionGroupPnlSnapshot) => snapshot.pnlBps < 0n ? "stop_loss" : "take_profit"),
    };
    const database = { setPositionGroupStatus: vi.fn().mockResolvedValue(undefined) };
    const executor = { executeRelatedGroup: vi.fn().mockResolvedValue(undefined) };
    const guardian = new Guardian(
      { settlementSwapSlippageBps: 200 } as RuntimeConfig,
      database as never,
      {} as never,
      {} as never,
      {} as never,
      pnl as never,
      executor as never,
      {} as never,
    );
    const evaluate = (guardian as unknown as {
      evaluatePositionGroup(name: "robinhood", value: PositionGroupRecord, block: bigint): Promise<boolean>;
    }).evaluatePositionGroup.bind(guardian);

    await expect(evaluate("robinhood", group("tp-to-sl"), 10n)).resolves.toBe(true);

    expect(executor.executeRelatedGroup).toHaveBeenCalledWith("tp-to-sl", "stop_loss");
    expect(database.setPositionGroupStatus).toHaveBeenCalledWith("tp-to-sl", "active", expect.objectContaining({ exitTrigger: "stop_loss" }));
  });

  it("uses the SL timeout when a TWAP-blocked profit exit is promoted to SL", async () => {
    const main = {
      ...valued,
      snapshot: { ...valued.snapshot, pnlBps: 2_500n, pnlQuote: 250_000n },
    };
    const local = {
      ...main,
      snapshot: { ...main.snapshot, pnlBps: -3_000n, pnlQuote: -300_000n },
    };
    const pnl = {
      valueGroup: vi.fn().mockResolvedValue(main),
      valueGroupLocalExitEstimate: vi.fn().mockResolvedValue(local),
      evaluateTrailingStop: vi.fn().mockReturnValue({ action: "none" }),
      shouldTriggerGroup: vi.fn((snapshot: PositionGroupPnlSnapshot) => snapshot.pnlBps < 0n ? "stop_loss" : "take_profit"),
    };
    const database = { setPositionGroupStatus: vi.fn().mockResolvedValue(undefined) };
    const executor = { executeRelatedGroup: vi.fn().mockResolvedValue(undefined) };
    const guardian = new Guardian(
      { settlementSwapSlippageBps: 200, trailingTwapGuardMaxWaitMs: 0, slTwapGuardMaxWaitMs: 15_000 } as RuntimeConfig,
      database as never,
      {} as never,
      {} as never,
      {} as never,
      pnl as never,
      executor as never,
      {} as never,
    );
    const evaluate = (guardian as unknown as {
      evaluatePositionGroup(name: "robinhood", value: PositionGroupRecord, block: bigint): Promise<boolean>;
    }).evaluatePositionGroup.bind(guardian);

    await expect(evaluate("robinhood", group("promoted-sl-wait"), 10n)).resolves.toBe(true);

    expect(database.setPositionGroupStatus).toHaveBeenCalledWith("promoted-sl-wait", "active", { slTwapWaitStartedAt: expect.any(Number) });
    expect(executor.executeRelatedGroup).not.toHaveBeenCalled();
  });

  it("keeps a due manual retry ahead of a newly observed TP", async () => {
    const main = {
      ...valued,
      twapGuard: { ready: true },
      snapshot: { ...valued.snapshot, pnlBps: 2_500n, pnlQuote: 250_000n },
    };
    const pnl = {
      valueGroup: vi.fn().mockResolvedValue(main),
      evaluateTrailingStop: vi.fn().mockReturnValue({ action: "none" }),
      shouldTriggerGroup: vi.fn().mockReturnValue("take_profit"),
    };
    const database = { setPositionGroupStatus: vi.fn().mockResolvedValue(undefined) };
    const executor = { executeRelatedGroup: vi.fn().mockResolvedValue(undefined) };
    const guardian = new Guardian(
      {} as RuntimeConfig,
      database as never,
      {} as never,
      {} as never,
      {} as never,
      pnl as never,
      executor as never,
      {} as never,
    );
    const evaluate = (guardian as unknown as {
      evaluatePositionGroup(name: "robinhood", value: PositionGroupRecord, block: bigint): Promise<boolean>;
    }).evaluatePositionGroup.bind(guardian);
    const retryGroup = {
      ...group("manual-retry"),
      metadata: {
        exitRetry: { reason: "manual", attempts: 1, nextAttemptAt: new Date(Date.now() - 1_000).toISOString() },
      },
    };

    await expect(evaluate("robinhood", retryGroup, 10n)).resolves.toBe(true);

    expect(executor.executeRelatedGroup).toHaveBeenCalledWith("manual-retry", "manual");
  });

  it("applies a conservative estimate gate to group trailing exits", async () => {
    const value = { ...valued, snapshot: { ...valued.snapshot, pnlBps: 450n, pnlQuote: 45_000n } };
    const pnl = {
      valueGroup: vi.fn().mockResolvedValue(value),
      valueGroupLocalExitEstimate: vi.fn().mockResolvedValue({ ...value, twapGuard: { ready: true } }),
      valueGroupExitEstimate: vi.fn().mockResolvedValue({ ...value, twapGuard: { ready: true } }),
      evaluateTrailingStop: vi.fn().mockReturnValue({ action: "trigger" }),
      shouldTriggerGroup: vi.fn().mockReturnValue(null),
      trailingExitEstimateGateBps: vi.fn().mockReturnValue(400n),
      trailingFloorBps: vi.fn().mockReturnValue(350n),
    };
    const database = { setPositionGroupStatus: vi.fn().mockResolvedValue(undefined) };
    const executor = { executeRelatedGroup: vi.fn().mockResolvedValue(undefined) };
    const guardian = new Guardian(
      { settlementSwapSlippageBps: 200, slTwapGuardMaxWaitMs: 15_000, trailingTwapGuardMaxWaitMs: 15_000 } as RuntimeConfig,
      database as never,
      {} as never,
      {} as never,
      {} as never,
      pnl as never,
      executor as never,
      {} as never,
    );
    const evaluate = (guardian as unknown as {
      evaluatePositionGroup(name: "robinhood", value: PositionGroupRecord, block: bigint): Promise<boolean>;
    }).evaluatePositionGroup.bind(guardian);
    const trailingGroup = {
      ...group("trail"),
      metadata: {
        trailingStop: { peakPnlBps: "600", activatedAtBlock: "1" },
        trailingTwapWaitStartedAt: Date.now() - 15_001,
      },
    };

    await expect(evaluate("robinhood", trailingGroup, 10n)).resolves.toBe(true);

    expect(pnl.valueGroupExitEstimate).toHaveBeenCalledWith(trailingGroup, 10n, 200);
    expect(executor.executeRelatedGroup).toHaveBeenCalledWith("trail", "trailing_take_profit");
  });

  it.each(["profit_oor_above", "out_of_range_above"] as const)("revalidates %s against fresh local state", async (trigger) => {
    const local = { ...valued, twapGuard: { ready: true } };
    const pnl = {
      valueGroupLocalExitEstimate: vi.fn().mockResolvedValue(local),
      shouldTriggerGroup: vi.fn().mockReturnValue(null),
    };
    const guardian = new Guardian(
      {} as RuntimeConfig,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      pnl as never,
      {} as never,
      {} as never,
    );
    if (trigger === "profit_oor_above") {
      vi.spyOn(guardian as never, "updateGroupProfitOorAboveTimer" as never).mockResolvedValue(trigger as never);
    } else {
      vi.spyOn(guardian as never, "updateGroupOorAboveTimer" as never).mockResolvedValue(trigger as never);
    }
    const validate = (guardian as unknown as {
      validateGroupProfitExit(
        value: PositionGroupRecord,
        block: bigint,
        reason: "profit_oor_above" | "out_of_range_above",
        snapshot: PositionGroupPnlSnapshot,
      ): Promise<PositionGroupPnlSnapshot | null>;
    }).validateGroupProfitExit.bind(guardian);

    await expect(validate(group(trigger), 10n, trigger, valued.snapshot)).resolves.toEqual(valued.snapshot);
    expect(pnl.valueGroupLocalExitEstimate).toHaveBeenCalled();
  });

  it("keeps only SL and manual group retries sticky", () => {
    expect(shouldResumeGroupExitRetry("stop_loss")).toBe(true);
    expect(shouldResumeGroupExitRetry("manual")).toBe(true);
    expect(shouldResumeGroupExitRetry("take_profit")).toBe(false);
    expect(shouldResumeGroupExitRetry("trailing_take_profit")).toBe(false);
    expect(shouldResumeGroupExitRetry("profit_oor_above")).toBe(false);
    expect(shouldResumeGroupExitRetry("out_of_range_above")).toBe(false);
    expect(shouldWaitForGroupExitRetry("manual", Date.now() + 1_000)).toBe(true);
    expect(shouldWaitForGroupExitRetry("stop_loss", Date.now() + 1_000)).toBe(false);
  });

  it("clears a sticky SL retry when fresh local validation no longer confirms SL", async () => {
    const main = {
      ...valued,
      twapGuard: { ready: true },
      snapshot: { ...valued.snapshot, pnlBps: 2_500n, pnlQuote: 250_000n },
    };
    const pnl = {
      valueGroup: vi.fn().mockResolvedValue(main),
      valueGroupLocal: vi.fn().mockResolvedValue(main),
      evaluateTrailingStop: vi.fn().mockReturnValue({ action: "none" }),
      shouldTriggerGroup: vi.fn().mockReturnValue("take_profit"),
    };
    const database = { setPositionGroupStatus: vi.fn().mockResolvedValue(undefined) };
    const executor = { executeRelatedGroup: vi.fn().mockResolvedValue(undefined) };
    const guardian = new Guardian(
      {} as RuntimeConfig,
      database as never,
      {} as never,
      {} as never,
      {} as never,
      pnl as never,
      executor as never,
      {} as never,
    );
    const evaluate = (guardian as unknown as {
      evaluatePositionGroup(name: "robinhood", value: PositionGroupRecord, block: bigint): Promise<boolean>;
    }).evaluatePositionGroup.bind(guardian);
    const retryGroup = {
      ...group("stale-sl"),
      metadata: {
        exitTrigger: "stop_loss",
        exitRetry: { reason: "stop_loss", attempts: 1, nextAttemptAt: new Date(Date.now() - 1_000).toISOString() },
      },
    };

    await expect(evaluate("robinhood", retryGroup, 10n)).resolves.toBe(true);

    expect(database.setPositionGroupStatus).toHaveBeenCalledWith("stale-sl", "active", expect.objectContaining({
      exitRetry: null,
      exitTrigger: null,
    }));
    expect(executor.executeRelatedGroup).not.toHaveBeenCalled();
  });

  it("returns an unbroadcast dynamic close to active state after restart", async () => {
    const closing = {
      ...group("restart-profit"),
      status: "closing" as const,
      metadata: { exitTrigger: "trailing_take_profit", settlementPhase: "group_close" },
    };
    const database = {
      listPendingSwapPositions: vi.fn().mockResolvedValue([]),
      listPositionGroups: vi.fn().mockResolvedValue([closing]),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
    };
    const executor = { executeGroup: vi.fn().mockResolvedValue(undefined) };
    const guardian = new Guardian(
      {} as RuntimeConfig,
      database as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      executor as never,
      {} as never,
    );

    await (guardian as unknown as { resumeClosingPositions(): Promise<void> }).resumeClosingPositions();

    expect(database.setPositionGroupStatus).toHaveBeenCalledWith("restart-profit", "active", expect.objectContaining({
      exitTrigger: null,
      exitRetry: null,
    }));
    expect(executor.executeGroup).not.toHaveBeenCalled();
  });

  it("contains a failed dynamic recovery reset without stopping recovery", async () => {
    const closing = {
      ...group("restart-db-error"),
      status: "closing" as const,
      metadata: { exitTrigger: "take_profit", settlementPhase: "group_close" },
    };
    const database = {
      listPendingSwapPositions: vi.fn().mockResolvedValue([]),
      listPositionGroups: vi.fn().mockResolvedValue([closing]),
      setPositionGroupStatus: vi.fn().mockRejectedValue(new Error("database unavailable")),
    };
    const executor = { executeGroup: vi.fn().mockResolvedValue(undefined) };
    const guardian = new Guardian(
      {} as RuntimeConfig,
      database as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      executor as never,
      {} as never,
    );

    await expect((guardian as unknown as { resumeClosingPositions(): Promise<void> }).resumeClosingPositions()).resolves.toBeUndefined();
    expect(executor.executeGroup).not.toHaveBeenCalled();
  });
});
