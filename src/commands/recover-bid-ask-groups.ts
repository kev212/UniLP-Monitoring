import { loadConfig } from "../config.js";
import { Database } from "../db.js";
import { PancakeUniversalRouter } from "../services/pancake-universal-router.js";
import { ChainClients } from "../services/chain-client.js";
import { Executor } from "../services/executor.js";
import { KyberSwapAggregatorApi } from "../services/kyberswap-aggregator-api.js";
import { Notifier } from "../services/notifier.js";
import { PositionReader } from "../services/position-reader.js";
import { RoutePlanner } from "../services/route-planner.js";
import { UniswapTradingApi } from "../services/uniswap-trading-api.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const groupIds = process.argv.slice(2);
  if (groupIds.length === 0 || groupIds.some((id) => !UUID.test(id))) {
    throw new Error("Usage: node dist/commands/recover-bid-ask-groups.js <group-uuid> [...]");
  }

  const config = loadConfig();
  const database = new Database(config.databaseUrl);
  const chains = new ChainClients(config);
  const reader = new PositionReader(chains, config.maxSwapSlippageBps);
  const routes = new RoutePlanner(chains, config.maxSwapSlippageBps, config.quoteTokens);
  const tradingApi = config.uniswapApiKey
    ? new UniswapTradingApi(config.uniswapApiKey, config.maxSwapSlippageBps, globalThis.fetch, config.swapApiTimeoutMs)
    : undefined;
  const kyberswapApi = config.kyberswapEnabled
    ? new KyberSwapAggregatorApi(config.kyberswapClientId, config.settlementSwapSlippageBps, config.swapApiTimeoutMs, config.kyberswapMaxRouteAgeMs)
    : undefined;
  const notifier = new Notifier(config, chains, database);
  const pancakeUr = new PancakeUniversalRouter(chains, routes, config.settlementSwapSlippageBps);
  const executor = new Executor(database, chains, reader, routes, notifier, config, tradingApi, kyberswapApi, pancakeUr);

  await database.connect();
  await database.migrate();
  await database.releaseOrphanedLeases();
  try {
    for (const groupId of groupIds) {
      const group = await database.getPositionGroup(groupId);
      if (!group || group.chainId !== 4663 || group.protocol !== "v4" || group.shape !== "bid_ask" || group.status !== "needs_review") {
        throw new Error(`Group ${groupId} is not a recoverable Robinhood V4 Bid-Ask group`);
      }
      await executor.recoverGroup(group.id);
      const recovered = await database.getPositionGroup(group.id);
      console.log(JSON.stringify({ groupId, status: recovered?.status ?? "missing" }));
    }
  } finally {
    await database.close();
  }
}

void main();
