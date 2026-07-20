import { describe, expect, it, vi } from "vitest";

import { Database } from "../src/db.js";

describe("Database native USD backfill", () => {
  it("claims settlement only when no active lease or settled status exists", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "position" }] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.claimSettlementLease("position", "worker", 300_000)).resolves.toBe(true);

    expect(query.mock.calls[0]![0]).toContain("status <> 'settled'");
    expect(query.mock.calls[0]![0]).toContain("settlement_lease_until <= NOW()");
    expect(query.mock.calls[0]![1]).toEqual(["position", "worker", 300_000]);
  });

  it("does not regress a settled position to a mutable status", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.setPositionStatusUnlessSettled("position", "closing", { reason: "late worker" })).resolves.toBe(false);

    expect(query.mock.calls[0]![0]).toContain("status <> 'settled'");
  });

  it("renews a settlement lease only while the worker still owns it", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "position" }] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.renewSettlementLease("position", "worker", 300_000)).resolves.toBe(true);

    expect(query.mock.calls[0]![0]).toContain("settlement_lease_token = $2");
    expect(query.mock.calls[0]![0]).toContain("status <> 'settled'");
  });

  it("retries legacy receipt-accounting reviews even before pendingSwap exists", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.listPendingSwapPositions();

    expect(query.mock.calls[0]![0]).toContain("metadata->>'settlementPhase' = 'removing_liquidity'");
  });

  it("excludes swap submissions already recorded as reverted", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.getSubmittedSwapAttempt("position");

    expect(query.mock.calls[0]![0]).toContain("NOT EXISTS");
    expect(query.mock.calls[0]![0]).toContain("terminal.status = 'failed'");
  });

  it("persists signed transaction recovery data and the submitted hash atomically", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "position" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const client = { query };
    vi.spyOn(database, "transaction").mockImplementation(async (work) => work(client as never));

    await database.recordSignedExecution("position", "swap_to_quote", "0xhash", "0xraw", "worker");

    expect(query.mock.calls[0]![0]).toContain("pendingRawTransaction");
    expect(query.mock.calls[1]![0]).toContain("'submitted'");
  });

  it("blocks new account transactions while a signed transaction is unresolved", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ value: 1 }] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.hasPendingRawTransaction(4663)).resolves.toBe(true);

    expect(query.mock.calls[0]![0]).toContain("pendingRawTransaction");
    expect(query.mock.calls[0]![1]).toEqual([4663]);
  });

  it("aggregates calendar days in UTC without a history limit", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rows: [{ date: "2026-07-01", pnl_usd: "1250000", close_count: "2", win_count: "1" }] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.getPnlCalendarMonth(2026, 7)).resolves.toEqual({
      year: 2026,
      month: 7,
      pnlUsd: 1250000n,
      closeCount: 2,
      winCount: 1,
      activeDays: 1,
      days: [{ date: "2026-07-01", pnlUsd: 1250000n, closeCount: 2, winCount: 1 }],
    });
    expect(query.mock.calls[0]![0]).toContain("settled_at AT TIME ZONE 'UTC'");
    expect(query.mock.calls[0]![0]).toContain("ABS(final_pnl_bps) >= 50");
    expect(query.mock.calls[0]![0]).not.toContain("LIMIT");
  });

  it("uses limit and offset for close-history pages", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.listCloseHistoryPage(6, 12);

    expect(query.mock.calls[0]![0]).toContain("LIMIT $1 OFFSET $2");
    expect(query.mock.calls[0]![0]).toContain("ABS(final_pnl_bps) >= 50");
    expect(query.mock.calls[0]![1]).toEqual([6, 12]);
  });

  it("includes accrued snapshot fees in PnL card details", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{
        deposits: "99999999", settlement: "105539126", fees: "0", withdrawals: "0",
        snapshot_realized: "5506579", fee: "31200",
      }],
    });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.getPnlCardDetail("position")).resolves.toEqual({
      depositsQuote: 99999999n,
      settlementQuote: 105539126n,
      feesQuote: 5506579n,
      feePips: 31200,
    });
    expect(query.mock.calls[0]![0]).toContain("snapshot.realized_quote");
  });

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

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not create history from an exit snapshot without a verified settlement total", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ deposits: "1", realized: "0" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: "settled", metadata: { exitSnapshot: { pnlQuote: "999" } } }] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.finalizeCloseHistory("position", "manual");

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("excludes close-transaction cashflows from final settlement PnL", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        chain_id: 4663, protocol: "v4", position_key: "position", status: "settled",
        token0: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", token1: "0xtoken",
        quote_token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        metadata: { totalReceived: "10000", closeTransactionHash: "0xclose" }, opened_at_block: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ stage: "remove_liquidity", transaction_hash: "0xclose" }] })
      .mockResolvedValueOnce({ rows: [{ deposits: "10000", realized: "50" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.finalizeCloseHistory("position", "manual");

    expect(query.mock.calls[2]![0]).toContain("transaction_hash <> ALL");
    expect(query.mock.calls[2]![1]).toEqual(["position", ["0xclose"]]);
    expect(query.mock.calls[3]![1].slice(0, 5)).toEqual(["position", "50", "50", "50", "0xclose"]);
  });

  it("removes stale history for a manual close below the ±0.5% threshold", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        chain_id: 4663, protocol: "v4", position_key: "position", status: "settled",
        token0: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", token1: "0xtoken",
        quote_token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        metadata: { totalReceived: "10000" }, opened_at_block: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ stage: "remove_liquidity", transaction_hash: "0xclose" }] })
      .mockResolvedValueOnce({ rows: [{ deposits: "10000", realized: "0" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.finalizeCloseHistory("position", "manual");

    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[3]![0]).toContain("DELETE FROM close_history");
  });

  it("does not finalize history before the close receipt is confirmed", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        chain_id: 4663, protocol: "v4", position_key: "position", status: "settled",
        token0: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", token1: "0xtoken",
        quote_token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        metadata: { totalReceived: "10000", closeTransactionHash: "0xclose" }, opened_at_block: null,
      }] })
      .mockResolvedValueOnce({ rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.finalizeCloseHistory("position", "manual");

    expect(query).toHaveBeenCalledTimes(2);
  });

  it("removes history when a confirmed swap is missing from the settlement total", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        chain_id: 4663, protocol: "v4", position_key: "position", status: "settled",
        token0: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", token1: "0xtoken",
        quote_token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        metadata: { totalReceived: "10000", settlementQuoteFromClose: "10000" }, opened_at_block: null,
      }] })
      .mockResolvedValueOnce({ rows: [
        { stage: "remove_liquidity", transaction_hash: "0xclose" },
        { stage: "swap_to_quote", transaction_hash: "0xswap" },
      ] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.finalizeCloseHistory("position", "manual");

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]![0]).toContain("DELETE FROM close_history");
  });

  it("does not send a closing position to review from stale burn detection", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.markNeedsReviewIfNoPendingSettlement("position", { reason: "nft_burned_unverified" })).resolves.toBe(false);
    expect(query.mock.calls[0]![0]).toContain("status NOT IN ('closing', 'settled')");
    expect(query.mock.calls[0]![0]).toContain("metadata->'pendingSwap' = 'null'::jsonb");
    expect(query.mock.calls[0]![0]).toContain("execution_attempts.stage = 'remove_liquidity'");
  });

  it("recovers only receipt-backed settlements after liquidity reaches zero", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ trigger: "out_of_range_above" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.recoverVerifiedSettlement("position")).resolves.toBe(true);

    expect(query.mock.calls[0]![0]).toContain("jsonb_typeof(metadata->'totalReceived') = 'string'");
    expect(query.mock.calls[0]![0]).toContain("execution_attempts.status = 'confirmed'");
    expect(query.mock.calls[1]![0]).toContain("SELECT chain_id");
  });
});
