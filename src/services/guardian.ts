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

export class Guardian {
  private readonly lastEvaluatedBlock = new Map<number, bigint>();
  private exitQueue: Promise<void> = Promise.resolve();
  private readonly queuedExitPositions = new Set<string>();
  private monitorRunning = false;
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
    await this.runMonitorOnce();
  }

  async runForever(): Promise<void> {
    await Promise.all([
      this.runLoop(() => this.runMonitorOnce(), this.config.positionMonitorIntervalMs),
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

  private async runMonitorOnce(): Promise<void> {
    if (this.monitorRunning) return;
    this.monitorRunning = true;
    try {
      await Promise.all(this.config.chains.map(async (name) => {
        try {
          await this.evaluateChain(name);
        } catch (error) {
          log.error({ err: error, chain: name }, "monitor cycle failed");
        }
      }));
      await this.resumeClosingPositions();
    } finally {
      this.monitorRunning = false;
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
            await this.database.setPositionStatus(candidate.id, "settled", { reason: "nft_burned" });
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
      const valued = await this.pnl.value(position, blockNumber);
      log.debug({ positionId: position.id, positionKey: position.positionKey, valuationMs: Date.now() - startedAt }, "position valued");
      await this.database.addPnlSnapshot(valued.snapshot);
      await this.notifier.logPnL(position, valued.snapshot);
      const trailing = this.pnl.evaluateTrailingStop(position.metadata, valued.snapshot);

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

      const staticTrigger = this.pnl.shouldTrigger(valued.snapshot);
      if (!staticTrigger && (trailing.action === "activate" || trailing.action === "raise_peak")) {
        await this.database.setTrailingStopState(position.id, trailing.state);
        log.info({
          positionId: position.id,
          peakPnlBps: trailing.state.peakPnlBps,
          activationBlock: trailing.state.activatedAtBlock,
          action: trailing.action,
        }, "trailing stop updated");
      }

      const trigger = staticTrigger ?? (trailing.action === "trigger" ? "trailing_take_profit" : null);
      const pendingRetry = !trigger ? parseExitRetry(position.metadata) : null;
      const effectiveTrigger: ExitTrigger | null = trigger ?? pendingRetry?.reason ?? null;
      if (!effectiveTrigger) {
        return true;
      }
      if (!valued.twapGuard.ready) {
        log.warn({ positionId: position.id, deviationBps: valued.twapGuard.deviationBps }, "threshold reached but price guard is not ready");
        return true;
      }
      const nextAttemptAt = retryAt(position.metadata);
      if (nextAttemptAt !== null && Date.now() < nextAttemptAt) {
        log.info({ positionId: position.id, trigger: effectiveTrigger, nextAttemptAt: new Date(nextAttemptAt).toISOString() }, "exit retry waiting for backoff");
        return true;
      }
      if (this.queuedExitPositions.has(position.id)) return true;
      void this.notifier.trigger(position, valued.snapshot, effectiveTrigger);
      try {
        await this.executeExit(position, effectiveTrigger);
        await this.database.setPositionStatus(position.id, position.status, { exitRetry: null });
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
        await this.database.setPositionStatus(position.id, "settled", { reason: "on_chain_liquidity_zero" });
        log.info({ positionId: position.id, reason: message }, "zero on-chain liquidity detected — marking settled");
        void this.notifier.settled(position);
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
