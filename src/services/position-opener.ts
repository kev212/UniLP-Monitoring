import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, http, type Address, type Hex, type PublicClient, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { erc20Abi, v3PoolAbi, v3PositionManagerAbi, v4PositionManagerAbi, v4PoolKeysAbi, v4StateViewAbi } from "../abi.js";
import { chainRegistry, type ChainRegistry } from "../chains.js";
import type { RuntimeConfig } from "../config.js";
import { log } from "../log.js";
import type { ChainName, QuoteToken } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import { applySlippage, liquidityForAmount0, liquidityForAmount1, sqrtRatioAtTick, tickToCeilSpacing, tickToFloorSpacing, ticksForDropPercent } from "./uniswap-math.js";

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
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  depositAmount: bigint;
  lowerPrice: string;
  upperPrice: string;
  currentPrice: string;
  dropPercent: number;
}

const Q192 = 1n << 192n;

type V4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export function encodeV4MintParams(
  poolKey: V4PoolKey,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
  amount0Min: bigint,
  amount1Min: bigint,
): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { type: "int24" },
      { type: "int24" },
      { type: "uint256" },
      { type: "uint128" },
      { type: "uint128" },
      { type: "bytes" },
    ],
    [poolKey, tickLower, tickUpper, liquidity, amount0Min, amount1Min, "0x"],
  );
}

export class PositionOpener {
  private readonly account;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly chains: ChainClients,
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

  async prepareOpen(poolAddress: string, chain: ChainName, dropPercent: number, depositAmount: bigint, quoteToken: QuoteToken): Promise<OpenPositionPreview> {
    const normalized = poolAddress.toLowerCase() as Hex;
    const isV4 = normalized.length === 66 && normalized.startsWith("0x");
    const protocol = isV4 ? "v4" : "v3";

    if (protocol === "v3") return this.prepareV3(normalized, chain, dropPercent, depositAmount, quoteToken);
    return this.prepareV4(normalized, chain, dropPercent, depositAmount, quoteToken);
  }

  private async prepareV3(pool: Hex, chain: ChainName, dropPercent: number, depositAmount: bigint, quoteToken: QuoteToken): Promise<OpenPositionPreview> {
    const client = this.client(chain);
    const [token0, token1, fee, slot0, tickSpacing] = await Promise.all([
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "token0" }) as Promise<Address>,
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "token1" }) as Promise<Address>,
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "fee" }) as Promise<number>,
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "slot0" }),
      client.readContract({ address: pool, abi: v3PoolAbi, functionName: "tickSpacing" }) as Promise<number>,
    ]);

    return this.buildPreview("v3", chain, pool, token0, token1, Number(fee), Number(tickSpacing), slot0[1], slot0[0], zeroAddress, dropPercent, depositAmount, quoteToken);
  }

  private async prepareV4(poolId: Hex, chain: ChainName, dropPercent: number, depositAmount: bigint, quoteToken: QuoteToken): Promise<OpenPositionPreview> {
    const client = this.client(chain);
    const { registry } = this.chains.get(chain);
    const bytes25 = poolId.slice(0, 2 + 25 * 2) as Hex;

    const [slot0, poolKeyResult] = await Promise.all([
      client.readContract({ address: registry.contracts.v4.stateView, abi: v4StateViewAbi, functionName: "getSlot0", args: [poolId] }),
      client.readContract({ address: registry.contracts.v4.positionManager, abi: v4PoolKeysAbi, functionName: "poolKeys", args: [bytes25] }),
    ]);

    const poolKey = poolKeyResult as unknown as V4PoolKey;
    const lpFee = slot0[3];

    return this.buildPreview("v4", chain, poolId, poolKey.currency0, poolKey.currency1, Number(lpFee), poolKey.tickSpacing, slot0[1], slot0[0], poolKey.hooks, dropPercent, depositAmount, quoteToken);
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
    hooks: Address,
    dropPercent: number,
    depositAmount: bigint,
    quoteToken: QuoteToken,
  ): Promise<OpenPositionPreview> {
    const client = this.client(chain);
    const quoteAddr = quoteToken.address.toLowerCase() as Address;
    const quoteIsToken0 = quoteAddr === token0.toLowerCase();
    if (quoteIsToken0 !== (quoteAddr < token1.toLowerCase())) {
      throw new Error("Quote token is neither token0 nor token1 of this pool");
    }

    let tickLower: number;
    let tickUpper: number;

    if (quoteIsToken0) {
      tickUpper = tickToFloorSpacing(currentTick - tickSpacing, tickSpacing);
      tickLower = tickToFloorSpacing(tickUpper - ticksForDropPercent(dropPercent), tickSpacing);
    } else {
      tickLower = tickToCeilSpacing(currentTick + tickSpacing, tickSpacing);
      tickUpper = tickToCeilSpacing(tickLower + ticksForDropPercent(dropPercent), tickSpacing);
    }

    const sqrtLower = sqrtRatioAtTick(tickLower);
    const sqrtUpper = sqrtRatioAtTick(tickUpper);
    const liquidity = quoteIsToken0
      ? liquidityForAmount0(sqrtLower, sqrtUpper, depositAmount)
      : liquidityForAmount1(sqrtLower, sqrtUpper, depositAmount);

    const baseToken = quoteIsToken0 ? token1 : token0;
    const baseDecimals = await this.tokenDecimals(client, baseToken);
    const lowerPrice = this.formatPrice(sqrtLower, quoteIsToken0, baseDecimals, quoteToken.symbol === "USDG" || quoteToken.symbol === "USDC" ? 6 : 18);
    const upperPrice = this.formatPrice(sqrtUpper, quoteIsToken0, baseDecimals, quoteToken.symbol === "USDG" || quoteToken.symbol === "USDC" ? 6 : 18);
    const currentPrice = this.formatPrice(sqrtPriceX96, quoteIsToken0, baseDecimals, quoteToken.symbol === "USDG" || quoteToken.symbol === "USDC" ? 6 : 18);

    const baseSymbol = await this.tokenSymbol(client, baseToken);
    const pair = quoteIsToken0 ? `${baseSymbol}/${quoteToken.symbol}` : `${quoteToken.symbol}/${baseSymbol}`;

    return {
      protocol, chain, poolAddress: pool, pair, feeTier: fee,
      feeLabel: hooks !== zeroAddress ? `${(fee / 10_000).toFixed(2)}% dynamic` : `${(fee / 10_000).toFixed(2)}%`,
      quoteToken: quoteToken.address, quoteTokenSymbol: quoteToken.symbol,
      quoteIsToken0, currentTick, tickLower, tickUpper, liquidity, depositAmount,
      lowerPrice, upperPrice, currentPrice, dropPercent,
    };
  }

  async executeOpen(preview: OpenPositionPreview): Promise<{ hash: Hex | null }> {
    const amountMin = applySlippage(preview.depositAmount, this.config.removeLiquiditySlippageBps);
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + 600);

    if (preview.protocol === "v3") return this.executeV3(preview, deadline, amountMin);
    return this.executeV4(preview, deadline, amountMin);
  }

  private async executeV3(preview: OpenPositionPreview, deadline: bigint, amountMin: bigint): Promise<{ hash: Hex | null }> {
    const client = this.client(preview.chain);
    const { registry } = this.chains.get(preview.chain);
    const positionManager = registry.contracts.v3.positionManager;
    const executor = this.config.executorAddress;

    const [token0, token1] = await Promise.all([
      client.readContract({ address: preview.poolAddress, abi: v3PoolAbi, functionName: "token0" }) as Promise<Address>,
      client.readContract({ address: preview.poolAddress, abi: v3PoolAbi, functionName: "token1" }) as Promise<Address>,
    ]);

    const amount0Desired = preview.quoteIsToken0 ? preview.depositAmount : 0n;
    const amount1Desired = preview.quoteIsToken0 ? 0n : preview.depositAmount;
    const amount0Min = preview.quoteIsToken0 ? amountMin : 0n;
    const amount1Min = preview.quoteIsToken0 ? 0n : amountMin;

    await this.ensureApproval(client, preview.quoteToken, positionManager, preview.depositAmount, executor);

    const mintData = encodeFunctionData({
      abi: v3PositionManagerAbi, functionName: "mint",
      args: [{
        token0, token1, fee: preview.feeTier,
        tickLower: preview.tickLower, tickUpper: preview.tickUpper,
        amount0Desired, amount1Desired, amount0Min, amount1Min,
        recipient: executor, deadline,
      }],
    });
    const data = encodeFunctionData({ abi: v3PositionManagerAbi, functionName: "multicall", args: [[mintData]] });

    return this.broadcast(preview.chain, positionManager, data);
  }

  private async executeV4(preview: OpenPositionPreview, deadline: bigint, amountMin: bigint): Promise<{ hash: Hex | null }> {
    const client = this.client(preview.chain);
    const { registry } = this.chains.get(preview.chain);
    const positionManager = registry.contracts.v4.positionManager;
    const stateView = registry.contracts.v4.stateView;
    const executor = this.config.executorAddress;

    const poolId = preview.poolAddress;
    const bytes25 = poolId.slice(0, 2 + 25 * 2) as Hex;

    const [poolKeyResult, slot0] = await Promise.all([
      client.readContract({ address: positionManager, abi: v4PoolKeysAbi, functionName: "poolKeys", args: [bytes25] }),
      client.readContract({ address: stateView, abi: v4StateViewAbi, functionName: "getSlot0", args: [poolId] }),
    ]);
    const poolKey = poolKeyResult as unknown as { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

    await this.ensureApproval(client, preview.quoteToken, registry.contracts.v4.permit2, preview.depositAmount, executor);

    const amount0Min = preview.quoteIsToken0 ? amountMin : 0n;
    const amount1Min = preview.quoteIsToken0 ? 0n : amountMin;

    const mintParams = encodeV4MintParams(
      poolKey,
      preview.tickLower,
      preview.tickUpper,
      preview.liquidity,
      amount0Min,
      amount1Min,
    );

    const settleParams = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }],
      [poolKey.currency0, poolKey.currency1],
    );

    const actions = "0x0510";
    const unlockData = encodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes[]" }],
      [actions, [mintParams, settleParams]],
    );

    const data = encodeFunctionData({ abi: v4PositionManagerAbi, functionName: "modifyLiquidities", args: [unlockData, deadline] });
    return this.broadcast(preview.chain, positionManager, data);
  }

  private async broadcast(chain: ChainName, to: Address, data: Hex): Promise<{ hash: Hex | null }> {
    const client = this.client(chain);
    const executor = this.config.executorAddress;

    await client.call({ account: executor, to, data });

    if (this.config.dryRun) {
      log.info({ to, data: data.slice(0, 100) }, "dry-run open position simulated");
      return { hash: null };
    }

    const wallet = this.walletClient(chain);
    const hash = await wallet.sendTransaction({ to, data, account: this.account!, chain: this.chains.get(chain).registry.chain });
    log.info({ hash, to }, "open position transaction broadcast");
    return { hash };
  }

  private async ensureApproval(client: PublicClient, token: Address, spender: Address, amount: bigint, owner: Address): Promise<void> {
    if (token.toLowerCase() === zeroAddress) return;
    const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
    if (allowance >= amount) return;

    if (this.config.dryRun) {
      log.info({ token, spender, amount: amount.toString() }, "dry-run: approval needed");
      return;
    }

    const wallet = this.walletClient(this.config.chains[0] as ChainName);
    const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
    const hash = await wallet.sendTransaction({ to: token, data: approveData, account: this.account! });
    log.info({ hash, token, spender }, "approval submitted");
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
