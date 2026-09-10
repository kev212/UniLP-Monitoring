import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { Database } from "../src/db.js";
import { log } from "../src/log.js";
import {
  EvaluationCancelledError,
  evaluationWait,
  runEvaluation,
  type EvaluationContext,
} from "../src/services/evaluation-context.js";
import { isRiskSettings } from "../src/types.js";

function testPoolClient(query: (...args: any[]) => any, release = vi.fn()) {
  return Object.assign(new EventEmitter(), { query, release });
}

function evaluationContext(deadline: number): EvaluationContext {
  return {
    id: "evaluation",
    kind: "position",
    entityId: "position",
    generation: "1",
    deadline,
    signal: new AbortController().signal,
  };
}

describe("Database native USD backfill", () => {
  it("rejects malformed persisted risk settings", () => {
    expect(isRiskSettings({
      stopLossPercent: -24,
      takeProfitPercent: 20,
      trailingStopActivationPercent: 5,
      trailingStopDrawdownPercent: 1.5,
      bidAskLadderV4MaxOpenGasUsd: 2,
    })).toBe(true);
    expect(isRiskSettings({
      stopLossPercent: -24,
      takeProfitPercent: 20,
      trailingStopActivationPercent: 5,
      trailingStopDrawdownPercent: 1.5,
    })).toBe(true);
    expect(isRiskSettings({ stopLossPercent: -24 })).toBe(false);
    expect(isRiskSettings({
      stopLossPercent: 0,
      takeProfitPercent: 20,
      trailingStopActivationPercent: 5,
      trailingStopDrawdownPercent: 1.5,
      bidAskLadderV4MaxOpenGasUsd: 2,
    })).toBe(false);
  });

  it("releases a transaction client and removes its error listener", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = testPoolClient(query);
    Object.defineProperty(database, "pool", { value: { connect: vi.fn().mockResolvedValue(client) } });

    await expect(database.transaction(async () => "result")).resolves.toBe("result");

    expect(client.release).toHaveBeenCalledWith(false);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("releases a checked-out client when listener setup throws", async () => {
    const database = new Database("postgres://unused");
    const client = testPoolClient(vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }));
    vi.spyOn(client, "on").mockImplementation(() => {
      throw new Error("listener setup failed");
    });
    Object.defineProperty(database, "pool", { value: { connect: vi.fn().mockResolvedValue(client) } });

    await expect(database.transaction(async () => "result")).rejects.toThrow("listener setup failed");

    expect(client.release).toHaveBeenCalledWith(false);
  });

  it("destroys a checked-out client when its connection fails", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = testPoolClient(query);
    Object.defineProperty(database, "pool", { value: { connect: vi.fn().mockResolvedValue(client) } });
    const connectionError = new Error("connection reset");

    const outcome = database.transaction(async () => {
      client.emit("error", connectionError);
      await new Promise(() => {});
    });

    await expect(outcome).rejects.toBe(connectionError);
    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(false);
    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("releases exactly once when pool.connect resolves after an evaluation timeout", async () => {
    const database = new Database("postgres://unused");
    let resolveConnect!: (client: ReturnType<typeof testPoolClient>) => void;
    const connect = vi.fn(() => new Promise<ReturnType<typeof testPoolClient>>((resolve) => {
      resolveConnect = resolve;
    }));
    Object.defineProperty(database, "pool", { value: { connect } });
    const context = evaluationContext(Date.now() + 20);

    const outcome = runEvaluation(context, () => database.transaction(async () => undefined)).catch((error) => error);
    await expect(outcome).resolves.toBeInstanceOf(EvaluationCancelledError);

    const client = testPoolClient(vi.fn());
    resolveConnect(client);
    await vi.waitFor(() => expect(client.release).toHaveBeenCalledTimes(1));
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("destroys the client without rollback when COMMIT exceeds the evaluation deadline", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT evaluation_generation")) {
        return { rowCount: 1, rows: [{ evaluation_generation: "1", evaluation_valid: true }] };
      }
      if (sql.includes("clock_timestamp()")) return { rowCount: 1, rows: [{ valid: true }] };
      if (sql === "COMMIT") return new Promise(() => {});
      return { rowCount: 1, rows: [] };
    });
    const client = testPoolClient(query);
    Object.defineProperty(database, "pool", { value: { connect: vi.fn().mockResolvedValue(client) } });
    const context = evaluationContext(Date.now() + 100);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const outcome = await runEvaluation(context, () => database.transaction(async () => "result")).catch((error) => error);

    expect(outcome).toBeInstanceOf(EvaluationCancelledError);
    expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(false);
    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.listenerCount("error")).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(EvaluationCancelledError) }),
      expect.stringContaining("uncertain"),
    );
    warn.mockRestore();
  });

  it("rejects late application queries after timeout and destroys the client", async () => {
    const database = new Database("postgres://unused");
    const lateSql = "INSERT INTO guarded_late_query (value) VALUES (1)";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT evaluation_generation")) {
        return { rowCount: 1, rows: [{ evaluation_generation: "1", evaluation_valid: true }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const client = testPoolClient(query);
    Object.defineProperty(database, "pool", { value: { connect: vi.fn().mockResolvedValue(client) } });
    const context = evaluationContext(Date.now() + 30);
    let resume!: () => void;
    const delayed = new Promise<void>((resolve) => { resume = resolve; });
    let lateError: unknown;

    const transaction = runEvaluation(context, () => database.transaction(async (guardedClient) => {
      await delayed;
      try {
        await guardedClient.query(lateSql);
      } catch (error) {
        lateError = error;
        throw error;
      }
    }));
    const outcome = transaction.catch((error) => error);

    await expect(evaluationWait(transaction, context)).rejects.toBeInstanceOf(EvaluationCancelledError);
    resume();

    await expect(outcome).resolves.toBeInstanceOf(EvaluationCancelledError);
    expect(lateError).toBeInstanceOf(EvaluationCancelledError);
    expect(query.mock.calls.some(([sql]) => sql === lateSql)).toBe(false);
    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("destroys a client when BEGIN never resolves without an evaluation context", async () => {
    vi.useFakeTimers();
    try {
      const database = new Database("postgres://unused");
      const query = vi.fn((sql: string) => sql === "BEGIN"
        ? new Promise(() => {})
        : Promise.resolve({ rowCount: 1, rows: [] }));
      const client = testPoolClient(query);
      Object.defineProperty(database, "pool", { value: { connect: vi.fn().mockResolvedValue(client) } });

      const outcome = database.transaction(async () => "unreachable").catch((error) => error);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(outcome).resolves.toMatchObject({
        name: "DatabaseControlTimeoutError",
        message: "postgres BEGIN timed out",
      });
      expect(client.release).toHaveBeenCalledWith(true);
      expect(client.listenerCount("error")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists one global risk-settings override", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });
    const settings = {
      stopLossPercent: -24,
      takeProfitPercent: 20,
      trailingStopActivationPercent: 5,
      trailingStopDrawdownPercent: 1.5,
    };

    await database.setGlobalRiskSettings(settings);
    await database.clearGlobalRiskSettings();

    expect(query.mock.calls[0]![0]).toContain("INSERT INTO global_risk_settings");
    expect(query.mock.calls[0]![1]).toEqual([JSON.stringify(settings)]);
    expect(query.mock.calls[1]![0]).toContain("DELETE FROM global_risk_settings");
  });

  it("upserts positions against the production dex composite key", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: "position",
        chain_id: 4663,
        protocol: "v4",
        position_key: "437787",
        owner: "0x0000000000000000000000000000000000000001",
        pool_address: null,
        token0: "0x0000000000000000000000000000000000000002",
        token1: "0x0000000000000000000000000000000000000003",
        quote_token: "0x0000000000000000000000000000000000000003",
        status: "syncing",
        liquidity: "1",
        opened_at_block: "100",
        metadata: { dex: "uniswap" },
      }],
    });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.upsertPosition({
      chainId: 4663,
      protocol: "v4",
      positionKey: "437787",
      owner: "0x0000000000000000000000000000000000000001",
      poolAddress: null,
      token0: "0x0000000000000000000000000000000000000002",
      token1: "0x0000000000000000000000000000000000000003",
      quoteToken: "0x0000000000000000000000000000000000000003",
      status: "syncing",
      liquidity: 1n,
      openedAtBlock: 100n,
      metadata: { dex: "uniswap" },
    });

    expect(query.mock.calls[0]![0]).toContain("INSERT INTO positions");
    expect(query.mock.calls[0]![0]).toContain("ON CONFLICT (chain_id, protocol, dex, position_key)");
    expect(query.mock.calls[0]![1]).toHaveLength(13);
    expect(query.mock.calls[0]![1]![12]).toBe("uniswap");
  });

  it("loads a position by its durable ID", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: "position",
        chain_id: 4663,
        protocol: "v4",
        position_key: "437787",
        owner: "0x0000000000000000000000000000000000000001",
        pool_address: null,
        token0: "0x0000000000000000000000000000000000000002",
        token1: "0x0000000000000000000000000000000000000003",
        quote_token: "0x0000000000000000000000000000000000000003",
        status: "minted",
        liquidity: "9",
        opened_at_block: "100",
        metadata: { positionGroupId: "group" },
      }],
    });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.getPositionById("position")).resolves.toMatchObject({
      id: "position",
      liquidity: 9n,
      openedAtBlock: 100n,
      metadata: { positionGroupId: "group" },
    });
    expect(query.mock.calls[0]![1]).toEqual(["position"]);
  });

  it("persists a durable token rescue job with bigint NFT IDs", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: "token-rescue",
        chain_id: 4663,
        token_address: "0x0000000000000000000000000000000000000001",
        quote_token: "0x0000000000000000000000000000000000000002",
        position_manager: "0x0000000000000000000000000000000000000003",
        token_ids: ["1", "2"],
        status: "polling",
        pending_raw_transaction: null,
        metadata: {},
        last_error: null,
      }],
    });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.getOrCreateTokenRescueJob({
      id: "token-rescue",
      chainId: 4663,
      tokenAddress: "0x0000000000000000000000000000000000000001",
      quoteToken: "0x0000000000000000000000000000000000000002",
      positionManager: "0x0000000000000000000000000000000000000003",
      tokenIds: [1n, 2n],
    })).resolves.toMatchObject({ tokenIds: [1n, 2n], status: "polling" });
    expect(query.mock.calls[0]![0]).toContain("INSERT INTO token_rescue_jobs");
    expect(query.mock.calls[0]![1]![5]).toBe('["1","2"]');
  });

  it("merges group status metadata and clears a pending signed transaction when requested", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ updated: true }] });
    Object.defineProperty(database, "pool", { value: { query } });
    const metadata = { pendingRawTransaction: null, settlementPhase: "accounting" };

    await expect(database.setPositionGroupStatus("group", "settling", metadata)).resolves.toBe(true);

    expect(query.mock.calls[0]![0]).toContain("metadata = metadata || $3::jsonb");
    expect(query.mock.calls[0]![0]).toContain("pending_raw_transaction = CASE");
    expect(query.mock.calls[0]![0]).toContain("AND NOT (status IN ('settled', 'cancelled') AND $2::text NOT IN ('settled', 'cancelled'))");
    expect(query.mock.calls[0]![0]).toContain("AND ($4::text IS NULL OR status = $4::text)");
    expect(query.mock.calls[0]![1]).toEqual(["group", "settling", JSON.stringify(metadata), null]);
  });

  it("atomically rejects a stale group update after its status changed", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ updated: false }] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.setPositionGroupStatus("group", "active", { slTwapWaitStartedAt: 123 }, "active")).resolves.toBe(false);

    expect(query.mock.calls[0]![1]).toEqual([
      "group",
      "active",
      JSON.stringify({ slTwapWaitStartedAt: 123 }),
      "active",
    ]);
  });

  it("keeps group finalization numeric parameters consistently typed", async () => {
    const database = new Database("postgres://unused");
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "group" }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "history" }] })
      .mockResolvedValueOnce({});
    const connect = vi.fn().mockResolvedValue(testPoolClient(clientQuery));
    Object.defineProperty(database, "pool", { value: { connect } });

    await expect(database.finalizePositionGroup("group", "0xclose", 100n, 2n, 200n, "manual", 123n)).resolves.toBe(true);

    const parentQuery = clientQuery.mock.calls[1]![0] as string;
    expect(parentQuery).toContain("total_received_quote = $3::numeric");
    expect(parentQuery).toContain("'totalReceivedQuote', ($3::numeric)::text");
    expect(parentQuery).toContain("'finalPnlQuote', ($4::numeric)::text");
    expect(parentQuery).toContain("'finalPnlBps', ($5::numeric)::text");
    expect(parentQuery).toContain("final_pnl_usd = $7::numeric");
    expect(parentQuery).toContain("'finalPnlUsd', ($7::numeric)::text");
    expect(clientQuery.mock.calls[1]![1]).toEqual(["group", "0xclose", "100", "2", "200", "manual", "123"]);
    expect(clientQuery.mock.calls[4]![0]).toContain("INSERT INTO close_history");
    expect(clientQuery.mock.calls[4]![0]).toContain("position_group_id");
  });

  it("renews a group lease only while its token owns the parent", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "group" }] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.renewPositionGroupLease("group", "worker", 45_000)).resolves.toBe(true);

    expect(query.mock.calls[0]![0]).toContain("execution_lease_token = $2");
    expect(query.mock.calls[0]![0]).toContain("status NOT IN ('settled', 'cancelled')");
    expect(query.mock.calls[0]![1]).toEqual(["group", "worker", 45_000]);
  });

  it("updates only the supplied group-bin receipt fields", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "bin" }] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.updatePositionGroupBin("group", 2, {
      tokenId: 77n,
      positionId: "position",
      status: "minted",
      openTransactionHash: "0xopen",
      closeTransactionHash: null,
      openingAmount0: 11n,
      openingAmount1: 12n,
      closeAmount0: 13n,
      closeAmount1: 14n,
      settlementQuote: 15n,
    })).resolves.toBe(true);

    expect(query.mock.calls[0]![0]).toContain("token_id = $3");
    expect(query.mock.calls[0]![0]).toContain("opening_amount0 = $8");
    expect(query.mock.calls[0]![0]).toContain("settlement_quote = $12");
    expect(query.mock.calls[0]![1]).toEqual(["group", 2, "77", "position", "minted", "0xopen", null, "11", "12", "13", "14", "15"]);
  });

  it("links an open receipt to the parent and bins in one idempotent transaction", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "group" }] })
      .mockResolvedValueOnce({ rowCount: 2, rows: [] });
    const client = { query };
    vi.spyOn(database, "transaction").mockImplementation(async (work) => work(client as never));

    await expect(database.setPositionGroupOpenTransaction("group", "0xopen", "active")).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![0]).toContain("open_transaction_hash = CASE");
    expect(query.mock.calls[0]![1]).toEqual(["group", "0xopen", "active", "{}"]);
    expect(query.mock.calls[1]![0]).toContain("UPDATE position_group_bins");
    expect(query.mock.calls[1]![1]).toEqual(["group", "0xopen"]);
  });

  it("does not link a bin to an already-linked position or token", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.linkPositionGroupBinPosition("group", 2, "position", 77n)).resolves.toBe(false);

    expect(query.mock.calls[0]![0]).toContain("NOT EXISTS");
    expect(query.mock.calls[0]![0]).toContain("conflicting.token_id = $4::numeric");
  });

  it("loads the global risk-settings override when present", async () => {
    const database = new Database("postgres://unused");
    const settings = {
      stopLossPercent: -24,
      takeProfitPercent: 20,
      trailingStopActivationPercent: 5,
      trailingStopDrawdownPercent: 1.5,
    };
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ settings }] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.getGlobalRiskSettings()).resolves.toEqual(settings);
    expect(query.mock.calls[0]![0]).toContain("SELECT settings FROM global_risk_settings");
  });

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

  it("serializes bigint values in standalone position metadata", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "position" }] });
    Object.defineProperty(database, "pool", { value: { query } });

    const metadata = {
      trailingStopExpected: { peakPnlBps: 4_610n, activatedAtBlock: 50_847_048n },
    };
    await expect(database.setPositionStatus("position", "armed", metadata)).resolves.toBe(true);
    await expect(database.setPositionStatusUnlessSettled("position", "closing", metadata)).resolves.toBe(true);

    const serialized = '{"trailingStopExpected":{"peakPnlBps":"4610","activatedAtBlock":"50847048"}}';
    expect(query.mock.calls[0]![1]).toEqual(["position", "armed", serialized, null]);
    expect(query.mock.calls[1]![1]).toEqual(["position", "closing", serialized]);
  });

  it("atomically checks expected status and blocks stale position revivals", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "position" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.setPositionStatus("position", "settled", { reason: "complete" }, "closing")).resolves.toBe(true);
    await expect(database.setPositionStatus("position", "armed", undefined, "closing")).resolves.toBe(false);

    const sql = query.mock.calls[0]![0] as string;
    expect(sql).toContain("NOT (status = 'settled' AND $2::text <> 'settled')");
    expect(sql).toContain("NOT (status = 'cancelled' AND $2::text <> 'cancelled')");
    expect(sql).toContain("NOT (status = 'closing' AND $2::text IN ('discovered', 'syncing', 'armed'))");
    expect(sql).toContain("AND ($4::text IS NULL OR status = $4::text)");
    expect(query.mock.calls[0]![1]).toEqual([
      "position",
      "settled",
      JSON.stringify({ reason: "complete" }),
      "closing",
    ]);
    expect(query.mock.calls[1]![1]).toEqual(["position", "armed", "{}", "closing"]);
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

  it("excludes swap submissions already recorded as reverted or confirmed", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.getSubmittedSwapAttempt("position");

    expect(query.mock.calls[0]![0]).toContain("NOT EXISTS");
    expect(query.mock.calls[0]![0]).toContain("terminal.status IN ('failed', 'confirmed')");
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

  it("clears orphaned settlement and group execution leases on startup", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.releaseOrphanedLeases();

    expect(query.mock.calls[0]![0]).toContain("settlement_lease_token = NULL");
    expect(query.mock.calls[1]![0]).toContain("execution_lease_token = NULL");
  });

  it("blocks new account transactions while a signed transaction is unresolved", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ value: 1 }] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.hasPendingRawTransaction(4663)).resolves.toBe(true);

    expect(query.mock.calls[0]![0]).toContain("pendingRawTransaction");
    expect(query.mock.calls[0]![0]).toContain("settlementRetryDisabled");
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
    expect(query.mock.calls[0]![0]).toContain("ABS(final_pnl_usd) >= 500000");
    expect(query.mock.calls[0]![0]).not.toContain("LIMIT");
  });

  it("uses limit and offset for close-history pages", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({ rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.listCloseHistoryPage(6, 12);

    expect(query.mock.calls[0]![0]).toContain("LIMIT $1 OFFSET $2");
    expect(query.mock.calls[0]![0]).toContain("ABS(final_pnl_usd) >= 500000");
    expect(query.mock.calls[0]![1]).toEqual([6, 12]);
  });

  it("maps parent-level Bid-Ask history without a child position", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: "history",
        position_id: null,
        position_group_id: "group",
        chain_id: 4663,
        protocol: "v4",
        position_key: "group",
        token0: "0x0000000000000000000000000000000000000001",
        token1: "0x0000000000000000000000000000000000000002",
        quote_token: "0x0000000000000000000000000000000000000002",
        final_pnl_bps: "228",
        final_pnl_quote: "4562148",
        final_pnl_usd: "4562148",
        trigger: "manual",
        close_transaction_hash: "0xclose",
        swap_transaction_hash: "0xswap",
        settled_at: "2026-08-08T02:58:45.195Z",
        opened_at_block: "100",
      }],
    });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.listCloseHistoryPage(20, 0)).resolves.toMatchObject([{
      positionId: null,
      positionGroupId: "group",
      positionKey: "group",
      finalPnlBps: 228n,
    }]);
  });

  it("selects only settled Bid-Ask groups missing threshold history", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({
      rows: [{ id: "group", chain_id: 4663, protocol: "v4", final_pnl_bps: "50", settled_at: "2026-08-08T00:00:00Z" }],
    });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.listPositionGroupHistoryBackfillCandidates("group")).resolves.toEqual([{
      id: "group",
      chainId: 4663,
      protocol: "v4",
      finalPnlBps: 50n,
      settledAt: new Date("2026-08-08T00:00:00Z"),
    }]);
    expect(query.mock.calls[0]![0]).toContain("COALESCE(g.final_pnl_usd, CASE WHEN LOWER(g.quote_token) IN");
    expect(query.mock.calls[0]![0]).toContain("h.position_group_id = g.id");
    expect(query.mock.calls[0]![1]).toEqual(["500000", "50", "group", 1_000]);
  });

  it("backfills group history atomically and idempotently by group ID", async () => {
    const database = new Database("postgres://unused");
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: "group" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "history" }] })
      .mockResolvedValueOnce({});
    const connect = vi.fn().mockResolvedValue(testPoolClient(clientQuery));
    Object.defineProperty(database, "pool", { value: { connect } });

    await expect(database.backfillPositionGroupHistory(["group"])).resolves.toBe(1);
    expect(clientQuery.mock.calls[2]![0]).toContain("ON CONFLICT (position_group_id)");
    expect(clientQuery.mock.calls[2]![1]).toEqual(["group", "500000"]);
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

  it("loads parent-level Bid-Ask PnL card details from group accounting", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{
        deposits: "125000000000000000",
        deployed_cost_quote: "125000000000000000",
        settlement: "135288195878780614",
        fees: "10312489586487282",
        fee: "50000",
      }],
    });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.getPositionGroupPnlCardDetail("group")).resolves.toEqual({
      depositsQuote: 125000000000000000n,
      settlementQuote: 135288195878780614n,
      feesQuote: 10312489586487282n,
      feePips: 50000,
    });
    expect(query.mock.calls[0]![0]).toContain("position_group_cashflows");
    expect(query.mock.calls[0]![0]).toContain("position_group_pnl_snapshots");
    expect(query.mock.calls[0]![0]).toContain("g.total_received_quote");
    expect(query.mock.calls[0]![1]).toEqual(["group"]);
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
      positionGroupId: null,
      chainId: 4663,
      positionKey: "101616",
      finalPnlQuote: "1",
      quoteToken: "0x0000000000000000000000000000000000000000",
      isNativeQuote: true,
      closeTransactionHash: "0xclose",
      swapTransactionHash: "0xswap",
    }]);
    expect(query.mock.calls[0]![0]).toContain("NULLIF(p.metadata->>'swapTransactionHash', '')");
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

  it("removes manually excluded settlement history instead of recreating it", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        chain_id: 4663, protocol: "v4", position_key: "position", status: "settled",
        token0: "0xtoken0", token1: "0xtoken1", quote_token: "0xquote",
        metadata: { historyExcluded: true }, opened_at_block: null, updated_at: "2026-08-12T00:00:00Z",
      }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.finalizeCloseHistory("position", "manual")).resolves.toBe(false);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]).toEqual(["DELETE FROM close_history WHERE position_id = $1", ["position"]]);
  });

  it("excludes close-transaction cashflows from final settlement PnL", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        chain_id: 4663, protocol: "v4", position_key: "position", status: "settled",
        token0: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", token1: "0xtoken",
        quote_token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        metadata: { totalReceived: "1600000", closeTransactionHash: "0xclose" }, opened_at_block: null,
        updated_at: "2026-08-12T06:27:42Z",
      }] })
      .mockResolvedValueOnce({ rows: [{ stage: "remove_liquidity", transaction_hash: "0xclose" }] })
      .mockResolvedValueOnce({ rows: [{ deposits: "1000000", realized: "50000" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.finalizeCloseHistory("position", "manual");

    expect(query.mock.calls[2]![0]).toContain("transaction_hash <> ALL");
    expect(query.mock.calls[2]![1]).toEqual(["position", ["0xclose"]]);
    expect(query.mock.calls[3]![0]).toContain("$4::numeric = 0 AND close_history.final_pnl_usd <> 0");
    expect(query.mock.calls[3]![0]).toContain("settled_at = COALESCE(settled_at, $8)");
    expect(query.mock.calls[3]![1].slice(0, 5)).toEqual(["position", "6500", "650000", "650000", "0xclose"]);
    expect(query.mock.calls[3]![1][7]).toEqual("2026-08-12T06:27:42Z");
  });

  it("removes stale history for a manual close below the ±$0.50 threshold", async () => {
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

  it("finalizes history from the metadata close hash when execution attempts are missing", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        chain_id: 4663, protocol: "v4", position_key: "position", status: "settled",
        token0: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", token1: "0xtoken",
        quote_token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        metadata: { totalReceived: "1600000", closeTransactionHash: "0xclose" }, opened_at_block: null,
        updated_at: "2026-08-12T06:27:42Z",
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ deposits: "1000000", realized: "50000" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await database.finalizeCloseHistory("position", "manual");

    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[3]![1].slice(0, 5)).toEqual(["position", "6500", "650000", "650000", "0xclose"]);
    expect(query.mock.calls[4]![0]).toContain("INSERT INTO close_history");
    expect(query.mock.calls[4]![1].slice(11, 15)).toEqual([
      "0xclose", null, "2026-08-12T06:27:42Z", null,
    ]);
  });

  it("finalizes history from the metadata swap hash when the confirmed attempt is missing", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        chain_id: 4663, protocol: "v4", position_key: "872988", status: "settled",
        token0: "0xtoken", token1: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        quote_token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        metadata: {
          totalReceived: "811163424",
          settlementQuoteFromClose: "1776326",
          closeTransactionHash: "0xclose",
          swapTransactionHash: "0xswap",
        },
        opened_at_block: "45030148",
        updated_at: "2026-08-25T00:41:29Z",
      }] })
      .mockResolvedValueOnce({ rows: [{ stage: "remove_liquidity", transaction_hash: "0xclose" }] })
      .mockResolvedValueOnce({ rows: [{ deposits: "807975499", realized: "0" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.finalizeCloseHistory("position", "manual")).resolves.toBe(true);

    expect(query.mock.calls[2]![1]).toEqual(["position", ["0xclose", "0xswap"]]);
    expect(query.mock.calls[3]![1].slice(0, 7)).toEqual([
      "position", "39", "3187925", "3187925", "0xclose", "0xswap", "45030148",
    ]);
  });

  it("rejects conflicting confirmed and metadata settlement swap hashes", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        chain_id: 4663, protocol: "v4", position_key: "position", status: "settled",
        token0: "0xtoken", token1: "0xquote", quote_token: "0xquote",
        metadata: { totalReceived: "20", closeTransactionHash: "0xclose", swapTransactionHash: "0xmetadata" },
        opened_at_block: null, updated_at: "2026-08-25T00:41:29Z",
      }] })
      .mockResolvedValueOnce({ rows: [
        { stage: "remove_liquidity", transaction_hash: "0xclose" },
        { stage: "swap_to_quote", transaction_hash: "0xattempt" },
      ] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.finalizeCloseHistory("position", "manual")).resolves.toBe(false);
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

  it("settles unverified zero-liquidity without writing close history", async () => {
    const database = new Database("postgres://unused");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "position" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    Object.defineProperty(database, "pool", { value: { query } });

    await expect(database.settleUnverifiedZeroLiquidity("position", "externally_closed")).resolves.toBe(true);
    expect(query.mock.calls[0]![0]).toContain("status = 'settled'");
    expect(query.mock.calls[0]![0]).toContain("status NOT IN ('closing', 'settled')");
    expect(query.mock.calls[1]![0]).toContain("DELETE FROM close_history");
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
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      if (sql.includes("UPDATE positions")) {
        return { rowCount: 1, rows: [{ trigger: "out_of_range_above" }] };
      }
      if (sql.includes("SELECT chain_id")) {
        return {
          rowCount: 1,
          rows: [{
            chain_id: 4663,
            protocol: "v4",
            position_key: "position",
            status: "settled",
            token0: "0xtoken0",
            token1: "0xtoken1",
            quote_token: "0xquote",
            metadata: { totalReceived: "20", closeTransactionHash: "0xclose" },
            opened_at_block: null,
            updated_at: "2026-08-12T00:00:00Z",
          }],
        };
      }
      if (sql.includes("FROM execution_attempts")) {
        return { rowCount: 1, rows: [{ stage: "remove_liquidity", transaction_hash: "0xclose" }] };
      }
      if (sql.includes("FROM cashflows")) {
        return { rowCount: 1, rows: [{ deposits: "10", realized: "0" }] };
      }
      if (sql.includes("UPDATE close_history")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = testPoolClient(query);
    Object.defineProperty(database, "pool", { value: { connect: vi.fn().mockResolvedValue(client) } });

    await expect(database.recoverVerifiedSettlement("position")).resolves.toBe(true);

    const sql = query.mock.calls.map(([statement]) => statement);
    const recoveryUpdate = sql.find((statement) => statement.includes("UPDATE positions"));
    expect(recoveryUpdate).toContain("jsonb_typeof(metadata->'totalReceived') = 'string'");
    expect(recoveryUpdate).toContain("execution_attempts.status = 'confirmed'");
    expect(sql.some((statement) => statement.includes("SELECT chain_id"))).toBe(true);
    expect(sql.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledWith(false);
  });
});

describe('persistent market discovery', () => {
  it('upserts one page and advances its cursor in the same transaction without clearing live candidates', async () => {
    const database = new Database('postgres://unused');
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const client = testPoolClient(query);
    Object.defineProperty(database, 'pool', { value: { connect: vi.fn(async () => client) } });
    await database.saveMarketDiscoveryPage('robinhood', 'new_pools?page=1', 1,
      [{tokenAddress:'0xABC', seedScore:0}], [{poolId:'0xDEF', tvlUsd:6000}]);
    const sql = query.mock.calls.map(call => String(call[0]));
    expect(sql[0]).toBe('BEGIN');
    expect(sql.at(-1)).toBe('COMMIT');
    expect(sql.some(text => text.includes('ON CONFLICT (chain, token_address) DO UPDATE'))).toBe(true);
    expect(sql.some(text => text.includes('pool_scan_discovery_state') && text.includes('next_cursor'))).toBe(true);
    const deletes = sql.filter(text => text.startsWith('DELETE FROM pool_scan_candidates'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain("INTERVAL '7 days'");
    expect(deletes[0]).toContain('last_active_at');
    expect(query.mock.calls.some(call => JSON.stringify(call[1]) === JSON.stringify(['robinhood','0xabc',0,'new_pools?page=1']))).toBe(true);
  });

  it('rolls back page and cursor together if persistence fails', async () => {
    const database = new Database('postgres://unused');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO pool_scan_tvl_snapshots')) throw new Error('storage failed');
      return { rows: [], rowCount: 1 };
    });
    Object.defineProperty(database, 'pool', { value: { connect: vi.fn(async () => testPoolClient(query)) } });
    await expect(database.saveMarketDiscoveryPage('robinhood','page',1,[],[{poolId:'0xabc',tvlUsd:5}])).rejects.toThrow('storage failed');
    expect(query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO pool_scan_discovery_state'))).toBe(false);
  });

  it('loads all retained candidates with timestamps, without a top-20 limit', async () => {
    const database = new Database('postgres://unused');
    const query = vi.fn(async () => ({rowCount:1, rows:[{token_address:'0xabc',seed_score:2,updated_at:'2026-09-08T00:00:00Z',last_evaluated_at:null,sources:['page'] }]}));
    Object.defineProperty(database,'pool',{value:{query}});
    const rows=await database.listRetainedMarketCandidates('robinhood');
    expect(rows[0]).toMatchObject({tokenAddress:'0xabc',lastEvaluatedAt:null,sources:['page']});
    const config=query.mock.calls[0]![0] as any;
    expect(config.text).not.toContain('LIMIT');
    expect(config.text).toContain("INTERVAL '7 days'");
    expect(config.values).toEqual(['robinhood']);
  });
});
