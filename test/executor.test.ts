import { describe, expect, it, vi } from "vitest";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, keccak256, pad, stringToHex, toFunctionSelector, toHex, zeroAddress, type Address, type Hex } from "viem";

import { v3PositionManagerAbi, v4PositionManagerAbi } from "../src/abi.js";
import type { RuntimeConfig } from "../src/config.js";
import { PANCAKE_PERMIT2 } from "../src/services/pancake-universal-router.js";
import { isRpcRateLimited } from "../src/rpc.js";
import { allowsZeroMinimumGroupClose, bufferedGasLimit, Executor, TransientCloseError, effectiveRemoveSlippageBps, effectiveSettlementSlippageBps, groupSettlementPosition, isTransientRpcError, nextExitRetry, nextSwapRetry, permit2AllowanceReady, receiptErc20NetReceived } from "../src/services/executor.js";
import type { PositionGroupBinRecord, PositionGroupRecord, PositionRecord } from "../src/types.js";

const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const weth = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
const token = "0xd7321801caae694090694ff55a9323139f043b88" as const;
const nvda = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" as const;
const owner = "0xeE924367213Ae3764b57d5b9a6214c8188d34060" as const;
const sender = "0x0000000000000000000000000000000000000002" as const;
const hash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const unwrapHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const groupId = "group";
const groupManager = "0x0000000000000000000000000000000000000100" as Address;
const groupPool = "0x0000000000000000000000000000000000000200" as Address;
const Q96 = 1n << 96n;
const v4StateView = "0x00000000000000000000000000000000000000aa" as Address;

function v4Registry(name: "robinhood" | "bsc" | "base", extra: Record<string, unknown> = {}) {
  return { name, contracts: { v4: { stateView: v4StateView, permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3", ...extra } } };
}

function markReadContract(callImpl?: (input: { functionName: string; args?: unknown[] }) => unknown) {
  return vi.fn(async (input: { functionName: string; args?: unknown[] }) => {
    if (input.functionName === "getSlot0" || input.functionName === "slot0") return [Q96, 0, 0, 0];
    if (callImpl) return callImpl(input);
    if (input.functionName === "allowance") return (input.args?.length ?? 0) === 3 ? [10n ** 30n, 4_000_000_000] : 10n ** 30n;
    return 10n ** 30n;
  });
}

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

function nftBurnLog(tokenAddress: Address, from: Address, tokenId: bigint) {
  return {
    address: tokenAddress,
    topics: [
      keccak256(stringToHex("Transfer(address,address,uint256)")),
      pad(from, { size: 32 }),
      pad(zeroAddress, { size: 32 }),
      pad(toHex(tokenId), { size: 32 }),
    ] as Hex[],
    data: "0x" as Hex,
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
  settlementMaxImpactBps: 1_500,
  swapGasLimitMultiplierPercent: 300,
  removeLiquiditySlippageBps: 200,
  removeLiquidityMaxSlippageBps: 500,
  confirmations: 1,
} as RuntimeConfig;

const wethConfig = {
  ...config,
  quoteTokens: { base: [], robinhood: [{ symbol: "USDG", address: usdg }, { symbol: "WETH", address: weth }] },
} as RuntimeConfig;

function groupRecord(protocol: "v3" | "v4" = "v3"): PositionGroupRecord {
  return {
    id: groupId,
    chainId: 4663,
    protocol,
    positionManager: groupManager,
    poolKey: groupPool,
    owner,
    token0: usdg,
    token1: token,
    quoteToken: usdg,
    shape: "bid_ask",
    shapeVersion: "delta-amount-linear-v1",
    requestedBinCount: 2,
    generatedBinCount: 2,
    mintableBinCount: 2,
    outerTickLower: -120,
    outerTickUpper: 0,
    anchorBinIndex: 0,
    totalDeposit: 100n,
    deployedCostQuote: 100n,
    directCloseAmount0: 0n,
    directCloseAmount1: 0n,
    totalReceivedQuote: 0n,
    status: "active",
    planHash: "plan",
    planJson: {},
    referenceBlock: 100n,
    referenceTick: -100,
    referencePrice: 1n,
    openTransactionHash: null,
    closeTransactionHash: null,
    pendingRawTransaction: null,
    executionLeaseToken: null,
    executionLeaseUntil: null,
    finalPnlQuote: null,
    finalPnlBps: null,
    finalPnlUsd: null,
    settledAt: null,
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function groupBin(index: number, tokenId: bigint, positionId: string, lower: number, upper: number): PositionGroupBinRecord {
  return {
    id: `bin-${index}`,
    groupId,
    chainId: 4663,
    positionManager: groupManager,
    binIndex: index,
    tickLower: lower,
    tickUpper: upper,
    side: "token0",
    weightMicros: 1,
    allocatedAmount0: 50n,
    allocatedAmount1: 0n,
    expectedLiquidity: 10n,
    expectedAmount0: 50n,
    expectedAmount1: 0n,
    tokenId,
    positionId,
    openingAmount0: 50n,
    openingAmount1: 0n,
    closeAmount0: 0n,
    closeAmount1: 0n,
    settlementQuote: 0n,
    status: "minted",
    dropReason: null,
    openTransactionHash: null,
    closeTransactionHash: null,
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function groupChild(id: string, tokenId: bigint): PositionRecord {
  return {
    id,
    chainId: 4663,
    protocol: "v3",
    positionKey: tokenId.toString(),
    owner,
    poolAddress: groupPool,
    token0: usdg,
    token1: token,
    quoteToken: usdg,
    status: "armed",
    liquidity: 10n,
    openedAtBlock: 90n,
    metadata: { positionGroupId: groupId },
  };
}

function v4GroupChild(id: string, tokenId: bigint): PositionRecord {
  return {
    ...groupChild(id, tokenId),
    protocol: "v4",
    poolAddress: null,
    metadata: { positionGroupId: groupId },
  };
}

function relatedPosition(
  id: string,
  token0: Address = usdg,
  token1: Address = token,
  quoteToken: Address = usdg,
  status: PositionRecord["status"] = "armed",
  metadata: Record<string, unknown> = {},
): PositionRecord {
  return {
    id,
    chainId: 4663,
    protocol: "v3",
    positionKey: id,
    owner,
    poolAddress: groupPool,
    token0,
    token1,
    quoteToken,
    status,
    liquidity: 10n,
    openedAtBlock: 90n,
    metadata,
  };
}

function groupValue(lower: number, upper: number, liquidity = 10n) {
  return {
    protocol: "v3" as const,
    poolKey: groupPool,
    sourcePool: groupPool,
    token0: { token: usdg, amount: 50n },
    token1: { token, amount: 0n },
    liquidity,
    priceMarker: 1n,
    v3Fee: 500,
    minAmount0: 40n,
    minAmount1: 0n,
    range: { tickLower: lower, tickUpper: upper, currentTick: -200, currentSqrtPrice: 1n, status: "below" as const },
    unclaimedFees0: 1n,
    unclaimedFees1: 0n,
    observedBlock: 100n,
  };
}

function v4GroupValue(lower: number, upper: number, liquidity = 10n) {
  return {
    protocol: "v4" as const,
    poolKey: groupPool,
    sourcePool: null,
    token0: { token: usdg, amount: 50n },
    token1: { token, amount: 0n },
    liquidity,
    priceMarker: 1n,
    minAmount0: 40n,
    minAmount1: 30n,
    v4PoolKey: { currency0: usdg, currency1: token, fee: 500, tickSpacing: 10, hooks: zeroAddress },
    range: { tickLower: lower, tickUpper: upper, currentTick: -200, currentSqrtPrice: 1n, status: "below" as const },
    unclaimedFees0: 1n,
    unclaimedFees1: 0n,
    observedBlock: 100n,
  };
}

describe("Executor pending settlement recovery", () => {
  it("encodes stored remove-liquidity hook data for a hooked V4 close", () => {
    const executor = new Executor({} as never, { getById: vi.fn(() => ({ registry: { contracts: { v4: { positionManager: groupManager } } } })) } as never, {} as never, {} as never, {} as never, config);
    const hookData = "0x1234" as Hex;
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "123", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "armed", liquidity: 10n, openedAtBlock: 1n,
      metadata: { removeLiquidityHookData: hookData },
    } as PositionRecord;
    const plan = (executor as any).closePlan(position, v4GroupValue(-100, 100));
    const decoded = decodeFunctionData({ abi: v4PositionManagerAbi, data: plan.data });
    const [, inputs] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], decoded.args[0]);
    const [, , , encodedHookData] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
      inputs[0]!,
    );

    expect(encodedHookData).toBe(hookData);
  });

  it("unwraps only a WETH quote settlement and leaves USDG and native ETH unchanged", async () => {
    const database = {
      getPositionMetadata: vi.fn().mockResolvedValue({}),
      setPositionStatusUnlessSettled: vi.fn(),
    };
    const chains = { getById: vi.fn(() => ({ registry: { name: "robinhood" } })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, {
      ...config,
      quoteTokens: { ...config.quoteTokens, robinhood: [{ symbol: "USDG", address: usdg }, { symbol: "WETH", address: weth }] },
    });
    const send = vi.spyOn(executor as any, "send").mockResolvedValue(hash);
    const base = {
      id: "position", chainId: 4663, protocol: "v3", positionKey: "1", owner, poolAddress: null,
      token0: token, token1: weth, status: "closing", liquidity: null, openedAtBlock: null, metadata: {},
    } as const;

    await expect((executor as any).unwrapWethQuote({ ...base, quoteToken: weth }, 42n)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ quoteToken: weth }), "unwrap_quote", expect.objectContaining({ to: weth, description: "unwrap_quote" }));

    send.mockClear();
    await expect((executor as any).unwrapWethQuote({ ...base, quoteToken: usdg }, 42n)).resolves.toBe(true);
    await expect((executor as any).unwrapWethQuote({ ...base, quoteToken: zeroAddress }, 42n)).resolves.toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("settles an inactive V4 NFT as externally closed when liquidity is already zero", async () => {
    const database = {
      recoverVerifiedSettlement: vi.fn().mockResolvedValue(false),
      settleUnverifiedZeroLiquidity: vi.fn().mockResolvedValue(true),
    };
    const readContract = vi.fn()
      .mockResolvedValueOnce(owner)
      .mockResolvedValueOnce(0n);
    const chains = {
      getById: vi.fn(() => ({
        client: { readContract },
        registry: { name: "bsc", contracts: { v4: { positionManager: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b" } } },
      })),
    };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, { settled: vi.fn() } as never, config);
    vi.spyOn(executor, "autoSettleZeroLiquidityV4").mockResolvedValue(false);
    const position = {
      id: "position", chainId: 56, protocol: "v4", positionKey: "99", owner, poolAddress: null,
      token0: token, token1: usdg, quoteToken: usdg, status: "needs_review", liquidity: 0n, openedAtBlock: 1n,
      metadata: { reason: "on_chain_liquidity_zero_unverified" },
    } as PositionRecord;

    await expect(executor.settleExternallyClosedV4(position)).resolves.toBe(true);
    expect(database.settleUnverifiedZeroLiquidity).toHaveBeenCalledWith("position", "externally_closed");
  });

  it("does not settle a V4 NFT from a single NOT_MINTED response", async () => {
    const database = {
      recoverVerifiedSettlement: vi.fn().mockResolvedValue(false),
      settleUnverifiedZeroLiquidity: vi.fn().mockResolvedValue(true),
    };
    const executionClient = {
      readContract: vi.fn().mockRejectedValue(new Error("execution reverted: NOT_MINTED")),
    };
    const chains = {
      getById: vi.fn(() => ({
        client: executionClient,
        registry: { name: "robinhood", contracts: { v4: { positionManager: groupManager } } },
      })),
      getForExecution: vi.fn(() => ({ client: executionClient })),
    };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, { settled: vi.fn() } as never, config);
    vi.spyOn(executor, "autoSettleZeroLiquidityV4").mockResolvedValue(false);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "99", owner, poolAddress: null,
      token0: token, token1: usdg, quoteToken: usdg, status: "needs_review", liquidity: 10n, openedAtBlock: 1n,
      metadata: { reason: "nft_burned_unverified" },
    } as PositionRecord;

    await expect(executor.settleExternallyClosedV4(position)).resolves.toBe(false);
    expect(database.settleUnverifiedZeroLiquidity).not.toHaveBeenCalled();
  });

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
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
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
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
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
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
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

  it("uses the dedicated scan fallback when execution and normal receipt providers lag", async () => {
    const receipt = { status: "success", blockNumber: 100n, logs: [] };
    const executionClient = { getTransactionReceipt: vi.fn().mockRejectedValue(new Error("invalid params")) };
    const normalClient = { getTransactionReceipt: vi.fn().mockRejectedValue(new Error("lagging RPC")) };
    const fallbackClient = { getTransactionReceipt: vi.fn().mockResolvedValue(receipt) };
    const chains = {
      getById: vi.fn(() => ({ client: normalClient, registry: { name: "robinhood" } })),
      getForExecution: vi.fn(() => ({ client: executionClient, registry: { name: "robinhood" } })),
      getForScanFallback: vi.fn(() => ({ client: fallbackClient, registry: { name: "robinhood" } })),
    };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, { ...config, confirmations: 1 });

    await expect((executor as unknown as {
      getConfirmedReceipt(chainId: number, transactionHash: Hex): Promise<unknown>;
    }).getConfirmedReceipt(4663, hash)).resolves.toBe(receipt);

    expect(executionClient.getTransactionReceipt).toHaveBeenCalledOnce();
    expect(fallbackClient.getTransactionReceipt).toHaveBeenCalledOnce();
    expect(normalClient.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("derives native proceeds at the receipt block and restores transaction gas", async () => {
    const client = {
      getBalance: vi.fn()
        .mockResolvedValueOnce(1_000n)
        .mockResolvedValueOnce(1_085n),
      getTransaction: vi.fn().mockResolvedValue({ value: 0n }),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, config);
    const receipt = { blockNumber: 100n, gasUsed: 5n, effectiveGasPrice: 3n, logs: [] };

    await expect((executor as unknown as {
      assetReceivedFromReceipt(chainId: number, tokenAddress: Address, account: Address, transactionHash: Hex, value: unknown): Promise<bigint>;
    }).assetReceivedFromReceipt(4663, zeroAddress, owner, hash, receipt)).resolves.toBe(100n);
    expect(client.getBalance).toHaveBeenNthCalledWith(1, { address: owner, blockNumber: 99n });
    expect(client.getBalance).toHaveBeenNthCalledWith(2, { address: owner, blockNumber: 100n });
  });

  it("counts native ETH outflows when auto-settling a V4 burn", async () => {
    const database = {
      addCashflow: vi.fn(),
      recordExecution: vi.fn(),
      setPositionStatus: vi.fn(),
      finalizeCloseHistory: vi.fn().mockResolvedValue(undefined),
    };
    const notifier = { settled: vi.fn() };
    const receipt = { status: "success", blockNumber: 100n, gasUsed: 5n, effectiveGasPrice: 3n, logs: [] };
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      getBalance: vi.fn().mockResolvedValueOnce(1_000n).mockResolvedValueOnce(1_085n),
      getTransaction: vi.fn().mockResolvedValue({ value: 0n }),
      readContract: vi.fn().mockResolvedValue([1n << 96n, 0]),
    };
    const poolManager = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address;
    const chains = {
      getById: vi.fn(() => ({
        client,
        registry: {
          name: "robinhood",
          nativeSymbol: "ETH",
          wrappedSymbol: "WETH",
          contracts: { v4: { poolManager, positionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7", stateView: "0x00000000000000000000000000000000000000aa" } },
        },
      })),
    };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, notifier as never, config);
    vi.spyOn(executor as any, "findV4WithdrawalEvent").mockResolvedValue({ transactionHash: hash, blockNumber: 100n });
    vi.spyOn(executor as any, "wethQuoteToken").mockReturnValue(null);
    vi.spyOn(executor as any, "computeEthUsd").mockResolvedValue(2_030_000_000n);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "770179", owner, poolAddress: null,
      token0: zeroAddress, token1: token, quoteToken: zeroAddress, status: "needs_review", liquidity: 0n,
      openedAtBlock: 1n,
      metadata: { salt: hash, currency0: zeroAddress, currency1: token, fee: 49900, tickSpacing: 200, hooks: zeroAddress },
    } as PositionRecord;

    await expect(executor.autoSettleZeroLiquidityV4("robinhood", position)).resolves.toBe(true);
    expect(database.addCashflow).toHaveBeenCalledWith("position", 100n, hash, "withdrawal", 100n, expect.objectContaining({ token0Amount: "100", token1Amount: "0" }));
    expect(database.setPositionStatus).toHaveBeenCalledWith("position", "settled", expect.objectContaining({
      totalReceived: "100",
      settlementUsd: "2030000000",
    }));
    expect(notifier.settled).toHaveBeenCalled();
  });

  it("does not auto-settle a V4 burn when no token outflows can be reconstructed", async () => {
    const database = { addCashflow: vi.fn(), setPositionStatus: vi.fn() };
    const receipt = { status: "success", blockNumber: 100n, logs: [] };
    const client = { getTransactionReceipt: vi.fn().mockResolvedValue(receipt) };
    const chains = {
      getById: vi.fn(() => ({
        client,
        registry: { name: "robinhood", contracts: { v4: { poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" } } },
      })),
    };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, { settled: vi.fn() } as never, config);
    vi.spyOn(executor as any, "findV4WithdrawalEvent").mockResolvedValue({ transactionHash: hash, blockNumber: 100n });
    vi.spyOn(executor as any, "assetReceivedFromReceipt").mockResolvedValue(0n);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1", owner, poolAddress: null,
      token0: zeroAddress, token1: token, quoteToken: zeroAddress, status: "needs_review", liquidity: 0n,
      openedAtBlock: 1n, metadata: { salt: hash },
    } as PositionRecord;

    await expect(executor.autoSettleZeroLiquidityV4("robinhood", position)).resolves.toBe(false);
    expect(database.setPositionStatus).not.toHaveBeenCalled();
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

    expect(effectiveSettlementSlippageBps(200, 500, { broadcastAttempts: 0, planningFailures: 3 })).toBe(500);
    expect(effectiveSettlementSlippageBps(200, 500, { broadcastAttempts: 1, planningFailures: 0 })).toBe(300);
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

  it("approves max for non-protected tokens without reset and skips when sufficient", async () => {
    const client = { readContract: vi.fn().mockResolvedValue(0n) };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, config);
    const send = vi.spyOn(executor as any, "send").mockResolvedValue(hash);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    const changed = await (executor as unknown as { ensureApproval(p: PositionRecord, t: Address, s: Address, a: bigint, st: string): Promise<boolean> })
      .ensureApproval(position, token, sender, 100n, "approve_swap");
    expect(changed).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);

    send.mockClear();
    client.readContract.mockResolvedValue((1n << 256n) - 1n);
    const skipped = await (executor as unknown as { ensureApproval(p: PositionRecord, t: Address, s: Address, a: bigint, st: string): Promise<boolean> })
      .ensureApproval(position, token, sender, 100n, "approve_swap");
    expect(skipped).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("approves exact for protected quote tokens with reset when amount differs", async () => {
    const client = { readContract: vi.fn().mockResolvedValue(50n) };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, config);
    const send = vi.spyOn(executor as any, "send").mockResolvedValue(hash);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1", owner, poolAddress: null,
      token0: token, token1: usdg, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    await (executor as unknown as { ensureApproval(p: PositionRecord, t: Address, s: Address, a: bigint, st: string): Promise<boolean> })
      .ensureApproval(position, usdg, sender, 100n, "approve_swap");
    expect(send).toHaveBeenCalledWith(expect.anything(), "approve_swap_reset", expect.anything());
  });

  it("finds a V4 manual withdrawal with chunked unfiltered log queries", async () => {
    const salt = "0x000000000000000000000000000000000000000000000000000000000005bab3" as const;
    const poolManager = "0x0000000000000000000000000000000000000003" as const;
    const positionManager = "0x0000000000000000000000000000000000000004" as const;
    const event = {
      args: { sender: positionManager, salt, liquidityDelta: -1n },
      transactionHash: hash,
      blockNumber: 2_500n,
    };
    const scanClient = {
      getBlockNumber: vi.fn().mockResolvedValue(3_000n),
    };
    const logClient = {
      getLogs: vi.fn().mockResolvedValue([event]),
    };
    const chains = {
      getById: vi.fn(() => ({ registry: { name: "robinhood", contracts: { v4: { poolManager, positionManager } } } })),
      getForScan: vi.fn(() => ({ client: scanClient })),
      getForLogs: vi.fn(() => ({ client: logClient })),
    };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, config);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "375475", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "needs_review", liquidity: 0n,
      openedAtBlock: 1_000n, metadata: {},
    } as PositionRecord;

    const found = await (executor as unknown as { findV4WithdrawalEvent(value: PositionRecord, valueSalt: Hex): Promise<unknown> })
      .findV4WithdrawalEvent(position, salt);

    expect(found).toBe(event);
    expect(logClient.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 1_001n, toBlock: 3_000n }));
  });

  it("uses the chain client's failover client for executor calls", () => {
    const primaryClient = {};
    const scanClient = {};
    const executionClient = {};
    const chains = {
      getById: vi.fn(() => ({ client: primaryClient, registry: { name: "robinhood" } })),
      getForScan: vi.fn(() => ({ client: scanClient })),
      getForExecution: vi.fn(() => ({ client: executionClient })),
    };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, config);

    const selected = (executor as any).executorClient(4663);

    expect(selected).toBe(executionClient);
    expect(chains.getForExecution).toHaveBeenCalledWith("robinhood");
    expect(chains.getForScan).not.toHaveBeenCalled();
  });

  it("uses the public-first scan client for Base execution preflight reads", () => {
    const primaryClient = {};
    const scanClient = {};
    const executionClient = {};
    const chains = {
      getById: vi.fn(() => ({ client: primaryClient, registry: { name: "base" } })),
      getForScan: vi.fn(() => ({ client: scanClient })),
      getForExecution: vi.fn(() => ({ client: executionClient })),
    };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, config);

    const selected = (executor as any).executionReadClient(8453);

    expect(selected).toBe(scanClient);
    expect(chains.getForScan).toHaveBeenCalledWith("base");
    expect(chains.getForExecution).not.toHaveBeenCalled();
  });

  it("classifies provider rate limits and timeouts as transient RPC errors", () => {
    expect(isTransientRpcError(new Error("HTTP request failed: Status: 429 Too Many Requests"))).toBe(true);
    expect(isTransientRpcError(new Error("The operation was aborted due to timeout"))).toBe(true);
    expect(isTransientRpcError(new Error("Transaction receipt could not be found yet"))).toBe(true);
    expect(isTransientRpcError({ status: 429, message: "rate limited" })).toBe(true);
    expect(isTransientRpcError({ cause: { code: -32005, message: "resource unavailable" } })).toBe(true);
    expect(isTransientRpcError(new Error("unsupported block number 32436872"))).toBe(true);
    expect(isTransientRpcError(new Error("HTTP request failed.\nStatus: 530"))).toBe(true);
    expect(isTransientRpcError({ status: 530, message: "origin is unreachable" })).toBe(true);
    expect(isTransientRpcError(new Error("Execution reverted for an unknown reason"))).toBe(false);
    expect(isRpcRateLimited(new Error("HTTP request failed: Status: 429 Too Many Requests"))).toBe(true);
    expect(isRpcRateLimited({ status: 429, message: "rate limited" })).toBe(true);
    expect(isRpcRateLimited(new Error("The operation was aborted due to timeout"))).toBe(false);
  });

  it("quotes providers in parallel and selects the best simulated output", async () => {
    const client = {
      readContract: markReadContract(),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
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
    const routes = { quoteDirect: vi.fn().mockResolvedValue({ expectedOut: 105n }) };
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, config, tradingApi as never, kyberswapApi as never);
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

  it("uses KyberSwap as the native settlement benchmark", async () => {
    const client = {
      readContract: markReadContract(),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const kyberQuote = { source: "kyberswap", expectedOut: 110n, minimumOut: 107n, router: sender };
    const kyberswapApi = {
      quote: vi.fn().mockResolvedValue(kyberQuote),
      approvalSpender: vi.fn().mockReturnValue(sender),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: sender, data: "0x22", description: "kyber" }),
    };
    const routes = { quoteDirect: vi.fn().mockRejectedValue(new Error("native V4 quote is unsupported")) };
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, config, undefined, kyberswapApi as never);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1", owner, poolAddress: null,
      token0: zeroAddress, token1: token, quoteToken: zeroAddress, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    const prepared = await (executor as unknown as {
      prepareBestSettlementSwap(value: PositionRecord, tokenIn: Address, amount: bigint, tokenOut: Address, slippage: number): Promise<{ provider: string; expectedOut: bigint }>;
    }).prepareBestSettlementSwap(position, token, 5n, zeroAddress, 200);

    expect(prepared).toMatchObject({ provider: "kyberswap", expectedOut: 110n });
    expect(kyberswapApi.quote).toHaveBeenCalledTimes(1);
    expect(routes.quoteDirect).not.toHaveBeenCalled();
    expect(client.call).toHaveBeenCalledWith(expect.objectContaining({ data: "0x22" }));
  });

  it("uses KyberSwap as the BSC settlement benchmark when the local V4 quote is gone", async () => {
    const client = {
      readContract: markReadContract(),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("bsc") })) };
    const kyberQuote = { source: "kyberswap", expectedOut: 110n, minimumOut: 107n, router: sender };
    const kyberswapApi = {
      quote: vi.fn().mockResolvedValue(kyberQuote),
      approvalSpender: vi.fn().mockReturnValue(sender),
      createSwap: vi.fn().mockResolvedValue({ chainId: 56, to: sender, data: "0x22", description: "kyber" }),
    };
    const routes = { quoteDirect: vi.fn().mockResolvedValue(null) };
    const bscConfig = { ...config, quoteTokens: { ...config.quoteTokens, bsc: [{ symbol: "USDT", address: usdg }] } } as RuntimeConfig;
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, bscConfig, undefined, kyberswapApi as never);
    const position = {
      id: "position", chainId: 56, protocol: "v4", positionKey: "1056851", owner, poolAddress: null,
      token0: token, token1: usdg, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    const prepared = await (executor as unknown as {
      prepareBestSettlementSwap(value: PositionRecord, tokenIn: Address, amount: bigint, tokenOut: Address, slippage: number): Promise<{ provider: string; expectedOut: bigint }>;
    }).prepareBestSettlementSwap(position, token, 5n, usdg, 200);

    expect(prepared).toMatchObject({ provider: "kyberswap", expectedOut: 110n });
    expect(routes.quoteDirect).not.toHaveBeenCalled();
    expect(kyberswapApi.quote).toHaveBeenCalledTimes(1);
  });

  it("uses KyberSwap on BSC when the local V4 quote is optimistic but not executable", async () => {
    const ur = "0x1906c1d672b88cd1b9ac7593301ca990f94eae07" as Address;
    const client = {
      readContract: markReadContract(({ functionName, args }) => {
        if (functionName === "allowance") return (args?.length ?? 0) === 3 ? [10n ** 30n, 4_000_000_000] : 10n ** 30n;
        return 10n ** 30n;
      }),
      call: vi.fn(async ({ data }: { data: string }) => {
        if (data === "0x22") return { data: "0x" };
        throw new Error("execution reverted");
      }),
    };
    const chains = {
      getById: vi.fn(() => ({
        client,
        registry: v4Registry("bsc"),
      })),
    };
    const kyberQuote = { source: "kyberswap", expectedOut: 110n, minimumOut: 107n, router: sender };
    const kyberswapApi = {
      quote: vi.fn().mockResolvedValue(kyberQuote),
      approvalSpender: vi.fn().mockReturnValue(sender),
      createSwap: vi.fn().mockResolvedValue({ chainId: 56, to: sender, data: "0x22", description: "kyber" }),
    };
    const routes = {
      quoteDirect: vi.fn().mockResolvedValue({
        protocol: "v4",
        expectedOut: 200n,
        minimumOut: 196n,
        router: ur,
        tokenIn: token,
        tokenOut: usdg,
        path: [token, usdg],
        amountIn: 5n,
        pool: zeroAddress,
        pools: [],
      }),
    };
    const bscConfig = { ...config, quoteTokens: { ...config.quoteTokens, bsc: [{ symbol: "USDT", address: usdg }] } } as RuntimeConfig;
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, bscConfig, undefined, kyberswapApi as never);
    const position = {
      id: "position", chainId: 56, protocol: "v4", positionKey: "1059271", owner, poolAddress: null,
      token0: token, token1: usdg, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    const prepared = await (executor as unknown as {
      prepareBestSettlementSwap(value: PositionRecord, tokenIn: Address, amount: bigint, tokenOut: Address, slippage: number): Promise<{ provider: string; expectedOut: bigint }>;
    }).prepareBestSettlementSwap(position, token, 5n, usdg, 200);

    expect(prepared).toMatchObject({ provider: "kyberswap", expectedOut: 110n });
  });

  it("retries Kyber without the local V4 floor after an insufficient-return revert", async () => {
    const kyberTarget = "0x0000000000000000000000000000000000000005" as Address;
    const client = {
      readContract: markReadContract(({ functionName, args }) => {
        if (functionName === "allowance") return (args?.length ?? 0) === 3 ? [10n ** 30n, 4_000_000_000] : 10n ** 30n;
        return 10n ** 30n;
      }),
      call: vi.fn()
        .mockRejectedValueOnce(new Error("Return amount is not enough"))
        .mockResolvedValue({ data: "0x" }),
    };
    const chains = {
      getById: vi.fn(() => ({
        client,
        registry: v4Registry("bsc"),
      })),
    };
    const kyberswapApi = {
      quote: vi.fn().mockResolvedValue({ source: "kyberswap", expectedOut: 110n, minimumOut: 107n, router: kyberTarget, slippageBps: 200 }),
      approvalSpender: vi.fn().mockReturnValue(kyberTarget),
      createSwap: vi.fn().mockResolvedValue({ chainId: 56, to: kyberTarget, data: "0x22", description: "kyber" }),
    };
    const routes = {
      quoteDirect: vi.fn().mockResolvedValue({
        protocol: "v4",
        expectedOut: 500n,
        minimumOut: 490n,
        router: "0x1906c1d672b88cd1b9ac7593301ca990f94eae07",
        tokenIn: token,
        tokenOut: usdg,
        path: [token, usdg],
        amountIn: 5n,
        pool: zeroAddress,
        pools: [],
      }),
    };
    const bscConfig = { ...config, quoteTokens: { ...config.quoteTokens, bsc: [{ symbol: "USDT", address: usdg }] } } as RuntimeConfig;
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, bscConfig, undefined, kyberswapApi as never);
    const position = {
      id: "position", chainId: 56, protocol: "v4", positionKey: "1061958", owner, poolAddress: null,
      token0: token, token1: usdg, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    await expect((executor as unknown as {
      prepareBestSettlementSwap(value: PositionRecord, tokenIn: Address, amount: bigint, tokenOut: Address, slippage: number): Promise<{ provider: string }>;
    }).prepareBestSettlementSwap(position, token, 5n, usdg, 200)).rejects.toThrow("No executable settlement route");
    expect(kyberswapApi.createSwap).toHaveBeenCalledTimes(1);
  });

  it("uses KyberSwap as a non-BSC fallback when the local quote is gone", async () => {
    const client = {
      readContract: markReadContract(),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const kyberswapApi = {
      quote: vi.fn().mockResolvedValue({ source: "kyberswap", expectedOut: 110n, minimumOut: 107n, router: sender }),
      approvalSpender: vi.fn().mockReturnValue(sender),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: sender, data: "0x22", description: "kyber" }),
    };
    const routes = { quoteDirect: vi.fn().mockResolvedValue(null) };
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, config, undefined, kyberswapApi as never);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    const prepared = await (executor as unknown as {
      prepareBestSettlementSwap(value: PositionRecord, tokenIn: Address, amount: bigint, tokenOut: Address, slippage: number): Promise<{ provider: string; expectedOut: bigint }>;
    }).prepareBestSettlementSwap(position, token, 5n, usdg, 200);

    expect(prepared).toMatchObject({ provider: "kyberswap", expectedOut: 110n });
    expect(kyberswapApi.quote).toHaveBeenCalledTimes(1);
  });

  it("rejects an aggregator route below the local two-percent minimum floor", async () => {
    const client = {
      readContract: markReadContract(),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const tradingApi = {
      quote: vi.fn().mockResolvedValue({ routing: "CLASSIC", expectedOut: 100n, minimumOut: 98n, raw: {} }),
      approval: vi.fn().mockResolvedValue(null),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: sender, data: "0x11", description: "uniswap" }),
    };
    const kyberswapApi = {
      quote: vi.fn().mockResolvedValue({ source: "kyberswap", expectedOut: 1n, minimumOut: 0n, router: sender }),
      approvalSpender: vi.fn().mockReturnValue(sender),
      createSwap: vi.fn(),
    };
    const routes = { quoteDirect: vi.fn().mockResolvedValue({ expectedOut: 100n }) };
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, config, tradingApi as never, kyberswapApi as never);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "365091", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    const prepared = await (executor as unknown as {
      prepareBestSettlementSwap(value: PositionRecord, tokenIn: Address, amount: bigint, tokenOut: Address, slippage: number): Promise<{ provider: string; expectedOut: bigint }>;
    }).prepareBestSettlementSwap(position, token, 5n, usdg, 200);

    expect(prepared).toMatchObject({ provider: "uniswap", expectedOut: 100n });
    expect(kyberswapApi.approvalSpender).not.toHaveBeenCalled();
    expect(kyberswapApi.createSwap).not.toHaveBeenCalled();
  });

  it("keeps a Uniswap quote 2.4% below Kyber when adaptive slippage is 500 bps", async () => {
    const uniswapTarget = "0x0000000000000000000000000000000000000004" as Address;
    const kyberTarget = "0x0000000000000000000000000000000000000005" as Address;
    const client = {
      readContract: markReadContract(),
      call: vi.fn().mockImplementation(({ to }: { to: Address }) => to === kyberTarget
        ? Promise.reject(new Error("Return amount is not enough"))
        : Promise.resolve({ data: "0x" })),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const tradingApi = {
      quote: vi.fn().mockResolvedValue({ routing: "CLASSIC", expectedOut: 222n, minimumOut: 211n, raw: {}, slippageBps: 500 }),
      approval: vi.fn().mockResolvedValue(null),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: uniswapTarget, data: "0x11", description: "uniswap" }),
    };
    const kyberswapApi = {
      quote: vi.fn().mockResolvedValue({ source: "kyberswap", expectedOut: 228n, minimumOut: 216n, router: kyberTarget, slippageBps: 500 }),
      approvalSpender: vi.fn().mockReturnValue(kyberTarget),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: kyberTarget, data: "0x22", description: "kyber" }),
    };
    const routes = { quoteDirect: vi.fn().mockRejectedValue(new Error("V4 quote failed after retries")) };
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, config, tradingApi as never, kyberswapApi as never);
    const group = {
      ...groupRecord("v4"),
      token0: zeroAddress,
      token1: token,
      quoteToken: zeroAddress,
    };
    const pending = { token, amount: 5n };

    const prepared = await (executor as unknown as {
      prepareGroupSettlementSwap(
        value: PositionGroupRecord,
        position: PositionRecord,
        swap: { token: Address; amount: bigint },
        slippage: number,
      ): Promise<{ provider: string; expectedOut: bigint }>;
    }).prepareGroupSettlementSwap(group, groupSettlementPosition(group), pending, 500);

    expect(prepared).toMatchObject({ provider: "uniswap", expectedOut: 222n });
    expect(tradingApi.createSwap).toHaveBeenCalledTimes(1);
  });

  it("selects Uniswap for BOW/ETH after Kyber simulation reverts even at 200 bps", async () => {
    const uniswapTarget = "0x0000000000000000000000000000000000000004" as Address;
    const kyberTarget = "0x0000000000000000000000000000000000000005" as Address;
    const client = {
      readContract: markReadContract(),
      call: vi.fn().mockImplementation(({ to }: { to: Address }) => to === kyberTarget
        ? Promise.reject(new Error("Return amount is not enough"))
        : Promise.resolve({ data: "0x" })),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const tradingApi = {
      quote: vi.fn().mockResolvedValue({ routing: "CLASSIC", expectedOut: 222n, minimumOut: 217n, raw: {}, slippageBps: 200 }),
      approval: vi.fn().mockResolvedValue(null),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: uniswapTarget, data: "0x11", description: "uniswap" }),
    };
    const kyberswapApi = {
      quote: vi.fn().mockResolvedValue({ source: "kyberswap", expectedOut: 228n, minimumOut: 223n, router: kyberTarget, slippageBps: 200 }),
      approvalSpender: vi.fn().mockReturnValue(kyberTarget),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: kyberTarget, data: "0x22", description: "kyber" }),
    };
    const routes = { quoteDirect: vi.fn().mockRejectedValue(new Error("V4 quote failed after retries")) };
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, config, tradingApi as never, kyberswapApi as never);
    const group = {
      ...groupRecord("v4"),
      token0: zeroAddress,
      token1: token,
      quoteToken: zeroAddress,
    };

    const prepared = await (executor as unknown as {
      prepareGroupSettlementSwap(
        value: PositionGroupRecord,
        position: PositionRecord,
        swap: { token: Address; amount: bigint },
        slippage: number,
      ): Promise<{ provider: string; expectedOut: bigint }>;
    }).prepareGroupSettlementSwap(group, groupSettlementPosition(group), { token, amount: 5n }, 200);

    expect(prepared).toMatchObject({ provider: "uniswap", expectedOut: 222n });
    expect(kyberswapApi.createSwap).toHaveBeenCalledTimes(1);
    expect(tradingApi.createSwap).toHaveBeenCalledTimes(1);
  });

  it("deprioritizes Kyber on the next group retry after a deterministic simulation failure", async () => {
    const retry = nextSwapRetry({}, "kyberswap", false, 2, Date.now(), ["kyberswap"]);
    expect(retry.failedProviders).toEqual(["kyberswap"]);
    expect(retry.lastProvider).toBe("kyberswap");

    const uniswapTarget = "0x0000000000000000000000000000000000000004" as Address;
    const kyberTarget = "0x0000000000000000000000000000000000000005" as Address;
    const client = {
      readContract: markReadContract(),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const tradingApi = {
      quote: vi.fn().mockResolvedValue({ routing: "CLASSIC", expectedOut: 222n, minimumOut: 217n, raw: {}, slippageBps: 200 }),
      approval: vi.fn().mockResolvedValue(null),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: uniswapTarget, data: "0x11", description: "uniswap" }),
    };
    const kyberswapApi = {
      quote: vi.fn().mockResolvedValue({ source: "kyberswap", expectedOut: 228n, minimumOut: 223n, router: kyberTarget, slippageBps: 200 }),
      approvalSpender: vi.fn().mockReturnValue(kyberTarget),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: kyberTarget, data: "0x22", description: "kyber" }),
    };
    const routes = { quoteDirect: vi.fn().mockRejectedValue(new Error("V4 quote failed after retries")) };
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, config, tradingApi as never, kyberswapApi as never);
    const group = { ...groupRecord("v4"), token0: zeroAddress, token1: token, quoteToken: zeroAddress };

    const prepared = await (executor as unknown as {
      prepareGroupSettlementSwap(
        value: PositionGroupRecord,
        position: PositionRecord,
        swap: { token: Address; amount: bigint },
        slippage: number,
        lastFailed?: string,
        failed?: string[],
      ): Promise<{ provider: string }>;
    }).prepareGroupSettlementSwap(group, groupSettlementPosition(group), { token, amount: 5n }, 500, "kyberswap", ["kyberswap"]);

    expect(prepared.provider).toBe("uniswap");
    expect(kyberswapApi.createSwap).not.toHaveBeenCalled();
    expect(client.call).toHaveBeenCalledWith(expect.objectContaining({ to: uniswapTarget }));
  });

  it("tightens an API quote so its calldata minimum preserves the local floor", async () => {
    const client = {
      readContract: markReadContract(),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const tradingApi = {
      quote: vi.fn()
        .mockResolvedValueOnce({ routing: "CLASSIC", expectedOut: 99n, minimumOut: 97n, raw: {}, slippageBps: 200 })
        .mockResolvedValueOnce({ routing: "CLASSIC", expectedOut: 99n, minimumOut: 98n, raw: {}, slippageBps: 101 }),
      approval: vi.fn().mockResolvedValue(null),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: sender, data: "0x11", description: "uniswap" }),
    };
    const routes = { quoteDirect: vi.fn().mockResolvedValue({ expectedOut: 100n }) };
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, config, tradingApi as never);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "426429", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    const prepared = await (executor as unknown as {
      prepareBestSettlementSwap(value: PositionRecord, tokenIn: Address, amount: bigint, tokenOut: Address, slippage: number): Promise<{ provider: string; minimumOut: bigint }>;
    }).prepareBestSettlementSwap(position, token, 5n, usdg, 200);

    expect(prepared).toMatchObject({ provider: "uniswap", minimumOut: 97n });
    expect(tradingApi.quote).toHaveBeenCalledTimes(1);
  });

  it("falls back before broadcast when the best provider fails simulation", async () => {
    const uniswapTarget = "0x0000000000000000000000000000000000000004" as const;
    const kyberTarget = "0x0000000000000000000000000000000000000005" as const;
    const client = {
      readContract: markReadContract(),
      call: vi.fn().mockImplementation(({ to }: { to: Address }) => to === uniswapTarget
        ? Promise.reject(new Error("simulation reverted"))
        : Promise.resolve({ data: "0x" })),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
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
    const routes = { quoteDirect: vi.fn().mockResolvedValue({ expectedOut: 100n }) };
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, config, tradingApi as never, kyberswapApi as never);
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

  it("reuses a live Permit2 allowance instead of re-approving every cycle", () => {
    const now = 1_700_000_000;
    expect(permit2AllowanceReady([5n, now + 200], 5n, now)).toBe(true);
    expect(permit2AllowanceReady([5n, now + 30], 5n, now)).toBe(false);
    expect(permit2AllowanceReady([4n, now + 200], 5n, now)).toBe(false);
  });

  it("copies pancake dex onto Bid-Ask settlement positions", () => {
    const group = { ...groupRecord("v3"), chainId: 56, metadata: { dex: "pancake" } } as PositionGroupRecord;
    expect(groupSettlementPosition(group).metadata.dex).toBe("pancake");
  });

  it("settles pancake leftovers through Pancake UR or Kyber only", async () => {
    const pancakeTarget = "0x00000000000000000000000000000000000000aa" as Address;
    const kyberTarget = "0x00000000000000000000000000000000000000bb" as Address;
    const client = {
      readContract: markReadContract(({ functionName, args }) => {
        if (functionName === "allowance") return (args?.length ?? 0) === 3 ? [10n ** 30n, 4_000_000_000] : 10n ** 30n;
        return 10n ** 30n;
      }),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("bsc", { permit2: PANCAKE_PERMIT2 }) })) };
    const tradingApi = { quote: vi.fn(), createSwap: vi.fn() };
    const pancakeQuote = { source: "pancake-ur", expectedOut: 120n, minimumOut: 117n, router: pancakeTarget };
    const pancakeUr = {
      quote: vi.fn().mockResolvedValue(pancakeQuote),
      createSwap: vi.fn().mockReturnValue({ chainId: 56, to: pancakeTarget, data: "0x33", description: "pancake" }),
    };
    const kyberswapApi = {
      quote: vi.fn().mockResolvedValue({ source: "kyberswap", expectedOut: 110n, minimumOut: 107n, router: kyberTarget }),
      approvalSpender: vi.fn().mockReturnValue(kyberTarget),
      createSwap: vi.fn().mockResolvedValue({ chainId: 56, to: kyberTarget, data: "0x22", description: "kyber" }),
    };
    const routes = { quoteDirect: vi.fn() };
    const bscConfig = { ...config, quoteTokens: { ...config.quoteTokens, bsc: [{ symbol: "USDT", address: usdg }] } } as RuntimeConfig;
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, bscConfig, tradingApi as never, kyberswapApi as never, pancakeUr as never);
    const position = {
      id: "position", chainId: 56, protocol: "v3", positionKey: "7142438", owner,
      token0: token, token1: usdg, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, poolAddress: "0x0000000000000000000000000000000000000456", metadata: { dex: "pancake" },
    } as PositionRecord;

    const prepared = await (executor as unknown as {
      prepareBestSettlementSwap(value: PositionRecord, tokenIn: Address, amount: bigint, tokenOut: Address, slippage: number): Promise<{ provider: string; expectedOut: bigint }>;
    }).prepareBestSettlementSwap(position, token, 5n, usdg, 200);

    expect(["pancake", "kyberswap"]).toContain(prepared.provider);
    expect(tradingApi.quote).not.toHaveBeenCalled();
    expect(routes.quoteDirect).not.toHaveBeenCalled();
  });

  it("selects an aggregator quote above the spot-mark floor instead of a source-pool dump", async () => {
    const client = {
      readContract: markReadContract(),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const kyberswapApi = {
      quote: vi.fn().mockResolvedValue({ source: "kyberswap", expectedOut: 230n, minimumOut: 225n, router: sender }),
      approvalSpender: vi.fn().mockReturnValue(sender),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: sender, data: "0x22", description: "kyber" }),
    };
    const routes = { quoteDirect: vi.fn().mockResolvedValue({ expectedOut: 20n, protocol: "v4", router: sender, tokenIn: token, tokenOut: usdg, path: [token, usdg], amountIn: 246n }) };
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, config, undefined, kyberswapApi as never);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1065396", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    const prepared = await (executor as unknown as {
      prepareBestSettlementSwap(value: PositionRecord, tokenIn: Address, amount: bigint, tokenOut: Address, slippage: number): Promise<{ provider: string; expectedOut: bigint }>;
    }).prepareBestSettlementSwap(position, token, 246n, usdg, 200);

    expect(prepared).toMatchObject({ provider: "kyberswap", expectedOut: 230n });
    expect(routes.quoteDirect).not.toHaveBeenCalled();
  });

  it("does not broadcast a source-pool dump below the spot-mark floor", async () => {
    const client = {
      readContract: markReadContract(),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const routes = {
      quoteDirect: vi.fn().mockResolvedValue({
        expectedOut: 20n, protocol: "v4", router: sender, tokenIn: token, tokenOut: usdg, path: [token, usdg], amountIn: 246n, pool: zeroAddress, pools: [],
      }),
    };
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, config);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1065396", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    await expect((executor as unknown as {
      prepareBestSettlementSwap(value: PositionRecord, tokenIn: Address, amount: bigint, tokenOut: Address, slippage: number): Promise<unknown>;
    }).prepareBestSettlementSwap(position, token, 246n, usdg, 200)).rejects.toThrow("No executable settlement route");
  });

  it("falls back to Kyber when pancake UR simulation fails", async () => {
    const pancakeTarget = "0x00000000000000000000000000000000000000aa" as Address;
    const kyberTarget = "0x00000000000000000000000000000000000000bb" as Address;
    const client = {
      readContract: markReadContract(({ functionName, args }) => {
        if (functionName === "allowance") return (args?.length ?? 0) === 3 ? [10n ** 30n, 4_000_000_000] : 10n ** 30n;
        return 10n ** 30n;
      }),
      call: vi.fn().mockImplementation(({ to }: { to: Address }) => to === pancakeTarget
        ? Promise.reject(new Error("simulation reverted"))
        : Promise.resolve({ data: "0x" })),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("bsc", { permit2: PANCAKE_PERMIT2 }) })) };
    const pancakeUr = {
      quote: vi.fn().mockResolvedValue({ source: "pancake-ur", expectedOut: 120n, minimumOut: 117n, router: pancakeTarget }),
      createSwap: vi.fn().mockReturnValue({ chainId: 56, to: pancakeTarget, data: "0x33", description: "pancake" }),
    };
    const kyberswapApi = {
      quote: vi.fn().mockResolvedValue({ source: "kyberswap", expectedOut: 110n, minimumOut: 107n, router: kyberTarget }),
      approvalSpender: vi.fn().mockReturnValue(kyberTarget),
      createSwap: vi.fn().mockResolvedValue({ chainId: 56, to: kyberTarget, data: "0x22", description: "kyber" }),
    };
    const bscConfig = { ...config, quoteTokens: { ...config.quoteTokens, bsc: [{ symbol: "USDT", address: usdg }] } } as RuntimeConfig;
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, bscConfig, undefined, kyberswapApi as never, pancakeUr as never);
    const position = {
      id: "position", chainId: 56, protocol: "v3", positionKey: "7142438", owner,
      token0: token, token1: usdg, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, poolAddress: "0x0000000000000000000000000000000000000456", metadata: { dex: "pancake" },
    } as PositionRecord;

    const prepared = await (executor as unknown as {
      prepareBestSettlementSwap(value: PositionRecord, tokenIn: Address, amount: bigint, tokenOut: Address, slippage: number): Promise<{ provider: string }>;
    }).prepareBestSettlementSwap(position, token, 5n, usdg, 200);

    expect(prepared.provider).toBe("kyberswap");
    expect(kyberswapApi.createSwap).toHaveBeenCalledTimes(1);
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
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
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
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
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
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
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
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
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

  it("converts an arbitrary 18-decimal quote token to stablecoin settlement units", async () => {
    const database = {
      setPositionStatus: vi.fn(),
      getPositionMetadata: vi.fn().mockResolvedValue({ closeReceiptAccounted: true, settlementQuoteFromClose: "1264138280810145126" }),
    };
    const chains = { getById: vi.fn(() => ({ registry: { name: "robinhood" } })) };
    const routes = { quoteDirect: vi.fn().mockResolvedValue({ expectedOut: 266_760_835n }) };
    const executor = new Executor(database as never, chains as never, {} as never, routes as never, {} as never, {
      ...config,
      quoteTokens: { ...config.quoteTokens, robinhood: [{ symbol: "USDG", address: usdg }, { symbol: "NVDA", address: nvda }] },
    });
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "284857", owner, poolAddress: null,
      token0: token, token1: nvda, quoteToken: nvda, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    await (executor as unknown as { saveSettlementBalance(value: PositionRecord): Promise<void> }).saveSettlementBalance(position);

    expect(routes.quoteDirect).toHaveBeenCalledWith(position, nvda, 1_264_138_280_810_145_126n, usdg);
    expect(database.setPositionStatus).toHaveBeenCalledWith("position", "closing", {
      totalReceived: "1264138280810145126",
      settlementUsd: "266760835",
    });
  });

  it("stores zero USD instead of raw token units when no conversion route exists", async () => {
    const database = {
      setPositionStatus: vi.fn(),
      getPositionMetadata: vi.fn().mockResolvedValue({ closeReceiptAccounted: true, settlementQuoteFromClose: "1000000000000000000" }),
    };
    const chains = { getById: vi.fn(() => ({ registry: { name: "robinhood" } })) };
    const routes = { quoteDirect: vi.fn().mockResolvedValue(null) };
    const executor = new Executor(database as never, chains as never, {} as never, routes as never, {} as never, {
      ...config,
      quoteTokens: { ...config.quoteTokens, robinhood: [{ symbol: "USDG", address: usdg }, { symbol: "NVDA", address: nvda }] },
    });
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "1", owner, poolAddress: null,
      token0: token, token1: nvda, quoteToken: nvda, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    await (executor as unknown as { saveSettlementBalance(value: PositionRecord): Promise<void> }).saveSettlementBalance(position);

    expect(database.setPositionStatus).toHaveBeenCalledWith("position", "closing", {
      totalReceived: "1000000000000000000",
      settlementUsd: "0",
    });
  });

  it("swaps only the amount received by the closing position", async () => {
    vi.useFakeTimers();
    const database = {
      claimSettlementLease: vi.fn().mockResolvedValue(true),
      releaseSettlementLease: vi.fn(),
      getPositionMetadata: vi.fn().mockResolvedValue({ pendingSwap: { token, amount: "5" } }),
      getSubmittedSwapAttempt: vi.fn().mockResolvedValue(null),
      getConfirmedSwapAttempt: vi.fn().mockResolvedValue(null),
      recordExecution: vi.fn(),
      setPositionStatusUnlessSettled: vi.fn(),
    };
    const client = { readContract: vi.fn().mockResolvedValue(100n) };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
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
      getConfirmedSwapAttempt: vi.fn().mockResolvedValue(null),
      setPositionStatusUnlessSettled: vi.fn(),
    };
    const client = { readContract: vi.fn().mockResolvedValue(0n) };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
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
      pendingRawTransaction: null,
    });
    expect(routes.quoteDirect).not.toHaveBeenCalled();
  });

  it("waits for receipt providers when a submitted swap nonce was consumed recently", async () => {
    const serialized = stringToHex("pending-swap-tx");
    const swapHash = keccak256(serialized);
    const metadata = {
      pendingSwap: { token, amount: "5" },
      closeReceiptAccounted: true,
      settlementQuoteFromClose: "1982164029",
      settlementPhase: "pending_swap",
      pendingRawTransaction: { stage: "swap_to_quote", hash: swapHash, serializedTransaction: serialized, submittedAt: new Date().toISOString() },
    };
    const database = {
      claimSettlementLease: vi.fn().mockResolvedValue(true),
      releaseSettlementLease: vi.fn(),
      getPositionMetadata: vi.fn().mockResolvedValue(metadata),
      getSubmittedSwapAttempt: vi.fn().mockResolvedValue(swapHash),
      getConfirmedSwapAttempt: vi.fn().mockResolvedValue(null),
      recordExecution: vi.fn(),
      setPositionStatusUnlessSettled: vi.fn(),
    };
    const client = { readContract: vi.fn().mockResolvedValue(0n) };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const executor = new Executor(database as never, chains as never, {} as never, { quoteDirect: vi.fn() } as never, {} as never, config);
    vi.spyOn(executor as any, "getConfirmedReceipt").mockRejectedValue(new Error("not found"));
    vi.spyOn(executor as any, "pendingRawIsStale").mockResolvedValue(true);
    const rebroadcast = vi.spyOn(executor as any, "rebroadcastPendingTransaction").mockResolvedValue(undefined);
    const position = {
      id: "position", chainId: 4663, protocol: "v3", positionKey: "729224", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata,
    } as PositionRecord;

    await executor.resume(position);

    expect(rebroadcast).not.toHaveBeenCalled();
    expect(database.recordExecution).not.toHaveBeenCalledWith("position", "swap_to_quote", "failed", expect.anything(), expect.anything());
    expect(database.setPositionStatusUnlessSettled).not.toHaveBeenCalledWith("position", "needs_review", expect.anything());
  });

  it("requires review instead of discarding swap output when its receipt stays unavailable", async () => {
    const serialized = stringToHex("old-pending-swap-tx");
    const swapHash = keccak256(serialized);
    const metadata = {
      pendingSwap: { token, amount: "5" },
      closeReceiptAccounted: true,
      settlementQuoteFromClose: "10",
      settlementPhase: "pending_swap",
      pendingRawTransaction: {
        stage: "swap_to_quote",
        hash: swapHash,
        serializedTransaction: serialized,
        submittedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      },
    };
    const database = {
      claimSettlementLease: vi.fn().mockResolvedValue(true),
      releaseSettlementLease: vi.fn(),
      getPositionMetadata: vi.fn().mockResolvedValue(metadata),
      getSubmittedSwapAttempt: vi.fn().mockResolvedValue(swapHash),
      getConfirmedSwapAttempt: vi.fn().mockResolvedValue(null),
      recordExecution: vi.fn(),
      setPositionStatusUnlessSettled: vi.fn(),
    };
    const chains = { getById: vi.fn(() => ({ client: { readContract: markReadContract() }, registry: v4Registry("robinhood") })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, config);
    vi.spyOn(executor as any, "getConfirmedReceipt").mockRejectedValue(new Error("not found"));
    vi.spyOn(executor as any, "pendingRawIsStale").mockResolvedValue(true);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "872988", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata,
    } as PositionRecord;

    await executor.resume(position);

    expect(database.recordExecution).not.toHaveBeenCalledWith("position", "swap_to_quote", "failed", expect.anything(), expect.anything());
    expect(database.setPositionStatusUnlessSettled).toHaveBeenCalledWith("position", "needs_review", {
      reason: `swap receipt unavailable after nonce advanced: ${swapHash}`,
      settlementRetryDisabled: true,
      settlementSwapCandidateHash: swapHash,
    });
  });

  it("rebroadcasts a submitted swap while its nonce is still pending", async () => {
    const serialized = stringToHex("pending-swap-tx");
    const swapHash = keccak256(serialized);
    const metadata = {
      pendingSwap: { token, amount: "5" },
      closeReceiptAccounted: true,
      settlementPhase: "pending_swap",
      pendingRawTransaction: { stage: "swap_to_quote", hash: swapHash, serializedTransaction: serialized },
    };
    const database = {
      claimSettlementLease: vi.fn().mockResolvedValue(true),
      releaseSettlementLease: vi.fn(),
      getPositionMetadata: vi.fn().mockResolvedValue(metadata),
      getSubmittedSwapAttempt: vi.fn().mockResolvedValue(swapHash),
      getConfirmedSwapAttempt: vi.fn().mockResolvedValue(null),
      recordExecution: vi.fn(),
      setPositionStatusUnlessSettled: vi.fn(),
    };
    const chains = { getById: vi.fn(() => ({ client: { readContract: markReadContract() }, registry: v4Registry("robinhood") })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, config);
    vi.spyOn(executor as any, "getConfirmedReceipt").mockRejectedValue(new Error("not found"));
    vi.spyOn(executor as any, "pendingRawIsStale").mockResolvedValue(false);
    const rebroadcast = vi.spyOn(executor as any, "rebroadcastPendingTransaction").mockResolvedValue(undefined);
    const position = {
      id: "position", chainId: 4663, protocol: "v3", positionKey: "1", owner, poolAddress: null,
      token0: usdg, token1: token, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata,
    } as PositionRecord;

    await executor.resume(position);

    expect(rebroadcast).toHaveBeenCalledWith(position, swapHash);
    expect(database.recordExecution).not.toHaveBeenCalled();
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

  it("recomputes a close-only stored total when a confirmed swap hash arrives", async () => {
    const database = {
      getPositionMetadata: vi.fn().mockResolvedValue({ settlementTotalReceived: "10" }),
      setPositionStatusUnlessSettled: vi.fn(),
      setPositionStatus: vi.fn(),
      finalizeCloseHistory: vi.fn().mockResolvedValue(true),
    };
    const notifier = { settled: vi.fn() };
    const executor = new Executor(database as never, {} as never, {} as never, {} as never, notifier as never, config);
    vi.spyOn(executor as any, "saveSettlementBalance").mockResolvedValue(20n);
    vi.spyOn(executor as any, "unwrapWethQuote").mockResolvedValue(true);
    const position = {
      id: "position", chainId: 4663, protocol: "v4", positionKey: "872988", owner, poolAddress: null,
      token0: token, token1: usdg, quoteToken: usdg, status: "closing", liquidity: null,
      openedAtBlock: null, metadata: {},
    } as PositionRecord;

    await (executor as any).completeSettlement(position, 0n, hash, hash);

    expect((executor as any).saveSettlementBalance).toHaveBeenCalledWith(position, 0n, hash);
    expect(database.setPositionStatusUnlessSettled).toHaveBeenCalledWith("position", "closing", {
      settlementTotalReceived: "20",
      swapTransactionHash: hash,
    });
    expect(database.setPositionStatusUnlessSettled).toHaveBeenCalledWith("position", "closing", {
      pendingSwap: null,
      pendingRawTransaction: null,
    });
    expect(database.setPositionStatus).toHaveBeenCalledWith("position", "settled", expect.anything());
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
        registry: { name: "robinhood", contracts: { v3: { positionManager: "0x0000000000000000000000000000000000000001" } } },
      })),
      getForLogs: vi.fn(() => ({ client })),
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

  it("closes every V3 Bid-Ask child in one outer multicall and accounts one parent receipt", async () => {
    const group = groupRecord();
    const children = [groupChild("child-7", 7n), groupChild("child-8", 8n)];
    const bins = [groupBin(0, 7n, "child-7", -120, -60), groupBin(1, 8n, "child-8", -60, 0)];
    const client = {
      getBlockNumber: vi.fn().mockResolvedValue(100n),
      readContract: vi.fn().mockResolvedValue(owner),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const receipt = {
      status: "success" as const,
      blockNumber: 101n,
      logs: [
        transferLog(usdg, sender, owner, 23n),
        transferLog(token, sender, owner, 118n),
        nftBurnLog(groupManager, owner, 7n),
        nftBurnLog(groupManager, owner, 8n),
      ],
    };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      listPositionGroupBins: vi.fn().mockResolvedValue(bins),
      listActivePositions: vi.fn().mockResolvedValue(children),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      addPositionGroupCashflow: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const reader = {
      read: vi.fn((position: PositionRecord) => Promise.resolve(position.positionKey === "7" ? groupValue(-120, -60) : groupValue(-60, 0))),
    };
    const executor = new Executor(database as never, chains as never, reader as never, {} as never, { transaction: vi.fn() } as never, config);
    const closeReceiptAmounts = vi.spyOn(executor as any, "closeReceiptAmounts");
    (executor as any).confirmedReceipts.set(hash, receipt);
    const sendGroup = vi.spyOn(executor as any, "sendGroup").mockResolvedValue(hash);

    await executor.executeGroup(groupId, "manual");

    expect(reader.read).toHaveBeenNthCalledWith(1, children[0], 100n, 200, "execution");
    expect(reader.read).toHaveBeenNthCalledWith(2, children[1], 100n, 200, "execution");
    expect(sendGroup).toHaveBeenCalledTimes(1);
    const plan = sendGroup.mock.calls[0]![2] as { data: Hex };
    const outer = decodeFunctionData({ abi: v3PositionManagerAbi, data: plan.data });
    expect(plan.data.slice(0, 10)).toBe(toFunctionSelector("multicall(bytes[])") as string);
    expect(outer.args[0]).toHaveLength(6);
    expect(database.addPositionGroupCashflow).toHaveBeenCalledTimes(1);
    expect(database.addPositionGroupCashflow).toHaveBeenCalledWith(
      groupId,
      101n,
      hash,
      "close_receipt",
      23n,
      23n,
      118n,
      expect.objectContaining({ source: "atomic_group_close", childCount: 2 }),
    );
    expect(closeReceiptAmounts).not.toHaveBeenCalled();
  });

  it("ignores a stale triggerless recovery after an open becomes active", async () => {
    const group = {
      ...groupRecord(),
      pendingRawTransaction: {
        stage: "open_batch",
        hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        serializedTransaction: "0x1234",
      },
      metadata: { exitRetry: null, exitTrigger: null, pendingSwap: null },
    } as PositionGroupRecord;
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      listPositionGroupBins: vi.fn(),
    };
    const executor = new Executor(database as never, {} as never, {} as never, {} as never, {} as never, config);

    await expect(executor.executeGroup(group.id)).resolves.toBeUndefined();

    expect(database.listPositionGroupBins).not.toHaveBeenCalled();
  });

  it("falls back to zero minimums for a reverting V4 Bid-Ask close simulation", async () => {
    const group = groupRecord("v4");
    const children = [v4GroupChild("child-7", 7n), v4GroupChild("child-8", 8n)];
    const bins = [groupBin(0, 7n, "child-7", -120, -60), groupBin(1, 8n, "child-8", -60, 0)];
    const client = {
      getBlockNumber: vi.fn().mockResolvedValue(100n),
      readContract: vi.fn().mockResolvedValue(owner),
      call: vi.fn()
        .mockRejectedValueOnce(new Error("execution reverted"))
        .mockResolvedValueOnce({ data: "0x" }),
    };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      listPositionGroupBins: vi.fn().mockResolvedValue(bins),
      getPositionById: vi.fn((id: string) => Promise.resolve(children.find((child) => child.id === id) ?? null)),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const reader = {
      read: vi.fn((position: PositionRecord) => Promise.resolve(position.positionKey === "7" ? v4GroupValue(-120, -60) : v4GroupValue(-60, 0))),
    };
    const executor = new Executor(database as never, chains as never, reader as never, {} as never, {} as never, config);
    const sendGroup = vi.spyOn(executor as any, "sendGroup").mockResolvedValue(null);

    await executor.executeGroup(groupId, "manual");

    expect(client.call).toHaveBeenCalledTimes(2);
    expect(sendGroup).toHaveBeenCalledTimes(1);
    const plan = sendGroup.mock.calls[0]![2] as { data: Hex };
    const outer = decodeFunctionData({ abi: v4PositionManagerAbi, data: plan.data });
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], outer.args[0]);
    expect(actions).toBe("0x030311");
    const burnTypes = [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }] as const;
    for (const param of params.slice(0, 2)) {
      const [, amount0Min, amount1Min] = decodeAbiParameters(burnTypes, param);
      expect(amount0Min).toBe(0n);
      expect(amount1Min).toBe(0n);
    }
    expect(database.setPositionGroupStatus).toHaveBeenCalledWith(groupId, "active", expect.objectContaining({
      dryRunPlan: "batch V4 bid-ask close",
    }));
  });

  it("only allows zero-minimum group closes for SL and manual exits", () => {
    expect(allowsZeroMinimumGroupClose("stop_loss")).toBe(true);
    expect(allowsZeroMinimumGroupClose("manual")).toBe(true);
    expect(allowsZeroMinimumGroupClose("take_profit")).toBe(false);
    expect(allowsZeroMinimumGroupClose("trailing_take_profit")).toBe(false);
    expect(allowsZeroMinimumGroupClose("profit_oor_above")).toBe(false);
    expect(allowsZeroMinimumGroupClose("out_of_range_above")).toBe(false);
  });

  it("resumes the aggregate settlement swap after the close receipt was accounted in the same process", async () => {
    const group = {
      ...groupRecord(),
      status: "settling",
      closeTransactionHash: hash,
      metadata: {
        closeTransactionHash: hash,
        closeReceiptAccounted: true,
        settlementPhase: "pending_swap",
        pendingSwap: { token, amount: "500" },
        totalReceivedQuote: "100",
        exitTrigger: "manual",
      },
    };
    const swapReceipt = {
      status: "success" as const,
      blockNumber: 102n,
      logs: [transferLog(usdg, sender, owner, 200n)],
    };
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue(swapReceipt),
      readContract: markReadContract(),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
      getPositionGroupCashflowTotals: vi.fn().mockResolvedValue({ deposits: 100n, realized: 300n }),
      addPositionGroupCashflow: vi.fn().mockResolvedValue(undefined),
      finalizePositionGroup: vi.fn().mockResolvedValue(true),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const routes = {
      quoteDirect: vi.fn().mockResolvedValue({
        protocol: "v3",
        pool: groupPool,
        pools: [groupPool],
        router: "0x0000000000000000000000000000000000000300",
        tokenIn: token,
        tokenOut: usdg,
        path: [token, usdg],
        encodedPath: "0x00",
        amountIn: 500n,
        expectedOut: 500n,
        minimumOut: 500n,
      }),
    };
    const executor = new Executor(database as never, chains as never, {} as never, routes as never, {} as never, config);
    (executor as any).accountedGroupCloses.add(groupId);
    const sendGroup = vi.spyOn(executor as any, "sendGroup").mockResolvedValue(hash);

    await executor.executeGroup(groupId, "manual");

    expect(routes.quoteDirect).toHaveBeenCalledWith(expect.anything(), token, 500n, usdg);
    expect(sendGroup).toHaveBeenCalledWith(group, "settlement_swap", expect.anything());
    expect(database.addPositionGroupCashflow).toHaveBeenCalledWith(groupId, 102n, hash, "settlement_swap", 200n, 0n, 0n, expect.any(Object));
    expect(database.finalizePositionGroup).toHaveBeenCalledWith(groupId, hash, 300n, 200n, 20000n, "manual", 200n);
  });

  it("keeps a Bid-Ask group pending when the aggregate swap is unquotable", async () => {
    const group = {
      ...groupRecord(),
      status: "settling",
      closeTransactionHash: hash,
      metadata: {
        closeTransactionHash: hash,
        closeReceiptAccounted: true,
        settlementPhase: "pending_swap",
        pendingSwap: { token, amount: "500" },
        totalReceivedQuote: "100",
        exitTrigger: "manual",
      },
    };
    const client = { readContract: markReadContract(), call: vi.fn().mockResolvedValue({ data: "0x" }) };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
      getPositionGroupCashflowTotals: vi.fn().mockResolvedValue({ deposits: 100n, realized: 300n }),
      addPositionGroupCashflow: vi.fn().mockResolvedValue(undefined),
      finalizePositionGroup: vi.fn().mockResolvedValue(true),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const routes = { quoteDirect: vi.fn().mockResolvedValue(null) };
    const executor = new Executor(database as never, chains as never, {} as never, routes as never, {} as never, config);
    const sendGroup = vi.spyOn(executor as any, "sendGroup");

    await executor.executeGroup(groupId, "manual");

    expect(routes.quoteDirect).toHaveBeenCalledWith(expect.anything(), token, 500n, usdg);
    expect(sendGroup).not.toHaveBeenCalled();
    expect(database.finalizePositionGroup).not.toHaveBeenCalled();
    expect(database.setPositionGroupStatus).toHaveBeenLastCalledWith(groupId, "settling", expect.objectContaining({
      settlementPhase: "pending_swap",
      pendingSwap: { token, amount: "500" },
      swapRetry: expect.objectContaining({ planningFailures: 1 }),
    }));
  });

  it("keeps a Bid-Ask group pending when the aggregate swap simulation reverts", async () => {
    const group = {
      ...groupRecord(),
      status: "settling",
      closeTransactionHash: hash,
      metadata: {
        closeTransactionHash: hash,
        closeReceiptAccounted: true,
        settlementPhase: "pending_swap",
        pendingSwap: { token, amount: "500" },
        totalReceivedQuote: "100",
        exitTrigger: "manual",
      },
    };
    const client = { readContract: markReadContract(), call: vi.fn().mockResolvedValue({ data: "0x" }) };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
      getPositionGroupCashflowTotals: vi.fn().mockResolvedValue({ deposits: 100n, realized: 300n }),
      addPositionGroupCashflow: vi.fn().mockResolvedValue(undefined),
      finalizePositionGroup: vi.fn().mockResolvedValue(true),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const routes = {
      quoteDirect: vi.fn().mockResolvedValue({
        protocol: "v3",
        pool: groupPool,
        pools: [groupPool],
        router: "0x0000000000000000000000000000000000000300",
        tokenIn: token,
        tokenOut: usdg,
        path: [token, usdg],
        encodedPath: "0x00",
        amountIn: 500n,
        expectedOut: 500n,
        minimumOut: 500n,
      }),
    };
    const executor = new Executor(database as never, chains as never, {} as never, routes as never, {} as never, config);
    const sendGroup = vi.spyOn(executor as any, "sendGroup").mockRejectedValue(new Error("Execution reverted for an unknown reason"));

    await executor.executeGroup(groupId, "manual");

    expect(sendGroup).toHaveBeenCalledWith(group, "settlement_swap", expect.anything());
    expect(database.finalizePositionGroup).not.toHaveBeenCalled();
    expect(database.setPositionGroupStatus).toHaveBeenLastCalledWith(groupId, "settling", expect.objectContaining({
      settlementPhase: "pending_swap",
      pendingSwap: { token, amount: "500" },
      swapRetry: expect.objectContaining({ broadcastAttempts: 1 }),
    }));
  });

  it("uses the normal provider pipeline for Bid-Ask settlement swaps", async () => {
    const group = {
      ...groupRecord(),
      status: "settling",
      closeTransactionHash: hash,
      metadata: {
        closeTransactionHash: hash,
        closeReceiptAccounted: true,
        settlementPhase: "pending_swap",
        pendingSwap: { token, amount: "500" },
        totalReceivedQuote: "100",
        exitTrigger: "manual",
      },
    };
    const router = "0x0000000000000000000000000000000000000300" as Address;
    const receipt = { status: "success" as const, blockNumber: 102n, logs: [transferLog(usdg, sender, owner, 120n)] };
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      readContract: markReadContract(),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
      getPositionGroupCashflowTotals: vi.fn().mockResolvedValue({ deposits: 100n, realized: 300n }),
      addPositionGroupCashflow: vi.fn().mockResolvedValue(undefined),
      finalizePositionGroup: vi.fn().mockResolvedValue(true),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const routes = {
      quoteDirect: vi.fn().mockResolvedValue({
        protocol: "v3",
        pool: groupPool,
        pools: [groupPool],
        router: groupPool,
        tokenIn: token,
        tokenOut: usdg,
        path: [token, usdg],
        encodedPath: "0x00",
        amountIn: 500n,
        expectedOut: 500n,
        minimumOut: 490n,
      }),
    };
    const kyberQuote = {
      source: "kyberswap",
      expectedOut: 520n,
      minimumOut: 510n,
      router,
      routeSummary: {},
      tokenIn: token,
      tokenOut: usdg,
      amountIn: 500n,
      chainId: 4663,
      owner,
      slippageBps: 200,
      validUntilMs: Date.now() + 60_000,
    };
    const kyberswap = {
      quote: vi.fn().mockResolvedValue(kyberQuote),
      approvalSpender: vi.fn().mockReturnValue(router),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: router, data: "0x1234", value: 0n, description: "kyber" }),
    };
    const executor = new Executor(database as never, chains as never, {} as never, routes as never, {} as never, config, undefined, kyberswap as never);
    const sendGroup = vi.spyOn(executor as any, "sendGroup").mockResolvedValue(hash);

    await executor.executeGroup(groupId, "manual");

    expect(kyberswap.quote).toHaveBeenCalledWith(expect.anything(), token, 500n, usdg, 200);
    expect(kyberswap.createSwap).toHaveBeenCalledWith(expect.anything(), kyberQuote);
    expect(sendGroup).toHaveBeenCalledWith(group, "settlement_swap", expect.objectContaining({ to: router }));
    expect(database.finalizePositionGroup).toHaveBeenCalledWith(groupId, hash, 220n, 200n, 20000n, "manual", 200n);
  });

  it("falls through to the local route when an API group settlement simulation reverts", async () => {
    const group = {
      ...groupRecord(),
      status: "settling",
      closeTransactionHash: hash,
      metadata: {
        closeTransactionHash: hash,
        closeReceiptAccounted: true,
        settlementPhase: "pending_swap",
        pendingSwap: { token, amount: "500" },
        totalReceivedQuote: "100",
        exitTrigger: "manual",
      },
    };
    const apiRouter = "0x0000000000000000000000000000000000000300" as Address;
    const receipt = { status: "success" as const, blockNumber: 102n, logs: [transferLog(usdg, sender, owner, 100n)] };
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      readContract: markReadContract(),
      call: vi.fn().mockRejectedValueOnce(new Error("api simulation reverted")).mockResolvedValue({ data: "0x" }),
    };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
      getPositionGroupCashflowTotals: vi.fn().mockResolvedValue({ deposits: 100n, realized: 200n }),
      addPositionGroupCashflow: vi.fn().mockResolvedValue(undefined),
      finalizePositionGroup: vi.fn().mockResolvedValue(true),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const routes = {
      quoteDirect: vi.fn().mockResolvedValue({
        protocol: "v3",
        pool: groupPool,
        pools: [groupPool],
        router: groupPool,
        tokenIn: token,
        tokenOut: usdg,
        path: [token, usdg],
        encodedPath: "0x00",
        amountIn: 500n,
        expectedOut: 500n,
        minimumOut: 490n,
      }),
    };
    const kyberQuote = {
      source: "kyberswap",
      expectedOut: 520n,
      minimumOut: 510n,
      router: apiRouter,
      routeSummary: {},
      tokenIn: token,
      tokenOut: usdg,
      amountIn: 500n,
      chainId: 4663,
      owner,
      slippageBps: 200,
      validUntilMs: Date.now() + 60_000,
    };
    const kyberswap = {
      quote: vi.fn().mockResolvedValue(kyberQuote),
      approvalSpender: vi.fn().mockReturnValue(apiRouter),
      createSwap: vi.fn().mockResolvedValue({ chainId: 4663, to: apiRouter, data: "0x1234", value: 0n, description: "kyber" }),
    };
    const executor = new Executor(database as never, chains as never, {} as never, routes as never, {} as never, config, undefined, kyberswap as never);
    const sendGroup = vi.spyOn(executor as any, "sendGroup").mockResolvedValue(hash);

    await executor.executeGroup(groupId, "manual");

    expect(sendGroup).toHaveBeenCalledWith(group, "settlement_swap", expect.objectContaining({ to: groupPool }));
    expect(database.finalizePositionGroup).toHaveBeenCalledWith(groupId, hash, 200n, 100n, 10000n, "manual", 100n);
  });

  it("unwraps WETH quote proceeds to native ETH before finalizing a Bid-Ask group without a settlement swap", async () => {
    const group = {
      ...groupRecord(),
      quoteToken: weth,
      status: "settling",
      closeTransactionHash: hash,
      metadata: {
        closeTransactionHash: hash,
        closeReceiptAccounted: true,
        settlementPhase: "accounting",
        totalReceivedQuote: "100",
        exitTrigger: "manual",
      },
    };
    const receipt = { status: "success" as const, blockNumber: 102n, logs: [] };
    const client = { getTransactionReceipt: vi.fn().mockResolvedValue(receipt), readContract: markReadContract(), call: vi.fn().mockResolvedValue({ data: "0x" }) };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
      getPositionGroupCashflowTotals: vi.fn().mockResolvedValue({ deposits: 100n, realized: 300n }),
      addPositionGroupCashflow: vi.fn().mockResolvedValue(undefined),
      finalizePositionGroup: vi.fn().mockResolvedValue(true),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, wethConfig);
    const sendGroup = vi.spyOn(executor as any, "sendGroup").mockResolvedValue(unwrapHash);

    await executor.executeGroup(groupId, "manual");

    expect(sendGroup).toHaveBeenCalledWith(group, "unwrap_quote", expect.objectContaining({ to: weth, description: "unwrap_quote" }));
    expect(database.addPositionGroupCashflow).toHaveBeenCalledWith(groupId, 102n, unwrapHash, "unwrap_quote", 100n, 0n, 0n, expect.objectContaining({ source: "group_quote_unwrap" }));
    expect(database.finalizePositionGroup).toHaveBeenCalledWith(groupId, hash, 100n, 200n, 20000n, "manual", null);
  });

  it("unwraps the combined WETH proceeds after the aggregate settlement swap of a Bid-Ask group", async () => {
    const group = {
      ...groupRecord(),
      quoteToken: weth,
      status: "settling",
      closeTransactionHash: hash,
      metadata: {
        closeTransactionHash: hash,
        closeReceiptAccounted: true,
        settlementPhase: "pending_swap",
        pendingSwap: { token, amount: "500" },
        totalReceivedQuote: "100",
        exitTrigger: "manual",
      },
    };
    const receipt = { status: "success" as const, blockNumber: 102n, logs: [transferLog(weth, sender, owner, 200n)] };
    const client = { getTransactionReceipt: vi.fn().mockResolvedValue(receipt), readContract: markReadContract(), call: vi.fn().mockResolvedValue({ data: "0x" }) };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
      getPositionGroupCashflowTotals: vi.fn().mockResolvedValue({ deposits: 100n, realized: 300n }),
      addPositionGroupCashflow: vi.fn().mockResolvedValue(undefined),
      finalizePositionGroup: vi.fn().mockResolvedValue(true),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const routes = {
      quoteDirect: vi.fn().mockResolvedValue({
        protocol: "v3",
        pool: groupPool,
        pools: [groupPool],
        router: "0x0000000000000000000000000000000000000300",
        tokenIn: token,
        tokenOut: weth,
        path: [token, weth],
        encodedPath: "0x00",
         amountIn: 500n,
        expectedOut: 500n,
        minimumOut: 490n,
      }),
    };
    const executor = new Executor(database as never, chains as never, {} as never, routes as never, {} as never, wethConfig);
    const sendGroup = vi.spyOn(executor as any, "sendGroup")
      .mockImplementation(async (_group: unknown, stage: string) => stage === "settlement_swap" ? hash : unwrapHash);

    await executor.executeGroup(groupId, "manual");

    expect(sendGroup).toHaveBeenCalledWith(group, "settlement_swap", expect.anything());
    expect(sendGroup).toHaveBeenCalledWith(group, "unwrap_quote", expect.objectContaining({ to: weth, description: "unwrap_quote" }));
    expect(database.addPositionGroupCashflow).toHaveBeenCalledWith(groupId, 102n, unwrapHash, "unwrap_quote", 300n, 0n, 0n, expect.anything());
    expect(database.finalizePositionGroup).toHaveBeenCalledWith(groupId, hash, 300n, 200n, 20000n, "manual", null);
  });

  it("unwraps only the incremental WETH output when a settled group is recovered", async () => {
    const group = {
      ...groupRecord(),
      quoteToken: weth,
      status: "settling",
      closeTransactionHash: hash,
      metadata: {
        closeTransactionHash: hash,
        closeReceiptAccounted: true,
        settlementPhase: "pending_swap",
        pendingSwap: { token, amount: "500" },
        totalReceivedQuote: "100",
        exitTrigger: "manual",
        unwrapQuoteConfirmed: true,
        unwrapQuoteAmount: "100",
      },
    };
    const swapReceipt = { status: "success" as const, blockNumber: 102n, logs: [transferLog(weth, sender, owner, 120n)] };
    const unwrapReceipt = { status: "success" as const, blockNumber: 103n, logs: [] };
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValueOnce(swapReceipt).mockResolvedValueOnce(unwrapReceipt),
      readContract: markReadContract(),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
      getPositionGroupCashflowTotals: vi.fn().mockResolvedValue({ deposits: 100n, realized: 220n }),
      addPositionGroupCashflow: vi.fn().mockResolvedValue(undefined),
      finalizePositionGroup: vi.fn().mockResolvedValue(true),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const routes = {
      quoteDirect: vi.fn().mockResolvedValue({
        protocol: "v3",
        pool: groupPool,
        pools: [groupPool],
        router: groupPool,
        tokenIn: token,
        tokenOut: weth,
        path: [token, weth],
        encodedPath: "0x00",
         amountIn: 500n,
        expectedOut: 500n,
        minimumOut: 490n,
      }),
    };
    const executor = new Executor(database as never, chains as never, {} as never, routes as never, {} as never, wethConfig);
    const sendGroup = vi.spyOn(executor as any, "sendGroup")
      .mockImplementation(async (_group: unknown, stage: string) => stage === "settlement_swap" ? hash : unwrapHash);

    await executor.executeGroup(groupId, "manual");

    expect(sendGroup).toHaveBeenCalledWith(group, "unwrap_quote", expect.objectContaining({
      data: expect.any(String),
    }));
    expect(database.addPositionGroupCashflow).toHaveBeenCalledWith(groupId, 103n, unwrapHash, "unwrap_quote", 120n, 0n, 0n, expect.anything());
    expect(database.finalizePositionGroup).toHaveBeenCalledWith(groupId, hash, 220n, 120n, 12000n, "manual", null);
  });

  it("finalizes a WETH-quoted Bid-Ask group without unwrap when the unwrap transaction reverts", async () => {
    const group = {
      ...groupRecord(),
      quoteToken: weth,
      status: "settling",
      closeTransactionHash: hash,
      metadata: {
        closeTransactionHash: hash,
        closeReceiptAccounted: true,
        settlementPhase: "accounting",
        totalReceivedQuote: "100",
        exitTrigger: "manual",
      },
    };
    const client = { readContract: markReadContract(), call: vi.fn().mockResolvedValue({ data: "0x" }) };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
      getPositionGroupCashflowTotals: vi.fn().mockResolvedValue({ deposits: 100n, realized: 300n }),
      addPositionGroupCashflow: vi.fn().mockResolvedValue(undefined),
      finalizePositionGroup: vi.fn().mockResolvedValue(true),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, wethConfig);
    vi.spyOn(executor as any, "sendGroup").mockRejectedValue(new Error("unwrap_quote transaction reverted"));

    await executor.executeGroup(groupId, "manual");

    expect(database.setPositionGroupStatus).toHaveBeenLastCalledWith(groupId, "settling", expect.objectContaining({ unwrapQuoteFailed: true }));
    expect(database.finalizePositionGroup).toHaveBeenCalledWith(groupId, hash, 100n, 200n, 20000n, "manual", null);
  });

  it("skips a confirmed group unwrap on resume and finalizes the WETH-quoted Bid-Ask group", async () => {
    const group = {
      ...groupRecord(),
      quoteToken: weth,
      status: "settling",
      closeTransactionHash: hash,
      metadata: {
        closeTransactionHash: hash,
        closeReceiptAccounted: true,
        settlementPhase: "unwrapping_quote",
        totalReceivedQuote: "100",
        exitTrigger: "manual",
        unwrapQuoteConfirmed: true,
        unwrapQuoteAmount: "100",
      },
    };
    const client = { readContract: markReadContract(), call: vi.fn().mockResolvedValue({ data: "0x" }) };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
      getPositionGroupCashflowTotals: vi.fn().mockResolvedValue({ deposits: 100n, realized: 300n }),
      addPositionGroupCashflow: vi.fn().mockResolvedValue(undefined),
      finalizePositionGroup: vi.fn().mockResolvedValue(true),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, wethConfig);
    const sendGroup = vi.spyOn(executor as any, "sendGroup");

    await executor.executeGroup(groupId, "manual");

    expect(sendGroup).not.toHaveBeenCalled();
    expect(database.finalizePositionGroup).toHaveBeenCalledWith(groupId, hash, 100n, 200n, 20000n, "manual", null);
  });

  it("reconciles a confirmed pending group unwrap transaction on recovery", async () => {
    const pendingRaw = stringToHex("pending-unwrap");
    const pendingHash = keccak256(pendingRaw);
    const group = {
      ...groupRecord(),
      quoteToken: weth,
      status: "settling",
      closeTransactionHash: hash,
      pendingRawTransaction: {
        stage: "unwrap_quote",
        hash: pendingHash,
        serializedTransaction: pendingRaw,
        nonce: "0",
        submittedAt: new Date().toISOString(),
      },
      metadata: {
        closeTransactionHash: hash,
        closeReceiptAccounted: true,
        settlementPhase: "unwrapping_quote",
        unwrapQuoteAmount: "100",
        exitTrigger: "manual",
      },
    };
    const receipt = { status: "success" as const, blockNumber: 102n, logs: [] };
    const client = { getTransactionReceipt: vi.fn().mockResolvedValue(receipt), readContract: markReadContract(), call: vi.fn().mockResolvedValue({ data: "0x" }) };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
      getPositionGroupCashflowTotals: vi.fn().mockResolvedValue({ deposits: 100n, realized: 300n }),
      addPositionGroupCashflow: vi.fn().mockResolvedValue(undefined),
      finalizePositionGroup: vi.fn().mockResolvedValue(true),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, wethConfig);

    await executor.executeGroup(groupId, "manual");

    expect(database.recordPositionGroupExecution).toHaveBeenCalledWith(groupId, "unwrap_quote", "confirmed", pendingHash);
    expect(database.addPositionGroupCashflow).toHaveBeenCalledWith(groupId, 102n, pendingHash, "unwrap_quote", 100n, 0n, 0n, expect.anything());
    expect(database.setPositionGroupStatus).toHaveBeenLastCalledWith(groupId, "settling", expect.objectContaining({ unwrapQuoteConfirmed: true }));
    expect(database.finalizePositionGroup).toHaveBeenCalledWith(groupId, hash, 0n, 200n, 20000n, "manual", null);
  });

  it("clears a stale pending group approval after its nonce is consumed", async () => {
    const pendingRaw = stringToHex("pending-approval");
    const pendingHash = keccak256(pendingRaw);
    const group = {
      ...groupRecord(),
      status: "settling",
      closeTransactionHash: hash,
      pendingRawTransaction: {
        stage: "approve_quote",
        hash: pendingHash,
        serializedTransaction: pendingRaw,
        nonce: "12",
        submittedAt: new Date().toISOString(),
      },
      metadata: {
        closeTransactionHash: hash,
        closeReceiptAccounted: true,
        settlementPhase: "pending_swap",
        pendingSwap: { token, amount: "500" },
      },
    };
    const client = {
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error("not found")),
      getTransactionCount: vi.fn().mockResolvedValue(13n),
      readContract: markReadContract(),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, config);
    const rebroadcast = vi.spyOn(executor as any, "rebroadcastGroupPendingTransaction");

    await executor.executeGroup(groupId, "manual");

    expect(database.recordPositionGroupExecution).toHaveBeenCalledWith(
      groupId,
      "approve_quote",
      "failed",
      pendingHash,
      undefined,
      undefined,
      expect.stringContaining("nonce 12 was consumed"),
    );
    expect(database.setPositionGroupStatus).toHaveBeenCalledWith(groupId, "settling", expect.objectContaining({
      pendingRawTransaction: null,
      settlementPhase: "pending_swap",
    }));
    expect(rebroadcast).not.toHaveBeenCalled();
  });

  it("returns a stale pending group close to active for a fresh close retry", async () => {
    const pendingRaw = stringToHex("pending-close");
    const pendingHash = keccak256(pendingRaw);
    const group = {
      ...groupRecord(),
      status: "settling",
      closeTransactionHash: pendingHash,
      pendingRawTransaction: {
        stage: "close_batch",
        hash: pendingHash,
        serializedTransaction: pendingRaw,
        nonce: "12",
        submittedAt: new Date().toISOString(),
      },
      metadata: {
        closeTransactionHash: pendingHash,
        settlementPhase: "accounting",
        exitTrigger: "manual",
      },
    };
    const client = {
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error("not found")),
      getTransactionCount: vi.fn().mockResolvedValue(13),
      readContract: markReadContract(),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      hasPendingRawTransaction: vi.fn().mockResolvedValue(false),
      withExecutionLock: vi.fn(async (_chainId: number, _address: Address, work: () => Promise<unknown>) => work()),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, config);

    await executor.executeGroup(groupId, "manual");

    expect(database.setPositionGroupStatus).toHaveBeenCalledWith(groupId, "active", expect.objectContaining({
      closeTransactionHash: null,
      settlementPhase: null,
      pendingRawTransaction: null,
      settlementRetryDisabled: null,
      exitRetry: expect.any(Object),
    }));
  });

  it("converts WETH and native ETH Bid-Ask PnL using the settlement quote rate", async () => {
    const routes = { quoteDirect: vi.fn().mockResolvedValue({ expectedOut: 3_000_000_000n }) };
    const chains = { getById: vi.fn(() => ({ registry: { name: "robinhood" } })) };
    const executor = new Executor({} as never, chains as never, {} as never, routes as never, {} as never, wethConfig);
    const wethGroup = { ...groupRecord(), quoteToken: weth };
    const nativeGroup = { ...groupRecord(), quoteToken: zeroAddress };

    await expect((executor as any).computeGroupFinalPnlUsd(wethGroup, 10n ** 18n, 2n * 10n ** 17n)).resolves.toBe(600_000_000n);
    await expect((executor as any).computeGroupFinalPnlUsd(nativeGroup, 10n ** 18n, 2n * 10n ** 17n)).resolves.toBe(600_000_000n);
    expect(routes.quoteDirect).toHaveBeenCalledTimes(2);
  });

  it("keeps all Bid-Ask children active and the parent retryable when the batch reverts", async () => {
    const group = groupRecord();
    const children = [groupChild("child-7", 7n), groupChild("child-8", 8n)];
    const bins = [groupBin(0, 7n, "child-7", -120, -60), groupBin(1, 8n, "child-8", -60, 0)];
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      listPositionGroupBins: vi.fn().mockResolvedValue(bins),
      listActivePositions: vi.fn().mockResolvedValue(children),
      claimPositionGroupLease: vi.fn().mockResolvedValue(true),
      releasePositionGroupLease: vi.fn().mockResolvedValue(undefined),
      recordPositionGroupExecution: vi.fn().mockResolvedValue(undefined),
      setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      getBlockNumber: vi.fn().mockResolvedValue(100n),
      readContract: vi.fn().mockResolvedValue(owner),
      call: vi.fn().mockResolvedValue({ data: "0x" }),
    };
    const chains = { getById: vi.fn(() => ({ client, registry: v4Registry("robinhood") })) };
    const reader = { read: vi.fn((position: PositionRecord) => Promise.resolve(position.positionKey === "7" ? groupValue(-120, -60) : groupValue(-60, 0))) };
    const executor = new Executor(database as never, chains as never, reader as never, {} as never, {} as never, config);
    vi.spyOn(executor as any, "sendGroup").mockRejectedValue(new Error("close_batch transaction reverted"));

    await expect(executor.executeGroup(groupId, "stop_loss")).rejects.toThrow("close_batch transaction reverted");

    expect(database.setPositionGroupStatus).toHaveBeenLastCalledWith(groupId, "active", expect.objectContaining({ reason: "close_batch transaction reverted" }));
    expect(database.recordPositionGroupExecution).toHaveBeenCalledWith(groupId, "close_batch", "failed", undefined, undefined, undefined, "close_batch transaction reverted");
    expect(database).not.toHaveProperty("setPositionStatus");
  });

  it("keeps a group active when a transient RPC failure reaches the retry limit", async () => {
    vi.useFakeTimers();
    try {
      const group = {
        ...groupRecord(),
        metadata: { exitRetry: { attempts: 2 } },
      };
      const database = { setPositionGroupStatus: vi.fn().mockResolvedValue(undefined) };
      const executor = new Executor(database as never, {} as never, {} as never, {} as never, {} as never, config);

      await (executor as any).markGroupRetryable(group, "manual", "HTTP 429 Too Many Requests", true);

      expect(database.setPositionGroupStatus).toHaveBeenCalledWith(groupId, "active", expect.objectContaining({
        reason: "HTTP 429 Too Many Requests",
        settlementRetryDisabled: null,
        exitRetry: expect.objectContaining({ attempts: 3 }),
      }));
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not directly retry a stale dynamic group trigger", async () => {
    vi.useFakeTimers();
    try {
      const group = { ...groupRecord(), metadata: {} };
      const database = { setPositionGroupStatus: vi.fn().mockResolvedValue(undefined) };
      const executor = new Executor(database as never, {} as never, {} as never, {} as never, {} as never, config);
      const execute = vi.spyOn(executor, "executeGroup").mockResolvedValue(undefined);

      await (executor as any).markGroupRetryable(group, "trailing_take_profit", "HTTP 429 Too Many Requests", true);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(execute).not.toHaveBeenCalled();
      expect(database.setPositionGroupStatus).toHaveBeenCalledWith(group.id, "active", expect.objectContaining({
        exitRetry: expect.objectContaining({ reason: "trailing_take_profit" }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers the durable group trigger from retry metadata", () => {
    const executor = new Executor({} as never, {} as never, {} as never, {} as never, {} as never, config);
    const group = {
      ...groupRecord(),
      metadata: { exitRetry: { reason: "take_profit", attempts: 1 } },
    };

    expect((executor as any).groupExitTrigger(group)).toBe("take_profit");
  });

  it("prioritizes a sticky SL retry over an older profit trigger", () => {
    const executor = new Executor({} as never, {} as never, {} as never, {} as never, {} as never, config);
    const group = {
      ...groupRecord(),
      metadata: {
        exitTrigger: "take_profit",
        exitRetry: { reason: "stop_loss", attempts: 1 },
      },
    };

    expect((executor as any).groupExitTrigger(group)).toBe("stop_loss");
  });

  it("keeps a profit trigger scoped to the independently-qualified origin", async () => {
    const source = relatedPosition("source", token, usdg, usdg);
    const sibling = relatedPosition("sibling", usdg, token, usdg);
    const group = groupRecord();
    const child = relatedPosition("child", usdg, token, usdg, "armed", { managedBy: "position_group", positionGroupId: group.id });
    const protectedPosition = relatedPosition("review", usdg, token, usdg, "needs_review");
    const differentPair = relatedPosition("different", nvda, usdg, usdg);
    const database = {
      listActivePositions: vi.fn().mockResolvedValue([source, sibling, child, protectedPosition, differentPair]),
      listPositionGroups: vi.fn().mockResolvedValue([group]),
    };
    const chains = { getById: vi.fn(() => ({ registry: { name: "robinhood" } })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, config);
    const executePosition = vi.spyOn(executor, "execute").mockResolvedValue(undefined);
    const executeGroup = vi.spyOn(executor, "executeGroup").mockResolvedValue(undefined);

    await executor.executeRelatedPosition(source, "take_profit");

    expect(executePosition).toHaveBeenCalledWith(source, "take_profit");
    expect(executePosition).not.toHaveBeenCalledWith(sibling, "take_profit");
    expect(executePosition).not.toHaveBeenCalledWith(child, "take_profit");
    expect(executePosition).not.toHaveBeenCalledWith(protectedPosition, "take_profit");
    expect(executePosition).not.toHaveBeenCalledWith(differentPair, "take_profit");
    expect(executeGroup).not.toHaveBeenCalled();
  });

  it("does not cascade an OOR group trigger to a matching WETH position", async () => {
    const group = {
      ...groupRecord("v4"),
      id: "eth-group",
      token0: zeroAddress,
      token1: token,
      quoteToken: zeroAddress,
    };
    const wethPosition = relatedPosition("weth-position", weth, token, weth);
    const database = {
      getPositionGroup: vi.fn().mockResolvedValue(group),
      listActivePositions: vi.fn().mockResolvedValue([wethPosition]),
      listPositionGroups: vi.fn().mockResolvedValue([group]),
    };
    const chains = { getById: vi.fn(() => ({ registry: { name: "robinhood" } })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, wethConfig);
    const executePosition = vi.spyOn(executor, "execute").mockResolvedValue(undefined);
    const executeGroup = vi.spyOn(executor, "executeGroup").mockResolvedValue(undefined);

    await executor.executeRelatedGroup(group.id, "out_of_range_above");

    expect(executeGroup).toHaveBeenCalledWith(group.id, "out_of_range_above");
    expect(executePosition).not.toHaveBeenCalled();
  });

  it("deduplicates simultaneous related-pair close requests", async () => {
    const source = relatedPosition("source", token, usdg, usdg);
    const sibling = relatedPosition("sibling", usdg, token, usdg);
    const database = {
      listActivePositions: vi.fn().mockResolvedValue([source, sibling]),
      listPositionGroups: vi.fn().mockResolvedValue([]),
    };
    const chains = { getById: vi.fn(() => ({ registry: { name: "robinhood" } })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, config);
    const executePosition = vi.spyOn(executor, "execute").mockResolvedValue(undefined);

    await Promise.all([
      executor.executeRelatedPosition(source, "manual"),
      executor.executeRelatedPosition(sibling, "manual"),
    ]);

    expect(executePosition).toHaveBeenCalledTimes(2);
    expect(database.listActivePositions).toHaveBeenCalledTimes(1);
    expect(database.listPositionGroups).toHaveBeenCalledTimes(1);
  });

  it("queues a related-pair close when every target hits a transient RPC error", async () => {
    const source = relatedPosition("727323", token, usdg, usdg);
    const database = {
      listActivePositions: vi.fn().mockResolvedValue([source]),
      listPositionGroups: vi.fn().mockResolvedValue([]),
    };
    const chains = { getById: vi.fn(() => ({ registry: { name: "robinhood" } })) };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, {} as never, config);
    vi.spyOn(executor, "execute").mockRejectedValue(new TransientCloseError("727323"));

    await expect(executor.executeRelatedPosition(source, "manual")).rejects.toBeInstanceOf(TransientCloseError);
  });
});
