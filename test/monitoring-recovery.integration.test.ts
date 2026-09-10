import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Database } from "../src/db.js";
import {
  EvaluationCancelledError,
  evaluationWait,
  runEvaluation,
  type EvaluationContext,
} from "../src/services/evaluation-context.js";
import type { PositionGroupPnlSnapshot } from "../src/types.js";

const connectionString = process.env.MONITORING_TEST_DATABASE_URL;
if (connectionString) {
  const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  if (databaseName !== "unilp_monitoring_test") {
    throw new Error(`Refusing monitoring integration tests against database ${databaseName}; expected unilp_monitoring_test`);
  }
}

const integration = connectionString ? describe : describe.skip;

integration("monitoring recovery generation fencing (PostgreSQL)", () => {
  let database: Database;
  let pool: Pool;
  let groupId: string;
  let positionId: string;

  const context = (kind: "position" | "group", entityId: string, generation: string, deadline = Date.now() + 30_000): EvaluationContext => ({
    id: randomUUID(),
    kind,
    entityId,
    generation,
    deadline,
    signal: new AbortController().signal,
  });

  const snapshot = (blockNumber: bigint, pnlQuote: bigint): PositionGroupPnlSnapshot => ({
    groupId,
    quoteToken: "0x0000000000000000000000000000000000000003",
    depositsQuote: 1_000n,
    realizedQuote: 0n,
    liquidationQuote: 1_000n + pnlQuote,
    feeQuote: 0n,
    feeQuoteUsdg: 0n,
    pnlQuote,
    pnlBps: pnlQuote,
    blockNumber,
    groupGasQuote: 0n,
    rangeCurrentTick: null,
    rangeCurrentSqrtPrice: null,
  });

  beforeAll(async () => {
    if (!connectionString) return;
    pool = new Pool({ connectionString, max: 8 });
    database = new Database(connectionString);
    await database.migrate();

    groupId = randomUUID();
    positionId = randomUUID();
    await pool.query(
      `INSERT INTO position_groups (
         id, chain_id, protocol, position_manager, pool_key, owner, token0, token1, quote_token,
         shape, shape_version, requested_bin_count, generated_bin_count, mintable_bin_count,
         outer_tick_lower, outer_tick_upper, anchor_bin_index, total_deposit, deployed_cost_quote,
         direct_close_amount0, direct_close_amount1, status, plan_hash, plan_json
       ) VALUES ($1, 1, 'v4', $2, $3, $4, $5, $6, $7, 'bid_ask', 'delta-amount-linear-v1',
                 1, 1, 1, -10, 10, 0, 1000, 0, 0, 0, 'active', $8, '{}'::jsonb)`,
      [
        groupId,
        "0x0000000000000000000000000000000000000010",
        `test-pool-${groupId}`,
        "0x0000000000000000000000000000000000000011",
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000003",
        `test-plan-${groupId}`,
      ],
    );
    await pool.query(
      `INSERT INTO positions (
         id, chain_id, protocol, position_key, owner, token0, token1, quote_token,
         status, liquidity, metadata
       ) VALUES ($1, 1, 'v4', $2, $3, $4, $5, $6, 'armed', 1, '{}'::jsonb)`,
      [
        positionId,
        `test-position-${positionId}`,
        "0x0000000000000000000000000000000000000011",
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000003",
      ],
    );
  });

  beforeEach(async () => {
    if (!connectionString) return;
    await pool.query("DELETE FROM close_history WHERE position_id = $1", [positionId]);
    await pool.query("DELETE FROM cashflows WHERE position_id = $1", [positionId]);
    await pool.query("DELETE FROM execution_attempts WHERE position_id = $1", [positionId]);
    await pool.query("DELETE FROM position_group_pnl_snapshots WHERE group_id = $1", [groupId]);
    await pool.query("UPDATE position_groups SET status = 'active', evaluation_generation = 0, evaluation_deadline = NULL, metadata = '{}'::jsonb WHERE id = $1", [groupId]);
    await pool.query("UPDATE positions SET status = 'armed', evaluation_generation = 0, evaluation_deadline = NULL, metadata = '{}'::jsonb WHERE id = $1", [positionId]);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await pool.query("DELETE FROM position_groups WHERE id = $1", [groupId]);
    await pool.query("DELETE FROM positions WHERE id = $1", [positionId]);
    await database.close();
    await pool.end();
  });

  it("increments independent position and group generations", async () => {
    const positionGeneration = await database.beginEvaluation("position", positionId, Date.now() + 30_000);
    const groupGeneration = await database.beginEvaluation("group", groupId, Date.now() + 30_000);

    expect(positionGeneration).toBe("1");
    expect(groupGeneration).toBe("1");
  });

  it("rejects stale metadata writes and accepts a fresh same-block write", async () => {
    const staleGeneration = await database.beginEvaluation("group", groupId, Date.now() + 30_000);
    const freshGeneration = await database.beginEvaluation("group", groupId, Date.now() + 30_000);

    await expect(runEvaluation(
      context("group", groupId, staleGeneration),
      () => database.setPositionGroupStatus(groupId, "active", { staleWrite: true }, "active"),
    )).rejects.toThrow(/generation is stale/);

    await runEvaluation(
      context("group", groupId, freshGeneration),
      async () => {
        expect(await database.setPositionGroupStatus(groupId, "active", { freshWrite: true }, "active")).toBe(true);
        await database.addPositionGroupPnlSnapshot(snapshot(100n, 7n));
      },
    );

    const row = await pool.query<{ metadata: Record<string, unknown> }>("SELECT metadata FROM position_groups WHERE id = $1", [groupId]);
    expect(row.rows[0]!.metadata).toMatchObject({ freshWrite: true });
    expect(row.rows[0]!.metadata).not.toHaveProperty("staleWrite");
  });

  it("rejects a stale same-block snapshot after the fresh generation replaces it", async () => {
    const staleGeneration = await database.beginEvaluation("group", groupId, Date.now() + 30_000);

    await runEvaluation(
      context("group", groupId, staleGeneration),
      () => database.addPositionGroupPnlSnapshot(snapshot(100n, 1n)),
    );

    const freshGeneration = await database.beginEvaluation("group", groupId, Date.now() + 30_000);
    await runEvaluation(
      context("group", groupId, freshGeneration),
      () => database.addPositionGroupPnlSnapshot(snapshot(100n, 2n)),
    );

    await expect(runEvaluation(
      context("group", groupId, staleGeneration),
      () => database.addPositionGroupPnlSnapshot(snapshot(100n, 99n)),
    )).rejects.toThrow(/generation is stale/);

    await expect(database.getLatestPositionGroupPnlSnapshot(groupId)).resolves.toMatchObject({
      blockNumber: 100n,
      pnlQuote: 2n,
    });
  });

  it("rejects stale standalone position metadata writes", async () => {
    const staleGeneration = await database.beginEvaluation("position", positionId, Date.now() + 30_000);
    await database.beginEvaluation("position", positionId, Date.now() + 30_000);

    await expect(runEvaluation(
      context("position", positionId, staleGeneration),
      () => database.setPositionStatus(positionId, "armed", { stalePositionMetadata: true }),
    )).rejects.toThrow(/generation is stale/);

    const row = await pool.query<{ metadata: Record<string, unknown> }>("SELECT metadata FROM positions WHERE id = $1", [positionId]);
    expect(row.rows[0]!.metadata).not.toHaveProperty("stalePositionMetadata");
  });

  it("does not change updated_at when beginning an evaluation", async () => {
    await pool.query("UPDATE position_groups SET updated_at = '2000-01-01T00:00:00Z' WHERE id = $1", [groupId]);
    const before = await pool.query<{ updated_at: Date }>("SELECT updated_at FROM position_groups WHERE id = $1", [groupId]);

    await database.beginEvaluation("group", groupId, Date.now() + 30_000);

    const after = await pool.query<{ updated_at: Date }>("SELECT updated_at FROM position_groups WHERE id = $1", [groupId]);
    expect(after.rows[0]!.updated_at.toISOString()).toBe(before.rows[0]!.updated_at.toISOString());
  });

  it("reads the newest snapshot by block, regardless of created_at order", async () => {
    const generation = await database.beginEvaluation("group", groupId, Date.now() + 30_000);
    await runEvaluation(context("group", groupId, generation), async () => {
      await database.addPositionGroupPnlSnapshot(snapshot(100n, 1n));
      await database.addPositionGroupPnlSnapshot(snapshot(200n, 2n));
    });
    await pool.query(
      `UPDATE position_group_pnl_snapshots
          SET created_at = CASE WHEN block_number = 100 THEN NOW() ELSE NOW() - INTERVAL '1 hour' END
        WHERE group_id = $1`,
      [groupId],
    );

    await expect(database.getLatestPositionGroupPnlSnapshot(groupId)).resolves.toMatchObject({ blockNumber: 200n, pnlQuote: 2n });
  });

  it("does not commit a delayed SQL write after the evaluation deadline expires", async () => {
    const deadline = Date.now() + 100;
    const generation = await database.beginEvaluation("group", groupId, deadline);
    const ctx = context("group", groupId, generation, deadline);
    const delayed = runEvaluation(ctx, () => database.transaction(async (client) => {
      await client.query("SELECT pg_sleep(0.25)");
      await client.query("UPDATE position_groups SET metadata = metadata || '{\"lateWrite\":true}'::jsonb WHERE id = $1", [groupId]);
    }));

    const [original, observed] = await Promise.allSettled([
      delayed,
      evaluationWait(delayed, ctx),
    ]);
    expect(original.status).toBe("rejected");
    expect(observed.status).toBe("rejected");
    if (observed.status === "rejected") expect(String(observed.reason)).toMatch(/expired|cancelled|canceled/i);

    const row = await pool.query<{ metadata: Record<string, unknown> }>("SELECT metadata FROM position_groups WHERE id = $1", [groupId]);
    expect(row.rows[0]!.metadata).not.toHaveProperty("lateWrite");
  });

  it("blocks an application-level delayed insert after the evaluation deadline", async () => {
    const deadline = Date.now() + 100;
    const generation = await database.beginEvaluation("group", groupId, deadline);
    const ctx = context("group", groupId, generation, deadline);
    let resume!: () => void;
    const delayed = new Promise<void>((resolve) => { resume = resolve; });
    let attemptedLateWrite = false;
    const recovery = runEvaluation(ctx, () => database.transaction(async (client) => {
      await delayed;
      attemptedLateWrite = true;
      await client.query(
        `INSERT INTO position_group_pnl_snapshots (
           group_id, quote_token, deposits_quote, realized_quote, liquidation_quote,
           fee_quote, fee_quote_usdg, pnl_quote, pnl_bps, block_number, group_gas_quote
         ) VALUES ($1, $2, 1, 0, 1, 0, 0, 2, 2, 999, 0)`,
        [groupId, "0x0000000000000000000000000000000000000003"],
      );
    }));
    const outcome = recovery.then(() => undefined, (error) => error);

    await expect(evaluationWait(recovery, ctx)).rejects.toBeInstanceOf(EvaluationCancelledError);
    resume();

    await expect(outcome).resolves.toBeInstanceOf(EvaluationCancelledError);
    expect(attemptedLateWrite).toBe(true);
    const row = await pool.query("SELECT 1 FROM position_group_pnl_snapshots WHERE group_id = $1 AND block_number = 999", [groupId]);
    expect(row.rowCount).toBe(0);
  });

  it("blocks closing or settled position status regressions", async () => {
    await pool.query("UPDATE positions SET status = 'closing', metadata = '{}'::jsonb WHERE id = $1", [positionId]);

    await expect(database.setPositionStatus(positionId, "armed", { illegal: true }, "closing")).resolves.toBe(false);
    await expect(pool.query<{ status: string }>("SELECT status FROM positions WHERE id = $1", [positionId]))
      .resolves.toMatchObject({ rows: [{ status: "closing" }] });

    await pool.query("UPDATE positions SET status = 'settled', metadata = '{}'::jsonb WHERE id = $1", [positionId]);

    await expect(database.setPositionStatus(positionId, "closing", { illegal: true }, "settled")).resolves.toBe(false);
    await expect(database.setPositionStatus(positionId, "armed", { illegal: true }, "settled")).resolves.toBe(false);
    await expect(pool.query<{ status: string }>("SELECT status FROM positions WHERE id = $1", [positionId]))
      .resolves.toMatchObject({ rows: [{ status: "settled" }] });
  });

  it("commits recovered settlement when close history is intentionally omitted", async () => {
    await pool.query(
      `UPDATE positions
          SET status = 'closing',
              metadata = '{"totalReceived":"10000","closeTransactionHash":"0xclose","exitTrigger":"out_of_range_above"}'::jsonb
        WHERE id = $1`,
      [positionId],
    );
    await pool.query(
      `INSERT INTO execution_attempts (position_id, stage, transaction_hash, status)
       VALUES ($1, 'remove_liquidity', '0xclose', 'confirmed')`,
      [positionId],
    );
    await pool.query(
      `INSERT INTO cashflows (position_id, block_number, transaction_hash, flow_type, quote_value)
       VALUES ($1, 1, '0xdeposit', 'deposit', 10000)`,
      [positionId],
    );

    const generation = await database.beginEvaluation("position", positionId, Date.now() + 30_000);
    await expect(runEvaluation(
      context("position", positionId, generation),
      () => database.recoverVerifiedSettlement(positionId),
    )).resolves.toBe(true);

    const position = await pool.query<{ status: string }>("SELECT status FROM positions WHERE id = $1", [positionId]);
    const history = await pool.query("SELECT 1 FROM close_history WHERE position_id = $1", [positionId]);
    expect(position.rows[0]!.status).toBe("settled");
    expect(history.rowCount).toBe(0);
  });

  it("rolls back recovered settlement when close-history finalization is cancelled", async () => {
    await pool.query(
      `UPDATE positions
          SET status = 'closing',
              metadata = '{"totalReceived":"1600000","closeTransactionHash":"0xclose","exitTrigger":"out_of_range_above"}'::jsonb
        WHERE id = $1`,
      [positionId],
    );
    await pool.query(
      `INSERT INTO execution_attempts (position_id, stage, transaction_hash, status)
       VALUES ($1, 'remove_liquidity', '0xclose', 'confirmed')`,
      [positionId],
    );
    await pool.query(
      `INSERT INTO cashflows (position_id, block_number, transaction_hash, flow_type, quote_value)
       VALUES ($1, 1, '0xdeposit', 'deposit', 1000000)`,
      [positionId],
    );

    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE close_history IN ACCESS EXCLUSIVE MODE");
      const generation = await database.beginEvaluation("position", positionId, Date.now() + 30_000);
      const controller = new AbortController();
      const ctx: EvaluationContext = {
        ...context("position", positionId, generation),
        signal: controller.signal,
      };
      const recovery = runEvaluation(ctx, () => database.recoverVerifiedSettlement(positionId));
      const outcome = recovery.then(() => undefined, (error) => error);

      await vi.waitFor(async () => {
        const blocked = await pool.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query ILIKE '%close_history%'`,
        );
        expect(blocked.rows[0]!.count).toBeGreaterThan(0);
      }, { timeout: 2_000, interval: 25 });

      controller.abort();
      await expect(outcome).resolves.toBeInstanceOf(EvaluationCancelledError);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    const position = await pool.query<{ status: string }>("SELECT status FROM positions WHERE id = $1", [positionId]);
    const history = await pool.query("SELECT 1 FROM close_history WHERE position_id = $1", [positionId]);
    expect(position.rows[0]!.status).toBe("closing");
    expect(history.rowCount).toBe(0);
  });

  it("stops waiting and destroys the connection when deferred COMMIT exceeds the deadline", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `delay_commit_${suffix}`;
    const triggerName = `delay_commit_trigger_${suffix}`;
    await pool.query(`
      CREATE FUNCTION ${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(1.5);
        RETURN NEW;
      END;
      $$;
      CREATE CONSTRAINT TRIGGER ${triggerName}
        AFTER UPDATE OF metadata ON position_groups
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION ${functionName}();
    `);
    let backendPid: number | undefined;
    try {
      const deadline = Date.now() + 400;
      const generation = await database.beginEvaluation("group", groupId, deadline);
      const startedAt = Date.now();
      const outcome = await runEvaluation(
        context("group", groupId, generation, deadline),
        () => database.transaction(async (client) => {
          const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          backendPid = pid.rows[0]!.pid;
          await client.query(
            `UPDATE position_groups
                SET metadata = metadata || '{"slowCommit":true}'::jsonb
              WHERE id = $1`,
            [groupId],
          );
        }),
      ).catch((error) => error);

      expect(String(outcome)).toMatch(/expired|cancel|timeout|57014/i);
      expect(Date.now() - startedAt).toBeLessThan(1_200);
      expect(backendPid).toBeGreaterThan(0);
      const pid = backendPid!;
      await vi.waitFor(async () => {
        const active = await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid]);
        expect(active.rowCount).toBe(0);
      }, { timeout: 3_000, interval: 50 });
      // The server may have committed before our client stopped waiting.
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON position_groups`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });
});
