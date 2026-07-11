import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  pad,
  toHex,
  zeroAddress,
  type Address,
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
import type { PositionRecord, Protocol, TokenAmount } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import { amountsForLiquidity, applySlippage } from "./uniswap-math.js";

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
  unclaimedFees0: bigint;
  unclaimedFees1: bigint;
  observedBlock: bigint;
}

export class PositionReader {
  constructor(private readonly chains: ChainClients, private readonly slippageBps: number) {}

  async read(position: PositionRecord, blockNumber?: bigint): Promise<PositionValue> {
    const observedBlock = blockNumber ?? await this.chains.getById(position.chainId).client.getBlockNumber();
    if (position.protocol === "v2") return this.readV2(position, observedBlock);
    if (position.protocol === "v3") return this.readV3(position, observedBlock);
    return this.readV4(position, observedBlock);
  }

  private async readV2(position: PositionRecord, blockNumber: bigint): Promise<PositionValue> {
    if (!position.poolAddress) throw new Error("V2 position has no pair address");
    const { client } = this.chains.getById(position.chainId);
    const [balance, totalSupply, reserves] = await Promise.all([
      client.readContract({ address: position.poolAddress, abi: erc20Abi, functionName: "balanceOf", args: [position.owner], blockNumber }),
      client.readContract({ address: position.poolAddress, abi: v2PairAbi, functionName: "totalSupply", blockNumber }),
      client.readContract({ address: position.poolAddress, abi: v2PairAbi, functionName: "getReserves", blockNumber }),
    ]);
    if (balance === 0n || totalSupply === 0n) throw new Error("V2 position has zero liquidity");

    const token0Amount = (reserves[0] * balance) / totalSupply;
    const token1Amount = (reserves[1] * balance) / totalSupply;
    const priceMarker = reserves[0] === 0n ? 0n : (reserves[1] << 96n) / reserves[0];
    const minFactor = 10_000n - BigInt(this.slippageBps);

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

  private async readV3(position: PositionRecord, blockNumber: bigint): Promise<PositionValue> {
    const { client, registry } = this.chains.getById(position.chainId);
    const details = (await client.readContract({
      address: registry.contracts.v3.positionManager,
      abi: v3PositionManagerAbi,
      functionName: "positions",
      args: [BigInt(position.positionKey)],
      blockNumber,
    })) as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity, feeGrowthInside0Last, feeGrowthInside1Last] = details;
    if (liquidity === 0n) throw new Error("V3 position has zero liquidity");

    const poolAddress = await client.readContract({
      address: registry.contracts.v3.factory,
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
    const fee0 = feeOwed(liquidity, feeGrowthInside0, feeGrowthInside0Last);
    const fee1 = feeOwed(liquidity, feeGrowthInside1, feeGrowthInside1Last);
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
      minAmount0: applySlippage(principal.amount0, this.slippageBps),
      minAmount1: applySlippage(principal.amount1, this.slippageBps),
      unclaimedFees0: fee0,
      unclaimedFees1: fee1,
      observedBlock: blockNumber,
    };
  }

  private async readV4(position: PositionRecord, blockNumber: bigint): Promise<PositionValue> {
    const { client, registry } = this.chains.getById(position.chainId);
    const tokenId = BigInt(position.positionKey);
    const metadata = position.metadata as Record<string, unknown>;
    const poolKey = { currency0: metadata.currency0 as Address, currency1: metadata.currency1 as Address, fee: metadata.fee as number, tickSpacing: metadata.tickSpacing as number, hooks: metadata.hooks as Address };
    const tickLower = metadata.tickLower as number;
    const tickUpper = metadata.tickUpper as number;
    if (!poolKey.currency0 || !poolKey.currency1 || tickLower === undefined || tickUpper === undefined) {
      throw new Error("V4 position metadata is incomplete — needs full re-discovery");
    }
    if (poolKey.currency0 === zeroAddress || poolKey.currency1 === zeroAddress) {
      throw new Error("Native-currency V4 positions are not eligible for automatic settlement");
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
      client.readContract({ address: registry.contracts.v4.stateView, abi: v4StateViewAbi, functionName: "getSlot0", args: [poolId], blockNumber }),
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
      minAmount0: applySlippage(principal.amount0, this.slippageBps),
      minAmount1: applySlippage(principal.amount1, this.slippageBps),
      v4PoolKey: poolKey,
      unclaimedFees0: fee0,
      unclaimedFees1: fee1,
      observedBlock: blockNumber,
    };
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
