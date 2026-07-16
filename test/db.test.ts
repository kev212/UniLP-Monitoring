import { describe, expect, it, vi } from "vitest";

import { Database } from "../src/db.js";

describe("Database native USD backfill", () => {
  it("uses close-history transaction hashes when position metadata has none", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: "history",
        chain_id: 4663,
        position_key: "101616",
        final_pnl_quote: "1",
        quote_token: "0x0000000000000000000000000000000000000000",
        close_transaction_hash: "0xclose",
        swap_transaction_hash: "0xswap",
      }],
    });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.listStaleCloseHistoryUsd()).resolves.toEqual([{
      id: "history",
      chainId: 4663,
      positionKey: "101616",
      finalPnlQuote: "1",
      quoteToken: "0x0000000000000000000000000000000000000000",
      isNativeQuote: true,
      closeTransactionHash: "0xclose",
      swapTransactionHash: "0xswap",
    }]);
    expect(query.mock.calls[0]![0]).toContain("COALESCE(NULLIF(p.metadata->>'swapTransactionHash', ''), h.swap_transaction_hash)");
  });

  it("does not finalize close history while settlement is still closing", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ deposits: "1", realized: "0" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: "closing" }] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.finalizeCloseHistory("position", "manual");

    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not create history from an exit snapshot without a verified settlement total", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ deposits: "1", realized: "0" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: "settled", metadata: { exitSnapshot: { pnlQuote: "999" } } }] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.finalizeCloseHistory("position", "manual");

    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not send a closing position to review from stale burn detection", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.markNeedsReviewIfNoPendingSettlement("position", { reason: "nft_burned_unverified" })).resolves.toBe(false);
    expect(query.mock.calls[0]![0]).toContain("status NOT IN ('closing', 'settled')");
    expect(query.mock.calls[0]![0]).toContain("metadata->'pendingSwap' = 'null'::jsonb");
  });
});
