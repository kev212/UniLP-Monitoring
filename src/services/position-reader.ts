import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  pad,
  toHex,
  zeroAddress,
  type Address,
  type ContractFunctionParameters,
  type PublicClient,
} from "viem";

import {
  erc20Abi,
  v2PairAbi,
  v3FactoryAbi,
  v3PoolAbi,
  v3PositionManagerAbi,
  v4PositionManagerAbi,
  v4StateViewAbi,
} from "../abi.js";
import type { PositionGroupRecord, PositionRangeInfo, PositionRecord, Protocol, TokenAmount } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import { amountsForLiquidity, applySlippage, sqrtRatioAtTick } from "./uniswap-math.js";
import { dexNameFromMetadata, v3ContractsFor } from "./v3-deployment.js";

export interface PositionValue {
  protocol: Protocol;
  poolKey: string;
  sourcePool: Address | null;
  token0: TokenAmount;
  token1: TokenAmount;
  liquidity: bigint;
  priceMarker: bigint;
  v3Fee?: number;
  minAmount0: bigint;
  minAmount1: bigint;
  v4PoolKey?: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  range?: PositionRangeInfo;
  unclaimedFees0: bigint;
  unclaimedFees1: bigint;
  observedBlock: bigint;
}

type V4Slot0 = readonly [bigint, number, number, number];
type RpcSource = "scan" | "monitoring" | "execution";
type V3PositionDetails = readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];
type V3TickData = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean];
type V4FeeGrowthInside = readonly [bigint, bigint];
type V4StoredPosition = readonly [bigint, bigint, bigint];

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11" as Address;

export class PositionReader {
  private readonly v4Slot0Cache = new Map<string, Promise<V4Slot0>>();

  constructor(private readonly chains: ChainClients, private readonly slippageBps: number) {}

  async read(position: PositionRecord, blockNumber?: bigint, removeSlippageBps?: number, rpc: RpcSource = "scan"): Promise<PositionValue> {
    const observedBlock = blockNumber ?? await this.rpcClient(position.chainId, rpc).getBlockNumber();
    const effective = removeSlippageBps ?? this.slippageBps;
    if (position.protocol === "v2") return this.readV2(position, observedBlock, effective, rpc);
    if (position.protocol === "v3") return this.readV3(position, observedBlock, effective, rpc);
    return this.readV4(position, observedBlock, effective, rpc);
  }

  async readGroup(
    group: PositionGroupRecord,
    positions: readonly PositionRecord[],
    blockNumber: bigint,
    removeSlippageBps?: number,
    rpc: RpcSource = "monitoring",
  ): Promise<PositionValue[]> {
    if (positions.length === 0) return [];
    if (positions.some((position) => position.protocol !== group.protocol || position.chainId !== group.chainId)) {
      throw new Error("Position group children do not match the parent protocol and chain");
    }
    const effective = removeSlippageBps ?? this.slippageBps;
    if (group.protocol === "v3") return this.readV3Group(group, positions, blockNumber, effective, rpc);
    if (group.protocol === "v4") return this.readV4Group(group, positions, blockNumber, effective, rpc);
    return Promise.all(positions.map((position) => this.read(position, blockNumber, effective, rpc)));
  }

  private async readV3Group(
    group: PositionGroupRecord,
    positions: readonly PositionRecord[],
    blockNumber: bigint,
    removeSlippageBps: number,
    rpc: RpcSource,
  ): Promise<PositionValue[]> {
    const registry = this.chains.getById(group.chainId).registry;
    const client = this.rpcClient(group.chainId, rpc);
    const dex = dexNameFromMetadata(group.metadata) ?? dexNameFromMetadata(positions[0]!.metadata);
    const contracts = v3ContractsFor(registry, dex);
    const fee = numberMetadata(positions[0]!.metadata, "fee");
    const ranges = positions.map((position) => ({
      tickLower: numberMetadata(position.metadata, "tickLower"),
      tickUpper: numberMetadata(position.metadata, "tickUpper"),
    }));
    const boundaries = [...new Set(ranges.flatMap(({ tickLower, tickUpper }) => [tickLower, tickUpper]))].sort((a, b) => a - b);
    const calls: ContractFunctionParameters[] = [
      ...positions.map((position) => ({
        address: group.positionManager,
        abi: v3PositionManagerAbi,
        functionName: "positions",
        args: [BigInt(position.positionKey)],
      } as const)),
      {
        address: contracts.factory,
        abi: v3FactoryAbi,
        functionName: "getPool",
        args: [group.token0, group.token1, fee],
      } as const,
      { address: group.poolKey as Address, abi: v3PoolAbi, functionName: "slot0" } as const,
      { address: group.poolKey as Address, abi: v3PoolAbi, functionName: "feeGrowthGlobal0X128" } as const,
      { address: group.poolKey as Address, abi: v3PoolAbi, functionName: "feeGrowthGlobal1X128" } as const,
      ...boundaries.map((tick) => ({ address: group.poolKey as Address, abi: v3PoolAbi, functionName: "ticks", args: [tick] } as const)),
    ];
    const results = await this.multicall(client, calls, blockNumber);
    const details = results.slice(0, positions.length) as V3PositionDetails[];
    const sharedOffset = positions.length;
    const poolAddress = results[sharedOffset] as Address;
    const slot0 = results[sharedOffset + 1] as readonly [bigint, number, ...unknown[]];
    const feeGrowthGlobal0 = results[sharedOffset + 2] as bigint;
    const feeGrowthGlobal1 = results[sharedOffset + 3] as bigint;
    const tickData = new Map<number, V3TickData>();
    for (let index = 0; index < boundaries.length; index += 1) {
      tickData.set(boundaries[index]!, results[sharedOffset + 4 + index] as V3TickData);
    }
    if (poolAddress.toLowerCase() !== group.poolKey.toLowerCase()) throw new Error("V3 position group resolves to a different pool");

    return details.map((positionDetails, index) => {
      const position = positions[index]!;
      const expectedRange = ranges[index]!;
      const [, , token0, token1, positionFee, tickLower, tickUpper, liquidity, feeGrowthInside0Last, feeGrowthInside1Last, tokensOwed0, tokensOwed1] = positionDetails;
      if (token0.toLowerCase() !== group.token0.toLowerCase()
        || token1.toLowerCase() !== group.token1.toLowerCase()
        || Number(positionFee) !== fee
        || tickLower !== expectedRange.tickLower
        || tickUpper !== expectedRange.tickUpper) {
        throw new Error(`V3 position group child ${position.positionKey} differs from persisted metadata`);
      }
      if (liquidity === 0n) throw new Error(`V3 position group child ${position.positionKey} has zero liquidity`);
      const lower = tickData.get(tickLower);
      const upper = tickData.get(tickUpper);
      if (!lower || !upper) throw new Error(`V3 position group child ${position.positionKey} has incomplete tick state`);
      const currentTick = slot0[1];
      const feeGrowthInside0 = v3FeeGrowthInside(feeGrowthGlobal0, currentTick, tickLower, tickUpper, lower[2], upper[2]);
      const feeGrowthInside1 = v3FeeGrowthInside(feeGrowthGlobal1, currentTick, tickLower, tickUpper, lower[3], upper[3]);
      const principal = amountsForLiquidity(slot0[0], tickLower, tickUpper, liquidity);
      return {
        protocol: "v3",
        poolKey: poolAddress.toLowerCase(),
        sourcePool: poolAddress,
        token0: { token: token0, amount: principal.amount0 },
        token1: { token: token1, amount: principal.amount1 },
        liquidity,
        priceMarker: (slot0[0] * slot0[0]) >> 96n,
        v3Fee: fee,
        minAmount0: applySlippage(principal.amount0, removeSlippageBps),
        minAmount1: applySlippage(principal.amount1, removeSlippageBps),
        unclaimedFees0: tokensOwed0 + feeOwed(liquidity, feeGrowthInside0, feeGrowthInside0Last),
        unclaimedFees1: tokensOwed1 + feeOwed(liquidity, feeGrowthInside1, feeGrowthInside1Last),
        range: rangeInfo(currentTick, tickLower, tickUpper, slot0[0]),
        observedBlock: blockNumber,
      } satisfies PositionValue;
    });
  }

  private async readV4Group(
    group: PositionGroupRecord,
    positions: readonly PositionRecord[],
    blockNumber: bigint,
    removeSlippageBps: number,
    rpc: RpcSource,
  ): Promise<PositionValue[]> {
    const registry = this.chains.getById(group.chainId).registry;
    const client = this.rpcClient(group.chainId, rpc);
    const firstMetadata = positions[0]!.metadata as Record<string, unknown>;
    const poolKey = v4PoolKeyFromMetadata(firstMetadata);
    const poolId = keccak256(encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    ));
    if (poolId.toLowerCase() !== group.poolKey.toLowerCase()) throw new Error("V4 position group resolves to a different pool");
    const ranges = positions.map((position) => ({
      tickLower: numberMetadata(position.metadata, "tickLower"),
      tickUpper: numberMetadata(position.metadata, "tickUpper"),
    }));
    const calls: ContractFunctionParameters[] = [
      { address: registry.contracts.v4.stateView, abi: v4StateViewAbi, functionName: "getSlot0", args: [poolId] } as const,
      ...ranges.map(({ tickLower, tickUpper }) => ({
        address: registry.contracts.v4.stateView,
        abi: v4StateViewAbi,
        functionName: "getFeeGrowthInside",
        args: [poolId, tickLower, tickUpper],
      } as const)),
      ...positions.map((position, index) => ({
        address: registry.contracts.v4.stateView,
        abi: v4StateViewAbi,
        functionName: "getPositionInfo",
        args: [poolId, v4PositionId(group.positionManager, ranges[index]!.tickLower, ranges[index]!.tickUpper, BigInt(position.positionKey))],
      } as const)),
    ];
    const results = await this.multicall(client, calls, blockNumber);
    const slot0 = results[0] as V4Slot0;
    const feeGrowthResults = results.slice(1, 1 + positions.length) as V4FeeGrowthInside[];
    const storedPositions = results.slice(1 + positions.length) as V4StoredPosition[];

    return positions.map((position, index) => {
      const { tickLower, tickUpper } = ranges[index]!;
      const metadataPoolKey = v4PoolKeyFromMetadata(position.metadata as Record<string, unknown>);
      if (!sameV4PoolKey(poolKey, metadataPoolKey)) throw new Error(`V4 position group child ${position.positionKey} resolves to a different pool`);
      const feeGrowthInside = feeGrowthResults[index]!;
      const storedPosition = storedPositions[index]!;
      const liquidity = storedPosition[0];
      if (liquidity === 0n) throw new Error(`V4 position group child ${position.positionKey} has zero liquidity`);
      const principal = amountsForLiquidity(slot0[0], tickLower, tickUpper, liquidity);
      return {
        protocol: "v4",
        poolKey: poolId,
        sourcePool: null,
        token0: { token: poolKey.currency0, amount: principal.amount0 },
        token1: { token: poolKey.currency1, amount: principal.amount1 },
        liquidity,
        priceMarker: (slot0[0] * slot0[0]) >> 96n,
        minAmount0: applySlippage(principal.amount0, removeSlippageBps),
        minAmount1: applySlippage(principal.amount1, removeSlippageBps),
        v4PoolKey: poolKey,
        unclaimedFees0: feeOwed(liquidity, feeGrowthInside[0], storedPosition[1]),
        unclaimedFees1: feeOwed(liquidity, feeGrowthInside[1], storedPosition[2]),
        range: rangeInfo(slot0[1], tickLower, tickUpper, slot0[0]),
        observedBlock: blockNumber,
      } satisfies PositionValue;
    });
  }

  private async multicall(client: PublicClient, contracts: ContractFunctionParameters[], blockNumber: bigint): Promise<unknown[]> {
    return client.multicall({
      allowFailure: false,
      blockNumber,
      contracts,
      multicallAddress: MULTICALL3,
    }) as Promise<unknown[]>;
  }

  private async readV2(position: PositionRecord, blockNumber: bigint, removeSlippageBps: number, rpc: RpcSource = "scan"): Promise<PositionValue> {
    if (!position.poolAddress) throw new Error("V2 position has no pair address");
    const client = this.rpcClient(position.chainId, rpc);
    const [balance, totalSupply, reserves] = await Promise.all([
      client.readContract({ address: position.poolAddress, abi: erc20Abi, functionName: "balanceOf", args: [position.owner], blockNumber }),
      client.readContract({ address: position.poolAddress, abi: v2PairAbi, functionName: "totalSupply", blockNumber }),
      client.readContract({ address: position.poolAddress, abi: v2PairAbi, functionName: "getReserves", blockNumber }),
    ]);
    if (balance === 0n || totalSupply === 0n) throw new Error("V2 position has zero liquidity");

    const token0Amount = (reserves[0] * balance) / totalSupply;
    const token1Amount = (reserves[1] * balance) / totalSupply;
    const priceMarker = reserves[0] === 0n ? 0n : (reserves[1] << 96n) / reserves[0];
    const minFactor = 10_000n - BigInt(removeSlippageBps);

    return {
      protocol: "v2",
      poolKey: position.poolAddress.toLowerCase(),
      sourcePool: position.poolAddress,
      token0: { token: position.token0, amount: token0Amount },
      token1: { token: position.token1, amount: token1Amount },
      liquidity: balance,
      priceMarker,
      minAmount0: (token0Amount * minFactor) / 10_000n,
      minAmount1: (token1Amount * minFactor) / 10_000n,
      unclaimedFees0: 0n,
      unclaimedFees1: 0n,
      observedBlock: blockNumber,
    };
  }

  private async readV3(position: PositionRecord, blockNumber: bigint, removeSlippageBps: number, rpc: RpcSource = "scan"): Promise<PositionValue> {
    const registry = this.chains.getById(position.chainId).registry;
    const client = this.rpcClient(position.chainId, rpc);
    const contracts = v3ContractsFor(registry, dexNameFromMetadata(position.metadata));
    const details = (await client.readContract({
      address: contracts.positionManager,
      abi: v3PositionManagerAbi,
      functionName: "positions",
      args: [BigInt(position.positionKey)],
      blockNumber,
    })) as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity, feeGrowthInside0Last, feeGrowthInside1Last, tokensOwed0, tokensOwed1] = details;
    if (liquidity === 0n) throw new Error("V3 position has zero liquidity");

    const poolAddress = await client.readContract({
      address: contracts.factory,
      abi: v3FactoryAbi,
      functionName: "getPool",
      args: [token0, token1, fee],
      blockNumber,
    });
    if (poolAddress === zeroAddress) throw new Error("V3 pool does not exist");

    const [slot0, feeGrowthGlobal0, feeGrowthGlobal1, tickLowerData, tickUpperData] = await Promise.all([
      client.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: "slot0", blockNumber }),
      client.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: "feeGrowthGlobal0X128", blockNumber }),
      client.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: "feeGrowthGlobal1X128", blockNumber }),
      client.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: "ticks", args: [tickLower], blockNumber }),
      client.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: "ticks", args: [tickUpper], blockNumber }),
    ]);

    const currentTick = slot0[1];
    const feeGrowthInside0 = v3FeeGrowthInside(feeGrowthGlobal0, currentTick, tickLower, tickUpper, tickLowerData[2], tickUpperData[2]);
    const feeGrowthInside1 = v3FeeGrowthInside(feeGrowthGlobal1, currentTick, tickLower, tickUpper, tickLowerData[3], tickUpperData[3]);
    const fee0 = tokensOwed0 + feeOwed(liquidity, feeGrowthInside0, feeGrowthInside0Last);
    const fee1 = tokensOwed1 + feeOwed(liquidity, feeGrowthInside1, feeGrowthInside1Last);
    const principal = amountsForLiquidity(slot0[0], tickLower, tickUpper, liquidity);

    return {
      protocol: "v3",
      poolKey: poolAddress.toLowerCase(),
      sourcePool: poolAddress,
      token0: { token: token0, amount: principal.amount0 },
      token1: { token: token1, amount: principal.amount1 },
      liquidity,
      priceMarker: (slot0[0] * slot0[0]) >> 96n,
      v3Fee: fee,
      minAmount0: applySlippage(principal.amount0, removeSlippageBps),
      minAmount1: applySlippage(principal.amount1, removeSlippageBps),
      unclaimedFees0: fee0,
      unclaimedFees1: fee1,
      range: rangeInfo(currentTick, tickLower, tickUpper, slot0[0]),
      observedBlock: blockNumber,
    };
  }

  private async readV4(position: PositionRecord, blockNumber: bigint, removeSlippageBps: number, rpc: RpcSource = "scan"): Promise<PositionValue> {
    const registry = this.chains.getById(position.chainId).registry;
    const client = this.rpcClient(position.chainId, rpc);
    const tokenId = BigInt(position.positionKey);
    const metadata = position.metadata as Record<string, unknown>;
    const poolKey = { currency0: metadata.currency0 as Address, currency1: metadata.currency1 as Address, fee: metadata.fee as number, tickSpacing: metadata.tickSpacing as number, hooks: metadata.hooks as Address };
    const tickLower = metadata.tickLower as number;
    const tickUpper = metadata.tickUpper as number;
    if (!poolKey.currency0 || !poolKey.currency1 || tickLower === undefined || tickUpper === undefined) {
      throw new Error("V4 position metadata is incomplete — needs full re-discovery");
    }
    const poolId = keccak256(encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    ));
    const [slot0, feeGrowthInside, storedPosition] = await Promise.all([
      this.readV4Slot0(client, registry.contracts.v4.stateView, poolId, blockNumber, rpc, position.chainId),
      client.readContract({ address: registry.contracts.v4.stateView, abi: v4StateViewAbi, functionName: "getFeeGrowthInside", args: [poolId, tickLower, tickUpper], blockNumber }),
      client.readContract({
        address: registry.contracts.v4.stateView,
        abi: v4StateViewAbi,
        functionName: "getPositionInfo",
        args: [poolId, v4PositionId(registry.contracts.v4.positionManager, tickLower, tickUpper, tokenId)],
        blockNumber,
      }),
    ]);
    const liquidity = storedPosition[0];
    if (liquidity === 0n) throw new Error("V4 position has zero liquidity");
    const principal = amountsForLiquidity(slot0[0], tickLower, tickUpper, liquidity);
    const fee0 = feeOwed(liquidity, feeGrowthInside[0], storedPosition[1]);
    const fee1 = feeOwed(liquidity, feeGrowthInside[1], storedPosition[2]);

    return {
      protocol: "v4",
      poolKey: poolId,
      sourcePool: null,
      token0: { token: poolKey.currency0, amount: principal.amount0 },
      token1: { token: poolKey.currency1, amount: principal.amount1 },
      liquidity,
      priceMarker: (slot0[0] * slot0[0]) >> 96n,
      minAmount0: applySlippage(principal.amount0, removeSlippageBps),
      minAmount1: applySlippage(principal.amount1, removeSlippageBps),
      v4PoolKey: poolKey,
      unclaimedFees0: fee0,
      unclaimedFees1: fee1,
      range: rangeInfo(slot0[1], tickLower, tickUpper, slot0[0]),
      observedBlock: blockNumber,
    };
  }

  private readV4Slot0(
    client: PublicClient,
    stateView: Address,
    poolId: `0x${string}`,
    blockNumber: bigint,
    rpc: RpcSource,
    chainId: number,
  ): Promise<V4Slot0> {
    const key = `${chainId}:${rpc}:${poolId}:${blockNumber}`;
    const cached = this.v4Slot0Cache.get(key);
    if (cached) return cached;
    const pending = (client.readContract({
      address: stateView,
      abi: v4StateViewAbi,
      functionName: "getSlot0",
      args: [poolId],
      blockNumber,
    }) as Promise<V4Slot0>).catch((error: unknown) => {
      this.v4Slot0Cache.delete(key);
      throw error;
    });
    this.v4Slot0Cache.set(key, pending);
    if (this.v4Slot0Cache.size > 48) {
      const oldest = this.v4Slot0Cache.keys().next().value;
      if (oldest && oldest !== key) this.v4Slot0Cache.delete(oldest);
    }
    return pending;
  }

  private rpcClient(chainId: number, source: RpcSource = "scan") {
    const { registry } = this.chains.getById(chainId);
    if (source === "monitoring") return this.chains.getForMonitoring(registry.name).client;
    if (source === "execution") {
      const clients = this.chains as unknown as { getForExecution?: (name: typeof registry.name) => { client: PublicClient } };
      if (typeof clients.getForExecution === "function") return clients.getForExecution(registry.name).client;
    }
    return this.chains.getForScan(registry.name).client;
  }

}

function unpackV4PositionInfo(value: bigint): { tickLower: number; tickUpper: number } {
  return {
    tickLower: signed24((value >> 8n) & 0xffffffn),
    tickUpper: signed24((value >> 32n) & 0xffffffn),
  };
}

function signed24(value: bigint): number {
  return Number(value >= 0x800000n ? value - 0x1000000n : value);
}

function numberMetadata(metadata: Record<string, unknown>, key: string): number {
  const value = metadata[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Position metadata ${key} is missing`);
  return value;
}

function v4PoolKeyFromMetadata(metadata: Record<string, unknown>): NonNullable<PositionValue["v4PoolKey"]> {
  const currency0 = metadata.currency0;
  const currency1 = metadata.currency1;
  const hooks = metadata.hooks;
  if (typeof currency0 !== "string" || typeof currency1 !== "string" || typeof hooks !== "string") {
    throw new Error("V4 position metadata is missing its pool currencies or hooks");
  }
  return {
    currency0: currency0 as Address,
    currency1: currency1 as Address,
    fee: numberMetadata(metadata, "fee"),
    tickSpacing: numberMetadata(metadata, "tickSpacing"),
    hooks: hooks as Address,
  };
}

function sameV4PoolKey(
  left: NonNullable<PositionValue["v4PoolKey"]>,
  right: NonNullable<PositionValue["v4PoolKey"]>,
): boolean {
  return left.currency0.toLowerCase() === right.currency0.toLowerCase()
    && left.currency1.toLowerCase() === right.currency1.toLowerCase()
    && left.fee === right.fee
    && left.tickSpacing === right.tickSpacing
    && left.hooks.toLowerCase() === right.hooks.toLowerCase();
}

function v4PositionId(positionManager: Address, tickLower: number, tickUpper: number, tokenId: bigint): `0x${string}` {
  return keccak256(encodePacked(
    ["address", "int24", "int24", "bytes32"],
    [positionManager, tickLower, tickUpper, pad(toHex(tokenId), { size: 32 })],
  ));
}

function feeOwed(liquidity: bigint, feeGrowthInside: bigint, feeGrowthLast: bigint): bigint {
  const modulo = 1n << 256n;
  const growth = feeGrowthInside >= feeGrowthLast
    ? feeGrowthInside - feeGrowthLast
    : modulo - feeGrowthLast + feeGrowthInside;
  return (liquidity * growth) >> 128n;
}

function v3FeeGrowthInside(
  feeGrowthGlobal: bigint,
  currentTick: number,
  tickLower: number,
  tickUpper: number,
  feeGrowthOutsideLower: bigint,
  feeGrowthOutsideUpper: bigint,
): bigint {
  const below = currentTick >= tickLower ? feeGrowthOutsideLower : feeGrowthGlobal - feeGrowthOutsideLower;
  const above = currentTick >= tickUpper ? feeGrowthGlobal - feeGrowthOutsideUpper : feeGrowthOutsideUpper;
  return feeGrowthGlobal - below - above;
}

function rangeInfo(currentTick: number, tickLower: number, tickUpper: number, sqrtPriceX96: bigint): import("../types.js").PositionRangeInfo {
  if (currentTick >= tickUpper) {
    const sqrtUpper = sqrtRatioAtTick(tickUpper);
    const currentPrice = (sqrtPriceX96 * sqrtPriceX96) >> 96n;
    const upperPrice = (sqrtUpper * sqrtUpper) >> 96n;
    const distanceBps = upperPrice > 0n ? (currentPrice * 10_000n) / upperPrice - 10_000n : 0n;
    return { tickLower, tickUpper, currentTick, currentSqrtPrice: sqrtPriceX96, status: "above", aboveDistanceBps: distanceBps > 0n ? distanceBps : 0n };
  }
  if (currentTick < tickLower) {
    return { tickLower, tickUpper, currentTick, currentSqrtPrice: sqrtPriceX96, status: "below" };
  }
  return { tickLower, tickUpper, currentTick, currentSqrtPrice: sqrtPriceX96, status: "in_range" };
}
