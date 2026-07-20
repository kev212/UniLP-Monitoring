import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, pad, stringToHex, zeroAddress, type Address, type Hex } from "viem";

import type { RuntimeConfig } from "../src/config.js";
import { Executor, nextExitRetry, receiptErc20NetReceived } from "../src/services/executor.js";
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
  quoteTokens: { base: [], robinhood: [{ symbol: "USDG", address: usdg }] },
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
    const chains = { getById: vi.fn(() => ({ client })) };
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

  it("derives native proceeds at the receipt block and restores transaction gas", async () => {
    const client = {
      getBalance: vi.fn()
        .mockResolvedValueOnce(1_000n)
        .mockResolvedValueOnce(1_085n),
      getTransaction: vi.fn().mockResolvedValue({ value: 0n }),
    };
    const chains = { getById: vi.fn(() => ({ client })) };
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
    const chains = { getById: vi.fn(() => ({ client })) };
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
    const database = { recordExecution: vi.fn(), setPositionStatus: vi.fn() };
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

    await expect(executor.resume(position)).rejects.toThrow("No safe route");
    expect(routes.quoteDirect).toHaveBeenCalledWith(position, token, 5n, usdg);
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
