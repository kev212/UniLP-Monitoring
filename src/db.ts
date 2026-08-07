import { Pool, type PoolClient } from "pg";
import type { Address } from "viem";

import type {
  CloseHistoryRecord,
  PnlCalendarMonth,
  PnlCardDetail,
  PnlSnapshot,
  PoolScanSettings,
  PositionGroupBinRecord,
  PositionGroupBinSide,
  PositionGroupBinStatus,
  PositionGroupCashflowTotals,
  PositionGroupCashflowType,
  PositionGroupExecutionStage,
  PositionGroupExecutionStatus,
  PositionGroupPnlSnapshot,
  PositionGroupPnlSnapshotRecord,
  PositionGroupRecord,
  PositionGroupStatus,
  PositionRecord,
  PositionStatus,
  Protocol,
  RiskSettings,
  TrailingStopState,
} from "./types.js";

const HISTORY_MIN_PNL_BPS = 50n;

interface PositionRow {
  id: string;
  chain_id: number;
  protocol: Protocol;
  position_key: string;
  owner: string;
  pool_address: string | null;
  token0: string;
  token1: string;
  quote_token: string | null;
  status: PositionStatus;
  liquidity: string | null;
  opened_at_block: string | null;
  metadata: Record<string, unknown>;
}

interface PositionGroupRow {
  id: string;
  chain_id: number;
  protocol: Protocol;
  position_manager: string;
  pool_key: string;
  owner: string;
  token0: string;
  token1: string;
  quote_token: string;
  shape: "bid_ask";
  shape_version: "delta-amount-linear-v1";
  requested_bin_count: number;
  generated_bin_count: number;
  mintable_bin_count: number;
  outer_tick_lower: number;
  outer_tick_upper: number;
  anchor_bin_index: number;
  total_deposit: string;
  deployed_cost_quote: string;
  direct_close_amount0: string;
  direct_close_amount1: string;
  total_received_quote: string;
  status: PositionGroupStatus;
  plan_hash: string;
  plan_json: Record<string, unknown>;
  reference_block: string | null;
  reference_tick: number | null;
  reference_price: string | null;
  open_transaction_hash: string | null;
  close_transaction_hash: string | null;
  pending_raw_transaction: Record<string, unknown> | null;
  execution_lease_token: string | null;
  execution_lease_until: Date | string | null;
  final_pnl_quote: string | null;
  final_pnl_bps: string | null;
  final_pnl_usd: string | null;
  settled_at: Date | string | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PositionGroupBinRow {
  id: string;
  group_id: string;
  chain_id: number;
  position_manager: string;
  bin_index: number;
  tick_lower: number;
  tick_upper: number;
  side: PositionGroupBinSide;
  weight_micros: number;
  allocated_amount0: string;
  allocated_amount1: string;
  expected_liquidity: string;
  expected_amount0: string;
  expected_amount1: string;
  token_id: string | null;
  position_id: string | null;
  opening_amount0: string;
  opening_amount1: string;
  close_amount0: string;
  close_amount1: string;
  settlement_quote: string;
  status: PositionGroupBinStatus;
  drop_reason: string | null;
  open_transaction_hash: string | null;
  close_transaction_hash: string | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface PositionGroupBinPatch {
  tokenId?: bigint | null;
  positionId?: string | null;
  status?: PositionGroupBinStatus;
  openTransactionHash?: string | null;
  closeTransactionHash?: string | null;
  openingAmount0?: bigint;
  openingAmount1?: bigint;
  closeAmount0?: bigint;
  closeAmount1?: bigint;
  settlementQuote?: bigint;
}

export interface PositionGroupChildRecord {
  bin: PositionGroupBinRecord;
  position: PositionRecord | null;
}

interface PositionGroupPnlSnapshotRow {
  id: string;
  group_id: string;
  quote_token: string;
  deposits_quote: string;
  realized_quote: string;
  liquidation_quote: string;
  fee_quote: string;
  fee_quote_usdg: string;
  pnl_quote: string;
  pnl_bps: string;
  block_number: string;
  group_gas_quote: string;
  range_current_tick: number | null;
  range_current_sqrt_price: string | null;
  created_at: Date | string;
}

export class Database {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async connect(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE IF NOT EXISTS chain_cursors (
        chain_id INTEGER PRIMARY KEY,
        block_number NUMERIC(78, 0) NOT NULL,
        block_hash TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS chain_bootstraps (
        chain_id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        completed_at_block NUMERIC(78, 0) NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS positions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chain_id INTEGER NOT NULL,
        protocol TEXT NOT NULL CHECK (protocol IN ('v2', 'v3', 'v4')),
        position_key TEXT NOT NULL,
        owner TEXT NOT NULL,
        pool_address TEXT,
        token0 TEXT NOT NULL,
        token1 TEXT NOT NULL,
        quote_token TEXT,
        status TEXT NOT NULL CHECK (status IN ('discovered', 'syncing', 'armed', 'closing', 'settled', 'needs_review', 'failed', 'paused')),
        liquidity NUMERIC(78, 0),
        opened_at_block NUMERIC(78, 0),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(chain_id, protocol, position_key)
      );
      ALTER TABLE positions ADD COLUMN IF NOT EXISTS settlement_lease_token TEXT;
      ALTER TABLE positions ADD COLUMN IF NOT EXISTS settlement_lease_until TIMESTAMPTZ;
      ALTER TABLE positions ADD COLUMN IF NOT EXISTS dex TEXT NOT NULL DEFAULT 'uniswap';
      UPDATE positions SET dex = metadata->>'dex' WHERE metadata->>'dex' IS NOT NULL;
      ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_chain_id_protocol_position_key_key;
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'positions_chain_id_protocol_dex_position_key_key'
        ) THEN
          ALTER TABLE positions ADD CONSTRAINT positions_chain_id_protocol_dex_position_key_key UNIQUE(chain_id, protocol, dex, position_key);
        END IF;
      END $$;
      CREATE TABLE IF NOT EXISTS position_groups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chain_id INTEGER NOT NULL,
        protocol TEXT NOT NULL CHECK (protocol IN ('v3', 'v4')),
        position_manager TEXT NOT NULL,
        pool_key TEXT NOT NULL,
        owner TEXT NOT NULL,
        token0 TEXT NOT NULL,
        token1 TEXT NOT NULL,
        quote_token TEXT NOT NULL,
        shape TEXT NOT NULL CHECK (shape = 'bid_ask'),
        shape_version TEXT NOT NULL CHECK (shape_version = 'delta-amount-linear-v1'),
        requested_bin_count INTEGER NOT NULL,
        generated_bin_count INTEGER NOT NULL,
        mintable_bin_count INTEGER NOT NULL,
        outer_tick_lower INTEGER NOT NULL,
        outer_tick_upper INTEGER NOT NULL,
        anchor_bin_index INTEGER NOT NULL,
        total_deposit NUMERIC(78, 0) NOT NULL,
        deployed_cost_quote NUMERIC(78, 0) NOT NULL,
        direct_close_amount0 NUMERIC(78, 0) NOT NULL,
        direct_close_amount1 NUMERIC(78, 0) NOT NULL,
        total_received_quote NUMERIC(78, 0) NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('planned', 'preparing', 'opening', 'active', 'closing', 'settling', 'settled', 'needs_review', 'cancelled')),
        plan_hash TEXT NOT NULL,
        plan_json JSONB NOT NULL,
        reference_block NUMERIC(78, 0),
        reference_tick INTEGER,
        reference_price NUMERIC(78, 0),
        open_transaction_hash TEXT,
        close_transaction_hash TEXT,
        pending_raw_transaction JSONB,
        execution_lease_token TEXT,
        execution_lease_until TIMESTAMPTZ,
        final_pnl_quote NUMERIC(78, 0),
        final_pnl_bps NUMERIC(78, 0),
        final_pnl_usd NUMERIC(78, 0),
        settled_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS position_groups_chain_status_updated_idx ON position_groups(chain_id, status, updated_at ASC);
      CREATE INDEX IF NOT EXISTS position_groups_status_updated_idx ON position_groups(status, updated_at ASC);
      CREATE TABLE IF NOT EXISTS position_group_bins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id UUID NOT NULL REFERENCES position_groups(id) ON DELETE CASCADE,
        chain_id INTEGER NOT NULL,
        position_manager TEXT NOT NULL,
        bin_index INTEGER NOT NULL,
        tick_lower INTEGER NOT NULL,
        tick_upper INTEGER NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('token0', 'token1')),
        weight_micros INTEGER NOT NULL,
        allocated_amount0 NUMERIC(78, 0) NOT NULL,
        allocated_amount1 NUMERIC(78, 0) NOT NULL,
        expected_liquidity NUMERIC(78, 0) NOT NULL,
        expected_amount0 NUMERIC(78, 0) NOT NULL,
        expected_amount1 NUMERIC(78, 0) NOT NULL,
        token_id NUMERIC(78, 0),
        position_id UUID REFERENCES positions(id) ON DELETE SET NULL,
        opening_amount0 NUMERIC(78, 0) NOT NULL DEFAULT 0,
        opening_amount1 NUMERIC(78, 0) NOT NULL DEFAULT 0,
        close_amount0 NUMERIC(78, 0) NOT NULL DEFAULT 0,
        close_amount1 NUMERIC(78, 0) NOT NULL DEFAULT 0,
        settlement_quote NUMERIC(78, 0) NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('planned', 'minted', 'closed', 'skipped', 'needs_review')),
        drop_reason TEXT,
        open_transaction_hash TEXT,
        close_transaction_hash TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(group_id, bin_index)
      );
      CREATE INDEX IF NOT EXISTS position_group_bins_group_status_idx ON position_group_bins(group_id, status, bin_index);
      CREATE UNIQUE INDEX IF NOT EXISTS position_group_bins_chain_manager_token_idx
        ON position_group_bins(chain_id, position_manager, token_id) WHERE token_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS position_group_bins_position_idx
        ON position_group_bins(position_id) WHERE position_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS position_group_execution_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id UUID NOT NULL REFERENCES position_groups(id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK (stage IN ('approve_quote', 'wrap_quote', 'approve_permit2', 'permit2_approve', 'open_batch', 'close_batch', 'settlement_swap', 'unwrap_quote')),
        signed_raw_transaction TEXT,
        nonce NUMERIC(78, 0),
        transaction_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('planned', 'submitted', 'confirmed', 'failed')),
        all_or_nothing BOOLEAN NOT NULL DEFAULT FALSE,
        error TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (stage NOT IN ('open_batch', 'close_batch') OR all_or_nothing)
      );
      CREATE INDEX IF NOT EXISTS position_group_execution_attempts_group_created_idx
        ON position_group_execution_attempts(group_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS position_group_execution_attempts_group_stage_status_idx
        ON position_group_execution_attempts(group_id, stage, status, created_at DESC);
      CREATE TABLE IF NOT EXISTS position_group_cashflows (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id UUID NOT NULL REFERENCES position_groups(id) ON DELETE CASCADE,
        block_number NUMERIC(78, 0) NOT NULL,
        transaction_hash TEXT NOT NULL,
        flow_type TEXT NOT NULL CHECK (flow_type IN ('open_debit', 'close_receipt', 'settlement_swap', 'unwrap_quote')),
        quote_value NUMERIC(78, 0) NOT NULL,
        token0_amount NUMERIC(78, 0) NOT NULL DEFAULT 0,
        token1_amount NUMERIC(78, 0) NOT NULL DEFAULT 0,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(group_id, transaction_hash, flow_type)
      );
      CREATE INDEX IF NOT EXISTS position_group_cashflows_group_block_idx
        ON position_group_cashflows(group_id, block_number, created_at DESC);
      CREATE TABLE IF NOT EXISTS position_group_pnl_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id UUID NOT NULL REFERENCES position_groups(id) ON DELETE CASCADE,
        quote_token TEXT NOT NULL,
        deposits_quote NUMERIC(78, 0) NOT NULL,
        realized_quote NUMERIC(78, 0) NOT NULL,
        liquidation_quote NUMERIC(78, 0) NOT NULL,
        fee_quote NUMERIC(78, 0) NOT NULL,
        fee_quote_usdg NUMERIC(78, 0) NOT NULL DEFAULT 0,
        pnl_quote NUMERIC(78, 0) NOT NULL,
        pnl_bps NUMERIC(78, 0) NOT NULL,
        block_number NUMERIC(78, 0) NOT NULL,
        group_gas_quote NUMERIC(78, 0) NOT NULL DEFAULT 0,
        range_current_tick INTEGER,
        range_current_sqrt_price NUMERIC(78, 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(group_id, block_number)
      );
      ALTER TABLE position_group_pnl_snapshots ADD COLUMN IF NOT EXISTS range_current_tick INTEGER;
      ALTER TABLE position_group_pnl_snapshots ADD COLUMN IF NOT EXISTS range_current_sqrt_price NUMERIC(78, 0);
      ALTER TABLE position_group_pnl_snapshots ADD COLUMN IF NOT EXISTS fee_quote_usdg NUMERIC(78, 0) NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS position_group_pnl_snapshots_group_created_idx
        ON position_group_pnl_snapshots(group_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS cashflows (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        position_id UUID NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
        block_number NUMERIC(78, 0) NOT NULL,
        transaction_hash TEXT NOT NULL,
        flow_type TEXT NOT NULL CHECK (flow_type IN ('deposit', 'withdrawal', 'fee')),
        quote_value NUMERIC(78, 0) NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE(position_id, transaction_hash, flow_type)
      );
      CREATE TABLE IF NOT EXISTS pnl_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        position_id UUID NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
        quote_token TEXT NOT NULL,
        deposits_quote NUMERIC(78, 0) NOT NULL,
        realized_quote NUMERIC(78, 0) NOT NULL,
        liquidation_quote NUMERIC(78, 0) NOT NULL,
        pnl_quote NUMERIC(78, 0) NOT NULL,
        pnl_bps NUMERIC(78, 0) NOT NULL,
        block_number NUMERIC(78, 0) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS pnl_snapshots_position_created_idx ON pnl_snapshots(position_id, created_at DESC);
      ALTER TABLE pnl_snapshots ADD COLUMN IF NOT EXISTS fee_quote_usdg NUMERIC(78, 0) DEFAULT 0;
      CREATE TABLE IF NOT EXISTS position_observations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        position_id UUID NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
        protocol TEXT NOT NULL CHECK (protocol IN ('v2', 'v3', 'v4')),
        liquidity NUMERIC(78, 0) NOT NULL,
        token0 TEXT NOT NULL,
        token0_amount NUMERIC(78, 0) NOT NULL,
        token1 TEXT NOT NULL,
        token1_amount NUMERIC(78, 0) NOT NULL,
        block_number NUMERIC(78, 0) NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(position_id, block_number)
      );
      CREATE INDEX IF NOT EXISTS position_observations_lookup_idx ON position_observations(position_id, observed_at DESC);
      ALTER TABLE position_observations ADD COLUMN IF NOT EXISTS range_status TEXT;
      ALTER TABLE position_observations ADD COLUMN IF NOT EXISTS range_tick_lower INTEGER;
      ALTER TABLE position_observations ADD COLUMN IF NOT EXISTS range_tick_upper INTEGER;
      ALTER TABLE position_observations ADD COLUMN IF NOT EXISTS range_current_tick INTEGER;
      ALTER TABLE position_observations ADD COLUMN IF NOT EXISTS range_sqrt_price NUMERIC(78, 0);
      CREATE TABLE IF NOT EXISTS execution_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        position_id UUID NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        transaction_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('planned', 'submitted', 'confirmed', 'failed')),
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS pool_observations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chain_id INTEGER NOT NULL,
        protocol TEXT NOT NULL CHECK (protocol IN ('v2', 'v3', 'v4')),
        pool_key TEXT NOT NULL,
        price_marker NUMERIC(78, 0) NOT NULL,
        block_number NUMERIC(78, 0) NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS pool_observations_lookup_idx ON pool_observations(chain_id, protocol, pool_key, observed_at DESC);
      CREATE TABLE IF NOT EXISTS telegram_pool_scan_settings (
        chat_id TEXT PRIMARY KEY,
        settings JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS global_risk_settings (
        id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
        settings JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS telegram_dashboards (
        chat_id TEXT PRIMARY KEY,
        message_id INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS telegram_deletion_queue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        delete_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS telegram_deletion_queue_delete_at_idx ON telegram_deletion_queue(delete_at);
      DELETE FROM telegram_deletion_queue a
      USING telegram_deletion_queue b
      WHERE a.chat_id = b.chat_id AND a.message_id = b.message_id AND a.id > b.id;
      CREATE UNIQUE INDEX IF NOT EXISTS telegram_deletion_queue_message_idx ON telegram_deletion_queue(chat_id, message_id);
      CREATE TABLE IF NOT EXISTS pool_scan_candidates (
        token_address TEXT PRIMARY KEY,
        seed_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS pool_scan_candidates_updated_idx ON pool_scan_candidates(updated_at DESC);
      CREATE TABLE IF NOT EXISTS close_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        position_id UUID NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
        chain_id INTEGER NOT NULL,
        protocol TEXT NOT NULL CHECK (protocol IN ('v2', 'v3', 'v4')),
        position_key TEXT NOT NULL,
        token0 TEXT NOT NULL,
        token1 TEXT NOT NULL,
        quote_token TEXT NOT NULL,
        final_pnl_bps NUMERIC(78, 0) NOT NULL,
        final_pnl_quote NUMERIC(78, 0) NOT NULL,
        final_pnl_usd NUMERIC(78, 0) NOT NULL DEFAULT 0,
        trigger TEXT NOT NULL,
        close_transaction_hash TEXT,
        swap_transaction_hash TEXT,
        settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS close_history_settled_at_idx ON close_history(settled_at DESC);
      ALTER TABLE close_history ADD COLUMN IF NOT EXISTS final_pnl_usd NUMERIC(78, 0) NOT NULL DEFAULT 0;
      ALTER TABLE close_history ADD COLUMN IF NOT EXISTS opened_at_block NUMERIC(78, 0);
      CREATE TABLE IF NOT EXISTS telegram_pnl_card_bg (
        chat_id TEXT PRIMARY KEY,
        image BYTEA NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async withExecutionLock<T>(chainId: number, executorAddress: string, work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      await client.query("SELECT pg_advisory_lock($1, hashtext($2))", [chainId, executorAddress.toLowerCase()]);
      locked = true;
      return await work();
    } finally {
      if (locked) {
        try {
          await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [chainId, executorAddress.toLowerCase()]);
        } catch (error) {
          client.release(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      }
      client.release();
    }
  }

  async getCursor(chainId: number): Promise<bigint | null> {
    const result = await this.pool.query<{ block_number: string }>("SELECT block_number FROM chain_cursors WHERE chain_id = $1", [chainId]);
    return result.rowCount ? BigInt(result.rows[0]!.block_number) : null;
  }

  async saveCursor(chainId: number, blockNumber: bigint, blockHash?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO chain_cursors (chain_id, block_number, block_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (chain_id) DO UPDATE SET block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash, updated_at = NOW()`,
      [chainId, blockNumber.toString(), blockHash ?? null],
    );
  }

  async getBootstrap(chainId: number): Promise<{ source: string; completedAtBlock: bigint } | null> {
    const result = await this.pool.query<{ source: string; completed_at_block: string }>(
      "SELECT source, completed_at_block FROM chain_bootstraps WHERE chain_id = $1",
      [chainId],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0]!;
    return { source: row.source, completedAtBlock: BigInt(row.completed_at_block) };
  }

  async markBootstrapComplete(chainId: number, source: string, completedAtBlock: bigint): Promise<void> {
    await this.pool.query(
      `INSERT INTO chain_bootstraps (chain_id, source, completed_at_block)
       VALUES ($1, $2, $3)
       ON CONFLICT (chain_id) DO UPDATE SET source = EXCLUDED.source, completed_at_block = EXCLUDED.completed_at_block, completed_at = NOW()`,
      [chainId, source, completedAtBlock.toString()],
    );
  }

  async upsertPosition(position: Omit<PositionRecord, "id">): Promise<PositionRecord> {
    const dex = typeof position.metadata.dex === "string" ? position.metadata.dex : "uniswap";
    const result = await this.pool.query<PositionRow>(
      `INSERT INTO positions (chain_id, protocol, position_key, owner, pool_address, token0, token1, quote_token, status, liquidity, opened_at_block, metadata, dex)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (chain_id, protocol, dex, position_key) DO UPDATE SET
          owner = EXCLUDED.owner, pool_address = EXCLUDED.pool_address, token0 = EXCLUDED.token0, token1 = EXCLUDED.token1,
           quote_token = EXCLUDED.quote_token, status = CASE WHEN positions.status IN ('closing', 'settled', 'armed') THEN positions.status ELSE EXCLUDED.status END,
          liquidity = EXCLUDED.liquidity, opened_at_block = COALESCE(positions.opened_at_block, EXCLUDED.opened_at_block),
         metadata = positions.metadata || EXCLUDED.metadata, updated_at = NOW()
       RETURNING *`,
      [
        position.chainId,
        position.protocol,
        position.positionKey,
        position.owner.toLowerCase(),
        position.poolAddress?.toLowerCase() ?? null,
        position.token0.toLowerCase(),
        position.token1.toLowerCase(),
        position.quoteToken?.toLowerCase() ?? null,
         position.status,
         position.liquidity?.toString() ?? null,
         position.openedAtBlock?.toString() ?? null,
         JSON.stringify(position.metadata),
         dex,
       ],
    );
    return mapPosition(result.rows[0]!);
  }

  async listOpenPositions(chainId?: number): Promise<PositionRecord[]> {
    const result = await this.pool.query<PositionRow>(
      `SELECT * FROM positions WHERE status IN ('discovered', 'syncing', 'armed', 'needs_review', 'failed') ${chainId ? "AND chain_id = $1" : ""} ORDER BY created_at ASC`,
      chainId ? [chainId] : [],
    );
    return result.rows.map(mapPosition);
  }

  async listClosingPositions(): Promise<PositionRecord[]> {
    const result = await this.pool.query<PositionRow>("SELECT * FROM positions WHERE status = 'closing' ORDER BY updated_at ASC");
    return result.rows.map(mapPosition);
  }

  async listPendingSwapPositions(): Promise<PositionRecord[]> {
    const result = await this.pool.query<PositionRow>(
      `SELECT * FROM positions
       WHERE status = 'closing'
            OR (status = 'needs_review'
                AND COALESCE(metadata->>'settlementRetryDisabled', 'false') <> 'true'
                AND ((metadata ? 'pendingSwap' AND metadata->'pendingSwap' <> 'null'::jsonb)
                     OR metadata->>'settlementPhase' = 'removing_liquidity'))
       ORDER BY updated_at ASC`,
    );
    return result.rows.map(mapPosition);
  }

  async listActivePositions(chainId?: number): Promise<PositionRecord[]> {
    const result = await this.pool.query<PositionRow>(
      `SELECT * FROM positions WHERE status <> 'settled' ${chainId ? "AND chain_id = $1" : ""} ORDER BY created_at ASC`,
      chainId ? [chainId] : [],
    );
    return result.rows.map(mapPosition);
  }

  async getPositionById(positionId: string): Promise<PositionRecord | null> {
    const result = await this.pool.query<PositionRow>(
      "SELECT * FROM positions WHERE id = $1",
      [positionId],
    );
    return result.rowCount ? mapPosition(result.rows[0]!) : null;
  }

  async createPositionGroup(group: Omit<PositionGroupRecord, "id" | "createdAt" | "updatedAt">): Promise<PositionGroupRecord> {
    const result = await this.pool.query<PositionGroupRow>(
      `INSERT INTO position_groups (
         chain_id, protocol, position_manager, pool_key, owner, token0, token1, quote_token,
         shape, shape_version, requested_bin_count, generated_bin_count, mintable_bin_count,
         outer_tick_lower, outer_tick_upper, anchor_bin_index, total_deposit, deployed_cost_quote,
         direct_close_amount0, direct_close_amount1, total_received_quote, status, plan_hash, plan_json,
         reference_block, reference_tick, reference_price, open_transaction_hash, close_transaction_hash,
         pending_raw_transaction, execution_lease_token, execution_lease_until, final_pnl_quote,
         final_pnl_bps, final_pnl_usd, settled_at, metadata
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37
       )
       RETURNING *`,
      [
        group.chainId,
        group.protocol,
        group.positionManager.toLowerCase(),
        group.poolKey,
        group.owner.toLowerCase(),
        group.token0.toLowerCase(),
        group.token1.toLowerCase(),
        group.quoteToken.toLowerCase(),
        group.shape,
        group.shapeVersion,
        group.requestedBinCount,
        group.generatedBinCount,
        group.mintableBinCount,
        group.outerTickLower,
        group.outerTickUpper,
        group.anchorBinIndex,
        group.totalDeposit.toString(),
        group.deployedCostQuote.toString(),
        group.directCloseAmount0.toString(),
        group.directCloseAmount1.toString(),
        group.totalReceivedQuote.toString(),
        group.status,
        group.planHash,
        stringifyJson(group.planJson),
        group.referenceBlock?.toString() ?? null,
        group.referenceTick,
        group.referencePrice?.toString() ?? null,
        group.openTransactionHash,
        group.closeTransactionHash,
        group.pendingRawTransaction === null ? null : stringifyJson(group.pendingRawTransaction),
        group.executionLeaseToken,
        group.executionLeaseUntil,
        group.finalPnlQuote?.toString() ?? null,
        group.finalPnlBps?.toString() ?? null,
        group.finalPnlUsd?.toString() ?? null,
        group.settledAt,
        stringifyJson(group.metadata),
      ],
    );
    return mapPositionGroup(result.rows[0]!);
  }

  async getPositionGroup(groupId: string): Promise<PositionGroupRecord | null> {
    const result = await this.pool.query<PositionGroupRow>(
      "SELECT * FROM position_groups WHERE id = $1",
      [groupId],
    );
    return result.rowCount ? mapPositionGroup(result.rows[0]!) : null;
  }

  async listPositionGroups(chainId?: number, status?: PositionGroupStatus): Promise<PositionGroupRecord[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (chainId !== undefined) {
      values.push(chainId);
      conditions.push(`chain_id = $${values.length}`);
    }
    if (status !== undefined) {
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }
    const result = await this.pool.query<PositionGroupRow>(
      `SELECT * FROM position_groups${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY created_at ASC`,
      values,
    );
    return result.rows.map(mapPositionGroup);
  }

  async setPositionGroupStatus(groupId: string, status: PositionGroupStatus, metadata: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query(
      `WITH updated_group AS (
        UPDATE position_groups
         SET status = $2,
             metadata = metadata || $3::jsonb,
             open_transaction_hash = CASE
               WHEN $3::jsonb ? 'openTransactionHash' THEN NULLIF($3::jsonb->>'openTransactionHash', '')
               ELSE open_transaction_hash
             END,
             close_transaction_hash = CASE
               WHEN $3::jsonb ? 'closeTransactionHash' THEN NULLIF($3::jsonb->>'closeTransactionHash', '')
               ELSE close_transaction_hash
             END,
             total_received_quote = CASE
               WHEN $3::jsonb ? 'totalReceivedQuote' AND $3::jsonb->>'totalReceivedQuote' IS NOT NULL
                 THEN ($3::jsonb->>'totalReceivedQuote')::numeric
               ELSE total_received_quote
             END,
             final_pnl_quote = CASE
               WHEN $3::jsonb ? 'finalPnlQuote' THEN NULLIF($3::jsonb->>'finalPnlQuote', '')::numeric
               ELSE final_pnl_quote
             END,
             final_pnl_bps = CASE
               WHEN $3::jsonb ? 'finalPnlBps' THEN NULLIF($3::jsonb->>'finalPnlBps', '')::numeric
               ELSE final_pnl_bps
             END,
             final_pnl_usd = CASE
               WHEN $3::jsonb ? 'finalPnlUsd' THEN NULLIF($3::jsonb->>'finalPnlUsd', '')::numeric
               ELSE final_pnl_usd
             END,
             settled_at = CASE
               WHEN $3::jsonb ? 'settledAt' THEN NULLIF($3::jsonb->>'settledAt', '')::timestamptz
               WHEN $2 = 'settled' THEN COALESCE(settled_at, NOW())
               ELSE settled_at
             END,
             pending_raw_transaction = CASE
               WHEN $3::jsonb ? 'pendingRawTransaction'
                 AND $3::jsonb->'pendingRawTransaction' = 'null'::jsonb
               THEN NULL
               ELSE pending_raw_transaction
             END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id
      )
      UPDATE positions
         SET status = CASE
               WHEN $2 = 'settled' THEN 'settled'
               WHEN $2 IN ('closing', 'settling') AND positions.status <> 'settled' THEN 'closing'
               ELSE positions.status
             END,
             metadata = metadata || jsonb_build_object('positionGroupStatus', $2::text, 'autoExitDisabled', true),
             updated_at = NOW()
       WHERE EXISTS (SELECT 1 FROM updated_group WHERE id = $1)
         AND EXISTS (
           SELECT 1 FROM position_group_bins
            WHERE position_group_bins.group_id = $1
              AND position_group_bins.position_id = positions.id
         )`,
      [groupId, status, stringifyJson(metadata)],
    );
  }

  async finalizePositionGroup(
    groupId: string,
    closeTransactionHash: string,
    totalReceivedQuote: bigint,
    finalPnlQuote: bigint,
    finalPnlBps: bigint,
    trigger: string,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const parent = await client.query(
        `UPDATE position_groups
            SET status = 'settled',
                close_transaction_hash = $2,
                total_received_quote = $3::numeric,
                final_pnl_quote = $4::numeric,
                final_pnl_bps = $5::numeric,
                settled_at = NOW(),
                metadata = metadata || jsonb_build_object(
                  'closeTransactionHash', $2::text,
                  'totalReceivedQuote', ($3::numeric)::text,
                  'finalPnlQuote', ($4::numeric)::text,
                  'finalPnlBps', ($5::numeric)::text,
                  'exitTrigger', $6::text,
                  'settlementPhase', 'complete',
                  'closeReceiptAccounted', true,
                  'settledAt', NOW()::text
                ),
                pending_raw_transaction = NULL,
                execution_lease_token = NULL,
                execution_lease_until = NULL,
                updated_at = NOW()
          WHERE id = $1
            AND status NOT IN ('cancelled')
          RETURNING id`,
        [groupId, closeTransactionHash, totalReceivedQuote.toString(), finalPnlQuote.toString(), finalPnlBps.toString(), trigger],
      );
      if (parent.rowCount !== 1) return false;

      await client.query(
        `UPDATE position_group_bins
            SET status = CASE WHEN status = 'skipped' THEN status ELSE 'closed' END,
                close_transaction_hash = COALESCE(close_transaction_hash, $2),
                updated_at = NOW()
          WHERE group_id = $1`,
        [groupId, closeTransactionHash],
      );
      await client.query(
        `UPDATE positions
            SET status = 'settled',
                metadata = metadata || jsonb_build_object(
                  'positionGroupStatus', 'settled',
                  'positionGroupSettledAt', NOW()::text,
                  'positionGroupCloseTransactionHash', $2::text,
                  'autoExitDisabled', true
                ),
                updated_at = NOW()
          WHERE id IN (
            SELECT position_id FROM position_group_bins
             WHERE group_id = $1 AND position_id IS NOT NULL
          )`,
        [groupId, closeTransactionHash],
      );
      return true;
    });
  }

  async renewPositionGroupLease(groupId: string, token: string, ttlMs = 300_000): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE position_groups
       SET execution_lease_until = NOW() + ($3 * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE id = $1
         AND execution_lease_token = $2
         AND status NOT IN ('settled', 'cancelled')
       RETURNING id`,
      [groupId, token, ttlMs],
    );
    return result.rowCount === 1;
  }

  async createPositionGroupBin(bin: Omit<PositionGroupBinRecord, "id" | "createdAt" | "updatedAt">): Promise<PositionGroupBinRecord> {
    const result = await this.pool.query<PositionGroupBinRow>(
      `INSERT INTO position_group_bins (
         group_id, chain_id, position_manager, bin_index, tick_lower, tick_upper, side, weight_micros,
         allocated_amount0, allocated_amount1, expected_liquidity, expected_amount0, expected_amount1,
         token_id, position_id, opening_amount0, opening_amount1, close_amount0, close_amount1,
         settlement_quote, status, drop_reason, open_transaction_hash, close_transaction_hash, metadata
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         $19, $20, $21, $22, $23, $24, $25
       )
       RETURNING *`,
      [
        bin.groupId,
        bin.chainId,
        bin.positionManager.toLowerCase(),
        bin.binIndex,
        bin.tickLower,
        bin.tickUpper,
        bin.side,
        bin.weightMicros,
        bin.allocatedAmount0.toString(),
        bin.allocatedAmount1.toString(),
        bin.expectedLiquidity.toString(),
        bin.expectedAmount0.toString(),
        bin.expectedAmount1.toString(),
        bin.tokenId?.toString() ?? null,
        bin.positionId,
        bin.openingAmount0.toString(),
        bin.openingAmount1.toString(),
        bin.closeAmount0.toString(),
        bin.closeAmount1.toString(),
        bin.settlementQuote.toString(),
        bin.status,
        bin.dropReason,
        bin.openTransactionHash,
        bin.closeTransactionHash,
        stringifyJson(bin.metadata),
      ],
    );
    return mapPositionGroupBin(result.rows[0]!);
  }

  async getPositionGroupBin(groupIdOrBinId: string, binIndex?: number): Promise<PositionGroupBinRecord | null> {
    const result = binIndex === undefined
      ? await this.pool.query<PositionGroupBinRow>("SELECT * FROM position_group_bins WHERE id = $1", [groupIdOrBinId])
      : await this.pool.query<PositionGroupBinRow>(
        "SELECT * FROM position_group_bins WHERE group_id = $1 AND bin_index = $2",
        [groupIdOrBinId, binIndex],
      );
    return result.rowCount ? mapPositionGroupBin(result.rows[0]!) : null;
  }

  async listPositionGroupBins(groupId: string): Promise<PositionGroupBinRecord[]> {
    const result = await this.pool.query<PositionGroupBinRow>(
      "SELECT * FROM position_group_bins WHERE group_id = $1 ORDER BY bin_index ASC",
      [groupId],
    );
    return result.rows.map(mapPositionGroupBin);
  }

  async listPositionGroupChildren(groupId: string): Promise<PositionGroupChildRecord[]> {
    const bins = await this.listPositionGroupBins(groupId);
    const positionIds = bins.flatMap((bin) => bin.positionId === null ? [] : [bin.positionId]);
    if (positionIds.length === 0) return bins.map((bin) => ({ bin, position: null }));

    const result = await this.pool.query<PositionRow>(
      `SELECT positions.*
       FROM positions
       INNER JOIN position_group_bins ON position_group_bins.position_id = positions.id
       WHERE position_group_bins.group_id = $1
         AND positions.id = ANY($2::uuid[])
       ORDER BY position_group_bins.bin_index ASC`,
      [groupId, positionIds],
    );
    const positions = new Map(result.rows.map((row) => [row.id, mapPosition(row)]));
    return bins.map((bin) => ({ bin, position: bin.positionId === null ? null : positions.get(bin.positionId) ?? null }));
  }

  async updatePositionGroupBin(groupId: string, binIndex: number, patch: PositionGroupBinPatch): Promise<boolean> {
    const assignments: string[] = [];
    const values: unknown[] = [groupId, binIndex];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if (Object.prototype.hasOwnProperty.call(patch, "tokenId")) add("token_id", patch.tokenId === null ? null : patch.tokenId?.toString());
    if (Object.prototype.hasOwnProperty.call(patch, "positionId")) add("position_id", patch.positionId ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, "status")) add("status", patch.status);
    if (Object.prototype.hasOwnProperty.call(patch, "openTransactionHash")) add("open_transaction_hash", patch.openTransactionHash ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, "closeTransactionHash")) add("close_transaction_hash", patch.closeTransactionHash ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, "openingAmount0")) add("opening_amount0", patch.openingAmount0?.toString());
    if (Object.prototype.hasOwnProperty.call(patch, "openingAmount1")) add("opening_amount1", patch.openingAmount1?.toString());
    if (Object.prototype.hasOwnProperty.call(patch, "closeAmount0")) add("close_amount0", patch.closeAmount0?.toString());
    if (Object.prototype.hasOwnProperty.call(patch, "closeAmount1")) add("close_amount1", patch.closeAmount1?.toString());
    if (Object.prototype.hasOwnProperty.call(patch, "settlementQuote")) add("settlement_quote", patch.settlementQuote?.toString());
    if (assignments.length === 0) return false;

    const result = await this.pool.query(
      `UPDATE position_group_bins
       SET ${assignments.join(", ")}, updated_at = NOW()
       WHERE group_id = $1 AND bin_index = $2
       RETURNING id`,
      values,
    );
    return result.rowCount === 1;
  }

  async setPositionGroupOpenTransaction(groupId: string, hash: string, status: PositionGroupStatus): Promise<boolean> {
    return this.transaction(async (client) => {
      const parent = await client.query(
        `UPDATE position_groups
         SET open_transaction_hash = CASE
               WHEN open_transaction_hash IS NULL THEN $2
               ELSE open_transaction_hash
             END,
             status = $3,
             updated_at = NOW()
         WHERE id = $1
           AND (open_transaction_hash IS NULL OR open_transaction_hash = $2)
         RETURNING id`,
        [groupId, hash, status],
      );
      if (parent.rowCount !== 1) return false;

      await client.query(
        `UPDATE position_group_bins
         SET open_transaction_hash = CASE
               WHEN open_transaction_hash IS NULL THEN $2
               ELSE open_transaction_hash
             END,
             updated_at = NOW()
         WHERE group_id = $1`,
        [groupId, hash],
      );
      return true;
    });
  }

  async claimPositionGroupLease(groupId: string, token: string, ttlMs = 300_000): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE position_groups
       SET execution_lease_token = $2,
           execution_lease_until = NOW() + ($3 * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE id = $1
         AND status NOT IN ('settled', 'cancelled')
         AND (execution_lease_until IS NULL OR execution_lease_until <= NOW())
       RETURNING id`,
      [groupId, token, ttlMs],
    );
    return result.rowCount === 1;
  }

  async releasePositionGroupLease(groupId: string, token: string): Promise<void> {
    await this.pool.query(
      `UPDATE position_groups
       SET execution_lease_token = NULL, execution_lease_until = NULL, updated_at = NOW()
       WHERE id = $1 AND execution_lease_token = $2`,
      [groupId, token],
    );
  }

  async recordPositionGroupExecution(
    groupId: string,
    stage: PositionGroupExecutionStage,
    status: PositionGroupExecutionStatus,
    transactionHash?: string,
    signedRawTransaction?: string,
    nonce?: bigint,
    error?: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const pendingStatus = status === "planned" || status === "submitted";
    const terminalStatus = status === "confirmed" || status === "failed";
    await this.pool.query(
      `WITH recorded AS (
         INSERT INTO position_group_execution_attempts (
           group_id, stage, signed_raw_transaction, nonce, transaction_hash, status,
           all_or_nothing, error, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id
       )
       UPDATE position_groups
       SET pending_raw_transaction = CASE
             WHEN $10 AND $3 IS NOT NULL THEN jsonb_build_object(
               'stage', $2::text,
                'hash', $5::text,
                'serializedTransaction', $3::text,
                'nonce', $4::text,
                'submittedAt', NOW()::text
             )
             WHEN $11 AND pending_raw_transaction IS NOT NULL
               AND pending_raw_transaction->>'stage' = $2::text
               AND ($5::text IS NULL OR pending_raw_transaction->>'hash' = $5::text)
               THEN NULL
             ELSE pending_raw_transaction
           END,
           updated_at = NOW()
       FROM recorded
       WHERE position_groups.id = $1`,
      [
        groupId,
        stage,
        signedRawTransaction ?? null,
        nonce?.toString() ?? null,
        transactionHash ?? null,
        status,
        stage === "open_batch" || stage === "close_batch",
        error ?? null,
        stringifyJson(metadata),
        pendingStatus,
        terminalStatus,
      ],
    );
  }

  async getLatestPositionGroupExecutionHash(
    groupId: string,
    stage: PositionGroupExecutionStage,
    status: PositionGroupExecutionStatus = "confirmed",
  ): Promise<string | null> {
    const result = await this.pool.query<{ transaction_hash: string }>(
      `SELECT transaction_hash
         FROM position_group_execution_attempts
        WHERE group_id = $1
          AND stage = $2
          AND status = $3
          AND transaction_hash IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [groupId, stage, status],
    );
    return result.rowCount ? result.rows[0]!.transaction_hash : null;
  }

  async addPositionGroupCashflow(
    groupId: string,
    blockNumber: bigint,
    transactionHash: string,
    flowType: PositionGroupCashflowType,
    quoteValue: bigint,
    token0Amount = 0n,
    token1Amount = 0n,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO position_group_cashflows
        (group_id, block_number, transaction_hash, flow_type, quote_value, token0_amount, token1_amount, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (group_id, transaction_hash, flow_type) DO NOTHING`,
      [
        groupId,
        blockNumber.toString(),
        transactionHash,
        flowType,
        quoteValue.toString(),
        token0Amount.toString(),
        token1Amount.toString(),
        stringifyJson(details),
      ],
    );
  }

  async getPositionGroupCashflowTotals(groupId: string, excludedTransactionHashes: string[] = []): Promise<PositionGroupCashflowTotals> {
    const result = await this.pool.query<{ deposits: string; realized: string }>(
      `SELECT
         COALESCE(SUM(quote_value) FILTER (WHERE flow_type = 'open_debit'), 0) AS deposits,
         COALESCE(SUM(quote_value) FILTER (WHERE flow_type IN ('close_receipt', 'settlement_swap', 'unwrap_quote')), 0) AS realized
       FROM position_group_cashflows
       WHERE group_id = $1
         AND (cardinality($2::text[]) = 0 OR transaction_hash <> ALL($2::text[]))`,
      [groupId, excludedTransactionHashes],
    );
    const row = result.rows[0]!;
    return { deposits: BigInt(row.deposits), realized: BigInt(row.realized) };
  }

  async addPositionGroupPnlSnapshot(snapshot: PositionGroupPnlSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO position_group_pnl_snapshots
        (group_id, quote_token, deposits_quote, realized_quote, liquidation_quote, fee_quote, fee_quote_usdg, pnl_quote, pnl_bps, block_number, group_gas_quote, range_current_tick, range_current_sqrt_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (group_id, block_number) DO UPDATE SET
         quote_token = EXCLUDED.quote_token,
         deposits_quote = EXCLUDED.deposits_quote,
         realized_quote = EXCLUDED.realized_quote,
         liquidation_quote = EXCLUDED.liquidation_quote,
         fee_quote = EXCLUDED.fee_quote,
         fee_quote_usdg = EXCLUDED.fee_quote_usdg,
         pnl_quote = EXCLUDED.pnl_quote,
         pnl_bps = EXCLUDED.pnl_bps,
         range_current_tick = EXCLUDED.range_current_tick,
         range_current_sqrt_price = EXCLUDED.range_current_sqrt_price,
         group_gas_quote = EXCLUDED.group_gas_quote,
         created_at = NOW()`,
      [
        snapshot.groupId,
        snapshot.quoteToken.toLowerCase(),
        snapshot.depositsQuote.toString(),
        snapshot.realizedQuote.toString(),
        snapshot.liquidationQuote.toString(),
        snapshot.feeQuote.toString(),
        snapshot.feeQuoteUsdg.toString(),
        snapshot.pnlQuote.toString(),
        snapshot.pnlBps.toString(),
        snapshot.blockNumber.toString(),
        snapshot.groupGasQuote.toString(),
        snapshot.rangeCurrentTick,
        snapshot.rangeCurrentSqrtPrice?.toString() ?? null,
      ],
    );
  }

  async getLatestPositionGroupPnlSnapshot(groupId: string): Promise<PositionGroupPnlSnapshotRecord | null> {
    const result = await this.pool.query<PositionGroupPnlSnapshotRow>(
      `SELECT * FROM position_group_pnl_snapshots
       WHERE group_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [groupId],
    );
    return result.rowCount ? mapPositionGroupPnlSnapshot(result.rows[0]!) : null;
  }

  async linkPositionGroupBinPosition(groupId: string, binIndex: number, positionId: string, tokenId?: bigint): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE position_group_bins AS target
       SET position_id = $3,
           token_id = COALESCE($4, target.token_id),
           updated_at = NOW()
       WHERE target.group_id = $1
         AND target.bin_index = $2
         AND (target.position_id IS NULL OR target.position_id = $3)
         AND NOT EXISTS (
           SELECT 1
           FROM position_group_bins conflicting
           WHERE conflicting.id <> target.id
             AND (conflicting.position_id = $3
                  OR ($4::numeric IS NOT NULL AND conflicting.token_id = $4::numeric))
         )
       RETURNING id`,
      [groupId, binIndex, positionId, tokenId?.toString() ?? null],
    );
    return result.rowCount === 1;
  }

  async getPoolScanSettings(chatId: string): Promise<PoolScanSettings | null> {
    const result = await this.pool.query<{ settings: PoolScanSettings }>(
      "SELECT settings FROM telegram_pool_scan_settings WHERE chat_id = $1",
      [chatId],
    );
    return result.rowCount ? result.rows[0]!.settings : null;
  }

  async setPoolScanSettings(chatId: string, settings: PoolScanSettings): Promise<void> {
    await this.pool.query(
      `INSERT INTO telegram_pool_scan_settings (chat_id, settings)
       VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
      [chatId, JSON.stringify(settings)],
    );
  }

  async clearPoolScanSettings(chatId: string): Promise<void> {
    await this.pool.query("DELETE FROM telegram_pool_scan_settings WHERE chat_id = $1", [chatId]);
  }

  async getGlobalRiskSettings(): Promise<unknown | null> {
    const result = await this.pool.query<{ settings: unknown }>(
      "SELECT settings FROM global_risk_settings WHERE id = TRUE",
    );
    return result.rowCount ? result.rows[0]!.settings : null;
  }

  async setGlobalRiskSettings(settings: RiskSettings): Promise<void> {
    await this.pool.query(
      `INSERT INTO global_risk_settings (id, settings)
       VALUES (TRUE, $1)
       ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
      [JSON.stringify(settings)],
    );
  }

  async clearGlobalRiskSettings(): Promise<void> {
    await this.pool.query("DELETE FROM global_risk_settings WHERE id = TRUE");
  }

  async findPositionByKey(chainId: number, protocol: string, positionKey: string): Promise<PositionRecord | null> {
    const result = await this.pool.query<PositionRow>(
      "SELECT * FROM positions WHERE chain_id = $1 AND protocol = $2 AND position_key = $3",
      [chainId, protocol, positionKey],
    );
    return result.rowCount ? mapPosition(result.rows[0]!) : null;
  }

  async getPositionMetadata(positionId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM positions WHERE id = $1",
      [positionId],
    );
    return result.rowCount ? result.rows[0]!.metadata : null;
  }

  async setPositionStatus(positionId: string, status: PositionStatus, metadata?: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      "UPDATE positions SET status = $2, metadata = metadata || $3::jsonb, updated_at = NOW() WHERE id = $1",
      [positionId, status, JSON.stringify(metadata ?? {})],
    );
  }

  async setPositionStatusUnlessSettled(positionId: string, status: PositionStatus, metadata?: Record<string, unknown>): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE positions
       SET status = $2, metadata = metadata || $3::jsonb, updated_at = NOW()
       WHERE id = $1 AND status <> 'settled'
       RETURNING id`,
      [positionId, status, JSON.stringify(metadata ?? {})],
    );
    return result.rowCount === 1;
  }

  async claimSettlementLease(positionId: string, token: string, ttlMs = 300_000): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE positions
       SET settlement_lease_token = $2,
           settlement_lease_until = NOW() + ($3 * INTERVAL '1 millisecond')
       WHERE id = $1
         AND status <> 'settled'
         AND (settlement_lease_until IS NULL OR settlement_lease_until <= NOW())
       RETURNING id`,
      [positionId, token, ttlMs],
    );
    return result.rowCount === 1;
  }

  async releaseSettlementLease(positionId: string, token: string): Promise<void> {
    await this.pool.query(
      `UPDATE positions
       SET settlement_lease_token = NULL, settlement_lease_until = NULL
       WHERE id = $1 AND settlement_lease_token = $2`,
      [positionId, token],
    );
  }

  async renewSettlementLease(positionId: string, token: string, ttlMs = 300_000): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE positions
       SET settlement_lease_until = NOW() + ($3 * INTERVAL '1 millisecond')
       WHERE id = $1
         AND settlement_lease_token = $2
         AND status <> 'settled'
       RETURNING id`,
      [positionId, token, ttlMs],
    );
    return result.rowCount === 1;
  }

  async markNeedsReviewIfNoPendingSettlement(positionId: string, metadata: Record<string, unknown>): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE positions
       SET status = 'needs_review', metadata = metadata || $2::jsonb, updated_at = NOW()
       WHERE id = $1
          AND status NOT IN ('closing', 'settled')
          AND (NOT (metadata ? 'pendingSwap') OR metadata->'pendingSwap' = 'null'::jsonb)
          AND NOT EXISTS (
            SELECT 1 FROM execution_attempts
             WHERE execution_attempts.position_id = positions.id
               AND execution_attempts.stage = 'remove_liquidity'
               AND execution_attempts.status = 'confirmed'
          )
        RETURNING id`,
      [positionId, JSON.stringify(metadata)],
    );
    return result.rowCount === 1;
  }

  async recoverVerifiedSettlement(positionId: string): Promise<boolean> {
    const result = await this.pool.query<{ trigger: string }>(
      `UPDATE positions
       SET status = 'settled',
           metadata = metadata || jsonb_build_object('settlementRecoveredAt', NOW()::text),
           updated_at = NOW()
       WHERE id = $1
         AND status <> 'settled'
         AND jsonb_typeof(metadata->'totalReceived') = 'string'
         AND (NOT (metadata ? 'pendingSwap') OR metadata->'pendingSwap' = 'null'::jsonb)
         AND EXISTS (
           SELECT 1 FROM execution_attempts
            WHERE execution_attempts.position_id = positions.id
              AND execution_attempts.stage = 'remove_liquidity'
              AND execution_attempts.status = 'confirmed'
         )
       RETURNING COALESCE(NULLIF(metadata->>'exitTrigger', ''), 'settled') AS trigger`,
      [positionId],
    );
    if (!result.rowCount) return false;
    await this.finalizeCloseHistory(positionId, result.rows[0]!.trigger);
    return true;
  }

  async setTrailingStopState(positionId: string, state: TrailingStopState): Promise<void> {
    await this.pool.query(
      `UPDATE positions
       SET metadata = metadata || jsonb_build_object(
         'trailingStop',
         jsonb_build_object('peakPnlBps', $2::text, 'activatedAtBlock', $3::text)
       ), updated_at = NOW()
       WHERE id = $1`,
      [positionId, state.peakPnlBps.toString(), state.activatedAtBlock.toString()],
    );
  }

  async clearTrailingStopState(positionId: string): Promise<void> {
    await this.pool.query(
      "UPDATE positions SET metadata = metadata - 'trailingStop', updated_at = NOW() WHERE id = $1",
      [positionId],
    );
  }

  async repairPositionAssets(positionId: string, token0: Address, token1: Address, quoteToken: Address): Promise<void> {
    await this.pool.query(
      `UPDATE positions
       SET token0 = $2, token1 = $3, quote_token = $4, updated_at = NOW()
       WHERE id = $1`,
      [positionId, token0.toLowerCase(), token1.toLowerCase(), quoteToken.toLowerCase()],
    );
  }

  async addCashflow(positionId: string, blockNumber: bigint, transactionHash: string, flowType: "deposit" | "withdrawal" | "fee", quoteValue: bigint, details: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO cashflows (position_id, block_number, transaction_hash, flow_type, quote_value, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (position_id, transaction_hash, flow_type) DO NOTHING`,
      [positionId, blockNumber.toString(), transactionHash, flowType, quoteValue.toString(), JSON.stringify(details)],
    );
  }

  async getCashflowQuoteValue(positionId: string, transactionHash: string, flowType: "deposit" | "withdrawal" | "fee"): Promise<bigint | null> {
    const result = await this.pool.query<{ quote_value: string }>(
      "SELECT quote_value FROM cashflows WHERE position_id = $1 AND transaction_hash = $2 AND flow_type = $3 LIMIT 1",
      [positionId, transactionHash, flowType],
    );
    return result.rowCount ? BigInt(result.rows[0]!.quote_value) : null;
  }

  async getCashflowTotals(positionId: string, excludedTransactionHashes: string[] = []): Promise<{ deposits: bigint; realized: bigint }> {
    const result = await this.pool.query<{ deposits: string; realized: string }>(
      `SELECT
        COALESCE(SUM(quote_value) FILTER (WHERE flow_type = 'deposit'), 0) AS deposits,
        COALESCE(SUM(quote_value) FILTER (WHERE flow_type IN ('withdrawal', 'fee')), 0) AS realized
       FROM cashflows
       WHERE position_id = $1
         AND (cardinality($2::text[]) = 0 OR transaction_hash <> ALL($2::text[]))`,
      [positionId, excludedTransactionHashes],
    );
    const row = result.rows[0]!;
    return { deposits: BigInt(row.deposits), realized: BigInt(row.realized) };
  }

  async addPnlSnapshot(snapshot: PnlSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO pnl_snapshots (position_id, quote_token, deposits_quote, realized_quote, liquidation_quote, pnl_quote, pnl_bps, block_number, fee_quote_usdg)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        snapshot.positionId,
        snapshot.quoteToken.toLowerCase(),
        snapshot.depositsQuote.toString(),
        snapshot.realizedQuote.toString(),
        snapshot.liquidationQuote.toString(),
        snapshot.pnlQuote.toString(),
        snapshot.pnlBps.toString(),
        snapshot.blockNumber.toString(),
        snapshot.feeQuoteUsdg.toString(),
      ],
    );
  }

  async recordPositionObservation(
    positionId: string,
    protocol: Protocol,
    liquidity: bigint,
    token0: Address,
    token0Amount: bigint,
    token1: Address,
    token1Amount: bigint,
    blockNumber: bigint,
    range?: { status: string; tickLower: number; tickUpper: number; currentTick: number; currentSqrtPrice: bigint },
  ): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO position_observations
          (position_id, protocol, liquidity, token0, token0_amount, token1, token1_amount, block_number,
           range_status, range_tick_lower, range_tick_upper, range_current_tick, range_sqrt_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (position_id, block_number) DO UPDATE SET
           liquidity = EXCLUDED.liquidity,
           token0 = EXCLUDED.token0,
           token0_amount = EXCLUDED.token0_amount,
           token1 = EXCLUDED.token1,
           token1_amount = EXCLUDED.token1_amount,
           range_status = EXCLUDED.range_status,
           range_tick_lower = EXCLUDED.range_tick_lower,
           range_tick_upper = EXCLUDED.range_tick_upper,
           range_current_tick = EXCLUDED.range_current_tick,
           range_sqrt_price = EXCLUDED.range_sqrt_price,
           observed_at = NOW()`,
        [
          positionId,
          protocol,
          liquidity.toString(),
          token0.toLowerCase(),
          token0Amount.toString(),
          token1.toLowerCase(),
          token1Amount.toString(),
          blockNumber.toString(),
          range?.status ?? null,
          range?.tickLower ?? null,
          range?.tickUpper ?? null,
          range?.currentTick ?? null,
          range?.currentSqrtPrice?.toString() ?? null,
        ],
      );
      await client.query(
        "UPDATE positions SET liquidity = $2, updated_at = NOW() WHERE id = $1",
        [positionId, liquidity.toString()],
      );
    });
  }

  async getLatestSnapshots(positionIds: string[]): Promise<Map<string, { pnlBps: bigint; liquidationQuote: bigint; realizedQuote: bigint; depositsQuote: bigint; blockNumber: bigint; feeQuoteUsdg: bigint; createdAt: Date }>> {
    if (positionIds.length === 0) return new Map();
    const result = await this.pool.query(
      `SELECT DISTINCT ON (position_id)
          position_id, pnl_bps, liquidation_quote, realized_quote, deposits_quote, block_number, fee_quote_usdg, created_at
       FROM pnl_snapshots
       WHERE position_id = ANY($1::uuid[])
       ORDER BY position_id, created_at DESC`,
      [positionIds],
    );
    const map = new Map<string, { pnlBps: bigint; liquidationQuote: bigint; realizedQuote: bigint; depositsQuote: bigint; blockNumber: bigint; feeQuoteUsdg: bigint; createdAt: Date }>();
    for (const row of result.rows) {
      map.set(row.position_id, {
        pnlBps: BigInt(row.pnl_bps),
        liquidationQuote: BigInt(row.liquidation_quote),
        realizedQuote: BigInt(row.realized_quote),
        depositsQuote: BigInt(row.deposits_quote),
        blockNumber: BigInt(row.block_number),
        feeQuoteUsdg: BigInt(row.fee_quote_usdg ?? 0),
        createdAt: row.created_at,
      });
    }
    return map;
  }

  async getLatestObservations(positionIds: string[]): Promise<Map<string, {
    liquidity: bigint;
    token0Amount: bigint;
    token1Amount: bigint;
    blockNumber: bigint;
    rangeStatus: string | null;
    rangeTickLower: number | null;
    rangeTickUpper: number | null;
    rangeCurrentTick: number | null;
    rangeSqrtPrice: bigint | null;
  }>> {
    if (positionIds.length === 0) return new Map();
    const result = await this.pool.query(
      `SELECT DISTINCT ON (position_id)
          position_id, liquidity, token0_amount, token1_amount, block_number,
          range_status, range_tick_lower, range_tick_upper, range_current_tick, range_sqrt_price
       FROM position_observations
       WHERE position_id = ANY($1::uuid[])
       ORDER BY position_id, observed_at DESC`,
      [positionIds],
    );
    const map = new Map<string, {
      liquidity: bigint;
      token0Amount: bigint;
      token1Amount: bigint;
      blockNumber: bigint;
      rangeStatus: string | null;
      rangeTickLower: number | null;
      rangeTickUpper: number | null;
      rangeCurrentTick: number | null;
      rangeSqrtPrice: bigint | null;
    }>();
    for (const row of result.rows) {
      map.set(row.position_id, {
        liquidity: BigInt(row.liquidity),
        token0Amount: BigInt(row.token0_amount),
        token1Amount: BigInt(row.token1_amount),
        blockNumber: BigInt(row.block_number),
        rangeStatus: row.range_status ?? null,
        rangeTickLower: row.range_tick_lower !== null ? Number(row.range_tick_lower) : null,
        rangeTickUpper: row.range_tick_upper !== null ? Number(row.range_tick_upper) : null,
        rangeCurrentTick: row.range_current_tick !== null ? Number(row.range_current_tick) : null,
        rangeSqrtPrice: row.range_sqrt_price ? BigInt(row.range_sqrt_price) : null,
      });
    }
    return map;
  }

  async recordExecution(positionId: string, stage: string, status: "planned" | "submitted" | "confirmed" | "failed", transactionHash?: string, error?: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO execution_attempts (position_id, stage, status, transaction_hash, error) VALUES ($1, $2, $3, $4, $5)",
      [positionId, stage, status, transactionHash ?? null, error ?? null],
    );
  }

  async hasPendingRawTransaction(chainId: number): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
       FROM positions
       WHERE chain_id = $1
          AND status <> 'settled'
          AND metadata ? 'pendingRawTransaction'
          AND metadata->'pendingRawTransaction' <> 'null'::jsonb
       UNION ALL
       SELECT 1
       FROM position_groups
       WHERE chain_id = $1
         AND status NOT IN ('settled', 'cancelled')
         AND pending_raw_transaction IS NOT NULL
         AND pending_raw_transaction <> 'null'::jsonb
       UNION ALL
       SELECT 1
       FROM position_group_execution_attempts attempt
       JOIN position_groups group_record ON group_record.id = attempt.group_id
       WHERE group_record.chain_id = $1
         AND group_record.status NOT IN ('settled', 'cancelled')
         AND attempt.status IN ('planned', 'submitted')
         AND attempt.signed_raw_transaction IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM position_group_execution_attempts terminal
           WHERE terminal.group_id = attempt.group_id
             AND terminal.stage = attempt.stage
             AND terminal.transaction_hash IS NOT DISTINCT FROM attempt.transaction_hash
             AND terminal.status IN ('failed', 'confirmed')
         )
       LIMIT 1`,
      [chainId],
    );
    return result.rowCount === 1;
  }

  async recordSignedExecution(positionId: string, stage: string, transactionHash: string, serializedTransaction: string, leaseToken: string): Promise<void> {
    await this.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE positions
         SET status = 'closing',
              metadata = metadata || jsonb_build_object(
                'pendingRawTransaction',
                jsonb_build_object('stage', $2::text, 'hash', $3::text, 'serializedTransaction', $4::text, 'submittedAt', NOW()::text)
             ),
             updated_at = NOW()
         WHERE id = $1
           AND status <> 'settled'
           AND settlement_lease_token = $5
           AND settlement_lease_until > NOW()
         RETURNING id`,
        [positionId, stage, transactionHash, serializedTransaction, leaseToken],
      );
      if (updated.rowCount !== 1) throw new Error("Position cannot accept a signed execution");
      await client.query(
        "INSERT INTO execution_attempts (position_id, stage, status, transaction_hash) VALUES ($1, $2, 'submitted', $3)",
        [positionId, stage, transactionHash],
      );
    });
  }

  async getSubmittedSwapAttempt(positionId: string): Promise<string | null> {
    const result = await this.pool.query<{ transaction_hash: string }>(
      `SELECT submitted.transaction_hash
       FROM execution_attempts submitted
       WHERE submitted.position_id = $1
         AND submitted.stage = 'swap_to_quote'
         AND submitted.status = 'submitted'
         AND submitted.transaction_hash IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM execution_attempts terminal
           WHERE terminal.position_id = submitted.position_id
             AND terminal.stage = submitted.stage
             AND terminal.transaction_hash = submitted.transaction_hash
             AND terminal.status IN ('failed', 'confirmed')
         )
       ORDER BY submitted.created_at DESC
       LIMIT 1`,
      [positionId],
    );
    return result.rowCount ? result.rows[0]!.transaction_hash : null;
  }

  async getConfirmedSwapAttempt(positionId: string): Promise<string | null> {
    const result = await this.pool.query<{ transaction_hash: string }>(
      `SELECT transaction_hash
       FROM execution_attempts
       WHERE position_id = $1
         AND stage = 'swap_to_quote'
         AND status = 'confirmed'
         AND transaction_hash IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [positionId],
    );
    return result.rowCount ? result.rows[0]!.transaction_hash : null;
  }

  async getLatestExecutionHash(positionId: string, stage: string): Promise<string | null> {
    const result = await this.pool.query<{ transaction_hash: string }>(
      `SELECT transaction_hash
       FROM execution_attempts
       WHERE position_id = $1 AND stage = $2
         AND status IN ('submitted', 'confirmed')
         AND transaction_hash IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [positionId, stage],
    );
    return result.rowCount ? result.rows[0]!.transaction_hash : null;
  }

  async recordPoolObservation(chainId: number, protocol: Protocol, poolKey: string, priceMarker: bigint, blockNumber: bigint): Promise<void> {
    await this.pool.query(
      "INSERT INTO pool_observations (chain_id, protocol, pool_key, price_marker, block_number) VALUES ($1, $2, $3, $4, $5)",
      [chainId, protocol, poolKey, priceMarker.toString(), blockNumber.toString()],
    );
  }

  async getPoolObservationAtOrBefore(chainId: number, protocol: Protocol, poolKey: string, secondsAgo: number): Promise<{ priceMarker: bigint; blockNumber: bigint } | null> {
    const result = await this.pool.query<{ price_marker: string; block_number: string }>(
      `SELECT price_marker, block_number FROM pool_observations
       WHERE chain_id = $1 AND protocol = $2 AND pool_key = $3 AND observed_at <= NOW() - ($4 * INTERVAL '1 second')
       ORDER BY observed_at DESC LIMIT 1`,
      [chainId, protocol, poolKey, secondsAgo],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0]!;
    return { priceMarker: BigInt(row.price_marker), blockNumber: BigInt(row.block_number) };
  }

  async getDashboardMessageId(chatId: string): Promise<number | null> {
    const result = await this.pool.query<{ message_id: number }>(
      "SELECT message_id FROM telegram_dashboards WHERE chat_id = $1",
      [chatId],
    );
    return result.rowCount ? result.rows[0]!.message_id : null;
  }

  async setDashboardMessageId(chatId: string, messageId: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO telegram_dashboards (chat_id, message_id)
       VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET message_id = EXCLUDED.message_id, updated_at = NOW()`,
      [chatId, messageId],
    );
  }

  async clearDashboardMessageId(chatId: string): Promise<void> {
    await this.pool.query("DELETE FROM telegram_dashboards WHERE chat_id = $1", [chatId]);
  }

  async queueMessageDeletion(chatId: string, messageId: number, deleteAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO telegram_deletion_queue (chat_id, message_id, delete_at) VALUES ($1, $2, $3)
       ON CONFLICT (chat_id, message_id) DO UPDATE SET delete_at = EXCLUDED.delete_at`,
      [chatId, messageId, deleteAt],
    );
  }

  async replacePoolScanCandidates(candidates: readonly { tokenAddress: string; seedScore: number }[]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("DELETE FROM pool_scan_candidates");
      for (const candidate of candidates) {
        await client.query(
          "INSERT INTO pool_scan_candidates (token_address, seed_score) VALUES ($1, $2)",
          [candidate.tokenAddress.toLowerCase(), candidate.seedScore],
        );
      }
    });
  }

  async listPoolScanCandidates(limit: number): Promise<{ tokenAddress: string; seedScore: number; updatedAt: Date }[]> {
    const result = await this.pool.query<{ token_address: string; seed_score: number; updated_at: string }>(
      "SELECT token_address, seed_score, updated_at FROM pool_scan_candidates ORDER BY seed_score DESC LIMIT $1",
      [limit],
    );
    return result.rows.map((row) => ({ tokenAddress: row.token_address, seedScore: row.seed_score, updatedAt: new Date(row.updated_at) }));
  }

  async fetchDueDeletions(): Promise<{ id: string; chatId: string; messageId: number }[]> {
    const result = await this.pool.query<{ id: string; chat_id: string; message_id: number }>(
      "SELECT id, chat_id, message_id FROM telegram_deletion_queue WHERE delete_at <= NOW() ORDER BY delete_at ASC LIMIT 100",
    );
    return result.rows.map((row) => ({ id: row.id, chatId: row.chat_id, messageId: row.message_id }));
  }

  async removeDeletion(id: string): Promise<void> {
    await this.pool.query("DELETE FROM telegram_deletion_queue WHERE id = $1", [id]);
  }

  async deferDeletion(id: string): Promise<void> {
    await this.pool.query("UPDATE telegram_deletion_queue SET delete_at = NOW() + INTERVAL '1 minute' WHERE id = $1", [id]);
  }

  async listCloseHistory(limit = 20): Promise<CloseHistoryRecord[]> {
    return this.listCloseHistoryPage(limit, 0);
  }

  async countCloseHistory(): Promise<number> {
    const result = await this.pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM close_history WHERE ABS(final_pnl_bps) >= 50");
    return Number(result.rows[0]!.count);
  }

  async listCloseHistoryPage(limit: number, offset: number): Promise<CloseHistoryRecord[]> {
    const result = await this.pool.query<CloseHistoryRow>(
      "SELECT * FROM close_history WHERE ABS(final_pnl_bps) >= 50 ORDER BY settled_at DESC LIMIT $1 OFFSET $2",
      [limit, offset],
    );
    return result.rows.map(mapCloseHistory);
  }

  async getPnlCardDetail(positionId: string): Promise<PnlCardDetail | null> {
    const result = await this.pool.query<{
      deposits: string; settlement: string | null; fees: string; withdrawals: string;
      snapshot_realized: string | null; fee: string | null;
    }>(
      `SELECT COALESCE(SUM(c.quote_value) FILTER (WHERE c.flow_type = 'deposit'), 0) AS deposits,
              p.metadata->>'totalReceived' AS settlement,
              COALESCE(SUM(c.quote_value) FILTER (
                WHERE c.flow_type = 'fee'
                  AND c.transaction_hash IS DISTINCT FROM h.close_transaction_hash
                  AND c.transaction_hash IS DISTINCT FROM h.swap_transaction_hash
              ), 0) AS fees,
              COALESCE(SUM(c.quote_value) FILTER (
                WHERE c.flow_type = 'withdrawal'
                  AND c.transaction_hash IS DISTINCT FROM h.close_transaction_hash
                  AND c.transaction_hash IS DISTINCT FROM h.swap_transaction_hash
              ), 0) AS withdrawals,
              snapshot.realized_quote AS snapshot_realized,
              p.metadata->>'fee' AS fee
         FROM positions p
         LEFT JOIN close_history h ON h.position_id = p.id
         LEFT JOIN cashflows c ON c.position_id = p.id
         LEFT JOIN LATERAL (
           SELECT realized_quote
             FROM pnl_snapshots
            WHERE position_id = p.id
              AND created_at <= h.settled_at
            ORDER BY created_at DESC
            LIMIT 1
         ) snapshot ON TRUE
        WHERE p.id = $1
        GROUP BY p.id, h.close_transaction_hash, h.swap_transaction_hash, h.settled_at, snapshot.realized_quote`,
      [positionId],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0]!;
    const fees = BigInt(row.fees);
    const withdrawals = BigInt(row.withdrawals);
    const snapshotRealized = row.snapshot_realized ? BigInt(row.snapshot_realized) : 0n;
    const accruedFees = snapshotRealized > withdrawals + fees ? snapshotRealized - withdrawals - fees : 0n;
    return {
      depositsQuote: BigInt(row.deposits),
      settlementQuote: row.settlement && /^\d+$/.test(row.settlement) ? BigInt(row.settlement) : 0n,
      feesQuote: fees + accruedFees,
      feePips: row.fee && /^\d+$/.test(row.fee) ? Number(row.fee) : null,
    };
  }

  async getPnlCalendarMonth(year: number, month: number): Promise<PnlCalendarMonth> {
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw new Error("Invalid calendar month");
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    const result = await this.pool.query<{ date: string; pnl_usd: string; close_count: string; win_count: string }>(
      `SELECT (settled_at AT TIME ZONE 'UTC')::date::text AS date,
              SUM(final_pnl_usd) AS pnl_usd,
              COUNT(*) AS close_count,
              COUNT(*) FILTER (WHERE final_pnl_usd > 0) AS win_count
         FROM close_history
         WHERE settled_at >= $1
           AND settled_at < $2
           AND ABS(final_pnl_bps) >= 50
           AND final_pnl_usd <> 0
        GROUP BY 1
        ORDER BY 1`,
      [start.toISOString(), end.toISOString()],
    );
    const days = result.rows.map((row) => ({
      date: row.date,
      pnlUsd: BigInt(row.pnl_usd),
      closeCount: Number(row.close_count),
      winCount: Number(row.win_count),
    }));
    return {
      year,
      month,
      pnlUsd: days.reduce((total, day) => total + day.pnlUsd, 0n),
      closeCount: days.reduce((total, day) => total + day.closeCount, 0),
      winCount: days.reduce((total, day) => total + day.winCount, 0),
      activeDays: days.length,
      days,
    };
  }

  async finalizeCloseHistory(positionId: string, trigger: string): Promise<void> {
    const pos = await this.pool.query<{
      chain_id: number; protocol: Protocol; position_key: string; status: PositionStatus;
      token0: string; token1: string; quote_token: string;
      metadata: Record<string, unknown>;
      opened_at_block: string | null;
    }>(
      "SELECT chain_id, protocol, position_key, status, token0, token1, quote_token, metadata, opened_at_block FROM positions WHERE id = $1",
      [positionId],
    );
    if (!pos.rowCount) return;
    const row = pos.rows[0]!;
    if (row.status !== "settled") return;

    const meta = row.metadata;
    if (typeof meta.totalReceived !== "string") return;
    const totalReceived = BigInt(meta.totalReceived);

    const attempts = await this.pool.query<{ stage: string; transaction_hash: string }>(
      `SELECT DISTINCT ON (stage) stage, transaction_hash
       FROM execution_attempts
       WHERE position_id = $1 AND status = 'confirmed' AND transaction_hash IS NOT NULL
         AND stage IN ('remove_liquidity', 'swap_to_quote')
       ORDER BY stage, updated_at DESC`,
      [positionId],
    );
    const closeTx = attempts.rows.find((attempt) => attempt.stage === "remove_liquidity")?.transaction_hash ?? null;
    if (!closeTx) return;
    const metadataCloseTx = typeof meta.closeTransactionHash === "string" ? meta.closeTransactionHash : null;
    if (metadataCloseTx && metadataCloseTx.toLowerCase() !== closeTx.toLowerCase()) return;
    const swapTx = attempts.rows.find((attempt) => attempt.stage === "swap_to_quote")?.transaction_hash ?? null;
    const closeSettlement = typeof meta.settlementQuoteFromClose === "string" ? BigInt(meta.settlementQuoteFromClose) : null;
    if (swapTx && closeSettlement !== null && totalReceived <= closeSettlement) {
      await this.pool.query("DELETE FROM close_history WHERE position_id = $1", [positionId]);
      return;
    }
    const totals = await this.getCashflowTotals(positionId, [closeTx, swapTx].filter((hash): hash is string => hash !== null));
    if (totals.deposits === 0n) return;
    const finalPnl = totals.realized + totalReceived - totals.deposits;
    const finalPnlBps = (finalPnl * 10000n) / totals.deposits;
    if (finalPnlBps > -HISTORY_MIN_PNL_BPS && finalPnlBps < HISTORY_MIN_PNL_BPS) {
      await this.pool.query("DELETE FROM close_history WHERE position_id = $1", [positionId]);
      return;
    }
    const quoteTokenLower = row.quote_token.toLowerCase();
    const isUsdStable = quoteTokenLower === "0x5fc5360d0400a0fd4f2af552add042d716f1d168" // USDG Robinhood
      || quoteTokenLower === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // USDC Base
    const settlementUsdStr = typeof meta.settlementUsd === "string" ? meta.settlementUsd : undefined;
    const settlementUsd = settlementUsdStr ? BigInt(settlementUsdStr) : 0n;
    const finalPnlUsd = isUsdStable
      ? finalPnl
      : totalReceived > 0n && settlementUsd > 0n
        ? (finalPnl * settlementUsd) / totalReceived
        : 0n;

    const updated = await this.pool.query(
      `UPDATE close_history
       SET final_pnl_bps = $2, final_pnl_quote = $3, final_pnl_usd = $4,
            close_transaction_hash = COALESCE($5, close_transaction_hash),
            swap_transaction_hash = COALESCE($6, swap_transaction_hash), opened_at_block = $7
        WHERE position_id = $1`,
      [positionId, finalPnlBps.toString(), finalPnl.toString(), finalPnlUsd.toString(), closeTx, swapTx, row.opened_at_block],
    );
    if (updated.rowCount) return;

    await this.pool.query(
      `INSERT INTO close_history (position_id, chain_id, protocol, position_key, token0, token1, quote_token,
         final_pnl_bps, final_pnl_quote, final_pnl_usd, trigger, close_transaction_hash, swap_transaction_hash, settled_at, opened_at_block)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), $14)`,
      [
        positionId, row.chain_id, row.protocol, row.position_key,
        row.token0, row.token1, row.quote_token,
        finalPnlBps.toString(), finalPnl.toString(), finalPnlUsd.toString(), trigger,
        closeTx, swapTx,
        row.opened_at_block,
      ],
    );
  }

  async listStaleCloseHistoryUsd(): Promise<{ id: string; chainId: number; positionKey: string; finalPnlQuote: string; quoteToken: string; isNativeQuote: boolean; closeTransactionHash: string | null; swapTransactionHash: string | null }[]> {
    const result = await this.pool.query<{
      id: string; chain_id: number; position_key: string; final_pnl_quote: string;
      quote_token: string; close_transaction_hash: string | null; swap_transaction_hash: string | null;
    }>(
      `SELECT h.id, h.chain_id, h.position_key, h.final_pnl_quote,
              h.quote_token,
              COALESCE(NULLIF(p.metadata->>'closeTransactionHash', ''), h.close_transaction_hash) AS close_transaction_hash,
              COALESCE(NULLIF(p.metadata->>'swapTransactionHash', ''), h.swap_transaction_hash) AS swap_transaction_hash
        FROM close_history h
       JOIN positions p ON p.id = h.position_id
        WHERE h.final_pnl_usd = 0
          AND (h.quote_token = '0x0000000000000000000000000000000000000000'
               OR h.quote_token = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
               OR h.quote_token = '0x4200000000000000000000000000000000000006')
        ORDER BY h.settled_at DESC
       LIMIT 50`,
    );
    return result.rows.map(row => ({
      id: row.id,
      chainId: row.chain_id,
      positionKey: row.position_key,
      finalPnlQuote: row.final_pnl_quote,
      quoteToken: row.quote_token,
      isNativeQuote: row.quote_token === "0x0000000000000000000000000000000000000000",
      closeTransactionHash: row.close_transaction_hash,
      swapTransactionHash: row.swap_transaction_hash,
    }));
  }

  async updateCloseHistoryUsd(id: string, finalPnlUsd: bigint, settledAt?: Date): Promise<void> {
    await this.pool.query(
      "UPDATE close_history SET final_pnl_usd = $2, settled_at = COALESCE($3, settled_at) WHERE id = $1",
      [id, finalPnlUsd.toString(), settledAt?.toISOString() ?? null],
    );
  }

  async getPnlCardBackground(chatId: string): Promise<Buffer | null> {
    const result = await this.pool.query<{ image: Buffer }>(
      "SELECT image FROM telegram_pnl_card_bg WHERE chat_id = $1",
      [chatId],
    );
    return result.rowCount ? result.rows[0]!.image : null;
  }

  async setPnlCardBackground(chatId: string, image: Buffer): Promise<void> {
    await this.pool.query(
      `INSERT INTO telegram_pnl_card_bg (chat_id, image)
       VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET image = EXCLUDED.image, updated_at = NOW()`,
      [chatId, image],
    );
  }

  async clearPnlCardBackground(chatId: string): Promise<void> {
    await this.pool.query("DELETE FROM telegram_pnl_card_bg WHERE chat_id = $1", [chatId]);
  }
}

function stringifyJson(value: unknown): string {
  const json = JSON.stringify(value, (_key, nestedValue: unknown) => (
    typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue
  ));
  if (json === undefined) throw new Error("Cannot persist undefined JSON");
  return json;
}

function mapPositionGroup(row: PositionGroupRow): PositionGroupRecord {
  return {
    id: row.id,
    chainId: row.chain_id,
    protocol: row.protocol,
    positionManager: row.position_manager as Address,
    poolKey: row.pool_key,
    owner: row.owner as Address,
    token0: row.token0 as Address,
    token1: row.token1 as Address,
    quoteToken: row.quote_token as Address,
    shape: row.shape,
    shapeVersion: row.shape_version,
    requestedBinCount: row.requested_bin_count,
    generatedBinCount: row.generated_bin_count,
    mintableBinCount: row.mintable_bin_count,
    outerTickLower: row.outer_tick_lower,
    outerTickUpper: row.outer_tick_upper,
    anchorBinIndex: row.anchor_bin_index,
    totalDeposit: BigInt(row.total_deposit),
    deployedCostQuote: BigInt(row.deployed_cost_quote),
    directCloseAmount0: BigInt(row.direct_close_amount0),
    directCloseAmount1: BigInt(row.direct_close_amount1),
    totalReceivedQuote: BigInt(row.total_received_quote),
    status: row.status,
    planHash: row.plan_hash,
    planJson: row.plan_json,
    referenceBlock: row.reference_block === null ? null : BigInt(row.reference_block),
    referenceTick: row.reference_tick,
    referencePrice: row.reference_price === null ? null : BigInt(row.reference_price),
    openTransactionHash: row.open_transaction_hash,
    closeTransactionHash: row.close_transaction_hash,
    pendingRawTransaction: row.pending_raw_transaction,
    executionLeaseToken: row.execution_lease_token,
    executionLeaseUntil: row.execution_lease_until === null ? null : new Date(row.execution_lease_until),
    finalPnlQuote: row.final_pnl_quote === null ? null : BigInt(row.final_pnl_quote),
    finalPnlBps: row.final_pnl_bps === null ? null : BigInt(row.final_pnl_bps),
    finalPnlUsd: row.final_pnl_usd === null ? null : BigInt(row.final_pnl_usd),
    settledAt: row.settled_at === null ? null : new Date(row.settled_at),
    metadata: row.metadata,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapPositionGroupBin(row: PositionGroupBinRow): PositionGroupBinRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    chainId: row.chain_id,
    positionManager: row.position_manager as Address,
    binIndex: row.bin_index,
    tickLower: row.tick_lower,
    tickUpper: row.tick_upper,
    side: row.side,
    weightMicros: row.weight_micros,
    allocatedAmount0: BigInt(row.allocated_amount0),
    allocatedAmount1: BigInt(row.allocated_amount1),
    expectedLiquidity: BigInt(row.expected_liquidity),
    expectedAmount0: BigInt(row.expected_amount0),
    expectedAmount1: BigInt(row.expected_amount1),
    tokenId: row.token_id === null ? null : BigInt(row.token_id),
    positionId: row.position_id,
    openingAmount0: BigInt(row.opening_amount0),
    openingAmount1: BigInt(row.opening_amount1),
    closeAmount0: BigInt(row.close_amount0),
    closeAmount1: BigInt(row.close_amount1),
    settlementQuote: BigInt(row.settlement_quote),
    status: row.status,
    dropReason: row.drop_reason,
    openTransactionHash: row.open_transaction_hash,
    closeTransactionHash: row.close_transaction_hash,
    metadata: row.metadata,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapPositionGroupPnlSnapshot(row: PositionGroupPnlSnapshotRow): PositionGroupPnlSnapshotRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    quoteToken: row.quote_token as Address,
    depositsQuote: BigInt(row.deposits_quote),
    realizedQuote: BigInt(row.realized_quote),
    liquidationQuote: BigInt(row.liquidation_quote),
    feeQuote: BigInt(row.fee_quote),
    feeQuoteUsdg: BigInt(row.fee_quote_usdg),
    pnlQuote: BigInt(row.pnl_quote),
    pnlBps: BigInt(row.pnl_bps),
    blockNumber: BigInt(row.block_number),
    groupGasQuote: BigInt(row.group_gas_quote),
    rangeCurrentTick: row.range_current_tick === null ? null : Number(row.range_current_tick),
    rangeCurrentSqrtPrice: row.range_current_sqrt_price === null ? null : BigInt(row.range_current_sqrt_price),
    createdAt: new Date(row.created_at),
  };
}

function mapPosition(row: PositionRow): PositionRecord {
  return {
    id: row.id,
    chainId: row.chain_id,
    protocol: row.protocol,
    positionKey: row.position_key,
    owner: row.owner as Address,
    poolAddress: row.pool_address as Address | null,
    token0: row.token0 as Address,
    token1: row.token1 as Address,
    quoteToken: row.quote_token as Address | null,
    status: row.status,
    liquidity: row.liquidity === null ? null : BigInt(row.liquidity),
    openedAtBlock: row.opened_at_block === null ? null : BigInt(row.opened_at_block),
    metadata: row.metadata,
  };
}

interface CloseHistoryRow {
  id: string;
  position_id: string;
  chain_id: number;
  protocol: Protocol;
  position_key: string;
  token0: string;
  token1: string;
  quote_token: string;
  final_pnl_bps: string;
  final_pnl_quote: string;
  final_pnl_usd: string;
  trigger: string;
  close_transaction_hash: string | null;
  swap_transaction_hash: string | null;
  settled_at: string;
  opened_at_block: string | null;
}

function mapCloseHistory(row: CloseHistoryRow): CloseHistoryRecord {
  return {
    id: row.id,
    positionId: row.position_id,
    chainId: row.chain_id,
    protocol: row.protocol,
    positionKey: row.position_key,
    token0: row.token0 as Address,
    token1: row.token1 as Address,
    quoteToken: row.quote_token as Address,
    finalPnlBps: BigInt(row.final_pnl_bps),
    finalPnlQuote: BigInt(row.final_pnl_quote),
    finalPnlUsd: BigInt(row.final_pnl_usd),
    trigger: row.trigger as CloseHistoryRecord["trigger"],
    closeTransactionHash: row.close_transaction_hash,
    swapTransactionHash: row.swap_transaction_hash,
    settledAt: new Date(row.settled_at),
    openedAtBlock: row.opened_at_block ? BigInt(row.opened_at_block) : null,
    openedAt: null,
  };
}
