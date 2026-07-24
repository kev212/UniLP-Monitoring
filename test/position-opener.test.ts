import { Token } from "@uniswap/sdk-core";
import { FeeAmount, Pool as V3Pool, Position as V3Position } from "@uniswap/v3-sdk";
import { Pool as V4Pool, Position as V4Position } from "@uniswap/v4-sdk";
import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";

const chainId = 4663;
const token0 = new Token(chainId, "0x0000000000000000000000000000000000000001", 6, "USDG");
const token1 = new Token(chainId, "0x0000000000000000000000000000000000000002", 18, "VLAD");
const sqrtPriceX96 = (1n << 96n).toString();

describe("SDK single-side liquidity", () => {
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
