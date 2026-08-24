import { decodeEventLog, encodeAbiParameters, isHex, keccak256, pad, toHex, zeroAddress, zeroHash, type Address, type Hex, type Log, type PublicClient } from "viem";

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
import type { ChainName, PositionGroupBinRecord, PositionGroupRecord, PositionRecord, PositionStatus, Protocol } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import { getLogsChunked } from "./log-query.js";
import { hasV4Hooks } from "./v4-pool.js";
import { dexNameFromMetadata, isKnownV3PositionManager, resolveV3Dex, v3ContractsFor, v3Deployments, type DexName } from "./v3-deployment.js";
import { isTransientRpcError } from "../rpc.js";
import type { Notifier } from "./notifier.js";
import { amountsForLiquidity, isUsableSqrtPrice, quoteValueAtSqrtPrice, sqrtRatioAtTick } from "./uniswap-math.js";

const OPEN_RECEIPT_RETRY_BACKOFF_MS = 60_000;
const OPEN_RECEIPT_CORRELATION_FAILED = "group_open_receipt_correlation_failed";
const OWNER_OF_RETRY_ATTEMPTS = 4;
const OWNER_OF_RETRY_DELAY_MS = 500;

type TransactionReceipt = Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;

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

  async reconcilePositionGroupOpen(
    name: ChainName,
    groupOrId: PositionGroupRecord | string,
    transactionHash: Hex,
    receipt?: TransactionReceipt,
  ): Promise<PositionRecord[]> {
    const group = typeof groupOrId === "string" ? await this.database.getPositionGroup(groupOrId) : groupOrId;
    if (!group) throw new Error(`Position group ${typeof groupOrId === "string" ? groupOrId : "unknown"} was not found`);

    const { registry } = this.chains.get(name);
    const client = this.reconciliationClient(name);
    const bins = await this.database.listPositionGroupBins(group.id);
    try {
      if (group.chainId !== registry.chain.id) throw new Error("position group chain does not match the discovery chain");
      if (group.protocol !== "v3" && group.protocol !== "v4") throw new Error(`unsupported position group protocol ${group.protocol}`);
      if (group.positionManager.toLowerCase() !== expectedPositionManager(registry, group.protocol, group.positionManager).toLowerCase()) {
        throw new Error("position group manager does not match the configured manager");
      }
      if (group.shape !== "bid_ask" || !["delta-amount-linear-v1", "delta-amount-linear-v2", "delta-amount-linear-v3"].includes(group.shapeVersion)) {
        throw new Error("position group is not a Bid-Ask group");
      }

      const resolvedReceipt = receipt ?? await client.getTransactionReceipt({ hash: transactionHash });
      if (resolvedReceipt.status !== undefined && resolvedReceipt.status !== "success") throw new Error("position group open transaction reverted");
      const plannedBins = plannedGroupBins(group, bins);
      if (group.protocol === "v3") {
        return await this.reconcileV3PositionGroupOpen(name, group, plannedBins, transactionHash, resolvedReceipt);
      }
      return await this.reconcileV4PositionGroupOpen(name, group, plannedBins, transactionHash, resolvedReceipt);
    } catch (error) {
      await this.markPositionGroupOpenNeedsReview(group, bins, transactionHash, errorMessage(error));
      throw error;
    }
  }

  async reconcileKnownGroupOpen(
    name: ChainName,
    groupOrId: PositionGroupRecord | string,
    transactionHash: Hex,
    receipt?: TransactionReceipt,
  ): Promise<PositionRecord[]> {
    return this.reconcilePositionGroupOpen(name, groupOrId, transactionHash, receipt);
  }

  async reconcilePendingPositionGroupOpens(name: ChainName): Promise<void> {
    const { registry } = this.chains.get(name);
    const client = this.reconciliationClient(name);
    const groups = await this.database.listPositionGroups(registry.chain.id);
    for (const group of groups) {
      if (!shouldRetryPendingGroupOpen(group)) continue;
      let receipt: TransactionReceipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: group.openTransactionHash as Hex });
      } catch {
        // The signed transaction may still be pending. Keep the parent group and let the next cycle retry.
        continue;
      }
      try {
        await this.reconcilePositionGroupOpen(name, group, group.openTransactionHash as Hex, receipt);
        log.info({ chain: name, groupId: group.id, transactionHash: group.openTransactionHash, status: receipt.status }, "reconciled pending Bid-Ask open");
      } catch (error) {
        log.warn({ err: error, chain: name, groupId: group.id, transactionHash: group.openTransactionHash }, "pending Bid-Ask open requires review");
      }
    }
  }

  private async reconcileV3PositionGroupOpen(
    name: ChainName,
    group: PositionGroupRecord,
    bins: PositionGroupBinRecord[],
    transactionHash: Hex,
    receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>,
  ): Promise<PositionRecord[]> {
    const { registry } = this.chains.get(name);
    const client = this.reconciliationClient(name);
    const transfers = receipt.logs
      .filter((entry) => entry.address.toLowerCase() === group.positionManager.toLowerCase())
      .map((entry) => decodeErc721Transfer(entry))
      .filter((entry): entry is Erc721Transfer => entry !== null);
    const increases = receipt.logs
      .filter((entry) => entry.address.toLowerCase() === group.positionManager.toLowerCase())
      .map((entry) => decodeV3IncreaseLiquidity(entry))
      .filter((entry): entry is V3IncreaseLiquidity => entry !== null);
    const expectedTokenIds = exactMintTokenIds(transfers, bins.length, group.owner);
    if (!sameBigIntSet(expectedTokenIds, increases.map((entry) => entry.tokenId))) {
      throw new Error("V3 open receipt does not contain exactly one IncreaseLiquidity event per minted token");
    }
    const plannedFee = plannedV3Fee(group);
    const dex = resolveV3Dex(registry, group.positionManager) ?? dexNameFromMetadata(group.metadata);
    const contracts = v3ContractsFor(registry, dex);
    const reconciled: V3ReconciledChild[] = [];
    const usedBins = new Set<number>();
    for (const tokenId of expectedTokenIds) {
      const increase = increases.find((entry) => entry.tokenId === tokenId);
      if (!increase || increase.liquidity <= 0n) throw new Error(`V3 token ${tokenId} has no positive IncreaseLiquidity event`);
      const owner = await this.readMintedNftOwner(name, group.positionManager, "v3", tokenId);
      if (owner.toLowerCase() !== group.owner.toLowerCase()) throw new Error(`V3 token ${tokenId} is not owned by the group owner`);
      const details = (await client.readContract({
        address: group.positionManager,
        abi: v3PositionManagerAbi,
        functionName: "positions",
        args: [tokenId],
      })) as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];
      const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = details;
      if (token0.toLowerCase() !== group.token0.toLowerCase()
        || token1.toLowerCase() !== group.token1.toLowerCase()
        || (plannedFee !== undefined && Number(fee) !== plannedFee)
        || liquidity <= 0n) {
        throw new Error(`V3 token ${tokenId} does not match the authoritative group position`);
      }
      const pool = await client.readContract({
        address: contracts.factory,
        abi: v3FactoryAbi,
        functionName: "getPool",
        args: [token0, token1, fee],
      });
      if (pool.toLowerCase() !== group.poolKey.toLowerCase()) throw new Error(`V3 token ${tokenId} resolves to a different pool`);
      const bin = bins.find((candidate) => candidate.tickLower === Number(tickLower) && candidate.tickUpper === Number(tickUpper));
      if (!bin || usedBins.has(bin.binIndex)) throw new Error(`V3 token ${tokenId} does not map to exactly one planned bin`);
      usedBins.add(bin.binIndex);
      reconciled.push({
        bin,
        tokenId,
        token0,
        token1,
        fee: Number(fee),
        tickLower: Number(tickLower),
        tickUpper: Number(tickUpper),
        liquidity,
        openingAmount0: increase.amount0,
        openingAmount1: increase.amount1,
      });
    }
    if (usedBins.size !== bins.length) throw new Error("V3 open receipt does not cover the exact planned bin set");
    return this.persistPositionGroupOpen(name, group, transactionHash, receipt.blockNumber ?? group.referenceBlock ?? 0n, reconciled.map((child) => ({
      bin: child.bin,
      tokenId: child.tokenId,
      token0: child.token0,
      token1: child.token1,
      quoteToken: group.quoteToken,
      poolAddress: group.poolKey as Address,
      liquidity: child.liquidity,
      openingAmount0: child.openingAmount0,
      openingAmount1: child.openingAmount1,
      metadata: {
        fee: child.fee,
        tickLower: child.tickLower,
        tickUpper: child.tickUpper,
         positionManager: contracts.positionManager,
         positionGroupId: group.id,
         managedBy: "position_group",
         autoExitDisabled: true,
         source: "position_group_open_receipt",
        historyTrusted: true,
        dex,
      },
    })));
  }

  private async reconcileV4PositionGroupOpen(
    name: ChainName,
    group: PositionGroupRecord,
    bins: PositionGroupBinRecord[],
    transactionHash: Hex,
    receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>,
  ): Promise<PositionRecord[]> {
    const { registry } = this.chains.get(name);
    const client = this.reconciliationClient(name);
    const transfers = receipt.logs
      .filter((entry) => entry.address.toLowerCase() === group.positionManager.toLowerCase())
      .map((entry) => decodeErc721Transfer(entry))
      .filter((entry): entry is Erc721Transfer => entry !== null);
    const expectedTokenIds = exactMintTokenIds(transfers, bins.length, group.owner);
    const modifications = receipt.logs
      .filter((entry) => entry.address.toLowerCase() === registry.contracts.v4.poolManager.toLowerCase())
      .map((entry) => decodeV4LiquidityModification(entry))
      .filter((entry): entry is V4LiquidityModification => entry !== null);
    if (modifications.length !== expectedTokenIds.length) {
      throw new Error("V4 open receipt does not contain the exact ModifyLiquidity event set");
    }

    const expectedPoolId = group.poolKey.toLowerCase();
    const byTokenId = new Map<bigint, V4LiquidityModification>();
    for (const modification of modifications) {
      if (modification.id.toLowerCase() !== expectedPoolId
        || modification.sender.toLowerCase() !== group.positionManager.toLowerCase()
        || modification.liquidityDelta <= 0n) {
        throw new Error("V4 ModifyLiquidity event does not match the group pool or manager");
      }
      const tokenId = expectedTokenIds.find((candidate) => derivedV4Salt(candidate).toLowerCase() === modification.salt.toLowerCase());
      if (tokenId === undefined || byTokenId.has(tokenId)) {
        throw new Error("V4 ModifyLiquidity salt does not map to the exact minted token set");
      }
      byTokenId.set(tokenId, modification);
    }

    const reconciled: V4ReconciledChild[] = [];
    const usedBins = new Set<number>();
    for (const tokenId of expectedTokenIds) {
      const modification = byTokenId.get(tokenId);
      if (!modification) throw new Error(`V4 token ${tokenId} has no matching ModifyLiquidity event`);
      const owner = await this.readMintedNftOwner(name, group.positionManager, "v4", tokenId);
      if (owner.toLowerCase() !== group.owner.toLowerCase()) throw new Error(`V4 token ${tokenId} is not owned by the group owner`);
      const poolAndPositionInfo = await client.readContract({
        address: group.positionManager,
        abi: v4PositionManagerAbi,
        functionName: "getPoolAndPositionInfo",
        args: [tokenId],
      });
      const { poolKey, positionInfo } = normalizeV4PoolAndPositionInfo(poolAndPositionInfo);
      if (!sameV4GroupPoolKey(group, poolKey) || v4PoolId(poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks).toLowerCase() !== expectedPoolId) {
        throw new Error(`V4 token ${tokenId} does not match the authoritative group pool`);
      }
      const { tickLower, tickUpper } = unpackV4PositionInfo(positionInfo);
      if (tickLower !== modification.tickLower || tickUpper !== modification.tickUpper) {
        throw new Error(`V4 token ${tokenId} has inconsistent ModifyLiquidity and position ticks`);
      }
      const bin = bins.find((candidate) => candidate.tickLower === tickLower && candidate.tickUpper === tickUpper);
      if (!bin || usedBins.has(bin.binIndex)) throw new Error(`V4 token ${tokenId} does not map to exactly one planned bin`);
      const liquidity = await client.readContract({
        address: group.positionManager,
        abi: v4PositionManagerAbi,
        functionName: "getPositionLiquidity",
        args: [tokenId],
      });
      if (liquidity <= 0n) throw new Error(`V4 token ${tokenId} has no positive position liquidity`);
      usedBins.add(bin.binIndex);
      reconciled.push({
        bin,
        tokenId,
        poolKey,
        tickLower,
        tickUpper,
        liquidity,
        openingAmount0: bin.openingAmount0,
        openingAmount1: bin.openingAmount1,
      });
    }
    if (usedBins.size !== bins.length) throw new Error("V4 open receipt does not cover the exact planned bin set");
    return this.persistPositionGroupOpen(name, group, transactionHash, receipt.blockNumber ?? group.referenceBlock ?? 0n, reconciled.map((child) => ({
      bin: child.bin,
      tokenId: child.tokenId,
      token0: child.poolKey.currency0,
      token1: child.poolKey.currency1,
      quoteToken: group.quoteToken,
      poolAddress: null,
      liquidity: child.liquidity,
      openingAmount0: child.openingAmount0,
      openingAmount1: child.openingAmount1,
      metadata: {
        currency0: child.poolKey.currency0,
        currency1: child.poolKey.currency1,
        fee: child.poolKey.fee,
        tickSpacing: child.poolKey.tickSpacing,
        hooks: child.poolKey.hooks,
        tickLower: child.tickLower,
        tickUpper: child.tickUpper,
        salt: derivedV4Salt(child.tokenId),
         positionManager: registry.contracts.v4.positionManager,
         positionGroupId: group.id,
         managedBy: "position_group",
         autoExitDisabled: true,
         source: "position_group_open_receipt",
        historyTrusted: true,
        dex: registry.dex,
      },
    })));
  }

  private async persistPositionGroupOpen(
    name: ChainName,
    group: PositionGroupRecord,
    transactionHash: Hex,
    receiptBlockNumber: bigint,
    children: readonly ReconciledPositionChild[],
  ): Promise<PositionRecord[]> {
    const positions: PositionRecord[] = [];
    const newlyLinkedPositions: PositionRecord[] = [];
    const freshlyCreatedPositions: PositionRecord[] = [];
    for (const child of children) {
      const existing = await this.database.findPositionByKey(group.chainId, group.protocol, child.tokenId.toString());
      const position = await this.database.upsertPosition({
        chainId: group.chainId,
        protocol: group.protocol,
        positionKey: child.tokenId.toString(),
        owner: group.owner,
        poolAddress: child.poolAddress,
        token0: child.token0,
        token1: child.token1,
        quoteToken: child.quoteToken,
        status: "syncing",
        liquidity: child.liquidity,
        openedAtBlock: receiptBlockNumber,
        metadata: child.metadata,
      });
      const current = child.bin;
      const alreadyLinked = current.positionId === position.id && current.tokenId === child.tokenId;
      if (current.positionId !== position.id || current.tokenId !== child.tokenId) {
        const linked = await this.database.linkPositionGroupBinPosition(group.id, current.binIndex, position.id, child.tokenId);
        if (linked === false) throw new Error(`could not link position group bin ${current.binIndex} to child ${position.id}`);
      }
      const updated = await this.database.updatePositionGroupBin(group.id, current.binIndex, {
        tokenId: child.tokenId,
        positionId: position.id,
        status: "minted",
        openTransactionHash: transactionHash,
        openingAmount0: child.openingAmount0,
        openingAmount1: child.openingAmount1,
      });
      if (updated === false) throw new Error(`could not update position group bin ${current.binIndex}`);
      positions.push(position);
      if (!alreadyLinked) newlyLinkedPositions.push(position);
      if (existing === null) freshlyCreatedPositions.push(position);
    }

    const aggregateAmount0 = children.reduce((total, child) => total + child.openingAmount0, 0n);
    const aggregateAmount1 = children.reduce((total, child) => total + child.openingAmount1, 0n);
    const quoteAmount = group.quoteToken.toLowerCase() === group.token0.toLowerCase()
      ? aggregateAmount0
      : group.quoteToken.toLowerCase() === group.token1.toLowerCase()
        ? aggregateAmount1
        : 0n;
    const addCashflow = (this.database as Database & {
      addPositionGroupCashflow?: Database["addPositionGroupCashflow"];
    }).addPositionGroupCashflow;
    if (typeof addCashflow === "function") {
      await addCashflow.call(
        this.database,
        group.id,
        receiptBlockNumber,
        transactionHash,
        "open_debit",
        quoteAmount,
        aggregateAmount0,
        aggregateAmount1,
        { source: "atomic_group_open", childCount: children.length },
      );
    }

    const reviewCleanup = group.metadata.reason === OPEN_RECEIPT_CORRELATION_FAILED || group.metadata.reason === "bid_ask_open_failed"
      ? {
          reason: null,
          correlationError: null,
          lastExecutionError: null,
          openReceiptRetriedAt: null,
          pendingRawTransaction: null,
        }
      : undefined;
    const linked = reviewCleanup
      ? await this.database.setPositionGroupOpenTransaction(group.id, transactionHash, "active", reviewCleanup)
      : await this.database.setPositionGroupOpenTransaction(group.id, transactionHash, "active");
    if (linked === false) throw new Error("position group already has a different open transaction hash");
    const recordExecution = (this.database as Database & {
      recordPositionGroupExecution?: Database["recordPositionGroupExecution"];
    }).recordPositionGroupExecution;
    if (typeof recordExecution === "function") {
      await recordExecution.call(this.database, group.id, "open_batch", "confirmed", transactionHash, undefined, undefined, undefined, {
        source: "position_group_open_receipt_reconciliation",
      });
    }
    for (const position of freshlyCreatedPositions) {
      try {
        await this.notifier?.positionDiscovered(position);
      } catch (error) {
        log.warn({ err: error, positionId: position.id, positionKey: position.positionKey }, "group child notification failed after open receipt reconciliation");
      }
    }
    return positions;
  }

  private async markPositionGroupOpenNeedsReview(
    group: PositionGroupRecord,
    bins: readonly PositionGroupBinRecord[],
    transactionHash: Hex,
    reason: string,
  ): Promise<void> {
    try {
      await this.database.setPositionGroupStatus(group.id, "needs_review", {
        reason: OPEN_RECEIPT_CORRELATION_FAILED,
        correlationError: reason,
        openTransactionHash: transactionHash,
        pendingRawTransaction: null,
        openReceiptRetriedAt: new Date().toISOString(),
      });
      for (const bin of bins.filter((candidate) => candidate.status !== "skipped")) {
        await this.database.updatePositionGroupBin(group.id, bin.binIndex, { status: "needs_review" });
      }
    } catch (error) {
      log.warn({ err: error, groupId: group.id, transactionHash }, "could not mark position group open receipt for review");
    }
  }

  private reconciliationClient(name: ChainName): PublicClient {
    const regular = this.chains.get(name).client;
    return typeof this.chains.getForScan === "function" ? this.chains.getForScan(name).client : regular;
  }

  private ownerLookupClients(name: ChainName): PublicClient[] {
    const scan = this.reconciliationClient(name);
    try {
      if (typeof this.chains.getForExecution === "function") {
        const execution = this.chains.getForExecution(name).client;
        if (execution !== scan) return name === "base" ? [scan, execution] : [execution, scan];
      }
    } catch {
      // Tests and scan-only chains have no execution client.
    }
    return [scan];
  }

  private async readMintedNftOwner(
    name: ChainName,
    positionManager: Address,
    protocol: "v3" | "v4",
    tokenId: bigint,
  ): Promise<Address> {
    const abi = protocol === "v3" ? v3PositionManagerAbi : v4PositionManagerAbi;
    const clients = this.ownerLookupClients(name);
    let lastError: unknown;
    for (let attempt = 0; attempt < OWNER_OF_RETRY_ATTEMPTS; attempt++) {
      for (const client of clients) {
        try {
          return await client.readContract({
            address: positionManager,
            abi,
            functionName: "ownerOf",
            args: [tokenId],
          });
        } catch (error) {
          lastError = error;
          if (!isNotMintedError(error)) throw error;
        }
      }
      if (attempt < OWNER_OF_RETRY_ATTEMPTS - 1) await delay(OWNER_OF_RETRY_DELAY_MS);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async ingestOpenReceipt(name: ChainName, receipt: TransactionReceipt): Promise<PositionRecord[]> {
    const { registry } = this.chains.get(name);
    const hash = receipt.transactionHash;
    const blockNumber = receipt.blockNumber ?? 0n;
    const v3: NftActivity[] = [];
    const v4: NftActivity[] = [];
    for (const entry of receipt.logs) {
      const transfer = decodeErc721Transfer(entry);
      if (!transfer || transfer.from.toLowerCase() !== zeroAddress.toLowerCase()) continue;
      if (transfer.to.toLowerCase() !== this.config.executorAddress.toLowerCase()) continue;
      const activity: NftActivity = {
        asset: entry.address,
        transactionHash: hash,
        blockNumber,
        from: transfer.from,
        to: transfer.to,
        tokenId: transfer.tokenId,
        historyTrusted: true,
      };
      if (isKnownV3PositionManager(registry, entry.address)) v3.push(activity);
      else if (entry.address.toLowerCase() === registry.contracts.v4.positionManager.toLowerCase()) v4.push(activity);
    }
    const found: PositionRecord[] = [];
    if (v3.length > 0) found.push(...await this.discoverV3Candidates(name, v3));
    if (v4.length > 0) found.push(...await this.discoverV4Candidates(name, v4));
    for (const position of found) {
      if (position.protocol === "v3") await this.hydrateV3OpeningCashflowFromReceipt(name, position, receipt);
    }
    log.info({ chain: name, hash, count: found.length }, "ingested positions from open receipt");
    return found;
  }

  async syncChain(name: ChainName): Promise<void> {
    const { client, registry } = this.chains.get(name);
    await this.reconcilePendingPositionGroupOpens(name);
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

    if (registry.autoDiscoverExternalPositions && !registry.monitoringEnabled && !bootstrap && registry.discoveryProtocols.includes("v3")) {
      await this.discoverOwnedV3Positions(name, latest);
      await this.database.markBootstrapComplete(registry.chain.id, "owner_enumeration", latest);
    }

    if (useLimitedRpcFallback && registry.autoDiscoverExternalPositions) {
      log.warn({ chain: name, fromBlock, toBlock }, "Alchemy bootstrap is unavailable; using limited RPC lookback instead of genesis scan");
    }
    if (registry.autoDiscoverExternalPositions && registry.discoveryProtocols.includes("v4")) {
      try {
        await this.discoverOwnedV4Positions(name, latest);
      } catch (error) {
        log.warn({ err: error, chain: name }, "owned V4 enumeration failed");
      }
    }
    log.info({ chain: name, fromBlock, toBlock }, "syncing discovery range");
    try {
      if (registry.autoDiscoverExternalPositions && registry.discoveryProtocols.includes("v2")) {
        const v2Transfers = await this.getWalletTransferLogs(name, fromBlock, toBlock);
        await this.discoverV2(name, v2Transfers);
      }
      if (registry.autoDiscoverExternalPositions && registry.discoveryProtocols.includes("v3")) {
        for (const deployment of v3Deployments(registry)) {
          await this.discoverV3(name, fromBlock, toBlock, deployment.dex);
        }
      }
      if (registry.autoDiscoverExternalPositions && registry.discoveryProtocols.includes("v4")) await this.discoverV4(name, fromBlock, toBlock);
      if (registry.monitoringEnabled && registry.discoveryProtocols.includes("v3")) await this.syncV3Cashflows(name, fromBlock, toBlock);
      if (registry.monitoringEnabled && registry.discoveryProtocols.includes("v4")) await this.syncV4Cashflows(name, fromBlock, toBlock);
    } catch (error) {
      log.warn({ err: error, chain: name, fromBlock, toBlock }, "discovery log scan failed; cursor left unchanged for retry");
      return;
    }
    await this.database.saveCursor(registry.chain.id, toBlock);
  }

  async detectOwnedPositions(name: ChainName): Promise<{ chain: ChainName; discovered: PositionRecord[]; v3: number; v4: number; v4Error?: string }> {
    const { client, registry } = this.chains.getForScan(name);
    const blockNumber = await client.getBlockNumber();
    const known = new Set(
      (await this.database.listOpenPositions(registry.chain.id)).map((position) => `${position.protocol}:${position.positionKey}`),
    );
    const v3 = registry.discoveryProtocols.includes("v3")
      ? await this.discoverOwnedV3Positions(name, blockNumber, { trustOwned: true })
      : [];
    let v4: PositionRecord[] = [];
    let v4Error: unknown;
    if (registry.discoveryProtocols.includes("v4")) {
      try {
        v4 = await this.discoverOwnedV4Positions(name, blockNumber, true);
      } catch (error) {
        v4Error = error;
        log.warn({ err: error, chain: name }, "V4 detect failed; returning V3 results");
      }
    }
    const discovered = [...v3, ...v4].filter((position) => !known.has(`${position.protocol}:${position.positionKey}`));
    for (const position of discovered) {
      if (!position.quoteToken || position.status === "closing" || position.status === "settled" || position.status === "armed") continue;
      await this.database.setPositionStatus(position.id, "syncing", {
        source: "manual_detect",
        reason: null,
        historyTrusted: true,
      });
      position.status = "syncing";
      if (position.protocol === "v3") {
        try {
          await this.retryHydrateV3OpeningCashflow(name, position, true);
        } catch (error) {
          log.warn({ err: error, positionId: position.id, positionKey: position.positionKey }, "detect V3 cashflow reconstruct failed");
        }
      }
    }
    if (v4Error && discovered.length === 0) throw v4Error;
    return {
      chain: name,
      discovered,
      v3: discovered.filter((position) => position.protocol === "v3").length,
      v4: discovered.filter((position) => position.protocol === "v4").length,
      ...(v4Error ? { v4Error: v4Error instanceof Error ? v4Error.message : String(v4Error) } : {}),
    };
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
    const { client } = this.chains.getForLogs(name);
    return getLogsChunked(client, params, {
      maxBlockRange: this.config.maxLogBlockRange,
      delayMs: this.config.rpcRequestDelayMs,
    });
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
      } catch (error) {
        if (isTransientRpcError(error)) throw error;
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
        if (isTransientRpcError(error)) throw error;
        log.warn({ err: error, positionId: position.id, transactionHash: transfer.transactionHash }, "could not reconstruct V2 cashflow");
      }
    }
  }

  private async discoverV3(name: ChainName, fromBlock: bigint, toBlock: bigint, dex: DexName = "uniswap"): Promise<void> {
    const { registry } = this.chains.get(name);
    const contracts = v3ContractsFor(registry, dex);
    const [incoming, outgoing] = await Promise.all([
      this.getLogsChunked(name, {
        address: contracts.positionManager,
        event: erc721TransferEvent,
        args: { to: this.config.executorAddress },
        fromBlock,
        toBlock,
      }),
      this.getLogsChunked(name, {
        address: contracts.positionManager,
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
        asset: contracts.positionManager,
        transactionHash: item.transactionHash,
        blockNumber: existing ? minBigInt(existing.blockNumber, item.blockNumber) : item.blockNumber,
        from: args.from,
        to: args.to,
        tokenId: args.tokenId,
        historyTrusted: Boolean(existing?.historyTrusted || (args.from?.toLowerCase() === zeroAddress && args.to?.toLowerCase() === this.config.executorAddress.toLowerCase())),
      });
    }
    await this.discoverV3Candidates(name, [...candidates.values()], dex);
  }

  async discoverV3Candidates(name: ChainName, candidates: NftActivity[], dex: DexName = "uniswap"): Promise<PositionRecord[]> {
    const { client, registry } = this.chains.get(name);
    const positions: PositionRecord[] = [];
    for (const candidate of candidates) {
      const tokenId = candidate.tokenId;
      const resolvedDex = resolveV3Dex(registry, candidate.asset) ?? dex;
      const contracts = v3ContractsFor(registry, resolvedDex);
      try {
        const owner = await client.readContract({
          address: contracts.positionManager,
          abi: v3PositionManagerAbi,
          functionName: "ownerOf",
          args: [tokenId],
        });
        if (owner.toLowerCase() !== this.config.executorAddress.toLowerCase()) continue;
        const details = (await client.readContract({
          address: contracts.positionManager,
          abi: v3PositionManagerAbi,
          functionName: "positions",
          args: [tokenId],
        })) as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];
        const [, , token0, token1, fee, , , liquidity] = details;
        if (liquidity === 0n) continue;
        const pool = await client.readContract({
          address: contracts.factory,
          abi: v3FactoryAbi,
          functionName: "getPool",
          args: [token0, token1, fee],
        });
        if (pool === zeroAddress) continue;
        const quoteToken = this.findQuoteToken(name, token0, token1);
        const detectionOnly = !registry.monitoringEnabled;
        const position = await this.database.upsertPosition({
          chainId: registry.chain.id,
          protocol: "v3",
          positionKey: tokenId.toString(),
          owner: this.config.executorAddress,
          poolAddress: pool,
          token0,
          token1,
          quoteToken,
          status: detectionOnly ? "needs_review" : quoteToken && candidate.historyTrusted ? "syncing" : "needs_review",
          liquidity,
          openedAtBlock: candidate.blockNumber,
          metadata: {
            fee,
            positionManager: contracts.positionManager,
            source: detectionOnly ? "owner_enumeration" : "nft_transfer",
            historyTrusted: candidate.historyTrusted,
            dex: resolvedDex,
            ...(detectionOnly ? { detectionOnly: true, reason: "detection_only_chain" } : candidate.historyTrusted ? {} : { reason: "v3_position_transferred_or_history_unavailable" }),
          },
        });
        positions.push(position);
        await this.notifier?.positionDiscovered(position);
      } catch (error) {
        if (isTransientRpcError(error)) throw error;
        // An NFT may have been burned or transferred away between the observed log and this read.
      }
    }
    return positions;
  }

  async discoverOwnedV3Positions(name: ChainName, blockNumber: bigint, opts?: { trustOwned?: boolean }): Promise<PositionRecord[]> {
    const { client, registry } = this.chains.getForScan(name);
    const found: PositionRecord[] = [];
    const trustOwned = opts?.trustOwned === true;
    for (const deployment of v3Deployments(registry)) {
      const balance = await client.readContract({
        address: deployment.contracts.positionManager,
        abi: v3PositionManagerAbi,
        functionName: "balanceOf",
        args: [this.config.executorAddress],
      });
      const candidates: NftActivity[] = [];
      for (let index = 0n; index < balance; index += 1n) {
        const tokenId = await client.readContract({
          address: deployment.contracts.positionManager,
          abi: v3PositionManagerAbi,
          functionName: "tokenOfOwnerByIndex",
          args: [this.config.executorAddress, index],
        });
        candidates.push({
          asset: deployment.contracts.positionManager,
          transactionHash: zeroHash,
          blockNumber,
          to: this.config.executorAddress,
          tokenId,
          historyTrusted: trustOwned,
        });
      }
      found.push(...await this.discoverV3Candidates(name, candidates, deployment.dex));
    }
    return found;
  }

  async discoverOwnedV4Positions(name: ChainName, blockNumber: bigint, allowHistoricalRecovery = false): Promise<PositionRecord[]> {
    const tokenIds = await this.ownedV4TokenIds(name, allowHistoricalRecovery);
    const found: PositionRecord[] = [];
    const { registry } = this.chains.get(name);
    for (const tokenId of tokenIds) {
      const existing = await this.database.findPositionByKey(registry.chain.id, "v4", tokenId.toString());
      if (existing) continue;
      try {
        const position = await this.upsertV4FromPositionManager(name, tokenId, blockNumber, true, {
          source: "owner_enumeration",
        });
        if (!position) continue;
        found.push(position);
        await this.notifier?.positionDiscovered(position);
        log.info({ chain: name, positionKey: position.positionKey }, "discovered owned V4 position by enumeration");
      } catch (error) {
        if (isTransientRpcError(error)) throw error;
        log.warn({ err: error, chain: name, tokenId: tokenId.toString() }, "owned V4 enumeration candidate failed");
      }
    }
    return found;
  }

  private async ownedV4TokenIds(name: ChainName, allowHistoricalRecovery = false): Promise<bigint[]> {
    const { client, registry } = this.chains.getForScan(name);
    const manager = registry.contracts.v4.positionManager;
    try {
      const balance = await client.readContract({
        address: manager,
        abi: v4PositionManagerAbi,
        functionName: "balanceOf",
        args: [this.config.executorAddress],
      });
      const ids: bigint[] = [];
      for (let index = 0n; index < balance; index += 1n) {
        ids.push(await client.readContract({
          address: manager,
          abi: v4PositionManagerAbi,
          functionName: "tokenOfOwnerByIndex",
          args: [this.config.executorAddress, index],
        }));
      }
      return ids;
    } catch (error) {
      // Uniswap's V4 PositionManager is not ERC-721 Enumerable. Recover the
      // wallet's historical V4 receipts and verify each NFT's current owner.
      if (!allowHistoricalRecovery) return [];
      const rpcEndpoint = this.config.rpcHttp?.[name];
      const endpoint = this.config.alchemyHttp?.[name]
        ?? (rpcEndpoint?.includes("alchemy.com") ? rpcEndpoint : undefined);
      if (!endpoint) {
        const message = `V4 detect on ${name} requires ALCHEMY_${name.toUpperCase()}_HTTP (PositionManager is not enumerable)`;
        log.warn({ err: error, chain: name }, message);
        throw new Error(message);
      }
      try {
        const candidateIds = new Set<bigint>();
        let pageKey: string | undefined;
        do {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "alchemy_getAssetTransfers",
              params: [{
                fromBlock: "0x0",
                toBlock: "latest",
                toAddress: this.config.executorAddress,
                category: ["erc721"],
                contractAddresses: [manager],
                withMetadata: false,
                maxCount: "0x3e8",
                order: "asc",
                ...(pageKey ? { pageKey } : {}),
              }],
            }),
          });
          if (!response.ok) throw new Error(`Alchemy V4 NFT lookup failed: HTTP ${response.status}`);
          const payload = await response.json() as { result?: { pageKey?: string; transfers?: Array<{ tokenId?: string }> } };
          for (const transfer of payload.result?.transfers ?? []) {
            if (transfer.tokenId !== undefined) candidateIds.add(BigInt(transfer.tokenId));
          }
          pageKey = payload.result?.pageKey;
        } while (pageKey);

        const ids: bigint[] = [];
        for (const tokenId of candidateIds) {
          try {
            const owner = await client.readContract({
              address: manager,
              abi: v4PositionManagerAbi,
              functionName: "ownerOf",
              args: [tokenId],
            });
            if (owner.toLowerCase() === this.config.executorAddress.toLowerCase()) ids.push(tokenId);
          } catch {
            // A historical receipt can reference an NFT that has since burned.
          }
        }
        return ids;
      } catch (fallbackError) {
        log.warn({ err: fallbackError, chain: name }, "could not recover owned V4 positions from NFT transfers");
        return [];
      }
    }
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
        } catch (error) {
          if (isTransientRpcError(error)) throw error;
          // NOT_MINTED or other error — skip this salt.
        }
      }
    } catch (error) {
      if (isTransientRpcError(error)) throw error;
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
        const mintEvent = this.decodeV4MintLog(receipt.logs, registry.contracts.v4.poolManager, tokenId);
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
        const hooked = hasV4Hooks(poolKey.hooks);
        const position = await this.database.upsertPosition({
          chainId: registry.chain.id,
          protocol: "v4",
          positionKey: tokenId.toString(),
          owner: this.config.executorAddress,
          poolAddress: null,
          token0: poolKey.currency0,
          token1: poolKey.currency1,
          quoteToken,
          status: !hooked && quoteToken && candidate.historyTrusted ? "syncing" : "needs_review",
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
            dex: registry.dex,
            ...(hooked ? { reason: "unsupported_v4_hooks" } : candidate.historyTrusted ? {} : { reason: "v4_position_transferred_or_history_unavailable" }),
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
        if (isTransientRpcError(error)) throw error;
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
              const settled = await this.database.settleUnverifiedZeroLiquidity(existing.id, "nft_burned");
              log.info(
                { chain: name, tokenId: tokenId.toString() },
                settled ? "settled burned V4 NFT without a reconstructed receipt" : "V4 NFT is burned but settlement remains pending",
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
    const hooked = hasV4Hooks(poolKey.hooks);
    const refreshed = await this.database.upsertPosition({
      chainId: registry.chain.id,
      protocol: "v4",
      positionKey: tokenId.toString(),
      owner: this.config.executorAddress,
      poolAddress: null,
      token0: poolKey.currency0,
      token1: poolKey.currency1,
      quoteToken,
      status: !hooked && quoteToken && historyTrusted ? "syncing" : "needs_review",
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
        dex: registry.dex,
        ...(hooked ? { reason: "unsupported_v4_hooks" } : {}),
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
    if (!position.quoteToken) return;
    let wroteDeposit = false;
    if (position.openedAtBlock !== null) {
      const { registry } = this.chains.get(name);
      const tokenId = BigInt(position.positionKey);
      const manager = v3ContractsFor(registry, dexNameFromMetadata(position.metadata)).positionManager;
      try {
        const events = await this.getLogsChunked(name, {
          address: manager,
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
            wroteDeposit = true;
          }
        }
      } catch (error) {
        log.warn({ err: error, positionId: position.id }, "V3 opening cashflow retry failed");
      }
    }
    if (!wroteDeposit) {
      await this.reconstructV3OpeningCashflowFromLiveState(name, position);
      return;
    }
    await this.database.setPositionStatus(position.id, position.status, { openingCashflowHydrated: true });
  }

  private async reconstructV3OpeningCashflowFromLiveState(name: ChainName, position: PositionRecord): Promise<void> {
    if (!position.quoteToken || !position.poolAddress) return;
    const { registry } = this.chains.getForScan(name);
    const client = this.chains.getForScan(name).client;
    const manager = v3ContractsFor(registry, dexNameFromMetadata(position.metadata)).positionManager;
    const details = await client.readContract({
      address: manager,
      abi: v3PositionManagerAbi,
      functionName: "positions",
      args: [BigInt(position.positionKey)],
    }) as readonly [bigint, Address, Address, Address, number, number, number, bigint, ...bigint[]];
    const tickLower = Number(details[5]);
    const tickUpper = Number(details[6]);
    const liquidity = details[7];
    if (liquidity <= 0n) return;
    const slot0 = await client.readContract({ address: position.poolAddress, abi: v3PoolAbi, functionName: "slot0" });
    const amounts = amountsForLiquidity(slot0[0], tickLower, tickUpper, liquidity);
    const square = slot0[0] * slot0[0];
    const q192 = 1n << 192n;
    const quoteValue = position.quoteToken.toLowerCase() === position.token0.toLowerCase()
      ? amounts.amount0 + ((amounts.amount1 * q192) / square)
      : amounts.amount1 + ((amounts.amount0 * square) / q192);
    if (quoteValue <= 0n) return;
    const latest = await client.getBlockNumber();
    await this.database.addCashflow(position.id, latest, `reconstructed:${position.id}`, "deposit", quoteValue, {
      protocol: "v3",
      source: "live_liquidity",
      token0Amount: amounts.amount0.toString(),
      token1Amount: amounts.amount1.toString(),
    });
    await this.database.setPositionStatus(position.id, position.status, { openingCashflowHydrated: true });
    log.info({ positionId: position.id, positionKey: position.positionKey, quoteValue: quoteValue.toString() }, "reconstructed V3 opening cashflow from live liquidity");
  }

  private async hydrateV3OpeningCashflowFromReceipt(
    name: ChainName,
    position: PositionRecord,
    receipt: TransactionReceipt,
  ): Promise<void> {
    if (!position.quoteToken) return;
    const tokenId = BigInt(position.positionKey);
    const { registry } = this.chains.get(name);
    const manager = v3ContractsFor(registry, dexNameFromMetadata(position.metadata)).positionManager;
    for (const entry of receipt.logs) {
      if (entry.address.toLowerCase() !== manager.toLowerCase()) continue;
      const increase = decodeV3IncreaseLiquidity(entry);
      if (!increase || increase.tokenId !== tokenId) continue;
      const quoteValue = await this.quoteV3AmountsAtBlock(
        position,
        increase.amount0,
        increase.amount1,
        receipt.blockNumber ?? position.openedAtBlock ?? 0n,
      );
      if (quoteValue > 0n) {
        await this.database.addCashflow(position.id, receipt.blockNumber ?? 0n, receipt.transactionHash, "deposit", quoteValue, {
          protocol: "v3",
          token0Amount: increase.amount0.toString(),
          token1Amount: increase.amount1.toString(),
        });
      }
    }
    await this.database.setPositionStatus(position.id, position.status, { openingCashflowHydrated: true });
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

    const { registry } = this.chains.get(name);
    const historicalClient = this.chains.getForLogs(name).client;
    let events = await this.getLogsChunked(name, {
      address: registry.contracts.v4.poolManager,
      event: v4PoolManagerModifyLiquidityEvent,
      args: { sender: registry.contracts.v4.positionManager },
      fromBlock: position.openedAtBlock,
      toBlock: position.openedAtBlock,
    });
    let event = events.find((entry) => {
      const args = logArgs<{ salt?: Hex; liquidityDelta?: bigint }>(entry);
      return args.salt?.toLowerCase() === salt.toLowerCase() && (args.liquidityDelta ?? 0n) > 0n;
    });
    if (!event?.transactionHash || !event.blockNumber) {
      // Manual /detect stores openedAtBlock as detection time, not mint time.
      // Try a cheap Alchemy history lookup first (one RPC), then bounded log scan as last resort.
      const rpcEndpoint = this.config.rpcHttp?.[name];
      const endpoint = this.config.alchemyHttp?.[name] ?? (rpcEndpoint?.includes("alchemy.com") ? rpcEndpoint : undefined);
      if (endpoint) {
        try {
          const tokenId = BigInt(salt);
          const resp = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "alchemy_getAssetTransfers",
              params: [{
                fromBlock: "0x0",
                toAddress: this.config.executorAddress,
                category: ["erc721"],
                contractAddresses: [registry.contracts.v4.positionManager],
                withMetadata: false,
                maxCount: "0x3e8",
                order: "asc",
              }],
            }),
            signal: AbortSignal.timeout(15_000),
          });
          if (resp.ok) {
            const payload = await resp.json() as { result?: { transfers?: Array<{ tokenId?: string; blockNum?: string; hash?: string }> } };
            const match = (payload.result?.transfers ?? []).find((t) => {
              if (!t.tokenId) return false;
              try { return BigInt(t.tokenId) === tokenId; } catch { return false; }
            });
            if (match?.hash && match.blockNum) {
              const blockNumber = BigInt(match.blockNum);
              const receipt = await historicalClient.getTransactionReceipt({ hash: match.hash as Hex }).catch(() => null);
              const decoded = receipt ? this.decodeV4MintLog(receipt.logs as readonly { address: Address; data: Hex; topics: readonly Hex[] }[], registry.contracts.v4.poolManager, tokenId) : null;
              if (decoded && decoded.liquidityDelta > 0n) {
                event = { transactionHash: match.hash as Hex, blockNumber } as unknown as typeof event;
                // Use decoded liquidity directly to avoid second log scan.
                const poolIdAlt = v4PoolId(currency0, currency1, fee, tickSpacing, hooks);
                let slot0Alt: readonly [bigint, number, number, number];
                try {
                  slot0Alt = await historicalClient.readContract({
                    address: registry.contracts.v4.stateView,
                    abi: v4StateViewAbi,
                    functionName: "getSlot0",
                    args: [poolIdAlt],
                    blockNumber,
                  }) as unknown as readonly [bigint, number, number, number];
                } catch {
                  slot0Alt = await this.chains.getForScan(name).client.readContract({
                    address: registry.contracts.v4.stateView,
                    abi: v4StateViewAbi,
                    functionName: "getSlot0",
                    args: [poolIdAlt],
                  }) as unknown as readonly [bigint, number, number, number];
                }
                const amountsAlt = amountsForLiquidity(slot0Alt[0], tickLower, tickUpper, decoded.liquidityDelta);
                let quoteValueAlt = await this.quoteV4AmountsAtBlock(position, amountsAlt.amount0, amountsAlt.amount1, blockNumber);
                if (quoteValueAlt === 0n) {
                  if (position.quoteToken.toLowerCase() === position.token0.toLowerCase() && amountsAlt.amount0 > 0n) quoteValueAlt = amountsAlt.amount0;
                  else if (position.quoteToken.toLowerCase() === position.token1.toLowerCase() && amountsAlt.amount1 > 0n) quoteValueAlt = amountsAlt.amount1;
                }
                if (quoteValueAlt > 0n) {
                  await this.database.addCashflow(position.id, blockNumber, match.hash as Hex, "deposit", quoteValueAlt, {
                    protocol: "v4",
                    token0Amount: amountsAlt.amount0.toString(),
                    token1Amount: amountsAlt.amount1.toString(),
                    source: "position_manager_fallback",
                  });
                }
                await this.database.setPositionStatus(position.id, position.status, { openingCashflowHydrated: true });
                return;
              }
            }
          }
        } catch { /* fallback to log scan */ }
      }
      const lookback = this.config.rpcBootstrapLookbackBlocks;
      const fromBlock = position.openedAtBlock > lookback ? position.openedAtBlock - lookback : 0n;
      const fallbackEvents = await this.getLogsChunked(name, {
        address: registry.contracts.v4.poolManager,
        event: v4PoolManagerModifyLiquidityEvent,
        args: { sender: registry.contracts.v4.positionManager },
        fromBlock,
        toBlock: position.openedAtBlock,
      });
      event = fallbackEvents
        .filter((entry) => {
          const args = logArgs<{ salt?: Hex; liquidityDelta?: bigint }>(entry);
          return args.salt?.toLowerCase() === salt.toLowerCase() && (args.liquidityDelta ?? 0n) > 0n;
        })
        .sort((a, b) => (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n) ? -1 : 1)
        .at(-1);
    }
    if (!event?.transactionHash || !event.blockNumber) {
      // Last resort: reconstruct from live liquidity (no Alchemy spam, one StateView + one position read).
      try {
        const tokenId = BigInt(salt);
        const liveLiquidity = await this.chains.getForScan(name).client.readContract({
          address: registry.contracts.v4.positionManager,
          abi: v4PositionManagerAbi,
          functionName: "getPositionLiquidity",
          args: [tokenId],
        }) as unknown as bigint;
        if (liveLiquidity > 0n) {
          const poolIdLive = v4PoolId(currency0, currency1, fee, tickSpacing, hooks);
          const slot0Live = await this.chains.getForScan(name).client.readContract({
            address: registry.contracts.v4.stateView,
            abi: v4StateViewAbi,
            functionName: "getSlot0",
            args: [poolIdLive],
          }) as unknown as readonly [bigint, number, number, number];
          const amountsLive = amountsForLiquidity(slot0Live[0], tickLower, tickUpper, liveLiquidity);
          let quoteValueLive = await this.quoteV4AmountsAtBlock(position, amountsLive.amount0, amountsLive.amount1, position.openedAtBlock);
          if (quoteValueLive === 0n) {
            if (position.quoteToken.toLowerCase() === position.token0.toLowerCase() && amountsLive.amount0 > 0n) quoteValueLive = amountsLive.amount0;
            else if (position.quoteToken.toLowerCase() === position.token1.toLowerCase() && amountsLive.amount1 > 0n) quoteValueLive = amountsLive.amount1;
          }
          if (quoteValueLive > 0n) {
            await this.database.addCashflow(position.id, position.openedAtBlock, zeroHash, "deposit", quoteValueLive, {
              protocol: "v4",
              token0Amount: amountsLive.amount0.toString(),
              token1Amount: amountsLive.amount1.toString(),
              source: "live_liquidity",
            });
          }
        }
      } catch { /* ignore */ }
      await this.database.setPositionStatus(position.id, position.status, { openingCashflowHydrated: true });
      return;
    }
    const liquidityDelta = logArgs<{ liquidityDelta?: bigint }>(event).liquidityDelta;
    if (!liquidityDelta || liquidityDelta <= 0n) return;
    const poolId = v4PoolId(currency0, currency1, fee, tickSpacing, hooks);
    let slot0: readonly [bigint, number, number, number];
    try {
      slot0 = await historicalClient.readContract({
        address: registry.contracts.v4.stateView,
        abi: v4StateViewAbi,
        functionName: "getSlot0",
        args: [poolId],
        blockNumber: event.blockNumber,
      }) as unknown as readonly [bigint, number, number, number];
    } catch {
      // Archive miss on public RPC — fallback to latest slot without block tag (fallback includes Alchemy if configured).
      slot0 = await this.chains.getForScan(name).client.readContract({
        address: registry.contracts.v4.stateView,
        abi: v4StateViewAbi,
        functionName: "getSlot0",
        args: [poolId],
      }) as unknown as readonly [bigint, number, number, number];
    }
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

  private decodeV4MintLog(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[], poolManager: Address, tokenId?: bigint): { poolId: Hex; tickLower: number; tickUpper: number; liquidityDelta: bigint; salt: Hex } | null {
    const matches: { poolId: Hex; tickLower: number; tickUpper: number; liquidityDelta: bigint; salt: Hex }[] = [];
    for (const logEntry of logs) {
      if (logEntry.address.toLowerCase() !== poolManager.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: [v4PoolManagerModifyLiquidityEvent], data: logEntry.data, topics: logEntry.topics as [Hex, ...Hex[]] });
        const args = decoded.args as { id?: Hex; tickLower?: number; tickUpper?: number; liquidityDelta?: bigint; salt?: Hex };
        if (args.id === undefined || args.tickLower === undefined || args.tickUpper === undefined || args.liquidityDelta === undefined || args.salt === undefined) continue;
        if (tokenId !== undefined && args.salt.toLowerCase() !== derivedV4Salt(tokenId).toLowerCase()) continue;
        matches.push({ poolId: args.id, tickLower: args.tickLower, tickUpper: args.tickUpper, liquidityDelta: args.liquidityDelta, salt: args.salt });
      } catch { /* not the right log */ }
    }
    return matches.length === 1 ? matches[0]! : null;
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
    const positions = (selectedPositions ?? await this.database.listOpenPositions(registry.chain.id))
      .filter((position) => position.protocol === "v3" && position.quoteToken && !isManagedPosition(position));
    for (const position of positions) {
      const tokenId = BigInt(position.positionKey);
      try {
        const manager = v3ContractsFor(registry, dexNameFromMetadata(position.metadata)).positionManager;
        const [increases, collects] = await Promise.all([
          this.getLogsChunked(name, { address: manager, event: v3IncreaseLiquidityEvent, args: { tokenId }, fromBlock, toBlock }),
          this.getLogsChunked(name, { address: manager, event: v3CollectEvent, args: { tokenId }, fromBlock, toBlock }),
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
    const positions = (await this.database.listOpenPositions(registry.chain.id))
      .filter((position) => position.protocol === "v4" && position.quoteToken && !isManagedPosition(position));
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
        if (args.liquidityDelta > 0n) {
          const tx = await client.getTransaction({ hash: event.transactionHash });
          applyNativeDepositValue(amounts, position.token0, position.token1, tx.value);
        }
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
    const { registry } = this.chains.get(name);
    const { client } = this.chains.getForLogs(name);
    const positions = (await this.database.listOpenPositions(registry.chain.id)).filter((position) => position.protocol === "v4" && !isManagedPosition(position));
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
      const events = await getLogsChunked(client, {
        address: registry.contracts.v4.poolManager,
        event: v4PoolManagerModifyLiquidityEvent,
        args: { sender: registry.contracts.v4.positionManager },
        fromBlock: cursor,
        toBlock: end,
      }, { maxBlockRange: this.config.maxLogBlockRange, delayMs: 0 });
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
        const settled = await this.database.settleUnverifiedZeroLiquidity(position.id, "externally_closed");
        if (!settled) {
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
          const tx = await client.getTransaction({ hash: activity.transactionHash });
          applyNativeDepositValue(amounts, position.token0, position.token1, tx.value);
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
    const { registry } = this.chains.getById(position.chainId);
    const client = this.chains.getForLogs(registry.name).client;
    const slot0 = await client.readContract({ address: position.poolAddress, abi: v3PoolAbi, functionName: "slot0", blockNumber });
    const square = slot0[0] * slot0[0];
    const q192 = 1n << 192n;
    return position.quoteToken.toLowerCase() === position.token0.toLowerCase()
      ? amount0 + ((amount1 * q192) / square)
      : amount1 + ((amount0 * square) / q192);
  }

  private async quoteV4AmountsAtBlock(position: PositionRecord, amount0: bigint, amount1: bigint, blockNumber: bigint): Promise<bigint> {
    if (!position.quoteToken) throw new Error("V4 position has no quote token");
    const { registry } = this.chains.getById(position.chainId);
    const historicalClient = this.chains.getForLogs(registry.name).client;
    const metadata = position.metadata as { currency0?: Address; currency1?: Address; fee?: number; tickSpacing?: number; hooks?: Address; tickLower?: number; tickUpper?: number };
    if (!metadata.currency0 || !metadata.currency1 || metadata.fee === undefined || metadata.tickSpacing === undefined || !metadata.hooks) {
      throw new Error("V4 position metadata is incomplete");
    }
    const poolId = v4PoolId(metadata.currency0, metadata.currency1, metadata.fee, metadata.tickSpacing, metadata.hooks);
    const slot0 = await historicalClient.readContract({
      address: registry.contracts.v4.stateView,
      abi: v4StateViewAbi,
      functionName: "getSlot0",
      args: [poolId],
      blockNumber,
    });
    const quoteIsToken0 = position.quoteToken.toLowerCase() === position.token0.toLowerCase();
    const sqrtPriceX96 = isUsableSqrtPrice(slot0[0], slot0[1])
      ? slot0[0]
      : midRangeSqrtPrice(metadata.tickLower, metadata.tickUpper);
    return quoteValueAtSqrtPrice(amount0, amount1, quoteIsToken0, sqrtPriceX96);
  }

  private findQuoteToken(name: ChainName, token0: Address, token1: Address): Address | null {
    const tokens = this.config.quoteTokens[name];
    const match = (addr: Address) => tokens.find((quote) => quote.address.toLowerCase() === addr.toLowerCase());
    const m0 = match(token0);
    const m1 = match(token1);
    if (m0 && m1) {
      const priority = this.chains.get(name).registry.quotePriority;
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

interface Erc721Transfer {
  from: Address;
  to: Address;
  tokenId: bigint;
}

interface V3IncreaseLiquidity {
  tokenId: bigint;
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
}

interface V4LiquidityModification {
  id: Hex;
  sender: Address;
  tickLower: number;
  tickUpper: number;
  liquidityDelta: bigint;
  salt: Hex;
}

interface V3ReconciledChild {
  bin: PositionGroupBinRecord;
  tokenId: bigint;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  openingAmount0: bigint;
  openingAmount1: bigint;
}

interface V4ReconciledChild {
  bin: PositionGroupBinRecord;
  tokenId: bigint;
  poolKey: V4PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  openingAmount0: bigint;
  openingAmount1: bigint;
}

interface ReconciledPositionChild {
  bin: PositionGroupBinRecord;
  tokenId: bigint;
  token0: Address;
  token1: Address;
  quoteToken: Address;
  poolAddress: Address | null;
  liquidity: bigint;
  openingAmount0: bigint;
  openingAmount1: bigint;
  metadata: Record<string, unknown>;
}

type V4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

function expectedPositionManager(
  registry: { contracts: { v3: { positionManager: Address }; v4: { positionManager: Address } }; pancakeV3?: { positionManager: Address } },
  protocol: "v3" | "v4",
  stored?: Address,
): Address {
  if (protocol === "v4") return registry.contracts.v4.positionManager;
  if (stored && stored.toLowerCase() === registry.pancakeV3?.positionManager.toLowerCase()) return stored;
  return registry.contracts.v3.positionManager;
}

function shouldRetryPendingGroupOpen(group: PositionGroupRecord, now = Date.now()): boolean {
  if (!group.openTransactionHash || !isHex(group.openTransactionHash) || group.openTransactionHash.length !== 66) return false;
  if (group.status === "opening") return true;
  const retryable = (group.status === "needs_review" && group.metadata.reason === OPEN_RECEIPT_CORRELATION_FAILED)
    || (group.status === "cancelled" && group.metadata.reason === "bid_ask_open_failed");
  if (!retryable) return false;
  const retriedAt = typeof group.metadata.openReceiptRetriedAt === "string"
    ? Date.parse(group.metadata.openReceiptRetriedAt)
    : Number.NaN;
  if (Number.isFinite(retriedAt) && now - retriedAt < OPEN_RECEIPT_RETRY_BACKOFF_MS) return false;
  return true;
}

function plannedGroupBins(group: PositionGroupRecord, bins: readonly PositionGroupBinRecord[]): PositionGroupBinRecord[] {
  const planned = bins.filter((bin) => bin.status !== "skipped");
  if (planned.length === 0 || planned.length !== group.mintableBinCount) {
    throw new Error(`position group has ${planned.length} planned bins but expects ${group.mintableBinCount}`);
  }
  if (new Set(planned.map((bin) => bin.binIndex)).size !== planned.length) {
    throw new Error("position group contains duplicate planned bin indexes");
  }
  if (new Set(planned.map((bin) => `${bin.tickLower}:${bin.tickUpper}`)).size !== planned.length) {
    throw new Error("position group contains duplicate planned bin ticks");
  }
  return planned;
}

function isManagedPosition(position: PositionRecord): boolean {
  return position.metadata.managedBy === "position_group"
    && typeof position.metadata.positionGroupId === "string";
}

function exactMintTokenIds(transfers: readonly Erc721Transfer[], expectedCount: number, owner: Address): bigint[] {
  if (transfers.length !== expectedCount) {
    throw new Error(`open receipt contains ${transfers.length} ERC721 transfers; expected exactly ${expectedCount} mints`);
  }
  if (transfers.some((transfer) => transfer.from.toLowerCase() !== zeroAddress.toLowerCase() || transfer.to.toLowerCase() !== owner.toLowerCase())) {
    throw new Error("open receipt contains a non-mint or incorrectly owned ERC721 transfer");
  }
  const tokenIds = transfers.map((transfer) => transfer.tokenId);
  if (new Set(tokenIds.map((tokenId) => tokenId.toString())).size !== tokenIds.length) {
    throw new Error("open receipt contains duplicate ERC721 token IDs");
  }
  return tokenIds;
}

function sameBigIntSet(left: readonly bigint[], right: readonly bigint[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left.map((value) => value.toString()));
  return expected.size === left.length && right.every((value) => expected.has(value.toString())) && new Set(right.map((value) => value.toString())).size === right.length;
}

function plannedV3Fee(group: PositionGroupRecord): number | undefined {
  const configured = firstNumericValue(
    group.metadata,
    group.planJson,
    recordValue(group.planJson, "plan"),
    recordValue(group.planJson, "preview"),
  );
  return configured;
}

function firstNumericValue(...values: readonly (Record<string, unknown> | null | undefined)[]): number | undefined {
  for (const value of values) {
    if (!value) continue;
    for (const key of ["feeTier", "fee"]) {
      const candidate = value[key];
      if (typeof candidate === "number" && Number.isSafeInteger(candidate)) return candidate;
      if (typeof candidate === "string" && /^\d+$/.test(candidate)) return Number(candidate);
    }
  }
  return undefined;
}

function plannedV4PoolKey(group: PositionGroupRecord): V4PoolKey | null {
  const candidates = [
    recordValue(group.planJson, "poolKey"),
    recordValue(group.planJson, "v4PoolKey"),
    recordValue(recordValue(group.planJson, "plan"), "poolKey"),
    recordValue(recordValue(group.planJson, "plan"), "v4PoolKey"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const currency0 = candidate.currency0;
    const currency1 = candidate.currency1;
    const fee = candidate.fee;
    const tickSpacing = candidate.tickSpacing;
    const hooks = candidate.hooks;
    if (typeof currency0 !== "string" || typeof currency1 !== "string" || typeof hooks !== "string") continue;
    if (!Number.isSafeInteger(Number(fee)) || !Number.isSafeInteger(Number(tickSpacing))) continue;
    return { currency0: currency0 as Address, currency1: currency1 as Address, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: hooks as Address };
  }
  return null;
}

function sameV4GroupPoolKey(group: PositionGroupRecord, poolKey: V4PoolKey): boolean {
  if (poolKey.currency0.toLowerCase() !== group.token0.toLowerCase() || poolKey.currency1.toLowerCase() !== group.token1.toLowerCase()) return false;
  const planned = plannedV4PoolKey(group);
  return !planned || (
    poolKey.currency0.toLowerCase() === planned.currency0.toLowerCase()
    && poolKey.currency1.toLowerCase() === planned.currency1.toLowerCase()
    && Number(poolKey.fee) === planned.fee
    && Number(poolKey.tickSpacing) === planned.tickSpacing
    && poolKey.hooks.toLowerCase() === planned.hooks.toLowerCase()
  );
}

function recordValue(value: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const nested = value?.[key];
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : null;
}

function derivedV4Salt(tokenId: bigint): Hex {
  return pad(toHex(tokenId), { size: 32 });
}

function normalizeV4PoolAndPositionInfo(value: unknown): { poolKey: V4PoolKey; positionInfo: bigint } {
  const tuple = Array.isArray(value) ? value : null;
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const rawPoolKey = tuple?.[0] ?? record?.poolKey;
  const rawPositionInfo = tuple?.[1] ?? record?.positionInfo;
  if (!rawPoolKey || typeof rawPoolKey !== "object" || rawPositionInfo === undefined) throw new Error("V4 position manager returned incomplete pool position info");
  const poolKey = rawPoolKey as Record<string, unknown>;
  if (typeof poolKey.currency0 !== "string" || typeof poolKey.currency1 !== "string" || typeof poolKey.hooks !== "string") {
    throw new Error("V4 position manager returned an invalid pool key");
  }
  const positionInfo = typeof rawPositionInfo === "bigint" ? rawPositionInfo : BigInt(rawPositionInfo as string | number);
  return {
    poolKey: {
      currency0: poolKey.currency0 as Address,
      currency1: poolKey.currency1 as Address,
      fee: Number(poolKey.fee),
      tickSpacing: Number(poolKey.tickSpacing),
      hooks: poolKey.hooks as Address,
    },
    positionInfo,
  };
}

function decodeErc721Transfer(logEntry: { data: Hex; topics: readonly Hex[] }): Erc721Transfer | null {
  try {
    const decoded = decodeEventLog({ abi: [erc721TransferEvent], data: logEntry.data, topics: logEntry.topics as [Hex, ...Hex[]] });
    const args = decoded.args as { from?: unknown; to?: unknown; tokenId?: unknown };
    return typeof args.from === "string" && typeof args.to === "string" && typeof args.tokenId === "bigint"
      ? { from: args.from as Address, to: args.to as Address, tokenId: args.tokenId }
      : null;
  } catch {
    return null;
  }
}

function decodeV3IncreaseLiquidity(logEntry: { data: Hex; topics: readonly Hex[] }): V3IncreaseLiquidity | null {
  try {
    const decoded = decodeEventLog({ abi: [v3IncreaseLiquidityEvent], data: logEntry.data, topics: logEntry.topics as [Hex, ...Hex[]] });
    const args = decoded.args as { tokenId?: unknown; liquidity?: unknown; amount0?: unknown; amount1?: unknown };
    return typeof args.tokenId === "bigint" && typeof args.liquidity === "bigint" && typeof args.amount0 === "bigint" && typeof args.amount1 === "bigint"
      ? { tokenId: args.tokenId, liquidity: args.liquidity, amount0: args.amount0, amount1: args.amount1 }
      : null;
  } catch {
    return null;
  }
}

function decodeV4LiquidityModification(logEntry: { data: Hex; topics: readonly Hex[] }): V4LiquidityModification | null {
  try {
    const decoded = decodeEventLog({ abi: [v4PoolManagerModifyLiquidityEvent], data: logEntry.data, topics: logEntry.topics as [Hex, ...Hex[]] });
    const args = decoded.args as { id?: unknown; sender?: unknown; tickLower?: unknown; tickUpper?: unknown; liquidityDelta?: unknown; salt?: unknown };
    return typeof args.id === "string" && typeof args.sender === "string" && typeof args.liquidityDelta === "bigint" && typeof args.salt === "string"
      && Number.isSafeInteger(Number(args.tickLower)) && Number.isSafeInteger(Number(args.tickUpper))
      ? {
        id: args.id as Hex,
        sender: args.sender as Address,
        tickLower: Number(args.tickLower),
        tickUpper: Number(args.tickUpper),
        liquidityDelta: args.liquidityDelta,
        salt: args.salt as Hex,
      }
      : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotMintedError(error: unknown): boolean {
  return errorMessage(error).includes("NOT_MINTED");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export function applyNativeDepositValue(
  amounts: { intoPool0: bigint; intoPool1: bigint },
  token0: Address,
  token1: Address,
  txValue: bigint,
): void {
  if (txValue <= 0n) return;
  if (token0.toLowerCase() === zeroAddress && amounts.intoPool0 === 0n) amounts.intoPool0 = txValue;
  if (token1.toLowerCase() === zeroAddress && amounts.intoPool1 === 0n) amounts.intoPool1 = txValue;
}

function midRangeSqrtPrice(tickLower?: number, tickUpper?: number): bigint {
  if (tickLower === undefined || tickUpper === undefined || tickLower >= tickUpper) return 1n;
  return sqrtRatioAtTick(Math.floor((tickLower + tickUpper) / 2));
}

function v4PoolId(currency0: Address, currency1: Address, fee: number, tickSpacing: number, hooks: Address): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [currency0, currency1, fee, tickSpacing, hooks],
  ));
}

function logArgs<T extends object>(entry: Log): T {
  return (entry as unknown as { args: T }).args;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
