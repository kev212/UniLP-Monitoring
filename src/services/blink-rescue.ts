import {
  createWalletClient,
  encodeFunctionData,
  keccak256,
  parseEventLogs,
  parseTransaction,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";

import { erc20Abi, erc20TransferEvent, v3CollectEvent, v3PositionManagerAbi, wethAbi } from "../abi.js";
import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type { PositionRecord, TokenRescueJob, TokenRescuePendingTransaction } from "../types.js";
import type { ChainClient, ChainClients } from "./chain-client.js";
import { RoutePlanner } from "./route-planner.js";
import { buildSwapPlan } from "./swap-builder.js";

export const BLINK_RESCUE_JOB_ID = "robinhood-blink-v3-2026-08";
export const BLINK_ADDRESS = "0x7b630f080807df83908b4ade46ba6396ee66b098" as Address;
export const ROBINHOOD_WETH_ADDRESS = "0x0bd7d308f8e1639fab988df18a8011f41eacad73" as Address;
export const BLINK_TOKEN_IDS = [633633n, 633634n, 633635n, 633636n, 633647n] as const;
export const BLINK_BUY_LOCK_END_MS = 1_786_324_374_000;
export const BLINK_RESCUE_SLIPPAGE_BPS = 200;

const MAX_UINT128 = (1n << 128n) - 1n;
const RECEIPT_TIMEOUT_MS = 120_000;

type TickResult = "waiting" | "progressed" | "complete";

export class BlinkRescueWorker {
  private readonly account: PrivateKeyAccount;
  private readonly routes: RoutePlanner;

  constructor(
    private readonly database: Database,
    private readonly chains: ChainClients,
    private readonly config: RuntimeConfig,
    routes?: RoutePlanner,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.routes = routes ?? new RoutePlanner(chains, BLINK_RESCUE_SLIPPAGE_BPS, config.quoteTokens);
    if (!config.executorPrivateKey || config.dryRun) throw new Error("BLINK rescue requires a live executor private key");
    this.account = privateKeyToAccount(config.executorPrivateKey);
    if (this.account.address.toLowerCase() !== config.executorAddress.toLowerCase()) {
      throw new Error("EXECUTOR_ADDRESS does not match EXECUTOR_PRIVATE_KEY");
    }
  }

  async run(): Promise<void> {
    const { registry } = this.chains.get("robinhood");
    let job = await this.database.getOrCreateTokenRescueJob({
      id: BLINK_RESCUE_JOB_ID,
      chainId: registry.chain.id,
      tokenAddress: BLINK_ADDRESS,
      quoteToken: ROBINHOOD_WETH_ADDRESS,
      positionManager: registry.contracts.v3.positionManager,
      tokenIds: [...BLINK_TOKEN_IDS],
    });
    this.validateJob(job);
    log.info({ jobId: job.id, tokenIds: job.tokenIds.map(String), unlockAt: new Date(BLINK_BUY_LOCK_END_MS).toISOString() }, "BLINK rescue worker started");

    while (true) {
      try {
        const result = await this.tick(job);
        job = await this.requireJob();
        if (result === "complete" || job.status === "completed" || job.status === "needs_review") return;
        if (result === "waiting") await this.sleep(this.nextPollDelay());
      } catch (error) {
        const message = errorMessage(error);
        log.warn({ error: message, jobId: job.id }, "BLINK rescue cycle deferred");
        await this.database.setTokenRescueJobError(job.id, message);
        await this.sleep(this.config.blinkRescuePollIntervalMs);
        job = await this.requireJob();
      }
    }
  }

  async tick(job: TokenRescueJob): Promise<TickResult> {
    this.validateJob(job);
    if (job.status === "completed" || job.status === "needs_review") return "complete";
    if (job.pendingRawTransaction) {
      await this.resumePending(job);
      return "progressed";
    }
    if (job.status === "polling") return this.pollAndCollect(job);
    if (job.status === "collected") return this.swapCollectedBlink(job);
    if (job.status === "swapped") return this.unwrapSwapOutput(job);
    throw new Error(`Unsupported BLINK rescue status: ${job.status}`);
  }

  private async pollAndCollect(job: TokenRescueJob): Promise<TickResult> {
    if (this.now() + this.config.blinkRescuePollIntervalMs < BLINK_BUY_LOCK_END_MS) return "waiting";
    const { client } = this.chains.getForScan("robinhood");
    const calls: Hex[] = [];
    let totalOwed = 0n;
    for (const tokenId of job.tokenIds) {
      const owner = await client.readContract({
        address: job.positionManager,
        abi: v3PositionManagerAbi,
        functionName: "ownerOf",
        args: [tokenId],
      });
      if (owner.toLowerCase() !== this.config.executorAddress.toLowerCase()) {
        return this.needsReview(job, `NFT ${tokenId} is no longer owned by the executor`);
      }
      const position = await client.readContract({
        address: job.positionManager,
        abi: v3PositionManagerAbi,
        functionName: "positions",
        args: [tokenId],
      });
      if (position[2].toLowerCase() !== job.quoteToken.toLowerCase() || position[3].toLowerCase() !== job.tokenAddress.toLowerCase()) {
        return this.needsReview(job, `NFT ${tokenId} no longer matches WETH/BLINK`);
      }
      if (position[7] !== 0n) return this.needsReview(job, `NFT ${tokenId} unexpectedly has non-zero liquidity`);
      totalOwed += position[11];
      calls.push(encodeFunctionData({
        abi: v3PositionManagerAbi,
        functionName: "collect",
        args: [{
          tokenId,
          recipient: this.config.executorAddress,
          amount0Max: 0n,
          amount1Max: MAX_UINT128,
        }],
      }));
    }

    if (totalOwed === 0n) {
      return this.needsReview(job, "BLINK debt reached zero without a receipt-backed rescue collect");
    }

    const data = encodeFunctionData({ abi: v3PositionManagerAbi, functionName: "multicall", args: [calls] });
    try {
      await this.executionChain().client.call({ account: this.config.executorAddress, to: job.positionManager, data });
    } catch (error) {
      if (isCollectLocked(error)) return "waiting";
      throw error;
    }
    await this.send(job, "collect", job.positionManager, data, 0n, { expectedBlink: totalOwed.toString() });
    return "progressed";
  }

  private async swapCollectedBlink(job: TokenRescueJob): Promise<TickResult> {
    const amount = metadataBigInt(job.metadata, "collectedBlink");
    if (amount <= 0n) return this.needsReview(job, "Collected BLINK amount is missing");
    const walletBalance = await this.tokenBalance(job.tokenAddress);
    if (walletBalance < amount) return this.needsReview(job, "Executor BLINK balance fell below the collected rescue amount");

    const position = rescuePosition(job, this.config.executorAddress);
    const route = await this.routes.quoteDirect(position, job.tokenAddress, amount, job.quoteToken, { includeV4: false });
    if (!route) return "waiting";
    const requiredMinimum = route.expectedOut * BigInt(10_000 - BLINK_RESCUE_SLIPPAGE_BPS) / 10_000n;
    if (route.minimumOut !== requiredMinimum) return this.needsReview(job, "Rescue route did not enforce the fixed 2% minimum output");
    const { client } = this.chains.getForScan("robinhood");
    const approvedSpender = metadataAddress(job.metadata, "approvedSpender");
    if (approvedSpender && approvedSpender.toLowerCase() !== route.router.toLowerCase()) {
      const oldAllowance = await client.readContract({
        address: job.tokenAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [this.config.executorAddress, approvedSpender],
      });
      if (oldAllowance > 0n) {
        const resetData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [approvedSpender, 0n] });
        await this.send(job, "approve_reset", job.tokenAddress, resetData, 0n, {
          pendingApprovalSpender: approvedSpender,
          approvalAmount: "0",
        });
      } else {
        await this.database.setTokenRescueJobState(job.id, "collected", { approvedSpender: null }, null, "collected");
      }
      return "progressed";
    }
    const allowance = await client.readContract({
      address: job.tokenAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.config.executorAddress, route.router],
    });
    if (allowance !== amount) {
      const reset = allowance > 0n;
      const approvalAmount = reset ? 0n : amount;
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [route.router, approvalAmount] });
      await this.send(job, reset ? "approve_reset" : "approve", job.tokenAddress, data, 0n, {
        pendingApprovalSpender: route.router,
        approvalAmount: approvalAmount.toString(),
      });
      return "progressed";
    }

    const outputPool = route.pools.at(-1);
    if (!outputPool) return this.needsReview(job, "Rescue route has no final output pool");
    const preSwapWethBalance = await this.tokenBalance(job.quoteToken);
    const plan = buildSwapPlan(job.chainId, this.config.executorAddress, route, BigInt(Math.floor(this.now() / 1_000) + 300));
    await this.send(job, "swap", plan.to, plan.data, plan.value ?? 0n, {
      swapAmountIn: amount.toString(),
      swapExpectedOut: route.expectedOut.toString(),
      swapMinimumOut: route.minimumOut.toString(),
      swapProtocol: route.protocol,
      swapRouter: route.router,
      swapOutputPool: outputPool,
      preSwapWethBalance: preSwapWethBalance.toString(),
    }, true);
    return "progressed";
  }

  private async unwrapSwapOutput(job: TokenRescueJob): Promise<TickResult> {
    const amount = metadataBigInt(job.metadata, "swapOutputWeth");
    if (amount <= 0n) return this.needsReview(job, "Swap output WETH amount is missing");
    const walletBalance = await this.tokenBalance(job.quoteToken);
    if (walletBalance < amount) return this.needsReview(job, "Executor WETH balance fell below the rescue swap output");
    const data = encodeFunctionData({ abi: wethAbi, functionName: "withdraw", args: [amount] });
    await this.send(job, "unwrap", job.quoteToken, data, 0n, { unwrapAmountWeth: amount.toString() });
    return "progressed";
  }

  private async send(
    job: TokenRescueJob,
    stage: TokenRescuePendingTransaction["stage"],
    to: Address,
    data: Hex,
    value: bigint,
    metadata: Record<string, unknown>,
    bufferGas = false,
  ): Promise<void> {
    const { client, registry, transport } = this.executionChain();
    await this.database.withExecutionLock(job.chainId, this.config.executorAddress, async () => {
      const current = await this.requireJob();
      if (current.pendingRawTransaction) return this.resumePendingUnlocked(current);
      const expectedStatus = expectedStatusForStage(stage);
      if (current.status !== expectedStatus) {
        throw new Error(`Stale ${stage} request for BLINK rescue status ${current.status}`);
      }
      if (await this.database.hasPendingRawTransaction(job.chainId)) throw new Error("Another executor transaction is unresolved");
      await client.call({ account: this.config.executorAddress, to, data, value });
      const wallet = createWalletClient({ account: this.account!, chain: registry.chain, transport });
      const prepared = await wallet.prepareTransactionRequest({ account: this.account!, to, data, value });
      const request = bufferGas
        ? { ...prepared, gas: bufferedGas(prepared.gas, this.config.swapGasLimitMultiplierPercent) }
        : prepared;
      if (bufferGas) await client.call({ account: this.config.executorAddress, to, data, value, gas: request.gas });
      const serializedTransaction = await wallet.signTransaction(request);
      const hash = keccak256(serializedTransaction);
      const pending: TokenRescuePendingTransaction = {
        stage,
        hash,
        serializedTransaction,
        submittedAt: new Date(this.now()).toISOString(),
      };
      await this.database.setTokenRescuePendingTransaction(job.id, expectedStatus, pending, metadata);
      const broadcastHash = await wallet.sendRawTransaction({ serializedTransaction });
      if (broadcastHash.toLowerCase() !== hash.toLowerCase()) throw new Error(`${stage} broadcast returned an unexpected hash`);
      const receipt = await client.waitForTransactionReceipt({ hash, confirmations: this.config.confirmations, timeout: RECEIPT_TIMEOUT_MS });
      await this.finalizePending(await this.requireJob(), pending, receipt);
    });
  }

  private async resumePending(job: TokenRescueJob): Promise<void> {
    await this.database.withExecutionLock(job.chainId, this.config.executorAddress, () => this.resumePendingUnlocked(job));
  }

  private async resumePendingUnlocked(job: TokenRescueJob): Promise<void> {
    const pending = job.pendingRawTransaction;
    if (!pending) return;
    const { client, registry, transport } = this.executionChain();
    let receipt: TransactionReceipt;
    try {
      await client.getTransactionReceipt({ hash: pending.hash });
    } catch {
      const transaction = parseTransaction(pending.serializedTransaction);
      const latestNonce = await client.getTransactionCount({ address: this.config.executorAddress, blockTag: "latest" });
      if (transaction.nonce !== undefined && latestNonce > transaction.nonce) {
        const reason = `${pending.stage} nonce ${transaction.nonce} was consumed without receipt ${pending.hash}`;
        await this.database.clearTokenRescuePendingTransaction(job.id, pending.hash, "needs_review", {}, reason);
        await this.notify(`BLINK rescue requires review: ${reason}`);
        return;
      }
      const wallet = createWalletClient({ account: this.account!, chain: registry.chain, transport });
      try {
        await wallet.sendRawTransaction({ serializedTransaction: pending.serializedTransaction });
      } catch (error) {
        if (!/already known|known transaction|nonce too low/i.test(errorMessage(error))) throw error;
      }
    }
    receipt = await client.waitForTransactionReceipt({
      hash: pending.hash,
      confirmations: this.config.confirmations,
      timeout: RECEIPT_TIMEOUT_MS,
    });
    await this.finalizePending(job, pending, receipt);
  }

  private async finalizePending(job: TokenRescueJob, pending: TokenRescuePendingTransaction, receipt: TransactionReceipt): Promise<void> {
    if (receipt.status !== "success") {
      const reason = `${pending.stage} transaction reverted: ${pending.hash}`;
      await this.database.clearTokenRescuePendingTransaction(job.id, pending.hash, "needs_review", {}, reason);
      await this.notify(`BLINK rescue halted: ${reason}`);
      return;
    }

    if (pending.stage === "collect") {
      const amount = collectedBlink(receipt, job.positionManager, new Set(job.tokenIds.map(String)));
      if (amount <= 0n) {
        const reason = "Confirmed collect transaction contained no BLINK output";
        await this.database.clearTokenRescuePendingTransaction(job.id, pending.hash, "needs_review", {}, reason);
        await this.notify(`BLINK rescue requires review: ${reason}`);
        return;
      }
      await this.database.clearTokenRescuePendingTransaction(job.id, pending.hash, "collected", {
        collectTransactionHash: pending.hash,
        collectedBlink: amount.toString(),
      });
      await this.notify(`BLINK collected: ${formatToken(amount)} BLINK\n${pending.hash}`);
      return;
    }
    if (pending.stage === "approve" || pending.stage === "approve_reset") {
      const pendingSpender = metadataAddress(job.metadata, "pendingApprovalSpender");
      await this.database.clearTokenRescuePendingTransaction(job.id, pending.hash, "collected", {
        [`${pending.stage}TransactionHash`]: pending.hash,
        approvedSpender: pending.stage === "approve" ? pendingSpender : null,
        pendingApprovalSpender: null,
      });
      return;
    }
    if (pending.stage === "swap") {
      const outputPool = metadataAddress(job.metadata, "swapOutputPool");
      const amount = outputPool ? receivedToken(receipt, job.quoteToken, this.config.executorAddress, outputPool) : 0n;
      const minimumOut = metadataBigInt(job.metadata, "swapMinimumOut");
      const preSwapBalance = metadataBigInt(job.metadata, "preSwapWethBalance");
      const currentBalance = await this.tokenBalance(job.quoteToken);
      if (amount < minimumOut || currentBalance < preSwapBalance + amount) {
        const reason = "Confirmed swap transaction contained no WETH output";
        await this.database.clearTokenRescuePendingTransaction(job.id, pending.hash, "needs_review", {}, reason);
        await this.notify(`BLINK rescue requires review: ${reason}`);
        return;
      }
      await this.database.clearTokenRescuePendingTransaction(job.id, pending.hash, "swapped", {
        swapTransactionHash: pending.hash,
        swapOutputWeth: amount.toString(),
      });
      await this.notify(`BLINK rescue swap confirmed: ${formatToken(amount)} WETH\n${pending.hash}`);
      return;
    }
    await this.database.clearTokenRescuePendingTransaction(job.id, pending.hash, "completed", {
      unwrapTransactionHash: pending.hash,
      completedAt: new Date(this.now()).toISOString(),
    });
    await this.notify(`BLINK rescue completed and unwrapped to ETH.\n${pending.hash}`);
  }

  private async needsReview(job: TokenRescueJob, reason: string): Promise<TickResult> {
    await this.database.setTokenRescueJobState(job.id, "needs_review", {}, reason, job.status);
    log.error({ jobId: job.id, reason }, "BLINK rescue requires review");
    await this.notify(`BLINK rescue requires review: ${reason}`);
    return "complete";
  }

  private async tokenBalance(token: Address): Promise<bigint> {
    return this.chains.getForScan("robinhood").client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.config.executorAddress],
    });
  }

  private executionChain(): ChainClient {
    const chains = this.chains as unknown as { getForExecution?: (name: "robinhood") => ChainClient };
    return typeof chains.getForExecution === "function"
      ? chains.getForExecution("robinhood")
      : this.chains.getForScan("robinhood");
  }

  private validateJob(job: TokenRescueJob): void {
    const { registry } = this.chains.get("robinhood");
    const tokenIds = job.tokenIds.map(String).join(",");
    if (job.chainId !== registry.chain.id
      || job.tokenAddress.toLowerCase() !== BLINK_ADDRESS.toLowerCase()
      || job.quoteToken.toLowerCase() !== ROBINHOOD_WETH_ADDRESS.toLowerCase()
      || job.positionManager.toLowerCase() !== registry.contracts.v3.positionManager.toLowerCase()
      || tokenIds !== BLINK_TOKEN_IDS.map(String).join(",")) {
      throw new Error("Stored BLINK rescue job does not match the immutable rescue configuration");
    }
  }

  private async requireJob(): Promise<TokenRescueJob> {
    const job = await this.database.getTokenRescueJob(BLINK_RESCUE_JOB_ID);
    if (!job) throw new Error("BLINK rescue job disappeared");
    return job;
  }

  private nextPollDelay(): number {
    const untilUnlock = BLINK_BUY_LOCK_END_MS - this.now();
    if (untilUnlock > this.config.blinkRescuePollIntervalMs) return Math.min(untilUnlock, 300_000);
    return this.config.blinkRescuePollIntervalMs;
  }

  private async notify(text: string): Promise<void> {
    if (!this.config.telegram) return;
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.config.telegram.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.config.telegram.chatId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "BLINK rescue notification failed");
    }
  }
}

function rescuePosition(job: TokenRescueJob, owner: Address): PositionRecord {
  return {
    id: job.id,
    chainId: job.chainId,
    protocol: "v3",
    positionKey: "blink-rescue",
    owner,
    poolAddress: null,
    token0: job.quoteToken,
    token1: job.tokenAddress,
    quoteToken: job.quoteToken,
    status: "paused",
    liquidity: 0n,
    openedAtBlock: null,
    metadata: { rescue: true },
  };
}

function collectedBlink(receipt: TransactionReceipt, manager: Address, tokenIds: Set<string>): bigint {
  return parseEventLogs({ abi: [v3CollectEvent], logs: receipt.logs, strict: false })
    .filter((event) => event.address.toLowerCase() === manager.toLowerCase()
      && event.eventName === "Collect"
      && event.args.tokenId !== undefined
      && tokenIds.has(event.args.tokenId.toString()))
    .reduce((total, event) => total + (event.args.amount1 ?? 0n), 0n);
}

function receivedToken(receipt: TransactionReceipt, token: Address, recipient: Address, sender: Address): bigint {
  return parseEventLogs({ abi: [erc20TransferEvent], logs: receipt.logs, strict: false })
    .filter((event) => event.address.toLowerCase() === token.toLowerCase()
      && event.eventName === "Transfer"
      && event.args.from?.toLowerCase() === sender.toLowerCase()
      && event.args.to?.toLowerCase() === recipient.toLowerCase())
    .reduce((total, event) => total + (event.args.value ?? 0n), 0n);
}

function metadataBigInt(metadata: Record<string, unknown>, key: string): bigint {
  const value = metadata[key];
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function metadataAddress(metadata: Record<string, unknown>, key: string): Address | null {
  const value = metadata[key];
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value as Address : null;
}

function expectedStatusForStage(stage: TokenRescuePendingTransaction["stage"]): TokenRescueJob["status"] {
  if (stage === "collect") return "polling";
  if (stage === "unwrap") return "swapped";
  return "collected";
}

function bufferedGas(gas: bigint | undefined, multiplierPercent: number): bigint | undefined {
  return gas === undefined ? undefined : (gas * BigInt(multiplierPercent) + 99n) / 100n;
}

function isCollectLocked(error: unknown): boolean {
  return /\bTF\b|BuyLocked|0x3d80d6cf/i.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatToken(amount: bigint): string {
  const whole = amount / 10n ** 18n;
  const fraction = (amount % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
