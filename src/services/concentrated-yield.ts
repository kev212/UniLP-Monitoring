import { type Address, type Hex } from "viem";

import { erc20Abi, v3PoolAbi, v4PoolKeysAbi, v4StateViewAbi } from "../abi.js";
import type { ChainName } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import { amountsForLiquidity, sqrtRatioAtTick } from "./uniswap-math.js";

const Q192 = 1n << 192n;
const REFERENCE_CAPITAL_USD = 100;
const GECKO_REQUEST_INTERVAL_MS = 6_500;
const MIN_RANGE_PERCENT = 5;
const MAX_RANGE_PERCENT = 90;

export interface OhlcvCandle {
  timestamp: number;
  high: number;
  low: number;
  volumeUsd: number;
}

export function normalizeOhlcvPrices(high: number, low: number, baseAddress: string, quoteAddress: string, searchToken: string): { high: number; low: number } {
  const base = baseAddress.toLowerCase();
  const quote = quoteAddress.toLowerCase();
  const search = searchToken.toLowerCase();
  if (quote === search && base !== search) {
    return { high: low > 0 ? 1 / low : 0, low: high > 0 ? 1 / high : 0 };
  }
  return { high, low };
}

export interface ConcentratedEstimate {
  currentTick: number;
  lowerTick: number;
  upperTick: number;
  requestedDownsidePercent: number;
  actualDownsidePercent: number;
  actualUpsidePercent: number;
  rangeCapitalUsd: number;
  volumeInRangePercent: { h1: number; h6: number; h24: number };
  yieldHourlyPercent: { h1: number; h6: number; h24: number };
  warnings: string[];
}

interface TickPoint { tick: number; liquidityNet: bigint }
interface PoolState {
  poolAddress: Address;
  poolId?: Hex;
  currentTick: number;
  currentLiquidity: bigint;
  tickSpacing: number;
  token0: Address;
  token1: Address;
  decimals0: number;
  decimals1: number;
  searchTokenIsToken0: boolean;
}

export function validateRangePercent(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_RANGE_PERCENT && value <= MAX_RANGE_PERCENT;
}

export function snapRange(currentTick: number, tickSpacing: number, downsidePercent: number, searchTokenIsToken0 = true): { lowerTick: number; upperTick: number } {
  const tickDelta = Math.log(1 - downsidePercent / 100) / Math.log(1.0001);
  const lowerTarget = Math.floor(currentTick + (searchTokenIsToken0 ? tickDelta : -tickDelta));
  const currentBoundary = Math.floor(currentTick / tickSpacing) * tickSpacing;
  if (!searchTokenIsToken0) {
    return { lowerTick: currentBoundary, upperTick: Math.ceil(lowerTarget / tickSpacing) * tickSpacing };
  }
  return {
    lowerTick: Math.floor(lowerTarget / tickSpacing) * tickSpacing,
    upperTick: Math.floor(currentTick / tickSpacing) * tickSpacing + tickSpacing,
  };
}

export function overlapFraction(low: number, high: number, rangeLow: number, rangeHigh: number): number {
  if (![low, high, rangeLow, rangeHigh].every(Number.isFinite) || high <= 0 || rangeHigh <= rangeLow) return 0;
  const candleLow = Math.min(low, high);
  const candleHigh = Math.max(low, high);
  if (candleHigh <= rangeLow || candleLow >= rangeHigh) return 0;
  if (candleLow <= rangeLow && candleHigh >= rangeHigh) return 1;
  const full = Math.log(rangeHigh / rangeLow);
  const overlap = Math.log(Math.min(candleHigh, rangeHigh) / Math.max(candleLow, rangeLow));
  return full > 0 ? Math.max(0, Math.min(1, overlap / full)) : 0;
}

export async function estimateConcentratedYield(
  chains: ChainClients,
  chain: ChainName,
  protocol: "v3" | "v4",
  poolIdentifier: Address,
  searchToken: Address,
  fee: number,
  currentLpFee: number | undefined,
  downsidePercent: number,
  candles: readonly OhlcvCandle[],
): Promise<ConcentratedEstimate | null> {
  if (!validateRangePercent(downsidePercent)) return null;
  const { client, registry } = chains.getForScan(chain);
  const pool = await readPoolState(client, registry, protocol, poolIdentifier, searchToken);
  if (!pool || pool.currentLiquidity === 0n) return null;
  const range = snapRange(pool.currentTick, pool.tickSpacing, downsidePercent, pool.searchTokenIsToken0);
  if (range.lowerTick >= range.upperTick) return null;
  const points = await readTickPoints(client, registry, protocol, pool, range.lowerTick, range.upperTick);
  const capitalPerLiquidity = capitalUsdPerLiquidity(pool, range.lowerTick, range.upperTick);
  if (!(capitalPerLiquidity > 0)) return null;
  const referenceLiquidity = REFERENCE_CAPITAL_USD / capitalPerLiquidity;
  const feeRate = (currentLpFee ?? fee) / 1_000_000;
  const windows = [1, 6, 24].map((hours) => candles.filter((c) => c.timestamp >= Date.now() - hours * 3_600_000));
  const yieldHourlyPercent = { h1: 0, h6: 0, h24: 0 };
  const volumeInRangePercent = { h1: 0, h6: 0, h24: 0 };
  for (const [index, window] of windows.entries()) {
    const result = estimateWindow(window, pool, points, range.lowerTick, range.upperTick, referenceLiquidity, feeRate);
    const hours = [1, 6, 24][index]!;
    const key = index === 0 ? "h1" : index === 1 ? "h6" : "h24";
    yieldHourlyPercent[key] = result.feesUsd / REFERENCE_CAPITAL_USD / hours * 100;
    volumeInRangePercent[key] = result.totalVolumeUsd > 0 ? result.inRangeVolumeUsd / result.totalVolumeUsd * 100 : 0;
  }
  const currentPrice = priceAtTick(pool.currentTick, pool);
  const tickPriceA = priceAtTick(range.lowerTick, pool);
  const tickPriceB = priceAtTick(range.upperTick, pool);
  const lowerPrice = Math.min(tickPriceA, tickPriceB);
  const upperPrice = Math.max(tickPriceA, tickPriceB);
  return {
    currentTick: pool.currentTick,
    lowerTick: range.lowerTick,
    upperTick: range.upperTick,
    requestedDownsidePercent: downsidePercent,
    actualDownsidePercent: (1 - lowerPrice / currentPrice) * 100,
    actualUpsidePercent: (upperPrice / currentPrice - 1) * 100,
    rangeCapitalUsd: capitalPerLiquidity * referenceLiquidity,
    volumeInRangePercent,
    yieldHourlyPercent,
    warnings: currentLpFee !== undefined && currentLpFee !== fee ? ["dynamic fee"] : [],
  };
}

export async function fetchOhlcv(chain: ChainName, pool: Address, searchToken?: Address): Promise<OhlcvCandle[]> {
  const url = `https://api.geckoterminal.com/api/v2/networks/${chain}/pools/${pool}/ohlcv/minute?aggregate=5&limit=288`;
  const wait = Math.max(0, GECKO_REQUEST_INTERVAL_MS - (Date.now() - lastGeckoOhlcvRequestAt));
  if (wait > 0) await sleep(wait);
  lastGeckoOhlcvRequestAt = Date.now();
  let response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 429) {
    throw new Error("GeckoTerminal rate limited OHLCV");
  }
  if (!response.ok) throw new Error(`OHLCV request failed: ${response.status}`);
  const body = await response.json() as {
    data?: { attributes?: { ohlcv_list?: unknown[][] } };
    meta?: { base?: { address?: string }; quote?: { address?: string } };
  };
  const baseAddress = body.meta?.base?.address;
  const quoteAddress = body.meta?.quote?.address;
  return (body.data?.attributes?.ohlcv_list ?? []).map((row) => ({
    timestamp: Number(row[0]) * 1_000,
    ...normalizeOhlcvPrices(Number(row[2]), Number(row[3]), baseAddress ?? "", quoteAddress ?? "", searchToken ?? ""),
    volumeUsd: Number(row[5]),
  })).filter((c) => Number.isFinite(c.timestamp) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.volumeUsd));
}

let lastGeckoOhlcvRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateWindow(candles: readonly OhlcvCandle[], pool: PoolState, points: readonly TickPoint[], lowerTick: number, upperTick: number, referenceLiquidity: number, feeRate: number): { feesUsd: number; totalVolumeUsd: number; inRangeVolumeUsd: number } {
  const rangeLow = Math.min(priceAtTick(lowerTick, pool), priceAtTick(upperTick, pool));
  const rangeHigh = Math.max(priceAtTick(lowerTick, pool), priceAtTick(upperTick, pool));
  let feesUsd = 0;
  let totalVolumeUsd = 0;
  let inRangeVolumeUsd = 0;
  for (const candle of candles) {
    totalVolumeUsd += candle.volumeUsd;
    const overlap = overlapFraction(candle.low, candle.high, rangeLow, rangeHigh);
    if (overlap <= 0) continue;
    const representativePrice = Math.sqrt(Math.max(candle.low, rangeLow) * Math.min(candle.high || candle.low, rangeHigh));
    const representativeTick = tickAtPrice(representativePrice, pool);
    const competingLiquidity = liquidityAtTick(pool.currentLiquidity, pool.currentTick, representativeTick, points);
    if (competingLiquidity <= 0n) continue;
    const volumeInRange = candle.volumeUsd * overlap;
    inRangeVolumeUsd += volumeInRange;
    feesUsd += volumeInRange * feeRate * Math.min(1, referenceLiquidity / Number(competingLiquidity));
  }
  return { feesUsd, totalVolumeUsd, inRangeVolumeUsd };
}

function liquidityAtTick(startLiquidity: bigint, startTick: number, targetTick: number, points: readonly TickPoint[]): bigint {
  let liquidity = startLiquidity;
  if (targetTick < startTick) {
    for (const point of points) if (point.tick <= startTick && point.tick > targetTick) liquidity -= point.liquidityNet;
  } else {
    for (const point of points) if (point.tick > startTick && point.tick <= targetTick) liquidity += point.liquidityNet;
  }
  return liquidity > 0n ? liquidity : 0n;
}

function priceAtTick(tick: number, pool: PoolState): number {
  const square = sqrtRatioAtTick(tick) ** 2n;
  const rawToken1PerToken0 = Number(square) / Number(Q192);
  const token1PerToken0 = rawToken1PerToken0 * 10 ** (pool.decimals0 - pool.decimals1);
  const price = pool.searchTokenIsToken0 ? token1PerToken0 : 1 / token1PerToken0;
  return price > 0 && Number.isFinite(price) ? price : 0;
}

function tickAtPrice(price: number, pool: PoolState): number {
  const token1PerToken0 = pool.searchTokenIsToken0 ? price : 1 / price;
  return Math.floor(Math.log(token1PerToken0 / 10 ** (pool.decimals0 - pool.decimals1)) / Math.log(1.0001));
}

function capitalUsdPerLiquidity(pool: PoolState, lowerTick: number, upperTick: number): number {
  const scale = 1_000_000_000_000n;
  const amounts = amountsForLiquidity(sqrtRatioAtTick(pool.currentTick), lowerTick, upperTick, scale);
  const quotePrice = priceAtTick(pool.currentTick, pool);
  const baseAmount = pool.searchTokenIsToken0 ? Number(amounts.amount0) / 10 ** pool.decimals0 : Number(amounts.amount1) / 10 ** pool.decimals1;
  const quoteAmount = pool.searchTokenIsToken0 ? Number(amounts.amount1) / 10 ** pool.decimals1 : Number(amounts.amount0) / 10 ** pool.decimals0;
  return (baseAmount * quotePrice + quoteAmount) / 1_000_000_000_000;
}

async function readPoolState(client: any, registry: any, protocol: "v3" | "v4", identifier: Address, searchToken: Address): Promise<PoolState | null> {
  if (protocol === "v3") {
    const [slot, liquidity, spacing, token0, token1] = await Promise.all([
      client.readContract({ address: identifier, abi: v3PoolAbi, functionName: "slot0" }),
      client.readContract({ address: identifier, abi: v3PoolAbi, functionName: "liquidity" }),
      client.readContract({ address: identifier, abi: v3PoolAbi, functionName: "tickSpacing" }),
      client.readContract({ address: identifier, abi: v3PoolAbi, functionName: "token0" }),
      client.readContract({ address: identifier, abi: v3PoolAbi, functionName: "token1" }),
    ]);
    const [d0, d1] = await Promise.all([readDecimals(client, token0), readDecimals(client, token1)]);
    return { poolAddress: identifier, currentTick: Number(slot[1]), currentLiquidity: liquidity, tickSpacing: Number(spacing), token0, token1, decimals0: d0, decimals1: d1, searchTokenIsToken0: token0.toLowerCase() === searchToken.toLowerCase() };
  }
  const bytes25 = identifier.slice(0, 52) as Hex;
  const key = await client.readContract({ address: registry.contracts.v4.positionManager, abi: v4PoolKeysAbi, functionName: "poolKeys", args: [bytes25] });
  const [slot, liquidity, d0, d1] = await Promise.all([
    client.readContract({ address: registry.contracts.v4.stateView, abi: v4StateViewAbi, functionName: "getSlot0", args: [identifier] }),
    client.readContract({ address: registry.contracts.v4.stateView, abi: v4StateViewAbi, functionName: "getLiquidity", args: [identifier] }),
    readDecimals(client, key.currency0), readDecimals(client, key.currency1),
  ]);
  return { poolAddress: identifier, poolId: identifier as Hex, currentTick: Number(slot[1]), currentLiquidity: liquidity, tickSpacing: Number(key.tickSpacing), token0: key.currency0, token1: key.currency1, decimals0: d0, decimals1: d1, searchTokenIsToken0: key.currency0.toLowerCase() === searchToken.toLowerCase() };
}

async function readDecimals(client: any, token: Address): Promise<number> {
  if (token.toLowerCase() === "0x0000000000000000000000000000000000000000") return 18;
  return Number(await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
}

async function readTickPoints(client: any, registry: any, protocol: "v3" | "v4", pool: PoolState, lowerTick: number, upperTick: number): Promise<TickPoint[]> {
  const firstWord = Math.floor(Math.floor(lowerTick / pool.tickSpacing) / 256);
  const lastWord = Math.floor(Math.floor(upperTick / pool.tickSpacing) / 256);
  const words = Array.from({ length: lastWord - firstWord + 1 }, (_, i) => firstWord + i);
  const bitmaps = await Promise.all(words.map((word) => protocol === "v3"
    ? client.readContract({ address: pool.poolAddress, abi: v3PoolAbi, functionName: "tickBitmap", args: [word] })
    : client.readContract({ address: registry.contracts.v4.stateView, abi: v4StateViewAbi, functionName: "getTickBitmap", args: [pool.poolId, word] })));
  const points: TickPoint[] = [];
  const calls: { tick: number; word: number; bit: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    const bitmap = bitmaps[i] as bigint;
    for (let bit = 0; bit < 256; bit++) {
      if ((bitmap & (1n << BigInt(bit))) === 0n) continue;
      const tick = (words[i]! * 256 + bit) * pool.tickSpacing;
      if (tick > lowerTick && tick <= upperTick) calls.push({ tick, word: words[i]!, bit });
    }
  }
  const values = await Promise.all(calls.map(({ tick }) => protocol === "v3"
    ? client.readContract({ address: pool.poolAddress, abi: v3PoolAbi, functionName: "ticks", args: [tick] })
    : client.readContract({ address: registry.contracts.v4.stateView, abi: v4StateViewAbi, functionName: "getTickLiquidity", args: [pool.poolId, tick] })));
  for (let i = 0; i < calls.length; i++) points.push({ tick: calls[i]!.tick, liquidityNet: values[i]![1] as bigint });
  return points;
}
