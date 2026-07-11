import { loadConfig } from "./config.js";
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

async function main(): Promise<void> {
  const config = loadConfig();
  const database = new Database(config.databaseUrl);
  const chains = new ChainClients(config);
  const reader = new PositionReader(chains, config.maxSwapSlippageBps);
  const routes = new RoutePlanner(chains, config.maxSwapSlippageBps, config.quoteTokens);
  const tradingApi = config.uniswapApiKey ? new UniswapTradingApi(config.uniswapApiKey, config.maxSwapSlippageBps) : undefined;
  const notifier = new Notifier(config, chains);
  const discovery = new DiscoveryService(database, chains, config, notifier);
  const alchemyBootstrapper = new AlchemyBootstrapper(database, chains, discovery, config);
  const pnl = new PnlService(database, reader, routes, config, tradingApi);
  const executor = new Executor(database, chains, reader, routes, notifier, config, tradingApi);
  const guardian = new Guardian(config, database, chains, alchemyBootstrapper, discovery, pnl, executor, notifier);

  notifier.registerCommands(database, pnl, executor);

  await database.connect();
  await database.migrate();
  await guardian.validateNetworks();
  log.info({ chains: config.chains, dryRun: config.dryRun, executor: config.executorAddress }, "UniLP Guardian started");

  let botRunning = false;
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down");
    if (botRunning) await notifier.stopBot();
    await database.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await Promise.all([
    guardian.runForever(),
    notifier.startBot().then(() => { botRunning = true; }),
  ]);
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, "UniLP Guardian failed to start");
  process.exit(1);
});
