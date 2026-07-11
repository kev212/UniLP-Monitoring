import { encodeAbiParameters, encodePacked, keccak256, pad, toHex, zeroAddress, type Address } from "viem";

import { v3PositionManagerAbi, v4StateViewAbi } from "../abi.js";
import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type { ChainName, PositionRecord } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import type { AlchemyBootstrapper } from "./alchemy-bootstrap.js";
import type { DiscoveryService } from "./discovery.js";
import type { Executor } from "./executor.js";
import type { Notifier } from "./notifier.js";
import type { PnlService } from "./pnl.js";

export class Guardian {
  private readonly lastEvaluatedBlock = new Map<number, bigint>();

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
    await Promise.all(this.config.chains.map(async (name) => {
      try {
        if (this.alchemyBootstrapper.isEnabled(name)) {
          await this.alchemyBootstrapper.bootstrap(name);
        }
        await this.discovery.syncChain(name);
        await this.evaluateChain(name);
      } catch (error) {
        log.error({ err: error, chain: name }, "chain cycle failed");
      }
    }));
    await this.resumeClosingPositions();
  }

  async runForever(intervalMs = 15_000): Promise<void> {
    while (true) {
      await this.runOnce();
      await sleep(intervalMs);
    }
  }

  private async evaluateChain(name: ChainName): Promise<void> {
    const { client, registry } = this.chains.get(name);
    const blockNumber = await client.getBlockNumber();
    if (this.lastEvaluatedBlock.get(registry.chain.id) === blockNumber) return;
    const positions = await this.database.listOpenPositions(registry.chain.id);
    let cycleComplete = true;
    for (const position of positions) {
      if (position.status === "needs_review" || position.status === "failed" || position.status === "paused") continue;
      cycleComplete = (await this.evaluatePosition(position, blockNumber)) && cycleComplete;
    }
    if (cycleComplete) this.lastEvaluatedBlock.set(registry.chain.id, blockNumber);
  }

  private async evaluatePosition(position: PositionRecord, blockNumber: bigint): Promise<boolean> {
    try {
      if (position.protocol === "v4") {
        const meta = position.metadata as Record<string, unknown>;
        const pk = {
          currency0: meta.currency0 as Address | undefined,
          currency1: meta.currency1 as Address | undefined,
          fee: meta.fee as number | undefined,
          tickSpacing: meta.tickSpacing as number | undefined,
          hooks: meta.hooks as Address | undefined,
        };
        if (pk.currency0 && pk.currency1 && pk.fee !== undefined && pk.tickSpacing !== undefined) {
          const poolId = keccak256(encodeAbiParameters(
            [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
            [pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, (pk.hooks ?? zeroAddress) as Address],
          ));
          const tickLower = meta.tickLower as number | undefined;
          const tickUpper = meta.tickUpper as number | undefined;
          if (tickLower !== undefined && tickUpper !== undefined) {
            const { client, registry } = this.chains.getById(position.chainId);
            const positionId = keccak256(encodePacked(
              ["address", "int24", "int24", "bytes32"],
              [registry.contracts.v4.positionManager, tickLower, tickUpper, pad(toHex(BigInt(position.positionKey)), { size: 32 })],
            ));
            const storedPosition = await client.readContract({
              address: registry.contracts.v4.stateView,
              abi: v4StateViewAbi,
              functionName: "getPositionInfo",
              args: [poolId, positionId],
              blockNumber,
            });
            const onChainLiq = storedPosition[0];
            if (onChainLiq === 0n) {
              await this.database.setPositionStatus(position.id, "settled", { reason: "on_chain_liquidity_zero" });
              log.info({ positionId: position.id }, "V4 position has zero on-chain liquidity — marking settled");
              return true;
            }
          }
        }
      }

      if (position.protocol === "v3") {
        const { client, registry } = this.chains.getById(position.chainId);
        const details = await client.readContract({
          address: registry.contracts.v3.positionManager,
          abi: v3PositionManagerAbi,
          functionName: "positions",
          args: [BigInt(position.positionKey)],
          blockNumber,
        });
        if (details[7] === 0n) {
          await this.database.setPositionStatus(position.id, "settled", { reason: "on_chain_liquidity_zero" });
          log.info({ positionId: position.id }, "V3 position has zero on-chain liquidity — marking settled");
          return true;
        }
      }

      const valued = await this.pnl.value(position, blockNumber);
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
      if (!trigger) return true;
      if (!valued.twapGuard.ready) {
        log.warn({ positionId: position.id, deviationBps: valued.twapGuard.deviationBps }, "threshold reached but price guard is not ready");
        return true;
      }
      void this.notifier.trigger(position, valued.snapshot, trigger);
      await this.executor.execute(position);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("cost basis")) {
        log.warn({ positionId: position.id }, "cost basis not yet available — waiting for cashflow sync");
        return false;
      }
      if (message.includes("zero liquidity")) {
        await this.database.setPositionStatus(position.id, "settled", { reason: "on_chain_liquidity_zero" });
        log.info({ positionId: position.id, reason: message }, "zero on-chain liquidity detected — marking settled");
        return true;
      }
      if (message.includes("No safe direct Uniswap route") || message.includes("Native-currency")) {
        await this.database.setPositionStatus(position.id, "needs_review", { reason: message });
        log.warn({ positionId: position.id, reason: message }, "position requires review before arming");
        return true;
      } else {
        log.warn({ err: error, positionId: position.id }, "could not value position");
        return false;
      }
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
