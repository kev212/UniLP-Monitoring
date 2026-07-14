import type { Address, Hex } from "viem";

export type ChainName = "base" | "robinhood";
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

export type ExitTrigger = "stop_loss" | "take_profit" | "trailing_take_profit" | "manual";

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
  positionId: string;
  chainId: number;
  protocol: Protocol;
  positionKey: string;
  token0: Address;
  token1: Address;
  quoteToken: Address;
  finalPnlBps: bigint;
  finalPnlQuote: bigint;
  trigger: ExitTrigger | "settled";
  closeTransactionHash: string | null;
  swapTransactionHash: string | null;
  settledAt: Date;
}
