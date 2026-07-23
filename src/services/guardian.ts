import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type { ChainName, ExitTrigger, PnlSnapshot, PositionRecord } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import type { AlchemyBootstrapper } from "./alchemy-bootstrap.js";
import type { DiscoveryService } from "./discovery.js";
import type { Executor } from "./executor.js";
import type { Notifier } from "./notifier.js";
import type { PnlService } from "./pnl.js";
import { hasPendingSettlement } from "./pending-settlement.js";
import { quoteRangeState } from "./quote-range.js";

const POSITION_EVALUATION_TIMEOUT_MS = 60_000;

export class Guardian {
  private readonly lastEvaluatedBlock = new Map<number, bigint>();
  private exitQueue: Promise<void> = Promise.resolve();
  private readonly queuedExitPositions = new Set<string>();
  private monitorRunning = false;
  private readonly chainMonitorRunning = new Set<string>();
  private readonly positionEvaluations = new Set<string>();
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
      .filter((position) => position.status === "needs_review"
        && !hasPendingSettlement(position.status, position.metadata));

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
      if (!candidate.quoteToken) {
        const repaired = await this.discovery.tryAssignQuoteToken(name, candidate);
        if (!repaired) continue;
        candidate = repaired;
      }

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
    const results = await mapWithConcurrency(
      positions,
      this.config.positionMonitorConcurrency,
      (position) => this.evaluatePositionWithTimeout(name, position, blockNumber),
    );
    if (results.every(Boolean)) this.lastEvaluatedBlock.set(registry.chain.id, blockNumber);
  }

  private async evaluatePositionWithTimeout(name: ChainName, position: PositionRecord, blockNumber: bigint): Promise<boolean> {
    if (this.positionEvaluations.has(position.id)) return true;

    this.positionEvaluations.add(position.id);
    const evaluation = this.evaluatePosition(name, position, blockNumber);
    void evaluation.finally(() => this.positionEvaluations.delete(position.id)).catch(() => {});
    try {
      return await withTimeout(evaluation, POSITION_EVALUATION_TIMEOUT_MS);
    } catch (error) {
      log.warn({ err: error, positionId: position.id, positionKey: position.positionKey, timeoutMs: POSITION_EVALUATION_TIMEOUT_MS }, "position valuation timed out; continuing monitor cycle");
      return true;
    }
  }

  private async evaluatePosition(name: ChainName, position: PositionRecord, blockNumber: bigint): Promise<boolean> {
    const startedAt = Date.now();
    try {
      if (hasPendingSettlement(position.status, position.metadata)) {
        if (position.metadata.settlementRetryDisabled === true) {
          await this.database.setPositionStatusUnlessSettled(position.id, "needs_review", {
            reason: typeof position.metadata.reason === "string" ? position.metadata.reason : "settlement_retry_disabled",
          });
          return true;
        }
        await this.database.setPositionStatusUnlessSettled(position.id, "closing", { reason: null });
        await this.executor.resume({ ...position, status: "closing" });
        return true;
      }
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
      const oorTrigger = await this.updateOorAboveTimer(position, valued.range);
      const profitOorTrigger = await this.updateProfitOorAboveTimer(position, valued.range, valued.snapshot.pnlBps);

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
        ?? profitOorTrigger
        ?? oorTrigger;
      const pendingRetry = !trigger ? parseExitRetry(position.metadata) : null;
      const retryTrigger = pendingRetry && shouldResumeExitRetry(pendingRetry.reason) ? pendingRetry.reason : null;
      const effectiveTrigger: ExitTrigger | null = trigger ?? retryTrigger;
      if (!effectiveTrigger) {
        const staleDynamicRetry = pendingRetry && !shouldResumeExitRetry(pendingRetry.reason);
        if (position.metadata.slTwapWaitStartedAt !== undefined || staleDynamicRetry) {
          await this.database.setPositionStatus(position.id, position.status, {
            slTwapWaitStartedAt: null,
            ...(staleDynamicRetry ? { exitRetry: null } : {}),
          });
        }
        return true;
      }
      if (!valued.twapGuard.ready) {
        if (effectiveTrigger === "stop_loss") {
          const slWaitStartedAt = typeof position.metadata.slTwapWaitStartedAt === "number"
            ? position.metadata.slTwapWaitStartedAt : null;
          if (slWaitStartedAt === null) {
            await this.database.setPositionStatus(position.id, position.status, { slTwapWaitStartedAt: Date.now() });
            log.warn({
              positionId: position.id,
              trigger: effectiveTrigger,
              deviationBps: valued.twapGuard.deviationBps,
            }, "SL threshold reached but TWAP not ready; starting guard wait");
            return true;
          }
          if (Date.now() - slWaitStartedAt < this.config.slTwapGuardMaxWaitMs) {
            log.info({
              positionId: position.id,
              trigger: effectiveTrigger,
              elapsed: Date.now() - slWaitStartedAt,
            }, "SL waiting for TWAP guard to stabilize");
            return true;
          }
          log.warn({
            positionId: position.id,
            trigger: effectiveTrigger,
            elapsed: Date.now() - slWaitStartedAt,
          }, "SL executing after TWAP guard max wait override");
        } else {
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
      }
      const nextAttemptAt = retryAt(position.metadata);
      if (shouldWaitForExitRetry(effectiveTrigger, nextAttemptAt)) {
        log.info({ positionId: position.id, trigger: effectiveTrigger, nextAttemptAt: new Date(nextAttemptAt!).toISOString() }, "exit retry waiting for backoff");
        return true;
      }
      if (this.queuedExitPositions.has(position.id)) return true;
      if (effectiveTrigger === "trailing_take_profit") {
        if (!(await this.trailingExitEstimateAllowed(position, blockNumber))) return true;
      }
      try {
        await this.database.setPositionStatus(position.id, position.status, {
          slTwapWaitStartedAt: null,
          exitSnapshot: {
            pnlBps: valued.snapshot.pnlBps.toString(),
            pnlQuote: valued.snapshot.pnlQuote.toString(),
            blockNumber: valued.snapshot.blockNumber.toString(),
          },
        });
        await this.executeExit(position, effectiveTrigger, valued.snapshot);
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

  private async executeExit(position: PositionRecord, trigger: ExitTrigger, triggerSnapshot: PnlSnapshot): Promise<void> {
    if (this.queuedExitPositions.has(position.id)) return;
    this.queuedExitPositions.add(position.id);
    const attempt = this.exitQueue.then(async () => {
      if (trigger === "trailing_take_profit") {
        const latestMetadata = await this.database.getPositionMetadata(position.id);
        const latestPosition = latestMetadata ? { ...position, metadata: latestMetadata } : position;
        const latestBlock = await this.chains.getById(position.chainId).client.getBlockNumber();
        const latestValuation = await this.pnl.value(latestPosition, latestBlock, this.config.settlementSwapSlippageBps, false);
        const quoteIsToken0 = latestPosition.quoteToken?.toLowerCase() === latestPosition.token0.toLowerCase();
        const latestStaticTrigger = this.pnl.shouldTrigger(latestValuation.snapshot, latestValuation.range, quoteIsToken0);
        if (latestStaticTrigger === "stop_loss") {
          trigger = latestStaticTrigger;
          triggerSnapshot = latestValuation.snapshot;
          log.warn({ positionId: position.id, positionKey: position.positionKey }, "queued trailing exit upgraded to stop-loss");
        } else {
          const latestEstimate = await this.trailingExitEstimateAllowed(latestPosition, latestBlock, latestValuation);
          if (!latestEstimate) return;
          triggerSnapshot = latestEstimate;
        }
        position = latestPosition;
      }
      void this.notifier.trigger(position, triggerSnapshot, trigger);
      await this.executor.execute(position, trigger);
    });
    this.exitQueue = attempt.catch(() => undefined);
    try {
      await attempt;
    } finally {
      this.queuedExitPositions.delete(position.id);
    }
  }

  private async trailingExitEstimateAllowed(position: PositionRecord, blockNumber: bigint, valued?: Awaited<ReturnType<PnlService["value"]>>): Promise<PnlSnapshot | null> {
    const gateBps = this.pnl.trailingExitEstimateGateBps(position.metadata);
    if (gateBps === null) {
      await this.database.setPositionStatusUnlessSettled(position.id, "needs_review", {
        reason: "trailing_exit_state_missing",
        settlementRetryDisabled: true,
      });
      log.error({ positionId: position.id, positionKey: position.positionKey }, "trailing exit blocked because peak state is missing");
      return null;
    }

    const exitEstimate = valued ?? await this.pnl.value(
      position,
      blockNumber,
      this.config.settlementSwapSlippageBps,
      false,
    );
    if (exitEstimate.snapshot.pnlBps >= gateBps) return exitEstimate.snapshot;
    log.info({
      positionId: position.id,
      positionKey: position.positionKey,
      estimatePnlBps: exitEstimate.snapshot.pnlBps,
      gateBps,
    }, "trailing exit deferred below conservative estimate gate");
    return null;
  }

  private async updateOorAboveTimer(position: PositionRecord, range?: import("../types.js").PositionRangeInfo): Promise<ExitTrigger | null> {
    const meta = position.metadata as Record<string, unknown>;
    const quoteIsToken0 = position.quoteToken?.toLowerCase() === position.token0.toLowerCase();
    const state = quoteRangeState(range, quoteIsToken0 === true);
    if (!state || !this.config.oorAutoCloseEnabled) return null;
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
      return null;
    } else if (!active && typeof meta.oorAboveSeenAt === "number") {
      await this.database.setPositionStatus(position.id, position.status, {
        oorAboveSeenAt: null,
        oorAboveDistanceBps: null,
        oorStatus: state.status,
      });
      log.info({ positionId: position.id, rawRangeStatus: range?.status, quoteRangeStatus: state.status, quoteIsToken0 }, "OOR above timer reset");
      return null;
    }
    const seenAt = meta.oorAboveSeenAt;
    if (typeof seenAt !== "number") return null;
    if (Date.now() - seenAt < this.config.oorAboveMinDurationMs) return null;
    return "out_of_range_above";
  }

  private async updateProfitOorAboveTimer(position: PositionRecord, range: import("../types.js").PositionRangeInfo | undefined, pnlBps: bigint): Promise<ExitTrigger | null> {
    const meta = position.metadata as Record<string, unknown>;
    const quoteIsToken0 = position.quoteToken?.toLowerCase() === position.token0.toLowerCase();
    const state = quoteRangeState(range, quoteIsToken0 === true);
    if (!state) return null;
    const thresholdBps = BigInt(Math.round(this.config.profitOorAboveThresholdPercent * 100));
    const active = state.status === "above" && pnlBps >= thresholdBps;
    if (active && typeof meta.profitOorAboveSeenAt !== "number") {
      const now = Date.now();
      await this.database.setPositionStatus(position.id, position.status, {
        profitOorAboveSeenAt: now,
        profitOorAbovePnlBps: Number(pnlBps),
      });
      log.info({ positionId: position.id, positionKey: position.positionKey, pnlBps, quoteRangeStatus: state.status, quoteIsToken0 }, "profit + OOR above timer started");
      return null;
    } else if (!active && typeof meta.profitOorAboveSeenAt === "number") {
      await this.database.setPositionStatus(position.id, position.status, {
        profitOorAboveSeenAt: null,
        profitOorAbovePnlBps: null,
      });
      log.info({ positionId: position.id, positionKey: position.positionKey, pnlBps, quoteRangeStatus: state?.status, quoteIsToken0 }, "profit + OOR above timer reset");
      return null;
    }
    const seenAt = meta.profitOorAboveSeenAt;
    if (typeof seenAt !== "number") return null;
    if (Date.now() - seenAt < this.config.oorAboveProfitDurationMs) return null;
    return "profit_oor_above";
  }

}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`position evaluation timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

export function shouldWaitForExitRetry(trigger: ExitTrigger, nextAttemptAt: number | null, now = Date.now()): boolean {
  return trigger !== "stop_loss" && nextAttemptAt !== null && now < nextAttemptAt;
}

export function shouldResumeExitRetry(trigger: ExitTrigger): boolean {
  return trigger === "stop_loss" || trigger === "take_profit" || trigger === "manual";
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
