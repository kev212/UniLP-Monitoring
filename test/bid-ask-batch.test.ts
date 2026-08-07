import { describe, expect, it } from "vitest";
import {
  decodeAbiParameters,
  decodeFunctionData,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import { v3PositionManagerAbi, v4PositionManagerAbi } from "../src/abi.js";
import {
  buildV3BidAskClosePlan,
  buildV3BidAskOpenPlan,
  buildV4BidAskClosePlan,
  buildV4BidAskOpenPlan,
  type V4PoolKey,
} from "../src/services/bid-ask-batch.js";

const manager = "0x0000000000000000000000000000000000000100" as Address;
const token0 = "0x0000000000000000000000000000000000000010" as Address;
const token1 = "0x0000000000000000000000000000000000000020" as Address;
const owner = "0x0000000000000000000000000000000000000030" as Address;
const v3RefundAbi = parseAbi(["function refundETH() payable"]);

const v4PoolKey: V4PoolKey = {
  currency0: token0,
  currency1: token1,
  fee: 500,
  tickSpacing: 10,
  hooks: zeroAddress,
};

const v4Mint = {
  tickLower: -120,
  tickUpper: -60,
  liquidity: 10n,
  amount0Max: 100n,
  amount1Max: 0n,
};

const v3Mint = {
  tickLower: -120,
  tickUpper: -60,
  amount0Desired: 100n,
  amount1Desired: 0n,
  amount0Min: 90n,
  amount1Min: 0n,
};

function selectors(calls: readonly Hex[]): string[] {
  return calls.map((call) => call.slice(0, 10));
}

function decodeUnlockData(data: Hex): { actions: Hex; params: Hex[] } {
  const outer = decodeFunctionData({ abi: v4PositionManagerAbi, data });
  const unlockData = outer.args[0];
  const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], unlockData);
  return { actions, params };
}

describe("pure Bid-Ask batch calldata", () => {
  it("encodes direct V3 mints in one outer multicall with one final refund", () => {
    const plan = buildV3BidAskOpenPlan({
      chainId: 8453,
      positionManager: manager,
      token0,
      token1,
      fee: 500,
      recipient: owner,
      deadline: 1234n,
      value: 100n,
      refundETH: true,
      mints: [v3Mint, { ...v3Mint, tickLower: -60, tickUpper: 0 }],
    });

    expect(plan.value).toBe(100n);
    expect(plan.data.slice(0, 10)).toBe(toFunctionSelector("multicall(bytes[])") as string);
    const outer = decodeFunctionData({ abi: v3PositionManagerAbi, data: plan.data });
    const calls = outer.args[0];

    expect(calls).toHaveLength(3);
    expect(selectors(calls.slice(0, 2))).toEqual([
      toFunctionSelector("mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))"),
      toFunctionSelector("mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))"),
    ]);
    expect(calls[2]?.slice(0, 10)).toBe(toFunctionSelector("refundETH()"));
    expect(calls.slice(0, 2).every((call) => call.slice(0, 10) !== toFunctionSelector("refundETH()"))).toBe(true);
    expect(decodeFunctionData({ abi: v3RefundAbi, data: calls[2]! }).functionName).toBe("refundETH");
  });

  it("encodes decrease, collect, and burn for every V3 child", () => {
    const plan = buildV3BidAskClosePlan({
      chainId: 8453,
      positionManager: manager,
      recipient: owner,
      deadline: 1234n,
      value: 0n,
      positions: [
        { tokenId: 7n, liquidity: 10n, amount0Min: 1n, amount1Min: 2n },
        { tokenId: 8n, liquidity: 20n, amount0Min: 3n, amount1Min: 4n },
      ],
    });

    const outer = decodeFunctionData({ abi: v3PositionManagerAbi, data: plan.data });
    const calls = outer.args[0];
    expect(calls).toHaveLength(6);
    expect(selectors(calls)).toEqual([
      toFunctionSelector("decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))"),
      toFunctionSelector("collect((uint256,address,uint128,uint128))"),
      toFunctionSelector("burn(uint256)"),
      toFunctionSelector("decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))"),
      toFunctionSelector("collect((uint256,address,uint128,uint128))"),
      toFunctionSelector("burn(uint256)"),
    ]);
  });

  it("encodes one V4 modifyLiquidities call with mint, settle-pair, and one native sweep", () => {
    const nativePoolKey: V4PoolKey = { ...v4PoolKey, currency0: zeroAddress };
    const plan = buildV4BidAskOpenPlan({
      chainId: 8453,
      positionManager: manager,
      poolKey: nativePoolKey,
      recipient: owner,
      deadline: 1234n,
      value: 100n,
      nativeSweep: { currency: zeroAddress, recipient: owner },
      mints: [v4Mint, { ...v4Mint, tickLower: -60, tickUpper: 0 }],
    });

    expect(plan.data.slice(0, 10)).toBe(toFunctionSelector("modifyLiquidities(bytes,uint256)"));
    const { actions, params } = decodeUnlockData(plan.data);
    expect(actions).toBe("0x02020d14");
    expect(params).toHaveLength(4);
  });

  it("encodes repeated V4 burns followed by one take-pair", () => {
    const plan = buildV4BidAskClosePlan({
      chainId: 8453,
      positionManager: manager,
      poolKey: v4PoolKey,
      recipient: owner,
      deadline: 1234n,
      value: 0n,
      positions: [
        { tokenId: 7n, amount0Min: 1n, amount1Min: 2n },
        { tokenId: 8n, amount0Min: 3n, amount1Min: 4n },
        { tokenId: 9n, amount0Min: 5n, amount1Min: 6n },
      ],
    });

    const { actions, params } = decodeUnlockData(plan.data);
    expect(actions).toBe("0x03030311");
    expect(params).toHaveLength(4);
  });
});
