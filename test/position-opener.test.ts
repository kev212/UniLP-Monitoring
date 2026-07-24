import { Ether, Token } from "@uniswap/sdk-core";
import { FeeAmount, Pool as V3Pool, Position as V3Position } from "@uniswap/v3-sdk";
import { Pool as V4Pool, Position as V4Position } from "@uniswap/v4-sdk";
import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";

import { selectOpenQuoteToken } from "../src/services/position-opener.js";

const chainId = 4663;
const token0 = new Token(chainId, "0x0000000000000000000000000000000000000001", 6, "USDG");
const token1 = new Token(chainId, "0x0000000000000000000000000000000000000002", 18, "VLAD");
const sqrtPriceX96 = (1n << 96n).toString();

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
  });

  it("maps a V3 WETH pool quote to ETH funding", async () => {
    const weth = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
    // The SDK's Robinhood native currency resolves to the deployed WETH token.
    expect(Ether.onChain(chainId).wrapped.address).toBe(weth);
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
