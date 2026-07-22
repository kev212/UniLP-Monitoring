import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type { ChainName, ExitTrigger, PositionRecord } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import type { AlchemyBootstrapper } from "./alchemy-bootstrap.js";
import type { DiscoveryService } from "./discovery.js";
import type { Executor } from "./executor.js";
import type { Notifier } from "./notifier.js";
import type { PnlService } from "./pnl.js";
import { quoteRangeState } from "./quote-range.js";

export class Guardian {
  private readonly lastEvaluatedBlock = new Map<number, bigint>();
  private exitQueue: Promise<void> = Promise.resolve();
  private readonly queuedExitPositions = new Set<string>();
  private monitorRunning = false;
  private readonly chainMonitorRunning = new Set<string>();
  private discoveryRunning = false;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly database: Database,
    private readonly chains: ChainClients,
    private readonly alchemyBootstrapper: AlchemyBootstrapper,
    private readonly discovery: DiscoveryService,
    private readonly pnl: PnlService,
    private readonly executor: Executor,
    private readonly notifier: Notifier,
  ) {}

  async validateNetworks(): Promise<void> {
    for (const name of this.config.chains) {
      const { client, registry } = this.chains.get(name);
      const chainId = await client.getChainId();
      if (chainId !== registry.chain.id) {
        throw new Error(`${name} RPC returned chain ID ${chainId}, expected ${registry.chain.id}`);
      }
      log.info({ chain: name, chainId }, "network validated");
    }
  }

  async runOnce(): Promise<void> {
    await this.runDiscoveryOnce();
    await Promise.all(this.config.chains.map((name) => this.runChainMonitorOnce(name)));
  }

  async runForever(): Promise<void> {
    const monitorLoops = this.config.chains.map((name: ChainName) => {
      const interval = this.config.chainMonitorIntervalMs[name] ?? this.config.positionMonitorIntervalMs;
      return this.runLoop(() => this.runChainMonitorOnce(name), interval);
    });
    await Promise.all([
      ...monitorLoops,
      this.runLoop(() => this.runDiscoveryOnce(), this.config.discoveryIntervalMs),
    ]);
  }

  private async runDiscoveryOnce(): Promise<void> {
    if (this.discoveryRunning) return;
    this.discoveryRunning = true;
    try {
      await Promise.all(this.config.chains.map(async (name) => {
        try {
          if (this.alchemyBootstrapper.isEnabled(name)) await this.alchemyBootstrapper.bootstrap(name);
          await this.discovery.syncChain(name);
          await this.retryNeedsReview(name);
        } catch (error) {
          log.error({ err: error, chain: name }, "discovery cycle failed");
        }
      }));
    } finally {
      this.discoveryRunning = false;
    }
  }

  private async runChainMonitorOnce(name: ChainName): Promise<void> {
    if (this.chainMonitorRunning.has(name)) return;
    this.chainMonitorRunning.add(name);
    try {
      try {
        await this.evaluateChain(name);
      } catch (error) {
        log.error({ err: error, chain: name }, "monitor cycle failed");
      }
      if (!this.monitorRunning) {
        this.monitorRunning = true;
        try { await this.resumeClosingPositions(); } finally { this.monitorRunning = false; }
      }
    } finally {
      this.chainMonitorRunning.delete(name);
    }
  }

  private async retryNeedsReview(name: ChainName): Promise<void> {
    const { client, registry } = this.chains.get(name);
    const blockNumber = await client.getBlockNumber();
    const positions = (await this.database.listOpenPositions(registry.chain.id))
      .filter((position) => position.status === "needs_review");

    for (const position of positions) {
      let candidate = position;
      if (candidate.protocol === "v4") {
        try {
          const refreshed = await this.discovery.refreshV4Position(name, candidate);
          if (!refreshed || refreshed.status === "settled") continue;
          candidate = refreshed;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("NOT_MINTED")) {
            const reviewed = await this.database.markNeedsReviewIfNoPendingSettlement(candidate.id, { reason: "nft_burned_unverified" });
            log[reviewed ? "warn" : "info"](
              { positionId: candidate.id, positionKey: candidate.positionKey },
              reviewed ? "V4 NFT is burned without a verified settlement" : "V4 NFT is burned but settlement remains pending",
            );
          }
          continue;
        }
      }
      if (!candidate.quoteToken) continue;

      await this.database.setPositionStatus(candidate.id, "syncing", { needsReviewRetriedAt: new Date().toISOString(), reason: null });
      await this.evaluatePosition(name, { ...candidate, status: "syncing" }, blockNumber);
    }
  }

  private async runLoop(work: () => Promise<void>, intervalMs: number): Promise<void> {
    while (true) {
      const startedAt = Date.now();
      await work();
      await sleep(Math.max(0, intervalMs - (Date.now() - startedAt)));
    }
  }

  private async evaluateChain(name: ChainName): Promise<void> {
    const { client, registry } = this.chains.get(name);
    const blockNumber = await client.getBlockNumber();
    if (this.lastEvaluatedBlock.get(registry.chain.id) === blockNumber) return;
    const positions = (await this.database.listOpenPositions(registry.chain.id))
      .filter((position) => position.status !== "needs_review" && position.status !== "failed" && position.status !== "paused");
    const results = await mapWithConcurrency(positions, this.config.positionMonitorConcurrency, (position) => this.evaluatePosition(name, position, blockNumber));
    if (results.every(Boolean)) this.lastEvaluatedBlock.set(registry.chain.id, blockNumber);
  }

  private async evaluatePosition(name: ChainName, position: PositionRecord, blockNumber: bigint): Promise<boolean> {
    const startedAt = Date.now();
    try {
      if (position.protocol === "v4" && position.status === "syncing") {
        try {
          const totals = await this.database.getCashflowTotals(position.id);
          const force = totals.deposits === 0n;
          await this.discovery.retryHydrateV4OpeningCashflow(name, position, force);
        } catch (error) {
          log.warn({ err: error, positionId: position.id }, "V4 opening cashflow retry failed");
        }
      }
      if (position.protocol === "v3" && position.status === "syncing") {
        try {
          const totals = await this.database.getCashflowTotals(position.id);
          const force = totals.deposits === 0n;
          await this.discovery.retryHydrateV3OpeningCashflow(name, position, force);
        } catch (error) {
          log.warn({ err: error, positionId: position.id }, "V3 opening cashflow retry failed");
        }
      }
      const valued = await this.pnl.value(position, blockNumber);
      log.debug({ positionId: position.id, positionKey: position.positionKey, valuationMs: Date.now() - startedAt }, "position valued");
      await this.database.addPnlSnapshot(valued.snapshot);
      await this.notifier.logPnL(position, valued.snapshot);
      if (position.metadata.autoExitDisabled === true) {
        return true;
      }
      const trailing = this.pnl.evaluateTrailingStop(position.metadata, valued.snapshot);
      await this.updateOorAboveTimer(position, valued.range);
      await this.updateProfitOorAboveTimer(position, valued.range, valued.snapshot.pnlBps);

      if (position.status === "discovered" || position.status === "syncing") {
        if (trailing.action === "activate" || trailing.action === "raise_peak") {
          await this.database.setTrailingStopState(position.id, trailing.state);
          log.info({
            positionId: position.id,
            peakPnlBps: trailing.state.peakPnlBps,
            activationBlock: trailing.state.activatedAtBlock,
            action: trailing.action,
          }, "trailing stop updated");
        }
        await this.database.setPositionStatus(position.id, "armed", {
          armedAtBlock: blockNumber.toString(),
          twapReady: valued.twapGuard.ready,
        });
        await this.notifier.armed(position, valued.snapshot);
        return true;
      }

      if (trailing.action === "reset") {
        await this.database.clearTrailingStopState(position.id);
        log.info({ positionId: position.id, pnlBps: valued.snapshot.pnlBps }, "trailing stop reset after negative PnL");
      }

      const quoteIsToken0 = position.quoteToken?.toLowerCase() === position.token0.toLowerCase();
      const quoteRange = quoteRangeState(valued.range, quoteIsToken0);
      const staticTrigger = this.pnl.shouldTrigger(valued.snapshot, valued.range, quoteIsToken0);
      if (!staticTrigger && (trailing.action === "activate" || trailing.action === "raise_peak")) {
        await this.database.setTrailingStopState(position.id, trailing.state);
        log.info({
          positionId: position.id,
          peakPnlBps: trailing.state.peakPnlBps,
          activationBlock: trailing.state.activatedAtBlock,
          action: trailing.action,
        }, "trailing stop updated");
      }

      const trigger = staticTrigger
        ?? (trailing.action === "trigger" ? "trailing_take_profit" : null)
        ?? this.checkProfitOorAboveTrigger(position.metadata)
        ?? this.checkOorAboveTrigger(position.metadata);
      const pendingRetry = !trigger ? parseExitRetry(position.metadata) : null;
      const effectiveTrigger: ExitTrigger | null = trigger ?? pendingRetry?.reason ?? null;
      if (!effectiveTrigger) {
        return true;
      }
      if (effectiveTrigger !== "stop_loss" && !valued.twapGuard.ready) {
        log.warn({
          positionId: position.id,
          trigger: effectiveTrigger,
          rawRangeStatus: valued.range?.status,
          quoteRangeStatus: quoteRange?.status,
          quoteIsToken0,
          deviationBps: valued.twapGuard.deviationBps,
        }, "threshold reached but price guard is not ready");
        return true;
      }
      const nextAttemptAt = retryAt(position.metadata);
      if (nextAttemptAt !== null && Date.now() < nextAttemptAt) {
        log.info({ positionId: position.id, trigger: effectiveTrigger, nextAttemptAt: new Date(nextAttemptAt).toISOString() }, "exit retry waiting for backoff");
        return true;
      }
      if (effectiveTrigger === "trailing_take_profit") {
        const gateBps = this.pnl.trailingExitEstimateGateBps(position.metadata);
        if (gateBps !== null) {
          const exitEstimate = await this.pnl.value(position, blockNumber, this.config.settlementSwapSlippageBps);
          if (exitEstimate.snapshot.pnlBps < gateBps) {
            log.info({
              positionId: position.id,
              positionKey: position.positionKey,
              estimatePnlBps: exitEstimate.snapshot.pnlBps,
              gateBps,
            }, "trailing exit deferred below conservative estimate gate");
            return true;
          }
        }
      }
      if (this.queuedExitPositions.has(position.id)) return true;
      void this.notifier.trigger(position, valued.snapshot, effectiveTrigger);
      try {
        await this.database.setPositionStatus(position.id, position.status, {
          exitSnapshot: {
            pnlBps: valued.snapshot.pnlBps.toString(),
            pnlQuote: valued.snapshot.pnlQuote.toString(),
            blockNumber: valued.snapshot.blockNumber.toString(),
          },
        });
        await this.executeExit(position, effectiveTrigger);
        return true;
      } catch (error) {
        log.warn({ err: error, positionId: position.id, trigger: effectiveTrigger }, "exit attempt failed; waiting for fresh PnL before retry");
        return false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("cost basis")) {
        log.warn({ positionId: position.id }, "cost basis not yet available — waiting for cashflow sync");
        return false;
      }
      if (message.includes("zero liquidity") || message.includes("NOT_MINTED") || message.includes("Invalid token ID")) {
        if (await this.database.recoverVerifiedSettlement(position.id)) {
          log.info({ positionId: position.id, positionKey: position.positionKey }, "recovered verified settlement after on-chain liquidity reached zero");
          return true;
        }
        if (await this.executor.autoSettleZeroLiquidityV3(name, position)) return true;
        if (await this.executor.autoSettleZeroLiquidityV4(name, position)) return true;
        const reviewed = await this.database.markNeedsReviewIfNoPendingSettlement(position.id, { reason: "on_chain_liquidity_zero_unverified" });
        if (!reviewed) {
          log.info({ positionId: position.id, positionKey: position.positionKey, reason: message }, "V4 liquidity is gone but settlement remains pending");
          return true;
        }
        log.warn({ positionId: position.id, reason: message }, "zero on-chain liquidity requires settlement review");
        return true;
      }
      if (message.includes("No safe direct Uniswap route") || message.includes("Native-currency")) {
        await this.database.setPositionStatus(position.id, "needs_review", { reason: message });
        log.warn({ positionId: position.id, reason: message }, "position requires review before arming");
        return true;
      }
      log.warn({ err: error, positionId: position.id }, "could not value position");
      return false;
    }
  }

  private async resumeClosingPositions(): Promise<void> {
    const positions = await this.database.listPendingSwapPositions();
    for (const position of positions) {
      try {
        if (position.status !== "closing") {
          await this.database.setPositionStatus(position.id, "closing", { settlementRecoveryAt: new Date().toISOString() });
        }
        await this.executor.resume({ ...position, status: "closing" });
      } catch (error) {
        log.warn({ err: error, positionId: position.id }, "settlement retry deferred");
      }
    }
  }

  private async executeExit(position: PositionRecord, trigger: ExitTrigger): Promise<void> {
    if (this.queuedExitPositions.has(position.id)) return;
    this.queuedExitPositions.add(position.id);
    const attempt = this.exitQueue.then(() => this.executor.execute(position, trigger));
    this.exitQueue = attempt.catch(() => undefined);
    try {
      await attempt;
    } finally {
      this.queuedExitPositions.delete(position.id);
    }
  }

  private async updateOorAboveTimer(position: PositionRecord, range?: import("../types.js").PositionRangeInfo): Promise<void> {
    const meta = position.metadata as Record<string, unknown>;
    const quoteIsToken0 = position.quoteToken?.toLowerCase() === position.token0.toLowerCase();
    const state = quoteRangeState(range, quoteIsToken0 === true);
    if (!state || !this.config.oorAutoCloseEnabled) return;
    const thresholdBps = BigInt(Math.round(this.config.oorAboveMinDistancePercent * 100));
    const active = state.status === "above" && state.aboveDistanceBps >= thresholdBps;
    if (active && typeof meta.oorAboveSeenAt !== "number") {
      const now = Date.now();
      await this.database.setPositionStatus(position.id, position.status, {
        oorAboveSeenAt: now,
        oorAboveDistanceBps: Number(state.aboveDistanceBps),
        oorStatus: state.status,
      });
      log.info({ positionId: position.id, rawRangeStatus: range?.status, quoteRangeStatus: state.status, quoteIsToken0, distanceBps: state.aboveDistanceBps }, "OOR above timer started");
    } else if (!active && typeof meta.oorAboveSeenAt === "number") {
      await this.database.setPositionStatus(position.id, position.status, {
        oorAboveSeenAt: null,
        oorAboveDistanceBps: null,
        oorStatus: state.status,
      });
      log.info({ positionId: position.id, rawRangeStatus: range?.status, quoteRangeStatus: state.status, quoteIsToken0 }, "OOR above timer reset");
    }
  }

  private checkOorAboveTrigger(metadata: Record<string, unknown>): ExitTrigger | null {
    if (!this.config.oorAutoCloseEnabled) return null;
    const seenAt = (metadata as Record<string, unknown>).oorAboveSeenAt;
    if (typeof seenAt !== "number") return null;
    if (Date.now() - seenAt < this.config.oorAboveMinDurationMs) return null;
    return "out_of_range_above";
  }

  private async updateProfitOorAboveTimer(position: PositionRecord, range: import("../types.js").PositionRangeInfo | undefined, pnlBps: bigint): Promise<void> {
    const meta = position.metadata as Record<string, unknown>;
    const quoteIsToken0 = position.quoteToken?.toLowerCase() === position.token0.toLowerCase();
    const state = quoteRangeState(range, quoteIsToken0 === true);
    if (!state) return;
    const thresholdBps = BigInt(Math.round(this.config.profitOorAboveThresholdPercent * 100));
    const active = state.status === "above" && pnlBps >= thresholdBps;
    if (active && typeof meta.profitOorAboveSeenAt !== "number") {
      const now = Date.now();
      await this.database.setPositionStatus(position.id, position.status, {
        profitOorAboveSeenAt: now,
        profitOorAbovePnlBps: Number(pnlBps),
      });
      log.info({ positionId: position.id, positionKey: position.positionKey, pnlBps, quoteRangeStatus: state.status, quoteIsToken0 }, "profit + OOR above timer started");
    } else if (!active && typeof meta.profitOorAboveSeenAt === "number") {
      await this.database.setPositionStatus(position.id, position.status, {
        profitOorAboveSeenAt: null,
        profitOorAbovePnlBps: null,
      });
      log.info({ positionId: position.id, positionKey: position.positionKey, pnlBps, quoteRangeStatus: state?.status, quoteIsToken0 }, "profit + OOR above timer reset");
    }
  }

  private checkProfitOorAboveTrigger(metadata: Record<string, unknown>): ExitTrigger | null {
    const seenAt = (metadata as Record<string, unknown>).profitOorAboveSeenAt;
    if (typeof seenAt !== "number") return null;
    if (Date.now() - seenAt < this.config.oorAboveProfitDurationMs) return null;
    return "profit_oor_above";
  }

}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function retryAt(metadata: Record<string, unknown>): number | null {
  const raw = metadata.exitRetry;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const nextAttemptAt = (raw as Record<string, unknown>).nextAttemptAt;
  if (typeof nextAttemptAt !== "string") return null;
  const timestamp = Date.parse(nextAttemptAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseExitRetry(metadata: Record<string, unknown>): { reason: ExitTrigger; nextAttemptAt: number } | null {
  const raw = metadata.exitRetry;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.reason !== "string") return null;
  if (typeof r.nextAttemptAt !== "string") return null;
  const timestamp = Date.parse(r.nextAttemptAt);
  if (!Number.isFinite(timestamp)) return null;
  return { reason: r.reason as ExitTrigger, nextAttemptAt: timestamp };
}
