import { Ether, Token } from "@uniswap/sdk-core";
import { FeeAmount, Pool as V3Pool, Position as V3Position } from "@uniswap/v3-sdk";
import { Pool as V4Pool, Position as V4Position } from "@uniswap/v4-sdk";
import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, zeroAddress, type Address, type Hex } from "viem";

import { chainRegistry } from "../src/chains.js";
import { assertMintUtilization, assertSafeOpenMarket, bidAskDirectionForQuote, openPoolQuoteAddress, PositionOpener, selectOpenQuoteToken, wrappedNativeShortfall } from "../src/services/position-opener.js";
import { ticksForDropPercent, ticksForRisePercent } from "../src/services/uniswap-math.js";

const chainId = 4663;
const token0 = new Token(chainId, "0x0000000000000000000000000000000000000001", 6, "USDG");
const token1 = new Token(chainId, "0x0000000000000000000000000000000000000002", 18, "VLAD");
const sqrtPriceX96 = (1n << 96n).toString();
const nvdaAddress = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;
const packAddress = "0x0145AcbcceFbEd6F303C420bEeaaAc72E905430b" as Address;
const wethAddress = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
const v3PoolAddress = "0x0000000000000000000000000000000000000044" as Address;

function poolOpener(protocol: "v3" | "v4", tokenA = packAddress, tokenB = nvdaAddress, hooks = zeroAddress) {
  const poolKey = { currency0: tokenA, currency1: tokenB, fee: 10_000, tickSpacing: 200, hooks };
  const poolId = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
  ));
  const client = {
    readContract: vi.fn(async ({ functionName, address }: { functionName: string; address: Address }) => {
      if (functionName === "token0") return tokenA;
      if (functionName === "token1") return tokenB;
      if (functionName === "fee") return 10_000;
      if (functionName === "tickSpacing") return 200;
      if (functionName === "liquidity" || functionName === "getLiquidity") return 10n ** 30n;
      if (functionName === "slot0" || functionName === "getSlot0") return [1n << 96n, 0, 0, 0, 0, 0, true];
      if (functionName === "getPool") return v3PoolAddress;
      if (functionName === "poolKeys") return poolKey;
      if (functionName === "decimals") return 18;
      if (functionName === "symbol") return address.toLowerCase() === nvdaAddress.toLowerCase() ? "NVDA" : "PACK";
      throw new Error(`unexpected ${functionName}`);
    }),
  };
  const chains = {
    get: vi.fn(() => ({ registry: chainRegistry.robinhood, client })),
    getForScan: vi.fn(() => ({ registry: chainRegistry.robinhood, client })),
  };
  const config = {
    quoteTokens: { robinhood: [{ symbol: "NVDA", address: nvdaAddress }] },
    executorAddress: "0x0000000000000000000000000000000000000011",
    bidAskLadderEnabled: true,
    bidAskLadderProtocols: ["v3", "v4"],
    bidAskLadderMaxBins: 10,
  };
  return {
    opener: new PositionOpener(config as never, chains as never),
    pool: protocol === "v3" ? v3PoolAddress as Hex : poolId,
    client,
  };
}

describe("open safety guards", () => {
  it("rejects empty pools and extreme ticks", () => {
    expect(() => assertSafeOpenMarket(0, 0n)).toThrow("no active liquidity");
    expect(() => assertSafeOpenMarket(-881161, 1n)).toThrow("extreme tick");
    expect(() => assertSafeOpenMarket(880_000, 1n)).toThrow("extreme tick");
    expect(() => assertSafeOpenMarket(0, 1n)).not.toThrow();
  });

  it("rejects mints that lock less than 90% of the deposit", () => {
    expect(() => assertMintUtilization(6_078_705n, 299_500_717_867_255_336_348n)).toThrow("less than 90%");
    expect(() => assertMintUtilization(90n, 100n)).not.toThrow();
    expect(() => assertMintUtilization(89n, 100n)).toThrow("less than 90%");
  });

  it("rejects a Bid-Ask preview when the pool tick is unusable", async () => {
    const { opener, pool, client } = poolOpener("v4");
    client.readContract = vi.fn(async ({ functionName, address }: { functionName: string; address: Address }) => {
      if (functionName === "getSlot0") return [5830247392n, -881161, 0, 0];
      if (functionName === "getLiquidity") return 63n;
      if (functionName === "poolKeys") return { currency0: packAddress, currency1: nvdaAddress, fee: 10_000, tickSpacing: 200, hooks: zeroAddress };
      if (functionName === "decimals") return 18;
      if (functionName === "symbol") return address.toLowerCase() === nvdaAddress.toLowerCase() ? "NVDA" : "PACK";
      throw new Error(`unexpected ${functionName}`);
    });

    await expect(opener.prepareBidAskOpen(pool, "robinhood", 30, 3n * 10n ** 18n, { symbol: "NVDA", address: nvdaAddress }, 3)).rejects.toThrow("extreme tick");
  });
});

describe("SDK single-side liquidity", () => {
  it("selects only the actual supported quote currency from a pool", () => {
    const usdg = "0x0000000000000000000000000000000000000003" as const;
    const weth = "0x0000000000000000000000000000000000000004" as const;
    const nvda = "0x0000000000000000000000000000000000000005" as const;
    const allowed = [
      { symbol: "NVDA", address: nvda },
      { symbol: "USDG", address: usdg },
      { symbol: "WETH", address: weth },
      { symbol: "ETH", address: zeroAddress },
    ];

    expect(selectOpenQuoteToken(allowed, nvda, weth)).toEqual({ symbol: "WETH", address: weth });
    expect(selectOpenQuoteToken(allowed, nvda, zeroAddress)).toEqual({ symbol: "ETH", address: zeroAddress });
    expect(selectOpenQuoteToken(allowed, nvda, usdg)).toEqual({ symbol: "USDG", address: usdg });
    expect(selectOpenQuoteToken(allowed, nvda, token1.address as Address)).toEqual({ symbol: "NVDA", address: nvda });
  });

  it.each([
    ["v3", false],
    ["v3", true],
    ["v4", false],
    ["v4", true],
  ] as const)("prepares a normal single-side %s position funded by NVDA with quoteIsToken0=%s", async (protocol, quoteIsToken0) => {
    const { opener, pool } = poolOpener(protocol, quoteIsToken0 ? nvdaAddress : packAddress, quoteIsToken0 ? packAddress : nvdaAddress);

    const preview = await opener.prepareOpen(pool, "robinhood", 30, 3n * 10n ** 18n, { symbol: "NVDA", address: nvdaAddress });

    expect(preview.protocol).toBe(protocol);
    expect(preview.quoteToken).toBe(nvdaAddress);
    expect(preview.quoteTokenDecimals).toBe(18);
    expect(preview.quoteIsToken0).toBe(quoteIsToken0);
    if (quoteIsToken0) expect(preview.tickLower).toBeGreaterThan(preview.currentTick);
    else expect(preview.tickUpper).toBeLessThanOrEqual(preview.currentTick);
    expect(preview.pair).toBe(quoteIsToken0 ? "PACK/NVDA" : "NVDA/PACK");
  });

  it("rejects dual-side opening when NVDA is the quote", async () => {
    const { opener, pool } = poolOpener("v3");

    await expect(opener.prepareOpen(pool, "robinhood", 30, 3n * 10n ** 18n, { symbol: "NVDA", address: nvdaAddress }, "dual"))
      .rejects.toThrow("single-side normal opens only");
  });

  it("rejects hooked V4 pools before preparing a normal open", async () => {
    const { opener, pool } = poolOpener("v4", packAddress, nvdaAddress, "0x0000000000000000000000000000000000000001");

    await expect(opener.prepareOpen(pool, "robinhood", 30, 3n * 10n ** 18n, { symbol: "NVDA", address: nvdaAddress }))
      .rejects.toThrow("plain/no-hook V4 pools only");
  });

  it("fails closed when ERC-20 decimals cannot be read", async () => {
    const { opener, pool, client } = poolOpener("v3");
    client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "token0") return packAddress;
      if (functionName === "token1") return nvdaAddress;
      if (functionName === "fee") return 10_000;
      if (functionName === "tickSpacing") return 200;
      if (functionName === "liquidity") return 10n ** 30n;
      if (functionName === "slot0") return [1n << 96n, 0, 0, 0, 0, 0, true];
      if (functionName === "getPool") return v3PoolAddress;
      if (functionName === "decimals") throw new Error("RPC unavailable");
      throw new Error(`unexpected ${functionName}`);
    });

    await expect(opener.prepareOpen(pool, "robinhood", 30, 3n * 10n ** 18n, { symbol: "NVDA", address: nvdaAddress }))
      .rejects.toThrow("RPC unavailable");
  });

  it("uses wrapped ETH for V3 and native ETH for V4 quote matching", async () => {
    expect(Ether.onChain(chainId).wrapped.address).toBe(wethAddress);
    expect(openPoolQuoteAddress("v3", chainId, { symbol: "ETH", address: zeroAddress })).toBe(wethAddress);
    expect(openPoolQuoteAddress("v4", chainId, { symbol: "ETH", address: zeroAddress })).toBe(zeroAddress);
  });

  it("wraps only the WETH shortfall required for an open", () => {
    expect(wrappedNativeShortfall(10n, 10n)).toBe(0n);
    expect(wrappedNativeShortfall(7n, 10n)).toBe(3n);
  });

  it("keeps token0 deposits above the current tick for V3 and V4", () => {
    const v3Pool = new V3Pool(token0, token1, FeeAmount.MEDIUM, sqrtPriceX96, "1000000", 0);
    const v4Pool = new V4Pool(token0, token1, FeeAmount.MEDIUM, 60, zeroAddress, sqrtPriceX96, "1000000", 0);
    const options = { tickLower: 60, tickUpper: 120, amount0: "20000000", amount1: "0", useFullPrecision: true } as const;

    const v3 = V3Position.fromAmounts({ pool: v3Pool, ...options });
    const v4 = V4Position.fromAmounts({ pool: v4Pool, ...options });

    expect(v3.mintAmounts.amount0.toString()).toBe("20000000");
    expect(v3.mintAmounts.amount1.toString()).toBe("0");
    expect(v4.mintAmounts.amount0.toString()).toBe("20000000");
    expect(v4.mintAmounts.amount1.toString()).toBe("0");
  });

  it("keeps token1 deposits below the current tick for V3 and V4", () => {
    const v3Pool = new V3Pool(token0, token1, FeeAmount.MEDIUM, sqrtPriceX96, "1000000", 0);
    const v4Pool = new V4Pool(token0, token1, FeeAmount.MEDIUM, 60, zeroAddress, sqrtPriceX96, "1000000", 0);
    const options = { tickLower: -120, tickUpper: -60, amount0: "0", amount1: "20000000000000000000", useFullPrecision: true } as const;

    const v3 = V3Position.fromAmounts({ pool: v3Pool, ...options });
    const v4 = V4Position.fromAmounts({ pool: v4Pool, ...options });

    expect(v3.mintAmounts.amount0.toString()).toBe("0");
    expect(v3.mintAmounts.amount1.toString()).toBe("20000000000000000000");
    expect(v4.mintAmounts.amount0.toString()).toBe("0");
    expect(v4.mintAmounts.amount1.toString()).toBe("20000000000000000000");
  });
});

describe("Bid-Ask NVDA opening", () => {
  it.each([
    ["v3", false],
    ["v3", true],
    ["v4", false],
    ["v4", true],
  ] as const)("prepares an atomic %s ladder allocated only in NVDA with quoteIsToken0=%s", async (protocol, quoteIsToken0) => {
    const { opener, pool } = poolOpener(protocol, quoteIsToken0 ? nvdaAddress : packAddress, quoteIsToken0 ? packAddress : nvdaAddress);

    const preview = await opener.prepareBidAskOpen(
      pool,
      "robinhood",
      30,
      3n * 10n ** 18n,
      { symbol: "NVDA", address: nvdaAddress },
      3,
      quoteIsToken0 ? "above" : "below",
    );

    expect(preview.protocol).toBe(protocol);
    expect(preview.quoteToken).toBe(nvdaAddress);
    expect(preview.quoteTokenDecimals).toBe(18);
    expect(preview.direction).toBe(quoteIsToken0 ? "above" : "below");
    expect(quoteIsToken0 ? preview.token0Symbol : preview.token1Symbol).toBe("NVDA");
    expect(quoteIsToken0 ? preview.totalAmount0 : preview.totalAmount1).toBe(3n * 10n ** 18n);
    expect(quoteIsToken0 ? preview.totalAmount1 : preview.totalAmount0).toBe(0n);
    expect(preview.bins.every((bin) => quoteIsToken0
      ? bin.allocatedAmount0 > 0n && bin.allocatedAmount1 === 0n
      : bin.allocatedAmount0 === 0n && bin.allocatedAmount1 > 0n)).toBe(true);
  });

  it("maps the quote side to its only feasible ladder direction", () => {
    expect(bidAskDirectionForQuote(true)).toBe("above");
    expect(bidAskDirectionForQuote(false)).toBe("below");
  });

  it("normalizes a mismatched direction instead of failing", async () => {
    const { opener, pool } = poolOpener("v4");

    const preview = await opener.prepareBidAskOpen(
      pool,
      "robinhood",
      30,
      3n * 10n ** 18n,
      { symbol: "NVDA", address: nvdaAddress },
      3,
      "above",
    );

    expect(preview.direction).toBe("below");
    expect(preview.bins.every((bin) => bin.allocatedAmount0 === 0n && bin.allocatedAmount1 > 0n)).toBe(true);
  });

  it("normalizes the default below request to above for an ETH-as-token0 pool", async () => {
    const { opener, pool } = poolOpener("v4", zeroAddress, packAddress);

    const preview = await opener.prepareBidAskOpen(
      pool,
      "robinhood",
      30,
      3n * 10n ** 18n,
      { symbol: "ETH", address: zeroAddress },
      3,
      "below",
    );

    expect(preview.direction).toBe("above");
    expect(preview.quoteIsToken0).toBe(true);
    expect(preview.bins.every((bin) => bin.allocatedAmount0 > 0n && bin.allocatedAmount1 === 0n)).toBe(true);
  });
});

describe("SDK dual-side liquidity", () => {
  it("wraps V3 WETH funding before swapping the quote side", async () => {
    const executor = "0x0000000000000000000000000000000000000011" as Address;
    const client = {};
    const opener = new PositionOpener({ executorAddress: executor } as never, {} as never);
    const harness = opener as any;
    const depositAmount = 100_000_000_000_000_000n;
    const preview = {
      protocol: "v3",
      chain: "robinhood",
      poolAddress: v3PoolAddress,
      quoteToken: wethAddress,
      quoteTokenSymbol: "ETH",
      dropPercent: 30,
      depositAmount,
      mode: "dual",
      currentTick: 0,
      tickLower: -200,
      tickUpper: 200,
      quoteSideAmount: 60_000_000_000_000_000n,
    };
    const wrap = vi.fn().mockResolvedValue(undefined);
    const swap = vi.fn().mockResolvedValue({ hash: null, actualBaseOut: 1n });

    harness.prepareOpen = vi.fn().mockResolvedValue(preview);
    harness.isStillStraddling = vi.fn().mockReturnValue(true);
    harness.executionClient = vi.fn().mockReturnValue(client);
    harness.ensureWrappedNativeFunding = wrap;
    harness.swapQuoteForBase = swap;
    harness.executeV3Dual = vi.fn().mockResolvedValue({ hash: null });

    await opener.executeOpen(preview as never);

    expect(wrap).toHaveBeenCalledWith(client, "robinhood", wethAddress, depositAmount, executor);
    expect(wrap.mock.invocationCallOrder[0]).toBeLessThan(swap.mock.invocationCallOrder[0]!);
  });

  it("uses true percentage bounds instead of equal logarithmic tick distances", () => {
    const lower = ticksForDropPercent(30);
    const upper = ticksForRisePercent(30);

    expect(lower).toBeGreaterThan(upper);
    expect(Math.exp(-lower * Math.log(1.0001))).toBeCloseTo(0.7, 3);
    expect(Math.exp(upper * Math.log(1.0001))).toBeCloseTo(1.3, 3);
  });

  it("produces both token amounts when range straddles the current tick", () => {
    const v3Pool = new V3Pool(token0, token1, FeeAmount.MEDIUM, sqrtPriceX96, "1000000", 0);
    const v4Pool = new V4Pool(token0, token1, FeeAmount.MEDIUM, 60, zeroAddress, sqrtPriceX96, "1000000", 0);
    const tickLower = -2760;
    const tickUpper = 2760;

    const v3 = V3Position.fromAmount0({ pool: v3Pool, tickLower, tickUpper, amount0: "200000000", useFullPrecision: true });
    const v4 = V4Position.fromAmount0({ pool: v4Pool, tickLower, tickUpper, amount0: "200000000", useFullPrecision: true });

    expect(BigInt(v3.mintAmounts.amount0)).toBeGreaterThan(0n);
    expect(BigInt(v3.mintAmounts.amount1)).toBeGreaterThan(0n);
    expect(BigInt(v4.mintAmounts.amount0)).toBeGreaterThan(0n);
    expect(BigInt(v4.mintAmounts.amount1)).toBeGreaterThan(0n);
  });

  it("computes a dual-side split where quote + base quote-value approximates the deposit", () => {
    const pool = new V3Pool(token0, token1, FeeAmount.MEDIUM, sqrtPriceX96, "1000000", 0);
    const tickLower = -2760;
    const tickUpper = 2760;
    const depositAmount = 200_000_000n;
    const position = V3Position.fromAmount0({ pool, tickLower, tickUpper, amount0: depositAmount.toString(), useFullPrecision: true });

    const opener = new PositionOpener({} as never, {} as never);
    const split = (opener as any).computeDualSplit(position, true, depositAmount, 1n << 96n);

    expect(split.quoteSideAmount).toBeGreaterThan(0n);
    expect(split.baseAmount).toBeGreaterThan(0n);
    expect(split.swapAmount).toBeGreaterThan(0n);
    expect(split.swapAmount).toBeLessThan(depositAmount);
  });

  it("fromAmount1 also produces both sides when range straddles the tick", () => {
    const pool = new V3Pool(token0, token1, FeeAmount.MEDIUM, sqrtPriceX96, "1000000", 0);
    const tickLower = -2760;
    const tickUpper = 2760;

    const position = V3Position.fromAmount1({ pool, tickLower, tickUpper, amount1: "20000000000000000000" });

    expect(BigInt(position.mintAmounts.amount0)).toBeGreaterThan(0n);
    expect(BigInt(position.mintAmounts.amount1)).toBeGreaterThan(0n);
  });
});
