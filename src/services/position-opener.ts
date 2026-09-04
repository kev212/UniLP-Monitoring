import { createRequire } from "node:module";
import { createWalletClient, encodeAbiParameters, encodeFunctionData, formatEther, keccak256, type Address, type Hex, type PublicClient, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { erc20Abi, permit2Abi, v3FactoryAbi, v3PoolAbi, v4PoolKeysAbi, v4StateViewAbi, wethAbi } from "../abi.js";
import { chainRegistry } from "../chains.js";
import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type { ChainName, PositionGroupBinRecord, PositionGroupRecord, PositionRecord, QuoteToken, TransactionPlan } from "../types.js";
import {
  buildV3BidAskOpenPlan,
  buildV4BidAskOpenPlan,
  type V4PoolKey as BidAskV4PoolKey,
} from "./bid-ask-batch.js";
import {
  hashBidAskPlan,
  planBidAsk,
  validateBidAskRange,
  type BidAskAllocatedBin,
  type BidAskBinGeometry,
  type BidAskPlan,
} from "./bid-ask-planner.js";
import type { ChainClients } from "./chain-client.js";
import type { RoutePlanner } from "./route-planner.js";
import { buildSwapPlan } from "./swap-builder.js";
import { UNISWAP_API_ROUTER, type UniswapTradingApi } from "./uniswap-trading-api.js";
import { KyberSwapAggregatorApi } from "./kyberswap-aggregator-api.js";
import { applySlippage, baseAmountFromQuote, nearestSingleSidedTicks, quoteValueFromBase, sqrtRatioAtTick, tickToCeilSpacing, tickToFloorSpacing, ticksForDropPercent, ticksForRisePercent } from "./uniswap-math.js";
import { dexNameFromMetadata, v3ContractsFor, v3Deployments, type DexName } from "./v3-deployment.js";
import { isDynamicFee } from "./v4-pool.js";

const require = createRequire(import.meta.url);
const { Ether, Percent, Token } = require("@uniswap/sdk-core") as typeof import("@uniswap/sdk-core");
const { FeeAmount, NonfungiblePositionManager, Pool: V3SdkPool, Position: V3SdkPosition } = require("@uniswap/v3-sdk") as typeof import("@uniswap/v3-sdk");
const { Pool: V4SdkPool, Position: V4SdkPosition, V4PositionManager } = require("@uniswap/v4-sdk") as typeof import("@uniswap/v4-sdk");
const { Pool: PancakeV3Pool, Position: PancakeV3Position, NonfungiblePositionManager: PancakeNpm, FeeAmount: PancakeFeeAmount } = require("@pancakeswap/v3-sdk") as typeof import("@pancakeswap/v3-sdk");
const { Token: PancakeToken, Percent: PancakePercent } = require("@pancakeswap/swap-sdk-core") as typeof import("@pancakeswap/swap-sdk-core");
type V3Position = import("@uniswap/v3-sdk").Position;
type V4Position = import("@uniswap/v4-sdk").Position;
type V3FeeAmount = import("@uniswap/v3-sdk").FeeAmount;
const NVDA_SYMBOL = "NVDA";
const UNISWAP_MAX_TICK = 887_272;
const EXTREME_TICK_ABS = 400_000;
const EXTREME_TICK_EDGE = 20_000;
const MIN_MINT_UTILIZATION_BPS = 9_000n;

export type OpenMode = "single" | "dual";
export type BidAskDirection = "above" | "below";

export interface OpenPositionPreview {
  protocol: "v3" | "v4";
  dex?: DexName;
  chain: ChainName;
  poolAddress: Hex;
  pair: string;
  feeTier: number;
  feeLabel: string;
  quoteToken: Address;
  quoteTokenSymbol: string;
  quoteIsToken0: boolean;
  token0: Address;
  token1: Address;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  quoteTokenDecimals: number;
  currentTick: number;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  sqrtPriceX96: bigint;
  poolLiquidity: bigint;
  hooks: Address;
  currentLpFee?: number;
  liquidity: bigint;
  depositAmount: bigint;
  lowerPrice: string;
  upperPrice: string;
  currentPrice: string;
  dropPercent: number;
  spotMark?: bigint;
  executableOut?: bigint;
  mode: OpenMode;
  baseToken?: Address;
  baseTokenSymbol?: string;
  baseAmount?: bigint;
  quoteSideAmount?: bigint;
  swapAmount?: bigint;
  expectedBaseFromSwap?: bigint;
}

export interface BidAskOpenPreview {
  protocol: "v3" | "v4";
  dex?: DexName;
  chain: ChainName;
  poolAddress: Hex;
  poolKey?: V4PoolKey;
  v4PoolKey?: V4PoolKey;
  positionManager: Address;
  pair: string;
  feeTier: number;
  feeLabel: string;
  quoteToken: Address;
  quoteTokenSymbol: string;
  quoteIsToken0: boolean;
  direction: BidAskDirection;
  token0: Address;
  token1: Address;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  quoteTokenDecimals: number;
  currentTick: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  poolLiquidity: bigint;
  hooks: Address;
  rangePercent: number;
  dropPercent: number;
  depositAmount: bigint;
  requestedBinCount: number;
  generatedBinCount: number;
  mintableBinCount: number;
  outerTickLower: number;
  outerTickUpper: number;
  anchorBinIndex: number;
  totalAmount0: bigint;
  totalAmount1: bigint;
  plan: BidAskPlan;
  bins: BidAskPlan["bins"];
  planHash: Hex;
  batchPlan: TransactionPlan;
  transactionPlan: TransactionPlan;
  deadline: bigint;
  estimatedGas: bigint | null;
  blockGasLimit: bigint | null;
  atomicBatchFeasible: boolean;
  groupId?: string;
}

export interface BidAskOpenExecution {
  hash: Hex | null;
  groupId?: string;
  plan: TransactionPlan;
  estimatedGas: bigint;
  blockGasLimit: bigint | null;
  pendingReconciliation?: boolean;
}

const Q192 = 1n << 192n;
const V3_SUPPORTED_FEES = new Set<number>([FeeAmount.LOWEST, FeeAmount.LOW, FeeAmount.MEDIUM, FeeAmount.HIGH]);
const PANCAKE_V3_FEES = new Set<number>([PancakeFeeAmount.LOWEST, PancakeFeeAmount.LOW, PancakeFeeAmount.MEDIUM, PancakeFeeAmount.HIGH]);

type V4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

type BidAskDatabase = Pick<
  Database,
  | "createPositionGroup"
  | "createPositionGroupBin"
  | "getPositionGroup"
  | "setPositionGroupStatus"
  | "setPositionGroupOpenTransaction"
  | "recordPositionGroupExecution"
  | "withExecutionLock"
  | "hasPendingRawTransaction"
  | "nextPositionGroupExecutionNonce"
>;

export type BidAskOpenReconciler = (
  chain: ChainName,
  groupId: string,
  transactionHash: Hex,
  receipt?: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>,
) => Promise<PositionRecord[]>;

interface BidAskPoolState {
  protocol: "v3" | "v4";
  dex?: DexName;
  poolAddress: Hex;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  currentTick: number;
  sqrtPriceX96: bigint;
  poolLiquidity: bigint;
  poolKey?: V4PoolKey;
}

interface BidAskGasResult {
  estimatedGas: bigint;
  blockGasLimit: bigint | null;
}

type BidAskRuntimeConfig = RuntimeConfig & {
  bidAskLadderEnabled?: boolean | string;
  bidAskLadderProtocols?: readonly ("v3" | "v4")[] | string;
  bidAskLadderMaxBins?: number;
  bidAskLadderAtomicMaxBlockGasBps?: number;
  bidAskLadderV4MaxOpenGasUsd?: number;
  bidAskLadderV4EthUsd?: number;
  bidAskLadderTransactionDeadlineSeconds?: number;
  bidAskLadderMaxPriceDeviationBps?: number;
  bidAskLadderOpenSlippageBps?: number;
  bidAskLadderMaxGas?: bigint | number;
};

export class PositionOpener {
  private readonly account;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly chains: ChainClients,
    private readonly routes?: RoutePlanner,
    private readonly tradingApi?: UniswapTradingApi,
    private readonly database?: BidAskDatabase,
    private readonly reconcileBidAskOpen?: BidAskOpenReconciler,
    private readonly ingestOpenReceipt?: (chain: ChainName, receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>) => Promise<unknown>,
    private readonly kyberswapApi?: KyberSwapAggregatorApi,
  ) {
    this.account = config.executorPrivateKey ? privateKeyToAccount(config.executorPrivateKey) : undefined;
  }

  private client(chain: ChainName): PublicClient {
    return this.chains.getForExecution(chain).client;
  }

  private executionClient(chain: ChainName): PublicClient {
    return this.chains.getForExecution(chain).client;
  }

  private walletClient(chain: ChainName) {
    if (!this.account) throw new Error("Executor private key is not configured");
    const { registry, transport } = this.chains.getForExecution(chain);
    return createWalletClient({ chain: registry.chain, transport, account: this.account });
  }

  async prepareOpen(poolAddress: string, chain: ChainName, rangePercent: number, depositAmount: bigint, quoteToken: QuoteToken, mode: OpenMode = "single"): Promise<OpenPositionPreview> {
    const normalized = poolAddress.toLowerCase() as Hex;
    const isV4 = normalized.length === 66 && normalized.startsWith("0x");
    const protocol = isV4 ? "v4" : "v3";

    if (mode === "dual" && quoteToken.symbol === NVDA_SYMBOL) {
      throw new Error("NVDA quote supports single-side normal opens only");
    }

    if (protocol === "v3") return this.prepareV3(normalized, chain, rangePercent, depositAmount, quoteToken, mode);
    return this.prepareV4(normalized, chain, rangePercent, depositAmount, quoteToken, mode);
  }

  async prepareBidAskOpen(
    poolAddress: string,
    chain: ChainName,
    rangePercent: number,
    depositAmount: bigint,
    quoteToken: QuoteToken,
    requestedBinCount: number,
    direction?: BidAskDirection,
  ): Promise<BidAskOpenPreview> {
    if (chain !== "base" && chain !== "robinhood" && chain !== "bsc") throw new Error("Bid-Ask ladders are supported on Base, Robinhood, and BSC only");
    const normalized = poolAddress.toLowerCase() as Hex;
    const protocol = normalized.length === 66 && normalized.startsWith("0x") ? "v4" : "v3";
    this.assertBidAskEnabled(protocol, requestedBinCount);

    const state = await this.readBidAskPool(normalized, chain);
    assertSafeOpenMarket(state.currentTick, state.poolLiquidity);
    this.assertBidAskPoolSupported(state);
    const quoteAddress = openPoolQuoteAddress(protocol, this.chains.getForScan(chain).registry.chain.id, quoteToken).toLowerCase();
    const quoteIsToken0 = quoteAddress === state.token0.toLowerCase();
    if (!quoteIsToken0 && quoteAddress !== state.token1.toLowerCase()) {
      throw new Error("Quote token is neither token0 nor token1 of this pool");
    }
    void direction;
    const resolvedDirection = bidAskDirectionForQuote(quoteIsToken0);

    const outer = bidAskOuterTicks(state.currentTick, state.tickSpacing, quoteIsToken0, rangePercent);
    const [token0Decimals, token1Decimals] = await Promise.all([
      this.tokenDecimals(this.client(chain), state.token0),
      this.tokenDecimals(this.client(chain), state.token1),
    ]);
    const [token0Symbol, token1Symbol] = await Promise.all([
      this.tokenSymbol(this.client(chain), state.token0, chain),
      this.tokenSymbol(this.client(chain), state.token1, chain),
    ]);
    const baseSymbol = quoteIsToken0 ? token1Symbol : token0Symbol;
    const plan = this.makeBidAskPlan(state, chain, quoteIsToken0, token0Decimals, token1Decimals, outer, depositAmount, requestedBinCount);
    assertMintUtilization(quoteIsToken0 ? plan.totalAmount0 : plan.totalAmount1, depositAmount);
    await this.assertExecutableOpenPrice({
      chain,
      protocol,
      pool: normalized,
      token0: state.token0,
      token1: state.token1,
      fee: state.fee,
      tickSpacing: state.tickSpacing,
      hooks: state.hooks,
      dex: state.dex ?? "uniswap",
      quoteToken: quoteToken.address,
      quoteIsToken0,
      quoteDecimals: quoteIsToken0 ? token0Decimals : token1Decimals,
      sqrtPriceX96: state.sqrtPriceX96,
      depositAmount,
    });
    const deadline = this.bidAskDeadline();
    const batchPlan = this.buildBidAskBatch(state, chain, plan, quoteIsToken0, quoteToken, deadline);
    const planHash = hashBidAskPlan(plan);
    const pair = quoteIsToken0 ? `${baseSymbol}/${quoteToken.symbol}` : `${quoteToken.symbol}/${baseSymbol}`;

    return {
      protocol,
      dex: state.dex ?? "uniswap",
      chain,
      poolAddress: normalized,
      ...(state.poolKey ? { poolKey: state.poolKey } : {}),
      ...(state.poolKey ? { v4PoolKey: state.poolKey } : {}),
      positionManager: this.positionManager(chain, protocol, state.dex ?? "uniswap"),
      pair,
      feeTier: state.fee,
      feeLabel: `${(state.fee / 10_000).toFixed(2)}%`,
      quoteToken: quoteToken.address,
      quoteTokenSymbol: quoteToken.symbol,
      quoteIsToken0,
      direction: resolvedDirection,
      token0: state.token0,
      token1: state.token1,
      token0Symbol,
      token1Symbol,
      token0Decimals,
      token1Decimals,
      quoteTokenDecimals: quoteIsToken0 ? token0Decimals : token1Decimals,
      currentTick: state.currentTick,
      tickSpacing: state.tickSpacing,
      sqrtPriceX96: state.sqrtPriceX96,
      poolLiquidity: state.poolLiquidity,
      hooks: state.hooks,
      rangePercent,
      dropPercent: rangePercent,
      depositAmount,
      requestedBinCount,
      generatedBinCount: plan.generatedBinCount,
      mintableBinCount: plan.mintableBinCount,
      outerTickLower: plan.outerTickLower,
      outerTickUpper: plan.outerTickUpper,
      anchorBinIndex: plan.anchorIndex,
      totalAmount0: plan.totalAmount0,
      totalAmount1: plan.totalAmount1,
      plan,
      bins: plan.bins,
      planHash,
      batchPlan,
      transactionPlan: batchPlan,
      deadline,
      estimatedGas: null,
      blockGasLimit: null,
      atomicBatchFeasible: true,
    };
  }

  async prepareBidAsk(
    poolAddress: string,
    chain: ChainName,
    rangePercent: number,
    depositAmount: bigint,
    quoteToken: QuoteToken,
    requestedBinCount: number,
    direction?: BidAskDirection,
  ): Promise<BidAskOpenPreview> {
    return this.prepareBidAskOpen(poolAddress, chain, rangePercent, depositAmount, quoteToken, requestedBinCount, direction);
  }

  async prepareBidAskLadder(
    poolAddress: string,
    chain: ChainName,
    rangePercent: number,
    depositAmount: bigint,
    quoteToken: QuoteToken,
    requestedBinCount: number,
    direction?: BidAskDirection,
  ): Promise<BidAskOpenPreview> {
    return this.prepareBidAskOpen(poolAddress, chain, rangePercent, depositAmount, quoteToken, requestedBinCount, direction);
  }

  async detectQuoteToken(poolAddress: string, chain: ChainName): Promise<QuoteToken> {
    const normalized = poolAddress.toLowerCase() as Hex;
    const isV4 = normalized.length === 66 && normalized.startsWith("0x");
    const client = this.client(chain);
    let token0: Address;
    let token1: Address;
    if (isV4) {
      const poolKey = await this.resolveV4PoolKey(normalized, chain);
      token0 = poolKey.currency0;
      token1 = poolKey.currency1;
    } else {
      [token0, token1] = await Promise.all([
        client.readContract({ address: normalized, abi: v3PoolAbi, functionName: "token0" }) as Promise<Address>,
        client.readContract({ address: normalized, abi: v3PoolAbi, functionName: "token1" }) as Promise<Address>,
      ]);
    }
    const allowed = this.config.quoteTokens[chain] ?? [];
    const registry = this.chains.getForScan(chain).registry;
    const quote = selectOpenQuoteToken(allowed, token0, token1, registry.quotePriority);
    if (quote) return !isV4 && quote.symbol === registry.wrappedSymbol ? { ...quote, symbol: registry.nativeSymbol } : quote;
    const hasNativeCurrency = token0.toLowerCase() === zeroAddress || token1.toLowerCase() === zeroAddress;
    const wrappedNativeAllowed = allowed.some(({ address }) => address.toLowerCase() === registry.wrappedNative.toLowerCase());
    if (hasNativeCurrency && (allowed.some(({ symbol }) => symbol === registry.nativeSymbol) || (isV4 && wrappedNativeAllowed))) {
      return { symbol: registry.nativeSymbol, address: zeroAddress };
    }
    throw new Error("Pool tidak memiliki quote token dari allowlist");
  }

  async quoteTokenDecimals(chain: ChainName, token: Address): Promise<number> {
    return this.tokenDecimals(this.client(chain), token);
  }

  private async prepareV3(pool: Hex, chain: ChainName, rangePercent: number, depositAmount: bigint, quoteToken: QuoteToken, mode: OpenMode): Promise<OpenPositionPreview> {
    const client = this.client(chain);
    const [token0, token1, fee, slot0, tickSpacing, liquidity] = await Promise.all([
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "token0" }) as Promise<Address>,
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "token1" }) as Promise<Address>,
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "fee" }) as Promise<number>,
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "slot0" }),
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "tickSpacing" }) as Promise<number>,
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "liquidity" }) as Promise<bigint>,
    ]);

    const dex = await this.detectV3Dex(chain, pool, token0, token1, Number(fee));
    if (!dex) throw new Error("V3 pool does not match a configured factory");
    const allowedFees = dex === "pancake" ? PANCAKE_V3_FEES : V3_SUPPORTED_FEES;
    if (!allowedFees.has(Number(fee))) throw new Error(`V3 fee tier ${fee} is unsupported by the official SDK`);
    return this.buildPreview("v3", chain, pool, token0, token1, Number(fee), Number(tickSpacing), slot0[1], slot0[0], liquidity, zeroAddress, rangePercent, depositAmount, quoteToken, mode, dex);
  }

  private async prepareV4(poolId: Hex, chain: ChainName, rangePercent: number, depositAmount: bigint, quoteToken: QuoteToken, mode: OpenMode): Promise<OpenPositionPreview> {
    const client = this.client(chain);
    const { registry } = this.chains.getForScan(chain);

    const [slot0, liquidity, poolKey] = await Promise.all([
      client.readContract({ address: registry.contracts.v4.stateView, abi: v4StateViewAbi, functionName: "getSlot0", args: [poolId] }),
      client.readContract({ address: registry.contracts.v4.stateView, abi: v4StateViewAbi, functionName: "getLiquidity", args: [poolId] }) as Promise<bigint>,
      this.resolveV4PoolKey(poolId, chain),
    ]);

    return this.buildPreview("v4", chain, poolId, poolKey.currency0, poolKey.currency1, Number(poolKey.fee), poolKey.tickSpacing, slot0[1], slot0[0], liquidity, poolKey.hooks, rangePercent, depositAmount, quoteToken, mode, "uniswap", Number(slot0[3]));
  }

  private async buildPreview(
    protocol: "v3" | "v4",
    chain: ChainName,
    pool: Hex,
    token0: Address,
    token1: Address,
    fee: number,
    tickSpacing: number,
    currentTick: number,
    sqrtPriceX96: bigint,
    poolLiquidity: bigint,
    hooks: Address,
    rangePercent: number,
    depositAmount: bigint,
    quoteToken: QuoteToken,
    mode: OpenMode,
    dex: DexName = "uniswap",
    currentLpFee?: number,
  ): Promise<OpenPositionPreview> {
    const client = this.client(chain);
    const quoteAddr = openPoolQuoteAddress(protocol, this.chains.getForScan(chain).registry.chain.id, quoteToken).toLowerCase() as Address;
    const quoteIsToken0 = quoteAddr === token0.toLowerCase();
    if (!quoteIsToken0 && quoteAddr !== token1.toLowerCase()) {
      throw new Error("Quote token is neither token0 nor token1 of this pool");
    }
    assertSafeOpenMarket(currentTick, poolLiquidity);

    const [token0Decimals, token1Decimals] = await Promise.all([this.tokenDecimals(client, token0), this.tokenDecimals(client, token1)]);
    const baseToken = quoteIsToken0 ? token1 : token0;
    const baseDecimals = quoteIsToken0 ? token1Decimals : token0Decimals;
    const quoteDecimals = quoteIsToken0 ? token0Decimals : token1Decimals;
    const baseSymbol = await this.tokenSymbol(client, baseToken, chain);

    let tickLower: number;
    let tickUpper: number;

    if (mode === "dual") {
      tickLower = tickToFloorSpacing(currentTick - ticksForDropPercent(rangePercent), tickSpacing);
      tickUpper = tickToCeilSpacing(currentTick + ticksForRisePercent(rangePercent), tickSpacing);
    } else {
      const range = nearestSingleSidedTicks(currentTick, tickSpacing, quoteIsToken0, rangePercent);
      tickLower = range.tickLower;
      tickUpper = range.tickUpper;
    }

    const position = protocol === "v3"
      ? this.v3Position(chain, token0, token1, token0Decimals, token1Decimals, fee, sqrtPriceX96, poolLiquidity, currentTick, tickLower, tickUpper, depositAmount, quoteIsToken0, mode, dex)
      : this.v4Position(chain, token0, token1, token0Decimals, token1Decimals, fee, tickSpacing, hooks, sqrtPriceX96, poolLiquidity, currentTick, tickLower, tickUpper, depositAmount, quoteIsToken0, mode);
    const liquidity = BigInt(position.liquidity.toString());
    if (liquidity === 0n) throw new Error("Deposit amount is too small for this pool range");

    if (mode === "single") {
      this.assertSingleSideSpend(position, quoteIsToken0, depositAmount);
      const lockedQuote = BigInt((quoteIsToken0 ? position.mintAmounts.amount0 : position.mintAmounts.amount1).toString());
      assertMintUtilization(lockedQuote, depositAmount);
    } else {
      this.assertDualSidePosition(position, quoteIsToken0);
    }
    const exitCheck = await this.assertExecutableOpenPrice({
      chain, protocol, pool, token0, token1, fee, tickSpacing, hooks, dex,
      quoteToken: quoteToken.address, quoteIsToken0, quoteDecimals, sqrtPriceX96, depositAmount,
    });

    const sqrtLower = sqrtRatioAtTick(tickLower);
    const sqrtUpper = sqrtRatioAtTick(tickUpper);

    const currentPrice = this.formatPrice(sqrtPriceX96, quoteIsToken0, baseDecimals, quoteDecimals);
    const pair = quoteIsToken0 ? `${baseSymbol}/${quoteToken.symbol}` : `${quoteToken.symbol}/${baseSymbol}`;

    const [lowerPrice, upperPrice] = this.sortPrices(
      this.formatPrice(sqrtLower, quoteIsToken0, baseDecimals, quoteDecimals),
      this.formatPrice(sqrtUpper, quoteIsToken0, baseDecimals, quoteDecimals),
    );

    const token0Symbol = quoteIsToken0 ? quoteToken.symbol : baseSymbol;
    const token1Symbol = quoteIsToken0 ? baseSymbol : quoteToken.symbol;
    const basePreview: OpenPositionPreview = {
      protocol, dex: protocol === "v3" ? dex : "uniswap", chain, poolAddress: pool, pair, feeTier: fee,
      feeLabel: isDynamicFee(fee) ? `${((currentLpFee ?? 0) / 10_000).toFixed(2)}% dynamic` : `${(fee / 10_000).toFixed(2)}%`,
      quoteToken: quoteToken.address, quoteTokenSymbol: quoteToken.symbol,
      quoteIsToken0, token0, token1, token0Symbol, token1Symbol, token0Decimals, token1Decimals,
      quoteTokenDecimals: quoteDecimals, currentTick, tickSpacing, tickLower, tickUpper, sqrtPriceX96, poolLiquidity, hooks,
      ...(currentLpFee !== undefined ? { currentLpFee } : {}), liquidity, depositAmount,
      lowerPrice, upperPrice, currentPrice, dropPercent: rangePercent, mode,
      spotMark: exitCheck.spotMark, executableOut: exitCheck.executableOut,
    };

    if (mode === "dual") {
      const split = this.computeDualSplit(position, quoteIsToken0, depositAmount, sqrtPriceX96);
      assertMintUtilization(split.quoteSideAmount + split.swapAmount, depositAmount);
      return { ...basePreview, baseToken, baseTokenSymbol: baseSymbol, ...split };
    }

    return basePreview;
  }

  async executeOpen(preview: OpenPositionPreview): Promise<{ hash: Hex | null; swapHash?: Hex | null }> {
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + 600);
    assertSafeOpenMarket(preview.currentTick, preview.poolLiquidity);
    const refreshed = await this.prepareOpen(preview.poolAddress, preview.chain, preview.dropPercent, preview.depositAmount, { address: preview.quoteToken, symbol: preview.quoteTokenSymbol }, preview.mode);
    let merged = { ...preview, ...refreshed, tickLower: preview.tickLower, tickUpper: preview.tickUpper };

    if (preview.mode === "single") {
      if (!this.isStillSingleSided(preview, refreshed.currentTick)) throw new Error("Pool price moved into the requested range; review and confirm again");
      if (preview.protocol === "v3") return this.executeV3(merged, deadline);
      return this.executeV4(merged, deadline);
    }

    merged = this.recomputeDualPreviewForConfirmedRange(preview, refreshed);
    if (!this.isStillStraddling(preview, refreshed.currentTick)) throw new Error("Pool price moved outside the dual-side range; review and confirm again");

    await this.ensureWrappedNativeFunding(this.executionClient(preview.chain), preview.chain, preview.quoteToken, preview.depositAmount, this.config.executorAddress);
    const swapResult = await this.swapQuoteForBase(merged);
    const baseAmount = swapResult.actualBaseOut;
    const quoteSideAmount = merged.quoteSideAmount ?? 0n;
    const postSwap = await this.prepareOpen(preview.poolAddress, preview.chain, preview.dropPercent, preview.depositAmount, { address: preview.quoteToken, symbol: preview.quoteTokenSymbol }, preview.mode);
    this.assertSameOpenPool(merged, postSwap);
    if (!this.isStillStraddling(preview, postSwap.currentTick)) throw new Error("Dual-side swap moved the pool outside the confirmed range; mint was not broadcast");
    const mintPreview = {
      ...merged,
      currentTick: postSwap.currentTick,
      sqrtPriceX96: postSwap.sqrtPriceX96,
      poolLiquidity: postSwap.poolLiquidity,
      hooks: postSwap.hooks,
      ...(postSwap.currentLpFee !== undefined ? { currentLpFee: postSwap.currentLpFee } : {}),
    };
    if (preview.protocol === "v3") {
      return { ...(await this.executeV3Dual(mintPreview, deadline, quoteSideAmount, baseAmount)), swapHash: swapResult.hash };
    }
    return { ...(await this.executeV4Dual(mintPreview, deadline, quoteSideAmount, baseAmount)), swapHash: swapResult.hash };
  }

  async executeBidAskOpen(preview: BidAskOpenPreview): Promise<BidAskOpenExecution> {
    if (preview.chain !== "base" && preview.chain !== "robinhood" && preview.chain !== "bsc") throw new Error("Bid-Ask ladders are supported on Base, Robinhood, and BSC only");
    this.assertBidAskEnabled(preview.protocol, preview.requestedBinCount);
    assertSafeOpenMarket(preview.currentTick, preview.poolLiquidity);
    if (!this.database || !this.reconcileBidAskOpen) {
      throw new Error("Bid-Ask open requires durable group persistence and receipt reconciliation");
    }
    const client = this.executionClient(preview.chain);
    const firstState = await this.readBidAskPool(preview.poolAddress, preview.chain);
    assertSafeOpenMarket(firstState.currentTick, firstState.poolLiquidity);
    this.assertBidAskPoolSupported(firstState);
    this.assertBidAskStateMatches(preview, firstState);
    this.assertBidAskOrientation(preview, firstState.currentTick);
    this.assertBidAskPriceGuard(preview, firstState.sqrtPriceX96);

    const quoteAmount = preview.quoteIsToken0 ? preview.plan.totalAmount0 : preview.plan.totalAmount1;
    const executor = this.config.executorAddress;
    if (quoteAmount <= 0n) throw new Error("Bid-Ask quote allocation is zero");

    if (preview.protocol === "v3") {
      if (isBidAskNativeFunding(preview.protocol, preview.quoteToken, preview.quoteTokenSymbol)) {
        await this.ensureNativeBalance(client, executor, quoteAmount);
      } else {
        await this.ensureApproval(client, preview.quoteToken, preview.positionManager, quoteAmount, executor, preview.chain);
      }
    } else if (preview.quoteToken.toLowerCase() === zeroAddress.toLowerCase()) {
      await this.ensureNativeBalance(client, executor, quoteAmount);
    } else {
      const { registry } = this.chains.getForScan(preview.chain);
      await this.ensureWrappedNativeFunding(client, preview.chain, preview.quoteToken, quoteAmount, executor);
      await this.ensureApproval(client, preview.quoteToken, registry.contracts.v4.permit2, quoteAmount, executor, preview.chain);
      await this.ensurePermit2Approval(client, preview.quoteToken, registry.contracts.v4.positionManager, quoteAmount, executor, preview.chain);
    }

    const state = await this.readBidAskPool(preview.poolAddress, preview.chain);
    assertSafeOpenMarket(state.currentTick, state.poolLiquidity);
    this.assertBidAskPoolSupported(state);
    this.assertBidAskStateMatches(preview, state);
    this.assertBidAskOrientation(preview, state.currentTick);
    this.assertBidAskPriceGuard(preview, state.sqrtPriceX96);
    const plan = this.makeBidAskPlan(
      state,
      preview.chain,
      preview.quoteIsToken0,
      preview.token0Decimals,
      preview.token1Decimals,
      { lowerTick: preview.outerTickLower, upperTick: preview.outerTickUpper },
      preview.depositAmount,
      preview.requestedBinCount,
    );
    assertMintUtilization(preview.quoteIsToken0 ? plan.totalAmount0 : plan.totalAmount1, preview.depositAmount);
    const deadline = this.bidAskDeadline();
    const batchPlan = this.buildBidAskBatch(
      state,
      preview.chain,
      plan,
      preview.quoteIsToken0,
      { address: preview.quoteToken, symbol: preview.quoteTokenSymbol },
      deadline,
    );
    const gas = await this.simulateAndEstimateBidAsk(preview.chain, preview.protocol, batchPlan, plan.generatedBinCount);
    const planHash = hashBidAskPlan(plan);
    const finalPreview: BidAskOpenPreview = {
      ...preview,
      currentTick: state.currentTick,
      sqrtPriceX96: state.sqrtPriceX96,
      poolLiquidity: state.poolLiquidity,
      ...(state.poolKey ? { poolKey: state.poolKey } : {}),
      ...(state.poolKey ? { v4PoolKey: state.poolKey } : {}),
      generatedBinCount: plan.generatedBinCount,
      mintableBinCount: plan.mintableBinCount,
      outerTickLower: plan.outerTickLower,
      outerTickUpper: plan.outerTickUpper,
      anchorBinIndex: plan.anchorIndex,
      totalAmount0: plan.totalAmount0,
      totalAmount1: plan.totalAmount1,
      plan,
      bins: plan.bins,
      planHash,
      batchPlan,
      transactionPlan: batchPlan,
      deadline,
      estimatedGas: gas.estimatedGas,
      blockGasLimit: gas.blockGasLimit,
      atomicBatchFeasible: true,
    };
    const groupId = await this.persistBidAskPlan(finalPreview);
    if (!groupId) throw new Error("Bid-Ask open group was not persisted");
    await this.database.setPositionGroupStatus(groupId, "opening", {
      planHash,
      atomicBatch: true,
      noOpeningSwap: true,
    });
    let openedHash: Hex | null = null;
    try {
      const result = await this.broadcastBidAsk(preview.chain, preview.protocol, groupId, batchPlan.to, batchPlan.data, batchPlan.value ?? 0n, gas.estimatedGas);
      openedHash = result.hash;
      let pendingReconciliation = result.pendingReconciliation === true;
      if (result.hash) {
        if (result.receipt) {
          try {
            await this.reconcileBidAskOpen(preview.chain, groupId, result.hash, result.receipt);
            pendingReconciliation = false;
          } catch (error) {
            pendingReconciliation = true;
            log.warn({ err: error, chain: preview.chain, groupId, transactionHash: result.hash }, "Bid-Ask open confirmed; receipt reconciliation deferred");
          }
        }
      } else {
        await this.database.setPositionGroupStatus(groupId, "cancelled", {
          reason: "bid_ask_open_no_transaction",
          lastExecutionError: "Bid-Ask open did not produce a transaction hash",
        });
      }
      return {
        hash: result.hash,
        groupId,
        plan: batchPlan,
        estimatedGas: gas.estimatedGas,
        blockGasLimit: gas.blockGasLimit,
        ...(pendingReconciliation ? { pendingReconciliation: true } : {}),
      };
    } catch (error) {
      const current = openedHash ? null : await this.database.getPositionGroup(groupId);
      if (!openedHash && !current?.openTransactionHash) {
        await this.database.setPositionGroupStatus(groupId, "cancelled", {
          reason: "bid_ask_open_failed",
          lastExecutionError: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  async executeBidAsk(preview: BidAskOpenPreview): Promise<BidAskOpenExecution> {
    return this.executeBidAskOpen(preview);
  }

  async executeBidAskLadder(preview: BidAskOpenPreview): Promise<BidAskOpenExecution> {
    return this.executeBidAskOpen(preview);
  }

  private assertBidAskEnabled(protocol: "v3" | "v4", requestedBinCount: number): void {
    const config = this.config as BidAskRuntimeConfig;
    const enabled = config.bidAskLadderEnabled;
    if (enabled === false || String(enabled).toLowerCase() === "false") throw new Error("Bid-Ask ladder is disabled");

    const configuredProtocols = config.bidAskLadderProtocols;
    if (configuredProtocols !== undefined) {
      const protocols: readonly string[] = typeof configuredProtocols === "string"
        ? configuredProtocols.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
        : configuredProtocols;
      if (!protocols.includes(protocol)) throw new Error(`Bid-Ask protocol ${protocol} is disabled`);
    }

    const maxBins = config.bidAskLadderMaxBins;
    if (maxBins !== undefined && Number.isSafeInteger(maxBins) && (requestedBinCount > maxBins || maxBins < 1)) {
      throw atomicBatchInfeasible(`requested bin count ${requestedBinCount} exceeds the configured maximum`);
    }
  }

  private async readBidAskPool(poolAddress: Hex, chain: ChainName): Promise<BidAskPoolState> {
    const client = this.client(chain);
    const { registry } = this.chains.getForScan(chain);
    const isV4 = poolAddress.length === 66 && poolAddress.startsWith("0x");

    if (!isV4) {
      const [token0, token1, fee, slot0, tickSpacing, poolLiquidity] = await Promise.all([
        client.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: "token0" }) as Promise<Address>,
        client.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: "token1" }) as Promise<Address>,
        client.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: "fee" }) as Promise<number>,
        client.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: "slot0" }),
        client.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: "tickSpacing" }) as Promise<number>,
        client.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: "liquidity" }) as Promise<bigint>,
      ]);
      const dex = await this.detectV3Dex(chain, poolAddress, token0, token1, Number(fee));
      if (!dex) throw new Error("Bid-Ask V3 pool does not match a configured factory");
      const typedSlot0 = slot0 as readonly [bigint, number, ...unknown[]];
      return {
        protocol: "v3",
        dex,
        poolAddress,
        token0,
        token1,
        fee: Number(fee),
        tickSpacing: Number(tickSpacing),
        hooks: zeroAddress,
        currentTick: Number(typedSlot0[1]),
        sqrtPriceX96: BigInt(typedSlot0[0]),
        poolLiquidity: BigInt(poolLiquidity),
      };
    }

    const [slot0, poolLiquidity, poolKey] = await Promise.all([
      client.readContract({ address: registry.contracts.v4.stateView, abi: v4StateViewAbi, functionName: "getSlot0", args: [poolAddress] }),
      client.readContract({ address: registry.contracts.v4.stateView, abi: v4StateViewAbi, functionName: "getLiquidity", args: [poolAddress] }) as Promise<bigint>,
      this.resolveV4PoolKey(poolAddress, chain),
    ]);
    const typedSlot0 = slot0 as readonly [bigint, number, ...unknown[]];
    return {
      protocol: "v4",
      poolAddress,
      token0: poolKey.currency0,
      token1: poolKey.currency1,
      fee: Number(poolKey.fee),
      tickSpacing: Number(poolKey.tickSpacing),
      hooks: poolKey.hooks,
      currentTick: Number(typedSlot0[1]),
      sqrtPriceX96: BigInt(typedSlot0[0]),
      poolLiquidity: BigInt(poolLiquidity),
      poolKey,
    };
  }

  private assertBidAskPoolSupported(state: BidAskPoolState): void {
    if (state.protocol === "v3") {
      const allowed = state.dex === "pancake" ? PANCAKE_V3_FEES : V3_SUPPORTED_FEES;
      if (!allowed.has(state.fee)) throw new Error(`V3 fee tier ${state.fee} is unsupported by the official SDK`);
      return;
    }
  }

  private async resolveV4PoolKey(poolId: Hex, chain: ChainName): Promise<V4PoolKey> {
    const { registry } = this.chains.getForScan(chain);
    const bytes25 = poolId.slice(0, 2 + 25 * 2) as Hex;
    const candidate = await this.client(chain).readContract({
      address: registry.contracts.v4.positionManager,
      abi: v4PoolKeysAbi,
      functionName: "poolKeys",
      args: [bytes25],
    }) as unknown as V4PoolKey;
    if (bidAskPoolId(candidate).toLowerCase() === poolId.toLowerCase()) return candidate;

    const override = this.config.v4PoolKeyOverrides[chain]?.[poolId.toLowerCase()];
    if (!override) throw new Error("V4 pool key is unavailable; configure V4_POOL_KEY_OVERRIDES for this pool");
    log.info({ chain, poolId, hooks: override.hooks }, "resolved V4 pool key from configured override");
    return override;
  }

  private assertBidAskStateMatches(preview: BidAskOpenPreview, state: BidAskPoolState): void {
    if (preview.protocol !== state.protocol || preview.poolAddress.toLowerCase() !== state.poolAddress.toLowerCase()) {
      throw new Error("Bid-Ask pool identity changed; review and confirm again");
    }
    if (preview.token0.toLowerCase() !== state.token0.toLowerCase()
      || preview.token1.toLowerCase() !== state.token1.toLowerCase()
      || preview.feeTier !== state.fee
      || preview.tickSpacing !== state.tickSpacing
      || preview.hooks.toLowerCase() !== state.hooks.toLowerCase()) {
      throw new Error("Bid-Ask pool parameters changed; review and confirm again");
    }
    if (preview.protocol === "v4") {
      if (!preview.poolKey || !state.poolKey || !sameV4PoolKey(preview.poolKey, state.poolKey)) {
        throw new Error("Bid-Ask V4 pool key changed; review and confirm again");
      }
    }
  }

  private assertBidAskOrientation(preview: BidAskOpenPreview, currentTick: number): void {
    const range = validateBidAskRange({
      currentTick,
      rawTickLower: preview.outerTickLower,
      rawTickUpper: preview.outerTickUpper,
      tickSpacing: preview.tickSpacing,
      quoteIsToken0: preview.quoteIsToken0,
    });
    if (range.lowerTick !== preview.outerTickLower || range.upperTick !== preview.outerTickUpper) {
      throw new Error("Bid-Ask outer range changed; review and confirm again");
    }
  }

  private assertBidAskPriceGuard(preview: BidAskOpenPreview, sqrtPriceX96: bigint): void {
    const maxDeviationBps = (this.config as BidAskRuntimeConfig).bidAskLadderMaxPriceDeviationBps;
    if (maxDeviationBps === undefined) return;
    if (!Number.isFinite(maxDeviationBps) || maxDeviationBps < 0) throw new Error("Invalid Bid-Ask price deviation configuration");
    if (preview.sqrtPriceX96 <= 0n || sqrtPriceX96 <= 0n) throw new Error("Bid-Ask pool price is invalid");
    const previousPrice = preview.sqrtPriceX96 * preview.sqrtPriceX96;
    const currentPrice = sqrtPriceX96 * sqrtPriceX96;
    const difference = currentPrice >= previousPrice ? currentPrice - previousPrice : previousPrice - currentPrice;
    const deviationBps = (difference * 10_000n) / previousPrice;
    if (deviationBps > BigInt(Math.floor(maxDeviationBps))) {
      throw new Error("Bid-Ask pool price moved beyond the configured guard");
    }
  }

  private makeBidAskPlan(
    state: BidAskPoolState,
    chain: ChainName,
    quoteIsToken0: boolean,
    token0Decimals: number,
    token1Decimals: number,
    outer: { lowerTick: number; upperTick: number },
    depositAmount: bigint,
    requestedBinCount: number,
  ): BidAskPlan {
    return planBidAsk({
      currentTick: state.currentTick,
      rawTickLower: outer.lowerTick,
      rawTickUpper: outer.upperTick,
      tickSpacing: state.tickSpacing,
      quoteIsToken0,
      requestedBinCount,
      totalAmount: depositAmount,
      liquidityForBin: (bin, allocatedAmount0, allocatedAmount1) => {
        const position = this.bidAskSdkPosition(
          state,
          chain,
          token0Decimals,
          token1Decimals,
          bin,
          allocatedAmount0,
          allocatedAmount1,
        );
        const amount0 = BigInt(position.mintAmounts.amount0.toString());
        const amount1 = BigInt(position.mintAmounts.amount1.toString());
        const selectedAmount = quoteIsToken0 ? allocatedAmount0 : allocatedAmount1;
        const selectedMintAmount = quoteIsToken0 ? amount0 : amount1;
        const nonQuoteMintAmount = quoteIsToken0 ? amount1 : amount0;
        if (nonQuoteMintAmount !== 0n || selectedMintAmount > selectedAmount) {
          throw new Error(`Bid-Ask bin ${bin.index} is not a valid one-sided mint`);
        }
        return {
          expectedLiquidity: BigInt(position.liquidity.toString()),
          expectedAmount0: amount0,
          expectedAmount1: amount1,
        };
      },
    });
  }

  private bidAskSdkPosition(
    state: BidAskPoolState,
    chain: ChainName,
    token0Decimals: number,
    token1Decimals: number,
    bin: BidAskBinGeometry,
    amount0: bigint,
    amount1: bigint,
  ): V3Position | V4Position {
    const chainId = this.chains.getForScan(chain).registry.chain.id;
    if (state.protocol === "v3") {
      if (state.dex === "pancake") {
        const pancakePool = new PancakeV3Pool(
          new PancakeToken(chainId, state.token0, token0Decimals, "T0"),
          new PancakeToken(chainId, state.token1, token1Decimals, "T1"),
          state.fee as typeof PancakeFeeAmount[keyof typeof PancakeFeeAmount],
          state.sqrtPriceX96,
          state.poolLiquidity,
          state.currentTick,
        );
        return PancakeV3Position.fromAmounts({
          pool: pancakePool,
          tickLower: bin.tickLower,
          tickUpper: bin.tickUpper,
          amount0,
          amount1,
          useFullPrecision: true,
        }) as unknown as V3Position;
      }
      const pool = new V3SdkPool(
        new Token(chainId, state.token0, token0Decimals),
        new Token(chainId, state.token1, token1Decimals),
        state.fee as V3FeeAmount,
        state.sqrtPriceX96.toString(),
        state.poolLiquidity.toString(),
        state.currentTick,
      );
      return V3SdkPosition.fromAmounts({
        pool,
        tickLower: bin.tickLower,
        tickUpper: bin.tickUpper,
        amount0: amount0.toString(),
        amount1: amount1.toString(),
        useFullPrecision: true,
      });
    }

    const currency0 = state.token0.toLowerCase() === zeroAddress.toLowerCase()
      ? Ether.onChain(chainId)
      : new Token(chainId, state.token0, token0Decimals);
    const currency1 = state.token1.toLowerCase() === zeroAddress.toLowerCase()
      ? Ether.onChain(chainId)
      : new Token(chainId, state.token1, token1Decimals);
    const pool = new V4SdkPool(
      currency0,
      currency1,
      state.fee,
      state.tickSpacing,
      state.hooks,
      state.sqrtPriceX96.toString(),
      state.poolLiquidity.toString(),
      state.currentTick,
    );
    return V4SdkPosition.fromAmounts({
      pool,
      tickLower: bin.tickLower,
      tickUpper: bin.tickUpper,
      amount0: amount0.toString(),
      amount1: amount1.toString(),
      useFullPrecision: true,
    });
  }

  private buildBidAskBatch(
    state: BidAskPoolState,
    chain: ChainName,
    plan: BidAskPlan,
    quoteIsToken0: boolean,
    quoteToken: QuoteToken,
    deadline: bigint,
  ): TransactionPlan {
    const positionManager = this.positionManager(chain, state.protocol, state.dex ?? "uniswap");
    const recipient = this.config.executorAddress;
    const slippageBps = this.bidAskOpenSlippage();
    const nativeAmount = this.bidAskNativeAmount(state, plan, quoteToken, quoteIsToken0);

    if (state.protocol === "v3") {
      return buildV3BidAskOpenPlan({
        chainId: this.chains.getForScan(chain).registry.chain.id,
        positionManager,
        token0: state.token0,
        token1: state.token1,
        fee: state.fee,
        recipient,
        deadline,
        value: nativeAmount,
        refundETH: isBidAskNativeFunding(state.protocol, quoteToken.address, quoteToken.symbol),
        mints: plan.bins.map((bin) => {
          const expectedAmount0 = bin.expectedAmount0 ?? bin.allocatedAmount0;
          const expectedAmount1 = bin.expectedAmount1 ?? bin.allocatedAmount1;
          this.assertBidAskAmounts(bin, quoteIsToken0, expectedAmount0, expectedAmount1);
          return {
            tickLower: bin.tickLower,
            tickUpper: bin.tickUpper,
            amount0Desired: bin.allocatedAmount0,
            amount1Desired: bin.allocatedAmount1,
            amount0Min: applySlippage(expectedAmount0, slippageBps),
            amount1Min: applySlippage(expectedAmount1, slippageBps),
          };
        }),
      });
    }

    if (!state.poolKey) throw new Error("Bid-Ask V4 pool key is unavailable");
    const mints = plan.bins.map((bin) => {
      const expectedAmount0 = bin.expectedAmount0 ?? bin.allocatedAmount0;
      const expectedAmount1 = bin.expectedAmount1 ?? bin.allocatedAmount1;
      this.assertBidAskAmounts(bin, quoteIsToken0, expectedAmount0, expectedAmount1);
      if (bin.expectedLiquidity === undefined || bin.expectedLiquidity === 0n) {
        throw new Error(`Bid-Ask bin ${bin.index} has no mintable liquidity`);
      }
      return {
        tickLower: bin.tickLower,
        tickUpper: bin.tickUpper,
        liquidity: bin.expectedLiquidity,
        amount0Max: toUint128(bin.allocatedAmount0, `Bid-Ask bin ${bin.index} amount0`),
        amount1Max: toUint128(bin.allocatedAmount1, `Bid-Ask bin ${bin.index} amount1`),
        hookData: "0x" as Hex,
      };
    });
    const nativeSweep = nativeAmount > 0n
      ? { currency: zeroAddress, recipient }
      : undefined;
    const quoteCurrency = (quoteIsToken0 ? state.token0 : state.token1).toLowerCase() as Address;
    const tokenSweep = quoteCurrency !== zeroAddress
      ? { currency: quoteCurrency, recipient }
      : undefined;
    return buildV4BidAskOpenPlan({
      chainId: this.chains.getForScan(chain).registry.chain.id,
      positionManager,
      poolKey: state.poolKey as BidAskV4PoolKey,
      recipient,
      deadline,
      value: nativeAmount,
      ...(nativeSweep ? { nativeSweep } : {}),
      ...(tokenSweep ? { tokenSweep } : {}),
      mints,
    });
  }

  private assertBidAskAmounts(bin: BidAskAllocatedBin, quoteIsToken0: boolean, amount0: bigint, amount1: bigint): void {
    const selectedAllocation = quoteIsToken0 ? bin.allocatedAmount0 : bin.allocatedAmount1;
    const selectedAmount = quoteIsToken0 ? amount0 : amount1;
    const nonQuoteAmount = quoteIsToken0 ? amount1 : amount0;
    if (selectedAllocation <= 0n || selectedAmount <= 0n || selectedAmount > selectedAllocation || nonQuoteAmount !== 0n) {
      throw new Error(`Bid-Ask bin ${bin.index} is not a valid one-sided mint`);
    }
  }

  private bidAskNativeAmount(state: BidAskPoolState, plan: BidAskPlan, quoteToken: QuoteToken, quoteIsToken0: boolean): bigint {
    if (isBidAskNativeFunding(state.protocol, quoteToken.address, quoteToken.symbol)) {
      return quoteIsToken0 ? plan.totalAmount0 : plan.totalAmount1;
    }
    if (state.protocol === "v4") {
      if (state.token0.toLowerCase() === zeroAddress.toLowerCase()) return plan.totalAmount0;
      if (state.token1.toLowerCase() === zeroAddress.toLowerCase()) return plan.totalAmount1;
    }
    return 0n;
  }

  private async detectV3Dex(chain: ChainName, pool: Address, token0: Address, token1: Address, fee: number): Promise<DexName | null> {
    const client = this.client(chain);
    const { registry } = this.chains.getForScan(chain);
    for (const deployment of v3Deployments(registry)) {
      try {
        const factoryPool = await client.readContract({
          address: deployment.contracts.factory,
          abi: v3FactoryAbi,
          functionName: "getPool",
          args: [token0, token1, fee],
        }) as Address;
        if (factoryPool.toLowerCase() === pool.toLowerCase()) return deployment.dex;
      } catch {
        continue;
      }
    }
    return null;
  }

  private positionManager(chain: ChainName, protocol: "v3" | "v4", dex: DexName = "uniswap"): Address {
    const { registry } = this.chains.getForScan(chain);
    return protocol === "v3" ? v3ContractsFor(registry, dex).positionManager : registry.contracts.v4.positionManager;
  }

  private bidAskDeadline(): bigint {
    const configured = (this.config as BidAskRuntimeConfig).bidAskLadderTransactionDeadlineSeconds;
    const seconds = configured !== undefined && Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : 300;
    return BigInt(Math.floor(Date.now() / 1_000) + seconds);
  }

  private bidAskOpenSlippage(): number {
    const configured = (this.config as BidAskRuntimeConfig).bidAskLadderOpenSlippageBps;
    if (configured === undefined) return 0;
    if (!Number.isInteger(configured) || configured < 0 || configured > 10_000) {
      throw new Error("Invalid Bid-Ask opening slippage configuration");
    }
    return configured;
  }

  private async simulateAndEstimateBidAsk(chain: ChainName, protocol: "v3" | "v4", plan: TransactionPlan, binCount: number): Promise<BidAskGasResult> {
    const client = this.executionClient(chain);
    try {
      await client.call({ account: this.config.executorAddress, to: plan.to, data: plan.data, value: plan.value ?? 0n });
      const estimatedGas = BigInt(await client.estimateGas({ account: this.config.executorAddress, to: plan.to, data: plan.data, value: plan.value ?? 0n }));
      if (estimatedGas <= 0n) throw new Error("atomic batch returned a zero gas estimate");

      let blockGasLimit: bigint | null = null;
      if (typeof client.getBlock === "function") {
        try {
          const block = await client.getBlock();
          blockGasLimit = typeof block.gasLimit === "bigint" ? block.gasLimit : null;
        } catch {
          blockGasLimit = null;
        }
      }

      const config = this.config as BidAskRuntimeConfig;
      const explicitMaxGas = config.bidAskLadderMaxGas;
      if (explicitMaxGas !== undefined && estimatedGas > BigInt(explicitMaxGas)) {
        throw atomicBatchInfeasible(`estimated gas ${estimatedGas} exceeds the configured limit`);
      }
      if (blockGasLimit !== null) {
        const maxBlockGasBps = config.bidAskLadderAtomicMaxBlockGasBps ?? 8_000;
        if (!Number.isInteger(maxBlockGasBps) || maxBlockGasBps <= 0 || maxBlockGasBps > 10_000) {
          throw new Error("Invalid Bid-Ask atomic gas configuration");
        }
        if (estimatedGas * 10_000n > blockGasLimit * BigInt(maxBlockGasBps)) {
          throw atomicBatchInfeasible(`estimated gas ${estimatedGas} exceeds the block gas budget for ${binCount} bins`);
        }
      }
      if (protocol === "v4") {
        const maxFeePerGas = await this.nativeMaxFeePerGas(chain);
        this.assertV4OpenGasBudget(chain, estimatedGas, maxFeePerGas);
      }
      return { estimatedGas, blockGasLimit };
    } catch (error) {
      if (error instanceof Error && error.message.includes("atomic_batch_infeasible")) throw error;
      throw atomicBatchInfeasible(error instanceof Error ? error.message : String(error));
    }
  }

  private async nativeMaxFeePerGas(chain: ChainName): Promise<bigint> {
    const client = this.executionClient(chain);
    try {
      const fees = await client.estimateFeesPerGas();
      const fee = fees.maxFeePerGas ?? ("gasPrice" in fees ? fees.gasPrice : undefined);
      if (typeof fee === "bigint" && fee > 0n) return fee;
    } catch {
    }
    const gasPrice = await client.getGasPrice();
    if (gasPrice <= 0n) throw atomicBatchInfeasible("native gas price is unavailable");
    return gasPrice;
  }

  private assertV4OpenGasBudget(chain: ChainName, gas: bigint, maxFeePerGas: bigint): void {
    if (chainRegistry[chain].nativeSymbol !== "ETH") return;
    const config = this.config as BidAskRuntimeConfig;
    const maxUsd = config.bidAskLadderV4MaxOpenGasUsd ?? 2;
    const ethUsd = config.bidAskLadderV4EthUsd ?? 2_500;
    assertBidAskV4OpenGasCost(gas, maxFeePerGas, bidAskV4OpenGasBudgetWei(maxUsd, ethUsd), maxUsd, ethUsd);
  }

  private async persistBidAskPlan(preview: BidAskOpenPreview): Promise<string | undefined> {
    if (!this.database) return undefined;
    const chainId = this.chains.getForScan(preview.chain).registry.chain.id;
    const positionManager = preview.positionManager;
    const expectedAmounts = preview.plan.bins.reduce(
      (totals, bin) => ({
        amount0: totals.amount0 + (bin.expectedAmount0 ?? bin.allocatedAmount0),
        amount1: totals.amount1 + (bin.expectedAmount1 ?? bin.allocatedAmount1),
      }),
      { amount0: 0n, amount1: 0n },
    );
    const group = await this.database.createPositionGroup({
      chainId,
      protocol: preview.protocol,
      positionManager,
      poolKey: preview.poolAddress.toLowerCase(),
      owner: this.config.executorAddress,
      token0: preview.token0,
      token1: preview.token1,
      quoteToken: preview.quoteToken,
      shape: "bid_ask",
      shapeVersion: preview.plan.shapeVersion,
      requestedBinCount: preview.plan.requestedBinCount,
      generatedBinCount: preview.plan.generatedBinCount,
      mintableBinCount: preview.plan.mintableBinCount,
      outerTickLower: preview.plan.outerTickLower,
      outerTickUpper: preview.plan.outerTickUpper,
      anchorBinIndex: preview.plan.anchorIndex,
      totalDeposit: preview.depositAmount,
      deployedCostQuote: preview.quoteIsToken0 ? expectedAmounts.amount0 : expectedAmounts.amount1,
      directCloseAmount0: expectedAmounts.amount0,
      directCloseAmount1: expectedAmounts.amount1,
      totalReceivedQuote: 0n,
      status: "planned",
      planHash: preview.planHash,
      planJson: jsonSafe({
        plan: preview.plan,
        transaction: preview.batchPlan,
        poolAddress: preview.poolAddress,
        poolKey: preview.poolKey,
        feeTier: preview.feeTier,
        atomicOpenGasEstimate: preview.estimatedGas,
        blockGasLimit: preview.blockGasLimit,
        atomicBatchFeasible: preview.atomicBatchFeasible,
        noOpeningSwap: true,
      }),
      referenceBlock: await this.referenceBlock(preview.chain),
      referenceTick: preview.currentTick,
      referencePrice: preview.sqrtPriceX96,
      openTransactionHash: null,
      closeTransactionHash: null,
      pendingRawTransaction: null,
      executionLeaseToken: null,
      executionLeaseUntil: null,
      finalPnlQuote: null,
      finalPnlBps: null,
      finalPnlUsd: null,
      settledAt: null,
      metadata: {
        managedBy: "position_group",
        strategy: "bid_ask",
        dex: preview.dex ?? "uniswap",
        shapeVersion: preview.plan.shapeVersion,
        atomicBatch: true,
        noOpeningSwap: true,
        poolAddress: preview.poolAddress,
        feeTier: preview.feeTier,
        quoteTokenSymbol: preview.quoteTokenSymbol,
      },
    } satisfies Omit<PositionGroupRecord, "id" | "createdAt" | "updatedAt">);

    for (const bin of preview.plan.bins) {
      const expectedAmount0 = bin.expectedAmount0 ?? bin.allocatedAmount0;
      const expectedAmount1 = bin.expectedAmount1 ?? bin.allocatedAmount1;
      await this.database.createPositionGroupBin({
        groupId: group.id,
        chainId,
        positionManager,
        binIndex: bin.index,
        tickLower: bin.tickLower,
        tickUpper: bin.tickUpper,
        side: bin.side,
        weightMicros: bin.weightMicros,
        allocatedAmount0: bin.allocatedAmount0,
        allocatedAmount1: bin.allocatedAmount1,
        expectedLiquidity: bin.expectedLiquidity ?? 0n,
        expectedAmount0,
        expectedAmount1,
        tokenId: null,
        positionId: null,
        openingAmount0: expectedAmount0,
        openingAmount1: expectedAmount1,
        closeAmount0: 0n,
        closeAmount1: 0n,
        settlementQuote: 0n,
        status: "planned",
        dropReason: null,
        openTransactionHash: null,
        closeTransactionHash: null,
        metadata: { shape: "bid_ask", shapeVersion: preview.plan.shapeVersion },
      } satisfies Omit<PositionGroupBinRecord, "id" | "createdAt" | "updatedAt">);
    }
    return group.id;
  }

  private async broadcastBidAsk(
    chain: ChainName,
    protocol: "v3" | "v4",
    groupId: string,
    to: Address,
    data: Hex,
    value = 0n,
    estimatedGas: bigint,
  ): Promise<{ hash: Hex | null; receipt?: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>; pendingReconciliation?: boolean }> {
    if (!this.database) throw new Error("Bid-Ask group database is not configured");
    const chainId = this.chains.getForScan(chain).registry.chain.id;
    const run = async (): Promise<{ hash: Hex | null; receipt?: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>; pendingReconciliation?: boolean }> => {
      if (await this.database!.hasPendingRawTransaction(chainId)) throw new Error(`Chain ${chainId} has an unresolved signed transaction`);
      const client = this.executionClient(chain);
      const executor = this.config.executorAddress;
      await client.call({ account: executor, to, data, value });
      await this.database!.recordPositionGroupExecution(groupId, "open_batch", "planned", undefined, undefined, undefined, undefined, {
        description: "atomic_bid_ask_open",
      });

      if (this.config.dryRun) {
        await this.database!.setPositionGroupStatus(groupId, "planned", { dryRunPlan: "atomic_bid_ask_open", pendingRawTransaction: null });
        log.info({ groupId, to, data: data.slice(0, 100) }, "dry-run Bid-Ask open batch simulated");
        return { hash: null };
      }

      const wallet = this.walletClient(chain);
      const pendingNonce = await client.getTransactionCount({ address: this.account!.address, blockTag: "pending" });
      const nonce = await this.database!.nextPositionGroupExecutionNonce(chainId, pendingNonce);
      const preparedRequest = await wallet.prepareTransactionRequest({ account: this.account!, to, data, value, nonce });
      const signedGas = typeof preparedRequest.gas === "bigint" ? preparedRequest.gas : estimatedGas;
      const signedFee = typeof preparedRequest.maxFeePerGas === "bigint"
        ? preparedRequest.maxFeePerGas
        : typeof preparedRequest.gasPrice === "bigint"
          ? preparedRequest.gasPrice
          : 0n;
      if (protocol === "v4") this.assertV4OpenGasBudget(chain, signedGas, signedFee);
      const serializedTransaction = await wallet.signTransaction(preparedRequest);
      const hash = keccak256(serializedTransaction);
      const transactionNonce = preparedRequest.nonce === undefined ? undefined : BigInt(preparedRequest.nonce);
      let confirmedReceipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>> | undefined;

      await this.database!.recordPositionGroupExecution(groupId, "open_batch", "submitted", hash, serializedTransaction, transactionNonce, undefined, {
        description: "atomic_bid_ask_open",
      });
      const linked = await this.database!.setPositionGroupOpenTransaction(groupId, hash, "opening");
      if (!linked) throw new Error("Bid-Ask open transaction could not be linked to its parent group");

      try {
        const broadcastHash = await wallet.sendRawTransaction({ serializedTransaction });
        if (broadcastHash.toLowerCase() !== hash.toLowerCase()) throw new Error("Bid-Ask open broadcast returned an unexpected transaction hash");
        confirmedReceipt = await client.waitForTransactionReceipt({ hash, confirmations: this.config.confirmations });
        if (confirmedReceipt.status !== "success") {
          await this.database!.recordPositionGroupExecution(groupId, "open_batch", "failed", hash, undefined, undefined, "transaction reverted");
          await this.database!.setPositionGroupStatus(groupId, "cancelled", {
            reason: "bid_ask_open_transaction_reverted",
            openTransactionHash: hash,
            lastExecutionError: `open_batch transaction reverted: ${hash}`,
            pendingRawTransaction: null,
          });
          throw new Error(`Bid-Ask open transaction reverted: ${hash}`);
        }
        await this.database!.recordPositionGroupExecution(groupId, "open_batch", "confirmed", hash);
        return { hash, receipt: confirmedReceipt };
      } catch (error) {
        if (error instanceof Error && error.message.includes("reverted")) throw error;
        // The signed transaction is persisted before broadcast. A provider error can occur
        // after accepting it, so reconciliation must own recovery instead of cancelling open.
        log.warn({ err: error, chain, groupId, transactionHash: hash }, "Bid-Ask open confirmation deferred to reconciliation");
        return { hash, ...(confirmedReceipt ? { receipt: confirmedReceipt } : {}), pendingReconciliation: true };
      }
    };

    return this.database.withExecutionLock(chainId, this.config.executorAddress, run);
  }

  private async referenceBlock(chain: ChainName): Promise<bigint | null> {
    const client = this.client(chain);
    if (typeof client.getBlockNumber !== "function") return null;
    try {
      return await client.getBlockNumber();
    } catch {
      return null;
    }
  }

  private async executeV3(preview: OpenPositionPreview, deadline: bigint): Promise<{ hash: Hex | null }> {
    const client = this.executionClient(preview.chain);
    const { registry } = this.chains.getForScan(preview.chain);
    const dex = preview.dex ?? "uniswap";
    const positionManager = v3ContractsFor(registry, dex).positionManager;
    const executor = this.config.executorAddress;

    const useNative = preview.quoteTokenSymbol === "ETH" || preview.quoteTokenSymbol === "BNB";
    if (useNative) await this.ensureNativeBalance(client, executor, preview.depositAmount);
    else await this.ensureApproval(client, preview.quoteToken, positionManager, preview.depositAmount, executor, preview.chain);
    const position = this.v3PositionFromPreview(preview);
    this.assertSingleSideSpend(position, preview.quoteIsToken0, preview.depositAmount);
    if (dex === "pancake") {
      const parameters = PancakeNpm.addCallParameters(position as never, {
        recipient: executor,
        deadline: Number(deadline),
        slippageTolerance: new PancakePercent(0, 10_000),
      });
      return this.broadcast(preview.chain, positionManager, parameters.calldata as Hex, BigInt(parameters.value));
    }
    const parameters = NonfungiblePositionManager.addCallParameters(position, {
      recipient: executor,
      deadline: deadline.toString(),
      slippageTolerance: new Percent(0, 10_000),
      ...(useNative && preview.quoteTokenSymbol === "ETH" ? { useNative: Ether.onChain(this.chains.getForScan(preview.chain).registry.chain.id) } : {}),
    });
    return this.broadcast(preview.chain, positionManager, parameters.calldata as Hex, BigInt(parameters.value));
  }

  private async executeV4(preview: OpenPositionPreview, deadline: bigint): Promise<{ hash: Hex | null }> {
    const client = this.executionClient(preview.chain);
    const { registry } = this.chains.getForScan(preview.chain);
    const positionManager = registry.contracts.v4.positionManager;
    const executor = this.config.executorAddress;

    const position = this.v4PositionFromPreview(preview);
    this.assertSingleSideSpend(position, preview.quoteIsToken0, preview.depositAmount);
    const quoteSpend = BigInt((preview.quoteIsToken0 ? position.mintAmounts.amount0 : position.mintAmounts.amount1).toString());
    assertMintUtilization(quoteSpend, preview.depositAmount);
    await this.ensureWrappedNativeFunding(client, preview.chain, preview.quoteToken, quoteSpend, executor);
    await this.ensureApproval(client, preview.quoteToken, registry.contracts.v4.permit2, quoteSpend, executor, preview.chain);
    await this.ensurePermit2Approval(client, preview.quoteToken, positionManager, quoteSpend, executor, preview.chain);
    const parameters = V4PositionManager.addCallParameters(position, {
      recipient: executor,
      deadline: deadline.toString(),
      slippageTolerance: new Percent(0, 10_000),
      hookData: "0x",
      ...(preview.token0.toLowerCase() === zeroAddress ? { useNative: Ether.onChain(this.chains.getForScan(preview.chain).registry.chain.id) } : {}),
    });
    return this.broadcast(preview.chain, positionManager, parameters.calldata as Hex, BigInt(parameters.value));
  }

  private async executeV3Dual(preview: OpenPositionPreview, deadline: bigint, quoteAmount: bigint, baseAmount: bigint): Promise<{ hash: Hex | null }> {
    const client = this.executionClient(preview.chain);
    const { registry } = this.chains.getForScan(preview.chain);
    const dex = preview.dex ?? "uniswap";
    const positionManager = v3ContractsFor(registry, dex).positionManager;
    const executor = this.config.executorAddress;
    const chainId = this.chains.getForScan(preview.chain).registry.chain.id;

    const useNative = preview.quoteToken === zeroAddress;
    if (quoteAmount > 0n) {
      if (useNative) await this.ensureNativeBalance(client, executor, quoteAmount);
      else await this.ensureApproval(client, preview.quoteToken, positionManager, quoteAmount, executor, preview.chain);
    }
    if (baseAmount > 0n && preview.baseToken) await this.ensureApproval(client, preview.baseToken, positionManager, baseAmount, executor, preview.chain);

    if (dex === "pancake") {
      const pancakePool = new PancakeV3Pool(
        new PancakeToken(chainId, preview.token0, preview.token0Decimals, preview.token0Symbol),
        new PancakeToken(chainId, preview.token1, preview.token1Decimals, preview.token1Symbol),
        preview.feeTier as typeof PancakeFeeAmount[keyof typeof PancakeFeeAmount],
        preview.sqrtPriceX96,
        preview.poolLiquidity,
        preview.currentTick,
      );
      const pancakePosition = PancakeV3Position.fromAmounts({
        pool: pancakePool,
        tickLower: preview.tickLower,
        tickUpper: preview.tickUpper,
        amount0: preview.quoteIsToken0 ? quoteAmount : baseAmount,
        amount1: preview.quoteIsToken0 ? baseAmount : quoteAmount,
        useFullPrecision: true,
      });
      const pancakeParams = PancakeNpm.addCallParameters(pancakePosition, {
        recipient: executor,
        deadline: Number(deadline),
        slippageTolerance: new PancakePercent(100, 10_000),
      });
      return this.broadcast(preview.chain, positionManager, pancakeParams.calldata as Hex, BigInt(pancakeParams.value));
    }
    const pool = new V3SdkPool(
      new Token(chainId, preview.token0, preview.token0Decimals),
      new Token(chainId, preview.token1, preview.token1Decimals),
      preview.feeTier as V3FeeAmount,
      preview.sqrtPriceX96.toString(),
      preview.poolLiquidity.toString(),
      preview.currentTick,
    );
    const position = V3SdkPosition.fromAmounts({
      pool,
      tickLower: preview.tickLower,
      tickUpper: preview.tickUpper,
      amount0: preview.quoteIsToken0 ? quoteAmount.toString() : baseAmount.toString(),
      amount1: preview.quoteIsToken0 ? baseAmount.toString() : quoteAmount.toString(),
      useFullPrecision: true,
    });
    const parameters = NonfungiblePositionManager.addCallParameters(position, {
      recipient: executor,
      deadline: deadline.toString(),
      slippageTolerance: new Percent(100, 10_000),
      ...(useNative ? { useNative: Ether.onChain(chainId) } : {}),
    });
    return this.broadcast(preview.chain, positionManager, parameters.calldata as Hex, BigInt(parameters.value));
  }

  private async executeV4Dual(preview: OpenPositionPreview, deadline: bigint, quoteAmount: bigint, baseAmount: bigint): Promise<{ hash: Hex | null }> {
    const client = this.executionClient(preview.chain);
    const { registry } = this.chains.getForScan(preview.chain);
    const positionManager = registry.contracts.v4.positionManager;
    const executor = this.config.executorAddress;
    const chainId = this.chains.getForScan(preview.chain).registry.chain.id;

    const useNative = preview.quoteToken === zeroAddress;
    if (quoteAmount > 0n) {
      if (useNative) await this.ensureNativeBalance(client, executor, quoteAmount);
      else {
        await this.ensureApproval(client, preview.quoteToken, registry.contracts.v4.permit2, quoteAmount, executor, preview.chain);
        await this.ensurePermit2Approval(client, preview.quoteToken, positionManager, quoteAmount, executor, preview.chain);
      }
    }
    if (baseAmount > 0n && preview.baseToken) {
      await this.ensureApproval(client, preview.baseToken, registry.contracts.v4.permit2, baseAmount, executor, preview.chain);
      await this.ensurePermit2Approval(client, preview.baseToken, positionManager, baseAmount, executor, preview.chain);
    }

    const currency0 = preview.token0.toLowerCase() === zeroAddress ? Ether.onChain(chainId) : new Token(chainId, preview.token0, preview.token0Decimals);
    const currency1 = new Token(chainId, preview.token1, preview.token1Decimals);
    const pool = new V4SdkPool(currency0, currency1, preview.feeTier, preview.tickSpacing, preview.hooks, preview.sqrtPriceX96.toString(), preview.poolLiquidity.toString(), preview.currentTick);
    const position = V4SdkPosition.fromAmounts({
      pool,
      tickLower: preview.tickLower,
      tickUpper: preview.tickUpper,
      amount0: preview.quoteIsToken0 ? quoteAmount.toString() : baseAmount.toString(),
      amount1: preview.quoteIsToken0 ? baseAmount.toString() : quoteAmount.toString(),
      useFullPrecision: true,
    });
    const parameters = V4PositionManager.addCallParameters(position, {
      recipient: executor,
      deadline: deadline.toString(),
      slippageTolerance: new Percent(100, 10_000),
      hookData: "0x",
      ...(useNative ? { useNative: Ether.onChain(chainId) } : {}),
    });
    return this.broadcast(preview.chain, positionManager, parameters.calldata as Hex, BigInt(parameters.value));
  }

  private v3Position(
    chain: ChainName,
    token0: Address,
    token1: Address,
    token0Decimals: number,
    token1Decimals: number,
    fee: number,
    sqrtPriceX96: bigint,
    poolLiquidity: bigint,
    currentTick: number,
    tickLower: number,
    tickUpper: number,
    depositAmount: bigint,
    quoteIsToken0: boolean,
    mode: OpenMode,
    dex: DexName = "uniswap",
  ): V3Position {
    const chainId = this.chains.getForScan(chain).registry.chain.id;
    if (dex === "pancake") {
      const pool = new PancakeV3Pool(
        new PancakeToken(chainId, token0, token0Decimals, "T0"),
        new PancakeToken(chainId, token1, token1Decimals, "T1"),
        fee as typeof PancakeFeeAmount[keyof typeof PancakeFeeAmount],
        sqrtPriceX96,
        poolLiquidity,
        currentTick,
      );
      const pancake = mode === "dual"
        ? (quoteIsToken0
          ? PancakeV3Position.fromAmount0({ pool, tickLower, tickUpper, amount0: depositAmount, useFullPrecision: true })
          : PancakeV3Position.fromAmount1({ pool, tickLower, tickUpper, amount1: depositAmount }))
        : PancakeV3Position.fromAmounts({
          pool,
          tickLower,
          tickUpper,
          amount0: quoteIsToken0 ? depositAmount : 0n,
          amount1: quoteIsToken0 ? 0n : depositAmount,
          useFullPrecision: true,
        });
      return pancake as unknown as V3Position;
    }
    const pool = new V3SdkPool(
      new Token(chainId, token0, token0Decimals),
      new Token(chainId, token1, token1Decimals),
      fee as V3FeeAmount,
      sqrtPriceX96.toString(),
      poolLiquidity.toString(),
      currentTick,
    );
    if (mode === "dual") {
      return quoteIsToken0
        ? V3SdkPosition.fromAmount0({ pool, tickLower, tickUpper, amount0: depositAmount.toString(), useFullPrecision: true })
        : V3SdkPosition.fromAmount1({ pool, tickLower, tickUpper, amount1: depositAmount.toString() });
    }
    return V3SdkPosition.fromAmounts({
      pool,
      tickLower,
      tickUpper,
      amount0: quoteIsToken0 ? depositAmount.toString() : "0",
      amount1: quoteIsToken0 ? "0" : depositAmount.toString(),
      useFullPrecision: true,
    });
  }

  private v3PositionFromPreview(preview: OpenPositionPreview): V3Position {
    return this.v3Position(
      preview.chain, preview.token0, preview.token1, preview.token0Decimals, preview.token1Decimals,
      preview.feeTier, preview.sqrtPriceX96, preview.poolLiquidity, preview.currentTick,
      preview.tickLower, preview.tickUpper, preview.depositAmount, preview.quoteIsToken0, preview.mode, preview.dex ?? "uniswap",
    );
  }

  private v4Position(
    chain: ChainName,
    token0: Address,
    token1: Address,
    token0Decimals: number,
    token1Decimals: number,
    fee: number,
    tickSpacing: number,
    hooks: Address,
    sqrtPriceX96: bigint,
    poolLiquidity: bigint,
    currentTick: number,
    tickLower: number,
    tickUpper: number,
    depositAmount: bigint,
    quoteIsToken0: boolean,
    mode: OpenMode,
  ): V4Position {
    const chainId = this.chains.getForScan(chain).registry.chain.id;
    const currency0 = token0.toLowerCase() === zeroAddress ? Ether.onChain(chainId) : new Token(chainId, token0, token0Decimals);
    const currency1 = new Token(chainId, token1, token1Decimals);
    const pool = new V4SdkPool(currency0, currency1, fee, tickSpacing, hooks, sqrtPriceX96.toString(), poolLiquidity.toString(), currentTick);
    if (mode === "dual") {
      return quoteIsToken0
        ? V4SdkPosition.fromAmount0({ pool, tickLower, tickUpper, amount0: depositAmount.toString(), useFullPrecision: true })
        : V4SdkPosition.fromAmount1({ pool, tickLower, tickUpper, amount1: depositAmount.toString() });
    }
    return V4SdkPosition.fromAmounts({
      pool,
      tickLower,
      tickUpper,
      amount0: quoteIsToken0 ? depositAmount.toString() : "0",
      amount1: quoteIsToken0 ? "0" : depositAmount.toString(),
      useFullPrecision: true,
    });
  }

  private v4PositionFromPreview(preview: OpenPositionPreview): V4Position {
    return this.v4Position(
      preview.chain, preview.token0, preview.token1, preview.token0Decimals, preview.token1Decimals,
      preview.feeTier, preview.tickSpacing, preview.hooks, preview.sqrtPriceX96, preview.poolLiquidity,
      preview.currentTick, preview.tickLower, preview.tickUpper, preview.depositAmount, preview.quoteIsToken0, preview.mode,
    );
  }

  private isStillSingleSided(preview: OpenPositionPreview, currentTick: number): boolean {
    return preview.quoteIsToken0 ? currentTick < preview.tickLower : currentTick >= preview.tickUpper;
  }

  private isStillStraddling(preview: OpenPositionPreview, currentTick: number): boolean {
    return currentTick > preview.tickLower && currentTick < preview.tickUpper;
  }

  private recomputeDualPreviewForConfirmedRange(original: OpenPositionPreview, refreshed: OpenPositionPreview): OpenPositionPreview {
    this.assertSameOpenPool(original, refreshed);
    const position = refreshed.protocol === "v3"
      ? this.v3Position(
        refreshed.chain, refreshed.token0, refreshed.token1, refreshed.token0Decimals, refreshed.token1Decimals,
        refreshed.feeTier, refreshed.sqrtPriceX96, refreshed.poolLiquidity, refreshed.currentTick,
        original.tickLower, original.tickUpper, refreshed.depositAmount, refreshed.quoteIsToken0, "dual", refreshed.dex,
      )
      : this.v4Position(
        refreshed.chain, refreshed.token0, refreshed.token1, refreshed.token0Decimals, refreshed.token1Decimals,
        refreshed.feeTier, refreshed.tickSpacing, refreshed.hooks, refreshed.sqrtPriceX96, refreshed.poolLiquidity,
        refreshed.currentTick, original.tickLower, original.tickUpper, refreshed.depositAmount, refreshed.quoteIsToken0, "dual",
      );
    this.assertDualSidePosition(position, refreshed.quoteIsToken0);
    const split = this.computeDualSplit(position, refreshed.quoteIsToken0, refreshed.depositAmount, refreshed.sqrtPriceX96);
    assertMintUtilization(split.quoteSideAmount + split.swapAmount, refreshed.depositAmount);
    return {
      ...original,
      ...refreshed,
      tickLower: original.tickLower,
      tickUpper: original.tickUpper,
      lowerPrice: original.lowerPrice,
      upperPrice: original.upperPrice,
      ...split,
    };
  }

  private assertSameOpenPool(expected: OpenPositionPreview, actual: OpenPositionPreview): void {
    if (expected.protocol !== actual.protocol
      || expected.poolAddress.toLowerCase() !== actual.poolAddress.toLowerCase()
      || expected.token0.toLowerCase() !== actual.token0.toLowerCase()
      || expected.token1.toLowerCase() !== actual.token1.toLowerCase()
      || expected.feeTier !== actual.feeTier
      || expected.tickSpacing !== actual.tickSpacing
      || expected.hooks.toLowerCase() !== actual.hooks.toLowerCase()) {
      throw new Error("Pool configuration changed after confirmation; open was cancelled");
    }
  }

  private async assertExecutableOpenPrice(input: {
    chain: ChainName;
    protocol: "v3" | "v4";
    pool: Hex;
    token0: Address;
    token1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
    dex: DexName;
    quoteToken: Address;
    quoteIsToken0: boolean;
    quoteDecimals: number;
    sqrtPriceX96: bigint;
    depositAmount: bigint;
  }): Promise<{ spotMark: bigint; executableOut: bigint }> {
    const quoteCap = 50n * (10n ** BigInt(input.quoteDecimals));
    const probeQuote = input.depositAmount < quoteCap ? input.depositAmount : quoteCap;
    const probeBase = baseAmountFromQuote(input.sqrtPriceX96, probeQuote, input.quoteIsToken0);
    const spotMark = quoteValueFromBase(input.sqrtPriceX96, probeBase, input.quoteIsToken0);
    if (probeBase <= 0n || spotMark <= 0n) throw new Error("Cannot verify executable exit price");
    const baseToken = input.quoteIsToken0 ? input.token1 : input.token0;
    const position: PositionRecord = {
      id: `open:${input.pool}`,
      chainId: this.chains.getForScan(input.chain).registry.chain.id,
      protocol: input.protocol,
      positionKey: input.pool,
      owner: this.config.executorAddress,
      poolAddress: input.protocol === "v3" ? input.pool as Address : null,
      token0: input.token0,
      token1: input.token1,
      quoteToken: input.quoteToken,
      status: "discovered",
      liquidity: null,
      openedAtBlock: null,
      metadata: {
        dex: input.dex,
        currency0: input.token0,
        currency1: input.token1,
        fee: input.fee,
        tickSpacing: input.tickSpacing,
        hooks: input.hooks,
      },
    };
    const quotes = await Promise.all([
      this.tradingApi?.quote(position, baseToken, probeBase, input.quoteToken).catch(() => null) ?? Promise.resolve(null),
      this.kyberswapApi?.quote(position, baseToken, probeBase, input.quoteToken).catch(() => null) ?? Promise.resolve(null),
    ]);
    const executableOut = quotes.reduce<bigint | null>((best, quote) => {
      if (!quote || quote.expectedOut <= 0n) return best;
      return best === null || quote.expectedOut > best ? quote.expectedOut : best;
    }, null);
    if (executableOut === null) throw new Error("Cannot verify executable exit price");
    const minBps = BigInt(this.config.openMinExecutableBps ?? 5_000);
    if (executableOut * 10_000n < spotMark * minBps) {
      throw new Error("Pool price is not executable");
    }
    return { spotMark, executableOut };
  }

  private assertSingleSideSpend(position: V3Position | V4Position, quoteIsToken0: boolean, depositAmount: bigint): void {
    const { amount0, amount1 } = position.mintAmounts;
    const quoteAmount = BigInt((quoteIsToken0 ? amount0 : amount1).toString());
    const nonQuoteAmount = BigInt((quoteIsToken0 ? amount1 : amount0).toString());
    if (nonQuoteAmount !== 0n) throw new Error("Requested range is not single-side quote liquidity");
    if (quoteAmount > depositAmount) throw new Error("SDK quote spend exceeds the requested deposit cap");
  }

  private assertDualSidePosition(position: V3Position | V4Position, quoteIsToken0: boolean): void {
    const { amount0, amount1 } = position.mintAmounts;
    const quoteAmount = BigInt((quoteIsToken0 ? amount0 : amount1).toString());
    const baseAmount = BigInt((quoteIsToken0 ? amount1 : amount0).toString());
    if (quoteAmount === 0n || baseAmount === 0n) throw new Error("Requested range does not require both tokens for dual-side liquidity");
  }

  private computeDualSplit(
    position: V3Position | V4Position,
    quoteIsToken0: boolean,
    depositAmount: bigint,
    sqrtPriceX96: bigint,
  ): { quoteSideAmount: bigint; baseAmount: bigint; swapAmount: bigint; expectedBaseFromSwap: bigint } {
    const { amount0, amount1 } = position.mintAmounts;
    const fullQuoteAmount = BigInt((quoteIsToken0 ? amount0 : amount1).toString());
    const fullBaseAmount = BigInt((quoteIsToken0 ? amount1 : amount0).toString());

    if (fullBaseAmount === 0n) {
      return { quoteSideAmount: depositAmount, baseAmount: 0n, swapAmount: 0n, expectedBaseFromSwap: 0n };
    }

    const square = sqrtPriceX96 * sqrtPriceX96;
    const baseInQuote = quoteIsToken0
      ? (fullBaseAmount * Q192) / square
      : (fullBaseAmount * square) / Q192;

    const totalCost = fullQuoteAmount + baseInQuote;
    if (totalCost === 0n) throw new Error("Dual-side auto-split produced a zero total cost");

    const quoteSideAmount = (fullQuoteAmount * depositAmount) / totalCost;
    const baseAmount = (fullBaseAmount * depositAmount) / totalCost;
    const swapAmount = depositAmount - quoteSideAmount;
    if (quoteSideAmount === 0n || baseAmount === 0n || swapAmount === 0n) {
      throw new Error("Deposit amount is too small to split into both sides of this pool");
    }
    const expectedBaseFromSwap = baseAmount;

    log.info({
      depositAmount: depositAmount.toString(),
      quoteSideAmount: quoteSideAmount.toString(),
      swapAmount: swapAmount.toString(),
      baseAmount: baseAmount.toString(),
      baseInQuote: baseInQuote.toString(),
    }, "dual-side auto-split computed");

    return { quoteSideAmount, baseAmount, swapAmount, expectedBaseFromSwap };
  }

  private async swapQuoteForBase(preview: OpenPositionPreview): Promise<{ hash: Hex | null; actualBaseOut: bigint }> {
    const swapAmount = preview.swapAmount ?? 0n;
    if (swapAmount === 0n || !preview.baseToken) return { hash: null, actualBaseOut: 0n };

    const executor = this.config.executorAddress;
    const client = this.executionClient(preview.chain);
    const { registry } = this.chains.getForScan(preview.chain);

    if (this.tradingApi) {
      let apiPlan: { to: Address; data: Hex; value?: bigint } | null = null;
      try {
        let quote = await this.tradingApi.quote(
          { chainId: this.chains.getForScan(preview.chain).registry.chain.id, owner: executor } as PositionRecord,
          preview.quoteToken,
          swapAmount,
          preview.baseToken,
          this.config.maxSwapSlippageBps,
        );
        if (quote) {
          if (this.config.dryRun) {
            log.info({ swapAmount: swapAmount.toString(), expectedBase: quote.expectedOut.toString() }, "dry-run: dual-side swap via Trading API");
            return { hash: null, actualBaseOut: quote.expectedOut };
          }
          if (preview.quoteToken === zeroAddress) await this.ensureNativeBalance(client, executor, swapAmount);
          else await this.ensureApproval(client, preview.quoteToken, UNISWAP_API_ROUTER, swapAmount, executor, preview.chain);
          // Approval can take a block and Trading API quotes expire quickly, so refresh
          // the quote after an approval transaction before building calldata.
          quote = await this.tradingApi.quote(
            { chainId: this.chains.getForScan(preview.chain).registry.chain.id, owner: executor } as PositionRecord,
            preview.quoteToken,
            swapAmount,
            preview.baseToken,
            this.config.maxSwapSlippageBps,
          );
          if (!quote) throw new Error("Trading API route disappeared after approval");
          apiPlan = await this.tradingApi.createSwap(
            { chainId: this.chains.getForScan(preview.chain).registry.chain.id, owner: executor } as PositionRecord,
            quote,
          );
        }
      } catch (error) {
        log.warn({ error: error instanceof Error ? error.message : String(error) }, "Trading API dual-side swap failed; falling back to local route");
      }
      if (apiPlan) {
        const before = await this.tokenBalance(client, preview.baseToken, executor);
        const result = await this.broadcast(preview.chain, apiPlan.to, apiPlan.data, apiPlan.value ?? 0n);
        const after = await this.tokenBalance(client, preview.baseToken, executor);
        if (after <= before) throw new Error("Dual-side swap produced no base token output");
        return { hash: result.hash, actualBaseOut: after - before };
      }
    }

    if (!this.routes) throw new Error("No swap route available for dual-side open");
    const routePosition: PositionRecord = {
      id: `open:${preview.poolAddress}`,
      chainId: this.chains.getForScan(preview.chain).registry.chain.id,
      protocol: preview.protocol,
      positionKey: preview.poolAddress,
      owner: executor,
      poolAddress: preview.protocol === "v3" ? preview.poolAddress as Address : null,
      token0: preview.token0,
      token1: preview.token1,
      quoteToken: preview.quoteToken,
      status: "discovered",
      liquidity: null,
      openedAtBlock: null,
      metadata: {
        dex: preview.dex,
        currency0: preview.token0,
        currency1: preview.token1,
        fee: preview.feeTier,
        tickSpacing: preview.tickSpacing,
        hooks: preview.hooks,
      },
    };
    const swapRoute = await this.routes.quoteDirect(
      routePosition,
      preview.quoteToken,
      swapAmount,
      preview.baseToken,
    );
    if (!swapRoute) throw new Error("No local swap route found for dual-side open");

    const minOut = applySlippage(swapRoute.expectedOut, this.config.maxSwapSlippageBps);
    const adjustedRoute = { ...swapRoute, minimumOut: minOut };
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + 300);
    const plan = buildSwapPlan(this.chains.getForScan(preview.chain).registry.chain.id, executor, adjustedRoute, deadline);

    if (this.config.dryRun) {
      log.info({ swapAmount: swapAmount.toString(), expectedBase: swapRoute.expectedOut.toString(), protocol: swapRoute.protocol }, "dry-run: dual-side swap via local route");
      return { hash: null, actualBaseOut: swapRoute.expectedOut };
    }

    if (swapRoute.protocol === "v4") {
      if (preview.quoteToken.toLowerCase() === zeroAddress) {
        await this.ensureNativeBalance(client, executor, swapAmount);
      } else {
        await this.ensureApproval(client, preview.quoteToken, registry.contracts.v4.permit2, swapAmount, executor, preview.chain);
        await this.ensurePermit2Approval(client, preview.quoteToken, swapRoute.router, swapAmount, executor, preview.chain);
      }
    } else {
      if (preview.quoteToken.toLowerCase() === zeroAddress) throw new Error("Local native-ETH dual-side swaps require a direct V4 route");
      await this.ensureApproval(client, preview.quoteToken, swapRoute.router, swapAmount, executor, preview.chain);
    }
    const before = await this.tokenBalance(client, preview.baseToken, executor);
    const result = await this.broadcast(preview.chain, plan.to, plan.data, plan.value ?? 0n);
    const after = await this.tokenBalance(client, preview.baseToken, executor);
    if (after <= before) throw new Error("Dual-side swap produced no base token output");
    return { hash: result.hash, actualBaseOut: after - before };
  }

  private sortPrices(a: string, b: string): [string, string] {
    const asUnits = (value: string) => {
      const [whole, fraction = ""] = value.split(".");
      return BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
    };
    return asUnits(a) <= asUnits(b) ? [a, b] : [b, a];
  }

  private async broadcast(chain: ChainName, to: Address, data: Hex, value = 0n): Promise<{ hash: Hex | null }> {
    const client = this.executionClient(chain);
    const executor = this.config.executorAddress;

    await client.call({ account: executor, to, data, value });

    if (this.config.dryRun) {
      log.info({ to, data: data.slice(0, 100) }, "dry-run open position simulated");
      return { hash: null };
    }

    const wallet = this.walletClient(chain);
    const hash = await wallet.sendTransaction({ to, data, value, account: this.account!, chain: this.chains.getForScan(chain).registry.chain });
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: this.config.confirmations });
    if (receipt.status !== "success") throw new Error(`Open position transaction reverted: ${hash}`);
    log.info({ hash, to }, "open position transaction broadcast");
    if (this.ingestOpenReceipt) {
      try {
        await this.ingestOpenReceipt(chain, receipt);
      } catch (error) {
        log.warn({ err: error, hash, chain }, "open receipt ingest failed");
      }
    }
    return { hash };
  }

  private async ensureApproval(client: PublicClient, token: Address, spender: Address, amount: bigint, owner: Address, chain: ChainName): Promise<void> {
    if (token.toLowerCase() === zeroAddress) return;
    const balance = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    if (balance < amount) throw new Error(`Insufficient ${token} balance for open position`);
    const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
    if (allowance >= amount) return;

    if (this.config.dryRun) {
      log.info({ token, spender, amount: amount.toString() }, "dry-run: approval needed");
      return;
    }

    const wallet = this.walletClient(chain);
    const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
    const hash = await wallet.sendTransaction({ to: token, data: approveData, account: this.account!, chain: this.chains.getForScan(chain).registry.chain });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`ERC-20 approval reverted for ${token}`);
    log.info({ hash, token, spender }, "approval submitted");
  }

  private async ensureNativeBalance(client: PublicClient, owner: Address, amount: bigint): Promise<void> {
    const balance = await client.getBalance({ address: owner });
    if (balance < amount) throw new Error("Insufficient native ETH balance for open position");
  }

  private async ensureWrappedNativeFunding(client: PublicClient, chain: ChainName, token: Address, amount: bigint, owner: Address): Promise<void> {
    const wrappedNative = Ether.onChain(this.chains.getForScan(chain).registry.chain.id).wrapped.address.toLowerCase();
    if (token.toLowerCase() !== wrappedNative) return;

    const balance = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    const shortfall = wrappedNativeShortfall(balance, amount);
    if (shortfall === 0n) return;
    await this.ensureNativeBalance(client, owner, shortfall);

    if (this.config.dryRun) {
      log.info({ token, shortfall: shortfall.toString() }, "dry-run: native ETH wrap needed for open position");
      return;
    }

    const wallet = this.walletClient(chain);
    const data = encodeFunctionData({ abi: wethAbi, functionName: "deposit" });
    const hash = await wallet.sendTransaction({ to: token, data, value: shortfall, account: this.account!, chain: this.chains.getForScan(chain).registry.chain });
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: this.config.confirmations });
    if (receipt.status !== "success") throw new Error(`Native ETH wrap reverted for ${token}`);
    log.info({ hash, token, shortfall: shortfall.toString() }, "native ETH wrapped for open position");
  }

  private async tokenBalance(client: PublicClient, token: Address, owner: Address): Promise<bigint> {
    if (token.toLowerCase() === zeroAddress) return client.getBalance({ address: owner });
    return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  }

  private async ensurePermit2Approval(client: PublicClient, token: Address, spender: Address, amount: bigint, owner: Address, chain: ChainName): Promise<void> {
    if (token.toLowerCase() === zeroAddress) {
      const balance = await client.getBalance({ address: owner });
      if (balance < amount) throw new Error("Insufficient native ETH balance for open position");
      return;
    }
    if (amount > (1n << 160n) - 1n) throw new Error("Permit2 approval amount overflows uint160");

    const { registry } = this.chains.getForScan(chain);
    const permit2 = registry.contracts.v4.permit2;
    const allowance = await client.readContract({
      address: permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [owner, token, spender],
    });
    const expiration = Math.floor(Date.now() / 1_000) + 600;
    if (allowance[0] >= amount && BigInt(allowance[1]) >= BigInt(expiration)) return;

    if (this.config.dryRun) {
      log.info({ token, spender, amount: amount.toString() }, "dry-run: Permit2 approval needed");
      return;
    }

    const wallet = this.walletClient(chain);
    const approvalData = encodeFunctionData({
      abi: permit2Abi,
      functionName: "approve",
      args: [token, spender, amount, expiration],
    });
    const hash = await wallet.sendTransaction({ to: permit2, data: approvalData, account: this.account!, chain: this.chains.getForScan(chain).registry.chain });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Permit2 approval reverted for ${token}`);
    log.info({ hash, token, spender }, "Permit2 approval submitted");
  }

  private async tokenDecimals(client: PublicClient, token: Address): Promise<number> {
    if (token.toLowerCase() === zeroAddress.toLowerCase()) return 18;
    const decimals = Number(await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new Error(`Invalid token decimals for ${token}`);
    }
    return decimals;
  }

  private async tokenSymbol(client: PublicClient, token: Address, chain: ChainName): Promise<string> {
    if (token === zeroAddress) return chainRegistry[chain].nativeSymbol;
    try { return await client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }); }
    catch { return "???"; }
  }

  private formatPrice(sqrtPriceX96: bigint, quoteIsToken0: boolean, baseDecimals: number, quoteDecimals: number): string {
    const square = sqrtPriceX96 * sqrtPriceX96;
    const scale = 10n ** 18n;
    const raw = quoteIsToken0
      ? (Q192 * 10n ** BigInt(baseDecimals) * scale) / (square * 10n ** BigInt(quoteDecimals))
      : (square * 10n ** BigInt(quoteDecimals) * scale) / (Q192 * 10n ** BigInt(baseDecimals));
    const whole = raw / scale;
    const frac = (raw % scale).toString().padStart(18, "0").slice(0, 4);
    return `${whole}.${frac}`;
  }
}

export function assertSafeOpenMarket(currentTick: number, poolLiquidity: bigint): void {
  if (poolLiquidity <= 0n) throw new Error("Pool has no liquidity active at the current tick; displayed TVL may be entirely out of range");
  if (!Number.isInteger(currentTick)) throw new Error("Pool price is unusable (invalid tick)");
  if (Math.abs(currentTick) > EXTREME_TICK_ABS) throw new Error("Pool price is unusable (extreme tick)");
  if (currentTick <= -UNISWAP_MAX_TICK + EXTREME_TICK_EDGE || currentTick >= UNISWAP_MAX_TICK - EXTREME_TICK_EDGE) {
    throw new Error("Pool price is unusable (extreme tick)");
  }
}

export function assertMintUtilization(lockedQuote: bigint, depositAmount: bigint): void {
  if (depositAmount <= 0n) throw new Error("Deposit amount must be positive");
  if (lockedQuote < 0n) throw new Error("Minted quote amount is invalid");
  if (lockedQuote * 10_000n < depositAmount * MIN_MINT_UTILIZATION_BPS) {
    throw new Error("Minted liquidity uses less than 90% of the deposit");
  }
}

function bidAskOuterTicks(currentTick: number, tickSpacing: number, quoteIsToken0: boolean, rangePercent: number): { lowerTick: number; upperTick: number } {
  const range = nearestSingleSidedTicks(currentTick, tickSpacing, quoteIsToken0, rangePercent);
  return { lowerTick: range.tickLower, upperTick: range.tickUpper };
}

function isBidAskNativeFunding(protocol: "v3" | "v4", token: Address, symbol: string): boolean {
  return token.toLowerCase() === zeroAddress.toLowerCase() || (protocol === "v3" && (symbol === "ETH" || symbol === "BNB"));
}

function bidAskPoolId(poolKey: V4PoolKey): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
      { type: "int24" },
      { type: "address" },
    ],
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
  ));
}

function sameV4PoolKey(a: V4PoolKey, b: V4PoolKey): boolean {
  return a.currency0.toLowerCase() === b.currency0.toLowerCase()
    && a.currency1.toLowerCase() === b.currency1.toLowerCase()
    && a.fee === b.fee
    && a.tickSpacing === b.tickSpacing
    && a.hooks.toLowerCase() === b.hooks.toLowerCase();
}

function toUint128(value: bigint, label: string): bigint {
  if (value < 0n || value > (1n << 128n) - 1n) throw atomicBatchInfeasible(`${label} exceeds uint128`);
  return value;
}

function atomicBatchInfeasible(reason: string): Error {
  return new Error(`atomic_batch_infeasible: ${reason}`);
}

export function bidAskV4OpenGasBudgetWei(maxOpenGasUsd: number, ethUsd: number): bigint {
  const maxMicros = usdMicros(maxOpenGasUsd);
  const ethMicros = usdMicros(ethUsd);
  if (maxMicros <= 0n || ethMicros <= 0n) throw new Error("Bid-Ask V4 open gas budget must be positive");
  return (maxMicros * 10n ** 18n) / ethMicros;
}

export function assertBidAskV4OpenGasCost(
  gas: bigint,
  maxFeePerGas: bigint,
  budgetWei: bigint,
  maxUsd: number,
  ethUsd: number,
): void {
  if (gas <= 0n) throw atomicBatchInfeasible("estimated gas is unavailable");
  if (maxFeePerGas <= 0n) throw atomicBatchInfeasible("native gas price is unavailable");
  const costWei = gas * maxFeePerGas;
  if (costWei <= budgetWei) return;
  const costUsd = Number((costWei * usdMicros(ethUsd)) / 10n ** 18n) / 1_000_000;
  throw atomicBatchInfeasible(
    `estimated open gas ${formatEther(costWei)} ETH ($${costUsd.toFixed(2)} at $${ethUsd}/ETH) exceeds $${maxUsd.toFixed(2)} limit`,
  );
}

function usdMicros(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) throw new Error("USD amount must be a positive finite number");
  return BigInt(Math.round(value * 1_000_000));
}

function jsonSafe(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (_key, nestedValue: unknown) => (
    typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue
  ))) as Record<string, unknown>;
}

export function selectOpenQuoteToken(
  allowed: readonly QuoteToken[],
  token0: Address,
  token1: Address,
  priority: readonly string[] = ["USDG", "USDC", "WETH", "ETH", "NVDA"],
): QuoteToken | null {
  const matches = allowed.filter(({ symbol, address }) =>
    priority.includes(symbol) && (address.toLowerCase() === token0.toLowerCase() || address.toLowerCase() === token1.toLowerCase()),
  );
  return matches.sort((a, b) => priority.indexOf(a.symbol) - priority.indexOf(b.symbol))[0] ?? null;
}

export function bidAskDirectionForQuote(quoteIsToken0: boolean): BidAskDirection {
  return quoteIsToken0 ? "above" : "below";
}

export function openPoolQuoteAddress(protocol: "v3" | "v4", chainId: number, quoteToken: QuoteToken): Address {
  // V3 pools store WETH, while V4 pools can represent native ETH as zeroAddress.
  return protocol === "v3" && quoteToken.address === zeroAddress
    ? Ether.onChain(chainId).wrapped.address as Address
    : quoteToken.address;
}

export function wrappedNativeShortfall(wrappedBalance: bigint, requiredAmount: bigint): bigint {
  return wrappedBalance >= requiredAmount ? 0n : requiredAmount - wrappedBalance;
}
