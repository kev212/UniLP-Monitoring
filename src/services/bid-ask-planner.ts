import { encodeAbiParameters, keccak256, type Hex } from "viem";

import {
  amountsForLiquidity,
  liquidityForAmount0,
  liquidityForAmount1,
  sqrtRatioAtTick,
  tickToCeilSpacing,
  tickToFloorSpacing,
} from "./uniswap-math.js";

export type BidAskShapeVersion = "delta-amount-linear-v1" | "delta-amount-linear-v2" | "delta-amount-linear-v3" | "delta-amount-linear-v4";
export type BidAskBinSide = "token0" | "token1";
export type BidAskRangeOrientation = "below" | "above";

export const BID_ASK_SHAPE_VERSION: BidAskShapeVersion = "delta-amount-linear-v4";

const BID_ASK_TOTAL_WEIGHT_MICROS = 1_000_000;
const BID_ASK_ANCHOR_WEIGHT_MICROS = 100_000;
const BID_ASK_NON_ANCHOR_WEIGHT_MICROS = BID_ASK_TOTAL_WEIGHT_MICROS - BID_ASK_ANCHOR_WEIGHT_MICROS;
const BID_ASK_V4_ANCHOR_WEIGHT_MICROS = 70_000;
const BID_ASK_V4_NON_ANCHOR_WEIGHT_MICROS = BID_ASK_TOTAL_WEIGHT_MICROS - BID_ASK_V4_ANCHOR_WEIGHT_MICROS;
const BID_ASK_V3_MAX_BIN_COUNT = 10;

export interface BidAskRangeInput {
  currentTick: number;
  rawTickLower: number;
  rawTickUpper: number;
  tickSpacing: number;
  quoteIsToken0: boolean;
}

export interface BidAskPlannerInput extends BidAskRangeInput {
  requestedBinCount: number;
  totalAmount: bigint;
  /**
   * Optional SDK adapter. Without it (or sqrtPriceX96), allocation is still
   * returned and the caller remains responsible for liquidity validation.
   */
  liquidityForBin?: BidAskLiquidityForBin;
  /**
   * Pool sqrt price used by the built-in one-sided liquidity calculation.
   * The planner deliberately does not require pool state just to allocate.
   */
  sqrtPriceX96?: bigint;
}

export interface BidAskSnappedBounds {
  lowerTick: number;
  upperTick: number;
}

export interface BidAskValidatedRange extends BidAskSnappedBounds {
  orientation: BidAskRangeOrientation;
  side: BidAskBinSide;
}

export interface BidAskWeight {
  distance: number;
  weightMicros: number;
}

export interface BidAskBinGeometry {
  index: number;
  tickLower: number;
  tickUpper: number;
  side: BidAskBinSide;
  anchorIndex: number;
  distance: number;
  weightMicros: number;
}

export interface BidAskLiquidityEstimate {
  expectedLiquidity: bigint;
  expectedAmount0?: bigint;
  expectedAmount1?: bigint;
}

export type BidAskLiquidityForBin = (
  bin: BidAskBinGeometry,
  allocatedAmount0: bigint,
  allocatedAmount1: bigint,
) => BidAskLiquidityEstimate | bigint;

export interface BidAskAllocatedBin extends BidAskBinGeometry {
  allocatedAmount0: bigint;
  allocatedAmount1: bigint;
  expectedLiquidity?: bigint;
  expectedAmount0?: bigint;
  expectedAmount1?: bigint;
}

export interface BidAskPlan {
  shapeVersion: BidAskShapeVersion;
  currentTick: number;
  tickSpacing: number;
  requestedBinCount: number;
  generatedBinCount: number;
  mintableBinCount: number;
  outerTickLower: number;
  outerTickUpper: number;
  anchorIndex: number;
  totalAmount0: bigint;
  totalAmount1: bigint;
  bins: BidAskAllocatedBin[];
}

export interface BidAskGeometryInput {
  lowerTick: number;
  upperTick: number;
  tickSpacing: number;
  requestedBinCount: number;
  anchorIndex: number;
  side: BidAskBinSide;
  shapeVersion?: BidAskShapeVersion;
}

/** Snap the lower bound down and the upper bound up, matching existing range construction. */
export function snapBidAskBounds(rawTickLower: number, rawTickUpper: number, tickSpacing: number): BidAskSnappedBounds {
  assertInteger("rawTickLower", rawTickLower);
  assertInteger("rawTickUpper", rawTickUpper);
  assertPositiveInteger("tickSpacing", tickSpacing);
  if (rawTickLower >= rawTickUpper) throw new Error("Bid-Ask raw lower tick must be below raw upper tick");

  const lowerTick = normalizeZero(tickToFloorSpacing(rawTickLower, tickSpacing));
  const upperTick = normalizeZero(tickToCeilSpacing(rawTickUpper, tickSpacing));
  if (lowerTick >= upperTick) throw new Error("Bid-Ask snapping collapsed or reversed the range");
  return { lowerTick, upperTick };
}

/** Validate the snapped range and ensure the quote token is the only in-range-side token. */
export function validateBidAskRange(input: BidAskRangeInput): BidAskValidatedRange {
  assertInteger("currentTick", input.currentTick);
  assertBoolean("quoteIsToken0", input.quoteIsToken0);
  const { lowerTick, upperTick } = snapBidAskBounds(input.rawTickLower, input.rawTickUpper, input.tickSpacing);

  const currentBelowRange = input.currentTick < lowerTick;
  const currentAboveRange = input.currentTick >= upperTick;
  if (!currentBelowRange && !currentAboveRange) {
    throw new Error("Bid-Ask range must be entirely below or above the current tick");
  }

  // A quote-token0 position is above price and spends token0. A quote-token1
  // position is below price and spends token1, matching PositionOpener.
  if (input.quoteIsToken0 !== currentBelowRange) {
    throw new Error("Bid-Ask range orientation does not match quoteIsToken0");
  }

  return {
    lowerTick,
    upperTick,
    orientation: currentBelowRange ? "below" : "above",
    side: currentBelowRange ? "token0" : "token1",
  };
}

/** Select the latest monotonic shape for new ladders. */
export function bidAskShapeVersionForBinCount(binCount: number): BidAskShapeVersion {
  assertPositiveInteger("binCount", binCount);
  return BID_ASK_SHAPE_VERSION;
}

/** Calculate Bid-Ask weights for indexes ordered from the lower to the upper edge. */
export function calculateBidAskWeights(
  binCount: number,
  anchorIndex: number,
  shapeVersion: BidAskShapeVersion = bidAskShapeVersionForBinCount(binCount),
): BidAskWeight[] {
  assertPositiveInteger("binCount", binCount);
  assertInteger("anchorIndex", anchorIndex);
  if (anchorIndex < 0 || anchorIndex >= binCount) throw new Error("Bid-Ask anchor index is outside the generated bins");

  const lastIndex = binCount - 1;
  if (shapeVersion === "delta-amount-linear-v1") {
    const balance = Math.max(anchorIndex, lastIndex - anchorIndex, 1);
    return Array.from({ length: binCount }, (_, index) => {
      const distance = Math.abs(index - anchorIndex);
      const floatingWeight = Math.max(0.02, distance / balance);
      return {
        distance,
        weightMicros: Math.max(1, Math.round(floatingWeight * 1_000_000)),
      };
    });
  }

  if (shapeVersion === "delta-amount-linear-v2") {
    if (binCount === 1) return [{ distance: 0, weightMicros: BID_ASK_TOTAL_WEIGHT_MICROS }];
    const distanceSum = Array.from({ length: binCount }, (_, index) => Math.abs(index - anchorIndex))
      .reduce((sum, distance) => sum + distance, 0);
    if (distanceSum <= 0) throw new Error("Bid-Ask non-anchor distance sum must be positive");

    let allocatedNonAnchor = 0;
    const nonAnchorIndexes = Array.from({ length: binCount }, (_, index) => index).filter((index) => index !== anchorIndex);
    const lastNonAnchorIndex = nonAnchorIndexes.at(-1)!;
    return Array.from({ length: binCount }, (_, index) => {
      const distance = Math.abs(index - anchorIndex);
      if (index === anchorIndex) return { distance, weightMicros: BID_ASK_ANCHOR_WEIGHT_MICROS };
      const weightMicros = index === lastNonAnchorIndex
        ? BID_ASK_TOTAL_WEIGHT_MICROS - BID_ASK_ANCHOR_WEIGHT_MICROS - allocatedNonAnchor
        : Math.floor((BID_ASK_NON_ANCHOR_WEIGHT_MICROS * distance) / distanceSum);
      allocatedNonAnchor += weightMicros;
      return { distance, weightMicros };
    });
  }

  if (shapeVersion === "delta-amount-linear-v4" && binCount > BID_ASK_V3_MAX_BIN_COUNT) {
    if (binCount === 1) return [{ distance: 0, weightMicros: BID_ASK_TOTAL_WEIGHT_MICROS }];
    const distanceSum = Array.from({ length: binCount }, (_, index) => Math.abs(index - anchorIndex))
      .reduce((sum, distance) => sum + distance, 0);
    if (distanceSum <= 0) throw new Error("Bid-Ask v4 non-anchor distance sum must be positive");

    let allocatedNonAnchor = 0;
    const nonAnchorIndexes = Array.from({ length: binCount }, (_, index) => index).filter((index) => index !== anchorIndex);
    const lastNonAnchorIndex = nonAnchorIndexes.at(-1)!;
    return Array.from({ length: binCount }, (_, index) => {
      const distance = Math.abs(index - anchorIndex);
      if (index === anchorIndex) return { distance, weightMicros: BID_ASK_V4_ANCHOR_WEIGHT_MICROS };
      const weightMicros = index === lastNonAnchorIndex
        ? BID_ASK_V4_NON_ANCHOR_WEIGHT_MICROS - allocatedNonAnchor
        : Math.floor((BID_ASK_V4_NON_ANCHOR_WEIGHT_MICROS * distance) / distanceSum);
      allocatedNonAnchor += weightMicros;
      return { distance, weightMicros };
    });
  }

  if (shapeVersion === "delta-amount-linear-v3" && binCount > BID_ASK_V3_MAX_BIN_COUNT) {
    throw new Error(`Bid-Ask v3 supports at most ${BID_ASK_V3_MAX_BIN_COUNT} bins with a fixed ten-percent anchor`);
  }
  if (binCount === 1) return [{ distance: 0, weightMicros: BID_ASK_TOTAL_WEIGHT_MICROS }];

  const tailTerms = Array.from({ length: binCount }, (_, index) => Math.abs(index - anchorIndex) ** 2 + 2 * Math.abs(index - anchorIndex));
  const tailTermSum = tailTerms.reduce((sum, term) => sum + term, 0);
  if (tailTermSum <= 0) throw new Error("Bid-Ask v3 tail-term sum must be positive");
  const anchorWeight = shapeVersion === "delta-amount-linear-v4"
    ? BID_ASK_V4_ANCHOR_WEIGHT_MICROS
    : BID_ASK_ANCHOR_WEIGHT_MICROS;
  const remainingTailWeight = BID_ASK_TOTAL_WEIGHT_MICROS - anchorWeight * binCount;
  let farthestIndex = 0;
  for (let index = 1; index < binCount; index += 1) {
    if (Math.abs(index - anchorIndex) > Math.abs(farthestIndex - anchorIndex)) farthestIndex = index;
  }
  let allocatedTailWeight = 0;
  const tailWeights = Array<number>(binCount).fill(0);
  for (let index = 0; index < binCount; index += 1) {
    if (index === anchorIndex || index === farthestIndex) continue;
    const weightMicros = Math.floor((remainingTailWeight * tailTerms[index]!) / tailTermSum);
    tailWeights[index] = weightMicros;
    allocatedTailWeight += weightMicros;
  }
  tailWeights[farthestIndex] = remainingTailWeight - allocatedTailWeight;

  return Array.from({ length: binCount }, (_, index) => {
    const distance = Math.abs(index - anchorIndex);
    if (index === anchorIndex) return { distance, weightMicros: anchorWeight };
    return { distance, weightMicros: anchorWeight + tailWeights[index]! };
  });
}

/** Generate the exact Delta boundary geometry without expanding the snapped outer range. */
export function generateBidAskBinGeometry(input: BidAskGeometryInput): BidAskBinGeometry[] {
  assertInteger("lowerTick", input.lowerTick);
  assertInteger("upperTick", input.upperTick);
  assertPositiveInteger("tickSpacing", input.tickSpacing);
  assertPositiveInteger("requestedBinCount", input.requestedBinCount);
  assertInteger("anchorIndex", input.anchorIndex);
  if (input.lowerTick >= input.upperTick) throw new Error("Bid-Ask lower tick must be below upper tick");
  if (input.lowerTick % input.tickSpacing !== 0 || input.upperTick % input.tickSpacing !== 0) {
    throw new Error("Bid-Ask geometry bounds must be aligned to tick spacing");
  }

  const span = BigInt(input.upperTick) - BigInt(input.lowerTick);
  const spacing = BigInt(input.tickSpacing);
  if (span % spacing !== 0n) throw new Error("Bid-Ask geometry span must be divisible by tick spacing");

  const availableSlots = span / spacing;
  if (availableSlots > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Bid-Ask range has too many spacing slots");
  const binCount = Math.min(input.requestedBinCount, Number(availableSlots));
  if (binCount < 1) throw new Error("Bid-Ask range has no spacing slots");
  if (input.anchorIndex < 0 || input.anchorIndex >= binCount) throw new Error("Bid-Ask anchor index is outside the generated bins");

  const weights = calculateBidAskWeights(
    binCount,
    input.anchorIndex,
    input.shapeVersion ?? bidAskShapeVersionForBinCount(binCount),
  );
  const binCountBig = BigInt(binCount);
  const bins: BidAskBinGeometry[] = [];
  for (let index = 0; index < binCount; index += 1) {
    const lowerOffset = (availableSlots * BigInt(index)) / binCountBig;
    const upperOffset = (availableSlots * BigInt(index + 1)) / binCountBig;
    const tickLowerBig = BigInt(input.lowerTick) + lowerOffset * spacing;
    const tickUpperBig = BigInt(input.lowerTick) + upperOffset * spacing;
    const tickLower = Number(tickLowerBig);
    const tickUpper = Number(tickUpperBig);
    if (!Number.isSafeInteger(tickLower) || !Number.isSafeInteger(tickUpper) || tickLower >= tickUpper) {
      throw new Error("Bid-Ask geometry produced an invalid bin boundary");
    }
    const weight = weights[index]!;
    bins.push({
      index,
      tickLower,
      tickUpper,
      side: input.side,
      anchorIndex: input.anchorIndex,
      distance: weight.distance,
      weightMicros: weight.weightMicros,
    });
  }
  return bins;
}

/** Allocate only the selected token with bigint floor division and a final exact remainder. */
export function allocateBidAskAmounts(
  bins: readonly BidAskBinGeometry[],
  totalAmount: bigint,
  quoteIsToken0: boolean,
): BidAskAllocatedBin[] {
  assertBoolean("quoteIsToken0", quoteIsToken0);
  if (typeof totalAmount !== "bigint" || totalAmount < 0n) throw new Error("Bid-Ask total amount must be a non-negative bigint");
  if (bins.length === 0) throw new Error("Cannot allocate a Bid-Ask plan with no bins");

  const weightSum = bins.reduce((sum, bin) => {
    if (!Number.isSafeInteger(bin.weightMicros) || bin.weightMicros < 1) throw new Error("Bid-Ask bin weight must be a positive safe integer");
    return sum + BigInt(bin.weightMicros);
  }, 0n);
  if (weightSum <= 0n) throw new Error("Bid-Ask weight sum must be positive");

  let allocatedTotal = 0n;
  const allocatedBins = bins.map((bin, index) => {
    const amount = index === bins.length - 1
      ? totalAmount - allocatedTotal
      : (totalAmount * BigInt(bin.weightMicros)) / weightSum;
    if (amount < 0n) throw new Error("Bid-Ask allocation produced a negative amount");
    allocatedTotal += amount;
    return {
      ...bin,
      allocatedAmount0: quoteIsToken0 ? amount : 0n,
      allocatedAmount1: quoteIsToken0 ? 0n : amount,
    };
  });

  if (allocatedTotal !== totalAmount) throw new Error("Bid-Ask allocations do not equal the total deposit");
  return allocatedBins;
}

export function planBidAsk(input: BidAskPlannerInput): BidAskPlan {
  assertInteger("requestedBinCount", input.requestedBinCount);
  if (input.requestedBinCount < 1) throw new Error("Bid-Ask requested bin count must be positive");
  if (typeof input.totalAmount !== "bigint" || input.totalAmount < 0n) {
    throw new Error("Bid-Ask total amount must be a non-negative bigint");
  }

  const range = validateBidAskRange(input);
  const provisionalBinCount = Math.min(input.requestedBinCount, spacingSlots(range.lowerTick, range.upperTick, input.tickSpacing));
  const shapeVersion = bidAskShapeVersionForBinCount(provisionalBinCount);
  const bins = generateBidAskBinGeometry({
    lowerTick: range.lowerTick,
    upperTick: range.upperTick,
    tickSpacing: input.tickSpacing,
    requestedBinCount: input.requestedBinCount,
    anchorIndex: range.orientation === "below" ? 0 : provisionalBinCount - 1,
    side: range.side,
    shapeVersion,
  });
  const allocatedBins = allocateBidAskAmounts(bins, input.totalAmount, input.quoteIsToken0);
  const liquidityEstimator = input.liquidityForBin;
  const hasLiquidityInputs = liquidityEstimator !== undefined || input.sqrtPriceX96 !== undefined;

  const finalBins = allocatedBins.map((bin) => {
    const estimate = liquidityEstimator
      ? normalizeLiquidityEstimate(liquidityEstimator(bin, bin.allocatedAmount0, bin.allocatedAmount1), bin)
      : input.sqrtPriceX96 === undefined
        ? undefined
        : estimateOneSidedLiquidity(bin, input.quoteIsToken0, input.sqrtPriceX96);

    if (hasLiquidityInputs) {
      const selectedAmount = input.quoteIsToken0 ? bin.allocatedAmount0 : bin.allocatedAmount1;
      if (selectedAmount === 0n) throw new Error(`Bid-Ask bin ${bin.index} has zero allocation`);
      if (!estimate || estimate.expectedLiquidity === 0n) throw new Error(`Bid-Ask bin ${bin.index} has zero liquidity`);
    }

    return estimate ? { ...bin, ...estimate } : bin;
  });

  const totalAmount0 = finalBins.reduce((sum, bin) => sum + bin.allocatedAmount0, 0n);
  const totalAmount1 = finalBins.reduce((sum, bin) => sum + bin.allocatedAmount1, 0n);
  const generatedBinCount = finalBins.length;
  return {
    shapeVersion,
    currentTick: input.currentTick,
    tickSpacing: input.tickSpacing,
    requestedBinCount: input.requestedBinCount,
    generatedBinCount,
    mintableBinCount: generatedBinCount,
    outerTickLower: range.lowerTick,
    outerTickUpper: range.upperTick,
    anchorIndex: range.orientation === "below" ? 0 : generatedBinCount - 1,
    totalAmount0,
    totalAmount1,
    bins: finalBins,
  };
}

/** Hash the plan's typed, ordered fields; object key insertion order is irrelevant. */
export function hashBidAskPlan(plan: BidAskPlan): Hex {
  const binEncodings = plan.bins.map((bin) => encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "int256" },
      { type: "int256" },
      { type: "uint8" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bool" },
      { type: "uint256" },
      { type: "bool" },
      { type: "uint256" },
      { type: "bool" },
      { type: "uint256" },
    ],
    [
      BigInt(bin.index),
      BigInt(bin.tickLower),
      BigInt(bin.tickUpper),
      bin.side === "token0" ? 0 : 1,
      BigInt(bin.anchorIndex),
      BigInt(bin.distance),
      BigInt(bin.weightMicros),
      bin.allocatedAmount0,
      bin.allocatedAmount1,
      bin.expectedLiquidity !== undefined,
      bin.expectedLiquidity ?? 0n,
      bin.expectedAmount0 !== undefined,
      bin.expectedAmount0 ?? 0n,
      bin.expectedAmount1 !== undefined,
      bin.expectedAmount1 ?? 0n,
    ],
  ));

  return keccak256(encodeAbiParameters(
    [
      { type: "string" },
      { type: "int256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "int256" },
      { type: "int256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes[]" },
    ],
    [
      plan.shapeVersion,
      BigInt(plan.currentTick),
      BigInt(plan.tickSpacing),
      BigInt(plan.requestedBinCount),
      BigInt(plan.generatedBinCount),
      BigInt(plan.mintableBinCount),
      BigInt(plan.outerTickLower),
      BigInt(plan.outerTickUpper),
      BigInt(plan.anchorIndex),
      plan.totalAmount0,
      plan.totalAmount1,
      binEncodings,
    ],
  ));
}

function estimateOneSidedLiquidity(bin: BidAskBinGeometry & { allocatedAmount0?: bigint; allocatedAmount1?: bigint }, quoteIsToken0: boolean, sqrtPriceX96: bigint): BidAskLiquidityEstimate {
  if (sqrtPriceX96 <= 0n) throw new Error("sqrtPriceX96 must be positive");
  const amount0 = bin.allocatedAmount0 ?? 0n;
  const amount1 = bin.allocatedAmount1 ?? 0n;
  const sqrtLower = sqrtRatioAtTick(bin.tickLower);
  const sqrtUpper = sqrtRatioAtTick(bin.tickUpper);
  const expectedLiquidity = quoteIsToken0
    ? liquidityForAmount0(sqrtLower, sqrtUpper, amount0)
    : liquidityForAmount1(sqrtLower, sqrtUpper, amount1);
  const expectedAmounts = amountsForLiquidity(sqrtPriceX96, bin.tickLower, bin.tickUpper, expectedLiquidity);
  return {
    expectedLiquidity,
    expectedAmount0: expectedAmounts.amount0,
    expectedAmount1: expectedAmounts.amount1,
  };
}

function normalizeLiquidityEstimate(
  result: BidAskLiquidityEstimate | bigint,
  bin: BidAskAllocatedBin,
): BidAskLiquidityEstimate {
  const estimate = typeof result === "bigint"
    ? { expectedLiquidity: result }
    : result;
  if (!estimate || typeof estimate.expectedLiquidity !== "bigint" || estimate.expectedLiquidity < 0n) {
    throw new Error(`Bid-Ask bin ${bin.index} returned an invalid liquidity estimate`);
  }
  const expectedAmount0 = estimate.expectedAmount0 ?? bin.allocatedAmount0;
  const expectedAmount1 = estimate.expectedAmount1 ?? bin.allocatedAmount1;
  if (typeof expectedAmount0 !== "bigint" || expectedAmount0 < 0n || typeof expectedAmount1 !== "bigint" || expectedAmount1 < 0n) {
    throw new Error(`Bid-Ask bin ${bin.index} returned invalid expected amounts`);
  }
  return { expectedLiquidity: estimate.expectedLiquidity, expectedAmount0, expectedAmount1 };
}

function spacingSlots(lowerTick: number, upperTick: number, tickSpacing: number): number {
  const slots = (BigInt(upperTick) - BigInt(lowerTick)) / BigInt(tickSpacing);
  if (slots > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Bid-Ask range has too many spacing slots");
  return Number(slots);
}

function assertInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
}

function assertPositiveInteger(name: string, value: number): void {
  assertInteger(name, value);
  if (value <= 0) throw new Error(`${name} must be a positive integer`);
}

function assertBoolean(name: string, value: boolean): void {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}
