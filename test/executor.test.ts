import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, pad, stringToHex, zeroAddress, type Address, type Hex } from "viem";

import type { RuntimeConfig } from "../src/config.js";
import { bufferedGasLimit, Executor, effectiveRemoveSlippageBps, nextExitRetry, nextSwapRetry, receiptErc20NetReceived } from "../src/services/executor.js";
import type { PositionRecord } from "../src/types.js";

const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const token = "0xd7321801caae694090694ff55a9323139f043b88" as const;
const owner = "0xeE924367213Ae3764b57d5b9a6214c8188d34060" as const;
const sender = "0x0000000000000000000000000000000000000002" as const;
const hash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

function transferLog(tokenAddress: Address, from: Address, to: Address, value: bigint) {
  return {
    address: tokenAddress,
    topics: [
      keccak256(stringToHex("Transfer(address,address,uint256)")),
      pad(from, { size: 32 }),
      pad(to, { size: 32 }),
    ] as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

const config = {
  executorAddress: owner,
  executorPrivateKey: undefined,
  dryRun: true,
  pnlIncludeGas: false,
  alchemyHttp: {},
  rpcHttp: { base: "https://base.invalid", robinhood: "https://robinhood.invalid" },
  quoteTokens: { base: [], robinhood: [{ symbol: "USDG", address: usdg }] },
  settlementSwapSlippageBps: 200,
  settlementSwapMaxSlippageBps: 500,
  swapGasLimitMultiplierPercent: 300,
  removeLiquiditySlippageBps: 200,
  removeLiquidityMaxSlippageBps: 500,
  confirmations: 1,
} as RuntimeConfig;

describe("Executor pending settlement recovery", () => {
  it("derives net ERC-20 proceeds from confirmed receipt transfers", () => {
    const logs = [
      transferLog(token, sender, owner, 120n),
      transferLog(token, owner, sender, 20n),
      transferLog(usdg, sender, owner, 999n),
    ];

    expect(receiptErc20NetReceived(logs, token, owner)).toBe(100n);
  });

  it("derives close proceeds from receipt for either ERC-20 quote orientation", async () => {
    const receipt = {
      status: "success",
      logs: [transferLog(usdg, sender, owner, 23n), transferLog(token, sender, owner, 118n)],
    };
    const client = { getTransactionReceipt: vi.fn().mockResolvedValue(receipt) };
    const chains = { getById: vi.fn(() => ({ client, registry: { name: "robinhood" } })) };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, config);
    const basePosition = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1", owner, poolAddress: null,
      token0: usdg, token1: token, status: "closing", liquidity: null, openedAtBlock: null, metadata: {},
    } as PositionRecord;

    await expect((executor as unknown as {
      closeReceiptAmounts(value: PositionRecord, transactionHash: Hex): Promise<{ quoteAmount: bigint; nonQuoteAmount: bigint }>;
    }).closeReceiptAmounts({ ...basePosition, quoteToken: usdg }, hash)).resolves.toEqual({ quoteAmount: 23n, nonQuoteAmount: 118n });
    await expect((executor as unknown as {
      closeReceiptAmounts(value: PositionRecord, transactionHash: Hex): Promise<{ quoteAmount: bigint; nonQuoteAmount: bigint }>;
    }).closeReceiptAmounts({ ...basePosition, quoteToken: token }, hash)).resolves.toEqual({ quoteAmount: 118n, nonQuoteAmount: 23n });
  });

  it("reuses the receipt confirmed by the transaction provider", async () => {
    const receipt = {
      status: "success",
      logs: [transferLog(usdg, sender, owner, 23n), transferLog(token, sender, owner, 118n)],
    };
    const client = { getTransactionReceipt: vi.fn().mockRejectedValue(new Error("lagging RPC")) };
    const chains = { getById: vi.fn(() => ({ client, registry: { name: "robinhood" } })) };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, config);
    (executor as unknown as { confirmedReceipts: Map<Hex, unknown> }).confirmedReceipts.set(hash, receipt);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    await expect((executor as unknown as {
      closeReceiptAmounts(value: PositionRecord, transactionHash: Hex): Promise<{ quoteAmount: bigint; nonQuoteAmount: bigint }>;
    }).closeReceiptAmounts(position, hash)).resolves.toEqual({ quoteAmount: 23n, nonQuoteAmount: 118n });
    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("does not reconcile an uncached receipt before the configured confirmation depth", async () => {
    vi.useFakeTimers();
    const receipt = { status: "success", blockNumber: 100n, logs: [] };
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      getBlockNumber: vi.fn().mockResolvedValue(100n),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: { name: "robinhood" } })) };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, { ...config, confirmations: 2 });

    const pending = (executor as unknown as {
      getConfirmedReceipt(chainId: number, transactionHash: Hex): Promise<unknown>;
    }).getConfirmedReceipt(4663, hash);
    const assertion = expect(pending).rejects.toThrow("2 confirmations");
    await vi.runAllTimersAsync();
    await assertion;
    expect(client.getTransactionReceipt).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("derives native proceeds at the receipt block and restores transaction gas", async () => {
    const client = {
      getBalance: vi.fn()
        .mockResolvedValueOnce(1_000n)
        .mockResolvedValueOnce(1_085n),
      getTransaction: vi.fn().mockResolvedValue({ value: 0n }),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: { name: "robinhood" } })) };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, config);
    const receipt = { blockNumber: 100n, gasUsed: 5n, effectiveGasPrice: 3n, logs: [] };

    await expect((executor as unknown as {
      assetReceivedFromReceipt(chainId: number, tokenAddress: Address, account: Address, transactionHash: Hex, value: unknown): Promise<bigint>;
    }).assetReceivedFromReceipt(4663, zeroAddress, owner, hash, receipt)).resolves.toBe(100n);
    expect(client.getBalance).toHaveBeenNthCalledWith(1, { address: owner, blockNumber: 99n });
    expect(client.getBalance).toHaveBeenNthCalledWith(2, { address: owner, blockNumber: 100n });
  });

  it("increments retry attempts after a failed exit", () => {
    const retry = nextExitRetry({ exitRetry: { reason: "stop_loss", attempts: 2 } }, "stop_loss");
    expect(retry).toMatchObject({ reason: "stop_loss", attempts: 3 });
  });

  it("escalates remove-liquidity slippage on repeated close failures", () => {
    expect(effectiveRemoveSlippageBps(200, 500, 0)).toBe(200);
    expect(effectiveRemoveSlippageBps(200, 500, 1)).toBe(300);
    expect(effectiveRemoveSlippageBps(200, 500, 3)).toBe(500);
    expect(effectiveRemoveSlippageBps(200, 500, 5)).toBe(500);
  });

  it("tracks mined swap reverts separately from planning failures", () => {
    const now = Date.now();
    const planning = nextSwapRetry({}, "uniswap", false, 2, now);
    const reverted = nextSwapRetry({}, "uniswap", true, 2, now);

    expect(planning).toMatchObject({ broadcastAttempts: 0, planningFailures: 1, cycleBroadcastAttempts: 0, lastProvider: "uniswap" });
    expect(reverted).toMatchObject({ broadcastAttempts: 1, planningFailures: 0, cycleBroadcastAttempts: 1, lastProvider: "uniswap" });
    expect(Date.parse(planning.nextAttemptAt!)).toBe(now + 3_000);
    expect(Date.parse(reverted.nextAttemptAt!)).toBe(now);
  });

  it("restarts a failed two-provider cycle after three seconds without a hard retry cap", () => {
    const now = Date.now();
    let retry = nextSwapRetry({}, "kyberswap", true, 2, now);
    const first = retry;
    retry = nextSwapRetry({ swapRetry: retry }, "uniswap", true, 2, now);
    const second = retry;
    retry = nextSwapRetry({ swapRetry: retry }, "kyberswap", true, 2, now + 3_000);
    const third = retry;
    for (let attempt = 4; attempt <= 10; attempt += 1) {
      retry = nextSwapRetry({ swapRetry: retry }, attempt % 2 === 0 ? "uniswap" : "kyberswap", true, 2, now + 3_000);
    }

    expect(first.cycleBroadcastAttempts).toBe(1);
    expect(second).toMatchObject({ broadcastAttempts: 2, cycleBroadcastAttempts: 0, lastProvider: "uniswap" });
    expect(Date.parse(second.nextAttemptAt!)).toBe(now + 3_000);
    expect(third).toMatchObject({ broadcastAttempts: 3, cycleBroadcastAttempts: 1, lastProvider: "kyberswap" });
    expect(Date.parse(third.nextAttemptAt!)).toBe(now + 3_000);
    expect(retry).toMatchObject({ broadcastAttempts: 10, cycleBroadcastAttempts: 0, lastProvider: "uniswap" });
  });

  it("buffers swap gas estimates without changing actual gas accounting", () => {
    expect(bufferedGasLimit(172_217n, 300)).toBe(516_651n);
    expect(bufferedGasLimit(1n, 250)).toBe(3n);
    expect(() => bufferedGasLimit(100n, 99)).toThrow("between 100 and 500");
  });

  it("quotes providers in parallel and selects the best simulated output", async () => {
    const client = {
      readContract: vi.fn().mockResolvedValue(5n),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: { name: "robinhood" } })) };
    const uniswapQuote = { routing: "CLASSIC" as const, expectedOut: 100n, minimumOut: 98n, raw: {} };
    const tradingApi = {
      quote: vi.fn().mockResolvedValue(uniswapQuote),
      approval: vi.fn().mockResolvedValue(null),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: sender, data: "0x11", description: "uniswap" }),
    };
    const kyberQuote = { source: "kyberswap", expectedOut: 110n, minimumOut: 107n, router: sender };
    const kyberswapApi = {
      quote: vi.fn().mockResolvedValue(kyberQuote),
      approvalSpender: vi.fn().mockReturnValue(sender),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: sender, data: "0x22", description: "kyber" }),
    };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, config, tradingApi as never, kyberswapApi as never);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    const prepared = await (executor as unknown as {
      prepareBestSettlementSwap(value: PositionRecord, tokenIn: Address, amount: bigint, tokenOut: Address, slippage: number): Promise<{ provider: string; expectedOut: bigint }>;
    }).prepareBestSettlementSwap(position, token, 5n, usdg, 200);

    expect(prepared).toMatchObject({ provider: "kyberswap", expectedOut: 110n });
    expect(tradingApi.quote).toHaveBeenCalledTimes(1);
    expect(kyberswapApi.quote).toHaveBeenCalledTimes(1);
    expect(kyberswapApi.createSwap).toHaveBeenCalledTimes(1);
    expect(tradingApi.createSwap).not.toHaveBeenCalled();
    expect(client.call).toHaveBeenCalledWith(expect.objectContaining({ data: "0x22" }));
  });

  it("falls back before broadcast when the best provider fails simulation", async () => {
    const uniswapTarget = "0x0000000000000000000000000000000000000004" as const;
    const kyberTarget = "0x0000000000000000000000000000000000000005" as const;
    const client = {
      readContract: vi.fn().mockResolvedValue(5n),
      call: vi.fn().mockImplementation(({ to }: { to: Address }) => to === uniswapTarget
        ? Promise.reject(new Error("simulation reverted"))
        : Promise.resolve({ data: "0x" })),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: { name: "robinhood" } })) };
    const tradingApi = {
      quote: vi.fn().mockResolvedValue({ routing: "CLASSIC", expectedOut: 120n, minimumOut: 117n, raw: {} }),
      approval: vi.fn().mockResolvedValue(null),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: uniswapTarget, data: "0x11", description: "uniswap" }),
    };
    const kyberswapApi = {
      quote: vi.fn().mockResolvedValue({ source: "kyberswap", expectedOut: 110n, minimumOut: 107n, router: kyberTarget }),
      approvalSpender: vi.fn().mockReturnValue(kyberTarget),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: kyberTarget, data: "0x22", description: "kyber" }),
    };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, config, tradingApi as never, kyberswapApi as never);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    const prepared = await (executor as unknown as {
      prepareBestSettlementSwap(value: PositionRecord, tokenIn: Address, amount: bigint, tokenOut: Address, slippage: number): Promise<{ provider: string }>;
    }).prepareBestSettlementSwap(position, token, 5n, usdg, 200);

    expect(prepared.provider).toBe("kyberswap");
    expect(client.call).toHaveBeenNthCalledWith(1, expect.objectContaining({ to: uniswapTarget }));
    expect(client.call).toHaveBeenNthCalledWith(2, expect.objectContaining({ to: kyberTarget }));
  });

  it("restores a V4 quote token and pair from burned-position metadata", async () => {
    const database = { repairPositionAssets: vi.fn(), setPositionStatus: vi.fn() };
    const chains = { getById: vi.fn(() => ({ registry: { name: "robinhood" } })) };
    const notifier = { failure: vi.fn() };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, notifier as never, config);
    const position: PositionRecord = {
      id: "position",
      chainId: 4663,
      protocol: "v4",
      positionKey: "31470",
      owner,
      poolAddress: null,
      token0: "0x" as Address,
      token1: "0x" as Address,
      quoteToken: null,
      status: "closing",
      liquidity: null,
      openedAtBlock: null,
      metadata: { currency0: usdg, currency1: token },
    };

    const recovered = await (executor as unknown as { recoverSettlementPosition(value: PositionRecord): Promise<PositionRecord | null> }).recoverSettlementPosition(position);

    expect(recovered).toMatchObject({ token0: usdg, token1: token, quoteToken: usdg });
    expect(database.repairPositionAssets).toHaveBeenCalledWith("position", usdg, token, usdg);
    expect(database.setPositionStatus).not.toHaveBeenCalled();
  });

  it("reads native ETH with getBalance instead of ERC-20 balanceOf", async () => {
    const client = { getBalance: vi.fn().mockResolvedValue(123n), readContract: vi.fn() };
    const chains = { getById: vi.fn(() => ({ client, registry: { name: "robinhood" } })) };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, config);

    const balance = await (executor as unknown as {
      assetBalance(chainId: number, account: Address, tokenAddress: Address): Promise<bigint>;
    }).assetBalance(4663, owner, zeroAddress);

    expect(balance).toBe(123n);
    expect(client.getBalance).toHaveBeenCalledWith({ address: owner });
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("excludes confirmed gas from native ETH settlement PnL", async () => {
    const database = { setPositionStatus: vi.fn(), getPositionMetadata: vi.fn().mockResolvedValue({ preCloseQuoteBalance: "1000", settlementGasWei: "15" }) };
    const client = { getBalance: vi.fn().mockResolvedValue(1_085n) };
    const chains = { getById: vi.fn(() => ({ client, registry: { name: "robinhood" } })) };
    const routes = { quoteDirect: vi.fn().mockResolvedValue(null) };
    const executor = new Executor(database as never, chains as never, {} as never, routes as never, {} as never, config);
    const position: PositionRecord = {
      id: "position",
      chainId: 4663,
      protocol: "v4",
      positionKey: "1",
      owner,
      poolAddress: null,
      token0: zeroAddress,
      token1: token,
      quoteToken: zeroAddress,
      status: "closing",
      liquidity: null,
      openedAtBlock: null,
      metadata: {},
    };

    await (executor as unknown as { saveSettlementBalance(value: PositionRecord): Promise<void> }).saveSettlementBalance(position);

    expect(database.setPositionStatus).toHaveBeenCalledWith("position", "closing", expect.objectContaining({ totalReceived: "100" }));
  });

  it("keeps native ETH gas in PnL when configured", async () => {
    const database = { setPositionStatus: vi.fn(), getPositionMetadata: vi.fn().mockResolvedValue({ preCloseQuoteBalance: "1000", settlementGasWei: "15" }) };
    const client = { getBalance: vi.fn().mockResolvedValue(1_085n) };
    const chains = { getById: vi.fn(() => ({ client, registry: { name: "robinhood" } })) };
    const routes = { quoteDirect: vi.fn().mockResolvedValue(null) };
    const executor = new Executor(database as never, chains as never, {} as never, routes as never, {} as never, { ...config, pnlIncludeGas: true });
    const position: PositionRecord = {
      id: "position",
      chainId: 4663,
      protocol: "v4",
      positionKey: "1",
      owner,
      poolAddress: null,
      token0: zeroAddress,
      token1: token,
      quoteToken: zeroAddress,
      status: "closing",
      liquidity: null,
      openedAtBlock: null,
      metadata: {},
    };

    await (executor as unknown as { saveSettlementBalance(value: PositionRecord): Promise<void> }).saveSettlementBalance(position);

    expect(database.setPositionStatus).toHaveBeenCalledWith("position", "closing", expect.objectContaining({ totalReceived: "85" }));
  });

  it("persists receipt-confirmed swap output before a position can settle", async () => {
    const database = { setPositionStatus: vi.fn(), getPositionMetadata: vi.fn().mockResolvedValue({ settlementQuoteFromClose: "10" }) };
    const chains = { getById: vi.fn(() => ({ registry: { name: "robinhood" } })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, config);
    vi.spyOn(executor as any, "quoteOutputFromReceipt").mockResolvedValue(5n);
    const position = {
      id: "position", chainId: 4663, protocol: "v3", positionKey: "1", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    await (executor as unknown as { saveSettlementBalance(value: PositionRecord, expected: bigint, hash: `0x${string}`): Promise<void> })
      .saveSettlementBalance(position, 0n, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    expect(database.setPositionStatus).toHaveBeenCalledWith("position", "closing", {
      totalReceived: "15",
      settlementUsd: "15",
    });
  });

  it("uses receipt-accounted quote proceeds for a close that needs no swap", async () => {
    const database = {
      setPositionStatus: vi.fn(),
      getPositionMetadata: vi.fn().mockResolvedValue({
        closeReceiptAccounted: true,
        settlementQuoteFromClose: "23",
        preCloseQuoteBalance: "1000",
      }),
    };
    const client = { readContract: vi.fn().mockResolvedValue(999_999n) };
    const chains = { getById: vi.fn(() => ({ client, registry: { name: "robinhood" } })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, config);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    await (executor as unknown as { saveSettlementBalance(value: PositionRecord): Promise<void> }).saveSettlementBalance(position);

    expect(database.setPositionStatus).toHaveBeenCalledWith("position", "closing", {
      totalReceived: "23",
      settlementUsd: "23",
    });
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("swaps only the amount received by the closing position", async () => {
    vi.useFakeTimers();
    const database = {
      claimSettlementLease: vi.fn().mockResolvedValue(true),
      releaseSettlementLease: vi.fn(),
      getPositionMetadata: vi.fn().mockResolvedValue({ pendingSwap: { token, amount: "5" } }),
      getSubmittedSwapAttempt: vi.fn().mockResolvedValue(null),
      recordExecution: vi.fn(),
      setPositionStatusUnlessSettled: vi.fn(),
    };
    const client = { readContract: vi.fn().mockResolvedValue(100n) };
    const chains = { getById: vi.fn(() => ({ client, registry: { name: "robinhood" } })) };
    const routes = { quoteDirect: vi.fn().mockResolvedValue(null) };
    const notifier = { failure: vi.fn() };
    const executor = new Executor(database as never, chains as never, {} as never, routes as never, notifier as never, config);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: { pendingSwap: { token, amount: "5" } },
    } as PositionRecord;

    try {
      await expect(executor.resume(position)).resolves.toBeUndefined();
      expect(routes.quoteDirect).toHaveBeenCalledWith(position, token, 5n, usdg);
      expect(database.setPositionStatusUnlessSettled).toHaveBeenCalledWith("position", "closing", expect.objectContaining({
        settlementRetryDisabled: null,
        swapRetry: expect.objectContaining({ planningFailures: 1, cycleBroadcastAttempts: 0 }),
      }));
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("stops retrying when the pending token was moved externally after a failed cycle", async () => {
    const metadata = {
      pendingSwap: { token, amount: "5" },
      closeReceiptAccounted: true,
      swapRetry: { broadcastAttempts: 2, planningFailures: 0, cycleBroadcastAttempts: 0 },
    };
    const database = {
      claimSettlementLease: vi.fn().mockResolvedValue(true),
      releaseSettlementLease: vi.fn(),
      getPositionMetadata: vi.fn().mockResolvedValue(metadata),
      getSubmittedSwapAttempt: vi.fn().mockResolvedValue(null),
      setPositionStatusUnlessSettled: vi.fn(),
    };
    const client = { readContract: vi.fn().mockResolvedValue(0n) };
    const chains = { getById: vi.fn(() => ({ client, registry: { name: "robinhood" } })) };
    const routes = { quoteDirect: vi.fn() };
    const executor = new Executor(database as never, chains as never, {} as never, routes as never, {} as never, config);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata,
    } as PositionRecord;

    await executor.resume(position);

    expect(database.setPositionStatusUnlessSettled).toHaveBeenCalledWith("position", "needs_review", {
      reason: "pending swap token is no longer held — position externally settled",
      settlementRetryDisabled: true,
    });
    expect(routes.quoteDirect).not.toHaveBeenCalled();
  });

  it("runs only one settlement worker per position", async () => {
    let releaseWork!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWork = resolve; });
    const database = {
      claimSettlementLease: vi.fn().mockResolvedValue(true),
      releaseSettlementLease: vi.fn(),
    };
    const executor = new Executor(database as never, {} as never, {} as never, {} as never, {} as never, config);
    const work = vi.fn(async () => gate);
    const run = (executor as unknown as { runSettlementExclusive(id: string, task: () => Promise<void>): Promise<void> }).runSettlementExclusive.bind(executor);

    const first = run("position", work);
    const second = run("position", work);
    expect(second).toBe(first);
    releaseWork();
    await Promise.all([first, second]);

    expect(work).toHaveBeenCalledTimes(1);
    expect(database.claimSettlementLease).toHaveBeenCalledTimes(1);
    expect(database.releaseSettlementLease).toHaveBeenCalledTimes(1);
  });

  it("rejects a confirmed swap without a measurable quote output", async () => {
    const database = { setPositionStatus: vi.fn(), getPositionMetadata: vi.fn().mockResolvedValue({ settlementQuoteFromClose: "10" }) };
    const chains = { getById: vi.fn(() => ({ registry: { name: "robinhood" } })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, config);
    vi.spyOn(executor as any, "quoteOutputFromReceipt").mockResolvedValue(0n);
    const position = {
      id: "position", chainId: 4663, protocol: "v3", positionKey: "1", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    await expect((executor as unknown as { saveSettlementBalance(value: PositionRecord, expected: bigint, hash: `0x${string}`): Promise<void> })
      .saveSettlementBalance(position, 0n, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
      .rejects.toThrow("no quote-token output");
    expect(database.setPositionStatus).not.toHaveBeenCalled();
  });

  it("persists each confirmed native settlement gas cost", async () => {
    const database = { setPositionStatus: vi.fn() };
    const executor = new Executor(database as never, {} as never, {} as never, {} as never, {} as never, config);
    const position: PositionRecord = {
      id: "position",
      chainId: 4663,
      protocol: "v4",
      positionKey: "1",
      owner,
      poolAddress: null,
      token0: zeroAddress,
      token1: token,
      quoteToken: zeroAddress,
      status: "closing",
      liquidity: null,
      openedAtBlock: null,
      metadata: { settlementGasWei: "15" },
    };

    await (executor as unknown as { recordNativeSettlementGas(value: PositionRecord, gasWei: bigint): Promise<void> }).recordNativeSettlementGas(position, 8n);

    expect(position.metadata).toMatchObject({ settlementGasWei: "23" });
    expect(database.setPositionStatus).toHaveBeenCalledWith("position", "closing", { settlementGasWei: "23" });
  });

  it("auto-settles a V3 position only from a full remove and collect transaction", async () => {
    const database = {
      getCashflowQuoteValue: vi.fn().mockResolvedValue(249978708n),
      setPositionStatus: vi.fn(),
      recordExecution: vi.fn(),
      finalizeCloseHistory: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      readContract: vi.fn().mockResolvedValue([0n, "0x", usdg, token, 10000, 0, 0, 0n, 0n, 0n, 0n, 0n]),
      getLogs: vi.fn()
        .mockResolvedValueOnce([{ transactionHash: hash, blockNumber: 100n, args: { tokenId: 207488n, liquidity: 1n } }])
        .mockResolvedValueOnce([{ transactionHash: hash, blockNumber: 100n, args: { tokenId: 207488n, recipient: owner, amount0: 1n, amount1: 2n } }]),
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
    };
    const chains = {
      getById: vi.fn(() => ({
        client,
        registry: { contracts: { v3: { positionManager: "0x0000000000000000000000000000000000000001" } } },
      })),
    };
    const notifier = { settled: vi.fn() };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, notifier as never, config);
    const position = {
      id: "position", chainId: 4663, protocol: "v3", positionKey: "207488", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "needs_review", liquidity: 1n,
      openedAtBlock: 1n, metadata: {},
    } as PositionRecord;

    await expect(executor.autoSettleZeroLiquidityV3("robinhood", position)).resolves.toBe(true);
    expect(database.setPositionStatus).toHaveBeenCalledWith("position", "settled", expect.objectContaining({
      totalReceived: "249978708",
      closeTransactionHash: hash,
    }));
    expect(database.recordExecution).toHaveBeenCalledWith("position", "remove_liquidity", "confirmed", hash);
    expect(notifier.settled).toHaveBeenCalledWith(position);
  });
});
