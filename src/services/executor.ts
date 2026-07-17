import { privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  isAddress,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import {
  erc20Abi,
  permit2Abi,
  v2RouterAbi,
  v3FactoryAbi,
  v3PoolAbi,
  v3PositionManagerAbi,
  v3SwapRouterAbi,
  v4PoolManagerModifyLiquidityEvent,
  v4PositionManagerAbi,
  v4StateViewAbi,
  v4UniversalRouterAbi,
} from "../abi.js";
import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type { ExitTrigger, PositionRecord, TransactionPlan } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import type { Notifier } from "./notifier.js";
import type { PositionReader } from "./position-reader.js";
import type { RoutePlanner, SwapRoute } from "./route-planner.js";
import type { UniswapTradingApi } from "./uniswap-trading-api.js";
import { hasPendingSettlement } from "./pending-settlement.js";
import { receiptTokenTransfers } from "./discovery.js";

interface PendingSwap {
  token: Address;
  amount: string;
}

export class Executor {
  private readonly account;
  private readonly executorClientCache = new Map<string, PublicClient>();

  constructor(
    private readonly database: Database,
    private readonly chains: ChainClients,
    private readonly reader: PositionReader,
    private readonly routes: RoutePlanner,
    private readonly notifier: Notifier,
    private readonly config: RuntimeConfig,
    private readonly tradingApi?: UniswapTradingApi,
  ) {
    this.account = config.executorPrivateKey ? privateKeyToAccount(config.executorPrivateKey) : undefined;
    if (this.account && this.account.address.toLowerCase() !== config.executorAddress.toLowerCase()) {
      throw new Error("EXECUTOR_ADDRESS does not match EXECUTOR_PRIVATE_KEY");
    }
    if (!config.dryRun && !this.account) {
      throw new Error("A private key is required when DRY_RUN=false");
    }
  }

  async execute(position: PositionRecord, trigger?: ExitTrigger): Promise<void> {
    if (!position.quoteToken) throw new Error("Cannot execute a position without quote token");
    const quoteToken = position.quoteToken;
    if (position.status === "closing") return this.resume(position);
    if (position.protocol === "v4" && !(await this.canCloseV4(position))) return;
    const retryMetadata = position.metadata as Record<string, unknown>;

    const value = await this.reader.read(position);
    const before = await this.tokenBalances(position.chainId, position.owner, position.token0, position.token1);
    const quoteIsToken0 = value.token0.token.toLowerCase() === position.quoteToken.toLowerCase();
    const quotePrincipal = quoteIsToken0 ? value.token0.amount : value.token1.amount;
    const quoteFee = quoteIsToken0 ? value.unclaimedFees0 : value.unclaimedFees1;
    const settlementQuoteFromClose = quotePrincipal + quoteFee;
    const preCloseBalance = await this.assetBalance(position.chainId, this.config.executorAddress, position.quoteToken);
    const closingMetadata = {
      ...position.metadata,
      exitStartedAt: new Date().toISOString(),
      exitRetry: null,
      exitTrigger: trigger ?? "manual",
      settlementQuoteFromClose: settlementQuoteFromClose.toString(),
      preCloseQuoteBalance: preCloseBalance.toString(),
      ...(!this.config.pnlIncludeGas && quoteToken.toLowerCase() === zeroAddress
        ? { settlementGasWei: "0" }
        : {}),
    };
    position = { ...position, status: "closing", metadata: closingMetadata };
    await this.database.setPositionStatus(position.id, "closing", closingMetadata);
    let closeConfirmed = false;

    try {
      if (position.protocol === "v2") {
        if (!position.poolAddress) throw new Error("V2 position has no pair address");
        const { registry } = this.chains.getById(position.chainId);
        const approvalChanged = await this.ensureExactApproval(position, position.poolAddress, registry.contracts.v2.router, value.liquidity, "approve_lp");
        if (this.config.dryRun && approvalChanged) {
          await this.database.setPositionStatus(position.id, "paused", { dryRunPlan: "approve_lp then remove_liquidity" });
          return;
        }
      }

      const closePlan = this.closePlan(position, value);
      const hash = await this.send(position, "remove_liquidity", closePlan);
      if (!hash) {
        await this.database.setPositionStatus(position.id, "paused", { dryRunPlan: closePlan.description });
        return;
      }
      closeConfirmed = true;

      const after = await this.tokenBalances(position.chainId, position.owner, position.token0, position.token1);
      const nonQuoteToken = quoteToken.toLowerCase() === position.token0.toLowerCase() ? position.token1 : position.token0;
      const nonQuoteAmount = nonQuoteToken.toLowerCase() === position.token0.toLowerCase()
        ? positiveDelta(before.token0, after.token0)
        : positiveDelta(before.token1, after.token1);
      await this.database.setPositionStatus(position.id, "closing", {
        pendingSwap: nonQuoteAmount > 0n ? { token: nonQuoteToken, amount: nonQuoteAmount.toString() } satisfies PendingSwap : null,
        closeTransactionHash: hash,
      });
      await this.resume({
        ...position,
        metadata: {
          ...position.metadata,
          pendingSwap: nonQuoteAmount > 0n ? { token: nonQuoteToken, amount: nonQuoteAmount.toString() } : null,
          closeTransactionHash: hash,
        },
      });
    } catch (error) {
      if (!closeConfirmed) {
        const message = errorMessage(error);
        await this.database.recordExecution(position.id, "remove_liquidity", "failed", undefined, message);
        await this.database.setPositionStatus(position.id, "armed", {
          lastExecutionError: message,
          exitRetry: nextExitRetry(retryMetadata, trigger),
        });
        await this.notifier.failure(position, message);
      }
      throw error;
    }
  }

  async resume(position: PositionRecord): Promise<void> {
    const pending = parsePendingSwap(position.metadata.pendingSwap);
    if (!pending || pending.amount === 0n) {
      await this.database.setPositionStatus(position.id, "settled", { pendingSwap: null });
      await this.saveSettlementBalance(position);
      await this.notifier.settled(position);
      this.finalizeCloseHistory(position);
      return;
    }
    const recoveredPosition = await this.recoverSettlementPosition(position);
    if (!recoveredPosition) return;
    position = recoveredPosition;
    const quoteToken = recoveredPosition.quoteToken;
    if (!quoteToken) return;

    const actualBalance = await this.tokenBalance(position.chainId, pending.token);
    if (actualBalance < pending.amount) {
      const submittedSwap = await this.database.getSubmittedSwapAttempt(position.id);
      if (submittedSwap) {
        try {
          const { client } = this.chains.getById(position.chainId);
          const receipt = await client.getTransactionReceipt({ hash: submittedSwap as Hex });
          if (receipt && receipt.status === "success") {
            await this.database.recordExecution(position.id, "swap_to_quote", "confirmed", submittedSwap);
            log.info({ positionId: position.id, positionKey: position.positionKey, swapHash: submittedSwap }, "reconciled submitted swap receipt after restart");
            await this.database.setPositionStatus(position.id, "settled", { pendingSwap: null });
            await this.saveSettlementBalance(position);
            await this.notifier.settled(position);
            this.finalizeCloseHistory(position);
            return;
          }
        } catch {
          // Receipt not yet available — keep position closing and retry later.
        }
        log.info({ positionId: position.id, positionKey: position.positionKey, swapHash: submittedSwap }, "swap was broadcast but receipt not yet confirmed; retrying");
        return;
      }

      const reason = actualBalance === 0n
        ? "pending swap token is no longer held — position externally settled"
        : `pending swap balance (${actualBalance}) is below expected (${pending.amount}) — externally settled`;
      await this.database.setPositionStatus(position.id, "settled", { pendingSwap: null, reason });
      log.info({ positionId: position.id, positionKey: position.positionKey, reason }, "skipping post-close settlement");
      await this.notifier.settled(position);
      this.finalizeCloseHistory(position);
      return;
    }

    try {
      const apiResult = await this.tradingApiSwapPlan(position, pending.token, actualBalance, quoteToken);
      if (apiResult === null) return;
      if (apiResult) {
        const { plan, expectedOut } = apiResult;
        const hash = await this.send(position, "swap_to_quote", plan);
        if (!hash) {
          await this.database.setPositionStatus(position.id, "paused", { dryRunPlan: "swap_to_quote" });
          return;
        }
        await this.database.setPositionStatus(position.id, "settled", { pendingSwap: null, swapTransactionHash: hash });
        await this.saveSettlementBalance(position, expectedOut);
        await this.notifier.settled(position);
        this.finalizeCloseHistory(position);
        return;
      }

      const route = await this.routes.quoteDirect(position, pending.token, actualBalance, quoteToken);
      if (!route) throw new Error("No safe route remains for post-close settlement");
      log.info({ positionKey: position.positionKey, protocol: route.protocol, path: route.path, expectedOut: route.expectedOut.toString(), minimumOut: route.minimumOut.toString() }, "local swap route selected");
      if (route.protocol === "v4") {
        const { registry } = this.chains.getById(position.chainId);
        const tokenApprovalChanged = await this.ensureExactApproval(position, pending.token, registry.contracts.v4.permit2, actualBalance, "approve_permit2");
        if (this.config.dryRun && tokenApprovalChanged) {
          await this.database.setPositionStatus(position.id, "paused", { dryRunPlan: "approve_permit2 then permit2_approve then swap_to_quote" });
          return;
        }
        const permit2ApprovalChanged = await this.ensurePermit2Approval(position, pending.token, route.router, actualBalance);
        if (this.config.dryRun && permit2ApprovalChanged) {
          await this.database.setPositionStatus(position.id, "paused", { dryRunPlan: "permit2_approve then swap_to_quote" });
          return;
        }
      } else {
        const approvalChanged = await this.ensureExactApproval(position, pending.token, route.router, actualBalance, "approve_swap");
        if (this.config.dryRun && approvalChanged) {
          await this.database.setPositionStatus(position.id, "paused", { dryRunPlan: "approve_swap then swap_to_quote" });
          return;
        }
      }
      const hash = await this.send(position, "swap_to_quote", this.swapPlan(position, route));
      if (!hash) {
        await this.database.setPositionStatus(position.id, "paused", { dryRunPlan: "swap_to_quote" });
        return;
      }
      await this.database.setPositionStatus(position.id, "settled", { pendingSwap: null, swapTransactionHash: hash });
      await this.saveSettlementBalance(position, route.expectedOut);
      await this.notifier.settled(position);
      this.finalizeCloseHistory(position);
    } catch (error) {
      await this.database.recordExecution(position.id, "swap_to_quote", "failed", undefined, errorMessage(error));
      await this.database.setPositionStatus(position.id, "closing", { lastExecutionError: errorMessage(error) });
      await this.notifier.failure(position, errorMessage(error));
      throw error;
    }
  }

  private async saveSettlementBalance(position: PositionRecord, swapExpectedOut = 0n): Promise<void> {
    if (!position.quoteToken) return;
    try {
      // The in-memory object predates the closing status update. Read the durable
      // metadata so direct close proceeds and recorded gas cannot be lost on resume.
      const meta = (await this.database.getPositionMetadata(position.id)) ?? position.metadata as Record<string, unknown>;
      const preCloseStr = typeof meta.preCloseQuoteBalance === "string" ? meta.preCloseQuoteBalance : undefined;
      let totalReceived: bigint;
      if (preCloseStr) {
        const actualNow = await this.assetBalance(position.chainId, this.config.executorAddress, position.quoteToken);
        const preClose = BigInt(preCloseStr);
        const isNative = position.quoteToken.toLowerCase() === zeroAddress;
        totalReceived = isNative ? (actualNow + (preClose > actualNow ? preClose - actualNow : 0n)) - preClose : actualNow - preClose;
        if (totalReceived < 0n) totalReceived = 0n;
        if (isNative && !this.config.pnlIncludeGas) totalReceived += settlementGasWei(meta);
      } else {
        const fromCloseStr = typeof meta.settlementQuoteFromClose === "string" ? meta.settlementQuoteFromClose : "0";
        totalReceived = BigInt(fromCloseStr) + swapExpectedOut;
      }
      const qtLower = position.quoteToken.toLowerCase();
      const { registry } = this.chains.getById(position.chainId);
      const weth = this.config.quoteTokens[registry.name]?.find(q => q.symbol === "WETH" || q.symbol === "ETH");
      const isEth = qtLower === zeroAddress || (weth ? qtLower === weth.address.toLowerCase() : false);
      const settlementUsd = isEth ? await this.computeEthUsd(position.chainId, totalReceived) : totalReceived;
      await this.database.setPositionStatus(position.id, "settled", {
        totalReceived: totalReceived.toString(),
        settlementUsd: settlementUsd.toString(),
      });
    } catch {
      // Balance calculation is for notification only — do not block settlement.
    }
  }

  private async computeEthUsd(chainId: number, ethWei: bigint): Promise<bigint> {
    try {
      const { registry } = this.chains.getById(chainId);
      const stable = this.config.quoteTokens[registry.name]?.[0];
      if (!stable) return 0n;
      const weth = this.config.quoteTokens[registry.name]?.find(q => q.symbol === "WETH" || q.symbol === "ETH");
      const tokenIn = weth ? weth.address : zeroAddress;
      const route = await this.routes.quoteDirect(
        { chainId } as PositionRecord,
        tokenIn,
        10n ** 18n,
        stable.address,
      );
      if (!route) return 0n;
      return (ethWei * route.expectedOut) / (10n ** 18n);
    } catch {
      return 0n;
    }
  }

  private async canCloseV4(position: PositionRecord): Promise<boolean> {
    if (hasPendingSettlement(position.status, position.metadata)) {
      log.info({ positionId: position.id, positionKey: position.positionKey }, "V4 NFT state is irrelevant while settlement remains pending");
      return false;
    }
    const { client, registry } = this.chains.getById(position.chainId);
    try {
      const owner = await client.readContract({
        address: registry.contracts.v4.positionManager,
        abi: v4PositionManagerAbi,
        functionName: "ownerOf",
        args: [BigInt(position.positionKey)],
      });
      if (owner.toLowerCase() !== position.owner.toLowerCase()) {
        throw new Error("V4 position owner no longer matches executor");
      }
      const liquidity = await client.readContract({
        address: registry.contracts.v4.positionManager,
        abi: v4PositionManagerAbi,
        functionName: "getPositionLiquidity",
        args: [BigInt(position.positionKey)],
      });
      if (liquidity > 0n) return true;
      const reviewed = await this.database.markNeedsReviewIfNoPendingSettlement(position.id, { reason: "on_chain_liquidity_zero_unverified" });
      if (!reviewed) {
        log.info({ positionId: position.id, positionKey: position.positionKey }, "V4 liquidity is gone but settlement remains pending");
        return false;
      }
      log.warn({ positionId: position.id, positionKey: position.positionKey }, "V4 position has zero liquidity without a verified settlement");
      return false;
    } catch (error) {
      const message = errorMessage(error);
      if (!message.includes("NOT_MINTED")) throw error;
      const reviewed = await this.database.markNeedsReviewIfNoPendingSettlement(position.id, { reason: "nft_burned_unverified" });
      if (!reviewed) {
        log.info({ positionId: position.id, positionKey: position.positionKey }, "V4 NFT is burned but settlement remains pending");
        return false;
      }
      log.warn({ positionId: position.id, positionKey: position.positionKey }, "V4 NFT is burned without a verified settlement");
      return false;
    }
  }

  private async recoverSettlementPosition(position: PositionRecord): Promise<PositionRecord | null> {
    const metadata = position.metadata as Record<string, unknown>;
    const currency0 = addressFromMetadata(metadata.currency0);
    const currency1 = addressFromMetadata(metadata.currency1);
    const { registry } = this.chains.getById(position.chainId);
    const quoteToken = position.quoteToken ?? (currency0 && currency1
      ? this.config.quoteTokens[registry.name].find(({ address }) => address.toLowerCase() === currency0.toLowerCase() || address.toLowerCase() === currency1.toLowerCase())?.address
      : undefined);

    if (!quoteToken) {
      const reason = "Cannot settle pending swap: quote token cannot be recovered from position metadata";
      await this.database.setPositionStatus(position.id, "needs_review", { reason, settlementRetryDisabled: true });
      log.error({ positionId: position.id, positionKey: position.positionKey, reason }, "pending settlement disabled");
      await this.notifier.failure(position, reason);
      return null;
    }

    if (!currency0 || !currency1) return { ...position, quoteToken };

    if (position.token0.toLowerCase() !== currency0.toLowerCase() || position.token1.toLowerCase() !== currency1.toLowerCase() || position.quoteToken?.toLowerCase() !== quoteToken.toLowerCase()) {
      await this.database.repairPositionAssets(position.id, currency0, currency1, quoteToken);
      log.info({ positionId: position.id, positionKey: position.positionKey, token0: currency0, token1: currency1, quoteToken }, "recovered pending settlement assets from V4 metadata");
    }
    return { ...position, token0: currency0, token1: currency1, quoteToken };
  }

  private async tradingApiSwapPlan(position: PositionRecord, tokenIn: Address, amountIn: bigint, tokenOut: Address): Promise<{ plan: TransactionPlan; expectedOut: bigint } | undefined | null> {
    if (!this.tradingApi) return undefined;
    let quote = await this.tradingApi.quote(position, tokenIn, amountIn, tokenOut);
    if (!quote) return undefined;

    const approval = tokenIn.toLowerCase() === zeroAddress
      ? null
      : await this.tradingApi.approval(position, tokenIn, amountIn);
    if (approval) {
      const spender = approvalSpender(approval, tokenIn, amountIn);
      const approvalChanged = await this.ensureExactApproval(position, tokenIn, spender, amountIn, "approve_swap");
      if (this.config.dryRun && approvalChanged) {
        await this.database.setPositionStatus(position.id, "paused", { dryRunPlan: "approve_swap then swap_to_quote" });
        return null;
      }
      if (approvalChanged) {
        quote = await this.tradingApi.quote(position, tokenIn, amountIn, tokenOut);
        if (!quote) return undefined;
      }
    }

    const plan = await this.tradingApi.createSwap(position, quote);
    log.info({ positionKey: position.positionKey, routing: quote.routing, expectedOut: quote.expectedOut.toString(), minimumOut: quote.minimumOut.toString(), to: plan.to }, "Trading API swap selected");
    return { plan, expectedOut: quote.expectedOut };
  }

  private closePlan(position: PositionRecord, value: Awaited<ReturnType<PositionReader["read"]>>): TransactionPlan {
    const { registry } = this.chains.getById(position.chainId);
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + 300);
    if (position.protocol === "v2") {
      return {
        chainId: position.chainId,
        to: registry.contracts.v2.router,
        data: encodeFunctionData({
          abi: v2RouterAbi,
          functionName: "removeLiquidity",
          args: [position.token0, position.token1, value.liquidity, value.minAmount0, value.minAmount1, position.owner, deadline],
        }),
        description: "remove V2 liquidity",
      };
    }
    if (position.protocol === "v3") {
      const tokenId = BigInt(position.positionKey);
      const decrease = encodeFunctionData({
        abi: v3PositionManagerAbi,
        functionName: "decreaseLiquidity",
        args: [{ tokenId, liquidity: value.liquidity, amount0Min: value.minAmount0, amount1Min: value.minAmount1, deadline }],
      });
      const collect = encodeFunctionData({
        abi: v3PositionManagerAbi,
        functionName: "collect",
        args: [{ tokenId, recipient: position.owner, amount0Max: (1n << 128n) - 1n, amount1Max: (1n << 128n) - 1n }],
      });
      const burn = encodeFunctionData({ abi: v3PositionManagerAbi, functionName: "burn", args: [tokenId] });
      return {
        chainId: position.chainId,
        to: registry.contracts.v3.positionManager,
        data: encodeFunctionData({ abi: v3PositionManagerAbi, functionName: "multicall", args: [[decrease, collect, burn]] }),
        description: "remove V3 liquidity and collect fees",
      };
    }
    if (!value.v4PoolKey) throw new Error("V4 pool key is unavailable");
    const burnParams = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
      [BigInt(position.positionKey), value.minAmount0, value.minAmount1, "0x"],
    );
    const takePairParams = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }],
      [value.v4PoolKey.currency0, value.v4PoolKey.currency1, position.owner],
    );
    const unlockData = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], ["0x0311", [burnParams, takePairParams]]);
    return {
      chainId: position.chainId,
      to: registry.contracts.v4.positionManager,
      data: encodeFunctionData({ abi: v4PositionManagerAbi, functionName: "modifyLiquidities", args: [unlockData, deadline] }),
      description: "burn V4 position and take pair",
    };
  }

  private swapPlan(position: PositionRecord, route: SwapRoute): TransactionPlan {
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + 300);
    if (route.protocol === "v2") {
      return {
        chainId: position.chainId,
        to: route.router,
        data: encodeFunctionData({
          abi: v2RouterAbi,
          functionName: "swapExactTokensForTokens",
          args: [route.amountIn, route.minimumOut, route.path, position.owner, deadline],
        }),
        description: "swap V2 route to quote token",
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
        chainId: position.chainId,
        to: route.router,
        data: encodeFunctionData({ abi: v4UniversalRouterAbi, functionName: "execute", args: ["0x10" as Hex, [v4Input], deadline] }),
        description: "swap V4 route to quote token",
      };
    }
    if (!route.encodedPath) throw new Error("V3 route is missing an encoded path");
    return {
      chainId: position.chainId,
      to: route.router,
      data: encodeFunctionData({
        abi: v3SwapRouterAbi,
        functionName: "exactInput",
        args: [{
          path: route.encodedPath,
          recipient: position.owner,
          deadline,
          amountIn: route.amountIn,
          amountOutMinimum: route.minimumOut,
        }],
      }),
      description: "swap V3 route to quote token",
    };
  }

  private async ensureExactApproval(position: PositionRecord, token: Address, spender: Address, amount: bigint, stage: string): Promise<boolean> {
    if (token.toLowerCase() === zeroAddress) throw new Error("Native ETH does not require ERC-20 approval");
    const { client } = this.chains.getById(position.chainId);
    const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [position.owner, spender] });
    if (allowance === amount) return false;
    if (allowance > 0n) {
      await this.send(position, `${stage}_reset`, {
        chainId: position.chainId,
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 0n] }),
        description: `reset ${stage} allowance`,
      });
      if (this.config.dryRun) return true;
    }
    await this.send(position, stage, {
      chainId: position.chainId,
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
      description: `set exact ${stage} allowance`,
    });
    return true;
  }

  private async ensurePermit2Approval(position: PositionRecord, token: Address, spender: Address, amount: bigint): Promise<boolean> {
    if (token.toLowerCase() === zeroAddress) throw new Error("Native ETH does not require Permit2 approval");
    if (amount > (1n << 160n) - 1n) throw new Error("Permit2 approval amount overflows uint160");
    const { client, registry } = this.chains.getById(position.chainId);
    const allowance = await client.readContract({
      address: registry.contracts.v4.permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [position.owner, token, spender],
    });
    const expiration = Math.floor(Date.now() / 1_000) + 300;
    if (allowance[0] === amount && Number(allowance[1]) >= expiration) return false;
    await this.send(position, "permit2_approve", {
      chainId: position.chainId,
      to: registry.contracts.v4.permit2,
      data: encodeFunctionData({
        abi: permit2Abi,
        functionName: "approve",
        args: [token, spender, amount, expiration],
      }),
      description: "set exact Permit2 swap allowance",
    });
    return true;
  }

  private executorClient(chainId: number): PublicClient {
    const { client, registry } = this.chains.getById(chainId);
    const name = registry.name;
    const existing = this.executorClientCache.get(name);
    if (existing) return existing;
    const alchemyUrl = this.config.alchemyHttp[name];
    if (!alchemyUrl) {
      this.executorClientCache.set(name, client);
      return client;
    }
    const alchemyClient = createPublicClient({
      chain: registry.chain,
      transport: http(alchemyUrl, { retryCount: 3, timeout: 20_000 }),
    });
    this.executorClientCache.set(name, alchemyClient);
    return alchemyClient;
  }

  private async send(position: PositionRecord, stage: string, plan: TransactionPlan): Promise<Hex | null> {
    const { registry } = this.chains.getById(plan.chainId);
    const client = this.executorClient(plan.chainId);
    await client.call({ account: position.owner, to: plan.to, data: plan.data, value: plan.value ?? 0n });
    await this.database.recordExecution(position.id, stage, "planned");
    if (this.config.dryRun) {
      log.info({ positionId: position.id, stage, to: plan.to, description: plan.description }, "dry-run transaction simulated");
      return null;
    }
    if (!this.account) throw new Error("No executor account is configured");
    const alchemyUrl = this.config.alchemyHttp[registry.name];
    const transport = alchemyUrl ? http(alchemyUrl) : http(this.config.rpcHttp[registry.name]);
    const wallet = createWalletClient({ account: this.account, chain: registry.chain, transport });
    const hash = await wallet.sendTransaction({ to: plan.to, data: plan.data, value: plan.value ?? 0n });
    await this.database.recordExecution(position.id, stage, "submitted", hash);
    const receipt = await waitForReceipt(client, hash, this.config.confirmations);
    if (receipt.status !== "success") throw new Error(`${stage} transaction reverted: ${hash}`);
    await this.database.recordExecution(position.id, stage, "confirmed", hash);
    await this.recordNativeSettlementGas(position, receipt.gasUsed * receipt.effectiveGasPrice);
    await this.notifier.transaction(position, stage, hash);
    return hash;
  }

  private async recordNativeSettlementGas(position: PositionRecord, gasWei: bigint): Promise<void> {
    if (this.config.pnlIncludeGas || position.quoteToken?.toLowerCase() !== zeroAddress || gasWei === 0n) return;
    const metadata = position.metadata as Record<string, unknown>;
    const totalGasWei = settlementGasWei(metadata) + gasWei;
    metadata.settlementGasWei = totalGasWei.toString();
    await this.database.setPositionStatus(position.id, "closing", { settlementGasWei: totalGasWei.toString() });
  }

  private async tokenBalances(chainId: number, owner: Address, token0: Address, token1: Address): Promise<{ token0: bigint; token1: bigint }> {
    const [balance0, balance1] = await Promise.all([
      this.assetBalance(chainId, owner, token0),
      this.assetBalance(chainId, owner, token1),
    ]);
    return { token0: balance0, token1: balance1 };
  }

  private async tokenBalance(chainId: number, token: Address): Promise<bigint> {
    return this.assetBalance(chainId, this.config.executorAddress, token);
  }

  private async assetBalance(chainId: number, owner: Address, token: Address): Promise<bigint> {
    const { client } = this.chains.getById(chainId);
    if (token.toLowerCase() === zeroAddress) return client.getBalance({ address: owner });
    return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  }

  private closeTrigger(position: PositionRecord): string {
    const meta = position.metadata as Record<string, unknown>;
    if (typeof meta.exitTrigger === "string") return meta.exitTrigger;
    if (meta.exitRetry) {
      const retry = meta.exitRetry as Record<string, unknown>;
      if (typeof retry.reason === "string") return retry.reason;
    }
    return "settled";
  }

  private finalizeCloseHistory(position: PositionRecord): void {
    void this.database.finalizeCloseHistory(position.id, this.closeTrigger(position)).catch((error) => {
      log.error({ err: error, positionId: position.id, positionKey: position.positionKey }, "close-history finalization failed");
    });
  }

  async backfillStaleCloseHistoryUsd(): Promise<void> {
    const stale = await this.database.listStaleCloseHistoryUsd();
    if (stale.length === 0) return;
    log.info({ count: stale.length }, "backfilling stale close-history USD values");
    for (const item of stale) {
      try {
        const hashStr = (item.swapTransactionHash || item.closeTransactionHash) as `0x${string}` | null;
        if (!hashStr) continue;
        const swapHash = hashStr as `0x${string}`;
        const { client, registry } = this.chains.getById(item.chainId);
        const receipt = await client.getTransactionReceipt({ hash: swapHash });
        if (!receipt) continue;
        const blockNum = receipt.blockNumber;
        const block = await client.getBlock({ blockNumber: blockNum });
        const wethAddr = (item.isNativeQuote
          ? (this.config.quoteTokens[registry.name]?.find(q => q.symbol === "WETH" || q.symbol === "ETH")?.address ?? item.quoteToken)
          : item.quoteToken) as Address;
        const stableAddr = (this.config.quoteTokens[registry.name]?.[0]?.address) as Address;
        if (!stableAddr) continue;
        let pool: Address | null = null;
        for (const fee of [100, 500, 3000, 10000] as const) {
          pool = await client.readContract({
            address: registry.contracts.v3.factory,
            abi: v3FactoryAbi,
            functionName: "getPool",
            args: [wethAddr, stableAddr, fee],
          }) as Address;
          if (pool && pool !== zeroAddress) break;
        }
        if (!pool || pool === zeroAddress) continue;
        const [sqrtPriceX96] = await client.readContract({
          address: pool,
          abi: v3PoolAbi,
          functionName: "slot0",
          blockNumber: blockNum,
        }) as readonly [bigint, ...unknown[]];
        // usdPerEth in micro-USDG (6 dec): (sqrtPriceX96^2 / 2^192) * 10^18_weth / 10^6_usdg * 10^6_micro
        // simplifies to: sqrtPriceX96^2 * 10^18 / 2^192
        const usdPerEthMicro = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / (1n << 192n);
        const usdValue = (BigInt(item.finalPnlQuote) * usdPerEthMicro) / (10n ** 18n);
        await this.database.updateCloseHistoryUsd(item.id, usdValue, new Date(Number(block.timestamp) * 1_000));
        log.info({ positionKey: item.positionKey, usd: usdValue.toString(), usdPerEthMicro: usdPerEthMicro.toString() }, "backfilled close-history USD");
      } catch (err) {
        log.warn({ err, positionKey: item.positionKey }, "failed to backfill close-history USD");
      }
    }
  }

  async autoSettleZeroLiquidityV4(name: string, position: PositionRecord): Promise<boolean> {
    if (position.protocol !== "v4" || !position.quoteToken) return false;
    const metadata = position.metadata as Record<string, unknown>;
    const salt = metadata.salt as Hex | undefined;
    if (!salt) return false;
    const { client, registry } = this.chains.getById(position.chainId);
    try {
      const events = await client.getLogs({
        address: registry.contracts.v4.poolManager,
        event: v4PoolManagerModifyLiquidityEvent,
        args: { sender: registry.contracts.v4.positionManager },
        fromBlock: position.openedAtBlock ?? 0n,
        toBlock: "latest" as never,
      });
      let withdrawalEvent: (typeof events)[number] | null = null;
      for (const event of events) {
        const args = (event as unknown as { args: { salt?: Hex; liquidityDelta?: bigint } }).args;
        if (args.salt?.toLowerCase() === salt.toLowerCase() && (args.liquidityDelta ?? 0n) < 0n) {
          withdrawalEvent = event;
          break;
        }
      }
      if (!withdrawalEvent || !withdrawalEvent.transactionHash || !withdrawalEvent.blockNumber) return false;
      const receipt = await client.getTransactionReceipt({ hash: withdrawalEvent.transactionHash });
      if (!receipt) return false;
      const amounts = receiptTokenTransfers(receipt.logs, position.token0, position.token1, position.owner, registry.contracts.v4.poolManager);
      const quoteValue = await this.quoteV4AmountsAtBlock(position, amounts.outOfPool0, amounts.outOfPool1, withdrawalEvent.blockNumber);
      if (quoteValue > 0n) {
        await this.database.addCashflow(position.id, withdrawalEvent.blockNumber, withdrawalEvent.transactionHash, "withdrawal", quoteValue, {
          protocol: "v4", token0Amount: amounts.outOfPool0.toString(), token1Amount: amounts.outOfPool1.toString(), source: "auto_settle",
        });
      }
      await this.database.setPositionStatus(position.id, "settled", {
        totalReceived: quoteValue.toString(),
        closeTransactionHash: withdrawalEvent.transactionHash,
        reason: "auto_settle_zero_liquidity",
      });
      await this.database.recordExecution(position.id, "remove_liquidity", "confirmed", withdrawalEvent.transactionHash);
      this.finalizeCloseHistory({ ...position, status: "settled", metadata: { ...position.metadata, totalReceived: quoteValue.toString() } });
      log.info({ positionId: position.id, positionKey: position.positionKey, quoteValue: quoteValue.toString() }, "auto-settled zero-liquidity V4 position");
      await this.notifier.settled(position);
      return true;
    } catch (error) {
      log.warn({ err: error, positionId: position.id }, "auto-settle zero liquidity failed");
      return false;
    }
  }

  private async quoteV4AmountsAtBlock(position: PositionRecord, amount0: bigint, amount1: bigint, blockNumber: bigint): Promise<bigint> {
    if (!position.quoteToken) return 0n;
    const { client, registry } = this.chains.getById(position.chainId);
    const metadata = position.metadata as Record<string, unknown>;
    const currency0 = metadata.currency0 as Address;
    const currency1 = metadata.currency1 as Address;
    const fee = metadata.fee as number;
    const tickSpacing = metadata.tickSpacing as number;
    const hooks = metadata.hooks as Address;
    if (!currency0 || !currency1 || fee === undefined || tickSpacing === undefined || !hooks) return 0n;
    const poolId = keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0, currency1, fee, tickSpacing, hooks],
    ));
    const slot0 = await client.readContract({
      address: registry.contracts.v4.stateView,
      abi: v4StateViewAbi,
      functionName: "getSlot0",
      args: [poolId],
      blockNumber,
    });
    const square = slot0[0] * slot0[0];
    const q192 = 1n << 192n;
    return position.quoteToken.toLowerCase() === position.token0.toLowerCase()
      ? amount0 + ((amount1 * q192) / square)
      : amount1 + ((amount0 * square) / q192);
  }
}

function parsePendingSwap(value: unknown): { token: Address; amount: bigint } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PendingSwap>;
  if (typeof candidate.token !== "string" || typeof candidate.amount !== "string" || !/^0x[\da-fA-F]{40}$/.test(candidate.token) || !/^\d+$/.test(candidate.amount)) {
    return null;
  }
  return { token: candidate.token as Address, amount: BigInt(candidate.amount) };
}

function positiveDelta(before: bigint, after: bigint): bigint {
  return after > before ? after - before : 0n;
}

function settlementGasWei(metadata: Record<string, unknown>): bigint {
  const value = metadata.settlementGasWei;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return 0n;
  return BigInt(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForReceipt(client: PublicClient, hash: Hex, confirmations: number) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await client.waitForTransactionReceipt({ hash, confirmations });
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw lastError;
}

export function nextExitRetry(metadata: Record<string, unknown>, trigger?: ExitTrigger): Record<string, unknown> {
  const existing = metadata.exitRetry;
  const previousAttempts = existing && typeof existing === "object" && !Array.isArray(existing)
    && typeof (existing as Record<string, unknown>).attempts === "number"
    ? (existing as Record<string, unknown>).attempts as number
    : 0;
  const attempts = previousAttempts + 1;
  const delaySeconds = Math.min(20, 5 * (2 ** Math.min(attempts - 1, 2)));
  return {
    reason: trigger ?? "manual",
    attempts,
    lastFailedAt: new Date().toISOString(),
    nextAttemptAt: new Date(Date.now() + delaySeconds * 1_000).toISOString(),
  };
}

function approvalSpender(approval: { to: Address; data: Hex }, token: Address, amount: bigint): Address {
  if (approval.to.toLowerCase() !== token.toLowerCase()) throw new Error("Trading API approval targets an unexpected contract");
  const decoded = decodeFunctionData({ abi: erc20Abi, data: approval.data });
  if (decoded.functionName !== "approve" || !decoded.args || decoded.args[1] < amount) {
    throw new Error("Trading API approval is not a standard approval");
  }
  // The API may request max approval; execute the same spender with this bot's exact amount policy.
  if (amount === 0n) throw new Error("Cannot approve a zero swap amount");
  return decoded.args[0] as Address;
}

function addressFromMetadata(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value) ? value : null;
}
