import { afterEach, describe, expect, it, vi } from "vitest";
import { Notifier, type BidAskLadderOpenRequest } from "../src/services/notifier.js";
import { BidAskOpenRetryableError } from "../src/services/position-opener.js";

const safeFailure = () => new BidAskOpenRetryableError("price moved", "pre_mint");

function harness(maxRetries = 2) {
  const notifier = Object.create(Notifier.prototype) as any;
  notifier.config = { dryRun: false };
  const request: BidAskLadderOpenRequest = {
    poolAddress: "0x0000000000000000000000000000000000000044", chain: "base",
    quoteToken: { address: "0x0000000000000000000000000000000000000001", symbol: "USDC" },
    direction: "above", rangePercent: 33, binCount: 5, depositAmount: 123456789n,
    protocols: ["v3", "v4"], maxBins: 10, maxPriceDeviationBps: 100,
    atomicMaxBlockGasBps: 8000, transactionDeadlineSeconds: 300, maxRetries,
  };
  const confirmed = { protocol: "v3", pair: "TOKEN/USDC", outerTickLower: 100 };
  let generation = 0;
  const prepareBidAskOpen = vi.fn(async () => ({ ...confirmed, outerTickLower: 200 + generation++ }));
  const executeBidAskOpen = vi.fn().mockResolvedValue({ hash: "0x1234" });
  notifier.positionOpener = { prepareBidAskOpen, executeBidAskOpen };
  notifier.database = { queueMessageDeletion: vi.fn(async () => {}) };
  const ctx = {
    chat: { id: 1 }, reply: vi.fn().mockResolvedValue({ message_id: 42 }),
    api: { editMessageText: vi.fn().mockResolvedValue(true) },
  };
  const run = () => notifier.executeOpenConfirmation(ctx, { kind: "bid_ask", request, preview: confirmed });
  return { request, confirmed, prepareBidAskOpen, executeBidAskOpen, ctx, run, database: notifier.database };
}

afterEach(() => { vi.useRealTimers(); });

describe("Bid-Ask confirmed open retries", () => {
  it("keeps the confirmed preview first, then freshly prepares identical inputs every fixed 3000ms", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.executeBidAskOpen.mockRejectedValueOnce(safeFailure()).mockRejectedValueOnce(new BidAskOpenRetryableError("receipt reverted", "confirmed_revert"));
    const work = h.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.executeBidAskOpen).toHaveBeenCalledWith(h.confirmed);
    expect(h.executeBidAskOpen.mock.calls[0]![0]).toBe(h.confirmed);
    expect(h.prepareBidAskOpen).not.toHaveBeenCalled();
    for (let retry = 1; retry <= 2; retry++) {
      await vi.advanceTimersByTimeAsync(2999);
      expect(h.executeBidAskOpen).toHaveBeenCalledTimes(retry);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.executeBidAskOpen).toHaveBeenCalledTimes(retry + 1);
      expect(h.prepareBidAskOpen).toHaveBeenNthCalledWith(retry,
        h.request.poolAddress, h.request.chain, 33, 123456789n, h.request.quoteToken, 5, "above");
      expect(h.executeBidAskOpen.mock.calls[retry]![0]).toMatchObject({ outerTickLower: 199 + retry });
    }
    await work;
    expect(h.ctx.reply).toHaveBeenCalledOnce();
    expect(h.ctx.api.editMessageText.mock.calls.every(([chat, id]) => chat === 1 && id === 42)).toBe(true);
    expect(h.ctx.api.editMessageText.mock.lastCall![2]).toContain("LADDER OPENED");
  });

  it.each([0, 1, 3])("caps retries at initial + %i", async (maxRetries) => {
    vi.useFakeTimers();
    const h = harness(maxRetries);
    h.executeBidAskOpen.mockRejectedValue(safeFailure());
    const work = h.run();
    await vi.runAllTimersAsync();
    await work;
    expect(h.executeBidAskOpen).toHaveBeenCalledTimes(1 + maxRetries);
    expect(h.prepareBidAskOpen).toHaveBeenCalledTimes(maxRetries);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { hash: "0x1234", pendingReconciliation: true },
    { hash: null, pendingReconciliation: true },
    { hash: null },
    undefined,
  ])("stops on pending or ambiguous response %j", async (result) => {
    vi.useFakeTimers();
    const h = harness();
    h.executeBidAskOpen.mockResolvedValue(result);
    await h.run();
    await vi.runAllTimersAsync();
    expect(h.executeBidAskOpen).toHaveBeenCalledOnce();
    expect(h.prepareBidAskOpen).not.toHaveBeenCalled();
    expect(h.ctx.api.editMessageText.mock.lastCall![2]).toContain("RECONCILIATION");
  });

  it.each(["transaction reverted", "RPC timeout after signing", "insufficient funds", "Invalid Bid-Ask configuration"])("never infers execution safety from an unstructured error: %s", async (message) => {
    vi.useFakeTimers();
    const h = harness();
    h.executeBidAskOpen.mockRejectedValue(new Error(message));
    await h.run();
    expect(h.executeBidAskOpen).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["send", "edit"])("isolates Telegram %s failures from execution and retries", async (failure) => {
    vi.useFakeTimers();
    const h = harness();
    if (failure === "send") h.ctx.reply.mockRejectedValue(new Error("Telegram timeout"));
    else h.ctx.api.editMessageText.mockRejectedValue(new Error("Telegram timeout"));
    h.executeBidAskOpen.mockRejectedValueOnce(safeFailure());
    const work = h.run();
    await vi.runAllTimersAsync();
    await work;
    expect(h.executeBidAskOpen).toHaveBeenCalledTimes(2);
    expect(h.prepareBidAskOpen).toHaveBeenCalledOnce();
    expect(h.ctx.reply).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "opened", result: { hash: "0x1234" }, text: "LADDER OPENED" },
    { name: "reconciliation", result: { hash: null, pendingReconciliation: true }, text: "RECONCILIATION" },
  ])("auto-deletes the final $name message 10s after the outcome", async ({ result, text }) => {
    vi.useFakeTimers();
    const h = harness();
    h.executeBidAskOpen.mockResolvedValue(result);
    await h.run();
    expect(h.ctx.api.editMessageText.mock.lastCall![2]).toContain(text);
    expect(h.database.queueMessageDeletion.mock.calls[0]).toEqual(["1", 42, new Date(Date.now() + 30 * 60_000)]);
    expect(h.database.queueMessageDeletion.mock.calls.at(-1)).toEqual(["1", 42, new Date(Date.now() + 10_000)]);
  });

  it("auto-deletes the fatal error message 10s after it is rendered", async () => {
    vi.useFakeTimers();
    const h = harness(0);
    h.executeBidAskOpen.mockRejectedValue(new Error("insufficient balance"));
    await h.run();
    expect(h.ctx.api.editMessageText.mock.lastCall![2]).toContain("Open Bid-Ask berhenti");
    expect(h.database.queueMessageDeletion.mock.calls.at(-1)).toEqual(["1", 42, new Date(Date.now() + 10_000)]);
  });

  it("keeps retry progress messages queued at the safety TTL only", async () => {
    vi.useFakeTimers();
    const h = harness(1);
    h.executeBidAskOpen.mockRejectedValueOnce(safeFailure());
    const work = h.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.database.queueMessageDeletion).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await work;
    expect(h.database.queueMessageDeletion).toHaveBeenCalledTimes(2);
  });

  it("counts failed fresh preparations against the cap", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.executeBidAskOpen.mockRejectedValueOnce(safeFailure());
    h.prepareBidAskOpen.mockRejectedValue(new Error("RPC timeout"));
    const work = h.run();
    await vi.runAllTimersAsync();
    await work;
    expect(h.executeBidAskOpen).toHaveBeenCalledOnce();
    expect(h.prepareBidAskOpen).toHaveBeenCalledTimes(2);
  });

  it.each([
    "atomic_batch_infeasible: estimated open gas 0.004 ETH ($10.00 at $2500/ETH) exceeds $1.50 limit",
    "atomic_batch_infeasible: estimated gas 9000000 exceeds the configured limit",
    "atomic_batch_infeasible: estimated gas 9000000 exceeds the block gas budget for 5 bins",
  ])("bounds gas-cap retries at a fixed delay: %s", async (message) => {
    vi.useFakeTimers();
    const h = harness(2);
    h.executeBidAskOpen.mockRejectedValueOnce(new BidAskOpenRetryableError(message, "pre_mint"));
    h.prepareBidAskOpen.mockRejectedValue(new Error(message));
    const start = Date.now();
    const work = h.run();
    await vi.advanceTimersByTimeAsync(2999);
    expect(h.prepareBidAskOpen).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.prepareBidAskOpen).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2999);
    expect(h.prepareBidAskOpen).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await work;
    expect(Date.now() - start).toBe(6000);
    expect(h.prepareBidAskOpen).toHaveBeenCalledTimes(2);
    expect(h.executeBidAskOpen).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["insufficient balance", "invalid input", "not configured", "ladder disabled"])("stops fatal preparation: %s", async (message) => {
    vi.useFakeTimers();
    const h = harness(4);
    h.executeBidAskOpen.mockRejectedValueOnce(safeFailure());
    h.prepareBidAskOpen.mockRejectedValue(new Error(message));
    const work = h.run();
    await vi.runAllTimersAsync();
    await work;
    expect(h.prepareBidAskOpen).toHaveBeenCalledOnce();
    expect(h.executeBidAskOpen).toHaveBeenCalledOnce();
  });
});
