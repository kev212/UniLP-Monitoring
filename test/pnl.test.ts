import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";

import type { RuntimeConfig } from "../src/config.js";
import { PnlService } from "../src/services/pnl.js";
import { amountsForLiquidity, applySlippage, sqrtRatioAtTick } from "../src/services/uniswap-math.js";

const config: RuntimeConfig = {
  databaseUrl: "postgres://unused",
  chains: ["base"],
  executorAddress: "0x0000000000000000000000000000000000000001",
  rpcHttp: { base: "https://mainnet.base.org", robinhood: "https://rpc.mainnet.chain.robinhood.com" },
  rpcWss: {},
  alchemyHttp: {},
  quoteTokens: { base: [], robinhood: [] },
  stopLossPercent: -10,
  takeProfitPercent: 20,
  trailingStopActivationPercent: 5,
  trailingStopDrawdownPercent: 1.5,
  trailingExitEstimateBufferPercent: 10,
  profitOorAboveThresholdPercent: 3,
  slTwapGuardMaxWaitMs: 15_000,
  positionMonitorIntervalMs: 5_000,
  discoveryIntervalMs: 30_000,
  positionMonitorConcurrency: 2,
  maxSwapSlippageBps: 100,
  maxTwapDeviationBps: 250,
  twapWindowSeconds: 300,
  pnlIncludeGas: false,
  oorAutoCloseEnabled: false,
  oorAboveMinDistancePercent: 10,
  oorAboveMinDurationMs: 1_800_000,
  dryRun: true,
  confirmations: 2,
  scanBlockRange: 2_000n,
  maxLogBlockRange: 2_000n,
  rpcRequestDelayMs: 0,
  rpcBootstrapLookbackBlocks: 50_000n,
  startBlocks: { base: 0n, robinhood: 0n },
};

describe("PnL thresholds", () => {
  const pnl = new PnlService({} as never, {} as never, {} as never, config);
  const snapshot = (pnlBps: bigint) => ({
    positionId: "position",
    quoteToken: "0x0000000000000000000000000000000000000001" as const,
    depositsQuote: 1_000_000n,
    realizedQuote: 0n,
    liquidationQuote: 1_000_000n,
    pnlQuote: 0n,
    pnlBps,
    blockNumber: 1n,
    feeQuote: 0n,
    feeNonQuote: null,
    feeQuoteUsdg: 0n,
  });

  const range = (status: "in_range" | "above" | "below") => ({
    status,
    tickLower: -1,
    tickUpper: 1,
    currentTick: 0,
    currentSqrtPrice: 1n,
  });

  it("triggers stop-loss purely on PnL regardless of range state", () => {
    expect(pnl.shouldTrigger(snapshot(-1_000n), range("in_range"), false)).toBe("stop_loss");
    expect(pnl.shouldTrigger(snapshot(-1_000n), range("below"), false)).toBe("stop_loss");
    expect(pnl.shouldTrigger(snapshot(-1_000n), range("above"), true)).toBe("stop_loss");
    expect(pnl.shouldTrigger(snapshot(-1_000n), undefined, false)).toBe("stop_loss");
    expect(pnl.shouldTrigger(snapshot(-999n), range("below"), false)).toBeNull();
  });

  it("keeps take-profit independent of range state", () => {
    expect(pnl.shouldTrigger(snapshot(2_000n), undefined, false)).toBe("take_profit");
    expect(pnl.shouldTrigger(snapshot(1_999n), undefined, false)).toBeNull();
  });
});

describe("trailing stop", () => {
  const pnl = new PnlService({} as never, {} as never, {} as never, config);
  const snapshot = (pnlBps: bigint, blockNumber = 1n) => ({
    positionId: "position",
    quoteToken: "0x0000000000000000000000000000000000000001" as const,
    depositsQuote: 1_000_000n,
    realizedQuote: 0n,
    liquidationQuote: 1_000_000n,
    pnlQuote: 0n,
    pnlBps,
    blockNumber,
    feeQuote: 0n,
    feeNonQuote: null,
    feeQuoteUsdg: 0n,
  });

  it("activates at 5% and raises its peak with PnL", () => {
    expect(pnl.evaluateTrailingStop({}, snapshot(499n))).toEqual({ action: "none" });

    const activated = pnl.evaluateTrailingStop({}, snapshot(500n, 10n));
    expect(activated).toEqual({
      action: "activate",
      state: { peakPnlBps: 500n, activatedAtBlock: 10n },
    });

    expect(pnl.evaluateTrailingStop(
      { trailingStop: { peakPnlBps: "500", activatedAtBlock: "10" } },
      snapshot(900n, 11n),
    )).toEqual({
      action: "raise_peak",
      state: { peakPnlBps: 900n, activatedAtBlock: 10n },
    });
  });

  it("triggers after a 1.5 percentage-point drawdown from the peak", () => {
    const metadata = { trailingStop: { peakPnlBps: "900", activatedAtBlock: "10" } };

    expect(pnl.evaluateTrailingStop(metadata, snapshot(751n))).toEqual({ action: "none" });
    expect(pnl.evaluateTrailingStop(metadata, snapshot(750n))).toEqual({
      action: "trigger",
      state: { peakPnlBps: 900n, activatedAtBlock: 10n },
    });
  });

  it("resets an active trailing stop only after PnL becomes negative", () => {
    const metadata = { trailingStop: { peakPnlBps: "500", activatedAtBlock: "10" } };

    expect(pnl.evaluateTrailingStop(metadata, snapshot(-1n))).toEqual({ action: "reset" });
  });

  it("derives the conservative trailing exit gate from peak and drawdown", () => {
    const pnl = new PnlService({} as never, {} as never, {} as never, config);
    expect(pnl.trailingExitEstimateGateBps({ trailingStop: { peakPnlBps: "500", activatedAtBlock: "10" } })).toBe(315n);
    expect(pnl.trailingExitEstimateGateBps({ trailingStop: { peakPnlBps: "900", activatedAtBlock: "10" } })).toBe(675n);
  });
});

describe("fresh valuation quotes", () => {
  it("bounds a stuck position read so monitoring can retry", async () => {
    vi.useFakeTimers();
    try {
      const reader = { read: vi.fn(() => new Promise(() => {})) };
      const pnl = new PnlService({} as never, reader as never, {} as never, config);
      const position = {
        id: "position",
        chainId: 8453,
        protocol: "v4",
        positionKey: "1",
        owner: "0x0000000000000000000000000000000000000003",
        poolAddress: null,
        token0: "0x0000000000000000000000000000000000000001",
        token1: "0x0000000000000000000000000000000000000002",
        quoteToken: "0x0000000000000000000000000000000000000001",
        status: "armed",
        liquidity: 1n,
        openedAtBlock: 1n,
        metadata: {},
      } as const;
      const value = pnl.value(position, 1n);
      const rejection = expect(value).rejects.toThrow("position read timed out after 15000ms");

      await vi.advanceTimersByTimeAsync(15_000);

      await rejection;
      expect(reader.read).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a fresh Trading API quote before the local route planner", async () => {
    const usdg = "0x0000000000000000000000000000000000000001" as Address;
    const token = "0x0000000000000000000000000000000000000002" as Address;
    const position = {
      id: "position",
      chainId: 8453,
      protocol: "v4",
      positionKey: "1",
      owner: "0x0000000000000000000000000000000000000003" as Address,
      poolAddress: null,
      token0: usdg,
      token1: token,
      quoteToken: usdg,
      status: "armed",
      liquidity: 1n,
      openedAtBlock: 1n,
      metadata: {},
    } as const;
    const database = {
      recordPositionObservation: vi.fn(),
      getCashflowTotals: vi.fn().mockResolvedValue({ deposits: 1_000_000n, realized: 0n }),
      getPoolObservationAtOrBefore: vi.fn().mockResolvedValue(null),
      recordPoolObservation: vi.fn(),
    };
    const reader = {
      read: vi.fn().mockResolvedValue({
        protocol: "v4",
        poolKey: "pool",
        sourcePool: null,
        token0: { token: usdg, amount: 1_000_000n },
        token1: { token, amount: 10n ** 18n },
        liquidity: 1n,
        priceMarker: 1n,
        minAmount0: 0n,
        minAmount1: 0n,
        unclaimedFees0: 0n,
        unclaimedFees1: 0n,
        observedBlock: 1n,
      }),
    };
    const routes = { quoteDirect: vi.fn() };
    const tradingApi = {
      quote: vi.fn().mockResolvedValue({ expectedOut: 100_000n, minimumOut: 99_000n }),
    };
    const pnl = new PnlService(database as never, reader as never, routes as never, config, tradingApi as never);

    const valued = await pnl.value(position, 1n);

    expect(tradingApi.quote).toHaveBeenCalledWith(position, token, 10n ** 18n, usdg);
    expect(routes.quoteDirect).not.toHaveBeenCalled();
    expect(valued.snapshot.liquidationQuote).toBe(1_099_000n);
  });

  it("uses native ETH as a quote token without an ERC-20 route", async () => {
    const token = "0x0000000000000000000000000000000000000002" as Address;
    const position = {
      id: "position",
      chainId: 4663,
      protocol: "v4",
      positionKey: "1",
      owner: "0x0000000000000000000000000000000000000003" as Address,
      poolAddress: null,
      token0: zeroAddress,
      token1: token,
      quoteToken: zeroAddress,
      status: "armed",
      liquidity: 1n,
      openedAtBlock: 1n,
      metadata: {},
    } as const;
    const database = {
      recordPositionObservation: vi.fn(),
      getCashflowTotals: vi.fn().mockResolvedValue({ deposits: 10n ** 18n, realized: 0n }),
      getPoolObservationAtOrBefore: vi.fn().mockResolvedValue(null),
      recordPoolObservation: vi.fn(),
    };
    const reader = {
      read: vi.fn().mockResolvedValue({
        protocol: "v4", poolKey: "pool", sourcePool: null,
        token0: { token: zeroAddress, amount: 10n ** 18n },
        token1: { token, amount: 10n ** 18n }, liquidity: 1n, priceMarker: 1n,
        minAmount0: 0n, minAmount1: 0n, unclaimedFees0: 0n, unclaimedFees1: 0n, observedBlock: 1n,
      }),
    };
    const routes = { quoteDirect: vi.fn() };
    const tradingApi = { quote: vi.fn().mockResolvedValue({ expectedOut: 2n * 10n ** 18n, minimumOut: 0n }) };
    const pnl = new PnlService(database as never, reader as never, routes as never, config, tradingApi as never);

    await pnl.value(position, 1n);

    expect(tradingApi.quote).toHaveBeenCalledWith(position, token, 10n ** 18n, zeroAddress);
    expect(routes.quoteDirect).not.toHaveBeenCalled();
  });
});

describe("swap slippage", () => {
  it("deducts the configured maximum output buffer", () => {
    expect(applySlippage(1_000_000n, 100)).toBe(990_000n);
  });
});

describe("concentrated-liquidity math", () => {
  it("uses the canonical Q64.96 ratio at tick zero", () => {
    expect(sqrtRatioAtTick(0)).toBe(1n << 96n);
  });

  it("returns only token0 below range and only token1 above range", () => {
    const liquidity = 1_000_000_000_000n;
    const below = amountsForLiquidity(sqrtRatioAtTick(-120), -60, 60, liquidity);
    const above = amountsForLiquidity(sqrtRatioAtTick(120), -60, 60, liquidity);

    expect(below.amount0).toBeGreaterThan(0n);
    expect(below.amount1).toBe(0n);
    expect(above.amount0).toBe(0n);
    expect(above.amount1).toBeGreaterThan(0n);
  });
});
