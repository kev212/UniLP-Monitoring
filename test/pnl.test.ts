import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";

import type { RuntimeConfig } from "../src/config.js";
import { PnlService } from "../src/services/pnl.js";
import { amountsForLiquidity, applySlippage, sqrtRatioAtTick } from "../src/services/uniswap-math.js";
import type { PositionGroupRecord } from "../src/types.js";

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
  blinkRescuePollIntervalMs: 15_000,
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

  it("exposes the raw trailing floor for hard-floor enforcement", () => {
    const pnl = new PnlService({} as never, {} as never, {} as never, config);
    expect(pnl.trailingFloorBps({ trailingStop: { peakPnlBps: "1000", activatedAtBlock: "10" } })).toBe(850n);
    expect(pnl.trailingFloorBps({})).toBeNull();
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

  it("uses only the local route for SL revalidation", async () => {
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
      getCashflowTotals: vi.fn().mockResolvedValue({ deposits: 1_000_000n, realized: 0n }),
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
    const routes = {
      quoteDirect: vi.fn().mockResolvedValue({ expectedOut: 100_000n, path: [token, usdg] }),
    };
    const tradingApi = {
      quote: vi.fn().mockResolvedValue({ expectedOut: 1n, minimumOut: 1n }),
    };
    const pnl = new PnlService(database as never, reader as never, routes as never, config, tradingApi as never);

    const valued = await pnl.valueLocal(position, 1n);

    expect(tradingApi.quote).not.toHaveBeenCalled();
    expect(routes.quoteDirect).toHaveBeenCalledWith(position, token, 10n ** 18n, usdg);
    expect(valued.snapshot.liquidationQuote).toBe(1_099_000n);
  });

  it("does not use an unrelated local route when native quote validation has no Kyber quote", async () => {
    const froge = "0x0000000000000000000000000000000000000002" as Address;
    const native = zeroAddress;
    const position = {
      id: "position",
      chainId: 4663,
      protocol: "v4",
      positionKey: "1",
      owner: "0x0000000000000000000000000000000000000004" as Address,
      poolAddress: null,
      token0: native,
      token1: froge,
      quoteToken: native,
      status: "armed",
      liquidity: 1n,
      openedAtBlock: 1n,
      metadata: {},
    } as const;
    const database = {
      getCashflowTotals: vi.fn().mockResolvedValue({ deposits: 1_000_000n, realized: 0n }),
    };
    const reader = {
      read: vi.fn().mockResolvedValue({
        protocol: "v4",
        poolKey: "pool",
        sourcePool: null,
        token0: { token: position.token0, amount: 100n },
        token1: { token: froge, amount: 10n ** 18n },
        liquidity: 1n,
        priceMarker: 1n,
        minAmount0: 0n,
        minAmount1: 0n,
        unclaimedFees0: 0n,
        unclaimedFees1: 0n,
        observedBlock: 1n,
      }),
    };
    const routes = {
      quoteDirect: vi.fn().mockResolvedValue({ expectedOut: 900_000n, path: [froge, froge] }),
    };
    const pnl = new PnlService(database as never, reader as never, routes as never, config);

    await expect(pnl.valueLocal(position, 1n)).rejects.toThrow("No safe direct Uniswap route from LP asset to quote token");

    expect(routes.quoteDirect).not.toHaveBeenCalled();
  });

  it("uses KyberSwap for native quote validation", async () => {
    const froge = "0x0000000000000000000000000000000000000002" as Address;
    const native = zeroAddress;
    const position = {
      id: "position",
      chainId: 4663,
      protocol: "v4",
      positionKey: "1",
      owner: "0x0000000000000000000000000000000000000004" as Address,
      poolAddress: null,
      token0: native,
      token1: froge,
      quoteToken: native,
      status: "armed",
      liquidity: 1n,
      openedAtBlock: 1n,
      metadata: {},
    } as const;
    const database = {
      getCashflowTotals: vi.fn().mockResolvedValue({ deposits: 1_000_000n, realized: 0n }),
    };
    const reader = {
      read: vi.fn().mockResolvedValue({
        protocol: "v4",
        poolKey: "pool",
        sourcePool: null,
        token0: { token: native, amount: 100n },
        token1: { token: froge, amount: 10n ** 18n },
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
    const kyberswap = {
      quote: vi.fn().mockResolvedValue({ expectedOut: 900_000n, minimumOut: 891_000n }),
    };
    const pnl = new PnlService(database as never, reader as never, routes as never, config, undefined, kyberswap as never);

    const valued = await pnl.valueLocal(position, 1n);

    expect(kyberswap.quote).toHaveBeenCalledWith(position, froge, 10n ** 18n, native, 100);
    expect(routes.quoteDirect).not.toHaveBeenCalled();
    expect(valued.snapshot.liquidationQuote).toBe(891_100n);
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

describe("position group valuation fees", () => {
  const stable = "0x0000000000000000000000000000000000000005" as Address;
  const weth = "0x0000000000000000000000000000000000000004" as Address;
  const token = "0x0000000000000000000000000000000000000002" as Address;

  function groupRecord(quoteToken: Address, token0: Address, token1: Address): PositionGroupRecord {
    return {
      id: "group",
      chainId: 8453,
      protocol: "v4",
      positionManager: "0x0000000000000000000000000000000000000006" as Address,
      poolKey: "0xpool",
      owner: "0x0000000000000000000000000000000000000001" as Address,
      token0,
      token1,
      quoteToken,
      shape: "bid_ask",
      shapeVersion: "delta-amount-linear-v1",
      requestedBinCount: 2,
      generatedBinCount: 2,
      mintableBinCount: 2,
      outerTickLower: -100,
      outerTickUpper: 100,
      anchorBinIndex: 0,
      totalDeposit: 1_000_000n,
      deployedCostQuote: 1_000_000n,
      directCloseAmount0: 1_000_000n,
      directCloseAmount1: 0n,
      totalReceivedQuote: 0n,
      status: "active",
      planHash: "plan",
      planJson: {},
      referenceBlock: 10n,
      referenceTick: 0,
      referencePrice: 1n,
      openTransactionHash: null,
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
    };
  }

  function setup(
    token0: Address,
    token1: Address,
    quoteToken: Address,
    amount0: bigint,
    amount1: bigint,
    fee0: bigint,
    fee1: bigint,
    quoteTokensBase: Array<{ symbol: string; address: Address }>,
  ) {
    const baseConfig = { ...config, chains: ["base" as const], quoteTokens: { base: quoteTokensBase, robinhood: [] } };
    const database = {
      listPositionGroupChildren: vi.fn().mockResolvedValue([
        {
          bin: { binIndex: 0, tickLower: -100, tickUpper: 0, status: "minted" },
          position: { id: "child-0", positionKey: "10" },
        },
        {
          bin: { binIndex: 1, tickLower: 0, tickUpper: 100, status: "minted" },
          position: { id: "child-1", positionKey: "11" },
        },
      ]),
      getPositionGroupCashflowTotals: vi.fn().mockResolvedValue({ deposits: 1_000_000n, realized: 0n }),
      addPositionGroupPnlSnapshot: vi.fn().mockResolvedValue(undefined),
      getPoolObservationAtOrBefore: vi.fn().mockResolvedValue(null),
      recordPoolObservation: vi.fn().mockResolvedValue(undefined),
    };
    const reader = {
      read: vi.fn(async (position: { positionKey: string }) => {
        const lower = position.positionKey === "10" ? -100 : 0;
        const upper = position.positionKey === "10" ? 0 : 100;
        return {
          protocol: "v4",
          poolKey: "0xpool",
          sourcePool: null,
          token0: { token: token0, amount: amount0 },
          token1: { token: token1, amount: amount1 },
          liquidity: 100n,
          priceMarker: 100n,
          minAmount0: 0n,
          minAmount1: 0n,
          range: { tickLower: lower, tickUpper: upper, currentTick: 0, currentSqrtPrice: 1n, status: "in_range" },
          unclaimedFees0: fee0,
          unclaimedFees1: fee1,
          observedBlock: 10n,
        };
      }),
    };
    const routes = {
      quoteDirect: vi.fn(async (_position: never, tokenIn: Address, amountIn: bigint, tokenOut: Address) => ({
        expectedOut: amountIn,
        path: [tokenIn, tokenOut],
      })),
    };
    const pnl = new PnlService(database as never, reader as never, routes as never, baseConfig as unknown as RuntimeConfig);
    return { pnl, database, routes, group: groupRecord(quoteToken, token0, token1) };
  }

  it("converts WETH group fees into the chain stable token", async () => {
    const { pnl, database, group } = setup(token, weth, weth, 0n, 500n, 0n, 60n, [{ symbol: "USDC", address: stable }]);

    const valued = await pnl.valueGroup(group, 10n);

    expect(valued.snapshot.feeQuote).toBe(120n);
    expect(valued.snapshot.feeQuoteUsdg).toBe(118n);
    expect(database.addPositionGroupPnlSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      feeQuote: 120n,
      feeQuoteUsdg: 118n,
      quoteToken: weth,
    }));
  });

  it("keeps feeQuoteUsdg equal to feeQuote when no stable quote token is configured", async () => {
    const { pnl, group } = setup(token, weth, weth, 0n, 500n, 0n, 60n, []);

    const valued = await pnl.valueGroup(group, 10n);

    expect(valued.snapshot.feeQuoteUsdg).toBe(120n);
  });

  it("keeps feeQuoteUsdg equal to feeQuote when the quote token is already the stable", async () => {
    const { pnl, group } = setup(stable, weth, stable, 500n, 0n, 60n, 0n, [{ symbol: "USDC", address: stable }]);

    const valued = await pnl.valueGroup(group, 10n);

    expect(valued.snapshot.feeQuoteUsdg).toBe(120n);
  });
});
