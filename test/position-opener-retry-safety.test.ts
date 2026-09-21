import { describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";
import { chainRegistry } from "../src/chains.js";
import { BidAskOpenRetryableError, PositionOpener } from "../src/services/position-opener.js";
import { planBidAsk } from "../src/services/bid-ask-planner.js";

function harness() {
  const hash = keccak256("0x01");
  const client = {
    call: vi.fn().mockResolvedValue({}), getTransactionCount: vi.fn().mockResolvedValue(1),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
  };
  const database = {
    hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
    withExecutionLock: vi.fn(async (_chain: unknown, _owner: unknown, run: () => Promise<unknown>) => run()),
    nextPositionGroupExecutionNonce: vi.fn().mockResolvedValue(1),
    recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
    setPositionGroupOpenTransaction: vi.fn().mockResolvedValue(true),
    setPositionGroupStatus: vi.fn().mockResolvedValue(true),
  };
  const wallet = {
    prepareTransactionRequest: vi.fn().mockResolvedValue({ nonce: 1 }),
    signTransaction: vi.fn().mockResolvedValue("0x01"),
    sendRawTransaction: vi.fn().mockResolvedValue(hash),
  };
  const opener = new PositionOpener({
    executorAddress: "0x0000000000000000000000000000000000000011",
    executorPrivateKey: `0x${"11".repeat(32)}`, confirmations: 1,
  } as never, {
    getForScan: () => ({ registry: chainRegistry.base }),
    getForExecution: () => ({ client }),
  } as never, undefined, undefined, database as never) as any;
  opener.walletClient = () => wallet;
  const run = () => opener.broadcastBidAsk("base", "v3", "group", chainRegistry.base.contracts.v3.positionManager, "0x", 0n, 100n);
  return { hash, client, database, wallet, opener, run };
}

function executionHarness() {
  const h = harness();
  const plan = planBidAsk({ currentTick: 0, rawTickLower: 60, rawTickUpper: 600,
    tickSpacing: 60, quoteIsToken0: true, requestedBinCount: 5, totalAmount: 100000n });
  const preview = {
    chain: "base", protocol: "v3", poolAddress: chainRegistry.base.contracts.v3.factory,
    token0: "0x0000000000000000000000000000000000000001",
    token1: "0x0000000000000000000000000000000000000002",
    hooks: "0x0000000000000000000000000000000000000000",
    quoteToken: "0x0000000000000000000000000000000000000001", quoteTokenSymbol: "USDC",
    quoteIsToken0: true, currentTick: 0, poolLiquidity: 1000000n, sqrtPriceX96: 1n << 96n,
    feeTier: 3000, tickSpacing: 60, requestedBinCount: 5, depositAmount: 100000n,
    outerTickLower: 60, outerTickUpper: 600, plan,
  };
  h.opener.reconcileBidAskOpen = vi.fn().mockResolvedValue([]);
  h.opener.readBidAskPool = vi.fn().mockResolvedValue({ ...preview, fee: 3000 });
  h.opener.ensureApproval = vi.fn().mockResolvedValue(undefined);
  h.opener.makeBidAskPlan = vi.fn().mockReturnValue(plan);
  h.opener.buildBidAskBatch = vi.fn().mockReturnValue({ to: chainRegistry.base.contracts.v3.positionManager, data: "0x", value: 0n });
  h.opener.simulateAndEstimateBidAsk = vi.fn().mockResolvedValue({ estimatedGas: 100n, blockGasLimit: null });
  h.opener.persistBidAskPlan = vi.fn().mockResolvedValue("group");
  return { ...h, preview, execute: () => h.opener.executeBidAskOpen(preview) };
}

describe("Bid-Ask mint retry safety boundary", () => {
  it.each(["call", "getTransactionCount", "prepareTransactionRequest"] as const)("cleans up and safely retries a broadcast preflight RPC failure in %s", async (stage) => {
    const h = executionHarness();
    const failure = stage === "prepareTransactionRequest" ? h.wallet[stage] : h.client[stage];
    failure.mockRejectedValueOnce(new Error("RPC timeout"));
    await expect(h.execute()).rejects.toMatchObject({ safety: "pre_mint" });
    expect(h.database.setPositionGroupStatus).toHaveBeenLastCalledWith("group", "cancelled", {
      reason: "bid_ask_open_pre_sign_failed", lastExecutionError: "RPC timeout", pendingRawTransaction: null,
    });
    expect(h.wallet.signTransaction).not.toHaveBeenCalled();
    expect(h.wallet.sendRawTransaction).not.toHaveBeenCalled();
    await expect(h.execute()).resolves.toMatchObject({ hash: h.hash });
    expect(h.wallet.signTransaction).toHaveBeenCalledOnce();
    expect(h.wallet.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it.each([false, "throws"])("does not authorize retry when pre-sign cancellation fails: %s", async (failure) => {
    const h = harness();
    h.client.call.mockRejectedValue(new Error("RPC timeout"));
    if (failure === false) h.database.setPositionGroupStatus.mockResolvedValue(false);
    else h.database.setPositionGroupStatus.mockRejectedValue(new Error("database timeout"));
    await expect(h.run()).rejects.not.toBeInstanceOf(BidAskOpenRetryableError);
    expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("cleans up fatal pre-sign errors without authorizing a retry", async () => {
    const h = harness();
    h.wallet.prepareTransactionRequest.mockRejectedValue(new Error("insufficient funds"));
    await expect(h.run()).rejects.not.toBeInstanceOf(BidAskOpenRetryableError);
    expect(h.database.setPositionGroupStatus).toHaveBeenCalledWith("group", "cancelled", expect.anything());
  });

  it("cancels only the new unused group and stops when another signed transaction is pending", async () => {
    const h = harness();
    h.database.hasPendingRawTransaction.mockResolvedValue(true);
    await expect(h.run()).rejects.not.toBeInstanceOf(BidAskOpenRetryableError);
    expect(h.database.setPositionGroupStatus).toHaveBeenCalledWith("group", "cancelled", expect.objectContaining({ reason: "bid_ask_open_pre_sign_failed" }));
    expect(h.client.call).not.toHaveBeenCalled();
    expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("stops at the signing call even if signing rejects without returning a hash", async () => {
    const h = harness();
    h.wallet.signTransaction.mockRejectedValue(new Error("RPC timeout"));
    await expect(h.run()).rejects.not.toBeInstanceOf(BidAskOpenRetryableError);
    expect(h.database.setPositionGroupStatus).not.toHaveBeenCalled();
  });

  it("retries the V4 gas cap at pre-sign without signing or relaxing the cap", async () => {
    const h = harness();
    h.opener.config.bidAskLadderV4MaxOpenGasUsd = 1.5;
    h.opener.config.bidAskLadderV4EthUsd = 2500;
    h.wallet.prepareTransactionRequest.mockResolvedValue({ nonce: 1, gas: 740922n, maxFeePerGas: 5698390000n } as never);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(h.opener.broadcastBidAsk("base", "v4", "group", chainRegistry.base.contracts.v4.positionManager, "0x", 0n, 740922n))
        .rejects.toMatchObject({ safety: "pre_mint", message: expect.stringContaining("exceeds $1.50 limit") });
    }
    expect(h.opener.config.bidAskLadderV4MaxOpenGasUsd).toBe(1.5);
    expect(h.database.setPositionGroupStatus).toHaveBeenCalledTimes(2);
    expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("preserves dry-run planned state without nonce preparation or signing", async () => {
    const h = executionHarness();
    h.opener.config.dryRun = true;
    await expect(h.execute()).resolves.toMatchObject({ hash: null });
    expect(h.database.setPositionGroupStatus).toHaveBeenLastCalledWith("group", "planned", { dryRunPlan: "atomic_bid_ask_open", pendingRawTransaction: null });
    expect(h.client.getTransactionCount).not.toHaveBeenCalled();
    expect(h.wallet.prepareTransactionRequest).not.toHaveBeenCalled();
    expect(h.wallet.signTransaction).not.toHaveBeenCalled();
    expect(h.wallet.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.opener.reconcileBidAskOpen).not.toHaveBeenCalled();
  });

  it("allows a failed dry-run preflight to retry and then remain a dry run", async () => {
    const h = executionHarness();
    h.opener.config.dryRun = true;
    h.client.call.mockRejectedValueOnce(new Error("RPC timeout"));
    await expect(h.execute()).rejects.toMatchObject({ safety: "pre_mint" });
    const result = await h.execute();
    expect(result.hash).toBeNull();
    expect(result.pendingReconciliation).toBeUndefined();
    expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("authorizes a retry only after a reverted receipt and durable failed state", async () => {
    const h = harness();
    h.client.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    await expect(h.run()).rejects.toMatchObject({ safety: "confirmed_revert" });
    expect(h.database.recordPositionGroupExecution).toHaveBeenCalledWith("group", "open_batch", "failed", h.hash, undefined, undefined, "transaction reverted");
    expect(h.database.setPositionGroupStatus).toHaveBeenCalledWith("group", "cancelled", expect.objectContaining({ pendingRawTransaction: null }));
  });

  it.each(["execution reverted", "RPC timeout", "insufficient funds"])("keeps ambiguous broadcast '%s' pending even when it sounds fatal or reverted", async (message) => {
    const h = harness();
    h.wallet.sendRawTransaction.mockRejectedValue(new Error(message));
    await expect(h.run()).resolves.toEqual({ hash: h.hash, pendingReconciliation: true });
    expect(h.database.setPositionGroupStatus).not.toHaveBeenCalled();
    expect(h.database.recordPositionGroupExecution.mock.invocationCallOrder[1]).toBeLessThan(h.wallet.sendRawTransaction.mock.invocationCallOrder[0]!);
  });

  it("preserves a successful receipt when confirmed-accounting fails, even with revert text", async () => {
    const h = harness();
    h.database.recordPositionGroupExecution.mockImplementation(async (_group, _action, status) => {
      if (status === "confirmed") throw new Error("accounting reverted");
    });
    await expect(h.run()).resolves.toMatchObject({ hash: h.hash, receipt: { status: "success" }, pendingReconciliation: true });
  });

  it("does not authorize retry if recording the reverted receipt fails", async () => {
    const h = harness();
    h.client.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    h.database.setPositionGroupStatus.mockRejectedValue(new Error("database timeout"));
    await expect(h.run()).resolves.toEqual({ hash: h.hash, pendingReconciliation: true });
  });

  it("does not signal retry for a hashless post-signing persistence error", async () => {
    const h = harness();
    h.database.recordPositionGroupExecution.mockImplementation(async (_group, _action, status) => {
      if (status === "submitted") throw new Error("database timeout");
    });
    await expect(h.run()).rejects.not.toBeInstanceOf(BidAskOpenRetryableError);
    expect(h.wallet.signTransaction).toHaveBeenCalledOnce();
    expect(h.wallet.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("labels an actual transient preflight failure as safe to retry", async () => {
    const h = executionHarness();
    h.opener.readBidAskPool.mockRejectedValue(new Error("RPC timeout"));
    await expect(h.execute()).rejects.toMatchObject({ safety: "pre_mint" });
    expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });

  it.each(["insufficient balance", "Invalid input", "configuration disabled"])("does not retry a fatal preflight failure: %s", async (message) => {
    const h = executionHarness();
    h.opener.readBidAskPool.mockRejectedValue(new Error(message));
    await expect(h.execute()).rejects.not.toBeInstanceOf(BidAskOpenRetryableError);
    expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("keeps a hashless signing/persistence failure durable and non-retryable through the full execution path", async () => {
    const h = executionHarness();
    h.database.setPositionGroupOpenTransaction.mockRejectedValue(new Error("RPC timeout"));
    await expect(h.execute()).rejects.not.toBeInstanceOf(BidAskOpenRetryableError);
    expect(h.wallet.signTransaction).toHaveBeenCalledOnce();
    expect(h.database.recordPositionGroupExecution).toHaveBeenCalledWith("group", "open_batch", "submitted", h.hash, "0x01", 1n, undefined, expect.anything());
    expect(h.database.setPositionGroupStatus).toHaveBeenCalledTimes(1);
    expect(h.database.setPositionGroupStatus).toHaveBeenCalledWith("group", "opening", expect.anything());
  });

  it("returns pending when receipt reconciliation fails after a successful mint", async () => {
    const h = executionHarness();
    h.opener.reconcileBidAskOpen.mockRejectedValue(new Error("accounting RPC timeout"));
    await expect(h.execute()).resolves.toMatchObject({ hash: h.hash, pendingReconciliation: true });
    expect(h.wallet.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("does not cancel a hashless ambiguous response", async () => {
    const h = executionHarness();
    h.opener.broadcastBidAsk = vi.fn().mockResolvedValue({ hash: null });
    await expect(h.execute()).resolves.toMatchObject({ hash: null, pendingReconciliation: true });
    expect(h.database.setPositionGroupStatus).toHaveBeenCalledTimes(1);
    expect(h.database.setPositionGroupStatus).toHaveBeenCalledWith("group", "opening", expect.anything());
  });
});
