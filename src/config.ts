import "dotenv/config";

import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { z } from "zod";

import type { ChainName, PoolScanSettings, QuoteToken } from "./types.js";
import { v4PoolId, type V4PoolKey } from "./services/v4-pool.js";

export const PUBLIC_ROBINHOOD_RPC_HTTP = "https://rpc.mainnet.chain.robinhood.com";
export const PUBLIC_ROBINHOOD_SCAN_RPC_HTTP = "https://rpc-robinhood.blockmachine.io";
const DEFAULT_V4_POOL_KEY_OVERRIDES = [{
  chain: "base",
  poolId: "0x24ecedb296899f0110dce5cfdd9c9dd74b2b11a21dee752e085f93c700c7fccb",
  currency0: "0x4200000000000000000000000000000000000006",
  currency1: "0x9E00FC92493451EBA1c63DD3880D68b622037bA3",
  fee: 0x80_0000,
  tickSpacing: 200,
  hooks: "0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544",
}];

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
  ROBINHOOD_SCAN_RPC_HTTP: z.string().url().default(PUBLIC_ROBINHOOD_SCAN_RPC_HTTP),
  BSC_RPC_HTTP: z.string().url().default("https://bsc-dataseed.bnbchain.org"),
  BSC_RPC_WSS: z.string().url().optional().or(z.literal("")),
  BSC_RPC_HTTP_FALLBACK: z.string().url().optional().or(z.literal("")),
  ALCHEMY_BASE_HTTP: z.string().url().optional().or(z.literal("")),
  ALCHEMY_ROBINHOOD_HTTP: z.string().url().optional().or(z.literal("")),
  ALCHEMY_ROBINHOOD_MONITOR_HTTP: z.string().url().optional().or(z.literal("")),
  ALCHEMY_BSC_HTTP: z.string().url().optional().or(z.literal("")),
  QUOTE_TOKEN_ALLOWLIST_BASE: z.string().default(""),
  QUOTE_TOKEN_ALLOWLIST_ROBINHOOD: z.string().default(""),
  QUOTE_TOKEN_ALLOWLIST_BSC: z.string().default("USDT:0x55d398326f99059fF775485246999027B3197955,WBNB:0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c,BNB:0x0000000000000000000000000000000000000000"),
  V4_POOL_KEY_OVERRIDES: z.string().default(""),
  AUTO_EXIT_CHAINS: z.string().default("base,robinhood,bsc"),
  STOP_LOSS_PERCENT: z.coerce.number().negative(),
  TAKE_PROFIT_PERCENT: z.coerce.number().positive(),
  TRAILING_STOP_ACTIVATION_PERCENT: z.coerce.number().positive().default(5),
  TRAILING_STOP_DRAWDOWN_PERCENT: z.coerce.number().positive().default(1.5),
  TRAILING_EXIT_ESTIMATE_BUFFER_PERCENT: z.coerce.number().nonnegative().max(50).default(10),
  PROFIT_OOR_ABOVE_THRESHOLD_PERCENT: z.coerce.number().positive().default(3),
  SL_TWAP_GUARD_MAX_WAIT_MS: z.coerce.number().int().min(0).max(300_000).default(5_000),
  TRAILING_TWAP_GUARD_MAX_WAIT_MS: z.coerce.number().int().min(0).max(300_000).default(5_000),
  POSITION_MONITOR_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  BASE_POSITION_MONITOR_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).optional(),
  ROBINHOOD_POSITION_MONITOR_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).optional(),
  BSC_POSITION_MONITOR_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).optional(),
  DISCOVERY_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  POSITION_MONITOR_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  POSITION_EVALUATION_STAGGER_MS: z.coerce.number().int().min(0).max(2_000).default(120),
  MAX_SWAP_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(2_000).default(100),
  SETTLEMENT_SWAP_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(2_000).default(200),
  SETTLEMENT_SWAP_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(2_000).default(500),
  SETTLEMENT_MAX_IMPACT_BPS: z.coerce.number().int().min(1).max(5_000).default(1_500),
  SWAP_GAS_LIMIT_MULTIPLIER_PERCENT: z.coerce.number().int().min(100).max(500).default(300),
  REMOVE_LIQUIDITY_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(2_000).default(200),
  REMOVE_LIQUIDITY_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(2_000).default(500),
  SWAP_API_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(2_500),
  MAX_TWAP_DEVIATION_BPS: z.coerce.number().int().min(1).max(5_000).default(250),
  TWAP_WINDOW_SECONDS: z.coerce.number().int().min(10).max(3_600).default(60),
  PNL_INCLUDE_GAS: z.string().default("false"),
  OOR_AUTO_CLOSE_ENABLED: z.string().default("true"),
  OOR_ABOVE_MIN_DISTANCE_PERCENT: z.coerce.number().positive().default(10),
  OOR_ABOVE_MIN_DURATION_MS: z.coerce.number().int().min(5_000).max(86_400_000).default(3_600_000),
  OOR_ABOVE_PROFIT_DURATION_MS: z.coerce.number().int().min(5_000).max(86_400_000).default(300_000),
  APPROVAL_MODE: z.literal("exact").default("exact"),
  DRY_RUN: z.string().default("true"),
  POOL_SCAN_MIN_MARKET_CAP_USD: z.coerce.number().nonnegative().default(500_000),
  POOL_SCAN_MIN_POOL_TVL_USD: z.coerce.number().nonnegative().default(10_000),
  TOKEN_SCAN_MIN_POOL_TVL_USD: z.coerce.number().nonnegative().default(300),
  OPEN_MIN_EXECUTABLE_BPS: z.coerce.number().int().min(1).max(10_000).default(5_000),
  POOL_SCAN_MIN_TOTAL_ACTIVE_TVL_USD: z.coerce.number().nonnegative().default(70_000),
  POOL_SCAN_MIN_POOL_AGE_SECONDS: z.coerce.number().int().nonnegative().default(3_600),
  POOL_SCAN_MIN_YIELD_HOURLY_PERCENT: z.coerce.number().nonnegative().default(1),
  POOL_SCAN_MIN_STOCK_YIELD_HOURLY_PERCENT: z.coerce.number().nonnegative().default(0.1),
  POOL_SCAN_MAX_RESULTS: z.coerce.number().int().min(1).max(20).default(10),
  POOL_SCAN_ALLOWED_QUOTES: z.string().default("USDG,WETH,ETH"),
  POOL_SCAN_CANDIDATE_PAGES: z.coerce.number().int().min(1).max(10).default(3),
  SCANV2_ENABLED: z.string().default("false"),
  UNISWAP_API_KEY: z.string().optional().transform(v => v?.trim() || undefined),
  KYBERSWAP_ENABLED: z.string().default("true"),
  KYBERSWAP_CLIENT_ID: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).default("UniLP-Monitoring-kev212"),
  KYBERSWAP_MAX_ROUTE_AGE_MS: z.coerce.number().int().min(2_000).max(30_000).default(10_000),
  BIDASK_LADDER_ENABLED: z.string().default("false"),
  BIDASK_LADDER_PROTOCOLS: z.string().default("v3,v4"),
  BIDASK_LADDER_MAX_BINS: strictInteger(1, 10_000, 16),
  BIDASK_LADDER_MAX_PRICE_DEVIATION_BPS: strictInteger(0, 10_000, 100),
  BIDASK_LADDER_ATOMIC_MAX_BLOCK_GAS_BPS: strictInteger(1, 10_000, 8_000),
  BIDASK_LADDER_V4_MAX_OPEN_GAS_USD: z.coerce.number().positive().max(100).default(2),
  BIDASK_LADDER_V4_ETH_USD: z.coerce.number().positive().max(1_000_000).default(2_500),
  BIDASK_LADDER_TRANSACTION_DEADLINE_SECONDS: strictInteger(1, 86_400, 300),
  BIDASK_LADDER_MAX_RETRIES: strictInteger(0, 100, 3),
  THEGRAPH_API_KEY: z.string().optional().transform(v => v?.trim() || undefined),
  CONFIRMATIONS: z.coerce.number().int().min(1).max(32).default(2),
  SCAN_BLOCK_RANGE: z.coerce.number().int().min(100).max(100_000).default(2_000),
  MAX_LOG_BLOCK_RANGE: z.coerce.number().int().min(1).max(100_000).optional(),
  RPC_REQUEST_DELAY_MS: z.coerce.number().int().min(0).max(5_000).optional(),
  RPC_BOOTSTRAP_LOOKBACK_BLOCKS: z.coerce.number().int().min(1_000).max(1_000_000).default(50_000),
  START_BLOCK_BASE: z.coerce.bigint().min(0n).default(0n),
  START_BLOCK_ROBINHOOD: z.coerce.bigint().min(0n).default(0n),
  START_BLOCK_BSC: z.coerce.bigint().min(0n).default(0n),
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
  rpcHttpScanFallback: Partial<Record<ChainName, string>>;
  alchemyHttp: Partial<Record<ChainName, string>>;
  alchemyMonitoringHttp: Partial<Record<ChainName, string>>;
  quoteTokens: Record<ChainName, QuoteToken[]>;
  v4PoolKeyOverrides: Partial<Record<ChainName, Record<string, V4PoolKey>>>;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopActivationPercent: number;
  trailingStopDrawdownPercent: number;
  trailingExitEstimateBufferPercent: number;
  profitOorAboveThresholdPercent: number;
  slTwapGuardMaxWaitMs: number;
  trailingTwapGuardMaxWaitMs: number;
  positionMonitorIntervalMs: number;
  discoveryIntervalMs: number;
  chainMonitorIntervalMs: Partial<Record<ChainName, number>>;
  autoExitChains: ChainName[];
  positionMonitorConcurrency: number;
  positionEvaluationStaggerMs: number;
  maxSwapSlippageBps: number;
  settlementSwapSlippageBps: number;
  settlementSwapMaxSlippageBps: number;
  settlementMaxImpactBps: number;
  swapGasLimitMultiplierPercent: number;
  removeLiquiditySlippageBps: number;
  removeLiquidityMaxSlippageBps: number;
  swapApiTimeoutMs: number;
  maxTwapDeviationBps: number;
  twapWindowSeconds: number;
  pnlIncludeGas: boolean;
  oorAutoCloseEnabled: boolean;
  oorAboveMinDistancePercent: number;
  oorAboveMinDurationMs: number;
  oorAboveProfitDurationMs: number;
  dryRun: boolean;
  poolScanDefaults: PoolScanSettings;
  tokenScanMinPoolTvlUsd: number;
  openMinExecutableBps: number;
  poolScanCandidatePages: number;
  scanV2Enabled: boolean;
  uniswapApiKey?: string;
  kyberswapEnabled: boolean;
  kyberswapClientId: string;
  kyberswapMaxRouteAgeMs: number;
  bidAskLadderEnabled: boolean;
  bidAskLadderProtocols: Array<"v3" | "v4">;
  bidAskLadderMaxBins: number;
  bidAskLadderMaxPriceDeviationBps: number;
  bidAskLadderAtomicMaxBlockGasBps: number;
  bidAskLadderV4MaxOpenGasUsd: number;
  bidAskLadderV4EthUsd: number;
  bidAskLadderTransactionDeadlineSeconds: number;
  bidAskLadderMaxRetries: number;
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

function strictInteger(min: number, max: number, defaultValue: number) {
  return z.string()
    .regex(/^\d+$/, "must be a base-10 integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .default(defaultValue);
}

function parseBidAskProtocols(value: string): Array<"v3" | "v4"> {
  const protocols = value.split(",").map((protocol) => protocol.trim());
  if (protocols.length === 0 || protocols.some((protocol) => protocol !== "v3" && protocol !== "v4")) {
    throw new Error("BIDASK_LADDER_PROTOCOLS must contain only v3 and/or v4");
  }
  if (new Set(protocols).size !== protocols.length) {
    throw new Error("BIDASK_LADDER_PROTOCOLS must not contain duplicates");
  }
  return protocols as Array<"v3" | "v4">;
}

function parseChains(value: string): ChainName[] {
  const chains = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (chains.length === 0 || chains.some((chain) => chain !== "base" && chain !== "robinhood" && chain !== "bsc")) {
    throw new Error("CHAINS must contain only base, robinhood, and/or bsc");
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
    return { symbol: symbol.toUpperCase(), address: getAddress(normalized) };
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

function parseV4PoolKeyOverrides(value: string): Partial<Record<ChainName, Record<string, V4PoolKey>>> {
  let configuredEntries: unknown[] = [];
  if (value.trim()) {
    try {
      configuredEntries = JSON.parse(value);
    } catch {
      throw new Error("V4_POOL_KEY_OVERRIDES must be valid JSON");
    }
    if (!Array.isArray(configuredEntries)) throw new Error("V4_POOL_KEY_OVERRIDES must be a JSON array");
  }
  const overrides: Partial<Record<ChainName, Record<string, V4PoolKey>>> = {};
  for (const entry of [...DEFAULT_V4_POOL_KEY_OVERRIDES, ...configuredEntries]) {
    if (!entry || typeof entry !== "object") throw new Error("V4_POOL_KEY_OVERRIDES entries must be objects");
    const record = entry as Record<string, unknown>;
    const chain = record.chain;
    const poolId = record.poolId;
    const { currency0, currency1, fee, tickSpacing, hooks } = record;
    if ((chain !== "base" && chain !== "robinhood" && chain !== "bsc")
      || typeof poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(poolId)
      || typeof currency0 !== "string" || !isAddress(currency0)
      || typeof currency1 !== "string" || !isAddress(currency1)
      || typeof hooks !== "string" || !isAddress(hooks)
      || typeof fee !== "number"
      || !Number.isInteger(fee) || fee < 0 || fee > 0xff_ff_ff
      || typeof tickSpacing !== "number"
      || !Number.isInteger(tickSpacing) || tickSpacing < -8_388_608 || tickSpacing > 8_388_607) {
      throw new Error("V4_POOL_KEY_OVERRIDES contains an invalid pool key");
    }
    const key: V4PoolKey = { currency0: getAddress(currency0), currency1: getAddress(currency1), fee, tickSpacing, hooks: getAddress(hooks) };
    const normalizedPoolId = poolId.toLowerCase();
    if (v4PoolId(key).toLowerCase() !== normalizedPoolId) throw new Error(`V4_POOL_KEY_OVERRIDES key does not match pool ${poolId}`);
    const chainOverrides = overrides[chain] ?? {};
    if (chainOverrides[normalizedPoolId]) throw new Error(`V4_POOL_KEY_OVERRIDES contains duplicate pool ${poolId}`);
    chainOverrides[normalizedPoolId] = key;
    overrides[chain] = chainOverrides;
  }
  return overrides;
}

export function loadConfig(environment = process.env): RuntimeConfig {
  const env = envSchema.parse(environment);
  const alchemyBase = env.ALCHEMY_BASE_HTTP || undefined;
  const alchemyRobinhood = env.ALCHEMY_ROBINHOOD_HTTP || undefined;
  const alchemyRobinhoodMonitor = env.ALCHEMY_ROBINHOOD_MONITOR_HTTP || undefined;
  const alchemyBsc = env.ALCHEMY_BSC_HTTP || undefined;
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

  if (env.SETTLEMENT_SWAP_MAX_SLIPPAGE_BPS < env.SETTLEMENT_SWAP_SLIPPAGE_BPS) {
    throw new Error("SETTLEMENT_SWAP_MAX_SLIPPAGE_BPS must be at least SETTLEMENT_SWAP_SLIPPAGE_BPS");
  }
  if (env.REMOVE_LIQUIDITY_MAX_SLIPPAGE_BPS < env.REMOVE_LIQUIDITY_SLIPPAGE_BPS) {
    throw new Error("REMOVE_LIQUIDITY_MAX_SLIPPAGE_BPS must be at least REMOVE_LIQUIDITY_SLIPPAGE_BPS");
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
      bsc: env.BSC_RPC_HTTP,
    },
    rpcWss: {
      ...(env.BASE_RPC_WSS ? { base: env.BASE_RPC_WSS } : {}),
      ...(env.ROBINHOOD_RPC_WSS ? { robinhood: env.ROBINHOOD_RPC_WSS } : {}),
      ...(env.BSC_RPC_WSS ? { bsc: env.BSC_RPC_WSS } : {}),
    },
    rpcHttpFallback: {
      ...(env.BASE_RPC_HTTP_FALLBACK ? { base: env.BASE_RPC_HTTP_FALLBACK } : {}),
      robinhood: env.ROBINHOOD_RPC_HTTP_FALLBACK || PUBLIC_ROBINHOOD_RPC_HTTP,
      ...(env.BSC_RPC_HTTP_FALLBACK ? { bsc: env.BSC_RPC_HTTP_FALLBACK } : {}),
    },
    rpcHttpScanFallback: {
      ...(env.BASE_RPC_HTTP_FALLBACK ? { base: env.BASE_RPC_HTTP_FALLBACK } : {}),
      robinhood: env.ROBINHOOD_SCAN_RPC_HTTP,
      ...(env.BSC_RPC_HTTP_FALLBACK ? { bsc: env.BSC_RPC_HTTP_FALLBACK } : {}),
    },
    alchemyHttp: {
      ...(alchemyBase ? { base: alchemyBase } : {}),
      ...(alchemyRobinhood ? { robinhood: alchemyRobinhood } : {}),
      ...(alchemyBsc ? { bsc: alchemyBsc } : {}),
    },
    alchemyMonitoringHttp: {
      ...(alchemyRobinhoodMonitor ? { robinhood: alchemyRobinhoodMonitor } : {}),
    },
    quoteTokens: {
      base: parseQuoteTokens(env.QUOTE_TOKEN_ALLOWLIST_BASE, "QUOTE_TOKEN_ALLOWLIST_BASE"),
      robinhood: parseQuoteTokens(env.QUOTE_TOKEN_ALLOWLIST_ROBINHOOD, "QUOTE_TOKEN_ALLOWLIST_ROBINHOOD"),
      bsc: parseQuoteTokens(env.QUOTE_TOKEN_ALLOWLIST_BSC, "QUOTE_TOKEN_ALLOWLIST_BSC"),
    },
    v4PoolKeyOverrides: parseV4PoolKeyOverrides(env.V4_POOL_KEY_OVERRIDES),
    stopLossPercent: env.STOP_LOSS_PERCENT,
    takeProfitPercent: env.TAKE_PROFIT_PERCENT,
    trailingStopActivationPercent: env.TRAILING_STOP_ACTIVATION_PERCENT,
    trailingStopDrawdownPercent: env.TRAILING_STOP_DRAWDOWN_PERCENT,
    trailingExitEstimateBufferPercent: env.TRAILING_EXIT_ESTIMATE_BUFFER_PERCENT,
    profitOorAboveThresholdPercent: env.PROFIT_OOR_ABOVE_THRESHOLD_PERCENT,
    slTwapGuardMaxWaitMs: env.SL_TWAP_GUARD_MAX_WAIT_MS,
    trailingTwapGuardMaxWaitMs: env.TRAILING_TWAP_GUARD_MAX_WAIT_MS,
    positionMonitorIntervalMs: env.POSITION_MONITOR_INTERVAL_MS,
    discoveryIntervalMs: env.DISCOVERY_INTERVAL_MS,
    chainMonitorIntervalMs: {
      ...(env.BASE_POSITION_MONITOR_INTERVAL_MS !== undefined ? { base: env.BASE_POSITION_MONITOR_INTERVAL_MS } : {}),
      ...(env.ROBINHOOD_POSITION_MONITOR_INTERVAL_MS !== undefined ? { robinhood: env.ROBINHOOD_POSITION_MONITOR_INTERVAL_MS } : {}),
      bsc: env.BSC_POSITION_MONITOR_INTERVAL_MS ?? 10_000,
    },
    autoExitChains: parseChains(env.AUTO_EXIT_CHAINS),
    positionMonitorConcurrency: env.POSITION_MONITOR_CONCURRENCY,
    positionEvaluationStaggerMs: env.POSITION_EVALUATION_STAGGER_MS,
    maxSwapSlippageBps: env.MAX_SWAP_SLIPPAGE_BPS,
    settlementSwapSlippageBps: env.SETTLEMENT_SWAP_SLIPPAGE_BPS,
    settlementSwapMaxSlippageBps: env.SETTLEMENT_SWAP_MAX_SLIPPAGE_BPS,
    settlementMaxImpactBps: env.SETTLEMENT_MAX_IMPACT_BPS,
    swapGasLimitMultiplierPercent: env.SWAP_GAS_LIMIT_MULTIPLIER_PERCENT,
    removeLiquiditySlippageBps: env.REMOVE_LIQUIDITY_SLIPPAGE_BPS,
    removeLiquidityMaxSlippageBps: env.REMOVE_LIQUIDITY_MAX_SLIPPAGE_BPS,
    swapApiTimeoutMs: env.SWAP_API_TIMEOUT_MS,
    maxTwapDeviationBps: env.MAX_TWAP_DEVIATION_BPS,
    twapWindowSeconds: env.TWAP_WINDOW_SECONDS,
    pnlIncludeGas: parseBoolean(env.PNL_INCLUDE_GAS, "PNL_INCLUDE_GAS"),
    oorAutoCloseEnabled: parseBoolean(env.OOR_AUTO_CLOSE_ENABLED, "OOR_AUTO_CLOSE_ENABLED"),
    oorAboveMinDistancePercent: env.OOR_ABOVE_MIN_DISTANCE_PERCENT,
    oorAboveMinDurationMs: env.OOR_ABOVE_MIN_DURATION_MS,
    oorAboveProfitDurationMs: env.OOR_ABOVE_PROFIT_DURATION_MS,
    dryRun: parseBoolean(env.DRY_RUN, "DRY_RUN"),
    poolScanDefaults: {
      minMarketCapUsd: env.POOL_SCAN_MIN_MARKET_CAP_USD,
      minPoolTvlUsd: env.POOL_SCAN_MIN_POOL_TVL_USD,
      minTotalActiveTvlUsd: env.POOL_SCAN_MIN_TOTAL_ACTIVE_TVL_USD,
      minPoolAgeSeconds: env.POOL_SCAN_MIN_POOL_AGE_SECONDS,
      minYieldHourlyPercent: env.POOL_SCAN_MIN_YIELD_HOURLY_PERCENT,
      minStockYieldHourlyPercent: env.POOL_SCAN_MIN_STOCK_YIELD_HOURLY_PERCENT,
      maxResults: env.POOL_SCAN_MAX_RESULTS,
      allowedQuotes: parseSymbols(env.POOL_SCAN_ALLOWED_QUOTES, "POOL_SCAN_ALLOWED_QUOTES"),
    },
    tokenScanMinPoolTvlUsd: env.TOKEN_SCAN_MIN_POOL_TVL_USD,
    openMinExecutableBps: env.OPEN_MIN_EXECUTABLE_BPS,
    poolScanCandidatePages: env.POOL_SCAN_CANDIDATE_PAGES,
    scanV2Enabled: parseBoolean(env.SCANV2_ENABLED, "SCANV2_ENABLED"),
    uniswapApiKey: env.UNISWAP_API_KEY,
    kyberswapEnabled: parseBoolean(env.KYBERSWAP_ENABLED, "KYBERSWAP_ENABLED"),
    kyberswapClientId: env.KYBERSWAP_CLIENT_ID,
    kyberswapMaxRouteAgeMs: env.KYBERSWAP_MAX_ROUTE_AGE_MS,
    bidAskLadderEnabled: parseBoolean(env.BIDASK_LADDER_ENABLED, "BIDASK_LADDER_ENABLED"),
    bidAskLadderProtocols: parseBidAskProtocols(env.BIDASK_LADDER_PROTOCOLS),
    bidAskLadderMaxBins: env.BIDASK_LADDER_MAX_BINS,
    bidAskLadderMaxPriceDeviationBps: env.BIDASK_LADDER_MAX_PRICE_DEVIATION_BPS,
    bidAskLadderAtomicMaxBlockGasBps: env.BIDASK_LADDER_ATOMIC_MAX_BLOCK_GAS_BPS,
    bidAskLadderV4MaxOpenGasUsd: env.BIDASK_LADDER_V4_MAX_OPEN_GAS_USD,
    bidAskLadderV4EthUsd: env.BIDASK_LADDER_V4_ETH_USD,
    bidAskLadderTransactionDeadlineSeconds: env.BIDASK_LADDER_TRANSACTION_DEADLINE_SECONDS,
    bidAskLadderMaxRetries: env.BIDASK_LADDER_MAX_RETRIES,
    thegraphApiKey: env.THEGRAPH_API_KEY,
    confirmations: env.CONFIRMATIONS,
    scanBlockRange: BigInt(env.SCAN_BLOCK_RANGE),
    maxLogBlockRange: env.MAX_LOG_BLOCK_RANGE !== undefined
      ? BigInt(env.MAX_LOG_BLOCK_RANGE)
      : 2_000n,
    rpcRequestDelayMs: env.RPC_REQUEST_DELAY_MS !== undefined
      ? env.RPC_REQUEST_DELAY_MS
      : 0,
    rpcBootstrapLookbackBlocks: BigInt(env.RPC_BOOTSTRAP_LOOKBACK_BLOCKS),
    startBlocks: { base: env.START_BLOCK_BASE, robinhood: env.START_BLOCK_ROBINHOOD, bsc: env.START_BLOCK_BSC },
    telegram,
  };
}
