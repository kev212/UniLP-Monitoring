import type { Address, Hex } from "viem";

export type ChainName = "base" | "robinhood" | "bsc";
export type Protocol = "v2" | "v3" | "v4";
export type PositionStatus =
  | "discovered"
  | "syncing"
  | "armed"
  | "closing"
  | "settled"
  | "needs_review"
  | "failed"
  | "paused";

export type PositionGroupStatus =
  | "planned"
  | "preparing"
  | "opening"
  | "active"
  | "closing"
  | "settling"
  | "settled"
  | "needs_review"
  | "cancelled";

export type PositionGroupBinStatus = "planned" | "minted" | "closed" | "skipped" | "needs_review";
export type PositionGroupBinSide = "token0" | "token1";
export type PositionGroupShape = "bid_ask";
export type PositionGroupShapeVersion = "delta-amount-linear-v1" | "delta-amount-linear-v2";

export type PositionGroupExecutionStage =
  | "approve_quote"
  | "wrap_quote"
  | "approve_permit2"
  | "permit2_approve"
  | "open_batch"
  | "close_batch"
  | "settlement_swap"
  | "unwrap_quote";

export type PositionGroupExecutionStatus = "planned" | "submitted" | "confirmed" | "failed";

export type PositionGroupCashflowType = "open_debit" | "close_receipt" | "settlement_swap" | "unwrap_quote";

export type TokenRescueStatus = "polling" | "collected" | "swapped" | "completed" | "needs_review";

export interface TokenRescuePendingTransaction {
  stage: "collect" | "approve_reset" | "approve" | "swap" | "unwrap";
  hash: Hex;
  serializedTransaction: Hex;
  submittedAt: string;
}

export interface TokenRescueJob {
  id: string;
  chainId: number;
  tokenAddress: Address;
  quoteToken: Address;
  positionManager: Address;
  tokenIds: bigint[];
  status: TokenRescueStatus;
  pendingRawTransaction: TokenRescuePendingTransaction | null;
  metadata: Record<string, unknown>;
  lastError: string | null;
}

export type ExitTrigger = "stop_loss" | "take_profit" | "trailing_take_profit" | "profit_oor_above" | "out_of_range_above" | "manual";

export interface PositionRangeInfo {
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  currentSqrtPrice: bigint;
  status: "in_range" | "above" | "below";
  aboveDistanceBps?: bigint;
}

export interface TrailingStopState {
  peakPnlBps: bigint;
  activatedAtBlock: bigint;
}

export interface QuoteToken {
  address: Address;
  symbol: string;
}

export interface PoolScanSettings {
  minMarketCapUsd: number;
  minPoolTvlUsd: number;
  minTotalActiveTvlUsd: number;
  minPoolAgeSeconds: number;
  minYieldHourlyPercent: number;
  maxResults: number;
  allowedQuotes: string[];
}

export interface RiskSettings {
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopActivationPercent: number;
  trailingStopDrawdownPercent: number;
}

export function isRiskSettings(value: unknown): value is RiskSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  const stopLoss = settings.stopLossPercent;
  const takeProfit = settings.takeProfitPercent;
  const activation = settings.trailingStopActivationPercent;
  const drawdown = settings.trailingStopDrawdownPercent;
  return typeof stopLoss === "number" && Number.isFinite(stopLoss) && stopLoss < 0 && stopLoss >= -100
    && typeof takeProfit === "number" && Number.isFinite(takeProfit) && takeProfit > 0 && takeProfit <= 1_000
    && typeof activation === "number" && Number.isFinite(activation) && activation > 0 && activation <= 1_000
    && typeof drawdown === "number" && Number.isFinite(drawdown) && drawdown > 0 && drawdown <= 1_000;
}

export interface PositionRecord {
  id: string;
  chainId: number;
  protocol: Protocol;
  positionKey: string;
  owner: Address;
  poolAddress: Address | null;
  token0: Address;
  token1: Address;
  quoteToken: Address | null;
  status: PositionStatus;
  liquidity: bigint | null;
  openedAtBlock: bigint | null;
  metadata: Record<string, unknown>;
}

export interface PositionGroupRecord {
  id: string;
  chainId: number;
  protocol: Protocol;
  positionManager: Address;
  poolKey: string;
  owner: Address;
  token0: Address;
  token1: Address;
  quoteToken: Address;
  shape: PositionGroupShape;
  shapeVersion: PositionGroupShapeVersion;
  requestedBinCount: number;
  generatedBinCount: number;
  mintableBinCount: number;
  outerTickLower: number;
  outerTickUpper: number;
  anchorBinIndex: number;
  totalDeposit: bigint;
  deployedCostQuote: bigint;
  directCloseAmount0: bigint;
  directCloseAmount1: bigint;
  totalReceivedQuote: bigint;
  status: PositionGroupStatus;
  planHash: string;
  planJson: Record<string, unknown>;
  referenceBlock: bigint | null;
  referenceTick: number | null;
  referencePrice: bigint | null;
  openTransactionHash: string | null;
  closeTransactionHash: string | null;
  pendingRawTransaction: Record<string, unknown> | null;
  executionLeaseToken: string | null;
  executionLeaseUntil: Date | null;
  finalPnlQuote: bigint | null;
  finalPnlBps: bigint | null;
  finalPnlUsd: bigint | null;
  settledAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface PositionGroupBinRecord {
  id: string;
  groupId: string;
  chainId: number;
  positionManager: Address;
  binIndex: number;
  tickLower: number;
  tickUpper: number;
  side: PositionGroupBinSide;
  weightMicros: number;
  allocatedAmount0: bigint;
  allocatedAmount1: bigint;
  expectedLiquidity: bigint;
  expectedAmount0: bigint;
  expectedAmount1: bigint;
  tokenId: bigint | null;
  positionId: string | null;
  openingAmount0: bigint;
  openingAmount1: bigint;
  closeAmount0: bigint;
  closeAmount1: bigint;
  settlementQuote: bigint;
  status: PositionGroupBinStatus;
  dropReason: string | null;
  openTransactionHash: string | null;
  closeTransactionHash: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface PositionGroupExecutionAttemptRecord {
  id: string;
  groupId: string;
  stage: PositionGroupExecutionStage;
  signedRawTransaction: string | null;
  nonce: bigint | null;
  transactionHash: string | null;
  status: PositionGroupExecutionStatus;
  allOrNothing: boolean;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface PositionGroupCashflowRecord {
  id: string;
  groupId: string;
  blockNumber: bigint;
  transactionHash: string;
  flowType: PositionGroupCashflowType;
  quoteValue: bigint;
  token0Amount: bigint;
  token1Amount: bigint;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface PositionGroupCashflowTotals {
  deposits: bigint;
  realized: bigint;
}

export interface PositionGroupPnlSnapshot {
  groupId: string;
  quoteToken: Address;
  depositsQuote: bigint;
  realizedQuote: bigint;
  liquidationQuote: bigint;
  feeQuote: bigint;
  feeQuoteUsdg: bigint;
  pnlQuote: bigint;
  pnlBps: bigint;
  blockNumber: bigint;
  groupGasQuote: bigint;
  rangeCurrentTick: number | null;
  rangeCurrentSqrtPrice: bigint | null;
}

export interface PositionGroupPnlSnapshotRecord extends PositionGroupPnlSnapshot {
  id: string;
  createdAt: Date;
}

export interface TokenAmount {
  token: Address;
  amount: bigint;
}

export interface LiquidationQuote {
  token0Amount: bigint;
  token1Amount: bigint;
  nonQuoteInput: TokenAmount | null;
  quoteOutput: bigint;
  route: Address[];
  blockNumber: bigint;
}

export interface PnlSnapshot {
  positionId: string;
  quoteToken: Address;
  depositsQuote: bigint;
  realizedQuote: bigint;
  liquidationQuote: bigint;
  pnlQuote: bigint;
  pnlBps: bigint;
  blockNumber: bigint;
  liquidity?: bigint;
  feeQuote: bigint;
  feeNonQuote: { token: Address; amount: bigint; converted: bigint } | null;
  feeQuoteUsdg: bigint;
}

export interface TransactionPlan {
  chainId: number;
  to: Address;
  data: Hex;
  value?: bigint;
  description: string;
}

export interface CloseHistoryRecord {
  id: string;
  positionId: string | null;
  positionGroupId: string | null;
  chainId: number;
  protocol: Protocol;
  positionKey: string;
  token0: Address;
  token1: Address;
  quoteToken: Address;
  finalPnlBps: bigint;
  finalPnlQuote: bigint;
  finalPnlUsd: bigint;
  trigger: ExitTrigger | "settled";
  closeTransactionHash: string | null;
  swapTransactionHash: string | null;
  settledAt: Date;
  openedAtBlock: bigint | null;
  openedAt: Date | null;
}

export interface PnlCalendarDay {
  date: string;
  pnlUsd: bigint;
  closeCount: number;
  winCount: number;
}

export interface PnlCalendarMonth {
  year: number;
  month: number;
  pnlUsd: bigint;
  closeCount: number;
  winCount: number;
  activeDays: number;
  days: PnlCalendarDay[];
}

export interface PnlCardDetail {
  depositsQuote: bigint;
  settlementQuote: bigint;
  feesQuote: bigint;
  feePips: number | null;
}
