import { createRequire } from "node:module";
import { isAddress, isHex, zeroAddress, type Address, type Hex, type PublicClient } from "viem";

import { erc20Abi, v3PoolAbi } from "../abi.js";
import { chainRegistry } from "../chains.js";
import { log } from "../log.js";
import type { PositionRecord, TransactionPlan } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import type { RoutePlanner, SwapRoute } from "./route-planner.js";
import { applySlippage } from "./uniswap-math.js";

const require = createRequire(import.meta.url);
const pancakeChains = require("@pancakeswap/chains") as { ChainId: { BSC: number } };
const pancakeSdk = require("@pancakeswap/sdk") as {
  CurrencyAmount: { fromRawAmount(currency: unknown, amount: bigint): { currency: unknown; quotient: { toString(): string } } };
  ERC20Token: new (chainId: number, address: Address, decimals: number, symbol: string) => { address: Address };
  Percent: new (numerator: bigint | number, denominator: bigint | number) => unknown;
  TradeType: { EXACT_INPUT: unknown };
};
const pancakeSmartRouter = require("@pancakeswap/smart-router") as {
  SmartRouter: {
    getV2CandidatePools(params: unknown): Promise<unknown[]>;
    getV3CandidatePools(params: unknown): Promise<unknown[]>;
    createStaticPoolProvider(pools: unknown[]): unknown;
    createQuoteProvider(config: unknown): unknown;
    getBestTrade(...args: unknown[]): Promise<{ outputAmount: { quotient: { toString(): string } } } | null>;
  };
  PoolType: { V2: unknown; V3: unknown };
  RouteType: { V3: unknown };
};
const pancakeUrSdk = require("@pancakeswap/universal-router-sdk") as {
  PancakeSwapUniversalRouter: { swapERC20CallParameters(trade: unknown, options: unknown): { calldata: Hex; value: string } };
  getUniversalRouterAddress(chainId: number): Address;
};

export const PANCAKE_PERMIT2 = "0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768" as Address;
export const PANCAKE_UNIVERSAL_ROUTER = pancakeUrSdk.getUniversalRouterAddress(pancakeChains.ChainId.BSC);

export interface PancakeUrQuote {
  source: "pancake-ur";
  expectedOut: bigint;
  minimumOut: bigint;
  router: Address;
  permit2: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  chainId: number;
  owner: Address;
  slippageBps: number;
  validUntilMs: number;
  trade: unknown;
}

export class PancakeUniversalRouter {
  private readonly tokens = new Map<string, { address: Address }>();

  constructor(
    private readonly chains: ChainClients,
    private readonly routes: RoutePlanner,
    private readonly defaultSlippageBps: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(defaultSlippageBps) || defaultSlippageBps < 1 || defaultSlippageBps > 2_000) {
      throw new Error("Pancake UR slippage must be between 1 and 2000 bps");
    }
  }

  async quote(
    position: PositionRecord,
    tokenIn: Address,
    amountIn: bigint,
    tokenOut: Address,
    slippageBps = this.defaultSlippageBps,
  ): Promise<PancakeUrQuote | null> {
    if (position.chainId !== chainRegistry.bsc.chain.id) return null;
    if (!isAddress(position.owner) || !isAddress(tokenIn) || !isAddress(tokenOut)) throw new Error("Pancake UR quote contains an invalid address");
    if (tokenIn.toLowerCase() === zeroAddress || tokenOut.toLowerCase() === zeroAddress) return null;
    if (amountIn <= 0n) throw new Error("Pancake UR quote amount must be positive");
    if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) throw new Error("Pancake UR input and output tokens must differ");

    const client = this.chains.getForScan("bsc").client;
    const [currencyIn, currencyOut] = await Promise.all([
      this.token(client, tokenIn),
      this.token(client, tokenOut),
    ]);
    const inputAmount = pancakeSdk.CurrencyAmount.fromRawAmount(currencyIn, amountIn);
    const route = await this.routes.quoteDirect(position, tokenIn, amountIn, tokenOut, { includeV4: false });
    let trade: { outputAmount: { quotient: { toString(): string } } } | null = route
      ? await this.tradeFromRoute(client, route, currencyIn, currencyOut)
      : null;
    if (!trade) trade = await this.bestTrade(client, inputAmount, currencyOut);
    if (!trade) return null;
    const expectedOut = BigInt(trade.outputAmount.quotient.toString());
    if (expectedOut <= 0n) return null;
    return {
      source: "pancake-ur",
      expectedOut,
      minimumOut: applySlippage(expectedOut, slippageBps),
      router: PANCAKE_UNIVERSAL_ROUTER,
      permit2: PANCAKE_PERMIT2,
      tokenIn,
      tokenOut,
      amountIn,
      chainId: position.chainId,
      owner: position.owner,
      slippageBps,
      validUntilMs: this.now() + 12_000,
      trade,
    };
  }

  createSwap(position: PositionRecord, quote: PancakeUrQuote): TransactionPlan {
    this.validate(quote, position);
    const { calldata, value } = pancakeUrSdk.PancakeSwapUniversalRouter.swapERC20CallParameters(quote.trade, {
      slippageTolerance: new pancakeSdk.Percent(BigInt(quote.slippageBps), 10_000n),
      recipient: position.owner,
      deadlineOrPreviousBlockhash: Math.floor(this.now() / 1_000) + 180,
      payerIsUser: true,
    });
    if (!isHex(calldata) || calldata === "0x") throw new Error("Pancake UR returned empty calldata");
    if (BigInt(value) !== 0n) throw new Error("Pancake UR ERC-20 swap returned a nonzero transaction value");
    return {
      chainId: position.chainId,
      to: PANCAKE_UNIVERSAL_ROUTER,
      data: calldata,
      value: 0n,
      description: "swap through PancakeSwap Universal Router",
    };
  }

  private validate(quote: PancakeUrQuote, position?: PositionRecord): void {
    if (quote.source !== "pancake-ur" || quote.router.toLowerCase() !== PANCAKE_UNIVERSAL_ROUTER.toLowerCase()) {
      throw new Error("Invalid Pancake UR quote context");
    }
    if (this.now() > quote.validUntilMs) throw new Error("Pancake UR quote expired before build");
    if (position && (position.chainId !== quote.chainId || position.owner.toLowerCase() !== quote.owner.toLowerCase())) {
      throw new Error("Pancake UR quote does not belong to this position");
    }
  }

  private async bestTrade(client: PublicClient, amountIn: { currency: unknown; quotient: { toString(): string } }, currencyOut: { address: Address }) {
    try {
      const [v2Pools, v3Pools] = await Promise.all([
        pancakeSmartRouter.SmartRouter.getV2CandidatePools({ onChainProvider: () => client as never, currencyA: amountIn.currency, currencyB: currencyOut }),
        pancakeSmartRouter.SmartRouter.getV3CandidatePools({
          onChainProvider: () => client as never,
          subgraphProvider: undefined,
          subgraphFallback: true,
          currencyA: amountIn.currency,
          currencyB: currencyOut,
        }),
      ]);
      const pools = [...v2Pools, ...v3Pools];
      if (pools.length === 0) return null;
      return await pancakeSmartRouter.SmartRouter.getBestTrade(amountIn, currencyOut, pancakeSdk.TradeType.EXACT_INPUT, {
        gasPriceWei: () => client.getGasPrice(),
        poolProvider: pancakeSmartRouter.SmartRouter.createStaticPoolProvider(pools),
        quoteProvider: pancakeSmartRouter.SmartRouter.createQuoteProvider({ onChainProvider: () => client as never }),
        maxHops: 3,
        maxSplits: 2,
        allowedPoolTypes: [pancakeSmartRouter.PoolType.V2, pancakeSmartRouter.PoolType.V3],
      });
    } catch (error) {
      log.warn({ err: error }, "Pancake Smart Router quote failed");
      return null;
    }
  }

  private async tradeFromRoute(
    client: PublicClient,
    route: SwapRoute,
    currencyIn: { address: Address },
    currencyOut: { address: Address },
  ) {
    if (route.protocol !== "v3" || !route.fees || route.pools.length === 0) return null;
    const path: { address: Address }[] = [currencyIn];
    for (const hop of route.path.slice(1, -1)) path.push(await this.token(client, hop));
    path.push(currencyOut);
    const pools = await Promise.all(route.pools.map(async (address, index) => {
      const [token0Address, token1Address, slot0, liquidity] = await Promise.all([
        client.readContract({ address, abi: v3PoolAbi, functionName: "token0" }),
        client.readContract({ address, abi: v3PoolAbi, functionName: "token1" }),
        client.readContract({ address, abi: v3PoolAbi, functionName: "slot0" }),
        client.readContract({ address, abi: v3PoolAbi, functionName: "liquidity" }),
      ]);
      const token0 = path.find((item) => item.address.toLowerCase() === token0Address.toLowerCase())
        ?? await this.token(client, token0Address);
      const token1 = path.find((item) => item.address.toLowerCase() === token1Address.toLowerCase())
        ?? await this.token(client, token1Address);
      return {
        type: pancakeSmartRouter.PoolType.V3,
        token0,
        token1,
        fee: route.fees![index]!,
        liquidity,
        sqrtRatioX96: slot0[0],
        tick: slot0[1],
        address,
        token0ProtocolFee: new pancakeSdk.Percent(0, 1),
        token1ProtocolFee: new pancakeSdk.Percent(0, 1),
      };
    }));
    const inputAmount = pancakeSdk.CurrencyAmount.fromRawAmount(currencyIn, route.amountIn);
    const outputAmount = pancakeSdk.CurrencyAmount.fromRawAmount(currencyOut, route.expectedOut);
    return {
      tradeType: pancakeSdk.TradeType.EXACT_INPUT,
      inputAmount,
      outputAmount,
      routes: [{
        type: pancakeSmartRouter.RouteType.V3,
        pools,
        path,
        input: currencyIn,
        output: currencyOut,
        percent: 100,
        inputAmount,
        outputAmount,
      }],
      gasEstimate: 0n,
    };
  }

  private async token(client: PublicClient, address: Address): Promise<{ address: Address }> {
    const key = address.toLowerCase();
    const cached = this.tokens.get(key);
    if (cached) return cached;
    const [decimals, symbol] = await Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => "TKN"),
    ]);
    const token = new pancakeSdk.ERC20Token(pancakeChains.ChainId.BSC, address, Number(decimals), symbol);
    this.tokens.set(key, token);
    return token;
  }
}
