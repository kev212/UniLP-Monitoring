import "dotenv/config";

import { readFileSync } from "node:fs";
import { isAddress, type Address, type Hex } from "viem";
import { z } from "zod";

import type { ChainName, PoolScanSettings, QuoteToken } from "./types.js";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  CHAINS: z.string().default("base,robinhood"),
  EXECUTOR_ADDRESS: z.string().refine(isAddress, "EXECUTOR_ADDRESS must be an address"),
  EXECUTOR_PRIVATE_KEY_FILE: z.string().optional(),
  EXECUTOR_PRIVATE_KEY: z.string().optional(),
  BASE_RPC_HTTP: z.string().url(),
  BASE_RPC_WSS: z.string().url().optional().or(z.literal("")),
  BASE_RPC_HTTP_FALLBACK: z.string().url().optional().or(z.literal("")),
  ROBINHOOD_RPC_HTTP: z.string().url(),
  ROBINHOOD_RPC_WSS: z.string().url().optional().or(z.literal("")),
  ROBINHOOD_RPC_HTTP_FALLBACK: z.string().url().optional().or(z.literal("")),
  ALCHEMY_BASE_HTTP: z.string().url().optional().or(z.literal("")),
  ALCHEMY_ROBINHOOD_HTTP: z.string().url().optional().or(z.literal("")),
  QUOTE_TOKEN_ALLOWLIST_BASE: z.string().default(""),
  QUOTE_TOKEN_ALLOWLIST_ROBINHOOD: z.string().default(""),
  STOP_LOSS_PERCENT: z.coerce.number().negative(),
  TAKE_PROFIT_PERCENT: z.coerce.number().positive(),
  TRAILING_STOP_ACTIVATION_PERCENT: z.coerce.number().positive().default(5),
  TRAILING_STOP_DRAWDOWN_PERCENT: z.coerce.number().positive().default(1.5),
  POSITION_MONITOR_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  BASE_POSITION_MONITOR_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).optional(),
  ROBINHOOD_POSITION_MONITOR_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).optional(),
  DISCOVERY_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  POSITION_MONITOR_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  MAX_SWAP_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(2_000).default(100),
  SETTLEMENT_SWAP_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(2_000).default(200),
  SETTLEMENT_SWAP_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(2_000).default(500),
  SWAP_API_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(2_500),
  MAX_TWAP_DEVIATION_BPS: z.coerce.number().int().min(1).max(5_000).default(250),
  TWAP_WINDOW_SECONDS: z.coerce.number().int().min(10).max(3_600).default(300),
  PNL_INCLUDE_GAS: z.string().default("false"),
  OOR_AUTO_CLOSE_ENABLED: z.string().default("true"),
  OOR_ABOVE_MIN_DISTANCE_PERCENT: z.coerce.number().positive().default(10),
  OOR_ABOVE_MIN_DURATION_MS: z.coerce.number().int().min(5_000).max(86_400_000).default(3_600_000),
  APPROVAL_MODE: z.literal("exact").default("exact"),
  DRY_RUN: z.string().default("true"),
  POOL_SCAN_MIN_MARKET_CAP_USD: z.coerce.number().nonnegative().default(500_000),
  POOL_SCAN_MIN_POOL_TVL_USD: z.coerce.number().nonnegative().default(10_000),
  POOL_SCAN_MIN_TOTAL_ACTIVE_TVL_USD: z.coerce.number().nonnegative().default(70_000),
  POOL_SCAN_MIN_POOL_AGE_SECONDS: z.coerce.number().int().nonnegative().default(3_600),
  POOL_SCAN_MIN_YIELD_HOURLY_PERCENT: z.coerce.number().nonnegative().default(1),
  POOL_SCAN_MAX_RESULTS: z.coerce.number().int().min(1).max(20).default(10),
  POOL_SCAN_ALLOWED_QUOTES: z.string().default("USDG,WETH,ETH"),
  POOL_SCAN_CANDIDATE_PAGES: z.coerce.number().int().min(1).max(10).default(3),
  SCANV2_ENABLED: z.string().default("false"),
  UNISWAP_API_KEY: z.string().optional().transform(v => v?.trim() || undefined),
  KYBERSWAP_ENABLED: z.string().default("true"),
  KYBERSWAP_CLIENT_ID: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).default("UniLP-Monitoring-kev212"),
  KYBERSWAP_MAX_ROUTE_AGE_MS: z.coerce.number().int().min(2_000).max(30_000).default(10_000),
  THEGRAPH_API_KEY: z.string().optional().transform(v => v?.trim() || undefined),
  CONFIRMATIONS: z.coerce.number().int().min(1).max(32).default(2),
  SCAN_BLOCK_RANGE: z.coerce.number().int().min(100).max(100_000).default(2_000),
  MAX_LOG_BLOCK_RANGE: z.coerce.number().int().min(1).max(100_000).optional(),
  RPC_REQUEST_DELAY_MS: z.coerce.number().int().min(0).max(5_000).optional(),
  RPC_BOOTSTRAP_LOOKBACK_BLOCKS: z.coerce.number().int().min(1_000).max(1_000_000).default(50_000),
  START_BLOCK_BASE: z.coerce.bigint().min(0n).default(0n),
  START_BLOCK_ROBINHOOD: z.coerce.bigint().min(0n).default(0n),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_USER_ID: z.string().regex(/^\d+$/).optional(),
});

export interface RuntimeConfig {
  databaseUrl: string;
  chains: ChainName[];
  executorAddress: Address;
  executorPrivateKey?: Hex;
  rpcHttp: Record<ChainName, string>;
  rpcWss: Partial<Record<ChainName, string>>;
  rpcHttpFallback: Partial<Record<ChainName, string>>;
  alchemyHttp: Partial<Record<ChainName, string>>;
  quoteTokens: Record<ChainName, QuoteToken[]>;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopActivationPercent: number;
  trailingStopDrawdownPercent: number;
  positionMonitorIntervalMs: number;
  discoveryIntervalMs: number;
  chainMonitorIntervalMs: Partial<Record<ChainName, number>>;
  positionMonitorConcurrency: number;
  maxSwapSlippageBps: number;
  settlementSwapSlippageBps: number;
  settlementSwapMaxSlippageBps: number;
  swapApiTimeoutMs: number;
  maxTwapDeviationBps: number;
  twapWindowSeconds: number;
  pnlIncludeGas: boolean;
  oorAutoCloseEnabled: boolean;
  oorAboveMinDistancePercent: number;
  oorAboveMinDurationMs: number;
  dryRun: boolean;
  poolScanDefaults: PoolScanSettings;
  poolScanCandidatePages: number;
  scanV2Enabled: boolean;
  uniswapApiKey?: string;
  kyberswapEnabled: boolean;
  kyberswapClientId: string;
  kyberswapMaxRouteAgeMs: number;
  thegraphApiKey?: string;
  confirmations: number;
  scanBlockRange: bigint;
  maxLogBlockRange: bigint;
  rpcRequestDelayMs: number;
  rpcBootstrapLookbackBlocks: bigint;
  startBlocks: Record<ChainName, bigint>;
  telegram?: { token: string; chatId: string; userId: string };
}

function parseBoolean(value: string, field: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${field} must be true or false`);
}

function parseChains(value: string): ChainName[] {
  const chains = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (chains.length === 0 || chains.some((chain) => chain !== "base" && chain !== "robinhood")) {
    throw new Error("CHAINS must contain only base and/or robinhood");
  }

  return [...new Set(chains)] as ChainName[];
}

function parseQuoteTokens(value: string, field: string): QuoteToken[] {
  if (!value.trim()) return [];

  const seen = new Set<string>();
  return value.split(",").map((entry) => {
    const [symbol, address, ...rest] = entry.trim().split(":");
    if (!symbol || !address || rest.length > 0 || !isAddress(address, { strict: false })) {
      throw new Error(`${field} must use SYMBOL:0xaddress entries`);
    }

    const normalized = address.toLowerCase();
    if (seen.has(normalized)) throw new Error(`${field} has a duplicate token address`);
    seen.add(normalized);
    return { symbol: symbol.toUpperCase(), address: address as Address };
  });
}

function parseSymbols(value: string, field: string): string[] {
  const symbols = value.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) throw new Error(`${field} must include at least one symbol`);
  return [...new Set(symbols)];
}

function loadPrivateKey(file?: string, direct?: string): Hex | undefined {
  const value = file ? readFileSync(file, "utf8").trim() : direct?.trim();
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Executor private key must be a 32-byte 0x-prefixed hex value");
  }
  return value as Hex;
}

export function loadConfig(environment = process.env): RuntimeConfig {
  const env = envSchema.parse(environment);
  const alchemyBase = env.ALCHEMY_BASE_HTTP || undefined;
  const alchemyRobinhood = env.ALCHEMY_ROBINHOOD_HTTP || undefined;
  const telegram = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
    ? {
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
        // A private Telegram chat ID equals the account's user ID. Group chats
        // must opt in explicitly with an allowlisted user ID.
        userId: env.TELEGRAM_USER_ID ?? (env.TELEGRAM_CHAT_ID.startsWith("-") ? "" : env.TELEGRAM_CHAT_ID),
      }
    : undefined;

  if ((env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_CHAT_ID) || (!env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together");
  }
  if (telegram && !telegram.userId) {
    throw new Error("TELEGRAM_USER_ID is required when TELEGRAM_CHAT_ID is a group");
  }

  const rpcUsesAlchemy = Boolean(detectAlchemyEndpoint(env.BASE_RPC_HTTP) || detectAlchemyEndpoint(env.ROBINHOOD_RPC_HTTP));
  if (env.SETTLEMENT_SWAP_MAX_SLIPPAGE_BPS < env.SETTLEMENT_SWAP_SLIPPAGE_BPS) {
    throw new Error("SETTLEMENT_SWAP_MAX_SLIPPAGE_BPS must be at least SETTLEMENT_SWAP_SLIPPAGE_BPS");
  }
  if (env.KYBERSWAP_MAX_ROUTE_AGE_MS < env.SWAP_API_TIMEOUT_MS + 1_000) {
    throw new Error("KYBERSWAP_MAX_ROUTE_AGE_MS must exceed SWAP_API_TIMEOUT_MS by at least 1000ms");
  }

  return {
    databaseUrl: env.DATABASE_URL,
    chains: parseChains(env.CHAINS),
    executorAddress: env.EXECUTOR_ADDRESS as Address,
    executorPrivateKey: loadPrivateKey(env.EXECUTOR_PRIVATE_KEY_FILE, env.EXECUTOR_PRIVATE_KEY),
    rpcHttp: {
      base: env.BASE_RPC_HTTP,
      robinhood: env.ROBINHOOD_RPC_HTTP,
    },
    rpcWss: {
      ...(env.BASE_RPC_WSS ? { base: env.BASE_RPC_WSS } : {}),
      ...(env.ROBINHOOD_RPC_WSS ? { robinhood: env.ROBINHOOD_RPC_WSS } : {}),
    },
    rpcHttpFallback: {
      ...(env.BASE_RPC_HTTP_FALLBACK ? { base: env.BASE_RPC_HTTP_FALLBACK } : {}),
      ...(env.ROBINHOOD_RPC_HTTP_FALLBACK ? { robinhood: env.ROBINHOOD_RPC_HTTP_FALLBACK } : {}),
    },
    alchemyHttp: {
      ...(alchemyBase ? { base: alchemyBase } : {}),
      ...(alchemyRobinhood ? { robinhood: alchemyRobinhood } : {}),
    },
    quoteTokens: {
      base: parseQuoteTokens(env.QUOTE_TOKEN_ALLOWLIST_BASE, "QUOTE_TOKEN_ALLOWLIST_BASE"),
      robinhood: parseQuoteTokens(env.QUOTE_TOKEN_ALLOWLIST_ROBINHOOD, "QUOTE_TOKEN_ALLOWLIST_ROBINHOOD"),
    },
    stopLossPercent: env.STOP_LOSS_PERCENT,
    takeProfitPercent: env.TAKE_PROFIT_PERCENT,
    trailingStopActivationPercent: env.TRAILING_STOP_ACTIVATION_PERCENT,
    trailingStopDrawdownPercent: env.TRAILING_STOP_DRAWDOWN_PERCENT,
    positionMonitorIntervalMs: env.POSITION_MONITOR_INTERVAL_MS,
    discoveryIntervalMs: env.DISCOVERY_INTERVAL_MS,
    chainMonitorIntervalMs: {
      ...(env.BASE_POSITION_MONITOR_INTERVAL_MS !== undefined ? { base: env.BASE_POSITION_MONITOR_INTERVAL_MS } : {}),
      ...(env.ROBINHOOD_POSITION_MONITOR_INTERVAL_MS !== undefined ? { robinhood: env.ROBINHOOD_POSITION_MONITOR_INTERVAL_MS } : {}),
    },
    positionMonitorConcurrency: env.POSITION_MONITOR_CONCURRENCY,
    maxSwapSlippageBps: env.MAX_SWAP_SLIPPAGE_BPS,
    settlementSwapSlippageBps: env.SETTLEMENT_SWAP_SLIPPAGE_BPS,
    settlementSwapMaxSlippageBps: env.SETTLEMENT_SWAP_MAX_SLIPPAGE_BPS,
    swapApiTimeoutMs: env.SWAP_API_TIMEOUT_MS,
    maxTwapDeviationBps: env.MAX_TWAP_DEVIATION_BPS,
    twapWindowSeconds: env.TWAP_WINDOW_SECONDS,
    pnlIncludeGas: parseBoolean(env.PNL_INCLUDE_GAS, "PNL_INCLUDE_GAS"),
    oorAutoCloseEnabled: parseBoolean(env.OOR_AUTO_CLOSE_ENABLED, "OOR_AUTO_CLOSE_ENABLED"),
    oorAboveMinDistancePercent: env.OOR_ABOVE_MIN_DISTANCE_PERCENT,
    oorAboveMinDurationMs: env.OOR_ABOVE_MIN_DURATION_MS,
    dryRun: parseBoolean(env.DRY_RUN, "DRY_RUN"),
    poolScanDefaults: {
      minMarketCapUsd: env.POOL_SCAN_MIN_MARKET_CAP_USD,
      minPoolTvlUsd: env.POOL_SCAN_MIN_POOL_TVL_USD,
      minTotalActiveTvlUsd: env.POOL_SCAN_MIN_TOTAL_ACTIVE_TVL_USD,
      minPoolAgeSeconds: env.POOL_SCAN_MIN_POOL_AGE_SECONDS,
      minYieldHourlyPercent: env.POOL_SCAN_MIN_YIELD_HOURLY_PERCENT,
      maxResults: env.POOL_SCAN_MAX_RESULTS,
      allowedQuotes: parseSymbols(env.POOL_SCAN_ALLOWED_QUOTES, "POOL_SCAN_ALLOWED_QUOTES"),
    },
    poolScanCandidatePages: env.POOL_SCAN_CANDIDATE_PAGES,
    scanV2Enabled: parseBoolean(env.SCANV2_ENABLED, "SCANV2_ENABLED"),
    uniswapApiKey: env.UNISWAP_API_KEY,
    kyberswapEnabled: parseBoolean(env.KYBERSWAP_ENABLED, "KYBERSWAP_ENABLED"),
    kyberswapClientId: env.KYBERSWAP_CLIENT_ID,
    kyberswapMaxRouteAgeMs: env.KYBERSWAP_MAX_ROUTE_AGE_MS,
    thegraphApiKey: env.THEGRAPH_API_KEY,
    confirmations: env.CONFIRMATIONS,
    scanBlockRange: BigInt(env.SCAN_BLOCK_RANGE),
    maxLogBlockRange: env.MAX_LOG_BLOCK_RANGE !== undefined
      ? BigInt(env.MAX_LOG_BLOCK_RANGE)
      : (rpcUsesAlchemy ? 10n : 2_000n),
    rpcRequestDelayMs: env.RPC_REQUEST_DELAY_MS !== undefined
      ? env.RPC_REQUEST_DELAY_MS
      : (rpcUsesAlchemy ? 25 : 0),
    rpcBootstrapLookbackBlocks: BigInt(env.RPC_BOOTSTRAP_LOOKBACK_BLOCKS),
    startBlocks: { base: env.START_BLOCK_BASE, robinhood: env.START_BLOCK_ROBINHOOD },
    telegram,
  };
}

function detectAlchemyEndpoint(value: string): string | undefined {
  return new URL(value).hostname.endsWith("alchemy.com") ? value : undefined;
}
