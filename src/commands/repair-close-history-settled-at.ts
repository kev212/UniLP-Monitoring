import { Pool } from "pg";

import { loadConfig } from "../config.js";
import { ChainClients } from "../services/chain-client.js";
import type { ChainName } from "../types.js";
import type { Hex } from "viem";

const chainNames: Record<number, ChainName> = { 56: "bsc", 4663: "robinhood", 8453: "base" };

interface HistoryRow {
  id: string;
  chain_id: number;
  close_transaction_hash: Hex;
  swap_transaction_hash: Hex | null;
  settled_at: Date;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const chains = new ChainClients(config);
  const rows = await pool.query<HistoryRow>(
    "SELECT id, chain_id, close_transaction_hash, swap_transaction_hash, settled_at FROM close_history WHERE close_transaction_hash IS NOT NULL",
  );
  const timestamps = new Map<string, bigint>();
  let updated = 0;
  let failed = 0;

  for (const row of rows.rows) {
    const chain = chainNames[row.chain_id];
    if (!chain) {
      failed++;
      continue;
    }
    let receipt;
    for (const transactionHash of [row.swap_transaction_hash, row.close_transaction_hash]) {
      if (!transactionHash) continue;
      try {
        receipt = await chains.getForExecution(chain).client.getTransactionReceipt({ hash: transactionHash });
        break;
      } catch {
        // A failed optional swap lookup falls back to the close transaction.
      }
    }
    if (!receipt) {
      failed++;
      continue;
    }
    const key = `${chain}:${receipt.blockNumber}`;
    let timestamp = timestamps.get(key);
    if (timestamp === undefined) {
      timestamp = (await chains.getForExecution(chain).client.getBlock({ blockNumber: receipt.blockNumber })).timestamp;
      timestamps.set(key, timestamp);
    }
    const settledAt = new Date(Number(timestamp) * 1_000);
    if (row.settled_at.getTime() === settledAt.getTime()) continue;
    await pool.query("UPDATE close_history SET settled_at = $2 WHERE id = $1", [row.id, settledAt.toISOString()]);
    updated++;
  }

  await pool.end();
  console.log(JSON.stringify({ rows: rows.rowCount, updated, failed }));
}

void main();
