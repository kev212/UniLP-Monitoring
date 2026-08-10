import { loadConfig } from "../config.js";
import { Database } from "../db.js";
import { log } from "../log.js";
import { BlinkRescueWorker } from "../services/blink-rescue.js";
import { ChainClients } from "../services/chain-client.js";

const config = loadConfig();
const database = new Database(config.databaseUrl);

try {
  await database.connect();
  await database.migrate();
  const chains = new ChainClients(config);
  const { client, registry } = chains.get("robinhood");
  const chainId = await client.getChainId();
  if (chainId !== registry.chain.id) throw new Error(`Robinhood RPC returned chain ID ${chainId}`);
  await new BlinkRescueWorker(database, chains, config).run();
  log.info("BLINK rescue worker is complete or requires review; remaining idle for durable service health");
  while (true) await new Promise((resolve) => setTimeout(resolve, 3_600_000));
} finally {
  await database.close();
}
