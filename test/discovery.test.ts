import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, pad, stringToHex, toHex, zeroAddress, type Address, type Hex } from "viem";

import { chainRegistry } from "../src/chains.js";
import { applyNativeDepositValue, DiscoveryService } from "../src/services/discovery.js";
import type { PositionGroupBinRecord, PositionGroupRecord } from "../src/types.js";

const owner = "0x0000000000000000000000000000000000000011" as Address;
const token0 = "0x0000000000000000000000000000000000000022" as Address;
const token1 = "0x0000000000000000000000000000000000000033" as Address;
const v3Pool = "0x0000000000000000000000000000000000000044" as Address;
const openHash = `0x${"a".repeat(64)}` as Hex;
const nvda = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;

function group(protocol: "v3" | "v4", poolKey: string, positionManager: Address, planJson: Record<string, unknown> = {}): PositionGroupRecord {
  return {
    id: `${protocol}-group`,
    chainId: chainRegistry.base.chain.id,
    protocol,
    positionManager,
    poolKey,
    owner,
    token0,
    token1,
    quoteToken: token0,
    shape: "bid_ask",
    shapeVersion: "delta-amount-linear-v1",
    requestedBinCount: 2,
    generatedBinCount: 2,
    mintableBinCount: 2,
    outerTickLower: -200,
    outerTickUpper: 200,
    anchorBinIndex: 0,
    totalDeposit: 100n,
    deployedCostQuote: 100n,
    directCloseAmount0: 100n,
    directCloseAmount1: 0n,
    totalReceivedQuote: 0n,
    status: "opening",
    planHash: "plan",
    planJson,
    referenceBlock: 90n,
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

function bin(groupId: string, index: number, lower: number, upper: number, openingAmount0 = 10n): PositionGroupBinRecord {
  return {
    id: `${groupId}-bin-${index}`,
    groupId,
    chainId: chainRegistry.base.chain.id,
    positionManager: chainRegistry.base.contracts.v3.positionManager,
    binIndex: index,
    tickLower: lower,
    tickUpper: upper,
    side: "token0",
    weightMicros: 1,
    allocatedAmount0: openingAmount0,
    allocatedAmount1: 0n,
    expectedLiquidity: 10n,
    expectedAmount0: openingAmount0,
    expectedAmount1: 0n,
    tokenId: null,
    positionId: null,
    openingAmount0,
    openingAmount1: 0n,
    closeAmount0: 0n,
    closeAmount1: 0n,
    settlementQuote: 0n,
    status: "planned",
    dropReason: null,
    openTransactionHash: null,
    closeTransactionHash: null,
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function topic(signature: string): Hex {
  return keccak256(stringToHex(signature));
}

function indexed(value: Address | bigint | Hex): Hex {
  return pad(typeof value === "bigint" ? toHex(value) : value, { size: 32 });
}

function transferLog(address: Address, tokenId: bigint, to = owner, from = zeroAddress): { address: Address; data: Hex; topics: Hex[] } {
  return { address, data: "0x", topics: [topic("Transfer(address,address,uint256)"), indexed(from), indexed(to), indexed(tokenId)] };
}

function increaseLog(address: Address, tokenId: bigint, liquidity: bigint, amount0: bigint, amount1: bigint): { address: Address; data: Hex; topics: Hex[] } {
  return {
    address,
    topics: [topic("IncreaseLiquidity(uint256,uint128,uint256,uint256)"), indexed(tokenId)],
    data: encodeAbiParameters([{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }], [liquidity, amount0, amount1]),
  };
}

function modifyLiquidityLog(address: Address, poolId: Hex, sender: Address, lower: number, upper: number, delta: bigint, salt: Hex): { address: Address; data: Hex; topics: Hex[] } {
  return {
    address,
    topics: [topic("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"), indexed(poolId), indexed(sender)],
    data: encodeAbiParameters([{ type: "int24" }, { type: "int24" }, { type: "int256" }, { type: "bytes32" }], [lower, upper, delta, salt]),
  };
}

function groupDatabase(bins: PositionGroupBinRecord[]) {
  const updatePositionGroupBin = vi.fn(async (_groupId: string, binIndex: number, patch: Partial<PositionGroupBinRecord>) => {
    const target = bins.find((candidate) => candidate.binIndex === binIndex)!;
    Object.assign(target, patch);
    return true;
  });
  const linkPositionGroupBinPosition = vi.fn(async (_groupId: string, binIndex: number, positionId: string, tokenId?: bigint) => {
    const target = bins.find((candidate) => candidate.binIndex === binIndex)!;
    target.positionId = positionId;
    target.tokenId = tokenId ?? target.tokenId;
    return true;
  });
  return {
    listPositionGroupBins: vi.fn().mockResolvedValue(bins),
    upsertPosition: vi.fn(async (value: Record<string, unknown>) => ({ id: `position-${value.positionKey}`, ...value })),
    linkPositionGroupBinPosition,
    updatePositionGroupBin,
    setPositionGroupOpenTransaction: vi.fn().mockResolvedValue(true),
    setPositionGroupStatus: vi.fn().mockResolvedValue(undefined),
    findPositionByKey: vi.fn().mockResolvedValue(null),
  };
}

describe("historical discovery reads", () => {
  it("reuses the confirmed V4 open receipt when the other RPC provider is behind", async () => {
    const manager = chainRegistry.robinhood.contracts.v4.positionManager;
    const poolManager = chainRegistry.robinhood.contracts.v4.poolManager;
    const tokenId = 910_656n;
    const poolId = `0x${"b".repeat(64)}` as Hex;
    const liquidity = 123_456n;
    const receipt = {
      transactionHash: openHash,
      blockNumber: 123n,
      logs: [
        transferLog(manager, tokenId),
        modifyLiquidityLog(poolManager, poolId, manager, -200, 200, liquidity, indexed(tokenId)),
      ],
    };
    const upsertPosition = vi.fn(async (value: Record<string, unknown>) => ({ id: "position", ...value }));
    const client = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "ownerOf") return owner;
        if (functionName === "poolKeys") return { currency0: token0, currency1: token1, fee: 500, tickSpacing: 10, hooks: zeroAddress };
        throw new Error(`unexpected ${functionName}`);
      }),
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error("Transaction receipt is not available on this provider yet")),
    };
    const discovery = new DiscoveryService(
      { upsertPosition } as never,
      { get: vi.fn(() => ({ client, registry: chainRegistry.robinhood })) } as never,
      { executorAddress: owner, quoteTokens: { robinhood: [{ symbol: "USDG", address: token0 }] } } as never,
    );
    (discovery as any).hydrateV4OpeningCashflow = vi.fn().mockResolvedValue(undefined);

    await (discovery as any).discoverV4Candidates("robinhood", [{
      asset: manager,
      transactionHash: openHash,
      blockNumber: 123n,
      from: zeroAddress,
      to: owner,
      tokenId,
      historyTrusted: true,
    }], receipt);

    expect(upsertPosition).toHaveBeenCalledWith(expect.objectContaining({
      positionKey: tokenId.toString(),
      liquidity,
      status: "syncing",
    }));
  });

  it("uses the archive scan client for V4 historical price reads", async () => {
    const regularClient = { readContract: vi.fn() };
    const archiveClient = { readContract: vi.fn().mockResolvedValue([1n << 96n, 0, 0, 0]) };
    const discovery = new DiscoveryService(
      {} as never,
      {
        getById: vi.fn(() => ({ registry: chainRegistry.robinhood, client: regularClient })),
        getForScan: vi.fn(() => ({ registry: chainRegistry.robinhood, client: archiveClient })),
        getForLogs: vi.fn(() => ({ registry: chainRegistry.robinhood, client: archiveClient })),
      } as never,
      {} as never,
    );
    const position = {
      chainId: 4663,
      token0: "0x0000000000000000000000000000000000000001",
      token1: "0x0000000000000000000000000000000000000002",
      quoteToken: "0x0000000000000000000000000000000000000002",
      metadata: {
        currency0: "0x0000000000000000000000000000000000000001",
        currency1: "0x0000000000000000000000000000000000000002",
        fee: 42500,
        tickSpacing: 425,
        hooks: "0x0000000000000000000000000000000000000000",
      },
    };

    const value = await (discovery as unknown as {
      quoteV4AmountsAtBlock(position: typeof position, amount0: bigint, amount1: bigint, blockNumber: bigint): Promise<bigint>;
    }).quoteV4AmountsAtBlock(position, 10n, 20n, 123n);

    expect(value).toBe(30n);
    expect(archiveClient.readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 123n }));
    expect(regularClient.readContract).not.toHaveBeenCalled();
  });

  it("does not auto-discover external Base positions during sync", async () => {
    const database = {
      getCursor: vi.fn().mockResolvedValue(100n),
      getBootstrap: vi.fn().mockResolvedValue(true),
      listPositionGroups: vi.fn().mockResolvedValue([]),
      saveCursor: vi.fn().mockResolvedValue(undefined),
    };
    const client = { getBlockNumber: vi.fn().mockResolvedValue(101n) };
    const discovery = new DiscoveryService(
      database as never,
      {
        get: vi.fn(() => ({ client, registry: chainRegistry.base })),
        getForScan: vi.fn(() => ({ client, registry: chainRegistry.base })),
        getForLogs: vi.fn(() => ({ client, registry: chainRegistry.base })),
      } as never,
      {
        startBlocks: { base: 0n, robinhood: 0n, bsc: 0n },
        scanBlockRange: 1_000n,
        rpcBootstrapLookbackBlocks: 10_000n,
      } as never,
    );
    const ownedV4 = vi.spyOn(discovery as any, "discoverOwnedV4Positions");
    const v2 = vi.spyOn(discovery as any, "discoverV2");
    const v3 = vi.spyOn(discovery as any, "discoverV3");
    const v4 = vi.spyOn(discovery as any, "discoverV4");
    const syncV3 = vi.spyOn(discovery as any, "syncV3Cashflows").mockResolvedValue(undefined);
    const syncV4 = vi.spyOn(discovery as any, "syncV4Cashflows").mockResolvedValue(undefined);

    await discovery.syncChain("base");

    expect(ownedV4).not.toHaveBeenCalled();
    expect(v2).not.toHaveBeenCalled();
    expect(v3).not.toHaveBeenCalled();
    expect(v4).not.toHaveBeenCalled();
    expect(syncV3).toHaveBeenCalledWith("base", 101n, 101n);
    expect(syncV4).toHaveBeenCalledWith("base", 101n, 101n);
    expect(database.saveCursor).toHaveBeenCalledWith(8453, 101n);
  });
});

describe("quote token assignment", () => {
  it("recognizes NVDA as the quote side of a Robinhood position", () => {
    const discovery = new DiscoveryService(
      {} as never,
      {} as never,
      {
        quoteTokens: {
          base: [],
          robinhood: [{ symbol: "NVDA", address: nvda }],
          bsc: [],
        },
      } as never,
    );

    const quoteToken = (discovery as unknown as {
      findQuoteToken(name: "robinhood", token0: Address, token1: Address): Address | null;
    }).findQuoteToken("robinhood", token0, nvda);

    expect(quoteToken).toBe(nvda);
  });
});

describe("known Bid-Ask open receipt correlation", () => {
  it("maps V3 tokens by authoritative ticks and increase events, not log order", async () => {
    const manager = chainRegistry.base.contracts.v3.positionManager;
    const tokenIds = [101n, 205n];
    const receipt = {
      status: "success",
      blockNumber: 123n,
      logs: [
        transferLog(manager, tokenIds[1]!),
        increaseLog(manager, tokenIds[0]!, 10n, 7n, 0n),
        transferLog(manager, tokenIds[0]!),
        increaseLog(manager, tokenIds[1]!, 20n, 13n, 0n),
      ],
    };
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "getPool") return v3Pool;
        if (functionName === "ownerOf") return owner;
        if (functionName === "positions") {
          const tokenId = args?.[0] as bigint;
          return tokenId === tokenIds[0]
            ? [0n, zeroAddress, token0, token1, 500, -200, -100, 10n, 0n, 0n, 0n, 0n]
            : [0n, zeroAddress, token0, token1, 500, -100, 0, 20n, 0n, 0n, 0n, 0n];
        }
        throw new Error(`unexpected ${functionName}`);
      }),
    };
    const bins = [bin("v3-group", 0, -200, -100), bin("v3-group", 1, -100, 0)];
    const database = groupDatabase(bins);
    const regularClient = { getTransactionReceipt: vi.fn(), readContract: vi.fn() };
    const discovery = new DiscoveryService(
      database as never,
      {
        get: vi.fn(() => ({ client: regularClient, registry: chainRegistry.base })),
        getForScan: vi.fn(() => ({ client, registry: chainRegistry.base })),
      } as never,
      { executorAddress: owner } as never,
    );

    const positions = await discovery.reconcileKnownGroupOpen("base", group("v3", v3Pool, manager, { feeTier: 500 }), openHash);

    expect(positions.map((position) => position.positionKey).sort()).toEqual(["101", "205"]);
    expect(database.updatePositionGroupBin).toHaveBeenCalledWith("v3-group", 0, expect.objectContaining({ tokenId: 101n, openingAmount0: 7n, status: "minted" }));
    expect(database.updatePositionGroupBin).toHaveBeenCalledWith("v3-group", 1, expect.objectContaining({ tokenId: 205n, openingAmount0: 13n, status: "minted" }));
    expect(database.setPositionGroupOpenTransaction).toHaveBeenCalledWith("v3-group", openHash, "active");
    expect((discovery as unknown as { chains: { getForScan: ReturnType<typeof vi.fn> } }).chains.getForScan).toHaveBeenCalledWith("base");
    expect(regularClient.readContract).not.toHaveBeenCalled();
  });

  it("correlates V4 salts and interleaved ModifyLiquidity events and is replay-safe", async () => {
    const manager = chainRegistry.base.contracts.v4.positionManager;
    const poolManager = chainRegistry.base.contracts.v4.poolManager;
    const poolKey = { currency0: token0, currency1: token1, fee: 500, tickSpacing: 10, hooks: zeroAddress as Address };
    const poolId = keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    ));
    const tokenIds = [7n, 8n];
    const packInfo = (lower: number, upper: number) => (BigInt(lower & 0xffffff) << 8n) | (BigInt(upper & 0xffffff) << 32n);
    const receipt = {
      status: "success",
      blockNumber: 456n,
      logs: [
        transferLog(manager, tokenIds[0]!),
        modifyLiquidityLog(poolManager, poolId, manager, -100, -50, 10n, indexed(tokenIds[1]!)),
        transferLog(manager, tokenIds[1]!),
        modifyLiquidityLog(poolManager, poolId, manager, -200, -100, 20n, indexed(tokenIds[0]!)),
      ],
    };
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "ownerOf") return owner;
        if (functionName === "getPoolAndPositionInfo") {
          const tokenId = args?.[0] as bigint;
          return [poolKey, tokenId === tokenIds[0] ? packInfo(-200, -100) : packInfo(-100, -50)];
        }
        if (functionName === "getPositionLiquidity") {
          const tokenId = args?.[0] as bigint;
          return tokenId === tokenIds[0] ? 20n : 10n;
        }
        throw new Error(`unexpected ${functionName}`);
      }),
    };
    const bins = [
      { ...bin("v4-group", 0, -200, -100, 20n), positionManager: manager },
      { ...bin("v4-group", 1, -100, -50, 10n), positionManager: manager },
    ];
    const database = groupDatabase(bins);
    const discovery = new DiscoveryService(
      database as never,
      { get: vi.fn(() => ({ client, registry: chainRegistry.base })) } as never,
      { executorAddress: owner } as never,
    );
    const v4Group = group("v4", poolId, manager, { poolKey });

    await expect(discovery.reconcilePositionGroupOpen("base", v4Group, openHash)).resolves.toHaveLength(2);
    await expect(discovery.reconcilePositionGroupOpen("base", v4Group, openHash)).resolves.toHaveLength(2);

    expect(database.upsertPosition).toHaveBeenCalledWith(expect.objectContaining({ positionKey: "7", liquidity: 20n, poolAddress: null }));
    expect(database.updatePositionGroupBin).toHaveBeenCalledWith("v4-group", 0, expect.objectContaining({ tokenId: 7n, status: "minted" }));
    expect(database.setPositionGroupOpenTransaction).toHaveBeenCalledTimes(2);
  });

  it("marks a known group review-required when a V4 batch contains an extra modification", async () => {
    const manager = chainRegistry.base.contracts.v4.positionManager;
    const poolManager = chainRegistry.base.contracts.v4.poolManager;
    const poolId = `0x${"b".repeat(64)}` as Hex;
    const bins = [
      { ...bin("v4-group", 0, -100, 0), positionManager: manager },
      { ...bin("v4-group", 1, 0, 100), positionManager: manager },
    ];
    const receipt = {
      status: "success",
      blockNumber: 789n,
      logs: [
        transferLog(manager, 1n),
        transferLog(manager, 2n),
        modifyLiquidityLog(poolManager, poolId, manager, -100, 0, 10n, indexed(1n)),
        modifyLiquidityLog(poolManager, poolId, manager, 0, 100, 10n, indexed(2n)),
        modifyLiquidityLog(poolManager, poolId, manager, 100, 200, 10n, indexed(3n)),
      ],
    };
    const database = groupDatabase(bins);
    const discovery = new DiscoveryService(
      database as never,
      {
        get: vi.fn(() => ({
          client: { getTransactionReceipt: vi.fn().mockResolvedValue(receipt), readContract: vi.fn() },
          registry: chainRegistry.base,
        })),
      } as never,
      { executorAddress: owner } as never,
    );

    await expect(discovery.reconcilePositionGroupOpen("base", group("v4", poolId, manager), openHash)).rejects.toThrow(/exact ModifyLiquidity/);
    expect(database.setPositionGroupStatus).toHaveBeenCalledWith("v4-group", "needs_review", expect.objectContaining({ reason: "group_open_receipt_correlation_failed" }));
    expect(database.setPositionGroupOpenTransaction).not.toHaveBeenCalled();
  });
});

describe("pending Bid-Ask open reconciliation retries", () => {
  function v4ReviewSetup(bins: PositionGroupBinRecord[]) {
    const manager = chainRegistry.base.contracts.v4.positionManager;
    const poolManager = chainRegistry.base.contracts.v4.poolManager;
    const poolKey = { currency0: token0, currency1: token1, fee: 500, tickSpacing: 10, hooks: zeroAddress as Address };
    const poolId = keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    ));
    const tokenIds = [7n, 8n];
    const packInfo = (lower: number, upper: number) => (BigInt(lower & 0xffffff) << 8n) | (BigInt(upper & 0xffffff) << 32n);
    const receipt = {
      status: "success",
      blockNumber: 456n,
      logs: [
        transferLog(manager, tokenIds[0]!),
        modifyLiquidityLog(poolManager, poolId, manager, -100, -50, 10n, indexed(tokenIds[1]!)),
        transferLog(manager, tokenIds[1]!),
        modifyLiquidityLog(poolManager, poolId, manager, -200, -100, 20n, indexed(tokenIds[0]!)),
      ],
    };
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "ownerOf") return owner;
        if (functionName === "getPoolAndPositionInfo") {
          const tokenId = args?.[0] as bigint;
          return [poolKey, tokenId === tokenIds[0] ? packInfo(-200, -100) : packInfo(-100, -50)];
        }
        if (functionName === "getPositionLiquidity") {
          const tokenId = args?.[0] as bigint;
          return tokenId === tokenIds[0] ? 20n : 10n;
        }
        throw new Error(`unexpected ${functionName}`);
      }),
    };
    const database = {
      ...groupDatabase(bins),
      listPositionGroups: vi.fn().mockResolvedValue([{
        ...group("v4", poolId, manager),
        status: "needs_review",
        openTransactionHash: openHash,
        metadata: {
          reason: "group_open_receipt_correlation_failed",
          openReceiptRetriedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        },
      }]),
    };
    const discovery = new DiscoveryService(
      database as never,
      { get: vi.fn(() => ({ client, registry: chainRegistry.base })) } as never,
      { executorAddress: owner } as never,
    );
    return { database, discovery, manager, tokenIds, poolId, client };
  }

  it("retries needs_review correlation-failed opens and links previously discovered fallback positions", async () => {
    const manager = chainRegistry.base.contracts.v4.positionManager;
    const bins = [
      { ...bin("v4-group", 0, -200, -100, 20n), positionManager: manager, status: "needs_review" as const },
      { ...bin("v4-group", 1, -100, -50, 10n), positionManager: manager, status: "needs_review" as const },
    ];
    const { database, discovery } = v4ReviewSetup(bins);
    vi.mocked(database.findPositionByKey).mockResolvedValue({ id: "fallback-position-7" } as never);

    await discovery.reconcilePendingPositionGroupOpens("base");

    expect(database.setPositionGroupOpenTransaction).toHaveBeenCalledWith("v4-group", openHash, "active", {
      reason: null,
      correlationError: null,
      lastExecutionError: null,
      openReceiptRetriedAt: null,
      pendingRawTransaction: null,
    });
    expect(database.updatePositionGroupBin).toHaveBeenCalledWith("v4-group", 0, expect.objectContaining({ tokenId: 7n, status: "minted" }));
    expect(database.findPositionByKey).toHaveBeenCalledWith(chainRegistry.base.chain.id, "v4", "7");
  });

  it("does not re-notify positions that were already discovered as fallbacks", async () => {
    const manager = chainRegistry.base.contracts.v4.positionManager;
    const bins = [
      { ...bin("v4-group", 0, -200, -100, 20n), positionManager: manager, status: "needs_review" as const },
      { ...bin("v4-group", 1, -100, -50, 10n), positionManager: manager, status: "needs_review" as const },
    ];
    const { database, poolId, client } = v4ReviewSetup(bins);
    vi.mocked(database.findPositionByKey).mockResolvedValue({ id: "existing-fallback" } as never);
    const notifier = { positionDiscovered: vi.fn() };

    const discoveryWithNotifier = new DiscoveryService(
      database as never,
      { get: vi.fn(() => ({ client, registry: chainRegistry.base })) } as never,
      { executorAddress: owner } as never,
      notifier as never,
    );
    await discoveryWithNotifier.reconcileKnownGroupOpen("base", { ...group("v4", poolId, manager), status: "needs_review" }, openHash);

    expect(notifier.positionDiscovered).not.toHaveBeenCalled();
  });

  it("retries cancelled opens that failed after a confirmed transaction", async () => {
    const manager = chainRegistry.base.contracts.v4.positionManager;
    const bins = [
      { ...bin("v4-group", 0, -200, -100, 20n), positionManager: manager, status: "needs_review" as const },
      { ...bin("v4-group", 1, -100, -50, 10n), positionManager: manager, status: "needs_review" as const },
    ];
    const { database, discovery, poolId } = v4ReviewSetup(bins);
    database.listPositionGroups = vi.fn().mockResolvedValue([{
      ...group("v4", poolId, manager),
      status: "cancelled",
      openTransactionHash: openHash,
      metadata: { reason: "bid_ask_open_failed", lastExecutionError: "NOT_MINTED" },
    }]);

    await discovery.reconcilePendingPositionGroupOpens("base");

    expect(database.setPositionGroupOpenTransaction).toHaveBeenCalledWith("v4-group", openHash, "active", {
      reason: null,
      correlationError: null,
      lastExecutionError: null,
      openReceiptRetriedAt: null,
      pendingRawTransaction: null,
    });
  });

  it("reads minted NFT ownership from the execution client when scan still returns NOT_MINTED", async () => {
    const manager = chainRegistry.base.contracts.v4.positionManager;
    const bins = [
      { ...bin("v4-group", 0, -200, -100, 20n), positionManager: manager },
      { ...bin("v4-group", 1, -100, -50, 10n), positionManager: manager },
    ];
    const { database, client, poolId } = v4ReviewSetup(bins);
    const scanClient = {
      ...client,
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "ownerOf") throw new Error("NOT_MINTED");
        return client.readContract({ functionName, args });
      }),
    };
    const executionClient = {
      getTransactionReceipt: client.getTransactionReceipt,
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "ownerOf") return owner;
        return client.readContract({ functionName, args });
      }),
    };
    const discovery = new DiscoveryService(
      database as never,
      {
        get: vi.fn(() => ({ client: scanClient, registry: chainRegistry.base })),
        getForScan: vi.fn(() => ({ client: scanClient, registry: chainRegistry.base })),
        getForExecution: vi.fn(() => ({ client: executionClient, registry: chainRegistry.base })),
      } as never,
      { executorAddress: owner } as never,
    );

    await expect(discovery.reconcileKnownGroupOpen("base", group("v4", poolId, manager, {
      poolKey: { currency0: token0, currency1: token1, fee: 500, tickSpacing: 10, hooks: zeroAddress },
    }), openHash)).resolves.toHaveLength(2);
    expect(executionClient.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "ownerOf" }));
  });

  it("skips needs_review correlation-failed opens that were retried recently", async () => {
    const manager = chainRegistry.base.contracts.v4.positionManager;
    const database = {
      ...groupDatabase([]),
      listPositionGroups: vi.fn().mockResolvedValue([{
        ...group("v4", `0x${"c".repeat(64)}`, manager),
        status: "needs_review",
        openTransactionHash: openHash,
        metadata: { reason: "group_open_receipt_correlation_failed", openReceiptRetriedAt: new Date().toISOString() },
      }]),
    };
    const client = { getTransactionReceipt: vi.fn() };
    const discovery = new DiscoveryService(
      database as never,
      { get: vi.fn(() => ({ client, registry: chainRegistry.base })) } as never,
      { executorAddress: owner } as never,
    );

    await discovery.reconcilePendingPositionGroupOpens("base");

    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
    expect(database.setPositionGroupOpenTransaction).not.toHaveBeenCalled();
  });

  it("uses a provided receipt without a second RPC receipt lookup", async () => {
    const manager = chainRegistry.base.contracts.v3.positionManager;
    const tokenIds = [101n, 205n];
    const receipt = {
      status: "success",
      blockNumber: 123n,
      logs: [
        transferLog(manager, tokenIds[1]!),
        increaseLog(manager, tokenIds[0]!, 10n, 7n, 0n),
        transferLog(manager, tokenIds[0]!),
        increaseLog(manager, tokenIds[1]!, 20n, 13n, 0n),
      ],
    };
    const client = {
      getTransactionReceipt: vi.fn(() => { throw new Error("receipt lookup must not run when a receipt is provided"); }),
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "getPool") return v3Pool;
        if (functionName === "ownerOf") return owner;
        if (functionName === "positions") {
          const tokenId = args?.[0] as bigint;
          return tokenId === tokenIds[0]
            ? [0n, zeroAddress, token0, token1, 500, -200, -100, 10n, 0n, 0n, 0n, 0n]
            : [0n, zeroAddress, token0, token1, 500, -100, 0, 20n, 0n, 0n, 0n, 0n];
        }
        throw new Error(`unexpected ${functionName}`);
      }),
    };
    const bins = [bin("v3-group", 0, -200, -100), bin("v3-group", 1, -100, 0)];
    const database = groupDatabase(bins);
    const discovery = new DiscoveryService(
      database as never,
      { get: vi.fn(() => ({ client, registry: chainRegistry.base })) } as never,
      { executorAddress: owner } as never,
    );

    const positions = await discovery.reconcileKnownGroupOpen("base", group("v3", v3Pool, manager, { feeTier: 500 }), openHash, receipt);

    expect(positions.map((position) => position.positionKey).sort()).toEqual(["101", "205"]);
    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
    expect(database.setPositionGroupOpenTransaction).toHaveBeenCalledWith("v3-group", openHash, "active");
  });
});

describe("discovery cursor and owned detect", () => {
  it("does not advance the cursor when a log scan fails", async () => {
    const saveCursor = vi.fn();
    const database = {
      listPositionGroups: vi.fn().mockResolvedValue([]),
      getCursor: vi.fn().mockResolvedValue(100n),
      getBootstrap: vi.fn().mockResolvedValue({ source: "test" }),
      saveCursor,
    };
    const client = {
      getBlockNumber: vi.fn().mockResolvedValue(500n),
      getLogs: vi.fn().mockRejectedValue(new Error("Execution reverted for an unknown reason")),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "nextTokenId") return 1n;
        throw new Error(`unexpected ${functionName}`);
      }),
    };
    const discovery = new DiscoveryService(
      database as never,
      {
        get: vi.fn(() => ({ client, registry: chainRegistry.robinhood })),
        getForScan: vi.fn(() => ({ client, registry: chainRegistry.robinhood })),
        getForLogs: vi.fn(() => ({ client, registry: chainRegistry.robinhood })),
      } as never,
      {
        executorAddress: owner,
        startBlocks: { base: 0n, robinhood: 0n, bsc: 0n },
        scanBlockRange: 1_000n,
        maxLogBlockRange: 1_000n,
        rpcBootstrapLookbackBlocks: 10_000n,
        rpcRequestDelayMs: 0,
      } as never,
    );

    await discovery.syncChain("robinhood");

    expect(saveCursor).not.toHaveBeenCalled();
  });

  it("detects a newly owned V3 NFT that log discovery missed", async () => {
    const upserted = {
      id: "new",
      protocol: "v3",
      positionKey: "727661",
      status: "syncing",
      quoteToken: token0,
      token0,
      token1,
      poolAddress: v3Pool,
      openedAtBlock: 40734594n,
      metadata: { dex: "uniswap" },
    };
    const database = {
      listOpenPositions: vi.fn().mockResolvedValue([]),
      findPositionByKey: vi.fn().mockResolvedValue(null),
      upsertPosition: vi.fn().mockResolvedValue(upserted),
      setPositionStatus: vi.fn().mockResolvedValue(undefined),
      addCashflow: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      getBlockNumber: vi.fn().mockResolvedValue(40734594n),
      getLogs: vi.fn().mockResolvedValue([]),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "balanceOf") return 1n;
        if (functionName === "tokenOfOwnerByIndex") return 727661n;
        if (functionName === "ownerOf") return owner;
        if (functionName === "positions") return [0n, zeroAddress, token0, token1, 10_000, -200, 200, 10n ** 18n, 0n, 0n, 0n, 0n];
        if (functionName === "getPool") return v3Pool;
        if (functionName === "nextTokenId") return 1n;
        if (functionName === "slot0") return [1n << 96n, 0, 0, 0, 0, 0, true];
        throw new Error(`unexpected ${functionName}`);
      }),
    };
    const discovery = new DiscoveryService(
      database as never,
      {
        get: vi.fn(() => ({ client, registry: chainRegistry.robinhood })),
        getForScan: vi.fn(() => ({ client, registry: chainRegistry.robinhood })),
        getForLogs: vi.fn(() => ({ client, registry: chainRegistry.robinhood })),
      } as never,
      {
        executorAddress: owner,
        quoteTokens: { robinhood: [{ symbol: "USDG", address: token0 }] },
        maxLogBlockRange: 1_000n,
        rpcRequestDelayMs: 0,
      } as never,
    );

    const result = await discovery.detectOwnedPositions("robinhood");

    expect(result.v3).toBe(1);
    expect(result.discovered.map((position) => position.positionKey)).toEqual(["727661"]);
    expect(database.upsertPosition).toHaveBeenCalledWith(expect.objectContaining({
      positionKey: "727661",
      status: "syncing",
    }));
    expect(database.setPositionStatus).toHaveBeenCalledWith("new", "syncing", expect.objectContaining({ source: "manual_detect" }));
    expect(database.addCashflow).toHaveBeenCalledWith("new", 40734594n, "reconstructed:new", "deposit", expect.any(BigInt), expect.objectContaining({ source: "live_liquidity" }));
  });

  it("enumerates all owned V4 NFTs without scanning token IDs", async () => {
    const client = {
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "balanceOf") return 2n;
        if (functionName === "tokenOfOwnerByIndex") return (args?.[1] as bigint) === 0n ? 2_942_824n : 2_942_825n;
        throw new Error(`unexpected ${functionName}`);
      }),
    };
    const discovery = new DiscoveryService(
      {} as never,
      { getForScan: vi.fn(() => ({ client, registry: chainRegistry.base })) } as never,
      { executorAddress: owner } as never,
    );

    const tokenIds = await (discovery as unknown as { ownedV4TokenIds(name: "base"): Promise<bigint[]> }).ownedV4TokenIds("base");

    expect(tokenIds).toEqual([2_942_824n, 2_942_825n]);
    expect(client.readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: "nextTokenId" }));
    expect(client.readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: "ownerOf" }));
  });

  it("recovers V4 NFTs from Alchemy transfers when the manager is not enumerable", async () => {
    const client = {
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "balanceOf") return 1n;
        if (functionName === "tokenOfOwnerByIndex") throw new Error("not enumerable");
        if (functionName === "ownerOf" && args?.[0] === 2_942_824n) return owner;
        throw new Error(`unexpected ${functionName}`);
      }),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { transfers: [{ tokenId: "2942824" }] } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const discovery = new DiscoveryService(
      {} as never,
      { getForScan: vi.fn(() => ({ client, registry: chainRegistry.base })) } as never,
      { executorAddress: owner, alchemyHttp: { base: "https://alchemy.example" } } as never,
    );

    const tokenIds = await (discovery as unknown as { ownedV4TokenIds(name: "base", allowHistoricalRecovery?: boolean): Promise<bigint[]> }).ownedV4TokenIds("base", true);

    expect(tokenIds).toEqual([2_942_824n]);
    expect(fetchMock).toHaveBeenCalledWith("https://alchemy.example", expect.objectContaining({ method: "POST" }));
  });

  it("counts native ETH msg.value on a V4 increase when Transfer logs omit token0", () => {
    const amounts = { intoPool0: 0n, intoPool1: 2_180_218_165_949_907_576n };
    applyNativeDepositValue(amounts, zeroAddress, token1, 147_922_240_609_687_031n);
    expect(amounts.intoPool0).toBe(147_922_240_609_687_031n);
    expect(amounts.intoPool1).toBe(2_180_218_165_949_907_576n);
  });

  it("does not overwrite an ERC-20 into-pool amount with msg.value", () => {
    const amounts = { intoPool0: 10n, intoPool1: 0n };
    applyNativeDepositValue(amounts, zeroAddress, token1, 99n);
    expect(amounts.intoPool0).toBe(10n);
    expect(amounts.intoPool1).toBe(0n);
  });
});
