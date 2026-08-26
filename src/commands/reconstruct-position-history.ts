import { Database } from "../db.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const apply = process.argv.includes("--apply");

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const positionId = process.argv[2];
if (!positionId) throw new Error("usage: reconstruct-position-history <positionId> --close <hash> --swap <hash> --received <wei> [--settled-at <ISO>] [--apply]");
const closeTransactionHash = argValue("--close");
const swapTransactionHash = argValue("--swap");
const received = argValue("--received");
const settledAt = argValue("--settled-at");
if (!closeTransactionHash) throw new Error("--close requires the remove-liquidity transaction hash");
if (!swapTransactionHash) throw new Error("--swap requires the swap transaction hash");
if (!received || !/^\d+$/.test(received)) throw new Error("--received requires the total quote value received (wei)");
if (settledAt && Number.isNaN(Date.parse(settledAt))) throw new Error("--settled-at must be an ISO timestamp");

const database = new Database(databaseUrl);

try {
  await database.connect();
  await database.migrate();
  const position = await database.getPositionById(positionId);
  if (!position) throw new Error(`Position ${positionId} was not found`);
  if (position.status !== "settled") throw new Error(`Position ${positionId} is not settled (status=${position.status})`);
  const totalReceived = BigInt(received);
  const totals = await database.getCashflowTotals(positionId, [closeTransactionHash, swapTransactionHash]);
  const finalPnl = totals.realized + totalReceived - totals.deposits;
  const finalPnlBps = totals.deposits > 0n ? (finalPnl * 10_000n) / totals.deposits : 0n;
  const quoteTokenLower = position.quoteToken?.toLowerCase();
  const isUsdStable = quoteTokenLower === "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
    || quoteTokenLower === "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"
    || quoteTokenLower === "0x55d398326f99059ff775485246999027b3197955";
  const finalPnlUsd = isUsdStable ? finalPnl : 0n;

  console.log(JSON.stringify({
    positionId,
    positionKey: position.positionKey,
    protocol: position.protocol,
    chainId: position.chainId,
    closeTransactionHash,
    swapTransactionHash,
    totalReceived: totalReceived.toString(),
    deposits: totals.deposits.toString(),
    realizedExcludingClose: totals.realized.toString(),
    finalPnl: finalPnl.toString(),
    finalPnlBps: finalPnlBps.toString(),
    finalPnlUsd: finalPnlUsd.toString(),
    settledAt: settledAt ?? null,
  }, null, 2));

  if (!apply) {
    console.log(`dry-run: history row would be written for ${positionId}; rerun with --apply to write`);
  } else {
    await database.setPositionStatus(positionId, "settled", {
      totalReceived: totalReceived.toString(),
      closeTransactionHash,
      swapTransactionHash,
      exitTrigger: "manual",
      closeReceiptAccounted: false,
    });
    await database.recordExecution(positionId, "remove_liquidity", "confirmed", closeTransactionHash);
    await database.recordExecution(positionId, "swap_to_quote", "confirmed", swapTransactionHash);
    const written = await database.finalizeCloseHistory(positionId, "manual");
    if (!written) {
      console.log(`applied: finalizeCloseHistory did not write a row for ${positionId}`);
    } else {
      if (settledAt) {
        const rows = await (database as unknown as { pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ id: string; final_pnl_usd: string }> }> } }).pool.query(
          "SELECT id, final_pnl_usd FROM close_history WHERE position_id = $1",
          [positionId],
        );
        const row = rows.rows[0];
        if (row) await database.updateCloseHistoryUsd(row.id, BigInt(row.final_pnl_usd), new Date(settledAt));
      }
      console.log(`applied: history row written for ${positionId}`);
    }
  }
} finally {
  await database.close();
}
