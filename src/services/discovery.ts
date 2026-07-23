import { decodeEventLog, encodeAbiParameters, keccak256, pad, toHex, zeroAddress, type Address, type Hex, type Log, type PublicClient } from "viem";

import {
  erc20Abi,
  erc20TransferEvent,
  erc721TransferEvent,
  v2BurnEvent,
  v2MintEvent,
  v2PairAbi,
  v3CollectEvent,
  v3FactoryAbi,
  v3IncreaseLiquidityEvent,
  v3PoolAbi,
  v3PositionManagerAbi,
  v4ModifyPositionEvent,
  v4PoolManagerModifyLiquidityEvent,
  v4PoolKeysAbi,
  v4PositionManagerAbi,
  v4StateViewAbi,
} from "../abi.js";
import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type { ChainName, PositionRecord, PositionStatus, Protocol } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import type { Notifier } from "./notifier.js";
import { amountsForLiquidity } from "./uniswap-math.js";

export interface WalletActivity {
  asset: Address;
  transactionHash: Hex;
  blockNumber: bigint;
  from?: Address;
  to?: Address;
}

export interface NftActivity extends WalletActivity {
  tokenId: bigint;
  historyTrusted: boolean;
}

export class DiscoveryService {
  constructor(
    private readonly database: Database,
    private readonly chains: ChainClients,
    private readonly config: RuntimeConfig,
    private readonly notifier?: Notifier,
  ) {}

  async syncChain(name: ChainName): Promise<void> {
    const { client, registry } = this.chains.get(name);
    const latest = await client.getBlockNumber();
    const cursor = await this.database.getCursor(registry.chain.id);
    const bootstrap = await this.database.getBootstrap(registry.chain.id);
    const configuredStart = this.config.startBlocks[name];
    const fallbackStart = latest > this.config.rpcBootstrapLookbackBlocks ? latest - this.config.rpcBootstrapLookbackBlocks : 0n;
    // Never continue an old genesis scan when no indexed bootstrap has completed.
    const useLimitedRpcFallback = configuredStart === 0n && !bootstrap && (cursor === null || cursor < fallbackStart);
    const fromBlock = useLimitedRpcFallback
      ? fallbackStart
      : cursor === null
        ? configuredStart
        : cursor + 1n;
    if (fromBlock > latest) return;
    const toBlock = minBigInt(latest, fromBlock + this.config.scanBlockRange - 1n);

    if (useLimitedRpcFallback) {
      log.warn({ chain: name, fromBlock, toBlock }, "Alchemy bootstrap is unavailable; using limited RPC lookback instead of genesis scan");
    }
    log.info({ chain: name, fromBlock, toBlock }, "syncing discovery range");
    const v2Transfers = await this.getWalletTransferLogs(name, fromBlock, toBlock);
    await this.discoverV2(name, v2Transfers);
    await this.discoverV3(name, fromBlock, toBlock);
    await this.discoverV4(name, fromBlock, toBlock);
    await this.syncV3Cashflows(name, fromBlock, toBlock);
    await this.syncV4Cashflows(name, fromBlock, toBlock);
    await this.database.saveCursor(registry.chain.id, toBlock);
  }

  private async getWalletTransferLogs(name: ChainName, fromBlock: bigint, toBlock: bigint): Promise<Log[]> {
    const owner = this.config.executorAddress;
    const [incoming, outgoing] = await Promise.all([
      this.getLogsChunked(name, { event: erc20TransferEvent, args: { to: owner }, fromBlock, toBlock }),
      this.getLogsChunked(name, { event: erc20TransferEvent, args: { from: owner }, fromBlock, toBlock }),
    ]);
    const logs = new Map<string, Log>();
    for (const item of [...incoming, ...outgoing]) {
      logs.set(`${item.transactionHash}-${item.logIndex}`, item);
    }
    return [...logs.values()];
  }

  private async getLogsChunked(
    name: ChainName,
    params: { fromBlock: bigint; toBlock: bigint; [key: string]: unknown },
  ): Promise<Log[]> {
    const { client } = this.chains.get(name);
    const chunk = this.config.maxLogBlockRange;
    const all: Log[] = [];
    let start = params.fromBlock;
    const end = params.toBlock;
    while (start <= end) {
      const windowEnd = minBigInt(end, start + chunk - 1n);
      const page = await throttledGetLogs(client, { ...params, fromBlock: start, toBlock: windowEnd } as Parameters<PublicClient["getLogs"]>[0], this.config.rpcRequestDelayMs);
      all.push(...(page as Log[]));
      if (windowEnd >= end) break;
      start = windowEnd + 1n;
    }
    return all;
  }

  private async discoverV2(name: ChainName, transfers: Log[]): Promise<void> {
    const activities = transfers.flatMap((item) => {
      if (!item.transactionHash || item.blockNumber === null) return [];
      return [{ asset: item.address, transactionHash: item.transactionHash, blockNumber: item.blockNumber } satisfies WalletActivity];
    });
    await this.discoverV2Activities(name, activities);
  }

  async discoverV2Activities(name: ChainName, transfers: WalletActivity[]): Promise<PositionRecord[]> {
    const { client, registry } = this.chains.get(name);
    const candidates = [...new Set(transfers.map((item) => item.asset.toLowerCase()))] as Address[];
    const positions: PositionRecord[] = [];

    for (const pair of candidates) {
      try {
        const factory = await client.readContract({ address: pair, abi: v2PairAbi, functionName: "factory" });
        if (factory.toLowerCase() !== registry.contracts.v2.factory.toLowerCase()) continue;
        const [token0, token1, balance] = await Promise.all([
          client.readContract({ address: pair, abi: v2PairAbi, functionName: "token0" }),
          client.readContract({ address: pair, abi: v2PairAbi, functionName: "token1" }),
          client.readContract({ address: pair, abi: erc20Abi, functionName: "balanceOf", args: [this.config.executorAddress] }),
        ]);
        if (balance === 0n) continue;

        const quoteToken = this.findQuoteToken(name, token0, token1);
        const relevant = transfers.filter((item) => item.asset.toLowerCase() === pair.toLowerCase());
        const openedAtBlock = relevant.reduce((minimum, item) => minBigInt(minimum, item.blockNumber), relevant[0]?.blockNumber ?? 0n);
        const position = await this.database.upsertPosition({
          chainId: registry.chain.id,
          protocol: "v2",
          positionKey: pair.toLowerCase(),
          owner: this.config.executorAddress,
          poolAddress: pair,
          token0,
          token1,
          quoteToken,
          status: this.initialStatus(quoteToken),
          liquidity: balance,
          openedAtBlock,
          metadata: { factory: registry.contracts.v2.factory, source: "lp_transfer" },
        });
        await this.reconstructV2Cashflows(position, relevant);
        positions.push(position);
        await this.notifier?.positionDiscovered(position);
      } catch {
        // Arbitrary ERC-20 transfer candidates are expected to fail the pair interface probe.
      }
    }
    return positions;
  }

  private async reconstructV2Cashflows(position: PositionRecord, transfers: WalletActivity[]): Promise<void> {
    if (!position.quoteToken) return;
    const { client } = this.chains.getById(position.chainId);
    for (const transfer of transfers) {
      if (!position.poolAddress) continue;
      try {
        const receipt = await client.getTransactionReceipt({ hash: transfer.transactionHash });
        const mint = receipt.logs
          .filter((item) => item.address.toLowerCase() === position.poolAddress!.toLowerCase())
          .map((item) => tryDecode(v2MintEvent, item))
          .map(eventAmounts)
          .find((item): item is { amount0: bigint; amount1: bigint } => item !== null);
        if (mint) {
          const quoteValue = quoteValueFromPairAmounts(position, mint.amount0, mint.amount1);
          await this.database.addCashflow(position.id, transfer.blockNumber, transfer.transactionHash, "deposit", quoteValue, {
            protocol: "v2",
            token0Amount: mint.amount0.toString(),
            token1Amount: mint.amount1.toString(),
          });
        }
        const burn = receipt.logs
          .filter((item) => item.address.toLowerCase() === position.poolAddress!.toLowerCase())
          .map((item) => tryDecode(v2BurnEvent, item))
          .map(eventAmounts)
          .find((item): item is { amount0: bigint; amount1: bigint } => item !== null);
        if (burn) {
          const quoteValue = quoteValueFromPairAmounts(position, burn.amount0, burn.amount1);
          await this.database.addCashflow(position.id, transfer.blockNumber, transfer.transactionHash, "withdrawal", quoteValue, {
            protocol: "v2",
            token0Amount: burn.amount0.toString(),
            token1Amount: burn.amount1.toString(),
          });
        }
      } catch (error) {
        log.warn({ err: error, positionId: position.id, transactionHash: transfer.transactionHash }, "could not reconstruct V2 cashflow");
      }
    }
  }

  private async discoverV3(name: ChainName, fromBlock: bigint, toBlock: bigint): Promise<void> {
    const { registry } = this.chains.get(name);
    const [incoming, outgoing] = await Promise.all([
      this.getLogsChunked(name, {
        address: registry.contracts.v3.positionManager,
        event: erc721TransferEvent,
        args: { to: this.config.executorAddress },
        fromBlock,
        toBlock,
      }),
      this.getLogsChunked(name, {
        address: registry.contracts.v3.positionManager,
        event: erc721TransferEvent,
        args: { from: this.config.executorAddress },
        fromBlock,
        toBlock,
      }),
    ]);
    const candidates = new Map<bigint, NftActivity>();
    for (const item of [...incoming, ...outgoing]) {
      const args = logArgs<{ tokenId?: bigint; from?: Address; to?: Address }>(item);
      if (args.tokenId === undefined || !item.transactionHash || item.blockNumber == null) continue;
      const existing = candidates.get(args.tokenId);
      candidates.set(args.tokenId, {
        asset: registry.contracts.v3.positionManager,
        transactionHash: item.transactionHash,
        blockNumber: existing ? minBigInt(existing.blockNumber, item.blockNumber) : item.blockNumber,
        from: args.from,
        to: args.to,
        tokenId: args.tokenId,
        historyTrusted: Boolean(existing?.historyTrusted || (args.from?.toLowerCase() === zeroAddress && args.to?.toLowerCase() === this.config.executorAddress.toLowerCase())),
      });
    }
    await this.discoverV3Candidates(name, [...candidates.values()]);
  }

  async discoverV3Candidates(name: ChainName, candidates: NftActivity[]): Promise<PositionRecord[]> {
    const { client, registry } = this.chains.get(name);
    const positions: PositionRecord[] = [];
    for (const candidate of candidates) {
      const tokenId = candidate.tokenId;
      try {
        const owner = await client.readContract({
          address: registry.contracts.v3.positionManager,
          abi: v3PositionManagerAbi,
          functionName: "ownerOf",
          args: [tokenId],
        });
        if (owner.toLowerCase() !== this.config.executorAddress.toLowerCase()) continue;
        const details = (await client.readContract({
          address: registry.contracts.v3.positionManager,
          abi: v3PositionManagerAbi,
          functionName: "positions",
          args: [tokenId],
        })) as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];
        const [, , token0, token1, fee, , , liquidity] = details;
        if (liquidity === 0n) continue;
        const pool = await client.readContract({
          address: registry.contracts.v3.factory,
          abi: v3FactoryAbi,
          functionName: "getPool",
          args: [token0, token1, fee],
        });
        if (pool === zeroAddress) continue;
        const quoteToken = this.findQuoteToken(name, token0, token1);
        const position = await this.database.upsertPosition({
          chainId: registry.chain.id,
          protocol: "v3",
          positionKey: tokenId.toString(),
          owner: this.config.executorAddress,
          poolAddress: pool,
          token0,
          token1,
          quoteToken,
          status: quoteToken && candidate.historyTrusted ? "syncing" : "needs_review",
          liquidity,
          openedAtBlock: candidate.blockNumber,
          metadata: {
            fee,
            positionManager: registry.contracts.v3.positionManager,
            source: "nft_transfer",
            historyTrusted: candidate.historyTrusted,
            ...(candidate.historyTrusted ? {} : { reason: "v3_position_transferred_or_history_unavailable" }),
          },
        });
        positions.push(position);
        await this.notifier?.positionDiscovered(position);
      } catch {
        // An NFT may have been burned or transferred away between the observed log and this read.
      }
    }
    return positions;
  }

  private async discoverV4(name: ChainName, fromBlock: bigint, toBlock: bigint): Promise<void> {
    const { registry } = this.chains.get(name);
    const [incoming, outgoing] = await Promise.all([
      this.getLogsChunked(name, {
        address: registry.contracts.v4.positionManager,
        event: erc721TransferEvent,
        args: { to: this.config.executorAddress },
        fromBlock,
        toBlock,
      }),
      this.getLogsChunked(name, {
        address: registry.contracts.v4.positionManager,
        event: erc721TransferEvent,
        args: { from: this.config.executorAddress },
        fromBlock,
        toBlock,
      }),
    ]);
    const candidates = new Map<bigint, NftActivity>();
    for (const item of [...incoming, ...outgoing]) {
      const args = logArgs<{ tokenId?: bigint; from?: Address; to?: Address }>(item);
      if (args.tokenId === undefined || !item.transactionHash || item.blockNumber == null) continue;
      const existing = candidates.get(args.tokenId);
      candidates.set(args.tokenId, {
        asset: registry.contracts.v4.positionManager,
        transactionHash: item.transactionHash,
        blockNumber: existing ? minBigInt(existing.blockNumber, item.blockNumber) : item.blockNumber,
        from: args.from,
        to: args.to,
        tokenId: args.tokenId,
        historyTrusted: Boolean(existing?.historyTrusted || (args.from?.toLowerCase() === zeroAddress && args.to?.toLowerCase() === this.config.executorAddress.toLowerCase())),
      });
    }
    const liquidityEvents = await this.discoverV4FromLiquidityEvents(name, fromBlock, toBlock);
    for (const candidate of liquidityEvents) candidates.set(candidate.tokenId, candidate);

    await this.discoverV4Candidates(name, [...candidates.values()]);
  }

  private async discoverV4FromLiquidityEvents(name: ChainName, fromBlock: bigint, toBlock: bigint): Promise<NftActivity[]> {
    const { client, registry } = this.chains.get(name);
    const candidates: NftActivity[] = [];
    try {
      const events = await this.getLogsChunked(name, {
        address: registry.contracts.v4.poolManager,
        event: v4PoolManagerModifyLiquidityEvent,
        args: { sender: registry.contracts.v4.positionManager },
        fromBlock,
        toBlock,
      });
      const known = new Map<string, boolean>();
      for (const event of events) {
        const args = logArgs<{ salt?: Hex; liquidityDelta?: bigint }>(event);
        if (!args.salt || !args.liquidityDelta || args.liquidityDelta <= 0n || !event.transactionHash || !event.blockNumber) continue;
        const saltHex = args.salt.toLowerCase() as Hex;
        if (known.has(saltHex)) continue;
        known.set(saltHex, true);
        try {
          const owner = await client.readContract({
            address: registry.contracts.v4.positionManager,
            abi: v4PositionManagerAbi,
            functionName: "ownerOf",
            args: [BigInt(args.salt)],
          });
          if (owner.toLowerCase() !== this.config.executorAddress.toLowerCase()) continue;
          const existing = await this.database.findPositionByKey(registry.chain.id, "v4", BigInt(args.salt).toString());
          if (existing) continue;
          candidates.push({
            asset: registry.contracts.v4.positionManager,
            transactionHash: event.transactionHash,
            blockNumber: event.blockNumber,
            tokenId: BigInt(args.salt),
            historyTrusted: true,
          });
        } catch {
          // NOT_MINTED or other error — skip this salt.
        }
      }
    } catch (error) {
      log.warn({ err: error, chain: name }, "could not discover V4 positions from liquidity events");
    }
    return candidates;
  }

  async discoverV4Candidates(name: ChainName, candidates: NftActivity[]): Promise<PositionRecord[]> {
    const { client, registry } = this.chains.get(name);
    const positions: PositionRecord[] = [];
    for (const candidate of candidates) {
      const tokenId = candidate.tokenId;
      try {
        const owner = await client.readContract({
          address: registry.contracts.v4.positionManager,
          abi: v4PositionManagerAbi,
          functionName: "ownerOf",
          args: [tokenId],
        });
        if (owner.toLowerCase() !== this.config.executorAddress.toLowerCase()) continue;
        const receipt = await client.getTransactionReceipt({ hash: candidate.transactionHash });
        const mintEvent = this.decodeV4MintLog(receipt.logs, registry.contracts.v4.poolManager);
        if (!mintEvent) {
          const fallback = await this.upsertV4FromPositionManager(name, tokenId, candidate.blockNumber, candidate.historyTrusted, {
            source: "position_manager_fallback",
            reason: "mint_receipt_no_modify_liquidity_log",
          });
          if (fallback) {
            positions.push(fallback);
            await this.notifier?.positionDiscovered(fallback);
          }
          continue;
        }
        const bytes25 = mintEvent.poolId.slice(0, 2 + 25 * 2) as Hex;
        const poolKey = await client.readContract({
          address: registry.contracts.v4.positionManager, abi: v4PoolKeysAbi, functionName: "poolKeys", args: [bytes25],
        });
        const quoteToken = this.findQuoteToken(name, poolKey.currency0, poolKey.currency1);
        const position = await this.database.upsertPosition({
          chainId: registry.chain.id,
          protocol: "v4",
          positionKey: tokenId.toString(),
          owner: this.config.executorAddress,
          poolAddress: null,
          token0: poolKey.currency0,
          token1: poolKey.currency1,
          quoteToken,
          status: quoteToken && candidate.historyTrusted ? "syncing" : "needs_review",
          liquidity: 0n,
          openedAtBlock: candidate.blockNumber,
          metadata: {
            currency0: poolKey.currency0, currency1: poolKey.currency1,
            fee: poolKey.fee, tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks,
            tickLower: mintEvent.tickLower, tickUpper: mintEvent.tickUpper,
            salt: mintEvent.salt,
            positionManager: registry.contracts.v4.positionManager,
            source: "pool_manager_event",
            historyTrusted: candidate.historyTrusted,
            ...(candidate.historyTrusted ? {} : { reason: "v4_position_transferred_or_history_unavailable" }),
          },
        });
        try {
          if ((position.metadata as Record<string, unknown>).openingCashflowHydrated !== true) {
            await this.hydrateV4OpeningCashflow(name, position);
          }
        } catch (error) {
          log.warn({ err: error, chain: name, tokenId: tokenId.toString() }, "V4 opening cashflow hydrate failed; will retry");
        }
        positions.push(position);
        await this.notifier?.positionDiscovered(position);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const burned = message.includes("NOT_MINTED");
        log[burned ? "info" : "warn"](
          burned
            ? { chain: name, tokenId: tokenId.toString() }
            : { err: error, chain: name, tokenId: tokenId.toString() },
          burned ? "V4 candidate NFT is burned — requesting settlement review" : "could not resolve V4 candidate; marking needs_review",
        );
        try {
          if (burned) {
            const existing = await this.database.findPositionByKey(registry.chain.id, "v4", tokenId.toString());
            if (existing) {
              const reviewed = await this.database.markNeedsReviewIfNoPendingSettlement(existing.id, { reason: "nft_burned_unverified" });
              log[reviewed ? "warn" : "info"](
                { chain: name, tokenId: tokenId.toString() },
                reviewed ? "V4 NFT is burned without a verified settlement" : "V4 NFT is burned but settlement remains pending",
              );
              continue;
            }
          }
          await this.database.upsertPosition({
            chainId: registry.chain.id, protocol: "v4", positionKey: tokenId.toString(),
            owner: this.config.executorAddress, poolAddress: null, token0: "0x",
            token1: "0x", quoteToken: null, status: "needs_review", liquidity: 0n,
            openedAtBlock: candidate.blockNumber,
            metadata: {
              positionManager: registry.contracts.v4.positionManager,
              source: "nft_transfer",
              reason: burned ? "nft_burned_unverified" : "v4_read_failed",
              ...(burned ? {} : { error: message }),
              historyTrusted: candidate.historyTrusted,
            },
          });
        } catch { /* upsert can fail if position key already exists — acceptable */ }
      }
    }
    return positions;
  }

  async refreshV4Position(name: ChainName, position: PositionRecord): Promise<PositionRecord | null> {
    if (position.protocol !== "v4") return position;
    const metadata = position.metadata as Record<string, unknown>;
    return this.upsertV4FromPositionManager(
      name,
      BigInt(position.positionKey),
      position.openedAtBlock ?? 0n,
      Boolean(metadata.historyTrusted),
      { ...metadata, source: "position_manager_fallback" },
    );
  }

  private async upsertV4FromPositionManager(
    name: ChainName,
    tokenId: bigint,
    openedAtBlock: bigint,
    historyTrusted: boolean,
    metadata: Record<string, unknown>,
  ): Promise<PositionRecord | null> {
    const { client, registry } = this.chains.get(name);
    const owner = await client.readContract({
      address: registry.contracts.v4.positionManager,
      abi: v4PositionManagerAbi,
      functionName: "ownerOf",
      args: [tokenId],
    });
    if (owner.toLowerCase() !== this.config.executorAddress.toLowerCase()) return null;
    const [poolKey, packedPositionInfo] = await client.readContract({
      address: registry.contracts.v4.positionManager,
      abi: v4PositionManagerAbi,
      functionName: "getPoolAndPositionInfo",
      args: [tokenId],
    });
    const liquidity = await client.readContract({
      address: registry.contracts.v4.positionManager,
      abi: v4PositionManagerAbi,
      functionName: "getPositionLiquidity",
      args: [tokenId],
    });
    const { tickLower, tickUpper } = unpackV4PositionInfo(packedPositionInfo);
    const quoteToken = this.findQuoteToken(name, poolKey.currency0, poolKey.currency1);
    const refreshed = await this.database.upsertPosition({
      chainId: registry.chain.id,
      protocol: "v4",
      positionKey: tokenId.toString(),
      owner: this.config.executorAddress,
      poolAddress: null,
      token0: poolKey.currency0,
      token1: poolKey.currency1,
      quoteToken,
      status: quoteToken && historyTrusted ? "syncing" : "needs_review",
      liquidity,
      openedAtBlock,
      metadata: {
        ...metadata,
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks,
        tickLower,
        tickUpper,
        salt: pad(toHex(tokenId), { size: 32 }),
        positionManager: registry.contracts.v4.positionManager,
        historyTrusted,
      },
    });
    try {
      if ((refreshed.metadata as Record<string, unknown>).openingCashflowHydrated !== true) {
        await this.hydrateV4OpeningCashflow(name, refreshed);
      }
    } catch (error) {
      log.warn({ err: error, chain: name, positionKey: tokenId.toString() }, "V4 opening cashflow hydrate failed in fallback path");
    }
    return refreshed;
  }

  async retryHydrateV4OpeningCashflow(name: ChainName, position: PositionRecord, force = false): Promise<void> {
    if (!force && (position.metadata as Record<string, unknown>).openingCashflowHydrated === true) return;
    await this.hydrateV4OpeningCashflow(name, position);
  }

  async retryHydrateV3OpeningCashflow(name: ChainName, position: PositionRecord, force = false): Promise<void> {
    if (!force && (position.metadata as Record<string, unknown>).openingCashflowHydrated === true) return;
    if (!position.quoteToken || position.openedAtBlock === null) return;
    const { registry } = this.chains.get(name);
    const tokenId = BigInt(position.positionKey);
    try {
      const events = await this.getLogsChunked(name, {
        address: registry.contracts.v3.positionManager,
        event: v3IncreaseLiquidityEvent,
        args: { tokenId },
        fromBlock: position.openedAtBlock,
        toBlock: position.openedAtBlock,
      });
      for (const event of events) {
        if (!event.transactionHash || !event.blockNumber) continue;
        const args = logArgs<{ amount0?: bigint; amount1?: bigint }>(event);
        if (args.amount0 === undefined || args.amount1 === undefined) continue;
        const quoteValue = await this.quoteV3AmountsAtBlock(position, args.amount0, args.amount1, event.blockNumber);
        if (quoteValue > 0n) {
          await this.database.addCashflow(position.id, event.blockNumber, event.transactionHash, "deposit", quoteValue, {
            protocol: "v3",
            token0Amount: args.amount0.toString(),
            token1Amount: args.amount1.toString(),
          });
        }
      }
      await this.database.setPositionStatus(position.id, position.status, { openingCashflowHydrated: true });
    } catch (error) {
      log.warn({ err: error, positionId: position.id }, "V3 opening cashflow retry failed");
    }
  }

  private async hydrateV4OpeningCashflow(name: ChainName, position: PositionRecord): Promise<void> {
    if (!position.quoteToken || position.openedAtBlock === null) return;
    const metadata = position.metadata as Record<string, unknown>;
    const salt = metadata.salt as Hex | undefined;
    const tickLower = metadata.tickLower as number | undefined;
    const tickUpper = metadata.tickUpper as number | undefined;
    const fee = metadata.fee as number | undefined;
    const tickSpacing = metadata.tickSpacing as number | undefined;
    const hooks = metadata.hooks as Address | undefined;
    const currency0 = metadata.currency0 as Address | undefined;
    const currency1 = metadata.currency1 as Address | undefined;
    if (!salt || tickLower === undefined || tickUpper === undefined || fee === undefined || tickSpacing === undefined || !hooks || !currency0 || !currency1) return;

    const { client, registry } = this.chains.get(name);
    const events = await this.getLogsChunked(name, {
      address: registry.contracts.v4.poolManager,
      event: v4PoolManagerModifyLiquidityEvent,
      args: { sender: registry.contracts.v4.positionManager },
      fromBlock: position.openedAtBlock,
      toBlock: position.openedAtBlock,
    });
    const event = events.find((entry) => {
      const args = logArgs<{ salt?: Hex; liquidityDelta?: bigint }>(entry);
      return args.salt?.toLowerCase() === salt.toLowerCase() && (args.liquidityDelta ?? 0n) > 0n;
    });
    if (!event?.transactionHash || !event.blockNumber) return;
    const liquidityDelta = logArgs<{ liquidityDelta?: bigint }>(event).liquidityDelta;
    if (!liquidityDelta || liquidityDelta <= 0n) return;
    const poolId = v4PoolId(currency0, currency1, fee, tickSpacing, hooks);
    const slot0 = await client.readContract({
      address: registry.contracts.v4.stateView,
      abi: v4StateViewAbi,
      functionName: "getSlot0",
      args: [poolId],
      blockNumber: event.blockNumber,
    });
    const amounts = amountsForLiquidity(slot0[0], tickLower, tickUpper, liquidityDelta);
    let quoteValue = await this.quoteV4AmountsAtBlock(position, amounts.amount0, amounts.amount1, event.blockNumber);
    if (quoteValue === 0n) {
      if (position.quoteToken.toLowerCase() === position.token0.toLowerCase() && amounts.amount0 > 0n) {
        quoteValue = amounts.amount0;
      } else if (position.quoteToken.toLowerCase() === position.token1.toLowerCase() && amounts.amount1 > 0n) {
        quoteValue = amounts.amount1;
      }
      if (quoteValue > 0n) {
        log.info({ positionId: position.id, quoteValue: quoteValue.toString(), amount0: amounts.amount0.toString(), amount1: amounts.amount1.toString() }, "V4 opening cashflow: quote underflow fallback used");
      }
    }
    if (quoteValue > 0n) {
      await this.database.addCashflow(position.id, event.blockNumber, event.transactionHash, "deposit", quoteValue, {
        protocol: "v4",
        token0Amount: amounts.amount0.toString(),
        token1Amount: amounts.amount1.toString(),
        source: "position_manager_fallback",
      });
    }
    await this.database.setPositionStatus(position.id, position.status, { openingCashflowHydrated: true });
  }

  private decodeV4MintLog(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[], poolManager: Address): { poolId: Hex; tickLower: number; tickUpper: number; liquidityDelta: bigint; salt: Hex } | null {
    for (const logEntry of logs) {
      if (logEntry.address.toLowerCase() !== poolManager.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: [v4PoolManagerModifyLiquidityEvent], data: logEntry.data, topics: logEntry.topics as [Hex, ...Hex[]] });
        const args = decoded.args as { id?: Hex; tickLower?: number; tickUpper?: number; liquidityDelta?: bigint; salt?: Hex };
        if (args.id === undefined || args.tickLower === undefined || args.tickUpper === undefined || args.liquidityDelta === undefined || args.salt === undefined) continue;
        return { poolId: args.id, tickLower: args.tickLower, tickUpper: args.tickUpper, liquidityDelta: args.liquidityDelta, salt: args.salt };
      } catch { /* not the right log */ }
    }
    return null;
  }

  async hydrateV3History(name: ChainName, position: PositionRecord, fromBlock: bigint, toBlock: bigint): Promise<void> {
    let cursor = fromBlock;
    while (cursor <= toBlock) {
      const end = minBigInt(toBlock, cursor + this.config.scanBlockRange - 1n);
      await this.syncV3Cashflows(name, cursor, end, [position]);
      cursor = end + 1n;
    }
  }

  private async syncV3Cashflows(name: ChainName, fromBlock: bigint, toBlock: bigint, selectedPositions?: PositionRecord[]): Promise<void> {
    const { registry } = this.chains.get(name);
    const positions = (selectedPositions ?? await this.database.listOpenPositions(registry.chain.id)).filter((position) => position.protocol === "v3" && position.quoteToken);
    for (const position of positions) {
      const tokenId = BigInt(position.positionKey);
      try {
        const [increases, collects] = await Promise.all([
          this.getLogsChunked(name, { address: registry.contracts.v3.positionManager, event: v3IncreaseLiquidityEvent, args: { tokenId }, fromBlock, toBlock }),
          this.getLogsChunked(name, { address: registry.contracts.v3.positionManager, event: v3CollectEvent, args: { tokenId }, fromBlock, toBlock }),
        ]);
        for (const event of increases) {
          if (!event.transactionHash || !event.blockNumber) continue;
          const args = logArgs<{ amount0?: bigint; amount1?: bigint }>(event);
          if (args.amount0 === undefined || args.amount1 === undefined) continue;
          const quoteValue = await this.quoteV3AmountsAtBlock(position, args.amount0, args.amount1, event.blockNumber);
          await this.database.addCashflow(position.id, event.blockNumber, event.transactionHash, "deposit", quoteValue, {
            protocol: "v3",
            token0Amount: args.amount0.toString(),
            token1Amount: args.amount1.toString(),
          });
        }
        for (const event of collects) {
          if (!event.transactionHash || !event.blockNumber) continue;
          const args = logArgs<{ amount0?: bigint; amount1?: bigint }>(event);
          if (args.amount0 === undefined || args.amount1 === undefined) continue;
          const quoteValue = await this.quoteV3AmountsAtBlock(position, args.amount0, args.amount1, event.blockNumber);
          await this.database.addCashflow(position.id, event.blockNumber, event.transactionHash, "withdrawal", quoteValue, {
            protocol: "v3",
            token0Amount: args.amount0.toString(),
            token1Amount: args.amount1.toString(),
          });
        }
      } catch (error) {
        log.warn({ err: error, positionId: position.id }, "could not synchronize V3 cashflows");
      }
    }
  }

  private async syncV4Cashflows(name: ChainName, fromBlock: bigint, toBlock: bigint): Promise<void> {
    const { client, registry } = this.chains.get(name);
    const positions = (await this.database.listOpenPositions(registry.chain.id)).filter((position) => position.protocol === "v4" && position.quoteToken);
    if (positions.length === 0) return;
    const bySalt = new Map<Hex, PositionRecord>();
    const liquidityBySalt = new Map<Hex, bigint>();
    for (const position of positions) {
      const salt = (position.metadata as { salt?: Hex } | undefined)?.salt;
      if (!salt) continue;
      const key = salt.toLowerCase() as Hex;
      bySalt.set(key, position);
      liquidityBySalt.set(key, position.liquidity ?? 0n);
    }
    if (bySalt.size === 0) return;
    try {
      const events = await this.getLogsChunked(name, {
        address: registry.contracts.v4.poolManager,
        event: v4PoolManagerModifyLiquidityEvent,
        args: { sender: registry.contracts.v4.positionManager },
        fromBlock,
        toBlock,
      });
      const transactions = new Map<string, typeof events>();
      for (const event of events) {
        if (!event.transactionHash) continue;
        const group = transactions.get(event.transactionHash) ?? [];
        group.push(event);
        transactions.set(event.transactionHash, group);
      }
      for (const event of events) {
        if (!event.transactionHash || !event.blockNumber) continue;
        const args = logArgs<{ salt?: Hex; liquidityDelta?: bigint }>(event);
        if (args.salt === undefined || args.liquidityDelta === undefined) continue;
        const position = bySalt.get(args.salt.toLowerCase() as Hex);
        if (!position) continue;
        if ((transactions.get(event.transactionHash)?.length ?? 0) !== 1) {
          await this.database.setPositionStatus(position.id, "needs_review", { reason: "batched_v4_modification" });
          continue;
        }
        const receipt = await client.getTransactionReceipt({ hash: event.transactionHash });
        const amounts = receiptTokenTransfers(receipt.logs, position.token0, position.token1, position.owner, registry.contracts.v4.poolManager);
        const saltKey = args.salt.toLowerCase() as Hex;
        const previousLiquidity = liquidityBySalt.get(saltKey) ?? position.liquidity ?? 0n;
        const newLiquidity = previousLiquidity + args.liquidityDelta;
        const normalizedLiquidity = newLiquidity > 0n ? newLiquidity : 0n;
        liquidityBySalt.set(saltKey, normalizedLiquidity);
        if (args.liquidityDelta > 0n) {
          const quoteValue = await this.quoteV4AmountsAtBlock(position, amounts.intoPool0, amounts.intoPool1, event.blockNumber);
          if (quoteValue > 0n) {
            await this.database.addCashflow(position.id, event.blockNumber, event.transactionHash, "deposit", quoteValue, {
              protocol: "v4", token0Amount: amounts.intoPool0.toString(), token1Amount: amounts.intoPool1.toString(),
            });
          }
        } else {
          const quoteValue = await this.quoteV4AmountsAtBlock(position, amounts.outOfPool0, amounts.outOfPool1, event.blockNumber);
          if (quoteValue > 0n) {
            await this.database.addCashflow(position.id, event.blockNumber, event.transactionHash, args.liquidityDelta < 0n ? "withdrawal" : "fee", quoteValue, {
              protocol: "v4", token0Amount: amounts.outOfPool0.toString(), token1Amount: amounts.outOfPool1.toString(),
            });
          }
        }
        if (normalizedLiquidity !== previousLiquidity) {
          await this.database.upsertPosition({
            chainId: position.chainId, protocol: position.protocol, positionKey: position.positionKey,
            owner: position.owner, poolAddress: position.poolAddress, token0: position.token0, token1: position.token1,
            quoteToken: position.quoteToken, status: position.status, liquidity: normalizedLiquidity,
            openedAtBlock: position.openedAtBlock, metadata: position.metadata,
          });
        }
      }
    } catch (error) {
      log.warn({ err: error, chain: name }, "could not synchronize V4 cashflows");
    }
  }

  async reconcileV4Liquidity(name: ChainName): Promise<void> {
    const { client, registry } = this.chains.get(name);
    const positions = (await this.database.listOpenPositions(registry.chain.id)).filter((position) => position.protocol === "v4");
    if (positions.length === 0) return;
    const bySalt = new Map<Hex, PositionRecord>();
    let oldestBlock: bigint | null = null;
    for (const position of positions) {
      const salt = (position.metadata as { salt?: Hex } | undefined)?.salt;
      if (!salt) continue;
      bySalt.set(salt.toLowerCase() as Hex, position);
      if (oldestBlock === null || (position.openedAtBlock !== null && position.openedAtBlock < oldestBlock)) oldestBlock = position.openedAtBlock;
    }
    if (bySalt.size === 0 || oldestBlock === null) return;
    const latest = await client.getBlockNumber();
    if (oldestBlock >= latest) return;
    const allEvents: { salt: Hex; liquidityDelta: bigint }[] = [];
    const bulkChunk = this.config.scanBlockRange * 10n;
    let cursor = oldestBlock;
    while (cursor <= latest) {
      const end = minBigInt(latest, cursor + bulkChunk - 1n);
      const events = await throttledGetLogs(client, {
        address: registry.contracts.v4.poolManager,
        event: v4PoolManagerModifyLiquidityEvent,
        args: { sender: registry.contracts.v4.positionManager },
        fromBlock: cursor,
        toBlock: end,
      } as Parameters<PublicClient["getLogs"]>[0], 0);
      for (const event of events) {
        const args = logArgs<{ salt?: Hex; liquidityDelta?: bigint }>(event);
        if (args.salt && args.liquidityDelta !== undefined) allEvents.push({ salt: args.salt, liquidityDelta: args.liquidityDelta });
      }
      cursor = end + 1n;
    }
    const netBySalt = new Map<Hex, bigint>();
    for (const event of allEvents) {
      const key = event.salt.toLowerCase() as Hex;
      netBySalt.set(key, (netBySalt.get(key) ?? 0n) + event.liquidityDelta);
    }
    let settledCount = 0;
    for (const [saltKey, position] of bySalt) {
      const net = netBySalt.get(saltKey) ?? 0n;
      if (net > 0n && net !== position.liquidity) {
        await this.database.upsertPosition({
          chainId: position.chainId, protocol: position.protocol, positionKey: position.positionKey,
          owner: position.owner, poolAddress: position.poolAddress, token0: position.token0, token1: position.token1,
          quoteToken: position.quoteToken, status: position.status, liquidity: net,
          openedAtBlock: position.openedAtBlock, metadata: position.metadata,
        });
      } else if (net <= 0n) {
        const reviewed = await this.database.markNeedsReviewIfNoPendingSettlement(position.id, { reason: "liquidity_reconciled_to_zero_unverified" });
        if (!reviewed) {
          log.info({ chain: name, positionKey: position.positionKey }, "V4 liquidity reconciled to zero but settlement remains pending");
          continue;
        }
        settledCount += 1;
      }
    }
    log.info({ chain: name, positions: positions.length, reconciled: bySalt.size, settled: settledCount }, "V4 liquidity reconciliation complete");
  }

  async hydrateV4Activities(name: ChainName, activities: WalletActivity[]): Promise<void> {
    const { client, registry } = this.chains.get(name);
    const positions = (await this.database.listOpenPositions(registry.chain.id)).filter((position) => position.protocol === "v4" && position.quoteToken);
    const bySalt = new Map<Hex, PositionRecord>();
    for (const position of positions) {
      const salt = (position.metadata as { salt?: Hex } | undefined)?.salt;
      if (!salt) continue;
      bySalt.set(salt.toLowerCase() as Hex, position);
    }
    if (bySalt.size === 0) return;
    const transactions = new Map<string, WalletActivity>();
    for (const activity of activities) transactions.set(activity.transactionHash, activity);

    for (const activity of transactions.values()) {
      try {
        const receipt = await client.getTransactionReceipt({ hash: activity.transactionHash });
        const modifications = receipt.logs
          .filter((logEntry) => logEntry.address.toLowerCase() === registry.contracts.v4.poolManager.toLowerCase())
          .map(tryDecodeV4Modification)
          .filter((value): value is { liquidityDelta: bigint; salt: Hex } => value !== null);
        if (modifications.length === 0) continue;

        if (modifications.length !== 1) {
          for (const modification of modifications) {
            const position = bySalt.get(modification.salt.toLowerCase() as Hex);
            if (position) await this.database.setPositionStatus(position.id, "needs_review", { reason: "batched_v4_modification" });
          }
          continue;
        }

        const modification = modifications[0]!;
        const position = bySalt.get(modification.salt.toLowerCase() as Hex);
        if (!position) continue;
        const amounts = receiptTokenTransfers(receipt.logs, position.token0, position.token1, position.owner, registry.contracts.v4.poolManager);
        if (modification.liquidityDelta > 0n) {
          const quoteValue = await this.quoteV4AmountsAtBlock(position, amounts.intoPool0, amounts.intoPool1, activity.blockNumber);
          if (quoteValue > 0n) {
            await this.database.addCashflow(position.id, activity.blockNumber, activity.transactionHash, "deposit", quoteValue, {
              protocol: "v4",
              token0Amount: amounts.intoPool0.toString(),
              token1Amount: amounts.intoPool1.toString(),
              bootstrap: "alchemy_receipt",
            });
          }
        } else {
          const quoteValue = await this.quoteV4AmountsAtBlock(position, amounts.outOfPool0, amounts.outOfPool1, activity.blockNumber);
          if (quoteValue > 0n) {
            await this.database.addCashflow(position.id, activity.blockNumber, activity.transactionHash, modification.liquidityDelta < 0n ? "withdrawal" : "fee", quoteValue, {
              protocol: "v4",
              token0Amount: amounts.outOfPool0.toString(),
              token1Amount: amounts.outOfPool1.toString(),
              bootstrap: "alchemy_receipt",
            });
          }
        }
      } catch (error) {
        log.warn({ err: error, chain: name, transactionHash: activity.transactionHash }, "could not hydrate V4 transaction");
      }
    }
  }

  private async quoteV3AmountsAtBlock(position: PositionRecord, amount0: bigint, amount1: bigint, blockNumber: bigint): Promise<bigint> {
    if (!position.poolAddress || !position.quoteToken) throw new Error("V3 position has no pool or quote token");
    const { client } = this.chains.getById(position.chainId);
    const slot0 = await client.readContract({ address: position.poolAddress, abi: v3PoolAbi, functionName: "slot0", blockNumber });
    const square = slot0[0] * slot0[0];
    const q192 = 1n << 192n;
    return position.quoteToken.toLowerCase() === position.token0.toLowerCase()
      ? amount0 + ((amount1 * q192) / square)
      : amount1 + ((amount0 * square) / q192);
  }

  private async quoteV4AmountsAtBlock(position: PositionRecord, amount0: bigint, amount1: bigint, blockNumber: bigint): Promise<bigint> {
    if (!position.quoteToken) throw new Error("V4 position has no quote token");
    const { client, registry } = this.chains.getById(position.chainId);
    const metadata = position.metadata as { currency0?: Address; currency1?: Address; fee?: number; tickSpacing?: number; hooks?: Address };
    if (!metadata.currency0 || !metadata.currency1 || metadata.fee === undefined || metadata.tickSpacing === undefined || !metadata.hooks) {
      throw new Error("V4 position metadata is incomplete");
    }
    const poolId = v4PoolId(metadata.currency0, metadata.currency1, metadata.fee, metadata.tickSpacing, metadata.hooks);
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

  private findQuoteToken(name: ChainName, token0: Address, token1: Address): Address | null {
    const tokens = this.config.quoteTokens[name];
    const match = (addr: Address) => tokens.find((quote) => quote.address.toLowerCase() === addr.toLowerCase());
    const m0 = match(token0);
    const m1 = match(token1);
    if (m0 && m1) {
      const priority = ["USDG", "USDC", "WETH", "ETH"];
      for (const sym of priority) {
        if (m0.symbol === sym) return m0.address;
        if (m1.symbol === sym) return m1.address;
      }
      return m0.address;
    }
    if (m0) return m0.address;
    if (m1) return m1.address;
    return null;
  }

  private initialStatus(quoteToken: Address | null): PositionStatus {
    return quoteToken ? "syncing" : "needs_review";
  }

  async tryAssignQuoteToken(name: ChainName, position: PositionRecord): Promise<PositionRecord | null> {
    const quoteToken = this.findQuoteToken(name, position.token0, position.token1);
    if (!quoteToken) return null;
    await this.database.repairPositionAssets(position.id, position.token0, position.token1, quoteToken);
    log.info({ positionId: position.id, positionKey: position.positionKey, quoteToken }, "quote token assigned on retry");
    return { ...position, quoteToken };
  }
}

function quoteValueFromPairAmounts(position: PositionRecord, amount0: bigint, amount1: bigint): bigint {
  if (!position.quoteToken) throw new Error("Position has no quote token");
  if (position.quoteToken.toLowerCase() === position.token0.toLowerCase()) {
    return amount1 === 0n ? amount0 : amount0 + (amount1 * amount0) / amount1;
  }
  return amount0 === 0n ? amount1 : amount1 + (amount0 * amount1) / amount0;
}

function unpackV4PositionInfo(value: bigint): { tickLower: number; tickUpper: number } {
  return {
    tickLower: signed24((value >> 8n) & 0xffffffn),
    tickUpper: signed24((value >> 32n) & 0xffffffn),
  };
}

function signed24(value: bigint): number {
  return Number(value >= 0x800000n ? value - 0x1000000n : value);
}

function tryDecode(event: typeof v2MintEvent | typeof v2BurnEvent, logEntry: { data: Hex; topics: readonly Hex[] }): ReturnType<typeof decodeEventLog> | null {
  try {
    return decodeEventLog({ abi: [event], data: logEntry.data, topics: logEntry.topics as [Hex, ...Hex[]] });
  } catch {
    return null;
  }
}

function eventAmounts(event: ReturnType<typeof decodeEventLog> | null): { amount0: bigint; amount1: bigint } | null {
  if (!event || !("amount0" in event.args) || !("amount1" in event.args)) return null;
  const { amount0, amount1 } = event.args as { amount0: unknown; amount1: unknown };
  return typeof amount0 === "bigint" && typeof amount1 === "bigint" ? { amount0, amount1 } : null;
}

function tryDecodeV4Modification(logEntry: { data: Hex; topics: readonly Hex[] }): { liquidityDelta: bigint; salt: Hex } | null {
  try {
    const decoded = decodeEventLog({ abi: [v4PoolManagerModifyLiquidityEvent], data: logEntry.data, topics: logEntry.topics as [Hex, ...Hex[]] });
    const args = decoded.args as { liquidityDelta?: unknown; salt?: unknown };
    return typeof args.liquidityDelta === "bigint" && typeof args.salt === "string"
      ? { liquidityDelta: args.liquidityDelta, salt: args.salt as Hex }
      : null;
  } catch {
    return null;
  }
}

export function receiptTokenTransfers(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[], token0: Address, token1: Address, owner: Address, poolManager: Address): {
  intoPool0: bigint;
  intoPool1: bigint;
  outOfPool0: bigint;
  outOfPool1: bigint;
} {
  let intoPool0 = 0n;
  let intoPool1 = 0n;
  let outOfPool0 = 0n;
  let outOfPool1 = 0n;
  for (const logEntry of logs) {
    const isToken0 = logEntry.address.toLowerCase() === token0.toLowerCase();
    const isToken1 = logEntry.address.toLowerCase() === token1.toLowerCase();
    if (!isToken0 && !isToken1) continue;
    try {
      const decoded = decodeEventLog({ abi: [erc20TransferEvent], data: logEntry.data, topics: logEntry.topics as [Hex, ...Hex[]] });
      const args = decoded.args as { from?: Address; to?: Address; value?: bigint };
      if (!args.from || !args.to || args.value === undefined) continue;
      if (args.from.toLowerCase() === owner.toLowerCase() && args.to.toLowerCase() === poolManager.toLowerCase()) {
        if (isToken0) intoPool0 += args.value;
        else intoPool1 += args.value;
      }
      if (args.from.toLowerCase() === poolManager.toLowerCase() && args.to.toLowerCase() === owner.toLowerCase()) {
        if (isToken0) outOfPool0 += args.value;
        else outOfPool1 += args.value;
      }
    } catch {
      // Not every log emitted by a token address is a standard Transfer event.
    }
  }
  return { intoPool0, intoPool1, outOfPool0, outOfPool1 };
}

function v4PoolId(currency0: Address, currency1: Address, fee: number, tickSpacing: number, hooks: Address): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [currency0, currency1, fee, tickSpacing, hooks],
  ));
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function logArgs<T extends object>(entry: Log): T {
  return (entry as unknown as { args: T }).args;
}

// Serializes every getLogs request through a single queue with a minimum spacing so that
// providers with tight compute-units-per-second limits (e.g. Alchemy Free tier) are not flooded.
let lastGetLogsAt = 0;
let getLogsTail: Promise<unknown> = Promise.resolve();

async function throttledGetLogs(
  client: PublicClient,
  params: Parameters<PublicClient["getLogs"]>[0],
  delayMs: number,
): Promise<Log[]> {
  const run = getLogsTail.then(async () => {
    const elapsed = Date.now() - lastGetLogsAt;
    if (delayMs > 0 && elapsed < delayMs) await sleep(delayMs - elapsed);
    lastGetLogsAt = Date.now();
    return getLogsWithRetry(client, params);
  });
  getLogsTail = run.then(() => undefined, () => undefined);
  return run;
}

async function getLogsWithRetry(client: PublicClient, params: Parameters<PublicClient["getLogs"]>[0]): Promise<Log[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return (await client.getLogs(params)) as Log[];
    } catch (error) {
      lastError = error;
      if (!isTransientRpcError(error)) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

function isTransientRpcError(error: unknown): boolean {
  const value = error as { code?: unknown; status?: unknown; message?: unknown; cause?: { code?: unknown; status?: unknown; message?: unknown } };
  const code = value?.code ?? value?.cause?.code;
  const status = value?.status ?? value?.cause?.status;
  if (code === 429 || status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;
  if (typeof code === "number" && [-32000, -32005, -32603].includes(code)) return true;
  const message = `${value?.message ?? ""} ${value?.cause?.message ?? ""}`.toLowerCase();
  return /timeout|timed out|fetch failed|network|socket|econnreset|econnrefused|rate limit|too many requests|service unavailable|gateway/.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
