import { privateKeyToAccount } from "viem/accounts";
import {
  createWalletClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";

import {
  erc20Abi,
  permit2Abi,
  v2RouterAbi,
  v3PositionManagerAbi,
  v3SwapRouterAbi,
  v4PositionManagerAbi,
  v4UniversalRouterAbi,
} from "../abi.js";
import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type { PositionRecord, TransactionPlan } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import type { Notifier } from "./notifier.js";
import type { PositionReader } from "./position-reader.js";
import type { RoutePlanner, SwapRoute } from "./route-planner.js";
import type { UniswapTradingApi } from "./uniswap-trading-api.js";

interface PendingSwap {
  token: Address;
  amount: string;
}

export class Executor {
  private readonly account;

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

  async execute(position: PositionRecord): Promise<void> {
    if (!position.quoteToken) throw new Error("Cannot execute a position without quote token");
    if (position.status === "closing") return this.resume(position);

    const value = await this.reader.read(position);
    const before = await this.tokenBalances(position.chainId, position.owner, position.token0, position.token1);
    await this.database.setPositionStatus(position.id, "closing", { exitStartedAt: new Date().toISOString() });
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
      const nonQuoteToken = position.quoteToken.toLowerCase() === position.token0.toLowerCase() ? position.token1 : position.token0;
      const nonQuoteAmount = nonQuoteToken.toLowerCase() === position.token0.toLowerCase()
        ? positiveDelta(before.token0, after.token0)
        : positiveDelta(before.token1, after.token1);
      await this.database.setPositionStatus(position.id, "closing", {
        pendingSwap: nonQuoteAmount > 0n ? { token: nonQuoteToken, amount: nonQuoteAmount.toString() } satisfies PendingSwap : null,
        closeTransactionHash: hash,
      });
      await this.resume({ ...position, status: "closing", metadata: { ...position.metadata, pendingSwap: nonQuoteAmount > 0n ? { token: nonQuoteToken, amount: nonQuoteAmount.toString() } : null } });
    } catch (error) {
      if (!closeConfirmed) {
        await this.database.recordExecution(position.id, "remove_liquidity", "failed", undefined, errorMessage(error));
        await this.database.setPositionStatus(position.id, "armed", { lastExecutionError: errorMessage(error) });
        await this.notifier.failure(position, errorMessage(error));
      }
      throw error;
    }
  }

  async resume(position: PositionRecord): Promise<void> {
    const pending = parsePendingSwap(position.metadata.pendingSwap);
    if (!pending || pending.amount === 0n) {
      await this.database.setPositionStatus(position.id, "settled", { pendingSwap: null });
      await this.notifier.settled(position);
      return;
    }
    const recoveredPosition = await this.recoverSettlementPosition(position);
    if (!recoveredPosition) return;
    position = recoveredPosition;
    const quoteToken = recoveredPosition.quoteToken;
    if (!quoteToken) return;

    const actualBalance = await this.tokenBalance(position.chainId, pending.token);
    if (actualBalance < pending.amount) {
      const reason = actualBalance === 0n
        ? "pending swap token is no longer held — position externally settled"
        : `pending swap balance (${actualBalance}) is below expected (${pending.amount}) — externally settled`;
      await this.database.setPositionStatus(position.id, "settled", { pendingSwap: null, reason });
      log.info({ positionId: position.id, positionKey: position.positionKey, reason }, "skipping post-close settlement");
      await this.notifier.settled(position);
      return;
    }

    try {
      const apiPlan = await this.tradingApiSwapPlan(position, pending.token, actualBalance, quoteToken);
      if (apiPlan === null) return;
      if (apiPlan) {
        const hash = await this.send(position, "swap_to_quote", apiPlan);
        if (!hash) {
          await this.database.setPositionStatus(position.id, "paused", { dryRunPlan: "swap_to_quote" });
          return;
        }
        await this.database.setPositionStatus(position.id, "settled", { pendingSwap: null, swapTransactionHash: hash });
        await this.notifier.settled(position);
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
      await this.notifier.settled(position);
    } catch (error) {
      await this.database.recordExecution(position.id, "swap_to_quote", "failed", undefined, errorMessage(error));
      await this.database.setPositionStatus(position.id, "closing", { lastExecutionError: errorMessage(error) });
      await this.notifier.failure(position, errorMessage(error));
      throw error;
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

  private async tradingApiSwapPlan(position: PositionRecord, tokenIn: Address, amountIn: bigint, tokenOut: Address): Promise<TransactionPlan | undefined | null> {
    if (!this.tradingApi) return undefined;
    let quote = await this.tradingApi.quote(position, tokenIn, amountIn, tokenOut);
    if (!quote) return undefined;

    const approval = await this.tradingApi.approval(position, tokenIn, amountIn);
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
    return plan;
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

  private async send(position: PositionRecord, stage: string, plan: TransactionPlan): Promise<Hex | null> {
    const { client, registry } = this.chains.getById(plan.chainId);
    await client.call({ account: position.owner, to: plan.to, data: plan.data, value: plan.value ?? 0n });
    await this.database.recordExecution(position.id, stage, "planned");
    if (this.config.dryRun) {
      log.info({ positionId: position.id, stage, to: plan.to, description: plan.description }, "dry-run transaction simulated");
      return null;
    }
    if (!this.account) throw new Error("No executor account is configured");
    const wallet = createWalletClient({ account: this.account, chain: registry.chain, transport: http(this.config.rpcHttp[registry.name]) });
    const hash = await wallet.sendTransaction({ to: plan.to, data: plan.data, value: plan.value ?? 0n });
    await this.database.recordExecution(position.id, stage, "submitted", hash);
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: this.config.confirmations });
    if (receipt.status !== "success") throw new Error(`${stage} transaction reverted: ${hash}`);
    await this.database.recordExecution(position.id, stage, "confirmed", hash);
    await this.notifier.transaction(position, stage, hash);
    return hash;
  }

  private async tokenBalances(chainId: number, owner: Address, token0: Address, token1: Address): Promise<{ token0: bigint; token1: bigint }> {
    const { client } = this.chains.getById(chainId);
    const [balance0, balance1] = await Promise.all([
      client.readContract({ address: token0, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      client.readContract({ address: token1, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    ]);
    return { token0: balance0, token1: balance1 };
  }

  private async tokenBalance(chainId: number, token: Address): Promise<bigint> {
    const { client } = this.chains.getById(chainId);
    return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [this.config.executorAddress] });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
