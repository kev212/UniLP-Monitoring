import { loadConfig } from "./config.js";
import { zeroAddress } from "viem";
import { Database } from "./db.js";
import { log } from "./log.js";
import { ChainClients } from "./services/chain-client.js";
import { AlchemyBootstrapper } from "./services/alchemy-bootstrap.js";
import { DiscoveryService } from "./services/discovery.js";
import { Executor } from "./services/executor.js";
import { Guardian } from "./services/guardian.js";
import { Notifier } from "./services/notifier.js";
import { PnlService } from "./services/pnl.js";
import { PositionReader } from "./services/position-reader.js";
import { RoutePlanner } from "./services/route-planner.js";
import { UniswapTradingApi } from "./services/uniswap-trading-api.js";
import { PoolScanner } from "./services/pool-scanner.js";
import { PositionOpener } from "./services/position-opener.js";
import { GemScanner } from "./services/gem-scanner.js";
import { PortfolioService } from "./services/portfolio.js";
import { KyberSwapAggregatorApi } from "./services/kyberswap-aggregator-api.js";
import { PancakeUniversalRouter } from "./services/pancake-universal-router.js";
import { isRiskSettings, type RiskSettings } from "./types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const database = new Database(config.databaseUrl);
  const chains = new ChainClients(config);
  const reader = new PositionReader(chains, config.maxSwapSlippageBps);
  const routes = new RoutePlanner(chains, config.maxSwapSlippageBps, config.quoteTokens);
  const tradingApi = config.uniswapApiKey ? new UniswapTradingApi(config.uniswapApiKey, config.maxSwapSlippageBps, globalThis.fetch, config.swapApiTimeoutMs) : undefined;
  const kyberswapApi = config.kyberswapEnabled
    ? new KyberSwapAggregatorApi(
        config.kyberswapClientId,
        config.settlementSwapSlippageBps,
        config.swapApiTimeoutMs,
        config.kyberswapMaxRouteAgeMs,
      )
    : undefined;
  const notifier = new Notifier(config, chains, database);
  const discovery = new DiscoveryService(database, chains, config, notifier);
  const alchemyBootstrapper = new AlchemyBootstrapper(database, chains, discovery, config);
  const pnl = new PnlService(database, reader, routes, config, tradingApi, kyberswapApi);
  const pancakeUr = new PancakeUniversalRouter(chains, routes, config.settlementSwapSlippageBps);
  const executor = new Executor(database, chains, reader, routes, notifier, config, tradingApi, kyberswapApi, pancakeUr);
  const guardian = new Guardian(config, database, chains, alchemyBootstrapper, discovery, pnl, executor, notifier);
  const scanner = new PoolScanner(chains, database);
  const positionOpener = new PositionOpener(
    config,
    chains,
    routes,
    tradingApi,
    database,
    (chain, groupId, transactionHash, receipt) => discovery.reconcileKnownGroupOpen(chain, groupId, transactionHash, receipt),
    (chain, receipt) => discovery.ingestOpenReceipt(chain, receipt),
    kyberswapApi,
  );
  const gemScanner = new GemScanner(chains, database, scanner, config.quoteTokens.robinhood);
  const portfolio = new PortfolioService(config, chains, database);
  notifier.setPositionOpener(positionOpener);
  notifier.setGemScanner(gemScanner);
  notifier.setPortfolioService(portfolio);
  notifier.setDiscovery(discovery);

  notifier.registerCommands(database, pnl, executor, scanner);

  await database.connect();
  await database.migrate();
  await database.releaseOrphanedLeases();
  portfolio.start();
  const storedRiskSettings = await database.getGlobalRiskSettings();
  if (isRiskSettings(storedRiskSettings)) {
    applyRiskSettings(config, storedRiskSettings);
  } else if (storedRiskSettings !== null) {
    log.warn("invalid global risk settings ignored; using ENV defaults");
  }
  await guardian.validateNetworks();
  for (const chain of config.chains) {
    scanner.startCandidateRefresh(chain, [...config.quoteTokens[chain].map(({ address }) => address), zeroAddress], config.poolScanCandidatePages);
  }
  void (async () => {
    try {
      await executor.backfillStaleCloseHistoryUsd();
      await database.backfillPositionGroupHistory();
      const written = await database.backfillSettledPositionHistory();
      log.info({ written }, "settled-position history backfill complete");
    } catch (error) {
      log.warn({ err: error }, "settled-position history backfill failed");
    }
  })();
  log.info({ chains: config.chains, dryRun: config.dryRun }, "UniLP Guardian started");

  let botRunning = false;
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down");
    portfolio.stop();
    if (botRunning) await notifier.stopBot();
    await database.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  botRunning = true;
  await Promise.all([
    guardian.runForever(),
    notifier.startBot(),
  ]);
}

function applyRiskSettings(config: ReturnType<typeof loadConfig>, settings: RiskSettings): void {
  config.stopLossPercent = settings.stopLossPercent;
  config.takeProfitPercent = settings.takeProfitPercent;
  config.trailingStopActivationPercent = settings.trailingStopActivationPercent;
  config.trailingStopDrawdownPercent = settings.trailingStopDrawdownPercent;
  if (settings.bidAskLadderV4MaxOpenGasUsd !== undefined) {
    config.bidAskLadderV4MaxOpenGasUsd = settings.bidAskLadderV4MaxOpenGasUsd;
  }
}

main().catch((error: unknown) => {
  log.fatal({ error: error instanceof Error ? error.message : String(error) }, "UniLP Guardian failed to start");
  process.exit(1);
});
