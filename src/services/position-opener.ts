import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Address, type Hex, type PublicClient, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { erc20Abi, permit2Abi, v3PoolAbi, v4PoolKeysAbi, v4StateViewAbi } from "../abi.js";
import type { RuntimeConfig } from "../config.js";
import { log } from "../log.js";
import type { ChainName, PositionRecord, QuoteToken } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import type { RoutePlanner } from "./route-planner.js";
import { buildSwapPlan } from "./swap-builder.js";
import { UNISWAP_API_ROUTER, type UniswapTradingApi } from "./uniswap-trading-api.js";
import { applySlippage, sqrtRatioAtTick, tickToCeilSpacing, tickToFloorSpacing, ticksForDropPercent, ticksForRisePercent } from "./uniswap-math.js";

const require = createRequire(import.meta.url);
const { Ether, Percent, Token } = require("@uniswap/sdk-core") as typeof import("@uniswap/sdk-core");
const { FeeAmount, NonfungiblePositionManager, Pool: V3SdkPool, Position: V3SdkPosition } = require("@uniswap/v3-sdk") as typeof import("@uniswap/v3-sdk");
const { Pool: V4SdkPool, Position: V4SdkPosition, V4PositionManager } = require("@uniswap/v4-sdk") as typeof import("@uniswap/v4-sdk");
type V3Position = import("@uniswap/v3-sdk").Position;
type V4Position = import("@uniswap/v4-sdk").Position;
type V3FeeAmount = import("@uniswap/v3-sdk").FeeAmount;
const OPEN_QUOTE_PRIORITY = ["USDG", "USDC", "WETH", "ETH"];

export type OpenMode = "single" | "dual";

export interface OpenPositionPreview {
  protocol: "v3" | "v4";
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
  token0Decimals: number;
  token1Decimals: number;
  currentTick: number;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  sqrtPriceX96: bigint;
  poolLiquidity: bigint;
  hooks: Address;
  liquidity: bigint;
  depositAmount: bigint;
  lowerPrice: string;
  upperPrice: string;
  currentPrice: string;
  dropPercent: number;
  mode: OpenMode;
  baseToken?: Address;
  baseTokenSymbol?: string;
  baseAmount?: bigint;
  quoteSideAmount?: bigint;
  swapAmount?: bigint;
  expectedBaseFromSwap?: bigint;
}

const Q192 = 1n << 192n;
const V3_SUPPORTED_FEES = new Set<number>([FeeAmount.LOWEST, FeeAmount.LOW, FeeAmount.MEDIUM, FeeAmount.HIGH]);

type V4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export class PositionOpener {
  private readonly account;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly chains: ChainClients,
    private readonly routes?: RoutePlanner,
    private readonly tradingApi?: UniswapTradingApi,
  ) {
    this.account = config.executorPrivateKey ? privateKeyToAccount(config.executorPrivateKey) : undefined;
  }

  private client(chain: ChainName): PublicClient {
    const { registry } = this.chains.get(chain);
    const alchemyUrl = this.config.alchemyHttp[chain];
    if (!alchemyUrl) throw new Error(`ALCHEMY RPC is required for opening positions`);
    return createPublicClient({ chain: registry.chain, transport: http(alchemyUrl, { retryCount: 3, timeout: 20_000 }) });
  }

  private walletClient(chain: ChainName) {
    if (!this.account) throw new Error("Executor private key is not configured");
    const { registry } = this.chains.get(chain);
    const alchemyUrl = this.config.alchemyHttp[chain];
    if (!alchemyUrl) throw new Error(`ALCHEMY RPC is required for opening positions`);
    return createWalletClient({ chain: registry.chain, transport: http(alchemyUrl, { retryCount: 3, timeout: 20_000 }), account: this.account });
  }

  async prepareOpen(poolAddress: string, chain: ChainName, rangePercent: number, depositAmount: bigint, quoteToken: QuoteToken, mode: OpenMode = "single"): Promise<OpenPositionPreview> {
    const normalized = poolAddress.toLowerCase() as Hex;
    const isV4 = normalized.length === 66 && normalized.startsWith("0x");
    const protocol = isV4 ? "v4" : "v3";

    if (protocol === "v3") return this.prepareV3(normalized, chain, rangePercent, depositAmount, quoteToken, mode);
    return this.prepareV4(normalized, chain, rangePercent, depositAmount, quoteToken, mode);
  }

  async detectQuoteToken(poolAddress: string, chain: ChainName): Promise<QuoteToken> {
    const normalized = poolAddress.toLowerCase() as Hex;
    const isV4 = normalized.length === 66 && normalized.startsWith("0x");
    const client = this.client(chain);
    let token0: Address;
    let token1: Address;
    if (isV4) {
      const { registry } = this.chains.get(chain);
      const bytes25 = normalized.slice(0, 2 + 25 * 2) as Hex;
      const poolKey = await client.readContract({ address: registry.contracts.v4.positionManager, abi: v4PoolKeysAbi, functionName: "poolKeys", args: [bytes25] }) as unknown as V4PoolKey;
      token0 = poolKey.currency0;
      token1 = poolKey.currency1;
    } else {
      [token0, token1] = await Promise.all([
        client.readContract({ address: normalized, abi: v3PoolAbi, functionName: "token0" }) as Promise<Address>,
        client.readContract({ address: normalized, abi: v3PoolAbi, functionName: "token1" }) as Promise<Address>,
      ]);
    }
    const allowed = this.config.quoteTokens[chain] ?? [];
    const quote = selectOpenQuoteToken(allowed, token0, token1);
    // Uniswap V3 stores native ETH pools as WETH, but its PositionManager can
    // wrap native ETH in the mint multicall. Keep the pool address as WETH while
    // exposing ETH as the funding currency to the user.
    if (quote) return !isV4 && quote.symbol === "WETH" ? { ...quote, symbol: "ETH" } : quote;
    if ((token0.toLowerCase() === zeroAddress || token1.toLowerCase() === zeroAddress) && allowed.some(({ symbol }) => symbol === "ETH")) {
      return { symbol: "ETH", address: zeroAddress };
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

    if (!V3_SUPPORTED_FEES.has(Number(fee))) throw new Error(`V3 fee tier ${fee} is unsupported by the official SDK`);
    return this.buildPreview("v3", chain, pool, token0, token1, Number(fee), Number(tickSpacing), slot0[1], slot0[0], liquidity, zeroAddress, rangePercent, depositAmount, quoteToken, mode);
  }

  private async prepareV4(poolId: Hex, chain: ChainName, rangePercent: number, depositAmount: bigint, quoteToken: QuoteToken, mode: OpenMode): Promise<OpenPositionPreview> {
    const client = this.client(chain);
    const { registry } = this.chains.get(chain);
    const bytes25 = poolId.slice(0, 2 + 25 * 2) as Hex;

    const [slot0, liquidity, poolKeyResult] = await Promise.all([
      client.readContract({ address: registry.contracts.v4.stateView, abi: v4StateViewAbi, functionName: "getSlot0", args: [poolId] }),
      client.readContract({ address: registry.contracts.v4.stateView, abi: v4StateViewAbi, functionName: "getLiquidity", args: [poolId] }) as Promise<bigint>,
      client.readContract({ address: registry.contracts.v4.positionManager, abi: v4PoolKeysAbi, functionName: "poolKeys", args: [bytes25] }),
    ]);

    const poolKey = poolKeyResult as unknown as V4PoolKey;

    return this.buildPreview("v4", chain, poolId, poolKey.currency0, poolKey.currency1, Number(poolKey.fee), poolKey.tickSpacing, slot0[1], slot0[0], liquidity, poolKey.hooks, rangePercent, depositAmount, quoteToken, mode);
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
  ): Promise<OpenPositionPreview> {
    const client = this.client(chain);
    const quoteAddr = openPoolQuoteAddress(protocol, this.chains.get(chain).registry.chain.id, quoteToken).toLowerCase() as Address;
    const quoteIsToken0 = quoteAddr === token0.toLowerCase();
    if (!quoteIsToken0 && quoteAddr !== token1.toLowerCase()) {
      throw new Error("Quote token is neither token0 nor token1 of this pool");
    }

    const [token0Decimals, token1Decimals] = await Promise.all([this.tokenDecimals(client, token0), this.tokenDecimals(client, token1)]);
    const baseToken = quoteIsToken0 ? token1 : token0;
    const baseDecimals = quoteIsToken0 ? token1Decimals : token0Decimals;
    const quoteDecimals = quoteIsToken0 ? token0Decimals : token1Decimals;
    const baseSymbol = await this.tokenSymbol(client, baseToken);

    let tickLower: number;
    let tickUpper: number;

    if (mode === "dual") {
      tickLower = tickToFloorSpacing(currentTick - ticksForDropPercent(rangePercent), tickSpacing);
      tickUpper = tickToCeilSpacing(currentTick + ticksForRisePercent(rangePercent), tickSpacing);
    } else if (quoteIsToken0) {
      tickLower = tickToCeilSpacing(currentTick + tickSpacing, tickSpacing);
      tickUpper = tickToCeilSpacing(tickLower + ticksForDropPercent(rangePercent), tickSpacing);
    } else {
      tickUpper = tickToFloorSpacing(currentTick - tickSpacing, tickSpacing);
      tickLower = tickToFloorSpacing(tickUpper - ticksForDropPercent(rangePercent), tickSpacing);
    }

    const position = protocol === "v3"
      ? this.v3Position(chain, token0, token1, token0Decimals, token1Decimals, fee, sqrtPriceX96, poolLiquidity, currentTick, tickLower, tickUpper, depositAmount, quoteIsToken0, mode)
      : this.v4Position(chain, token0, token1, token0Decimals, token1Decimals, fee, tickSpacing, hooks, sqrtPriceX96, poolLiquidity, currentTick, tickLower, tickUpper, depositAmount, quoteIsToken0, mode);
    const liquidity = BigInt(position.liquidity.toString());
    if (liquidity === 0n) throw new Error("Deposit amount is too small for this pool range");

    if (mode === "single") {
      this.assertSingleSideSpend(position, quoteIsToken0, depositAmount);
    } else {
      this.assertDualSidePosition(position, quoteIsToken0);
    }

    const sqrtLower = sqrtRatioAtTick(tickLower);
    const sqrtUpper = sqrtRatioAtTick(tickUpper);

    const currentPrice = this.formatPrice(sqrtPriceX96, quoteIsToken0, baseDecimals, quoteDecimals);
    const pair = quoteIsToken0 ? `${baseSymbol}/${quoteToken.symbol}` : `${quoteToken.symbol}/${baseSymbol}`;

    const [lowerPrice, upperPrice] = this.sortPrices(
      this.formatPrice(sqrtLower, quoteIsToken0, baseDecimals, quoteDecimals),
      this.formatPrice(sqrtUpper, quoteIsToken0, baseDecimals, quoteDecimals),
    );

    const basePreview: OpenPositionPreview = {
      protocol, chain, poolAddress: pool, pair, feeTier: fee,
      feeLabel: hooks !== zeroAddress ? `${(fee / 10_000).toFixed(2)}% dynamic` : `${(fee / 10_000).toFixed(2)}%`,
      quoteToken: quoteToken.address, quoteTokenSymbol: quoteToken.symbol,
      quoteIsToken0, token0, token1, token0Decimals, token1Decimals, currentTick, tickSpacing, tickLower, tickUpper, sqrtPriceX96, poolLiquidity, hooks, liquidity, depositAmount,
      lowerPrice, upperPrice, currentPrice, dropPercent: rangePercent, mode,
    };

    if (mode === "dual") {
      const split = this.computeDualSplit(position, quoteIsToken0, depositAmount, sqrtPriceX96);
      return { ...basePreview, baseToken, baseTokenSymbol: baseSymbol, ...split };
    }

    return basePreview;
  }

  async executeOpen(preview: OpenPositionPreview): Promise<{ hash: Hex | null; swapHash?: Hex | null }> {
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + 600);
    const refreshed = await this.prepareOpen(preview.poolAddress, preview.chain, preview.dropPercent, preview.depositAmount, { address: preview.quoteToken, symbol: preview.quoteTokenSymbol }, preview.mode);
    const merged = { ...preview, ...refreshed, tickLower: preview.tickLower, tickUpper: preview.tickUpper };

    if (preview.mode === "single") {
      if (!this.isStillSingleSided(preview, refreshed.currentTick)) throw new Error("Pool price moved into the requested range; review and confirm again");
      if (preview.protocol === "v3") return this.executeV3(merged, deadline);
      return this.executeV4(merged, deadline);
    }

    if (!this.isStillStraddling(preview, refreshed.currentTick)) throw new Error("Pool price moved outside the dual-side range; review and confirm again");

    const swapResult = await this.swapQuoteForBase(merged);
    const baseAmount = swapResult.actualBaseOut;
    const quoteSideAmount = merged.quoteSideAmount ?? 0n;
    if (preview.protocol === "v3") {
      return { ...(await this.executeV3Dual(merged, deadline, quoteSideAmount, baseAmount)), swapHash: swapResult.hash };
    }
    return { ...(await this.executeV4Dual(merged, deadline, quoteSideAmount, baseAmount)), swapHash: swapResult.hash };
  }

  private async executeV3(preview: OpenPositionPreview, deadline: bigint): Promise<{ hash: Hex | null }> {
    const client = this.client(preview.chain);
    const { registry } = this.chains.get(preview.chain);
    const positionManager = registry.contracts.v3.positionManager;
    const executor = this.config.executorAddress;

    const useNative = preview.quoteTokenSymbol === "ETH";
    if (useNative) await this.ensureNativeBalance(client, executor, preview.depositAmount);
    else await this.ensureApproval(client, preview.quoteToken, positionManager, preview.depositAmount, executor, preview.chain);
    const position = this.v3PositionFromPreview(preview);
    this.assertSingleSideSpend(position, preview.quoteIsToken0, preview.depositAmount);
    const parameters = NonfungiblePositionManager.addCallParameters(position, {
      recipient: executor,
      deadline: deadline.toString(),
      slippageTolerance: new Percent(0, 10_000),
      ...(useNative ? { useNative: Ether.onChain(this.chains.get(preview.chain).registry.chain.id) } : {}),
    });
    return this.broadcast(preview.chain, positionManager, parameters.calldata as Hex, BigInt(parameters.value));
  }

  private async executeV4(preview: OpenPositionPreview, deadline: bigint): Promise<{ hash: Hex | null }> {
    const client = this.client(preview.chain);
    const { registry } = this.chains.get(preview.chain);
    const positionManager = registry.contracts.v4.positionManager;
    const executor = this.config.executorAddress;

    await this.ensureApproval(client, preview.quoteToken, registry.contracts.v4.permit2, preview.depositAmount, executor, preview.chain);
    await this.ensurePermit2Approval(client, preview.quoteToken, positionManager, preview.depositAmount, executor, preview.chain);
    const position = this.v4PositionFromPreview(preview);
    this.assertSingleSideSpend(position, preview.quoteIsToken0, preview.depositAmount);
    const parameters = V4PositionManager.addCallParameters(position, {
      recipient: executor,
      deadline: deadline.toString(),
      slippageTolerance: new Percent(0, 10_000),
      hookData: "0x",
      ...(preview.token0.toLowerCase() === zeroAddress ? { useNative: Ether.onChain(this.chains.get(preview.chain).registry.chain.id) } : {}),
    });
    return this.broadcast(preview.chain, positionManager, parameters.calldata as Hex, BigInt(parameters.value));
  }

  private async executeV3Dual(preview: OpenPositionPreview, deadline: bigint, quoteAmount: bigint, baseAmount: bigint): Promise<{ hash: Hex | null }> {
    const client = this.client(preview.chain);
    const { registry } = this.chains.get(preview.chain);
    const positionManager = registry.contracts.v3.positionManager;
    const executor = this.config.executorAddress;
    const chainId = this.chains.get(preview.chain).registry.chain.id;

    const useNative = preview.quoteToken === zeroAddress;
    if (quoteAmount > 0n) {
      if (useNative) await this.ensureNativeBalance(client, executor, quoteAmount);
      else await this.ensureApproval(client, preview.quoteToken, positionManager, quoteAmount, executor, preview.chain);
    }
    if (baseAmount > 0n && preview.baseToken) await this.ensureApproval(client, preview.baseToken, positionManager, baseAmount, executor, preview.chain);

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
    const client = this.client(preview.chain);
    const { registry } = this.chains.get(preview.chain);
    const positionManager = registry.contracts.v4.positionManager;
    const executor = this.config.executorAddress;
    const chainId = this.chains.get(preview.chain).registry.chain.id;

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
  ): V3Position {
    const chainId = this.chains.get(chain).registry.chain.id;
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
      preview.tickLower, preview.tickUpper, preview.depositAmount, preview.quoteIsToken0, preview.mode,
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
    const chainId = this.chains.get(chain).registry.chain.id;
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
    const client = this.client(preview.chain);
    const { registry } = this.chains.get(preview.chain);

    if (this.tradingApi) {
      let apiPlan: { to: Address; data: Hex; value?: bigint } | null = null;
      try {
        let quote = await this.tradingApi.quote(
          { chainId: this.chains.get(preview.chain).registry.chain.id, owner: executor } as PositionRecord,
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
            { chainId: this.chains.get(preview.chain).registry.chain.id, owner: executor } as PositionRecord,
            preview.quoteToken,
            swapAmount,
            preview.baseToken,
            this.config.maxSwapSlippageBps,
          );
          if (!quote) throw new Error("Trading API route disappeared after approval");
          apiPlan = await this.tradingApi.createSwap(
            { chainId: this.chains.get(preview.chain).registry.chain.id, owner: executor } as PositionRecord,
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

    if (preview.quoteToken === zeroAddress) throw new Error("No Trading API route is available for native-ETH dual-side open");
    if (!this.routes) throw new Error("No swap route available for dual-side open");
    const swapRoute = await this.routes.quoteDirect(
      { chainId: this.chains.get(preview.chain).registry.chain.id } as PositionRecord,
      preview.quoteToken,
      swapAmount,
      preview.baseToken,
    );
    if (!swapRoute) throw new Error("No local swap route found for dual-side open");

    const minOut = applySlippage(swapRoute.expectedOut, this.config.maxSwapSlippageBps);
    const adjustedRoute = { ...swapRoute, minimumOut: minOut };
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + 300);
    const plan = buildSwapPlan(this.chains.get(preview.chain).registry.chain.id, executor, adjustedRoute, deadline);

    if (this.config.dryRun) {
      log.info({ swapAmount: swapAmount.toString(), expectedBase: swapRoute.expectedOut.toString(), protocol: swapRoute.protocol }, "dry-run: dual-side swap via local route");
      return { hash: null, actualBaseOut: swapRoute.expectedOut };
    }

    if (swapRoute.protocol === "v4") {
      await this.ensureApproval(client, preview.quoteToken, registry.contracts.v4.permit2, swapAmount, executor, preview.chain);
      await this.ensurePermit2Approval(client, preview.quoteToken, swapRoute.router, swapAmount, executor, preview.chain);
    } else {
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
    const client = this.client(chain);
    const executor = this.config.executorAddress;

    await client.call({ account: executor, to, data, value });

    if (this.config.dryRun) {
      log.info({ to, data: data.slice(0, 100) }, "dry-run open position simulated");
      return { hash: null };
    }

    const wallet = this.walletClient(chain);
    const hash = await wallet.sendTransaction({ to, data, value, account: this.account!, chain: this.chains.get(chain).registry.chain });
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: this.config.confirmations });
    if (receipt.status !== "success") throw new Error(`Open position transaction reverted: ${hash}`);
    log.info({ hash, to }, "open position transaction broadcast");
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
    const hash = await wallet.sendTransaction({ to: token, data: approveData, account: this.account!, chain: this.chains.get(chain).registry.chain });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`ERC-20 approval reverted for ${token}`);
    log.info({ hash, token, spender }, "approval submitted");
  }

  private async ensureNativeBalance(client: PublicClient, owner: Address, amount: bigint): Promise<void> {
    const balance = await client.getBalance({ address: owner });
    if (balance < amount) throw new Error("Insufficient native ETH balance for open position");
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

    const { registry } = this.chains.get(chain);
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
    const hash = await wallet.sendTransaction({ to: permit2, data: approvalData, account: this.account!, chain: this.chains.get(chain).registry.chain });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Permit2 approval reverted for ${token}`);
    log.info({ hash, token, spender }, "Permit2 approval submitted");
  }

  private async tokenDecimals(client: PublicClient, token: Address): Promise<number> {
    if (token === zeroAddress) return 18;
    try { return Number(await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })); }
    catch { return 18; }
  }

  private async tokenSymbol(client: PublicClient, token: Address): Promise<string> {
    if (token === zeroAddress) return "ETH";
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

export function selectOpenQuoteToken(allowed: readonly QuoteToken[], token0: Address, token1: Address): QuoteToken | null {
  const matches = allowed.filter(({ symbol, address }) =>
    OPEN_QUOTE_PRIORITY.includes(symbol) && (address.toLowerCase() === token0.toLowerCase() || address.toLowerCase() === token1.toLowerCase()),
  );
  return matches.sort((a, b) => OPEN_QUOTE_PRIORITY.indexOf(a.symbol) - OPEN_QUOTE_PRIORITY.indexOf(b.symbol))[0] ?? null;
}

export function openPoolQuoteAddress(protocol: "v3" | "v4", chainId: number, quoteToken: QuoteToken): Address {
  // V3 pools store WETH, while V4 pools can represent native ETH as zeroAddress.
  return protocol === "v3" && quoteToken.address === zeroAddress
    ? Ether.onChain(chainId).wrapped.address as Address
    : quoteToken.address;
}
