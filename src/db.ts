import { Pool, type PoolClient } from "pg";
import type { Address } from "viem";

import type { CloseHistoryRecord, PnlSnapshot, PoolScanSettings, PositionRecord, PositionStatus, Protocol, TrailingStopState } from "./types.js";

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
    const result = await this.pool.query<PositionRow>(
      `INSERT INTO positions (chain_id, protocol, position_key, owner, pool_address, token0, token1, quote_token, status, liquidity, opened_at_block, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (chain_id, protocol, position_key) DO UPDATE SET
         owner = EXCLUDED.owner, pool_address = EXCLUDED.pool_address, token0 = EXCLUDED.token0, token1 = EXCLUDED.token1,
         quote_token = EXCLUDED.quote_token, status = CASE WHEN positions.status IN ('closing', 'settled') THEN positions.status ELSE EXCLUDED.status END,
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
               AND metadata ? 'pendingSwap'
               AND COALESCE(metadata->>'settlementRetryDisabled', 'false') <> 'true'
               AND metadata->'pendingSwap' <> 'null'::jsonb)
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

  async findPositionByKey(chainId: number, protocol: string, positionKey: string): Promise<PositionRecord | null> {
    const result = await this.pool.query<PositionRow>(
      "SELECT * FROM positions WHERE chain_id = $1 AND protocol = $2 AND position_key = $3",
      [chainId, protocol, positionKey],
    );
    return result.rowCount ? mapPosition(result.rows[0]!) : null;
  }

  async setPositionStatus(positionId: string, status: PositionStatus, metadata?: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      "UPDATE positions SET status = $2, metadata = metadata || $3::jsonb, updated_at = NOW() WHERE id = $1",
      [positionId, status, JSON.stringify(metadata ?? {})],
    );
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

  async getCashflowTotals(positionId: string): Promise<{ deposits: bigint; realized: bigint }> {
    const result = await this.pool.query<{ deposits: string; realized: string }>(
      `SELECT
        COALESCE(SUM(quote_value) FILTER (WHERE flow_type = 'deposit'), 0) AS deposits,
        COALESCE(SUM(quote_value) FILTER (WHERE flow_type IN ('withdrawal', 'fee')), 0) AS realized
       FROM cashflows WHERE position_id = $1`,
      [positionId],
    );
    const row = result.rows[0]!;
    return { deposits: BigInt(row.deposits), realized: BigInt(row.realized) };
  }

  async addPnlSnapshot(snapshot: PnlSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO pnl_snapshots (position_id, quote_token, deposits_quote, realized_quote, liquidation_quote, pnl_quote, pnl_bps, block_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        snapshot.positionId,
        snapshot.quoteToken.toLowerCase(),
        snapshot.depositsQuote.toString(),
        snapshot.realizedQuote.toString(),
        snapshot.liquidationQuote.toString(),
        snapshot.pnlQuote.toString(),
        snapshot.pnlBps.toString(),
        snapshot.blockNumber.toString(),
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
  ): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO position_observations
          (position_id, protocol, liquidity, token0, token0_amount, token1, token1_amount, block_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (position_id, block_number) DO UPDATE SET
           liquidity = EXCLUDED.liquidity,
           token0 = EXCLUDED.token0,
           token0_amount = EXCLUDED.token0_amount,
           token1 = EXCLUDED.token1,
           token1_amount = EXCLUDED.token1_amount,
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
        ],
      );
      await client.query(
        "UPDATE positions SET liquidity = $2, updated_at = NOW() WHERE id = $1",
        [positionId, liquidity.toString()],
      );
    });
  }

  async recordExecution(positionId: string, stage: string, status: "planned" | "submitted" | "confirmed" | "failed", transactionHash?: string, error?: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO execution_attempts (position_id, stage, status, transaction_hash, error) VALUES ($1, $2, $3, $4, $5)",
      [positionId, stage, status, transactionHash ?? null, error ?? null],
    );
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
      "INSERT INTO telegram_deletion_queue (chat_id, message_id, delete_at) VALUES ($1, $2, $3)",
      [chatId, messageId, deleteAt],
    );
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

  async listCloseHistory(limit = 20): Promise<CloseHistoryRecord[]> {
    const result = await this.pool.query<{
      id: string; position_id: string; chain_id: number; protocol: Protocol;
      position_key: string; token0: string; token1: string; quote_token: string;
      final_pnl_bps: string; final_pnl_quote: string; final_pnl_usd: string; trigger: string;
      close_transaction_hash: string | null; swap_transaction_hash: string | null;
      settled_at: string;
    }>(
      `SELECT * FROM close_history ORDER BY settled_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapCloseHistory);
  }

  async finalizeCloseHistory(positionId: string, trigger: string): Promise<void> {
    const existing = await this.pool.query("SELECT 1 FROM close_history WHERE position_id = $1", [positionId]);
    if (existing.rowCount) return;

    const totals = await this.getCashflowTotals(positionId);
    if (totals.deposits === 0n) return;

    const pos = await this.pool.query<{
      chain_id: number; protocol: Protocol; position_key: string;
      token0: string; token1: string; quote_token: string;
      metadata: Record<string, unknown>;
    }>(
      "SELECT chain_id, protocol, position_key, token0, token1, quote_token, metadata FROM positions WHERE id = $1",
      [positionId],
    );
    if (!pos.rowCount) return;
    const row = pos.rows[0]!;

    const meta = row.metadata;
    const totalReceivedStr = typeof meta.totalReceived === "string" ? meta.totalReceived : undefined;
    const totalReceived = totalReceivedStr ? BigInt(totalReceivedStr) : 0n;
    const closeTx = typeof meta.closeTransactionHash === "string" ? meta.closeTransactionHash : null;
    const swapTx = typeof meta.swapTransactionHash === "string" ? meta.swapTransactionHash : null;

    const finalPnl = totals.realized + totalReceived - totals.deposits;
    const finalPnlBps = totals.deposits > 0n ? (finalPnl * 10000n) / totals.deposits : 0n;

    if (finalPnlBps < 0n ? -finalPnlBps < 50n : finalPnlBps < 50n) return;

    const quoteTokenLower = row.quote_token.toLowerCase();
    const isUsdStable = quoteTokenLower === "0x5fc5360d0400a0fd4f2af552add042d716f1d168" // USDG Robinhood
      || quoteTokenLower === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // USDC Base
    const settlementUsdStr = typeof meta.settlementUsd === "string" ? meta.settlementUsd : undefined;
    let finalPnlUsd: bigint;
    if (isUsdStable) {
      finalPnlUsd = finalPnl;
    } else if (settlementUsdStr) {
      // For ETH/WETH: compute PnL USD from stored settlement
      const depositUsdPerUnit = totals.deposits > 0n ? (BigInt(settlementUsdStr) * totals.deposits) / totalReceived : 0n;
      finalPnlUsd = depositUsdPerUnit > 0n ? (finalPnl * BigInt(settlementUsdStr)) / depositUsdPerUnit : 0n;
    } else {
      finalPnlUsd = 0n;
    }

    await this.pool.query(
      `INSERT INTO close_history (position_id, chain_id, protocol, position_key, token0, token1, quote_token,
         final_pnl_bps, final_pnl_quote, final_pnl_usd, trigger, close_transaction_hash, swap_transaction_hash, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())`,
      [
        positionId, row.chain_id, row.protocol, row.position_key,
        row.token0, row.token1, row.quote_token,
        finalPnlBps.toString(), finalPnl.toString(), finalPnlUsd.toString(), trigger,
        closeTx, swapTx,
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
              NULLIF(p.metadata->>'closeTransactionHash', '') AS close_transaction_hash,
              NULLIF(p.metadata->>'swapTransactionHash', '') AS swap_transaction_hash
       FROM close_history h
       JOIN positions p ON p.id = h.position_id
       WHERE h.final_pnl_usd = 0
         AND (h.quote_token = '0x0000000000000000000000000000000000000000'
              OR h.quote_token = '0x0bd7d308f8e1639fab988df18a8011f41eacad73')
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

  async updateCloseHistoryUsd(id: string, finalPnlUsd: bigint): Promise<void> {
    await this.pool.query(
      "UPDATE close_history SET final_pnl_usd = $2 WHERE id = $1",
      [id, finalPnlUsd.toString()],
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
  };
}
