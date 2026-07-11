import { describe, expect, it } from "vitest";

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
  maxSwapSlippageBps: 100,
  maxTwapDeviationBps: 250,
  twapWindowSeconds: 300,
  pnlIncludeGas: false,
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

  it("triggers only at configured stop-loss and take-profit boundaries", () => {
    expect(pnl.shouldTrigger(snapshot(-1_000n))).toBe("stop_loss");
    expect(pnl.shouldTrigger(snapshot(2_000n))).toBe("take_profit");
    expect(pnl.shouldTrigger(snapshot(1_999n))).toBeNull();
    expect(pnl.shouldTrigger(snapshot(-999n))).toBeNull();
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
