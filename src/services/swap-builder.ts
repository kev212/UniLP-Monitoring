import { encodeAbiParameters, encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";

import { v2RouterAbi, v3SwapRouterAbi, v4UniversalRouterAbi } from "../abi.js";
import type { TransactionPlan } from "../types.js";
import type { SwapRoute } from "./route-planner.js";

export function buildSwapPlan(
  chainId: number,
  owner: Address,
  route: SwapRoute,
  deadline: bigint,
): TransactionPlan {
  if (route.protocol === "v2") {
    return {
      chainId,
      to: route.router,
      data: encodeFunctionData({
        abi: v2RouterAbi,
        functionName: "swapExactTokensForTokens",
        args: [route.amountIn, route.minimumOut, route.path, owner, deadline],
      }),
      description: "swap V2 route",
    };
  }

  if (route.protocol === "v4") {
    if (!route.v4PoolKey || route.amountIn > (1n << 128n) - 1n || route.minimumOut > (1n << 128n) - 1n) {
      throw new Error("V4 route has an invalid pool key or amount");
    }
    const zeroForOne = route.tokenIn.toLowerCase() === route.v4PoolKey.currency0.toLowerCase();
    const exactInputSingle = encodeAbiParameters(
      [{
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "minHopPriceX36", type: "uint256" },
          { name: "hookData", type: "bytes" },
        ],
      }],
      [{
        poolKey: route.v4PoolKey,
        zeroForOne,
        amountIn: route.amountIn,
        amountOutMinimum: route.minimumOut,
        minHopPriceX36: 0n,
        hookData: "0x",
      }],
    );
    const settleAll = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [route.tokenIn, route.amountIn],
    );
    const takeAll = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [route.tokenOut, route.minimumOut],
    );
    const v4Input = encodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes[]" }],
      ["0x060c0f", [exactInputSingle, settleAll, takeAll]],
    );
    return {
      chainId,
      to: route.router,
      data: encodeFunctionData({ abi: v4UniversalRouterAbi, functionName: "execute", args: ["0x10" as Hex, [v4Input], deadline] }),
      value: route.tokenIn.toLowerCase() === zeroAddress ? route.amountIn : 0n,
      description: "swap V4 route",
    };
  }

  if (!route.encodedPath) throw new Error("V3 route is missing an encoded path");
  return {
    chainId,
    to: route.router,
    data: encodeFunctionData({
      abi: v3SwapRouterAbi,
      functionName: "exactInput",
      args: [{
        path: route.encodedPath,
        recipient: owner,
        deadline,
        amountIn: route.amountIn,
        amountOutMinimum: route.minimumOut,
      }],
    }),
    description: "swap V3 route",
  };
}
