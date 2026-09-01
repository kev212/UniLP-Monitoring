import { encodeAbiParameters, encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from "viem";

import { v3PositionManagerAbi, v4PositionManagerAbi } from "../abi.js";
import type { TransactionPlan } from "../types.js";

const v3RefundAbi = parseAbi(["function refundETH() payable"]);
const MAX_UINT128 = (1n << 128n) - 1n;
const EMPTY_BYTES = "0x" as Hex;

const v4PoolKeyParameter = {
  name: "poolKey",
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

const v4MintParameters = [
  v4PoolKeyParameter,
  { name: "tickLower", type: "int24" },
  { name: "tickUpper", type: "int24" },
  { name: "liquidity", type: "uint256" },
  { name: "amount0Max", type: "uint128" },
  { name: "amount1Max", type: "uint128" },
  { name: "owner", type: "address" },
  { name: "hookData", type: "bytes" },
] as const;

const v4DecreaseParameters = [
  { name: "tokenId", type: "uint256" },
  { name: "liquidity", type: "uint256" },
  { name: "amount0Min", type: "uint128" },
  { name: "amount1Min", type: "uint128" },
  { name: "hookData", type: "bytes" },
] as const;

const v4PairParameters = [{ type: "address" }, { type: "address" }] as const;
const v4TakePairParameters = [{ type: "address" }, { type: "address" }, { type: "address" }] as const;

export interface BidAskBatchPlanOptions {
  chainId: number;
  positionManager: Address;
  deadline: bigint;
  value: bigint;
}

export interface V3MintBatchItem {
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
}

export interface V3MintBatchPlanOptions extends BidAskBatchPlanOptions {
  token0: Address;
  token1: Address;
  fee: number;
  recipient: Address;
  mints: readonly V3MintBatchItem[];
  refundETH?: boolean;
}

export interface V3CloseBatchItem {
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  amount0Max?: bigint;
  amount1Max?: bigint;
}

export interface V3CloseBatchPlanOptions extends BidAskBatchPlanOptions {
  recipient: Address;
  positions: readonly V3CloseBatchItem[];
}

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface V4MintBatchItem {
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  hookData?: Hex;
}

export interface V4MintBatchPlanOptions extends BidAskBatchPlanOptions {
  poolKey: V4PoolKey;
  recipient: Address;
  mints: readonly V4MintBatchItem[];
  nativeSweep?: {
    currency: Address;
    recipient: Address;
  };
  tokenSweep?: {
    currency: Address;
    recipient: Address;
  };
}

export interface V4CloseBatchItem {
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  hookData?: Hex;
}

export interface V4CloseBatchPlanOptions extends BidAskBatchPlanOptions {
  poolKey: V4PoolKey;
  recipient: Address;
  positions: readonly V4CloseBatchItem[];
}

export function buildV3BidAskOpenPlan(options: V3MintBatchPlanOptions): TransactionPlan {
  requireItems(options.mints, "V3 mints");

  const calls = options.mints.map((mint) => encodeFunctionData({
    abi: v3PositionManagerAbi,
    functionName: "mint",
    args: [{
      token0: options.token0,
      token1: options.token1,
      fee: options.fee,
      tickLower: mint.tickLower,
      tickUpper: mint.tickUpper,
      amount0Desired: mint.amount0Desired,
      amount1Desired: mint.amount1Desired,
      amount0Min: mint.amount0Min,
      amount1Min: mint.amount1Min,
      recipient: options.recipient,
      deadline: options.deadline,
    }],
  }));

  if (options.refundETH) {
    calls.push(encodeFunctionData({ abi: v3RefundAbi, functionName: "refundETH" }));
  }

  return makePlan(
    options,
    encodeFunctionData({ abi: v3PositionManagerAbi, functionName: "multicall", args: [calls] }),
    "batch V3 bid-ask mint",
  );
}

export function buildV3BidAskClosePlan(options: V3CloseBatchPlanOptions): TransactionPlan {
  requireItems(options.positions, "V3 positions");

  const calls: Hex[] = [];
  for (const position of options.positions) {
    calls.push(
      encodeFunctionData({
        abi: v3PositionManagerAbi,
        functionName: "decreaseLiquidity",
        args: [{
          tokenId: position.tokenId,
          liquidity: position.liquidity,
          amount0Min: position.amount0Min,
          amount1Min: position.amount1Min,
          deadline: options.deadline,
        }],
      }),
      encodeFunctionData({
        abi: v3PositionManagerAbi,
        functionName: "collect",
        args: [{
          tokenId: position.tokenId,
          recipient: options.recipient,
          amount0Max: position.amount0Max ?? MAX_UINT128,
          amount1Max: position.amount1Max ?? MAX_UINT128,
        }],
      }),
    );
  }

  return makePlan(
    options,
    encodeFunctionData({ abi: v3PositionManagerAbi, functionName: "multicall", args: [calls] }),
    "batch V3 bid-ask close",
  );
}

export function buildV4BidAskOpenPlan(options: V4MintBatchPlanOptions): TransactionPlan {
  requireItems(options.mints, "V4 mints");
  if (options.nativeSweep) validateNativeSweep(options.poolKey, options.nativeSweep.currency);

  const params = options.mints.map((mint) => encodeAbiParameters(v4MintParameters, [
    options.poolKey,
    mint.tickLower,
    mint.tickUpper,
    mint.liquidity,
    mint.amount0Max,
    mint.amount1Max,
    options.recipient,
    mint.hookData ?? EMPTY_BYTES,
  ]));

  params.push(encodeAbiParameters(v4PairParameters, [options.poolKey.currency0, options.poolKey.currency1]));
  if (options.nativeSweep) {
    params.push(encodeAbiParameters(v4PairParameters, [options.nativeSweep.currency, options.nativeSweep.recipient]));
  }
  if (options.tokenSweep) {
    params.push(encodeAbiParameters(v4PairParameters, [options.tokenSweep.currency, options.tokenSweep.recipient]));
  }

  const actions = actionBytes(
    0x02,
    ...Array(options.mints.length - 1).fill(0x02),
    0x0d,
    ...(options.nativeSweep ? [0x14] : []),
    ...(options.tokenSweep ? [0x14] : []),
  );
  return makePlan(
    options,
    encodeFunctionData({
      abi: v4PositionManagerAbi,
      functionName: "modifyLiquidities",
      args: [encodeUnlockData(actions, params), options.deadline],
    }),
    "batch V4 bid-ask mint",
  );
}

export function buildV4BidAskClosePlan(options: V4CloseBatchPlanOptions): TransactionPlan {
  requireItems(options.positions, "V4 positions");

  const params = options.positions.map((position) => encodeAbiParameters(v4DecreaseParameters, [
    position.tokenId,
    position.liquidity,
    position.amount0Min,
    position.amount1Min,
    position.hookData ?? EMPTY_BYTES,
  ]));
  params.push(encodeAbiParameters(v4TakePairParameters, [options.poolKey.currency0, options.poolKey.currency1, options.recipient]));

  const actions = actionBytes(...Array(options.positions.length).fill(0x01), 0x11);
  return makePlan(
    options,
    encodeFunctionData({
      abi: v4PositionManagerAbi,
      functionName: "modifyLiquidities",
      args: [encodeUnlockData(actions, params), options.deadline],
    }),
    "batch V4 bid-ask close",
  );
}

export const buildV3MintBatchPlan = buildV3BidAskOpenPlan;
export const buildV3CloseBatchPlan = buildV3BidAskClosePlan;
export const buildV4MintBatchPlan = buildV4BidAskOpenPlan;
export const buildV4CloseBatchPlan = buildV4BidAskClosePlan;

function makePlan(options: BidAskBatchPlanOptions, data: Hex, description: string): TransactionPlan {
  return {
    chainId: options.chainId,
    to: options.positionManager,
    data,
    value: options.value,
    description,
  };
}

function requireItems<T>(items: readonly T[], label: string): void {
  if (items.length === 0) throw new Error(`${label} must contain at least one item`);
}

function validateNativeSweep(poolKey: V4PoolKey, currency: Address): void {
  if (currency.toLowerCase() !== zeroAddress.toLowerCase()) throw new Error("V4 native sweep must use the zero-address currency");
  if (currency.toLowerCase() !== poolKey.currency0.toLowerCase() && currency.toLowerCase() !== poolKey.currency1.toLowerCase()) {
    throw new Error("V4 native sweep currency is not part of the pool key");
  }
}

function actionBytes(...actions: number[]): Hex {
  return `0x${actions.map((action) => action.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function encodeUnlockData(actions: Hex, params: readonly Hex[]): Hex {
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [...params]]);
}
